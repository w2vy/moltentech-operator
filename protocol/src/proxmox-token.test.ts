import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  AGENT_ROLE_PRIVS,
  AGENT_TOKEN_ID,
  createAgentToken,
  proxmoxAlive,
  tokenSetupCommands,
  type PveRequest,
  type PveResponse,
} from "./proxmox-token";
import { askProxmox, type Ask, type AskHidden } from "./cli";
import { REQUIRED_PRIVS } from "./proxmox-probe";

const ok = (data: unknown): PveResponse => ({ status: 200, reason: "OK", body: JSON.stringify({ data }) });
const err = (status: number, reason: string): PveResponse => ({ status, reason, body: "" });

/** A fake Proxmox: answers by `METHOD path`, records every call. */
function fakePve(routes: Record<string, PveResponse>) {
  const calls: string[] = [];
  const req: PveRequest = async (method, _url, path, opts) => {
    calls.push(`${method} ${path}${opts?.form ? " " + new URLSearchParams(opts.form).toString() : ""}`);
    const r = routes[`${method} ${path}`];
    if (!r) throw new Error(`unexpected ${method} ${path}`);
    return r;
  };
  return { req, calls };
}

const TICKET = ok({ ticket: "PVE:root@pam:X", CSRFPreventionToken: "csrf" });
const TOKEN_PATH = "/api2/json/access/users/fh-agent%40pve/token/agent";

test("the role is the documented FluxHubAgent role, and covers every privilege the probe checks", () => {
  const docs = readFileSync(new URL("../../docs/operator-onboarding.md", import.meta.url), "utf8");
  const block = docs.match(/pveum role add FluxHubAgent -privs \\\n\s*"([^"]+)"/);
  assert.ok(block, "Step 0.1 role line not found in the docs");
  const documented = block[1]!.replace(/\\\n/g, "").split(",").map((s) => s.trim());
  assert.deepEqual([...AGENT_ROLE_PRIVS].sort(), [...documented].sort());
  for (const p of REQUIRED_PRIVS) assert.ok(AGENT_ROLE_PRIVS.includes(p), `${p} missing from the role`);
});

test("the paste-in commands are the four Step 0.1 lines, token with privsep 0", () => {
  const lines = tokenSetupCommands();
  assert.equal(lines.length, 4);
  assert.match(lines[0]!, /^pveum role add FluxHubAgent -privs "VM\.Allocate,/);
  assert.equal(lines[3], "pveum user token add fh-agent@pve agent --privsep 0");
});

test("createAgentToken does Step 0.1 through the API and returns the secret", async () => {
  const { req, calls } = fakePve({
    "POST /api2/json/access/ticket": TICKET,
    "POST /api2/json/access/roles": ok(null),
    "POST /api2/json/access/users": ok(null),
    "PUT /api2/json/access/acl": ok(null),
    [`POST ${TOKEN_PATH}`]: ok({ "full-tokenid": AGENT_TOKEN_ID, value: "secret-uuid" }),
  });
  const r = await createAgentToken("https://pve:8006", { username: "root@pam", password: "pw" }, req);
  assert.deepEqual(r, { tokenId: AGENT_TOKEN_ID, tokenSecret: "secret-uuid" });
  assert.equal(calls.length, 5);
  assert.match(calls[3]!, /path=%2F&users=fh-agent%40pve&roles=FluxHubAgent/);
  assert.match(calls[4]!, /privsep=0/);
});

test("re-runnable: an existing role is reset and an existing user is fine", async () => {
  const { req, calls } = fakePve({
    "POST /api2/json/access/ticket": TICKET,
    "POST /api2/json/access/roles": err(500, "create role failed: role 'FluxHubAgent' already exists"),
    "PUT /api2/json/access/roles/FluxHubAgent": ok(null),
    "POST /api2/json/access/users": err(500, "create user failed: user 'fh-agent@pve' already exists"),
    "PUT /api2/json/access/acl": ok(null),
    [`POST ${TOKEN_PATH}`]: ok({ value: "s" }),
  });
  const r = await createAgentToken("https://pve:8006", { username: "root@pam", password: "pw" }, req);
  assert.equal(r.tokenSecret, "s");
  assert.ok(calls.some((c) => c.startsWith("PUT /api2/json/access/roles/FluxHubAgent")));
});

test("an existing TOKEN is refused with the remove command — its secret cannot be read back", async () => {
  const { req } = fakePve({
    "POST /api2/json/access/ticket": TICKET,
    "POST /api2/json/access/roles": ok(null),
    "POST /api2/json/access/users": ok(null),
    "PUT /api2/json/access/acl": ok(null),
    [`POST ${TOKEN_PATH}`]: err(500, "Token already exists."),
  });
  await assert.rejects(
    createAgentToken("https://pve:8006", { username: "root@pam", password: "pw" }, req),
    /already exists.*pveum user token remove fh-agent@pve agent/s
  );
});

test("wrong password and two-factor accounts are named, not reported as a generic failure", async () => {
  const bad = fakePve({ "POST /api2/json/access/ticket": err(401, "authentication failure") });
  await assert.rejects(
    createAgentToken("https://pve:8006", { username: "root@pam", password: "x" }, bad.req),
    /wrong password/
  );
  const tfa = fakePve({ "POST /api2/json/access/ticket": ok({ ticket: "t", CSRFPreventionToken: "c", NeedTFA: 1 }) });
  await assert.rejects(
    createAgentToken("https://pve:8006", { username: "root@pam", password: "x" }, tfa.req),
    /two-factor/
  );
});

test("proxmoxAlive: any HTTP answer (a 401) is alive; a network error is not", async () => {
  assert.deepEqual(await proxmoxAlive("https://pve:8006", async () => err(401, "No ticket")), { ok: true });
  const down = await proxmoxAlive("https://pve:8006", async () => {
    throw new Error("connect ECONNREFUSED 10.0.0.1:8006");
  });
  assert.equal(down.ok, false);
});

/** Scripted answers; records every prompt. Unknown prompts fail the test. */
function scripted(answers: [RegExp, string][]) {
  const asked: string[] = [];
  const ask: Ask = async (q, def) => {
    asked.push(q);
    const i = answers.findIndex(([re]) => re.test(q));
    if (i < 0) throw new Error(`unscripted prompt: ${q}`);
    const [, a] = answers.splice(i, 1)[0]!;
    return a || def || "";
  };
  return { ask, asked };
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const log = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
  }
};

