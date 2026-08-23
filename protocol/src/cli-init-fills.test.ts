import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What `init` must finish by itself.
 *
 * Measured on a real from-zero onboarding (prod, 2026-08-22): after answering every
 * question, `mt-manifest doctor` reported TEN `NOT_YET_FILLED` warnings — and seven of
 * them were values init already held (the key on disk), could generate (a random
 * secret), or could have asked for (the Proxmox token that Step 0.1 had just printed).
 *
 * The invariant these tests defend: an empty value in a freshly generated secrets.env
 * means ANOTHER SYSTEM has to issue it. Exactly three qualify — the keys /onboard mints
 * and shows once. A warning list that is mostly noise is one the operator skims.
 */

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

const ANSWERS = {
  providerSlug: "fills-test",
  providerName: "Fills Test Operator",
  ownerAddress: "t1exampleOwnerWalletAddress",
  // Unreachable on purpose: these tests are about local file contents, and no test
  // should depend on MT being up.
  mtBaseUrl: "https://127.0.0.1:1",
  fluxAppName: "coalition-fills-test",
  proxmoxTokenId: "fluxhub@pve!agent",
  proxmoxTokenSecret: "11111111-2222-3333-4444-555555555555",
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

function scaffold(answers: Record<string, unknown> = ANSWERS): { dir: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "mt-init-fills-"));
  writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
  cli(["keygen", "--out", dir]);
  const stdout = cli(["init", "--out", dir, "--answers", join(dir, "answers.json")]);
  return { dir, stdout };
}

const read = (dir: string, f: string): string => readFileSync(join(dir, f), "utf8");
const valueOf = (text: string, key: string): string =>
  text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";

test("init REFUSES without manifest-key.pem, and names keygen as the fix", () => {
  const dir = mkdtempSync(join(tmpdir(), "mt-init-nokey-"));
  writeFileSync(join(dir, "answers.json"), JSON.stringify(ANSWERS));
  assert.throws(
    () => cli(["init", "--out", dir, "--answers", join(dir, "answers.json")]),
    (err: Error & { stderr?: string }) => {
      assert.match(err.stderr ?? "", /manifest-key\.pem not found/);
      assert.match(err.stderr ?? "", /mt-manifest keygen/);
      return true;
    }
  );
});

test("⭐ the refusal comes BEFORE the first question, not after the last one", () => {
  // A precondition checked where its value is first USED is not a precondition. This one
  // used to fire after every prompt AND the MT_PUBKEY fetch, so an operator without a key
  // answered the whole wizard — Proxmox token included — and lost all of it to a die().
  const dir = mkdtempSync(join(tmpdir(), "mt-init-nokey-early-"));
  assert.throws(
    () => cli(["init", "--out", dir]),
    (err: Error & { stdout?: string; stderr?: string }) => {
      assert.match(err.stderr ?? "", /manifest-key\.pem not found/);
      assert.doesNotMatch(err.stdout ?? "", /Which are you\?/, "no question may be asked first");
      // Nor may it have gone to the network for tier minimums before refusing.
      assert.doesNotMatch(err.stderr ?? "", /tier minimums/);
      return true;
    }
  );
});

test("⭐ MANIFEST_KEY is filled in BOTH files, and is base64 of the key on disk", () => {
  const { dir } = scaffold();
  const expected = Buffer.from(read(dir, "manifest-key.pem"), "utf8").toString("base64");
  assert.equal(valueOf(read(dir, "secrets.env"), "MANIFEST_KEY"), expected);
  assert.equal(valueOf(read(dir, ".env.operator"), "MANIFEST_KEY"), expected);
  // Single-line: agent/src/signing.ts decodes this straight into a PEM, and a wrapped
  // value is the shape `base64` without -w0 produces.
  assert.ok(!expected.includes("\n"), "MANIFEST_KEY must be one line");
});

test("MANIFEST_PUBKEY is pinned, so mt-agent doctor compares instead of skipping", () => {
  const { dir } = scaffold();
  const pinned = valueOf(read(dir, ".env.operator"), "MANIFEST_PUBKEY");
  assert.equal(pinned, read(dir, "manifest-pubkey.txt").trim());
  assert.notEqual(pinned, "");
});

test("a deleted manifest-pubkey.txt still pins — the key itself is the source", () => {
  const dir = mkdtempSync(join(tmpdir(), "mt-init-nopub-"));
  writeFileSync(join(dir, "answers.json"), JSON.stringify(ANSWERS));
  cli(["keygen", "--out", dir]);
  const fromKeygen = read(dir, "manifest-pubkey.txt").trim();
  rmSync(join(dir, "manifest-pubkey.txt"));
  cli(["init", "--out", dir, "--answers", join(dir, "answers.json")]);
  assert.equal(valueOf(read(dir, ".env.operator"), "MANIFEST_PUBKEY"), fromKeygen);
});

