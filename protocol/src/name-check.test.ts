import { test } from "node:test";
import assert from "node:assert/strict";
import { checkNames, describeNameFindings } from "./name-check";

const ok = (body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

test("checkNames posts the request to /api/onboard/check-names and returns the verdicts", async () => {
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  const fake = (async (url: string, init?: RequestInit) => {
    seenUrl = url;
    seenInit = init;
    return new Response(
      JSON.stringify({
        advisory: true,
        hub: "https://mt.example",
        slug: { value: "acme", available: false, reason: "taken" },
        vmNames: [{ value: "ac-1", available: true }],
      }),
      { status: 200 }
    );
  }) as unknown as typeof fetch;
  const resp = await checkNames("https://mt.example/", { slug: "acme", vmNames: ["ac-1"] }, fake);
  assert.equal(seenUrl, "https://mt.example/api/onboard/check-names");
  assert.equal(seenInit?.method, "POST");
  assert.deepEqual(JSON.parse(String(seenInit?.body)), { slug: "acme", vmNames: ["ac-1"] });
  assert.equal(resp?.slug?.available, false);
  assert.equal(resp?.slug?.reason, "taken");
  assert.equal(resp?.vmNames?.[0]?.available, true);
});

test("checkNames returns null on every failure shape (old hub 404, 429, 500, throw, malformed)", async () => {
  const cases: Array<typeof fetch> = [
    (async () => new Response("no such route", { status: 404 })) as unknown as typeof fetch,
    (async () => new Response("slow down", { status: 429 })) as unknown as typeof fetch,
    (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
    (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch,
    (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch,
    ok({ slug: "acme" }), // a verdict that is not a verdict
    ok({ vmNames: [{ value: "x" }] }), // missing `available`
    ok(null),
  ];
  for (const f of cases) {
    assert.equal(await checkNames("https://mt.example", { slug: "acme" }, f), null);
  }
});

test("checkNames accepts a subset answer (the hub need not echo every field asked)", async () => {
  const resp = await checkNames("https://mt.example", { slug: "acme", name: "Acme" }, ok({ slug: { value: "acme", available: true } }));
  assert.equal(resp?.slug?.available, true);
  assert.equal(resp?.name, undefined);
  assert.equal(resp?.advisory, true);
});

test("describeNameFindings: unavailable → blocking, warnings → advisory, one sentence each", () => {
  const f = describeNameFindings({
    advisory: true,
    slug: { value: "acme", available: false, reason: "taken" },
    name: { value: "Acme", available: true, warning: "similar-to-existing" },
    vmNamePrefix: { value: "fh-", available: false, reason: "reserved" },
    hostNames: [
      { value: "pve30", available: false, reason: "taken" },
      { value: "pve31", available: true },
    ],
    vmNames: [{ value: "ac-1", available: true, warning: "confusable" }],
  });
  assert.equal(f.blocking.length, 3);
  assert.match(f.blocking[0]!, /slug "acme" is already registered/);
  assert.match(f.blocking[1]!, /prefix "fh-" is reserved/);
  assert.match(f.blocking[2]!, /host "pve30" is already registered/);
  assert.equal(f.advisory.length, 2);
  assert.match(f.advisory[0]!, /name "Acme" is very close/);
  assert.match(f.advisory[1]!, /VM name "ac-1" looks like/);
  // An unknown reason from a newer hub is passed through, never swallowed.
  const g = describeNameFindings({ advisory: true, slug: { value: "x", available: false, reason: "frozen" } });
  assert.match(g.blocking[0]!, /not available \(frozen\)/);
});

test("describeNameFindings: nothing to say is two empty lists", () => {
  assert.deepEqual(describeNameFindings({ advisory: true }), { blocking: [], advisory: [] });
});
