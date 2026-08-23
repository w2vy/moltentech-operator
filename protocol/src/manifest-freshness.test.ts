import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runDoctor } from "./config-lint";
import { verifyManifestObject } from "./signing";

/**
 * `init` now signs manifest.json itself. It used to stop one command short: the closing
 * steps said "paste your manifest at /onboard" while no manifest existed anywhere on
 * disk, and the missing `mt-manifest sign` was documented only in the runbook.
 *
 * Signing automatically buys a new failure mode, and these tests are the price of it.
 * A signed manifest is a SNAPSHOT of config.env; edit config.env afterwards and the file
 * still carries the old values, correctly signed. Pasting it ingests the wrong provider
 * with every signature valid — invisible to everything downstream.
 */

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

const ANSWERS = {
  providerSlug: "fresh-test",
  providerName: "Fresh Test",
  ownerAddress: "t1exampleOwnerWalletAddress",
  mtBaseUrl: "https://127.0.0.1:1",
  fluxAppName: "coalition-fresh-test",
  hosts: [
    {
      name: "pve-01",
      storageImages: "ssd",
      storageIso: "iso-store",
      slots: [
        {
          tier: "cumulus",
          vmName: "ft-c1",
          ipAddress: "203.0.113.10",
          lanIp: "192.168.1.10/24",
          gateway: "192.168.1.1",
          apiPort: 16127,
        },
      ],
    },
  ],
};

function cli(args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", CLI, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), "mt-fresh-"));
  writeFileSync(join(dir, "answers.json"), JSON.stringify(ANSWERS));
  cli(["keygen", "--out", dir]);
  cli(["init", "--out", dir, "--answers", join(dir, "answers.json")]);
  return dir;
}

const read = (dir: string, f: string): string => readFileSync(join(dir, f), "utf8");
const doctor = (dir: string) =>
  runDoctor({ configEnv: read(dir, "config.env"), manifestJson: read(dir, "manifest.json") });

test("⭐ init produces the signed manifest its own closing steps tell you to paste", () => {
  const dir = scaffold();
  assert.ok(existsSync(join(dir, "manifest.json")), "init must not stop one command short");
  const m = JSON.parse(read(dir, "manifest.json"));
  assert.equal(verifyManifestObject(m), true);
  assert.equal(m.provider.slug, ANSWERS.providerSlug);
  assert.equal(m.ownerAddress, ANSWERS.ownerAddress);
});

test("the manifest is signed by the key in the directory, not some other one", () => {
  const dir = scaffold();
  assert.equal(JSON.parse(read(dir, "manifest.json")).pubkey, read(dir, "manifest-pubkey.txt").trim());
});

test("a fresh scaffold reports no staleness — signing and checking agree", () => {
  assert.deepEqual(doctor(scaffold()).findings.filter((f) => f.rule.startsWith("MANIFEST_")), []);
});

test("⭐ editing config.env after signing is an ERROR that names what moved", () => {
  // The whole reason auto-signing is safe. Without this the operator pastes a valid
  // signature over stale values and nothing anywhere reports a problem.
  const dir = scaffold();
  writeFileSync(join(dir, "config.env"), read(dir, "config.env").replace(/^TRIAL_DAYS=.*$/m, "TRIAL_DAYS=7"));
  const stale = doctor(dir).findings.find((f) => f.rule === "MANIFEST_STALE")!;
  assert.equal(stale.severity, "error");
  assert.match(stale.message, /trialDays/);
  assert.match(stale.message, /mt-manifest sign/);
});

test("re-signing clears it, so the fix the message names actually works", () => {
  const dir = scaffold();
  writeFileSync(join(dir, "config.env"), read(dir, "config.env").replace(/^TRIAL_DAYS=.*$/m, "TRIAL_DAYS=7"));
  cli(["sign", "--key", join(dir, "manifest-key.pem"), "--from-config", join(dir, "config.env"),
       "--out", join(dir, "manifest.json")]);
  assert.deepEqual(doctor(dir).findings.filter((f) => f.rule.startsWith("MANIFEST_")), []);
});

test("a hand-edited manifest is caught as a BROKEN SIGNATURE, not as staleness", () => {
  // Different cause, different fix: staleness means re-sign, a bad signature means someone
  // edited the signed artifact and their edit is about to be thrown away.
  const dir = scaffold();
  const m = JSON.parse(read(dir, "manifest.json"));
  m.trialDays = 9;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m, null, 2));
  const f = doctor(dir).findings.find((x) => x.rule === "MANIFEST_SIG_INVALID")!;
  assert.equal(f.severity, "error");
  assert.match(f.message, /edited by hand/);
});

test("init REFUSES to clobber an existing manifest.json without --force", () => {
  // It is the one generated file carrying a signature, and it was the only one the
  // overwrite guard did not name.
  const dir = scaffold();
  assert.throws(
    () => cli(["init", "--out", dir, "--answers", join(dir, "answers.json")]),
    (err: Error & { stderr?: string }) => {
      assert.match(err.stderr ?? "", /manifest\.json/);
      return true;
    }
  );
});

test("doctor with no manifest.json says nothing about it — mid-onboarding is not an error", () => {
  const dir = scaffold();
  assert.deepEqual(
    runDoctor({ configEnv: read(dir, "config.env") }).findings.filter((f) => f.rule.startsWith("MANIFEST_")),
    []
  );
});

/**
 * `env` is the last command between a finished scaffold and a deployable Flux app, and
 * it used to be the longest to type: three required paths, all naming files `init` had
 * just written into the directory you were standing in. The runbook's own instruction —
 * "run `mt-manifest env`" — did not work as written.
 */

test("⭐ `env` needs no arguments in a scaffold directory", () => {
  const dir = scaffold();
  // Fill the three keys /onboard issues; env legitimately requires them.
  writeFileSync(
    join(dir, "secrets.env"),
    read(dir, "secrets.env")
      .replace(/^AGENT_KEY=$/m, "AGENT_KEY=ak_test")
      .replace(/^COALITION_KEY=$/m, "COALITION_KEY=ck_test")
      .replace(/^STRIPE_SECRET_KEY=$/m, "STRIPE_SECRET_KEY=rk_test")
      .replace(/^STRIPE_WEBHOOK_SECRET=$/m, "STRIPE_WEBHOOK_SECRET=whsec_test")
  );
  cli(["env", "--dir", dir]);
  const pairs = JSON.parse(read(dir, "env.json")) as string[];
  assert.ok(Array.isArray(pairs) && pairs.length > 0);
  assert.ok(pairs.some((p) => p.startsWith("MANIFEST_JSON=")), "the signed manifest must ship");
  assert.ok(pairs.some((p) => p === "AGENT_KEY=ak_test"));
});

test("a missing file names WHICH file and where env expected it", () => {
  const dir = mkdtempSync(join(tmpdir(), "mt-env-empty-"));
  assert.throws(
    () => cli(["env", "--dir", dir]),
    (err: Error & { stderr?: string }) => {
      assert.match(err.stderr ?? "", /config\.env not found/);
      assert.match(err.stderr ?? "", /--dir/);
      return true;
    }
  );
});