test("SESSION_SECRET is generated: 32 random bytes, hex, different every run", () => {
  const a = valueOf(read(scaffold().dir, "secrets.env"), "SESSION_SECRET");
  const b = valueOf(read(scaffold().dir, "secrets.env"), "SESSION_SECRET");
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, b, "two scaffolds must not share a session secret");
});

test("an explicitly supplied sessionSecret is kept — a re-run must not log everyone out", () => {
  const pinned = "a".repeat(64);
  const { dir } = scaffold({ ...ANSWERS, sessionSecret: pinned });
  assert.equal(valueOf(read(dir, "secrets.env"), "SESSION_SECRET"), pinned);
});

test("the Proxmox token reaches .env.operator from --answers, both halves", () => {
  const { dir } = scaffold();
  const env = read(dir, ".env.operator");
  assert.equal(valueOf(env, "PROXMOX_TOKEN_ID"), ANSWERS.proxmoxTokenId);
  assert.equal(valueOf(env, "PROXMOX_TOKEN_SECRET"), ANSWERS.proxmoxTokenSecret);
});

function emptyKeys(dir: string): string[] {
  return read(dir, "secrets.env")
    .split("\n")
    .filter((l) => /^[A-Z_]+=$/.test(l))
    .map((l) => l.slice(0, -1))
    .sort();
}

const ISSUED_BY_ONBOARD = ["AGENT_KEY", "COALITION_KEY", "COALITION_SIGNING_KEY"];

test("⭐ a self-hoster is left with exactly the three keys /onboard issues", () => {
  const { dir } = scaffold({ ...ANSWERS, selling: false });
  assert.deepEqual(emptyKeys(dir), ISSUED_BY_ONBOARD);
});

test("⭐ an operator who supplied Stripe is left with the same three", () => {
  const { dir } = scaffold({
    ...ANSWERS,
    tierPricesCents: { cumulus: 700 },
    stripeSecretKey: "rk_test_example",
    stripeWebhookSecret: "whsec_example",
  });
  assert.deepEqual(emptyKeys(dir), ISSUED_BY_ONBOARD);
});

test("an operator who has not done Stripe yet is left with those three plus the Stripe pair", () => {
  // These two are legitimately NOT_YET_FILLED: the restricted key comes from the Stripe
  // dashboard and the webhook secret does not exist until the endpoint is created against
  // the Coalition URL. Empty here means WAITING ON SOMEONE ELSE, which is the contract.
  const { dir } = scaffold({ ...ANSWERS, tierPricesCents: { cumulus: 700 } });
  assert.deepEqual(emptyKeys(dir), [...ISSUED_BY_ONBOARD, "STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"].sort());
});

test("a paid tier still leaves the Stripe pair empty when the operator supplied none", () => {
  const { dir } = scaffold({ ...ANSWERS, tierPricesCents: { cumulus: 700 } });
  const secrets = read(dir, "secrets.env");
  // Present-but-empty, never absent: an absent line is a gap nobody can notice, which is
  // the same reasoning MT_PUBKEY's empty line already carries.
  assert.match(secrets, /^STRIPE_SECRET_KEY=$/m);
  assert.match(secrets, /^STRIPE_WEBHOOK_SECRET=$/m);
});

test("supplied Stripe values are written through", () => {
  const { dir } = scaffold({
    ...ANSWERS,
    tierPricesCents: { cumulus: 700 },
    stripeSecretKey: "rk_test_example",
    stripeWebhookSecret: "whsec_example",
  });
  const secrets = read(dir, "secrets.env");
  assert.equal(valueOf(secrets, "STRIPE_SECRET_KEY"), "rk_test_example");
  assert.equal(valueOf(secrets, "STRIPE_WEBHOOK_SECRET"), "whsec_example");
});

test("no secret leaks into config.env, which is the file that gets committed", () => {
  const { dir } = scaffold({
    ...ANSWERS,
    tierPricesCents: { cumulus: 700 },
    stripeSecretKey: "rk_test_example",
  });
  const config = read(dir, "config.env");
  for (const secret of [
    ANSWERS.proxmoxTokenSecret,
    "rk_test_example",
    Buffer.from(read(dir, "manifest-key.pem"), "utf8").toString("base64"),
    valueOf(read(dir, "secrets.env"), "SESSION_SECRET"),
  ]) {
    assert.ok(!config.includes(secret), "config.env is non-secret by contract");
  }
});

test("the closing steps no longer tell you to run keygen — you just did", () => {
  const { stdout } = scaffold();
  assert.doesNotMatch(stdout, /1\. mt-manifest keygen/);
  assert.match(stdout, /MANIFEST_KEY {3}filled/);
  assert.match(stdout, /1\. open .*\/onboard/);
});
