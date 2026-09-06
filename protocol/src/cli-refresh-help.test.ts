import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// `--refresh` is the one flag an operator needs precisely when this CLI is out of date,
// and it is the one flag this CLI cannot carry out — the wrapper consumes it, because a
// container cannot replace its own image. That split is invisible from the prompt: help
// is the only place an operator can learn the flag exists, and a `--refresh` that
// reaches the CLI is itself the signal that their wrapper is stale.
//
// These drive the real CLI rather than asserting on a string constant: the failure being
// guarded is a *dispatch* mistake — `--refresh` falling through to the unknown-command
// default, which prints help and looks close enough to correct to survive review.

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

function run(args: string[]): { out: string; code: number } {
  try {
    return { out: execFileSync("npx", ["tsx", CLI, ...args], { encoding: "utf8" }), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { out: err.stdout ?? "", code: err.status ?? -1 };
  }
}

test("⭐ help names --refresh, the only way to update the tool", () => {
  const { out, code } = run(["help"]);
  assert.equal(code, 0);
  assert.match(out, /--refresh/);
  // Naming the flag without saying which half implements it is the confusion, not the fix.
  assert.match(out, /shell function/i);
});

test("⭐ --refresh reaching the CLI is diagnosed, not answered with `unknown command`", () => {
  const { out, code } = run(["--refresh"]);
  // Non-zero: nothing was pulled, so this is a failure to act on, not an FYI.
  assert.equal(code, 1);
  assert.match(out, /shell function/i);
  // The escape hatch has to be here — an operator whose wrapper is broken cannot use
  // the wrapper to fix the wrapper.
  assert.match(out, /docker pull ghcr\.io\/w2vy\/fh-toolkit:latest/);
  // It must NOT silently degrade into the usage list, which reads as "flag accepted".
  assert.doesNotMatch(out, /^usage: fh-toolkit/m);
});

// `--update-wrapper` has the same shape as `--refresh`, for the same reason twice over:
// the container can neither replace its own image nor write to the operator's home
// directory. Reaching the CLI is the diagnosis.

test("⭐ --update-wrapper reaching the CLI is diagnosed, with a hand escape hatch", () => {
  const { out, code } = run(["--update-wrapper"]);
  assert.equal(code, 1);
  assert.match(out, /shell function/i);
  assert.match(out, /cannot write to your home directory/i);
  // An operator whose wrapper is broken cannot use the wrapper to fix it, so the manual
  // form has to be printed here.
  assert.match(out, /docker run --rm ghcr\.io\/w2vy\/fh-toolkit:latest wrapper/);
});

test("help names --update-wrapper alongside --refresh", () => {
  const { out } = run(["help"]);
  assert.match(out, /--update-wrapper/);
  assert.match(out, /wrapper\s+\[--toolkit\|--agent\]/);
});

test("⭐ `wrapper` prints shell and nothing else — it is redirected into an rc file", () => {
  // A stray banner would land inside the operator's shell rc and be sourced.
  const { out, code } = run(["wrapper"]);
  assert.equal(code, 0);
  assert.match(out, /^# Shell functions/);
  assert.match(out, /^fh-toolkit\(\) \{$/m);
  assert.match(out, /^mt-agent\(\) \{$/m);
  assert.doesNotMatch(out, /^usage:/m);
});

test("`wrapper --toolkit` and `--agent` each print one function", () => {
  assert.doesNotMatch(run(["wrapper", "--toolkit"]).out, /^mt-agent\(\) \{$/m);
  assert.doesNotMatch(run(["wrapper", "--agent"]).out, /^fh-toolkit\(\) \{$/m);
});
