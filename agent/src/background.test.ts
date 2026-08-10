import { test } from "node:test";
import assert from "node:assert/strict";
import { runDetached } from "./background";

/** Let all pending microtasks + one macrotask turn drain. */
const settle = () => new Promise((r) => setTimeout(r, 0));

test("runDetached returns before the task finishes — the whole point (#90)", async () => {
  let finished = false;
  let release: () => void = () => {};
  const blocked = new Promise<void>((r) => {
    release = r;
  });

  runDetached("slow task", async () => {
    await blocked;
    finished = true;
  });

  // This is the assertion #90 is about: a task that has not finished (and on a
  // degraded Proxmox would not finish for 20 minutes per host) must not have held
  // up the caller. Before the fix, the equivalent `await` sat here for the duration
  // and the agent claimed no jobs the entire time.
  assert.equal(finished, false, "runDetached must not wait for the task");

  release();
  await settle();
  assert.equal(finished, true, "the task must still actually run");
});

test("a rejected task is logged, not thrown — a background failure must not kill the agent", async () => {
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    runDetached("failing task", async () => {
      throw new Error("proxmox unreachable");
    });
    await settle();
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /failing task error:.*proxmox unreachable/);
});

test("REGRESSION: a SYNCHRONOUS throw is caught too", async () => {
  // fn() throwing before it ever returns a promise would escape a bare
  // `fn().catch(...)` and crash the process on an unhandled exception.
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => void errors.push(args.join(" "));
  try {
    runDetached("sync thrower", () => {
      throw new Error("bad config");
    });
    await settle();
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /sync thrower error:.*bad config/);
});
