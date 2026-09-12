import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What `init` must finish by itself.
 *
 * Measured on a real from-zero onboarding (prod, 2026-08-22): after answering every
 * question, `fh-toolkit doctor` reported TEN `NOT_YET_FILLED` warnings — and seven of
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
  vmNamePrefix: "ft-",
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
      assert.match(err.stderr ?? "", /fh-toolkit keygen/);
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

test("MANIFEST_PUBKEY is pinned, so fh-agent doctor compares instead of skipping", () => {
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

// Phase E step 4 (2026-09-07): /onboard no longer issues the two bearers, and the
// scaffold no longer emits blanks for them. One key, not three.
const ISSUED_BY_ONBOARD = ["COALITION_SIGNING_KEY"];

test("⭐ a self-hoster is left with exactly the key /onboard issues", () => {
  const { dir } = scaffold({ ...ANSWERS, selling: false });
  assert.deepEqual(emptyKeys(dir), ISSUED_BY_ONBOARD);
});

test("⭐ an operator who supplied Stripe is left with the same one", () => {
  const { dir } = scaffold({
    ...ANSWERS,
    tierPricesCents: { cumulus: 700 },
    stripeSecretKey: "rk_test_example",
    stripeWebhookSecret: "whsec_example",
  });
  assert.deepEqual(emptyKeys(dir), ISSUED_BY_ONBOARD);
});

test("an operator who has not done Stripe yet is left with that one plus the Stripe pair", () => {
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
  assert.doesNotMatch(stdout, /1\. fh-toolkit keygen/);
  assert.match(stdout, /MANIFEST_KEY {3}filled/);
  assert.match(stdout, /1\. open .*\/onboard/);
});

/**
 * ⭐ Piped answers are refused, not half-consumed.
 *
 * Reproduced on the 2026-09-10 cold run, through a pipe AND through a real pty: `init`
 * printed its first question, took the first answer, and exited **0** having written
 * nothing at all. Node's readline resolves the first `question()`, then stdin hits EOF
 * and every later promise simply never settles — no handler, no error, no files, and a
 * success exit code. A wizard that reports success and produces nothing is the worst
 * shape this failure could take, so the guard is at the prompt, not in the docs.
 */
test("⭐ `init` refuses a non-terminal stdin instead of exiting 0 with nothing written", () => {
  const dir = mkdtempSync(join(tmpdir(), "fh-init-stdin-"));
  try {
    // `init` needs the signing key before it asks anything, so the refusal under test is
    // the one at the prompts rather than the missing-key guard in front of them.
    // Both run FROM the directory, the way an operator does — the mount is the cwd.
    execFileSync("npx", ["tsx", CLI, "keygen"], { encoding: "utf8", cwd: dir });
    let status = 0;
    let stderr = "";
    try {
      execFileSync("npx", ["tsx", CLI, "init"], {
        input: "answer-one\nanswer-two\nanswer-three\n",
        encoding: "utf8",
        cwd: dir,
        env: { ...process.env, FH_WRAPPER: "none" },
      });
    } catch (e) {
      const err = e as { status?: number; stderr?: string };
      status = err.status ?? 0;
      stderr = err.stderr ?? "";
    }
    assert.notEqual(status, 0, "a refusal has to be visible to a script");
    assert.match(stderr, /stdin is not a terminal/);
    // The message must carry the way out, or the operator is stuck where the tool is.
    assert.match(stderr, /--answers/);
    assert.deepEqual(
      readdirSync(dir).filter((f) => !f.startsWith("manifest-")).sort(),
      [],
      "nothing may be written on the refused path"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * ⭐ `keygen` writes where you told it, or says it does not understand you.
 *
 * `--out` names a FILE on `sign` and `env` and a DIRECTORY on `keygen`/`init`, so an
 * operator who learned `--dir` from `doctor` used it here — and it was taken as a bare
 * argument and ignored. The key, the one file in the scaffold that cannot be regenerated,
 * landed in whatever directory they were standing in, and the command reported success.
 */
test("⭐ `keygen --dir` writes there, and an unknown option is refused", () => {
  const dir = mkdtempSync(join(tmpdir(), "fh-keygen-dir-"));
  const cwd = mkdtempSync(join(tmpdir(), "fh-keygen-cwd-"));
  try {
    execFileSync("npx", ["tsx", CLI, "keygen", "--dir", dir], { encoding: "utf8", cwd });
    assert.deepEqual(readdirSync(dir).sort(), ["manifest-key.pem", "manifest-pubkey.txt"]);
    assert.deepEqual(readdirSync(cwd), [], "nothing may be written to the cwd");

    // --out still works: it is what the docs and CI have always passed.
    const alias = mkdtempSync(join(tmpdir(), "fh-keygen-out-"));
    execFileSync("npx", ["tsx", CLI, "keygen", "--out", alias], { encoding: "utf8", cwd });
    assert.ok(readdirSync(alias).includes("manifest-key.pem"));
    rmSync(alias, { recursive: true, force: true });

    // Two spellings that disagree are refused rather than one quietly winning.
    assert.throws(
      () => execFileSync("npx", ["tsx", CLI, "keygen", "--dir", dir, "--out", cwd], { encoding: "utf8", cwd }),
      (e: { stderr?: string }) => /disagree/.test(String(e.stderr))
    );

    // And a flag it does not know stops it, instead of being read as a directory.
    assert.throws(
      () => execFileSync("npx", ["tsx", CLI, "keygen", "--outdir", cwd], { encoding: "utf8", cwd }),
      (e: { stderr?: string }) => /unknown option --outdir/.test(String(e.stderr))
    );
    assert.deepEqual(readdirSync(cwd), [], "a refused run writes nothing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});
