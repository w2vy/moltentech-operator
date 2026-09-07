import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config";

// ⭐ Phase E polarity flip (2026-09-07). `MANIFEST_KEY` was the OPTIONAL half of an
// either/or with the legacy `AGENT_KEY` bearer, so an agent restarted from a stale
// `env.json` booted clean and authenticated `via=bearer` — the regression the Phase D
// soak exists to catch, silently. It is mandatory now; the bearer stays accepted
// alongside it as the rollback path, but it can no longer stand alone.

const BASE = { MT_BASE_URL: "https://mt.example", PROVIDER_SLUG: "pve25-lab", AGENT_DRY_RUN: "1" } as NodeJS.ProcessEnv;

test("⭐ AGENT_KEY alone no longer boots, and the error says what to do", () => {
  assert.throws(
    () => loadConfig({ ...BASE, AGENT_KEY: "legacy-bearer" }),
    /AGENT_KEY alone is no longer sufficient/
  );
});

test("MANIFEST_KEY alone boots", () => {
  const cfg = loadConfig({ ...BASE, MANIFEST_KEY: "not-a-real-manifest-key" });
  assert.equal(cfg.agentKey, undefined);
});

test("both set boots, and the bearer is still carried (rollback path)", () => {
  const cfg = loadConfig({ ...BASE, MANIFEST_KEY: "not-a-real-manifest-key", AGENT_KEY: "legacy-bearer" });
  assert.equal(cfg.agentKey, "legacy-bearer");
});

test("neither set still refuses", () => {
  assert.throws(() => loadConfig({ ...BASE }), /Missing agent auth/);
});
