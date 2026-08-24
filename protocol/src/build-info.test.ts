import { test } from "node:test";
import assert from "node:assert/strict";
import { readBuildInfo, formatBuildInfo } from "./build-info";

test("an image build names the commit it was built from", () => {
  const text = formatBuildInfo(
    readBuildInfo({ MT_BUILD_SHA: "0df6f00abc", MT_BUILD_TIME: "2026-08-24T19:15:14Z" }, "0.1.0")
  );
  assert.match(text, /mt-manifest 0\.1\.0/);
  assert.match(text, /0df6f00abc/);
  assert.match(text, /2026-08-24T19:15:14Z/);
  // The 48h refresh is why this command exists; say so where it is read.
  assert.match(text, /48h/);
});

test("⭐ a source checkout says so rather than inventing a SHA", () => {
  // An empty ARG is what a local `docker build` leaves behind. Printing a blank or a
  // placeholder there would make `version` unreliable exactly when it is being trusted.
  for (const env of [{}, { MT_BUILD_SHA: "", MT_BUILD_TIME: "  " }]) {
    const text = formatBuildInfo(readBuildInfo(env, "0.1.0"));
    assert.match(text, /source checkout/);
    assert.doesNotMatch(text, /48h/, "no refresh advice for a build that was not pulled");
  }
});

test("whitespace around a baked value does not reach the output", () => {
  const info = readBuildInfo({ MT_BUILD_SHA: " abc123 \n" }, "0.1.0");
  assert.equal(info.sha, "abc123");
  assert.equal(info.builtAt, undefined);
});