test("no token → create it: password asked hidden, id/secret never asked", async () => {
  const { ask, asked } = scripted([
    [/Proxmox URL/, "https://127.0.0.1:1"],
    [/already have a Proxmox API token/, "n"],
    [/Create fh-agent@pve!agent now/, "y"],
    [/retry, or `skip`/, "skip"],
  ]);
  let hiddenAsked = "";
  const askHidden: AskHidden = async (q) => ((hiddenAsked = q), "pw");
  const r = await quiet(() =>
    askProxmox(ask, {}, askHidden, {
      alive: async () => ({ ok: true }),
      create: async () => ({ tokenId: AGENT_TOKEN_ID, tokenSecret: "made" }),
    })
  );
  assert.match(hiddenAsked, /root@pam password/);
  assert.equal(r.proxmoxTokenId, AGENT_TOKEN_ID);
  assert.equal(r.proxmoxTokenSecret, "made");
  assert.ok(!asked.some((q) => /PROXMOX_TOKEN_(ID|SECRET)/.test(q)));
});

test("no token, don't create → commands printed, then id defaults to fh-agent@pve!agent", async () => {
  const { ask } = scripted([
    [/Proxmox URL/, "https://127.0.0.1:1"],
    [/already have a Proxmox API token/, "n"],
    [/Create fh-agent@pve!agent now/, "n"],
    [/PROXMOX_TOKEN_ID/, ""],
    [/PROXMOX_TOKEN_SECRET/, "pasted"],
    [/retry, or `skip`/, "skip"],
  ]);
  const printed: string[] = [];
  const log = console.log;
  console.log = (s?: unknown) => void printed.push(String(s ?? ""));
  try {
    const r = await askProxmox(ask, {}, ask, {
      alive: async () => ({ ok: true }),
      create: async () => {
        throw new Error("must not be called");
      },
    });
    assert.equal(r.proxmoxTokenId, AGENT_TOKEN_ID);
    assert.equal(r.proxmoxTokenSecret, "pasted");
  } finally {
    console.log = log;
  }
  assert.ok(printed.some((l) => l.includes("pveum user token add fh-agent@pve agent --privsep 0")));
});

test("a URL that does not answer is re-asked before any token question", async () => {
  const { ask, asked } = scripted([
    [/Proxmox URL/, "https://10.9.9.9:8006"],
    [/Proxmox URL/, "skip"],
  ]);
  await quiet(() =>
    askProxmox(ask, {}, ask, {
      alive: async () => ({ ok: false, detail: "refused" }),
      create: async () => ({ tokenId: "", tokenSecret: "" }),
    })
  );
  assert.equal(asked.filter((q) => /Proxmox URL/.test(q)).length, 2);
  assert.ok(!asked.some((q) => /already have/.test(q)));
});

test("an operator with a token configured is not asked whether they have one", async () => {
  const { ask, asked } = scripted([
    [/Proxmox URL/, ""],
    [/PROXMOX_TOKEN_ID/, ""],
    [/PROXMOX_TOKEN_SECRET/, ""],
    [/retry, or `skip`/, "skip"],
  ]);
  await quiet(() =>
    askProxmox(ask, { url: "https://127.0.0.1:1", tokenId: "x@pve!y", tokenSecret: "s" }, ask, {
      alive: async () => {
        throw new Error("must not be called");
      },
      create: async () => ({ tokenId: "", tokenSecret: "" }),
    })
  );
  assert.ok(!asked.some((q) => /already have/.test(q)));
});

test("form requests carry Content-Length — pveproxy refuses chunked bodies (HTTP 501)", async () => {
  const { pveRequestParts } = await import("./proxmox-token");
  const { body, headers } = pveRequestParts({ form: { username: "root@pam", password: "p w" } });
  assert.equal(headers["Content-Length"], String(Buffer.byteLength(body!)));
  assert.equal(headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(pveRequestParts({}).headers["Content-Length"], undefined);
});

test("the COALITION_SIGNING_KEY paste accepts the bare value or the whole line", async () => {
  const { parseSigningKeyPaste } = await import("./cli");
  assert.equal(parseSigningKeyPaste("abc123=="), "abc123==");
  assert.equal(parseSigningKeyPaste("COALITION_SIGNING_KEY=abc123=="), "abc123==");
  assert.equal(parseSigningKeyPaste('  COALITION_SIGNING_KEY = "abc123=="  '), "abc123==");
  assert.equal(parseSigningKeyPaste("export COALITION_SIGNING_KEY='k'"), "k");
  assert.equal(parseSigningKeyPaste(""), "");
});
