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
  // The reply from a file: the shell would eat the quotes in `VM 'vm1' not found`.
  writeFileSync(join(dir, "reply"), JSON.stringify(reply));
  writeFileSync(bin, `#!/bin/sh\necho "$@" >> ${log}\ncat >> ${log}\ncat ${join(dir, "reply")}\n`);
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

/** The hub's own test for "the VM was already gone" (job-triage.ts VM_ALREADY_ABSENT). */
const HUB_VM_ALREADY_ABSENT = /\bVM\s+(?:'[^']*'|id=\d+)\s+not found\b/i;
const doubt = (nodes: () => Promise<Map<string, string>>, vms: () => Promise<{ name?: string }[]>) =>
  notFoundDoubt(cfg(), "pve30", "vm1", { nodes, vms });
const listed = (status: string) => async () => new Map([["pve30", status], ["pve50", "online"]]);
const boom = async () => { throw new Error("proxmox 595"); };

test("absence: believed only when the node's own list lacks the VM", async () => {
  assert.equal(await doubt(listed("online"), async () => [{ name: "other" }]), null);
  assert.equal(await doubt(listed("online"), async () => []), null);
  // A token without Sys.Audit reads every node as `unknown`; the listing decides, not the status.
  assert.equal(await doubt(listed("unknown"), async () => []), null);
});

test("absence: an offline cluster member, an unreadable one and a VM that is there are all doubted", async () => {
  const offline = await doubt(listed("offline"), boom);
  assert.match(offline!.message, /vm1 was not torn down: pve30 is offline, so it may still be there/);
  const unreadable = await doubt(listed("online"), boom);
  assert.match(unreadable!.message, /could not list its VMs \(proxmox 595\)/);
  const there = await doubt(listed("online"), async () => [{ name: "vm1" }]);
  assert.match(there!.message, /but it is on pve30/);
  const noNodes = await doubt(boom, async () => []);
  const noNode = await doubt(async () => new Map([["pve50", "online"]]), async () => []);
  for (const d of [offline, unreadable, there, noNodes]) assert.equal(d!.failureClass, "transient");
  assert.equal(noNode!.failureClass, "unknown", "a wrong endpoint does not clear by itself");
  for (const d of [offline, unreadable, there, noNodes, noNode]) assert.doesNotMatch(d!.message, HUB_VM_ALREADY_ABSENT);
});

test("teardown on a powered-off cluster member fails, transient, through deprovisionVm", async () => {
  const am = fakeArcaneMage({ ok: false, error: "VM 'vm1' not found" });
  try {
    const r = await deprovisionVm("vm1", "pve30", cfg(), noFresh, { nodes: listed("offline"), vms: boom });
    assert.equal(r.ok, false);
    assert.equal(r.failureClass, "transient");
    assert.doesNotMatch(r.message!, HUB_VM_ALREADY_ABSENT);
    const gone = await deprovisionVm("vm1", "pve30", cfg(), noFresh, { nodes: listed("online"), vms: async () => [] });
    assert.equal(gone.ok, true);
    assert.match(gone.message!, HUB_VM_ALREADY_ABSENT, "the hub still learns that nothing was destroyed");
  } finally {
    am.restore();
  }
});

const failedDelete = (deleting = true) => ({
  ok: false,
  error: "Deprovisioning failed",
  vm_name: "vm1",
  vm_id: 100,
  steps: [
    { ok: true, message: "Found VM vm1 (id=100, status=running)" },
    ...(deleting ? [{ ok: true, message: "Deleting VM and disks..." }] : []),
    { ok: false, message: deleting ? "Failed to delete VM: task status unreadable (request timed out)" : "Failed to stop VM: got timeout" },
  ],
});

test("⭐ teardown: a failed delete whose VM then goes is a success, and not `already absent` to the hub", async () => {
  const am = fakeArcaneMage(failedDelete());
  try {
    let lists = 0;
    let slept = 0;
    // The destroy is still running at the first two looks.
    const vms = async () => (++lists <= 2 ? [{ name: "vm1" }] : []);
    const r = await deprovisionVm("vm1", "pve30", cfg(), noFresh, { nodes: listed("online"), vms }, async () => void slept++);
    assert.equal(r.ok, true);
    assert.equal(r.failureClass, undefined);
    assert.deepEqual([lists, slept], [3, 2]);
    assert.match(r.message!, /vm1 was destroyed: .*task status unreadable \(request timed out\).*pve30 no longer lists the VM/);
    assert.doesNotMatch(r.message!, HUB_VM_ALREADY_ABSENT, "destroyed, so the slot goes back on sale");
  } finally {
    am.restore();
  }
});

test("teardown: a failed delete stays failed while the VM is there, or the host cannot say", async () => {
  const am = fakeArcaneMage(failedDelete());
  try {
    for (const absence of [
      { nodes: listed("online"), vms: async () => [{ name: "vm1" }] },
      { nodes: listed("offline"), vms: boom },
      { nodes: boom, vms: async () => [] },
      { nodes: async () => new Map([["pve50", "online"]]), vms: async () => [] },
    ]) {
      const r = await deprovisionVm("vm1", "pve30", cfg(), noFresh, absence, async () => {});
      assert.equal(r.ok, false);
      assert.equal(r.failureClass, "unknown");
      assert.match(r.message!, /^\[step\] Failed to delete VM/);
    }
  } finally {
    am.restore();
  }
});

test("teardown: no delete was started, so a VM that is not listed proves nothing and nothing waits", async () => {
  const am = fakeArcaneMage(failedDelete(false));
  try {
    let asked = 0;
    const vms = async () => { asked++; return []; };
    const r = await deprovisionVm("vm1", "pve30", cfg(), noFresh, { nodes: listed("online"), vms }, async () => {});
    assert.equal(r.ok, false);
    assert.equal(asked, 0);
    assert.match(r.message!, /^\[step\] Failed to stop VM: got timeout/);
  } finally {
    am.restore();
  }
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
