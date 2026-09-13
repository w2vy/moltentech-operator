/**
 * The wrapper is shell, emitted from TypeScript, and then SOURCED into the operator's
 * login shell — three places for a quoting mistake to hide. So these tests do not only
 * compare strings: they run `bash -n` over the output and then source it against a fake
 * `docker` that records its argv, which is the only way to prove the arguments that
 * actually reach the daemon.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { tmpDir } from "./test-tmp";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  wrapperScript,
  toolkitFunction,
  agentFunction,
  wrapperStatus,
  WRAPPER_VERSION,
  TOOLKIT_IMAGE,
  REFRESH_MINUTES,
} from "./wrapper";
import { AGENT_IMAGE } from "./scaffold";

const script = (): string => wrapperScript();

// ---------------------------------------------------------------- shell harness

/**
 * A directory holding a `docker` that appends its argv to a log and exits 0, plus
 * anything else the test wants to stub. Putting it first on PATH is what turns "the
 * emitted text looks right" into "the emitted text CALLS the right thing".
 */
function shellBox(): { dir: string; run: (cmds: string, extra?: Record<string, string>) => string; argv: () => string[][] } {
  const dir = tmpDir("fh-wrapper-");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const log = join(dir, "docker.log");
  const stub = (name: string, body: string): void => {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/bash\n${body}\n`);
    chmodSync(p, 0o755);
  };
  stub("docker", `printf '%s\\n' "$*" >> ${JSON.stringify(log)}\nexit \${DOCKER_EXIT:-0}`);
  const rc = join(dir, "wrapper.sh");
  writeFileSync(rc, script());
  return {
    dir,
    run: (cmds, extra = {}): string =>
      execFileSync("bash", ["-c", `. ${JSON.stringify(rc)}\n${cmds}`], {
        encoding: "utf8",
        cwd: dir,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, HOME: dir, ...extra },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    argv: (): string[][] =>
      existsSync(log)
        ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => l.split(" "))
        : [],
  };
}

// ---------------------------------------------------------------- shape

test("the emitted file is valid bash", () => {
  const dir = tmpDir("fh-syntax-");
  const p = join(dir, "w.sh");
  writeFileSync(p, script());
  // Throws with the parse error attached if it is not.
  execFileSync("bash", ["-n", p]);
});

test("⭐ no backtick survives inside a double-quoted string", () => {
  // Backticks are command substitution in bash. `echo "run \`fh-toolkit init\`"` does not
  // print advice, it RUNS it. Caught exactly this in review, in the one line of prose that
  // named another command.
  for (const line of script().split("\n")) {
    const code = line.replace(/^\s*#.*/, "");
    if (!code.includes('"')) continue;
    const quoted = code.match(/"[^"]*"/g) ?? [];
    for (const q of quoted) {
      assert.ok(!q.includes("`"), `backtick inside a double-quoted string: ${line.trim()}`);
    }
  }
});

