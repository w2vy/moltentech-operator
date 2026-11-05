import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DoctorReport } from "./config-lint";
import {
  buildBundle,
  KEEP_PER_SHAPE,
  collapseRepeats,
  bundleFileName,
  bundleSummary,
  LOG_TAIL_LINES,
  LOGS_FILE_RE,
  MAX_LINE_CHARS,
  redactText,
  scanForLeaks,
  summarizeEnv,
  type BundleInput,
} from "./diagnose";
import type { ProxmoxSurvey } from "./proxmox-probe";

// Built in pieces so secret scanners do not take these fixtures for real credentials.
const STRIPE_KEY = "rk_" + "live_" + "A1b2C3d4E5f6G7h8";
const WEBHOOK = "whsec_" + "Q1w2E3r4T5y6U7i8";
const PVE_SECRET = "4f0c1d2e-" + "aaaa-bbbb-cccc-" + "1234567890ab";
const MANIFEST_KEY = "TUFOSUZFU1Q".repeat(4);
const CONSOLE_HASH = "$" + "6$saltsalt$hashhashhashhash";
const PEM =
  "-----BEGIN OPENSSH " + "PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\nAAAABG5vbmU\n-----END OPENSSH " + "PRIVATE KEY-----";
const COALITION_VALUE = "coalition" + "-value-123";
const TXID = "a".repeat(64);

const files = {
  config: [
    "PROVIDER_SLUG=buzznet",
    "PROVIDER_VM_PREFIX=bz-",
    "PROVIDER_CONTACT=ops@example.com",
    "MT_BASE_URL=https://staging.example.com",
    "SOME_FUTURE_SETTING=not-on-the-list",
  ].join("\n"),
  secrets: [
    ["STRIPE_SECRET_KEY", STRIPE_KEY],
    ["STRIPE_WEBHOOK_SECRET", WEBHOOK],
    ["# a comment"],
    ["COALITION_KEY", COALITION_VALUE],
  ]
    .map((pair) => pair.join("="))
    .join("\n"),
  operator: [
    `MANIFEST_KEY=${MANIFEST_KEY}`,
    "PROXMOX_URL=https://10.0.0.5:8006",
    "PROXMOX_" + "TOKEN_ID=fh-agent@pve!agent",
    `PROXMOX_TOKEN_SECRET=${PVE_SECRET}`,
    "PROXMOX_STORAGE_IMPORT=local",
    `CONSOLE_PASSWORD_HASH='${CONSOLE_HASH}'`,
    "OPERATOR_SSH_PUBKEY=",
  ].join("\n"),
};

const FINDING = {
  rule: "STORAGE_CANNOT_HOLD_CONTENT",
  severity: "error" as const,
  file: ".env.operator",
  message: 'PROXMOX_STORAGE_IMPORT on prox02: "local" is dir and cannot hold import content',
};

const report: DoctorReport = {
  findings: [FINDING],
  filesChecked: ["config.env"],
  minimumsSource: "api",
};

const STORAGE = { id: "local", type: "dir", rotational: false, why: "ssd", content: ["iso"], shared: false, active: true };
const VM = { vmid: 101, name: "bz-1", status: "stopped", cpus: 4, maxmem: 1, maxdisk: 2, tags: [] };

const survey: ProxmoxSurvey = {
  nodes: ["prox02"],
  storages: { prox02: [STORAGE] },
  vms: { prox02: [VM] },
  memoryMb: { prox02: 64000 },
};

const base = (over: Partial<BundleInput> = {}): BundleInput => ({
  now: new Date("2026-11-04T21:05:06Z"),
  toolkit: { version: "1.2.3" },
  wrapper: "current",
  files,
  report,
  probeOutput: [],
  survey,
  logs: { status: "read", text: "agent started\n" },
  ...over,
});

test("⭐ config: approved keys show values, every other key shows only that it is set", () => {
  const { config } = summarizeEnv(files);
  const [cfg, op] = [config["config.env"] ?? {}, config[".env.operator"] ?? {}];
  assert.deepEqual(cfg.PROVIDER_SLUG, { state: "set", value: "buzznet" });
  assert.deepEqual(op.PROXMOX_STORAGE_IMPORT, { state: "set", value: "local" });
  assert.deepEqual(cfg.SOME_FUTURE_SETTING, { state: "set" });
  assert.deepEqual(cfg.PROVIDER_CONTACT, { state: "set" });
  assert.deepEqual(op.PROXMOX_TOKEN_SECRET, { state: "set" });
  assert.deepEqual(op.OPERATOR_SSH_PUBKEY, { state: "empty" });
});

