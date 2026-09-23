import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Every package's lockfile names the same version as its package.json.
 *
 * Nothing read the lockfile versions, so they drifted silently: on 2026-09-23 the agent lock
 * said 0.11.17 against 0.11.29, protocol's 0.1.0 against 0.4.0, the Coalition's 0.6.4 against
 * 0.7.0, and both locks recorded the linked protocol as 0.3.0. `fh-toolkit version` prints
 * protocol/package.json, so a stale number there misleads an operator reading it.
 */
const read = (rel: string) => JSON.parse(readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8"));

for (const pkg of ["agent", "protocol", "coalition"]) {
  test(`${pkg}: package-lock.json matches package.json`, () => {
    const version = read(`${pkg}/package.json`).version as string;
    const lock = read(`${pkg}/package-lock.json`);
    assert.equal(lock.version, version, "lock root version");
    assert.equal(lock.packages[""].version, version, "lock packages[\"\"] version");
    const linked = lock.packages["../protocol"];
    if (linked) assert.equal(linked.version, read("protocol/package.json").version, "linked protocol version");
  });
}
