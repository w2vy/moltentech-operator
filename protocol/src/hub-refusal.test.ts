import { test } from "node:test";
import assert from "node:assert/strict";
import { hubError } from "./hub-refusal";

function res(status: number, body: unknown, json = true): Response {
  return {
    status,
    json: async () => {
      if (!json) throw new SyntaxError("Unexpected token < in JSON");
      return body;
    },
  } as unknown as Response;
}

test("a hub refusal reaches the operator's log with its reason", async () => {
  const err = await hubError(
    "claim",
    res(403, {
      error: "provider_retired",
      providerStatus: "retired",
      reason: "This provider is RETIRED on Flux Hub, so its agent requests are refused.",
    })
  );
  assert.match(err.message, /claim refused: 403/);
  assert.match(err.message, /provider retired/);
  assert.match(err.message, /RETIRED on Flux Hub/);
});

test("a plain failure still reports its status and nothing more", async () => {
  // The 401 case is the one that must NOT gain invented prose — there is no body to read.
  const err = await hubError("nodes list", res(401, null));
  assert.equal(err.message, "nodes list failed: 401");
});

test("an HTML error page from a proxy does not swallow the status", async () => {
  // A 502 from Caddy is not JSON. Parsing it must never throw over the caller's status.
  const err = await hubError("health report", res(502, undefined, false));
  assert.equal(err.message, "health report failed: 502");
});

test("a JSON body that is not a refusal falls through", async () => {
  const err = await hubError("listing", res(400, { error: "Invalid listing" }));
  assert.equal(err.message, "listing failed: 400");
});
