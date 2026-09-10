import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A flag this CLI does not know is an ERROR, not something to skip past.
 *
 * Found on 2026-09-10: `keygen --dir x` was read as a bare argument and ignored, so a
 * PERMANENT identity key landed in the cwd and the command reported success. Every
 * command here has the same shape — `flag()` looks up the names it wants and never looks
 * at the rest — so the guard is applied everywhere rather than only where it hurt.
 */

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

function run(args: string[], cwd: string): { status: number; stderr: string } {
  try {
    execFileSync("npx", ["tsx", CLI, ...args], { encoding: "utf8", cwd, env: { ...process.env, FH_WRAPPER: "none" } });
    return { status: 0, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: string };
    return { status: err.status ?? 0, stderr: err.stderr ?? "" };
  }
}

const box = (): string => mkdtempSync(join(tmpdir(), "fh-flags-"));

test("⭐ every command refuses an option it does not know", () => {
  const dir = box();
  try {
    for (const cmd of ["coalition-keygen", "keygen", "init", "doctor", "level", "sign", "env", "verify", "wrapper"]) {
      const { status, stderr } = run([cmd, "--bogus", "x"], dir);
      assert.notEqual(status, 0, `${cmd} accepted --bogus`);
      assert.match(stderr, new RegExp(`${cmd}: unknown option --bogus`), stderr);
      // The message lists what it does take, so the fix does not need the docs.
      assert.match(stderr, /Accepts: --/, stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⭐ a boolean flag does not swallow the typo after it", () => {
  // The bug in the first cut of the guard: it skipped the token after EVERY known flag,
  // so `--yes` consumed `--bogus` as its value and the typo went through silently —
  // on the one command that changes a price and a Stripe key.
  const dir = box();
  try {
    for (const args of [
      ["level", "--yes", "--bogus"],
      ["level", "--dry-run", "--bogus"],
      ["sign", "--stdout", "--bogus"],
      ["keygen", "--force", "--bogus"],
    ]) {
      const { status, stderr } = run(args, dir);
      assert.notEqual(status, 0, args.join(" "));
      assert.match(stderr, /unknown option --bogus/, args.join(" "));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a value that starts with -- is a value, not a flag", () => {
  // The reason value-taking flags skip: `--set` takes what follows, whatever it looks
  // like. Rejecting it here would be a false positive on a legitimate command line.
  const dir = box();
  try {
    const { stderr } = run(["level", "--set", "--weird"], dir);
    assert.doesNotMatch(stderr, /unknown option/, stderr);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
