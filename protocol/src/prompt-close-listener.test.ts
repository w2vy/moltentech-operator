import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { PassThrough } from "node:stream";

// 2026-09-10, a live `fh-toolkit init`: eleven questions in, Node printed
// MaxListenersExceededWarning into the middle of the run. Each prompt raced
// `rl.question()` against `rl.once("close")`, and the losing `close` listener — every
// answered question — was never removed. The fix detaches it after the race settles.

const CLI = readFileSync(fileURLToPath(new URL("./cli.ts", import.meta.url)), "utf8");

test("the prompt race detaches its close listener once the question is answered", () => {
  const race = CLI.slice(CLI.indexOf('rl.question(def ? `${q} [${def}]: `'));
  const settle = race.slice(0, race.indexOf("if (answer === null)"));
  assert.match(settle, /\.finally\(\(\) => onClosed && rl\.off\("close", onClosed\)\)/);
});

test("twelve answered questions through the same pattern leave ONE close listener, not thirteen", async () => {
  const input = new PassThrough();
  const rl = createInterface({ input, output: new PassThrough() });
  const warned: string[] = [];
  const onWarning = (w: Error): void => void warned.push(w.name);
  process.on("warning", onWarning);
  try {
    for (let i = 0; i < 12; i++) {
      let onClosed: (() => void) | undefined;
      const p = Promise.race([
        rl.question("q? "),
        new Promise<null>((resolve) => rl.once("close", (onClosed = () => resolve(null)))),
      ]).finally(() => onClosed && rl.off("close", onClosed));
      input.write("a\n");
      await p;
    }
    assert.equal(rl.listenerCount("close"), 1); // readline's own
    assert.deepEqual(warned, []);
  } finally {
    process.off("warning", onWarning);
    rl.close();
  }
});