test("both functions are emitted, and either alone on request", () => {
  assert.match(script(), /^fh-toolkit\(\) \{$/m);
  assert.match(script(), /^fh-agent\(\) \{$/m);
  assert.doesNotMatch(wrapperScript({ only: "toolkit" }), /^fh-agent\(\) \{$/m);
  assert.doesNotMatch(wrapperScript({ only: "agent" }), /^fh-toolkit\(\) \{$/m);
  // Each half must still stand alone as bash — `--toolkit` output is what a docs snippet
  // shows, and half a case statement would not parse.
  for (const s of [toolkitFunction(), agentFunction()]) {
    const p = join(tmpDir("fh-half-"), "w.sh");
    writeFileSync(p, s);
    execFileSync("bash", ["-n", p]);
  }
});

test("the header says where it came from and how to regenerate it", () => {
  const s = wrapperScript({ build: { version: "9.9.9", sha: "abcdef0123456789" } });
  assert.match(s, /GENERATED, do not edit/);
  assert.match(s, /fh-toolkit 9\.9\.9 \(abcdef012345\)/);
  assert.match(s, new RegExp(`wrapper format v${WRAPPER_VERSION}`));
  assert.match(s, /fh-toolkit --update-wrapper/);
  // A source checkout must say so rather than invent a build.
  assert.match(wrapperScript(), /source checkout/);
});

// ---------------------------------------------------------------- fh-toolkit()

test("⭐ the toolkit passes -i, the guarded -t, the mount and the handshake", () => {
  const box = shellBox();
  box.run("fh-toolkit doctor");
  const call = box.argv().find((a) => a.includes("run"));
  assert.ok(call, "no `docker run` reached the daemon");
  const line = call.join(" ");
  assert.match(line, /--rm -i /);
  assert.match(line, new RegExp(`-e FH_WRAPPER=${WRAPPER_VERSION}`));
  assert.match(line, /-v .*:\/work/);
  assert.match(line, /-v \/etc\/hosts:\/etc\/hosts:ro/);
  assert.ok(line.endsWith(`${TOOLKIT_IMAGE} doctor`), line);
});

test("⭐ $tty is unquoted: no empty argument reaches docker when there is no terminal", () => {
  // Tests run without a TTY, which is the case that matters — quoted, `$tty` would pass an
  // empty string and docker would read it as the image name.
  const box = shellBox();
  box.run("fh-toolkit doctor");
  const call = box.argv().find((a) => a.includes("run"))!;
  assert.ok(!call.includes(""), "an empty argument was passed");
  assert.ok(!call.includes("-t"), "-t was passed without a terminal");
});

test("the stamp file defers the pull, and --refresh forces it", () => {
  const box = shellBox();
  box.run("fh-toolkit doctor");
  const first = box.argv().filter((a) => a[0] === "pull").length;
  assert.equal(first, 1, "the first call should pull (no stamp yet)");
  box.run("fh-toolkit doctor");
  assert.equal(box.argv().filter((a) => a[0] === "pull").length, 1, "the second should not");
  box.run("fh-toolkit --refresh doctor");
  assert.equal(box.argv().filter((a) => a[0] === "pull").length, 2, "--refresh always pulls");
});

test("`--refresh` alone pulls and stops, without running a command", () => {
  const box = shellBox();
  box.run("fh-toolkit --refresh");
  assert.deepEqual(
    box.argv().map((a) => a[0]),
    ["pull"]
  );
});

test(`the stamp interval is ${REFRESH_MINUTES} minutes, in the code and in the text`, () => {
  assert.match(script(), new RegExp(`-mmin \\+${REFRESH_MINUTES}\\b`));
  assert.match(script(), new RegExp(`every ${REFRESH_MINUTES} minutes`));
});

// ---------------------------------------------------------------- --update-wrapper

test("⭐ a failed generation leaves the existing wrapper untouched", () => {
  // The trap this guards: `fh-toolkit wrapper > ~/.fh-toolkit.sh` truncates BEFORE docker
  // runs, so one failed pull would leave an empty wrapper and no way to regenerate it —
  // the only unrecoverable state this command could have had.
  const box = shellBox();
  const rc = join(box.dir, "rc.sh");
  writeFileSync(rc, "# the operator's existing wrapper\n");
  let threw = false;
  try {
    box.run(`fh-toolkit --update-wrapper`, { FH_TOOLKIT_RC: rc, DOCKER_EXIT: "1" });
  } catch {
    threw = true;
  }
  assert.ok(threw, "a failed update must be a non-zero exit");
  assert.equal(readFileSync(rc, "utf8"), "# the operator's existing wrapper\n");
});

test("an empty generation is refused too", () => {
  // The stub docker exits 0 and prints nothing, so `wrapper` yields an empty file. Exit
  // status alone would not catch it; `-s` does.
  const box = shellBox();
  const rc = join(box.dir, "rc.sh");
  writeFileSync(rc, "# existing\n");
  let threw = false;
  try {
    box.run(`fh-toolkit --update-wrapper`, { FH_TOOLKIT_RC: rc });
  } catch {
    threw = true;
  }
  assert.ok(threw);
  assert.equal(readFileSync(rc, "utf8"), "# existing\n");
});

test("a successful update replaces the file and re-sources it", () => {
  const box = shellBox();
  const rc = join(box.dir, "rc.sh");
  writeFileSync(rc, "# old\n");
  // A docker that emits a real wrapper on `run … wrapper`, so the re-source is exercised
  // for real — redefining a function while it is executing is legal in bash, and this is
  // the assertion that says so rather than assuming it.
  const gen = join(box.dir, "generated.sh");
  writeFileSync(gen, script());
  writeFileSync(
    join(box.dir, "bin", "docker"),
    `#!/bin/bash\nif [ "$1" = "run" ]; then cat ${JSON.stringify(gen)}; fi\nexit 0\n`
  );
  chmodSync(join(box.dir, "bin", "docker"), 0o755);
  const out = box.run(`fh-toolkit --update-wrapper`, { FH_TOOLKIT_RC: rc });
  assert.match(out, /wrapper updated/);
  assert.equal(readFileSync(rc, "utf8"), script());
});

// ---------------------------------------------------------------- fh-agent()

test("⭐ bare `fh-agent` refuses and points at compose", () => {
  // The deliberate divergence from the image's own CLI, where bare means "run the main
  // loop". Through a wrapper that would start a SECOND agent for this provider.
  const box = shellBox();
  let threw = false;
  try {
    box.run("fh-agent");
  } catch (e) {
    threw = true;
    assert.match(String((e as { stderr?: string }).stderr), /usage: fh-agent/);
  }
  assert.ok(threw, "bare fh-agent must exit non-zero");
  assert.deepEqual(box.argv(), [], "and must not run anything");
});

test("bare `fh-agent` answers before the directory guard", () => {
  // Someone in the wrong directory needs to hear what the command is for, not where they
  // are standing.
  const box = shellBox();
  try {
    box.run("fh-agent");
  } catch (e) {
    assert.doesNotMatch(String((e as { stderr?: string }).stderr), /\.env\.operator/);
  }
});

test("`fh-agent doctor` outside an operator directory says so, and runs nothing", () => {
  const box = shellBox();
  let threw = false;
  try {
    box.run("fh-agent doctor");
  } catch (e) {
    threw = true;
    assert.match(String((e as { stderr?: string }).stderr), /no \.env\.operator here/);
  }
  assert.ok(threw);
  assert.deepEqual(box.argv(), []);
});

test("⭐ `fh-agent doctor` mounts data read-only and passes the env file", () => {
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "MT_BASE_URL=https://example\n");
  box.run("fh-agent doctor");
  const call = box.argv().find((a) => a.includes("run"))!;
  const line = call.join(" ");
  assert.match(line, /--env-file \.env\.operator/);
  assert.match(line, /-v .*\/data:\/data:ro/);
  // `npm run doctor`, not a bare `doctor`: the image has no ENTRYPOINT of its own, so a
  // bare subcommand reaches node and dies MODULE_NOT_FOUND /app/agent/doctor.
  assert.ok(line.endsWith(`${AGENT_IMAGE} npm run doctor`), line);
});

test("⭐ the image comes from compose.yaml, not from a hardcoded :latest", () => {
  // The defect: every `fh-agent` subcommand ran `ghcr.io/w2vy/fh-agent:latest` regardless of what
  // compose was running. On a staging onboarding that means `doctor` validates the
  // PRODUCTION build while the loop beside it runs `:staging` — a green check for an image
  // nobody is running.
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  writeFileSync(
    join(box.dir, "compose.yaml"),
    "name: fh-agent-demo\nservices:\n  agent:\n    image: ghcr.io/w2vy/fh-agent:staging\n"
  );
  box.run("fh-agent doctor");
  const line = box.argv().find((a) => a.includes("run"))!.join(" ");
  assert.match(line, /w2vy\/fh-agent:staging npm run doctor$/);
  assert.doesNotMatch(line, /fh-agent:latest/);
});

test("with no compose.yaml the wrapper falls back to the published image", () => {
  // `fh-agent` is usable in a directory that has .env.operator and nothing else — an
  // operator checking creds before generating the rest.
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  box.run("fh-agent doctor");
  const line = box.argv().find((a) => a.includes("run"))!.join(" ");
  assert.ok(line.endsWith(`${AGENT_IMAGE} npm run doctor`), line);
});

test("`fh-agent dry-run` sets the env var, and passes no argument", () => {
  // The image takes it as AGENT_DRY_RUN, not as an argument — the whole reason it is worth
  // wrapping. Passing `dry-run` through would make the agent reject an unknown command.
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  box.run("fh-agent dry-run");
  const line = box.argv().find((a) => a.includes("run"))!.join(" ");
  assert.match(line, /-e AGENT_DRY_RUN=1/);
  assert.ok(line.endsWith(AGENT_IMAGE), line);
});

test("⭐ the agent is never pulled", () => {
  // Pulling it would mean `fh-agent doctor` validates a build the running loop is NOT on:
  // passed here, fails in prod. Drift is reported, never applied.
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  box.run("fh-agent doctor");
  const pulls = box.argv().filter((a) => a[0] === "pull");
  assert.deepEqual(pulls, [], "fh-agent must not pull");
});

test("the drift check is silent when nothing is running", () => {
  // `docker ps` returns nothing from the stub, so there is no container to compare against
  // and the honest answer is to say nothing at all.
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  const out = box.run("fh-agent doctor 2>&1");
  assert.doesNotMatch(out, /note:/);
});

test("⭐ the drift check reports a running container older than the pulled image", () => {
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  writeFileSync(
    join(box.dir, "bin", "docker"),
    `#!/bin/bash
case "$1 $2" in
  "ps --format") echo "c0ffee ${AGENT_IMAGE}" ;;
  "inspect --format") echo "sha256:1111111111111111" ;;
  "image inspect") echo "sha256:2222222222222222" ;;
  *) : ;;
esac
exit 0
`
  );
  chmodSync(join(box.dir, "bin", "docker"), 0o755);
  const out = box.run("fh-agent doctor 2>&1");
  assert.match(out, /ON THIS HOST than the one your agent is running/);
  assert.match(out, /fh-agent update/);
  assert.match(out, /1111111111111111/);
});

// ---------------------------------------------------------------- version / update (wrapper v4)

test("⭐ fh-agent update is the ONE verb that pulls, and it recreates the loop", () => {
  // The drift check reports and never acts (above). Acting is this verb, asked for by name:
  // pull, then up -d --force-recreate, with the running version printed on either side.
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  writeFileSync(join(box.dir, "compose.yaml"), `services:\n  agent:\n    image: ${AGENT_IMAGE}\n`);
  const out = box.run("fh-agent update 2>&1");
  const argv = box.argv();
  assert.deepEqual(argv.filter((a) => a[0] === "compose").map((a) => a.slice(1).join(" ")), [
    "pull",
    "up -d --force-recreate",
  ]);
  assert.match(out, /before: not running/); // the stub's `docker ps` prints nothing
  assert.match(out, /after: +not running/);
});

test("fh-toolkit --update-agent is retired: the wrapper no longer consumes it", () => {
  // It was an alias for `fh-agent update`. A v5 wrapper hands it to the CLI like any
  // other argument, where a signpost answers; the wrapper itself must not touch compose.
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  writeFileSync(join(box.dir, "compose.yaml"), `services:\n  agent:\n    image: ${AGENT_IMAGE}\n`);
  box.run("fh-toolkit --update-agent 2>&1");
  const argv = box.argv();
  assert.deepEqual(argv.filter((a) => a[0] === "compose"), []);
  const run = argv.find((a) => a[0] === "run")!;
  assert.equal(run[run.length - 1], "--update-agent", "passed through to the CLI");
});

// ---------------------------------------------------------------- lifecycle verbs (wrapper v5)

function composeCalls(box: ReturnType<typeof shellBox>): string[] {
  return box
    .argv()
    .filter((a) => a[0] === "compose")
    .map((a) => a.slice(1).join(" "));
}

function operatorDir(box: ReturnType<typeof shellBox>): void {
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  writeFileSync(join(box.dir, "compose.yaml"), `services:\n  agent:\n    image: ${AGENT_IMAGE}\n`);
}

test("⭐ fh-agent start/stop/status/logs are the compose lifecycle, by name", () => {
  const box = shellBox();
  operatorDir(box);
  box.run("fh-agent start");
  assert.deepEqual(composeCalls(box), ["up -d"]);

  const b2 = shellBox();
  operatorDir(b2);
  b2.run("fh-agent stop");
  assert.deepEqual(composeCalls(b2), ["down"]);

  const b3 = shellBox();
  operatorDir(b3);
  b3.run("fh-agent status");
  assert.deepEqual(composeCalls(b3), ["ps"]);

  const b4 = shellBox();
  operatorDir(b4);
  b4.run("fh-agent logs");
  assert.deepEqual(composeCalls(b4), ["logs -f"]);

  const b5 = shellBox();
  operatorDir(b5);
  b5.run("fh-agent logs --tail 50");
  assert.deepEqual(composeCalls(b5), ["logs --tail 50"], "arguments pass through, and bare -f is dropped");
});

test("⭐ fh-agent restart is `up -d --force-recreate`, never `compose restart`", () => {
  // The verb people reach for after editing .env.operator. `docker compose restart`
  // re-reads nothing; giving the obvious word the right meaning is the whole point.
  const box = shellBox();
  operatorDir(box);
  box.run("fh-agent restart");
  assert.deepEqual(composeCalls(box), ["up -d --force-recreate"]);
  const code = script()
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(code, /compose restart/);
});

test("the lifecycle verbs refuse a directory compose does not run", () => {
  for (const verb of ["start", "stop", "restart", "status", "logs"]) {
    const box = shellBox();
    writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
    assert.throws(() => box.run(`fh-agent ${verb}`), /no compose.yaml here/, verb);
    assert.deepEqual(composeCalls(box), [], verb);
  }
});

test("bare `fh-agent` lists its own verbs, not compose", () => {
  const box = shellBox();
  let err = "";
  try {
    box.run("fh-agent");
  } catch (e) {
    err = String((e as { stderr?: string }).stderr);
  }
  for (const verb of ["start", "stop", "restart", "status", "logs", "update", "doctor"]) {
    assert.match(err, new RegExp(`^  ${verb} `, "m"), verb);
  }
  assert.doesNotMatch(err, /^  docker compose/m);
});

test("fh-agent update refuses a directory compose does not run", () => {
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  assert.throws(() => box.run("fh-agent update"), /no compose.yaml here/);
  assert.deepEqual(box.argv().filter((a) => a[0] === "compose"), []);
});

test("fh-agent version reports running vs pulled and never pulls", () => {
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  writeFileSync(
    join(box.dir, "bin", "docker"),
    `#!/bin/bash
case "$1 $2" in
  "ps --format") echo "c0ffee ${AGENT_IMAGE}" ;;
  "exec c0ffee") echo "0.11.11" ;;
  "run --rm") echo "0.11.12" ;;
  "inspect --format") echo "sha256:1111111111111111" ;;
  "image inspect") echo "sha256:1111111111111111" ;;
  *) : ;;
esac
exit 0
`
  );
  chmodSync(join(box.dir, "bin", "docker"), 0o755);
  const out = box.run("fh-agent version 2>&1");
  assert.match(out, /running: 0\.11\.11/);
  assert.match(out, /pulled: +0\.11\.12/);
  assert.doesNotMatch(out, /pull &&/);
});

test("the drift check does NOT use `--filter ancestor`", () => {
  // That filter resolves the tag to its CURRENT id, so a container left behind by a pull —
  // precisely the case worth reporting — would not match it.
  const code = script()
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(code, /filter[= ]"?ancestor/);
});

// ---------------------------------------------------------------- the handshake

test("a current wrapper is reported quietly", () => {
  const s = wrapperStatus({ FH_WRAPPER: String(WRAPPER_VERSION) });
  assert.equal(s.state, "current");
});

test("⭐ no FH_WRAPPER means a wrapper predating the handshake", () => {
  // This is tom's 2026-09-06 case exactly: the rename shipped, his shell still defined
  // mt-manifest() against an image name that no longer publishes, and nothing said so.
  const s = wrapperStatus({});
  assert.equal(s.state, "unknown");
  assert.match(s.state === "unknown" ? s.fix : "", /--update-wrapper/);
});

test("an older wrapper is stale, and says both versions", () => {
  const s = wrapperStatus({ FH_WRAPPER: "0" });
  assert.equal(s.state, "stale");
  assert.match(s.state === "stale" ? s.message : "", /v0/);
  assert.match(s.state === "stale" ? s.message : "", new RegExp(`v${WRAPPER_VERSION}`));
});

test("garbage in FH_WRAPPER is treated as unknown, not as a version", () => {
  for (const v of ["", "  ", "abc", "1.2"]) {
    assert.equal(wrapperStatus({ FH_WRAPPER: v }).state, "unknown", v);
  }
});

test("FH_WRAPPER=none silences the check for a deliberate non-wrapper invocation", () => {
  // CI runs the image directly; so does any script. Telling them to install a wrapper they
  // have chosen not to use is noise that never goes away.
  assert.equal(wrapperStatus({ FH_WRAPPER: "none" }).state, "current");
});

test("a NEWER wrapper than the image is not a complaint", () => {
  // The operator updated the wrapper and has not yet pulled. `--refresh` is that problem,
  // and the wrapper is not the thing to fix.
  assert.equal(wrapperStatus({ FH_WRAPPER: String(WRAPPER_VERSION + 1) }).state, "current");
});

// ---------------------------------------------------------------- docs agreement

test("⭐ the docs show the same bytes the image emits", () => {
  // You should be able to read what you are about to source. Same rule the agent compose
  // file already lives under: an operator following the doc and an operator running
  // `--update-wrapper` must end up with the same shell.
  for (const name of ["fh-toolkit.md", "operator-onboarding.md"]) {
    const doc = fileURLToPath(new URL(`../../docs/${name}`, import.meta.url));
    if (!existsSync(doc)) continue;
    const text = readFileSync(doc, "utf8");
    if (!text.includes("fh-toolkit() {")) continue;
    const block = text.match(/```sh\nfh-toolkit\(\) \{[\s\S]*?\n```/);
    assert.ok(block, `${name} shows a wrapper but not in a fenced sh block`);
    const shown = block[0].replace(/^```sh\n/, "").replace(/\n```$/, "");
    assert.equal(shown, toolkitFunction(), `${name} has drifted from wrapper.ts`);
  }
});

// ---------------------------------------------------------------- reported where it is read

test("⭐ doctor reports a wrapper predating the handshake, and stays quiet about a current one", () => {
  // Driven through the real CLI: the failure being guarded is that the finding is built in
  // `doctor`'s case and could easily be pushed after the report is formatted.
  const dir = tmpDir("fh-doctor-");
  writeFileSync(
    join(dir, "config.env"),
    "PROVIDER_SLUG=demo-co\nPROVIDER_LEVEL=supporter\nMT_BASE_URL=https://fluxhub.moltentech.us\n"
  );
  const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const doctor = (env: Record<string, string | undefined>): string => {
    try {
      return execFileSync("npx", ["tsx", cli, "doctor", "--dir", dir], {
        encoding: "utf8",
        env: { ...process.env, FH_WRAPPER: undefined, ...env },
      });
    } catch (e) {
      const err = e as { stdout?: string };
      return err.stdout ?? "";
    }
  };
  const stale = doctor({});
  assert.match(stale, /WRAPPER_UNKNOWN/);
  assert.match(stale, /--update-wrapper/);
  assert.doesNotMatch(doctor({ FH_WRAPPER: String(WRAPPER_VERSION) }), /WRAPPER_/);
});

test("⭐ the old `mt-agent` name is a signpost, not a silent failure", () => {
  // The `mt-manifest` -> `fh-toolkit` rename taught this: the only operator kept running
  // the old function against an image name that no longer publishes, and nothing said so.
  const box = shellBox();
  writeFileSync(join(box.dir, ".env.operator"), "x=1\n");
  let threw = false;
  try {
    box.run("mt-agent doctor");
  } catch (e) {
    threw = true;
    const err = String((e as { stderr?: string }).stderr);
    assert.match(err, /now fh-agent/);
    assert.match(err, /fh-agent doctor/);
  }
  assert.ok(threw, "the old name must exit non-zero");
  assert.deepEqual(box.argv(), [], "and must run no container");
});
