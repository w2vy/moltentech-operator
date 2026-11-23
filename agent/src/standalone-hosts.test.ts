import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import https from "node:https";
import { forNode, hasOwnEndpoint, loadConfig, type AgentConfig } from "./config";
import { collectOwnedVms, getClusterVmIds, getTaskStatus, getVmDescription, setVmName, stopVmNow } from "./health";
import { arcaneMageExecutor, deprovisionVm, notFoundDoubt, refreshIso } from "./executor";
import { refreshIsoOnce, resetIsoRefreshStatus } from "./iso-refresh";
import { runPreflight } from "./preflight";
import { allocateVmId, resetCursor } from "./vmid";

/**
 * One agent, two Proxmox endpoints: pve50 on the plain PROXMOX_* lines, pve31 standalone with its
 * own. Every call about a node must go to that node's endpoint WITH that endpoint's token.
 */
const ENV = {
  MT_BASE_URL: "https://hub.test",
  PROVIDER_SLUG: "test",
  MANIFEST_KEY: "x",
  PROXMOX_URL: "https://pve50:8006",
  PROXMOX_TOKEN_ID: "a@pve!t",
  PROXMOX_TOKEN_SECRET: "plain-value-50",
  PROXMOX_URL_PVE31: "https://pve31:8006/",
  PROXMOX_TOKEN_ID_PVE31: "a@pve!t",
  PROXMOX_TOKEN_SECRET_PVE31: "other-value-31",
  AGENT_INVENTORY_JSON: JSON.stringify([
    { name: "pve50", nodeName: "pve50", slots: [] },
    { name: "pve31", nodeName: "pve31", slots: [] },
  ]),
};
const cfg = (over: Record<string, string> = {}): AgentConfig => loadConfig({ ...ENV, ...over } as NodeJS.ProcessEnv);

// ── the fake Proxmoxes ────────────────────────────────────────────────────────
type Call = { host: string; path: string; method: string; auth: string; timeout?: number };
let calls: Call[] = [];
let down = new Set<string>();
let silent = new Set<string>();
const AUTH: Record<string, string> = {
  pve50: "PVEAPIToken=a@pve!t=plain-value-50",
  pve31: "PVEAPIToken=a@pve!t=other-value-31",
};

function answer(host: string, path: string): unknown {
  if (path === "/api2/json/nodes") return [{ node: host, status: "online" }];
  if (path.startsWith("/api2/json/cluster/resources")) return host === "pve31" ? [{ vmid: 400 }] : [{ vmid: 219 }];
  if (path.endsWith("/qemu")) return [{ name: `vm-on-${host}`, status: "running", vmid: 300 }];
  if (path.endsWith("/status/stop")) return "UPID:x";
  if (path.endsWith("/config")) return { description: `notes-${host}` };
  return {};
}

beforeEach(() => {
  calls = [];
  down = new Set();
  silent = new Set();
  resetCursor();
  resetIsoRefreshStatus();
  mock.method(https, "request", ((url: URL, opts: { method: string; timeout?: number; headers: Record<string, string> }, cb: (r: EventEmitter) => void) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void; destroy: (e: Error) => void };
    req.destroy = (e) => void req.emit("error", e);
    req.end = () => {
      calls.push({ host: url.hostname, path: url.pathname + url.search, method: opts.method, auth: opts.headers.Authorization!, timeout: opts.timeout });
      setImmediate(() => {
        if (down.has(url.hostname)) return req.emit("error", new Error("connect EHOSTUNREACH"));
        if (silent.has(url.hostname)) return req.emit("timeout");
        const ok = opts.headers.Authorization === AUTH[url.hostname];
        const res = Object.assign(new EventEmitter(), { statusCode: ok ? 200 : 401 });
        cb(res);
        res.emit("data", JSON.stringify({ data: ok ? answer(url.hostname, url.pathname) : null }));
        res.emit("end");
      });
    };
    return req;
  }) as never);
  mock.method(console, "error", () => {});
  mock.method(console, "log", () => {});
});
afterEach(() => mock.restoreAll());

// ── config ────────────────────────────────────────────────────────────────────
test("a host without its own lines uses the plain ones, and is the same cfg", () => {
  const c = cfg();
  assert.equal(forNode(c, "pve50"), c);
  assert.equal(hasOwnEndpoint(c, "pve50"), false);
  assert.equal(forNode(c, "pve31").proxmox.url, "https://pve31:8006");
  assert.equal(c.proxmox.url, "https://pve50:8006", "the original is not touched");
  assert.equal(forNode(c, "pve31").host, c.host, "an adopted ISO name must be seen by both");
});

test("an incomplete set is refused, never sent to the plain endpoint", async () => {
  const c = cfg({ PROXMOX_TOKEN_SECRET_PVE31: "" });
  await assert.rejects(
    arcaneMageExecutor({ jobId: "j", action: "delete", slot: { nodeName: "pve31", vmName: "v" } } as never, c),
    /credentials for pve31 are incomplete: set PROXMOX_TOKEN_SECRET_PVE31/
  );
  assert.deepEqual(await refreshIso("pve31", "local", c).then((r) => r.ok), false);
});

test("dry-run: only per-host logins is still a real agent", () => {
  assert.equal(cfg({ PROXMOX_URL: "", PROXMOX_TOKEN_SECRET: "" }).dryRun, false);
  assert.equal(cfg({ PROXMOX_URL: "", PROXMOX_URL_PVE31: "" }).dryRun, true);
});

