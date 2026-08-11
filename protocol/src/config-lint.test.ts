import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseEnvLines,
  runDoctor,
  formatReport,
  lintInventory,
  lintCrossFile,
  lintCourier,
  lintTierPrices,
  TIER_FLOORS_CENTS,
} from "./config-lint";

/** Every rule is asserted in BOTH directions on purpose: these failures are silent in
 * production, so a rule that never fires is indistinguishable from a healthy config. */

const GOOD_CONFIG = `# MoltenTech operator config
PROVIDER_SLUG=acme-nodes
PROVIDER_NAME=Acme Nodes
PROVIDER_CONTACT=ops@acme.example
MT_BASE_URL=https://www.moltentech.us
COALITION_URL=https://coalition-acme.app.runonflux.io
OWNER_ADDRESS=1L1wz2wSomeOwnerAddressHere
HOSTS=pve30,pve50
TIER_PRICES_JSON={"cumulus":700,"nimbus":2000}
`;

const GOOD_OPERATOR = `PROVIDER_SLUG=acme-nodes
MT_BASE_URL=https://www.moltentech.us
COALITION_URL=https://coalition-acme.app.runonflux.io
OWNER_ADDRESS=1L1wz2wSomeOwnerAddressHere
MANIFEST_KEY=LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t
PROXMOX_TOKEN_SECRET=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
`;

/** The REAL shape, copied from ~/mt-agents/test1/data/inventory.json — a top-level
 * array. A draft of the linter assumed { hosts: [...] } and silently checked nothing. */
const GOOD_INVENTORY = JSON.stringify([
  { name: "pve30", nodeName: "pve30", slots: [{ vmName: "mt-187-c2", lanIp: "192.168.87.2/24" }] },
]);

function rules(text: { findings: Array<{ rule: string }> }): string[] {
  return text.findings.map((f) => f.rule);
}

test("a clean set of files produces no findings", () => {
  const report = runDoctor({
    configEnv: GOOD_CONFIG,
    envOperator: GOOD_OPERATOR,
    inventoryJson: GOOD_INVENTORY,
  });
  assert.deepEqual(report.findings, []);
  const { ok, text } = formatReport(report);
  assert.equal(ok, true);
  assert.match(text, /everything agrees/);
});

test("parseEnvLines keeps 1-indexed line numbers and ignores full-line comments", () => {
  const entries = parseEnvLines("# note\n\nA=1\nB=2\n");
  assert.deepEqual(entries, [
    { key: "A", value: "1", line: 3 },
    { key: "B", value: "2", line: 4 },
  ]);
});

test("parseEnvLines takes everything after the FIRST = as the value", () => {
  // This is the behaviour CFG_INLINE_COMMENT exists to protect against, and it must
  // match manifest-config.ts's parser exactly.
  const [entry] = parseEnvLines("URL=https://x.example/?a=1&b=2\n");
  assert.equal(entry!.value, "https://x.example/?a=1&b=2");
});

test("ENVFILE_NO_EXPANSION: a shell expansion ships literally", () => {
  const report = runDoctor({ configEnv: "MANIFEST_KEY=$(base64 -w0 manifest-key.pem)\n" });
  assert.ok(rules(report).includes("ENVFILE_NO_EXPANSION"));
  assert.equal(report.findings[0]!.line, 1);
});

test("ENVFILE_NO_EXPANSION does not fire on a plain value", () => {
  const report = runDoctor({ configEnv: "PROVIDER_SLUG=acme\n" });
  assert.ok(!rules(report).includes("ENVFILE_NO_EXPANSION"));
});

test("ENVFILE_QUOTED_VALUE: wrapping quotes become part of the value", () => {
  const report = runDoctor({ configEnv: 'PROVIDER_NAME="Acme Nodes"\n' });
  assert.ok(rules(report).includes("ENVFILE_QUOTED_VALUE"));
});

test("a value containing an inner quote is not flagged as quoted", () => {
  const report = runDoctor({ configEnv: `PROVIDER_NAME=Bob's Nodes\n` });
  assert.ok(!rules(report).includes("ENVFILE_QUOTED_VALUE"));
});

test("CFG_INLINE_COMMENT: a trailing comment is swallowed into the value", () => {
  const report = runDoctor({ configEnv: "TRIAL_DAYS=1 # one day free\n" });
  assert.ok(rules(report).includes("CFG_INLINE_COMMENT"));
});

