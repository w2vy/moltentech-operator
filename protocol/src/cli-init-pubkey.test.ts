import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { needsMtPubkey } from "./scaffold";

// `init --answers` never derived MT_PUBKEY (operator#54): the fetch lived inside the
// interactive `askAnswers`, so the non-interactive path — the one CI drives and the one a
// second operator is most likely to copy — wrote `MT_PUBKEY=` empty and said nothing.
//
// That is a DELAYED failure, which is what makes it worth a test rather than a fix alone:
// onboarding, the agent and provisioning all succeed without the key, and only
// checkout/manage breaks, long after the step that caused it.
//
// These drive the real CLI. A unit test of the generator would not have caught it, because
// the generator was always correct — it faithfully wrote the empty value it was handed.

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

const ANSWERS = {
  providerSlug: "pubkey-test",
  providerName: "Pubkey Test Operator",
  ownerAddress: "t1exampleOwnerWalletAddress",
  // Unreachable on purpose: no network, instant connection-refused, and it still proves
  // the derive was ATTEMPTED — which is the whole regression.
  mtBaseUrl: "https://127.0.0.1:1",
  fluxAppName: "coalition-pubkey-test",
  hosts: [
    {
      name: "pve-01",
      storageImages: "ssd",
      storageIso: "iso-store",
      slots: [
        {
          tier: "cumulus",
          vmName: "pk-c1",
          ipAddress: "203.0.113.10",
          lanIp: "192.168.1.10/24",
          gateway: "192.168.1.1",
          apiPort: 16127,
        },
      ],
    },
  ],
};

function runInit(answers: Record<string, unknown>): { dir: string; stdout: string } {
  const dir = mkdtempSync(join(tmpdir(), "mt-init-pubkey-"));
  writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
  const stdout = execFileSync(
    process.execPath,
    ["--import", "tsx", CLI, "init", "--out", dir, "--answers", join(dir, "answers.json")],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  return { dir, stdout };
}

test("needsMtPubkey: absent, empty and whitespace all still need deriving", () => {
  const base = { ...ANSWERS } as never;
  assert.equal(needsMtPubkey({ ...(base as object) } as never), true, "absent");
  assert.equal(needsMtPubkey({ ...(base as object), mtPubkey: "" } as never), true, "empty");
  assert.equal(needsMtPubkey({ ...(base as object), mtPubkey: "   " } as never), true, "whitespace");
});

test("needsMtPubkey: an explicitly pinned key is left alone", () => {
  assert.equal(
    needsMtPubkey({ ...(ANSWERS as object), mtPubkey: "qxzpAgOVT5PvYmCrI7ljNysiWt7xWlDkDqOZMwr5jAs=" } as never),
    false
  );
});

test("⭐ init --answers ATTEMPTS the MT_PUBKEY derive (operator#54)", () => {
  const { stdout } = runInit(ANSWERS);
  // Before the fix the non-interactive path said nothing about MT_PUBKEY at all — it never
  // looked. Any of fetchMtPubkey's outcomes proves it now does.
  assert.match(
    stdout,
    /MT_PUBKEY/,
    "init --answers must try to derive MT_PUBKEY, not silently leave it blank"
  );
});

test("an unreachable MT still writes the KEY with an empty value, so the gap is visible", () => {
  const { dir } = runInit(ANSWERS);
  const config = readFileSync(join(dir, "config.env"), "utf8");
  assert.match(config, /^MT_PUBKEY=$/m, "the line must exist and be empty, not be absent");
});

test("an explicitly pinned mtPubkey survives init --answers unchanged", () => {
  const pinned = "qxzpAgOVT5PvYmCrI7ljNysiWt7xWlDkDqOZMwr5jAs=";
  const { dir, stdout } = runInit({ ...ANSWERS, mtPubkey: pinned });
  const config = readFileSync(join(dir, "config.env"), "utf8");
  assert.match(config, new RegExp(`^MT_PUBKEY=${pinned.replace(/[+/=]/g, "\\$&")}$`, "m"));
  assert.doesNotMatch(
    stdout,
    /could not reach/,
    "a pinned key must not be overwritten by whatever the live endpoint serves"
  );
});
