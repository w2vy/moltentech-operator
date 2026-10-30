import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isConsoleHash,
  normalizeSshPubkey,
  quoteEnvValue,
  sha512Crypt,
  sshPubkeyProblem,
  unquoteEnvValue,
} from "./console-auth";

// A private key's look, built in pieces so secret scanners do not take the fixture for a real
// key. The body is only the `openssh-key-v1` header every unencrypted ed25519 key starts with.
const BEGIN = "-----BEGIN OPENSSH " + "PRIVATE KEY-----";
const END = "-----END OPENSSH " + "PRIVATE KEY-----";
const BODY = "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW";

// A throwaway key, generated for this test (`ssh-keygen -t ed25519`); its private half was deleted.
const ED25519 = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOW6ApNy6ULVdtlLiPv2S3XsfISt9D/IEan42sDFofV9 op@host";

test("sha512Crypt: Drepper's spec vector and `openssl passwd -6`", () => {
  assert.equal(
    sha512Crypt("Hello world!", "saltstring"),
    "$6$saltstring$svn8UoSVapNtMuq1ukKS4tPQd8iKwSMHWjl/O817G3uBnIFNjnQJuesI68u4OTLiBFdcbYEdFCoEOfaS35inz1"
  );
  // Over 64 bytes takes the block loop; a 16-char salt is the maximum.
  assert.equal(
    sha512Crypt("a much longer password that is over sixty-four bytes long, really it is quite long", "abcdefghijklmnop"),
    "$6$abcdefghijklmnop$d.erDK4JZbirHjmBZ7uDz8V5qjlGrD6s9sb1biURqOnGAkjEjpaDmuwmflr/TcXYTb14bj3ceY5PDi/ixlQmG/"
  );
});

test("sha512Crypt: a fresh salt each time, and the result is a console hash", () => {
  const a = sha512Crypt("pw");
  const b = sha512Crypt("pw");
  assert.notEqual(a, b);
  assert.match(a, /^\$6\$[./0-9A-Za-z]{16}\$[./0-9A-Za-z]{86}$/);
  assert.ok(isConsoleHash(a));
});

test("isConsoleHash: crypt hashes and `!`, never a pasted password", () => {
  assert.ok(isConsoleHash("!"));
  assert.ok(isConsoleHash("$y$j9T$abc./$def"));
  assert.ok(isConsoleHash("$6$rounds=10000$salt$hash"));
  assert.equal(isConsoleHash("hunter2"), false);
  assert.equal(isConsoleHash(""), false);
});

test("sshPubkeyProblem: a .pub line passes; private, damaged or mismatched keys do not", () => {
  assert.equal(sshPubkeyProblem(ED25519), null);
  assert.equal(sshPubkeyProblem(ED25519.split(" ").slice(0, 2).join(" ")), null);
  assert.match(sshPubkeyProblem(BEGIN)!, /PRIVATE/);
  assert.match(sshPubkeyProblem("ssh-dss AAAA")!, /unknown key type "ssh-dss"/);
  // A private key's body pasted without its BEGIN line: refused without being repeated.
  assert.doesNotMatch(sshPubkeyProblem(`${BODY} QyNTUxOQAAACA`)!, new RegExp(BODY));
  assert.match(sshPubkeyProblem(ED25519.replace("ssh-ed25519", "ssh-rsa"))!, /does not match/);
  assert.match(sshPubkeyProblem("ssh-ed25519 not*base64")!, /damaged/);
  assert.match(sshPubkeyProblem("ssh-ed25519")!, /one line/);
});

test("normalizeSshPubkey collapses whitespace and a trailing newline", () => {
  assert.equal(normalizeSshPubkey(`  ${ED25519.replace(/ /g, "   ")}\n`), ED25519);
});

test("env values are single-quoted, so Compose does not expand the `$` in a hash", () => {
  assert.equal(quoteEnvValue("$6$s$h"), "'$6$s$h'");
  assert.throws(() => quoteEnvValue("it's"));
  assert.equal(unquoteEnvValue("'$6$s$h'"), "$6$s$h");
  assert.equal(unquoteEnvValue("!"), "!");
  assert.equal(unquoteEnvValue(undefined), undefined);
});

test("⭐ console-auth never repeats a pasted private key (found 10-30: the error echoed it)", () => {
  const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "fh-console-auth-"));
  const priv = `${BEGIN}\n${BODY}\n${END}`;
  try {
    writeFileSync(join(dir, "config.env"), "PROVIDER_SLUG=test\n");
    writeFileSync(join(dir, ".env.operator"), "FLUX_HUB_URL=https://example.invalid\n");
    for (const key of [priv, `${BODY} QyNTUxOQAAACA`]) {
      const r = spawnSync("npx", ["tsx", CLI, "console-auth", "--dir", dir, "--ssh-key", key], {
        encoding: "utf8",
        env: { ...process.env, FH_WRAPPER: "none" },
      });
      assert.notEqual(r.status, 0);
      assert.doesNotMatch(r.stdout + r.stderr, new RegExp(BODY.slice(0, 30)), r.stderr);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
