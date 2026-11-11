/**
 * ensurePrice reads the lookup key with `prices.list`, not the eventually-consistent search
 * (two checkouts seconds apart on a new price collided on 2026-11-11), and a lost create race
 * re-reads the winner's price.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ensurePrice, type StripeLike } from "./stripe.js";

function fake(opts: { existing?: string; createFails?: "collision" | "other" }) {
  const calls: Array<[string, any]> = [];
  let stored = opts.existing ?? null;
  const stripe = {
    prices: {
      list: async (a: any) => (calls.push(["list", a]), { data: stored ? [{ id: stored }] : [] }),
      create: async (a: any) => {
        calls.push(["create", a]);
        if (opts.createFails === "collision") {
          stored = "price_winner"; // the other checkout's create landed first
          throw new Error("Price price_winner already uses this `lookup_key`.");
        }
        if (opts.createFails === "other") throw new Error("stripe down");
        stored = "price_new";
        return { id: "price_new" };
      },
    },
    products: { create: async () => ({ id: "prod_1" }) },
  } as unknown as StripeLike;
  return { stripe, calls };
}

test("an existing price is found by its lookup key — no create", async () => {
  const { stripe, calls } = fake({ existing: "price_1" });
  assert.equal(await ensurePrice(stripe, "op", "cumulus", 700), "price_1");
  assert.deepEqual(calls, [["list", { lookup_keys: ["mt-op-cumulus-700"], active: true, limit: 1 }]]);
});

test("a missing price is created with the deterministic lookup key", async () => {
  const { stripe, calls } = fake({});
  assert.equal(await ensurePrice(stripe, "op", "cumulus", 700), "price_new");
  assert.equal(calls[1]![1].lookup_key, "mt-op-cumulus-700");
  assert.equal(calls[1]![1].unit_amount, 700);
});

test("a lost create race returns the winner's price instead of failing the checkout", async () => {
  const { stripe } = fake({ createFails: "collision" });
  assert.equal(await ensurePrice(stripe, "op", "cumulus", 700), "price_winner");
});

test("a create that fails for any other reason still fails", async () => {
  const { stripe } = fake({ createFails: "other" });
  await assert.rejects(ensurePrice(stripe, "op", "cumulus", 700), /stripe down/);
});
