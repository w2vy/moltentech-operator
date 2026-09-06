import { test } from "node:test";
import assert from "node:assert/strict";
import { readBuildInfo, formatBuildInfo } from "./build-info";

test("an image build names the commit it was built from", () => {
  const text = formatBuildInfo(
    readBuildInfo({ FH_BUILD_SHA: "0df6f00abc", FH_BUILD_TIME: "2026-08-24T19:15:14Z" }, "0.1.0")
  );
  assert.match(text, /fh-toolkit 0\.1\.0/);
  assert.match(text, /0df6f00abc/);
  assert.match(text, /2026-08-24T19:15:14Z/);
  // The refresh window is why this command exists; say so where it is read.
  assert.match(text, /--refresh/);
});

test("⭐ a source checkout says so rather than inventing a SHA", () => {
  // An empty ARG is what a local `docker build` leaves behind. Printing a blank or a
  // placeholder there would make `version` unreliable exactly when it is being trusted.
  for (const env of [{}, { FH_BUILD_SHA: "", FH_BUILD_TIME: "  " }]) {
    const text = formatBuildInfo(readBuildInfo(env, "0.1.0"));
    assert.match(text, /source checkout/);
    assert.doesNotMatch(text, /--refresh/, "no refresh advice for a build that was not pulled");
  }
});

test("whitespace around a baked value does not reach the output", () => {
  const info = readBuildInfo({ FH_BUILD_SHA: " abc123 \n" }, "0.1.0");
  assert.equal(info.sha, "abc123");
  assert.equal(info.builtAt, undefined);
});