test("⭐ config: secrets.env reports names only, even for a key on the approved list", () => {
  const { config } = summarizeEnv({ secrets: "PROVIDER_SLUG=buzznet\nSTRIPE_SECRET_KEY=x\n" });
  assert.deepEqual(config["secrets.env"], { PROVIDER_SLUG: { state: "set" }, STRIPE_SECRET_KEY: { state: "set" } });
});

test("⭐ logs: a value from the local files is removed by exact match, whatever it looks like", () => {
  const log = `pve auth ${PVE_SECRET} ok\nkey is ${MANIFEST_KEY} here\nhash ${CONSOLE_HASH}\nraw ${COALITION_VALUE} end\n`;
  const { bundle, leaks } = buildBundle(base({ logs: { status: "read", text: log } }));
  assert.deepEqual(leaks, []);
  const text = JSON.stringify(bundle);
  for (const secret of [PVE_SECRET, MANIFEST_KEY, CONSOLE_HASH, COALITION_VALUE]) assert.ok(!text.includes(secret), secret);
  assert.equal(bundle.redactions["config-value"], 4);
});

test("⭐ logs: patterns catch secrets the local files never held", () => {
  const counts = {};
  const other = "rk_" + "test_" + "Z9y8X7w6V5u4";
  const out = redactText(
    [
      `stripe ${other}`,
      `hook whsec_${"z".repeat(12)}`,
      `Authorization: Bearer abc.def-ghi123`,
      `PVEAPIToken=user@pve!t=${PVE_SECRET}`,
      `https://admin:hunter22@10.0.0.5/x`,
      `DB_PASSWORD=swordfish9`,
      `ghp_${"a".repeat(30)}`,
      `mail buyer@example.com`,
      "b".repeat(90),
    ].join("\n"),
    [],
    counts
  );
  for (const gone of [other, "abc.def-ghi123", PVE_SECRET, "hunter22", "swordfish9", "buyer@example.com", "ghp_"]) {
    assert.ok(!out.includes(gone), gone);
  }
  assert.match(out, /DB_PASSWORD=\[redacted:named-secret\]/);
});

test("logs: a private key is removed whole across its lines, even cut off by the tail", () => {
  const { bundle } = buildBundle(base({ logs: { status: "read", text: `before\n${PEM}\nafter\n` } }));
  assert.deepEqual(bundle.logs.lines, ["before", "[redacted:private-key]", "after"]);
  const cut = PEM.slice(0, PEM.indexOf("-----END"));
  assert.deepEqual(buildBundle(base({ logs: { status: "read", text: cut } })).bundle.logs.lines, ["[redacted:private-key]"]);
});

test("⭐ logs: what support needs survives, a txid, a host, a VM, a plain error", () => {
  const line = `job failed: ${TXID} on prox02 10.0.0.5 bz-1: Storage type missing on hypervisor`;
  const { bundle } = buildBundle(base({ logs: { status: "read", text: `${line}\nPROXMOX_TOKEN_SECRET: missing\n` } }));
  assert.deepEqual(bundle.logs.lines, [line, "PROXMOX_TOKEN_SECRET: missing"]);
});

test("logs: keeps the last lines and caps a long one", () => {
  // Letters, not numbers: a number would make these all one shape.
  const word = (i: number) => i.toString(26).replace(/\d/g, (d) => "qrstuvwxyz"[Number(d)] ?? "");
  const lines = Array.from({ length: LOG_TAIL_LINES + 5 }, (_, i) => `line ${word(i)}`);
  lines[lines.length - 1] = "x ".repeat(MAX_LINE_CHARS);
  const { bundle } = buildBundle(base({ logs: { status: "read", text: lines.join("\n") } }));
  assert.equal(bundle.logs.lines.length, LOG_TAIL_LINES);
  assert.equal(bundle.logs.lines[0], lines[5]);
  assert.equal(bundle.logs.trimmed, true);
  assert.equal(bundle.logs.lines.at(-1)?.length, MAX_LINE_CHARS + 1);
});

