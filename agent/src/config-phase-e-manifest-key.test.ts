import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config";

// ⭐ Phase E (2026-09-07). `MANIFEST_KEY` was the OPTIONAL half of an either/or with the
// legacy `AGENT_KEY` bearer, so an agent restarted from a stale `env.json` booted clean
// and authenticated `via=bearer` — the regression the Phase D soak exists to catch,
// silently. The polarity flip made MANIFEST_KEY mandatory; step 4 then removed the bearer
// from every code path, so AGENT_KEY is now read for exactly one purpose: telling an
// operator with a stale env.json precisely what is wrong.

const BASE = { MT_BASE_URL: "https://mt.example", PROVIDER_SLUG: "pve25-lab", AGENT_DRY_RUN: "1" } as NodeJS.ProcessEnv;

test("⭐ AGENT_KEY alone no longer boots, and the error says it is dead, not just insufficient", () => {
  // The wording matters more than the throw. An operator reading "insufficient" reaches
  // for a second credential; "no longer used at all" tells them to stop looking for one.
  assert.throws(
    () => loadConfig({ ...BASE, AGENT_KEY: "legacy-bearer" }),
    /AGENT_KEY is no longer used at all/
  );
});

test("MANIFEST_KEY alone boots", () => {
  const cfg = loadConfig({ ...BASE, MANIFEST_KEY: "not-a-real-manifest-key" });
  assert.equal(cfg.legacyAgentKeyPresent, false);
});

test("🔒 a stale AGENT_KEY is NOTED but never carried as a credential", () => {
  const cfg = loadConfig({ ...BASE, MANIFEST_KEY: "not-a-real-manifest-key", AGENT_KEY: "legacy-bearer" });
  assert.equal(cfg.legacyAgentKeyPresent, true);
  // The value must not survive onto the config. A credential the code cannot use is one
  // nobody audits — and it would still show up in a heap dump or a debug print.
  assert.equal(JSON.stringify(cfg).includes("legacy-bearer"), false);
});

test("neither set still refuses", () => {
  assert.throws(() => loadConfig({ ...BASE }), /Missing agent auth/);
});
