import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tokenize, CliError, runCommand } from "./cli";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

function run(args: string[], opts: { stdin?: string } = {}): { out: string; code: number } {
  try {
    const out = execFileSync("npx", ["tsx", CLI, ...args], {
      encoding: "utf8",
      input: opts.stdin ?? "",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: (err.stdout ?? "") + (err.stderr ?? ""), code: err.status ?? -1 };
  }
}

test("tokenize splits on whitespace and honours quotes", () => {
  assert.deepEqual(tokenize("doctor --check-hub"), ["doctor", "--check-hub"]);
  assert.deepEqual(tokenize("  sign   --stdout  "), ["sign", "--stdout"]);
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   "), []);
  assert.deepEqual(tokenize('sign --out "my dir/manifest.json"'), [
    "sign",
    "--out",
    "my dir/manifest.json",
  ]);
  assert.deepEqual(tokenize("env --out 'a b'"), ["env", "--out", "a b"]);
});

test("tokenize keeps an empty quoted argument, which is not the same as no argument", () => {
  // `--signature ""` must reach the parser as a present-but-empty value rather than
  // silently vanishing and shifting every later argument left.
  assert.deepEqual(tokenize('verify --in ""'), ["verify", "--in", ""]);
});

test("⭐ a failing command THROWS rather than exiting, or one bad command kills the session", async () => {
  // This is the property the interactive loop rests on. If `die` ever goes back to
  // process.exit, the session dies on the first typo and this test is how you find out.
  await assert.rejects(
    () => runCommand("verify", [], { dir: ".", interactive: true }),
    (e: unknown) => e instanceof CliError && /--in <manifest.json> required/.test((e as Error).message)
  );
});

test("runCommand reports an exit code instead of exiting the process", async () => {
  assert.equal(await runCommand("version", [], { dir: ".", interactive: false }), 0);
  assert.equal(await runCommand("help", [], { dir: ".", interactive: false }), 0);
  // An unknown subcommand prints the usage block, but it is an error, not a request.
  assert.equal(await runCommand("bogus", [], { dir: ".", interactive: false }), 1);
});

test("⭐ no command and no TTY prints usage instead of opening a session that reads EOF", () => {
  // The failure this replaces: with `-i` but no `-t`, `init` printed its first prompt
  // and exited silently at EOF, so the tool looked half-broken rather than mis-invoked.
  const { out, code } = run([]);
  assert.equal(code, 1);
  assert.match(out, /not a terminal/);
  assert.match(out, /docker run -it/);
});

test("one-shot mode still exits non-zero on a bad command", () => {
  assert.equal(run(["verify"]).code, 1);
  assert.equal(run(["version"]).code, 0);
});

test("⭐ an unknown flag throws, so the session prompts again instead of exiting", async () => {
  // Verified against a real pty on 2026-09-10 — four bad flags in one session, four
  // errors, prompt back each time. This is that property as a unit test: the guard must
  // go through `die`/`CliError` like every other refusal, never `process.exit`.
  for (const args of [
    ["doctor", "--bogus"],
    ["level", "--yes", "--bogus"],
    ["wrapper", "--bogus"],
  ]) {
    await assert.rejects(
      () => runCommand(args[0]!, args.slice(1), { dir: process.cwd(), interactive: true }),
      (e: unknown) => e instanceof CliError && /unknown option --bogus/.test((e as Error).message),
      args.join(" ")
    );
  }
});