// ── every Proxmox call ────────────────────────────────────────────────────────
test("each node's calls go to its own endpoint with its own token", async () => {
  const c = cfg();
  for (const node of ["pve50", "pve31"]) {
    calls = [];
    await getVmDescription(c, node, 300);
    await getClusterVmIds(c, node);
    await getTaskStatus(c, node, "UPID:x");
    await setVmName(c, node, 300, "n");
    await stopVmNow(c, node, 300);
    assert.equal(calls.length, 5);
    for (const call of calls) {
      assert.equal(call.host, node, `${call.method} ${call.path}`);
      assert.equal(call.auth, AUTH[node]);
      assert.equal(call.timeout, 30_000, "a powered-off host must not hang the agent");
    }
  }
});

test("one host down: the other is still reported, and the dead one is absent, not `missing`", async () => {
  const owned = [
    { vmName: "vm-on-pve31", nodeName: "pve31" },
    { vmName: "vm-on-pve50", nodeName: "pve50" },
  ];
  assert.deepEqual((await collectOwnedVms(cfg(), owned)).map((v) => [v.vmName, v.status]), [
    ["vm-on-pve31", "running"],
    ["vm-on-pve50", "running"],
  ]);
  for (const set of [down, silent]) {
    set.add("pve31");
    assert.deepEqual((await collectOwnedVms(cfg(), owned)).map((v) => v.vmName), ["vm-on-pve50"]);
    set.clear();
  }
});

test("VM ids: one cursor across endpoints, above every endpoint's live maximum", async () => {
  const c = cfg();
  const next = (node: string) => allocateVmId(() => getClusterVmIds(c, node), forNode(c, node).proxmox.url);
  assert.equal(await next("pve50"), 220);
  assert.equal(await next("pve31"), 401);
  assert.equal(await next("pve50"), 402);
});

// ── arcane-mage ───────────────────────────────────────────────────────────────
function fakeArcaneMage(reply: unknown): { log: string; restore: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "am-"));
  const log = join(dir, "log");
  const bin = join(dir, "arcane-mage");
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\ncat >> ${log}\necho '${JSON.stringify(reply)}'\n`);
  chmodSync(bin, 0o755);
  const path = process.env.PATH;
  process.env.PATH = dir + delimiter + path;
  return { log, restore: () => void (process.env.PATH = path) };
}
const noFresh = { list: async () => [], stop: async () => "", task: async () => ({}) } as never;

test("arcane-mage gets the slot's host's url, and its token on stdin", async () => {
  const am = fakeArcaneMage({ ok: true, iso: "FluxLive-1775071308.iso" });
  try {
    await refreshIso("pve31", "local", cfg());
    await refreshIso("pve50", "local", cfg());
    const log = readFileSync(am.log, "utf8");
    assert.match(log, /--url https:\/\/pve31:8006 --json --node pve31.*\na@pve!t=other-value-31\n/);
    assert.match(log, /--url https:\/\/pve50:8006 --json --node pve50.*\na@pve!t=plain-value-50\n/);
  } finally {
    am.restore();
  }
});

test("teardown: `not found` from the right Proxmox is success; from one without that node it is not", async () => {
  const am = fakeArcaneMage({ ok: false, error: "VM 'vm1' not found" });
  try {
    assert.equal((await deprovisionVm("vm1", "pve31", cfg(), noFresh)).ok, true);

    const lost = cfg({ PROXMOX_URL_PVE31: "", PROXMOX_TOKEN_ID_PVE31: "", PROXMOX_TOKEN_SECRET_PVE31: "" });
    const r = await deprovisionVm("vm1", "pve31", lost, noFresh);
    assert.equal(r.ok, false, "pve50 does not have pve31: the VM may well be running there");
    assert.equal(r.failureClass, "unknown");
    assert.match(r.message!, /has no node pve31 \(it has pve50\).*PROXMOX_URL_PVE31/s);

    assert.ok(existsSync(am.log));
  } finally {
    am.restore();
  }
});

test("teardown: an OFFLINE cluster member is still that cluster's node", async () => {
  const listed = async () => new Map([["pve30", "offline"], ["pve50", "online"]]);
  assert.equal(await notFoundDoubt(cfg(), "pve30", listed), null);
  assert.match((await notFoundDoubt(cfg(), "pve30", async () => { throw new Error("x"); }))!, /could not list its nodes/);
});

// ── ISO refresh ───────────────────────────────────────────────────────────────
test("ISO refresh: a standalone host that is off is skipped; a refused token is not", async () => {
  const run = async () => {
    const seen: string[] = [];
    await refreshIsoOnce(cfg(), async (node) => {
      seen.push(node);
      return { ok: true, changed: false, iso: "FluxLive-1775071308.iso" };
    });
    return seen;
  };
  assert.deepEqual(await run(), ["pve50", "pve31"]);
  down.add("pve31");
  assert.deepEqual(await run(), ["pve50"]);
  down.clear();
  AUTH.pve31 = "changed";
  try {
    assert.deepEqual(await run(), ["pve50", "pve31"], "the refresh runs so its failure is recorded");
  } finally {
    AUTH.pve31 = "PVEAPIToken=a@pve!t=other-value-31";
  }
});

// ── doctor ────────────────────────────────────────────────────────────────────
test("preflight: one endpoint down hides nothing about the other", async () => {
  const asked: string[] = [];
  const get = (async (c: AgentConfig, path: string) => {
    if (c.proxmox.url === "https://pve50:8006") throw new Error("connect ECONNREFUSED");
    asked.push(`${c.proxmox.url}${path}`);
    return [];
  }) as never;
  const results = await runPreflight(cfg(), [{ nodeName: "pve50" }, { nodeName: "pve31" }], { get });
  assert.equal(results.find((r) => r.name === "Proxmox reachable and token accepted")?.status, "fail");
  assert.equal(results.find((r) => r.name === "pve31: Proxmox reachable and token accepted")?.status, "pass");
  assert.ok(asked.includes("https://pve31:8006/api2/json/nodes/pve31/storage"));
});
