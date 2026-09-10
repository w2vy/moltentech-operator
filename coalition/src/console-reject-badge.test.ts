import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * ⭐ A reject must not present as a bare "delete".
 *
 * The console badges off `action`, and `delete` has three meanings: the end of a cancelled
 * rental, a move's source teardown, and — since prudent-bouncing-knuth — a reject, where the
 * VM is destroyed and the RENTAL SURVIVES because the customer is about to re-enter their
 * configuration onto the same slot.
 *
 * This is the screen where the operator decides whether to sign. Two of the three meanings end
 * a customer's node; the third does not. Showing the same red "delete" for all three tells the
 * operator the opposite of what is about to happen in exactly one case.
 */
const src = readFileSync(fileURLToPath(new URL("./console.ts", import.meta.url)), "utf8");

test("the pending row badges a reject distinctly, and says what survives", () => {
  const fn = src.slice(src.indexOf("function actionBadge"), src.indexOf("/** Slot status"));
  assert.match(fn, /kind === "reject_delete"/);
  assert.match(fn, /reject config/);
  // The tooltip carries the fact the badge cannot: the rental is NOT ending.
  assert.match(fn, /rental stays with your customer/);
});

test("it falls back to the action when the hub sends no kind", () => {
  // `kind` is optional on the wire so an older hub still validates. A missing one must badge
  // exactly as before rather than rendering an empty pill.
  const fn = src.slice(src.indexOf("function actionBadge"), src.indexOf("/** Slot status"));
  assert.match(fn, /kind\?: string/);
  assert.match(fn, /action === "delete" \? "badge-delete"/);
});

test("⭐ the confirmation page reads the kind BEFORE the pending entry is deleted", () => {
  // `verifyAndQueue` removes the item as it queues the signature, so a lookup afterwards finds
  // nothing and the operator's confirmation would say "delete" for a reject.
  const fn = src.slice(src.indexOf("function verifyAndQueue"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(
    body.indexOf("const kind = pending.get(slotId)?.kind") < body.indexOf("pending.delete(slotId)"),
    "read the kind before deleting the entry"
  );
  assert.match(src, /actionBadge\(r\.claim\.action, r\.kind\)/);
});
