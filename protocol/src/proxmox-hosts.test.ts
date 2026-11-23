import { test } from "node:test";
import assert from "node:assert/strict";
import { credsForNode, hostEnvField, hostEnvKeys, missingHostKeys, parseHostEndpoints } from "./proxmox-hosts";
import { lintHostProxmox, runDoctor } from "./config-lint";
import { scanForLeaks, summarizeEnv } from "./diagnose";
import { mergeSurveys } from "./proxmox-probe";

const SECRET = "4f0c1d2e-" + "aaaa-bbbb-cccc-" + "1234567890ab";
const SET = { PROXMOX_URL_PVE31: "https://pve31:8006/", PROXMOX_TOKEN_ID_PVE31: "fh-agent@pve!agent", PROXMOX_TOKEN_SECRET_PVE31: SECRET };
const inv = (...names: string[]) => JSON.stringify(names.map((n) => ({ name: n, nodeName: n, slots: [] })));

test("names: a node name becomes a variable suffix", () => {
  assert.deepEqual(hostEnvKeys("pve-31").tokenSecret, "PROXMOX_TOKEN_SECRET_PVE_31");
  assert.deepEqual(hostEnvField("PROXMOX_TOKEN_ID_PVE31"), { suffix: "PVE31", field: "tokenId" });
  for (const plain of ["PROXMOX_URL", "PROXMOX_TOKEN_ID", "PROXMOX_TOKEN_SECRET", "PROXMOX_STORAGE_ISO", "PROXMOX_URL_"]) {
    assert.equal(hostEnvField(plain), null, plain);
  }
});

test("parse: empty lines are not a host; a partial set is kept", () => {
  assert.deepEqual(parseHostEndpoints({ PROXMOX_URL_PVE31: "", PROXMOX_TOKEN_SECRET_PVE31: "" }), {});
  const partial = parseHostEndpoints({ PROXMOX_URL_PVE31: "https://pve31:8006" });
  assert.deepEqual(missingHostKeys("PVE31", partial.PVE31!), ["PROXMOX_TOKEN_ID_PVE31", "PROXMOX_TOKEN_SECRET_PVE31"]);
  assert.equal(credsForNode("pve31", { url: "plain" }, partial), partial.PVE31, "not the plain endpoint");
  assert.equal(parseHostEndpoints(SET).PVE31!.url, "https://pve31:8006");
});

test("lint: incomplete, unused and ambiguous", () => {
  const rules = (op: Record<string, string>, i?: string) => lintHostProxmox(op, i, "f").map((f) => `${f.severity}:${f.rule}`);
  assert.deepEqual(rules(SET, inv("pve50", "pve31")), []);
  assert.deepEqual(rules(SET, undefined), []);
  assert.deepEqual(rules(SET, inv("pve50")), ["warning:HOST_PROXMOX_UNUSED"]);
  assert.deepEqual(rules({ PROXMOX_URL_PVE31: "x" }, inv("pve31")), ["error:HOST_PROXMOX_INCOMPLETE"]);
  const two = { PROXMOX_URL_PVE_1: "x", PROXMOX_TOKEN_ID_PVE_1: "x", PROXMOX_TOKEN_SECRET_PVE_1: "x" };
  assert.deepEqual(rules(two, inv("pve-1", "pve.1")), ["error:HOST_PROXMOX_AMBIGUOUS"]);
  // pve40.184 / pve40.185: two inventory hosts, one Proxmox node — not ambiguous.
  const pve40 = JSON.stringify([{ name: "pve40.184", nodeName: "pve40", slots: [] }, { name: "pve40.185", nodeName: "pve40", slots: [] }]);
  const own40 = { PROXMOX_URL_PVE40: "x", PROXMOX_TOKEN_ID_PVE40: "x", PROXMOX_TOKEN_SECRET_PVE40: "x" };
  assert.deepEqual(rules(own40, pve40), []);
});

test("a host's secret in config.env is caught", () => {
  const report = runDoctor({ configEnv: `PROXMOX_TOKEN_SECRET_PVE31=${SECRET}\n` });
  assert.ok(report.findings.some((f) => f.rule === "SECRET_IN_NONSECRET_CONFIG" && f.message.includes("PROXMOX_TOKEN_SECRET_PVE31")));
});

test("diagnose: the host's secret never leaves, and the shared token id does not stop the bundle", () => {
  const operator = ["PROXMOX_TOKEN_ID=fh-agent@pve!agent", ...Object.entries(SET).map(([k, v]) => `${k}=${v}`)].join("\n");
  const s = summarizeEnv({ operator });
  assert.ok(s.credentials.includes(SECRET));
  assert.equal(s.config[".env.operator"]!.PROXMOX_TOKEN_SECRET_PVE31!.value, undefined);
  assert.equal(s.config[".env.operator"]!.PROXMOX_URL_PVE31!.value, "https://pve31:8006/");
  assert.deepEqual(scanForLeaks(s.config, s.credentials), []);
});

test("surveys merge", () => {
  const a = { nodes: ["pve50"], storages: { pve50: [] }, memoryMb: { pve50: 32000 } };
  const b = { nodes: ["pve31"], storages: { pve31: [] } };
  assert.deepEqual(mergeSurveys(a, b)!.nodes, ["pve31", "pve50"]);
  assert.deepEqual(mergeSurveys(a, b)!.memoryMb, { pve50: 32000 });
  assert.equal(mergeSurveys(undefined, b), b);
});