test("CFG_INLINE_COMMENT does not fire on a '#' that is part of the value", () => {
  // A fragment or a password may legitimately contain '#'; only " #" reads as a comment.
  const report = runDoctor({ configEnv: "PROVIDER_DESCRIPTION=Nodes#1\n" });
  assert.ok(!rules(report).includes("CFG_INLINE_COMMENT"));
});

test("SECRET_IN_NONSECRET_CONFIG: a Proxmox token in config.env — the real pve30 leak", () => {
  const report = runDoctor({
    configEnv: GOOD_CONFIG + "PROXMOX_TOKEN_SECRET=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee\n",
  });
  assert.ok(rules(report).includes("SECRET_IN_NONSECRET_CONFIG"));
});

test("SECRET_IN_NONSECRET_CONFIG: a Stripe key detected by VALUE shape, not key name", () => {
  const report = runDoctor({ configEnv: "SOME_INNOCENT_NAME=sk_live_x\n" });
  assert.ok(rules(report).includes("SECRET_IN_NONSECRET_CONFIG"));
});

test("PROXMOX creds in .env.operator are legitimate and NOT flagged", () => {
  // .env.operator is the agent's env file; holding hypervisor creds is its job.
  const report = runDoctor({ envOperator: GOOD_OPERATOR });
  assert.ok(!rules(report).includes("SECRET_IN_NONSECRET_CONFIG"));
});

test("a Stripe key in .env.operator IS flagged — those belong to the Coalition", () => {
  const report = runDoctor({ envOperator: GOOD_OPERATOR + "STRIPE_SECRET_KEY=sk_live_abc\n" });
  assert.ok(rules(report).includes("SECRET_IN_NONSECRET_CONFIG"));
});

test("an empty skeleton slot is not a leak, and not an error", () => {
  // secrets.env straight out of `init` is empty-but-present; that is a third state,
  // neither configured nor broken, and must not read as a fault on first run.
  const report = runDoctor({ secretsEnv: "MANIFEST_KEY=\nSTRIPE_SECRET_KEY=\n" });
  assert.deepEqual(rules(report), ["NOT_YET_FILLED", "NOT_YET_FILLED"]);
  assert.ok(report.findings.every((f) => f.severity === "warning"));
  // It must say where the value comes from, or the operator is just told it is empty.
  assert.match(report.findings[0]!.message, /keygen/);
  assert.equal(formatReport(report).ok, true);
});

test("an EMPTY MANIFEST_KEY slot is 'not yet filled'; a MISSING one is a real error", () => {
  const skeleton = lintCourier(
    { COALITION_URL: "https://c.example", MANIFEST_KEY: "", OWNER_ADDRESS: "1abc" },
    ".env.operator"
  );
  assert.deepEqual(skeleton.map((f) => f.rule), ["NOT_YET_FILLED"]);
  assert.equal(skeleton[0]!.severity, "warning");

  const missing = lintCourier({ COALITION_URL: "https://c.example", OWNER_ADDRESS: "1abc" }, ".env.operator");
  assert.deepEqual(missing.map((f) => f.rule), ["COURIER_SILENT_OFF"]);
  assert.equal(missing[0]!.severity, "error");
});

test("PRICE_BELOW_FLOOR fires under the floor and not on it", () => {
  const below = lintTierPrices(parseEnvLines('TIER_PRICES_JSON={"cumulus":500}\n'), "config.env");
  assert.deepEqual(below.map((f) => f.rule), ["PRICE_BELOW_FLOOR"]);

  const atFloor = lintTierPrices(
    parseEnvLines(`TIER_PRICES_JSON={"cumulus":${TIER_FLOORS_CENTS.cumulus}}\n`),
    "config.env"
  );
  assert.deepEqual(atFloor, []);
});

test("PRICE_ZEROS warns on the $200-nimbus shape but does not block", () => {
  const found = lintTierPrices(parseEnvLines('TIER_PRICES_JSON={"nimbus":20000}\n'), "config.env");
  assert.deepEqual(found.map((f) => f.rule), ["PRICE_ZEROS"]);
  assert.equal(found[0]!.severity, "warning");
});

test("PRICE_NOT_INTEGER_CENTS: dollars where cents belong", () => {
  const found = lintTierPrices(parseEnvLines('TIER_PRICES_JSON={"cumulus":7.5}\n'), "config.env");
  assert.deepEqual(found.map((f) => f.rule), ["PRICE_NOT_INTEGER_CENTS"]);
});

