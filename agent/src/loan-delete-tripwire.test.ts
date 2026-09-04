import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A tripwire around the agent's ability to destroy a VM, in the spirit of the #89 mutation check
 * and of `vm-annotation-not-a-gate.test.ts` next door.
 *
 * The loan expiry delete (`prudent-lending-lamport` §7 step 5) is agent-originated: no hub job,
 * no owner signature, no `ProvisionLog` row, no reviewer. The plan's own instruction is *"scope it
 * narrowly and unit-test it hard"*, and the narrowness is the part a unit test cannot express —
 * it is a property of the codebase, not of a function.
 *
 * So this asserts two things that no amount of testing `shouldReclaim` can:
 *
 * 1. **The decision modules stay pure.** `loan-state.ts` and `loan-reclaim.ts` decide what gets
 *    destroyed. The moment either of them can also *do* it, the reviewable boundary between
 *    "works out the answer" and "acts on it" is gone, and a future edit can reach a delete
 *    without passing the I/O layer where the logging lives.
 * 2. **The number of delete sites is fixed.** Not because three is a magic number, but because
 *    adding a fourth should be a deliberate act that updates this file and makes someone say why.
 *    A silently-added delete path is precisely the failure mode with no second party to catch it.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

/** Modules that DECIDE. None of them may destroy anything. */
const PURE_DECISION_MODULES = ["loan-state.ts", "loan-reclaim.ts"];

/** Anything that ends a VM's life, however it is spelled. */
const DESTRUCTIVE = ["deprovisionVm", "deprovision", "runArcaneMage", "qm destroy"];

function sources(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(SRC, f));
}

function codeLines(path: string): Array<{ n: number; text: string }> {
  return readFileSync(path, "utf8")
    .split("\n")
    .map((text, i) => ({ n: i + 1, text }))
    .filter(({ text }) => {
      const t = text.trimStart();
      // Comments name these functions constantly and must keep being allowed to.
      return !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    });
}

test("the loan DECISION modules cannot destroy anything", () => {
  const offenders: string[] = [];
  for (const file of PURE_DECISION_MODULES) {
    for (const { n, text } of codeLines(join(SRC, file))) {
      for (const bad of DESTRUCTIVE) {
        if (text.includes(bad)) offenders.push(`${file}:${n}: ${text.trim()}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "A loan decision module gained the ability to destroy a VM. Keep the decision pure and do " +
      "the deleting in index.ts, where it is logged unconditionally:\n" +
      offenders.join("\n")
  );
});

test("deprovisionVm has exactly the delete sites we know about", () => {
  // executor.ts    — the JOB path, gated by owner auth (definition + the `deprovision` job).
  // index.ts       — two autonomous sweeps: liskov's expired free trial, and lamport's expired
  //                  loan. Neither has an owner signature behind it, by design.
  const expected: Record<string, number> = { "executor.ts": 2, "index.ts": 2 };

  const found: Record<string, number> = {};
  for (const path of sources()) {
    const file = path.split("/").pop()!;
    const count = codeLines(path).filter(({ text }) => text.includes("deprovisionVm(")).length;
    if (count > 0) found[file] = count;
  }

  assert.deepEqual(
    found,
    expected,
    "The set of places this agent can destroy a VM changed.\n" +
      "That is allowed — but it is never incidental. Update this test, and say in the commit " +
      "message what authorizes the new delete: an owner signature, a hub job, or a marker " +
      "carried by the VM itself.\n" +
      `expected ${JSON.stringify(expected)}, found ${JSON.stringify(found)}`
  );
});

test("the loan reclaim logs unconditionally, like the trial sweep", () => {
  // No hub record exists for an agent-originated delete, so the log line IS the audit trail. A
  // reclaim that ran silently would be unauditable after the fact.
  const index = readFileSync(join(SRC, "index.ts"), "utf8");
  const fn = index.slice(index.indexOf("async function reclaimExpiredLoans"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));
  const logBeforeDelete =
    body.indexOf("RECLAIMING") !== -1 && body.indexOf("RECLAIMING") < body.indexOf("deprovisionVm(");
  assert.ok(logBeforeDelete, "reclaimExpiredLoans must log the decision BEFORE it deletes");
});

test("the loan scan reads its VM list from inventory, never from the hub", () => {
  // Found on staging 2026-09-04. `GET /api/agent/nodes` only returns slots in
  // AGENT_REPORTED_STATUSES, which excludes `available` — and an `available` slot is precisely
  // the one a lender lends. A scan fed from that list can never see a borrowed VM, so its expiry
  // would never fire. `inventory.json` is also the correct source on principle: §9d.3 exists to
  // keep MT off this path, and asking the hub which of your own slots you may look at is MT on
  // the path.
  const index = readFileSync(join(SRC, "index.ts"), "utf8");
  const fn = index.slice(index.indexOf("async function scanLoansOnce"));
  const body = fn.slice(0, fn.indexOf("\n  }\n"));
  assert.match(body, /reloadInventory\(cfg\)/, "scanLoansOnce must build its list from inventory");
  assert.doesNotMatch(body, /getNodes\(/, "scanLoansOnce must not take its list from the hub");
});