test("⭐ logs: a rare old failure outlives thousands of heartbeats", () => {
  const stamp = (i: number) => `2026-11-0${1 + (i % 3)}T10:00:${String(i % 60).padStart(2, "0")}.000Z`;
  const lines = [`${stamp(0)} [step] Storage type missing on hypervisor`];
  for (let i = 1; i <= 5000; i++) lines.push(`${stamp(i)} [agent] reported health for ${1 + (i % 2)} node(s)`);
  const { bundle } = buildBundle(base({ logs: { status: "read", text: lines.join("\n") } }));
  assert.equal(bundle.logs.lines.length, KEEP_PER_SHAPE + 1);
  assert.equal(bundle.logs.lines[0], lines[0]);
  assert.equal(bundle.logs.lines.at(-1), lines.at(-1));
  assert.equal(bundle.logs.repeats.length, 1);
  assert.equal(bundle.logs.repeats[0]?.total, 5000);
  assert.equal(bundle.logs.repeats[0]?.dropped, 5000 - KEEP_PER_SHAPE);
  assert.match(bundleSummary(bundle).join("\n"), /4980 repeats left out/);
});

test("logs: the shape ignores numbers but not words", () => {
  const { kept, repeats } = collapseRepeats(["job 1 failed", "job 2 failed", "job 3 worked"]);
  assert.deepEqual(kept, ["job 1 failed", "job 2 failed", "job 3 worked"]);
  assert.deepEqual(repeats, []);
});

test("logs: each way of having none is named", () => {
  assert.equal(buildBundle(base({ logs: { status: "read", text: "\n" } })).bundle.logs.status, "empty");
  assert.equal(buildBundle(base({ logs: { status: "not-provided" } })).bundle.logs.status, "not-provided");
  assert.equal(buildBundle(base({ logs: { status: "missing" } })).bundle.logs.status, "missing");
});

test("doctor text is redacted too, and the findings keep their rule", () => {
  const leaky: DoctorReport = {
    ...report,
    findings: [{ ...FINDING, message: `bad token ${PVE_SECRET}`, fix: `set ${STRIPE_KEY}` }],
    unproven: [`hub: ${WEBHOOK}`],
  };
  const { bundle, leaks } = buildBundle(base({ report: leaky, probeOutput: [`proxmox ${PVE_SECRET}`] }));
  assert.deepEqual(leaks, []);
  const text = JSON.stringify(bundle);
  assert.ok(!text.includes(PVE_SECRET) && !text.includes(STRIPE_KEY) && !text.includes(WEBHOOK));
  assert.equal(bundle.doctor.findings[0]?.rule, FINDING.rule);
});

test("⭐ a secret typed into an approved field stops the bundle and is named by place only", () => {
  const typed = { ...files, config: `${files.config}\nPROVIDER_NAME=${STRIPE_KEY}\n` };
  const { leaks } = buildBundle(base({ files: typed }));
  assert.deepEqual(leaks, [
    { path: "config.config.env.PROVIDER_NAME.value", rule: "config-credential" },
    { path: "config.config.env.PROVIDER_NAME.value", rule: "stripe-key" },
  ]);
  assert.ok(!JSON.stringify(leaks).includes(STRIPE_KEY));
});

test("⭐ a credential that reaches a structured field stops the bundle", () => {
  const vms = { prox02: [{ ...VM, name: PVE_SECRET }] };
  const { leaks } = buildBundle(base({ survey: { ...survey, vms } }));
  assert.deepEqual(leaks, [{ path: "proxmox.vms.prox02[0].name", rule: "config-credential" }]);
});

test("the scan reads keys as well as values", () => {
  assert.deepEqual(scanForLeaks({ [STRIPE_KEY]: 1 }, []), [{ path: STRIPE_KEY, rule: "stripe-key" }]);
});

test("an ordinary long setting off the list is redacted but cannot stop the bundle", () => {
  const log = "reading not-on-the-list now\n";
  const typed = { ...files, config: `${files.config}\nPROVIDER_NAME=not-on-the-list\n` };
  const { bundle, leaks } = buildBundle(base({ files: typed, logs: { status: "read", text: log } }));
  assert.deepEqual(leaks, []);
  assert.deepEqual(bundle.logs.lines, ["reading [redacted:config-value] now"]);
});

test("the survey and inventory carry only their named fields", () => {
  const storages = { prox02: [{ ...STORAGE, extra: "no" }] };
  const inventoryText = JSON.stringify([
    { name: "prox02", storageImages: "local-lvm", apiToken: "no", slots: [{ vmName: "bz-1", tier: "cumulus", lanIp: "10.0.0.9/24", storagePool: "ssd", identityKey: "no" }] },
  ]);
  const { bundle } = buildBundle(base({ survey: { ...survey, storages }, inventoryText }));
  assert.ok(!JSON.stringify(bundle.proxmox).includes("extra"));
  assert.deepEqual(bundle.inventory, [
    { name: "prox02", storageImages: "local-lvm", slots: [{ vmName: "bz-1", tier: "cumulus", lanIp: "10.0.0.9/24", storagePool: "ssd" }] },
  ]);
});

