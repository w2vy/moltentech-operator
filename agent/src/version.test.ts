import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { generateEd25519 } from "@moltentech/protocol/signing";
import { HEADER_AGENT_VERSION, HEADER_AGENT_SIGNATURE } from "@moltentech/protocol";
import { AGENT_VERSION } from "./version";
import { MtClient } from "./client";

// candid-versioning-lovelace — the version the agent reports IS the package version it runs,
// resolved relative to this module so it also holds inside the image (`/app/agent/package.json`).
test("🟢 AGENT_VERSION is this package's version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(AGENT_VERSION, pkg.version);
  assert.match(AGENT_VERSION, /^\d+\.\d+\.\d+/);
});

test("🟢 every hub request carries X-Agent-Version beside the signature", async () => {
  const { privateKey } = generateEd25519();
  const client = new MtClient("http://hub.test", { kind: "signature", key: privateKey }).withProvider("pve25-lab");
  const seen: Record<string, string>[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
    seen.push({ ...(init?.headers as Record<string, string>) });
    return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    await client.claimJobs();
  } finally {
    globalThis.fetch = realFetch;
  }
  const headers = seen[0];
  assert.ok(headers);
  assert.equal(headers[HEADER_AGENT_VERSION], AGENT_VERSION);
  // Informational, NOT part of the envelope: the signature header is still there unchanged.
  assert.ok(headers[HEADER_AGENT_SIGNATURE]);
});