test("ENV_DUPLICATED_ACROSS_FILES: the half-on-staging snag, caught on MT_BASE_URL", () => {
  const found = lintCrossFile(
    { MT_BASE_URL: "https://www.moltentech.us" },
    { MT_BASE_URL: "https://staging.moltentech.us" }
  );
  assert.deepEqual(found.map((f) => f.rule), ["ENV_DUPLICATED_ACROSS_FILES"]);
});

test("cross-file agreement produces nothing", () => {
  assert.deepEqual(lintCrossFile({ MT_BASE_URL: "https://x" }, { MT_BASE_URL: "https://x" }), []);
});

test("COURIER_SILENT_OFF: no COALITION_URL at all", () => {
  const found = lintCourier({ MANIFEST_KEY: "k", OWNER_ADDRESS: "1abc" }, ".env.operator");
  assert.deepEqual(found.map((f) => f.rule), ["COURIER_SILENT_OFF"]);
});

test("COURIER_SILENT_OFF: URL set but the key that authenticates it is missing", () => {
  const found = lintCourier({ COALITION_URL: "https://c.example", OWNER_ADDRESS: "1abc" }, ".env.operator");
  assert.deepEqual(found.map((f) => f.rule), ["COURIER_SILENT_OFF"]);
  assert.match(found[0]!.message, /MANIFEST_KEY/);
});

test("a fully wired courier is silent", () => {
  assert.deepEqual(
    lintCourier({ COALITION_URL: "https://c.example", MANIFEST_KEY: "k", OWNER_ADDRESS: "1abc" }, ".env.operator"),
    []
  );
});

test("HOSTS_UNATTESTED: an inventory host missing from HOSTS is the 409, pre-empted", () => {
  const found = lintInventory(JSON.stringify([{ name: "pve99" }]), ["pve30"]);
  assert.deepEqual(found.map((f) => f.rule), ["HOSTS_UNATTESTED"]);
});

test("the top-level ARRAY form is the canonical one and IS inspected", () => {
  // Regression: the object-shaped assumption made every inventory rule a no-op.
  const found = lintInventory(JSON.stringify([{ name: "pve99" }]), ["pve30"]);
  assert.equal(found.length, 1);
});

test("the { hosts: [...] } form is still accepted", () => {
  const found = lintInventory(JSON.stringify({ hosts: [{ name: "pve99" }] }), ["pve30"]);
  assert.deepEqual(found.map((f) => f.rule), ["HOSTS_UNATTESTED"]);
});

test("a shape that is neither errors instead of silently passing", () => {
  const found = lintInventory(JSON.stringify({ nope: true }), ["pve30"]);
  assert.deepEqual(found.map((f) => f.rule), ["INVENTORY_MALFORMED"]);
});

test("LANIP_NO_CIDR: a bare lanIp silently becomes /32", () => {
  const found = lintInventory(
    JSON.stringify([{ name: "pve30", slots: [{ vmName: "c2", lanIp: "192.168.87.2" }] }]),
    ["pve30"]
  );
  assert.deepEqual(found.map((f) => f.rule), ["LANIP_NO_CIDR"]);
});

test("a lanIp WITH a CIDR suffix passes", () => {
  const found = lintInventory(
    JSON.stringify([{ name: "pve30", slots: [{ vmName: "c2", lanIp: "192.168.87.2/24" }] }]),
    ["pve30"]
  );
  assert.deepEqual(found, []);
});

test("INVENTORY_MALFORMED reports rather than throwing", () => {
  const found = lintInventory("{not json", ["pve30"]);
  assert.deepEqual(found.map((f) => f.rule), ["INVENTORY_MALFORMED"]);
});

test("missing files are skipped, not failed — doctor is useful mid-onboarding", () => {
  const report = runDoctor({ configEnv: GOOD_CONFIG });
  assert.deepEqual(report.filesChecked, ["config.env"]);
  assert.deepEqual(report.findings, []);
});

test("no files at all is itself an error, with a message naming what was sought", () => {
  const { ok, text } = formatReport(runDoctor({}));
  assert.equal(ok, false);
  assert.match(text, /config\.env/);
});

test("the report names file and line so a beginner can find it", () => {
  const { text } = formatReport(runDoctor({ configEnv: "A=1\nB=2 # oops\n" }));
  assert.match(text, /config\.env:2/);
  assert.match(text, /CFG_INLINE_COMMENT/);
});

test("warnings alone do not fail the run", () => {
  const { ok } = formatReport(runDoctor({ configEnv: 'TIER_PRICES_JSON={"nimbus":20000}\n' }));
  assert.equal(ok, true);
});