test("--vm pulls that VM's Proxmox row and slot to the top", () => {
  const inventoryText = JSON.stringify([{ name: "prox02", slots: [{ vmName: "bz-1", tier: "cumulus" }] }]);
  const { bundle } = buildBundle(base({ focusVm: "bz-1", inventoryText }));
  assert.equal(bundle.focus?.proxmox?.node, "prox02");
  assert.deepEqual(bundle.focus?.inventory, { host: "prox02", vmName: "bz-1", tier: "cumulus" });
  const none = buildBundle(base({ focusVm: "bz-9" })).bundle;
  assert.match(bundleSummary(none).join("\n"), /bz-9 \(not found/);
});

test("broken pieces are named in the summary, never left out silently", () => {
  const { bundle } = buildBundle(base({ survey: undefined, inventoryText: "not json", logs: { status: "not-provided" } }));
  const text = bundleSummary(bundle).join("\n");
  assert.match(text, /Proxmox survey:\s+NOT INCLUDED/);
  assert.match(text, /Inventory:\s+NOT INCLUDED/);
  assert.match(text, /--update-wrapper/);
});

test("the file name carries the slug and a sortable time", () => {
  assert.equal(bundleFileName(files.config, "2026-11-04T21:05:06.000Z"), "fh-diagnose-buzznet-20261104-210506.json");
  assert.equal(bundleFileName(undefined, "2026-11-04T21:05:06.000Z"), "fh-diagnose-operator-20261104-210506.json");
});

test("only the wrapper's temp file name is accepted", () => {
  assert.ok(LOGS_FILE_RE.test(".fh-diagnose-logs.aB3dE9"));
  for (const bad of ["../secrets.env", "secrets.env", ".fh-diagnose-logs.a/../../x"]) assert.ok(!LOGS_FILE_RE.test(bad), bad);
});

// ---------------------------------------------------------------- the CLI, end to end

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
const TSX = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));

function run(args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(TSX, [CLI, "diagnose", ...args], {
    encoding: "utf8",
    env: { ...process.env, FH_WRAPPER: "none", ...env },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

function box(config = "PROVIDER_SLUG=buzznet\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "fh-diagnose-"));
  writeFileSync(join(dir, "config.env"), config);
  writeFileSync(join(dir, "secrets.env"), files.secrets);
  return dir;
}

test("⭐ cli: writes a private file with the logs in it and no secret, and sends nothing", () => {
  const dir = box();
  try {
    writeFileSync(join(dir, ".fh-diagnose-logs.abc123"), `started\nstripe ${STRIPE_KEY}\n`);
    const r = run(["--dir", dir, "--dry-run"], { FH_DIAGNOSE_LOGS: ".fh-diagnose-logs.abc123", FH_AGENT_RUNNING: "0.11.69" });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Nothing was sent/);
    const name = readdirSync(dir).find((f) => f.startsWith("fh-diagnose-buzznet-"));
    assert.ok(name, "no bundle written");
    const path = join(dir, name);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    const text = readFileSync(path, "utf8");
    assert.ok(!text.includes(STRIPE_KEY));
    const bundle = JSON.parse(text);
    assert.equal(bundle.agentRunning, "0.11.69");
    assert.deepEqual(bundle.logs.lines, ["started", "stripe [redacted:config-value]"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⭐ cli: a leak stops it, writes no file, and never prints the value", () => {
  const dir = box(`PROVIDER_SLUG=buzznet\nPROVIDER_NAME=${STRIPE_KEY}\n`);
  try {
    const r = run(["--dir", dir]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /STOPPED/);
    assert.match(r.out, /PROVIDER_NAME/);
    assert.ok(!r.out.includes(STRIPE_KEY));
    assert.ok(!readdirSync(dir).some((f) => f.startsWith("fh-diagnose-")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: a logs path that is not the wrapper's temp file is never read", () => {
  const dir = box();
  try {
    assert.equal(run(["--dir", dir], { FH_DIAGNOSE_LOGS: "secrets.env" }).code, 0);
    const name = readdirSync(dir).find((f) => f.startsWith("fh-diagnose-"))!;
    assert.equal(JSON.parse(readFileSync(join(dir, name), "utf8")).logs.status, "not-provided");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cli: outside an operator directory it says so", () => {
  const dir = mkdtempSync(join(tmpdir(), "fh-diagnose-"));
  try {
    const r = run(["--dir", dir]);
    assert.equal(r.code, 1);
    assert.match(r.out, /operator directory/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
