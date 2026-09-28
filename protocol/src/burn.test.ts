import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BURNER_VERSION, burnScript, burnVms, parseBurnPlan, type BurnOptions } from "./burn";
import type { HostCheckInput } from "./host-check";
import { tmpDir } from "./test-tmp";

const V = BURNER_VERSION;
const IMG = `fh-burner-${V}.qcow2`;
const CTL = `fh-burner-${V}-host.sh`;

/**
 * A fake Proxmox host: `qm list` rows, a fake GitHub release served by a stub wget, and
 * a fake controller that records the arguments it was handed instead of burning.
 */
interface Fake {
  /** `qm list` rows: [vmid, name, status]. */
  vms?: [number, string, string][];
  /** The release's files are corrupted (checksum no longer matches). */
  badChecksum?: boolean;
  /** The release does not exist (wget fails). */
  unreleased?: boolean;
  /** Files already downloaded into the burn dir. */
  cached?: boolean;
  hostname?: string;
  /** Template 9900 exists with this tags line (burn's own is `fh-burn`). */
  template?: string;
}

function run(host: HostCheckInput, fake: Fake = {}, opts: BurnOptions = {}) {
  const root = tmpDir("fh-burn-");
  const put = (rel: string, text: string, mode = 0o644) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
    chmodSync(join(root, rel), mode);
  };
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const release = {
    [IMG]: "qcow2 bytes\n",
    [CTL]: `#!/bin/bash\necho "CONTROLLER $*" > "$FH_BURN_DIR/../controller-args"\necho controller ran\n`,
  };
  for (const [name, body] of Object.entries(release)) {
    put(`release/${name}`, fake.badChecksum && name === IMG ? "tampered\n" : body);
    put(`release/${name}.sha256`, `${sha(body)}  ${name}\n`);
    if (fake.cached) {
      put(`burn/${name}`, body);
      put(`burn/${name}.sha256`, `${sha(body)}  ${name}\n`);
    }
  }
  const rows = (fake.vms ?? []).map(([id, name, st]) => `${String(id).padStart(10)} ${name.padEnd(20)} ${st.padEnd(10)} 2048  32.00 0`);
  put(
    "bin/qm",
    `#!/bin/bash\n[ "$1" = list ] && printf '%s\\n' "      VMID NAME                 STATUS     MEM(MB)    BOOTDISK(GB) PID" ${rows.map((r) => `'${r}'`).join(" ")}\n` +
      (fake.template !== undefined ? `[ "$1 $2" = "config 9900" ] && echo 'tags: ${fake.template}'\n` : "") +
      `[ "$1" = destroy ] && echo "$*" >> "$FH_BURN_DIR/../qm.log"\nexit 0\n`,
    0o755
  );
  put(
    "bin/wget",
    `#!/bin/bash\necho "$*" >> "$FH_BURN_DIR/../wget.log"\n${fake.unreleased ? "exit 8" : 'out=$3; cp "$FAKE_RELEASE/$(basename "$4")" "$out"'}\n`,
    0o755
  );
  put("bin/id", "#!/bin/bash\necho 0\n", 0o755);
  put("bin/hostname", `#!/bin/bash\necho ${fake.hostname ?? host.name}\n`, 0o755);
  mkdirSync(join(root, "burn"), { recursive: true });
  const r = spawnSync("bash", ["-c", burnScript(host, "0.0.0-test", opts)], {
    env: { ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`, FH_BURN_DIR: join(root, "burn"), FAKE_RELEASE: join(root, "release") },
    encoding: "utf8",
  });
  const args = join(root, "controller-args");
  const qmLog = join(root, "qm.log");
  return {
    out: r.stdout + r.stderr,
    status: r.status,
    controller: existsSync(args) ? readFileSync(args, "utf8").trim() : undefined,
    wget: existsSync(join(root, "wget.log")) ? readFileSync(join(root, "wget.log"), "utf8") : "",
    destroyed: existsSync(qmLog) ? readFileSync(qmLog, "utf8").trim() : "",
    burnDirLeft: existsSync(join(root, "burn")),
  };
}

const pve25: HostCheckInput = { name: "pve25", storageImages: "ssd", vmMemoryMb: { nimbus: 31744 }, slots: [{ tier: "nimbus", vmName: "mt-186-n5" }] };
const pve40: HostCheckInput = {
  name: "pve40",
  storageImages: "local-lvm",
  vmMemoryMb: { cumulus: 7424 },
  slots: [
    { tier: "cumulus", vmName: "mt-185-c1", storagePool: "ss1" },
    { tier: "cumulus", vmName: "mt-185-c2", storagePool: "ss3" },
    { tier: "cumulus", vmName: "mt-185-c3" },
  ],
};

test("one burn VM per slot: the host's size, the tier's cores, the slot's pool else the host's", () => {
  assert.deepEqual(burnVms(pve40), [
    { tier: "cumulus", mb: 7424, cores: 4, pool: "ss1" },
    { tier: "cumulus", mb: 7424, cores: 4, pool: "ss3" },
    { tier: "cumulus", mb: 7424, cores: 4, pool: "local-lvm" },
  ]);
  assert.deepEqual(burnVms(pve25), [{ tier: "nimbus", mb: 31744, cores: 8, pool: "ssd" }]);
});

test("--plan replaces the slots; tier defaults where the host has no size; bad plans say why", () => {
  assert.deepEqual(parseBurnPlan("nimbus:1,cumulus:2").plan, [
    { tier: "nimbus", count: 1 },
    { tier: "cumulus", count: 2 },
  ]);
  assert.deepEqual(parseBurnPlan("stratus").plan, [{ tier: "stratus", count: 1 }]);
  assert.deepEqual(burnVms(pve25, parseBurnPlan("cumulus:2").plan), [
    { tier: "cumulus", mb: 8192, cores: 4, pool: "ssd" },
    { tier: "cumulus", mb: 8192, cores: 4, pool: "ssd" },
  ]);
  assert.match(parseBurnPlan("mystery:1").error!, /tier one of cumulus, nimbus, stratus/);
  assert.match(parseBurnPlan("nimbus:0").error!, /count 1\.\.64/);
});

test("empty host: fetches and checks the release, hands the controller the plan, lists the gateway", () => {
  const r = run(pve40, { vms: [[100, "OPNsense-185", "running"], [102, "LiveCD", "stopped"]] });
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /burn: fetching fh-burner-.*\.qcow2/);
  assert.match(r.out, /also running \(they stay on, as they will under the real nodes\): OPNsense-185$/m);
  assert.doesNotMatch(r.out, /LiveCD/);
  assert.match(r.out, /3 VM\(s\): cumulus:7424:4:ss1 cumulus:7424:4:ss3 cumulus:7424:4:local-lvm/);
  assert.match(r.out, /about 9 min \(up to 18 if all-memory FAILs and it re-runs at 90%\)/);
  assert.match(r.controller!, new RegExp(`^CONTROLLER --image .*/burn/${IMG.replace(/\./g, "\\.")} --plan cumulus:7424:4:ss1 cumulus:7424:4:ss3 cumulus:7424:4:local-lvm --fill max$`));
  assert.match(r.wget, new RegExp(`releases/download/fh-burner-v${V.replace(/\./g, "\\.")}/${IMG.replace(/\./g, "\\.")}\\.sha256`));
});

test("a node VM on the host (with or without the fh- prefix) stops it before anything is fetched", () => {
  for (const name of ["mt-185-c2", "fh-mt-185-c2"]) {
    const r = run(pve40, { vms: [[110, name, "stopped"]] });
    assert.equal(r.status, 1);
    assert.match(r.out, new RegExp(`pve40 is not empty — these node VMs exist: ${name}\\(stopped\\)`));
    assert.equal(r.wget, "");
    assert.equal(r.controller, undefined);
  }
});

test("leftover burn VMs are not node VMs (the controller refuses those itself)", () => {
  const r = run(pve25, { vms: [[9900, "fh-burner-tmpl", "stopped"]] });
  assert.equal(r.status, 0, r.out);
});

test("a tampered download is refused; an unreleased version says so; a cached release is not fetched again", () => {
  const bad = run(pve25, { badChecksum: true });
  assert.equal(bad.status, 1);
  assert.match(bad.out, /does not match its \.sha256/);
  assert.equal(bad.controller, undefined);

  const missing = run(pve25, { unreleased: true });
  assert.equal(missing.status, 1);
  assert.match(missing.out, new RegExp(`is fh-burner ${V.replace(/\./g, "\\.")} released\\?`));

  const cached = run(pve25, { cached: true });
  assert.equal(cached.status, 0, cached.out);
  assert.equal(cached.wget, "");
  assert.doesNotMatch(cached.out, /fetching/);
});

test("options reach the controller; no slots and no --plan says what to do; another hostname is noted", () => {
  const r = run(pve25, {}, { fill: "90", keep: true, noRetry: true });
  assert.match(r.controller!, /--fill 90 --keep --no-retry$/);
  assert.match(r.out, /about 3 min\. Ctrl-C/);

  const none = run({ ...pve25, slots: [] });
  assert.equal(none.status, 1);
  assert.match(none.out, /pve25 has no node slots in the inventory — say what to burn: fh-toolkit burn pve25 --plan nimbus:1/);

  const other = run(pve25, { hostname: "pve26" });
  assert.match(other.out, /this plan is for pve25, and this host calls itself pve26/);
});

test("at the end the template and the download go too; --keep leaves them; a foreign 9900 is never touched", () => {
  const r = run(pve25, { template: "fh-burn" });
  assert.equal(r.status, 0, r.out);
  assert.equal(r.destroyed, "destroy 9900 --purge 1");
  assert.equal(r.burnDirLeft, false);
  assert.match(r.out, /burn: removed template 9900 and the fh-burner download$/m);

  const kept = run(pve25, { template: "fh-burn" }, { keep: true });
  assert.equal(kept.destroyed, "");
  assert.equal(kept.burnDirLeft, true);
  assert.match(kept.out, /--keep: template 9900 and .* left in place/);

  const foreign = run(pve25, { template: "customer" });
  assert.equal(foreign.status, 0, foreign.out);
  assert.equal(foreign.destroyed, "");
});

test("burn-host.sh (the released controller) rejects a malformed plan before touching the host", () => {
  const ctl = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "burner", "burn-host.sh");
  const img = join(tmpDir("fh-burn-ctl-"), "fh-burner-9.9.9.qcow2");
  writeFileSync(img, "x");
  const r = spawnSync("bash", [ctl, "--image", img, "--plan", "nimbus:31744:8"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /bad plan entry 'nimbus:31744:8'/);
  const noPlan = spawnSync("bash", [ctl, "--image", img], { encoding: "utf8" });
  assert.equal(noPlan.status, 2);
  assert.match(noPlan.stderr, /usage: burn-host\.sh/);
});
