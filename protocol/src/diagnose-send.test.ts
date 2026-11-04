import { test } from "node:test";
import assert from "node:assert/strict";
import { answerLines, sendBundle } from "./diagnose-send";
import type { HubHttp } from "./hub-probe";
import { bodyHash, generateEd25519, verifyRequest } from "./signing";

const pair = generateEd25519();
const manifestKey = Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString()).toString("base64");
const input = { mtBaseUrl: "https://hub.test/", manifestKey, providerSlug: "buzznet", body: '{"format":"fh-diagnose/1"}' };

const reply = (status: number, text = ""): HubHttp => async () => ({ status, text, headers: {} });

test("the request is signed the way the hub checks it", async () => {
  let seen: Parameters<HubHttp>[0] | undefined;
  const http: HubHttp = async (req) => {
    seen = req;
    return { status: 200, text: JSON.stringify({ id: "DG-0001", status: "unanswered" }), headers: {} };
  };
  await sendBundle(input, http);
  assert.equal(seen?.url, "https://hub.test/api/agent/diagnose");
  assert.equal(seen?.body, input.body);
  const ok = verifyRequest(
    {
      method: "POST",
      path: "/api/agent/diagnose",
      slug: "buzznet",
      issuedAt: seen!.headers["x-agent-timestamp"]!,
      nonce: seen!.headers["x-agent-nonce"]!,
      bodyHash: bodyHash(input.body),
    },
    seen!.headers["x-agent-signature"]!,
    pair.publicKeyBase64
  );
  assert.equal(ok, true);
});

test("an answer prints the cause, numbered steps and the ID", () => {
  const out = answerLines({ id: "DG-0042", status: "answered", cause: "No import on local.", confidence: "high", steps: ["Open Storage.", "Add Import."], escalate: false }).join("\n");
  assert.match(out, /Likely cause \(high confidence\):\n  No import on local\./);
  assert.match(out, /1\. Open Storage\.\n  2\. Add Import\./);
  assert.match(out, /Support ID: DG-0042/);
  assert.doesNotMatch(out, /needs a person/);
});

test("escalate tells the operator to contact a person", () => {
  const out = answerLines({ id: "DG-1", status: "answered", cause: "x", confidence: "low", steps: [], escalate: true }).join("\n");
  assert.match(out, /needs a person/);
  assert.doesNotMatch(out, /What to do/);
});

test("no AI answer still gives the ID", async () => {
  const r = await sendBundle(input, reply(200, JSON.stringify({ id: "DG-0007", status: "unanswered" })));
  assert.equal(r.sent, true);
  assert.match(r.lines.join("\n"), /quote DG-0007/);
});

test("escape sequences in an answer never reach the terminal", () => {
  const out = answerLines({ id: "DG-1\u001b[2J", status: "answered", cause: "bad\u001b]0;title\u0007 text", confidence: "high", steps: ["run\u0008 this"], escalate: false }).join("\n");
  assert.doesNotMatch(out, /[\u0000-\u0009\u000b-\u001f]/);
});

for (const [status, text] of [
  [401, /rejected your signature/],
  [404, /does not offer diagnose/],
  [413, /too large/],
  [429, /daily limit/],
  [503, /answered 503/],
] as const) {
  test(`a ${status} says so and points at the file`, async () => {
    const r = await sendBundle(input, reply(status));
    assert.equal(r.sent, false);
    assert.match(r.lines.join("\n"), text);
    assert.match(r.lines.join("\n"), /still here/);
  });
}

test("a dead link and a bad key are reported, not thrown", async () => {
  const dead = await sendBundle(input, async () => {
    throw new Error("connect refused");
  });
  assert.match(dead.lines.join("\n"), /Could not reach .*connect refused/);
  const badKey = await sendBundle({ ...input, manifestKey: "bm90IGEga2V5" }, reply(200));
  assert.equal(badKey.sent, false);
});

test("an unreadable 200 is not an answer", async () => {
  const r = await sendBundle(input, reply(200, "<html>"));
  assert.equal(r.sent, false);
});
