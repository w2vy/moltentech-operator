import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The running agent code version. Sent to the hub on every request as
 * `X-Agent-Version` (see `client.ts`), so the hub can show which agent an operator runs
 * next to their Coalition version and flag one older than the hub was built against.
 *
 * Same shape as `coalition/src/version.ts`: `AGENT_VERSION` env overrides (a build can
 * inject a tag/SHA), otherwise this package's `version`. The image copies `agent/` whole
 * and runs from `src/` under tsx, so `../package.json` resolves to `/app/agent/package.json`
 * at runtime — the one build-side assumption, and the reason the fallback is a visible
 * `0.0.0` rather than a throw.
 */
function pkgVersion(): string {
  try {
    const p = fileURLToPath(new URL("../package.json", import.meta.url));
    return (JSON.parse(readFileSync(p, "utf8")).version as string) ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const AGENT_VERSION = process.env.AGENT_VERSION || pkgVersion();

/**
 * The version as a person reads it: `0.11.64 · built 2026-10-12T14:03:22Z · 1a2b3c4d5e6f`.
 * The build time and commit are baked in by the publish workflow (Dockerfile ARGs →
 * `FH_BUILD_TIME` / `FH_BUILD_SHA`), the same pair `fh-toolkit version` prints. A source
 * checkout has neither, and gets the bare version rather than an invented stamp.
 *
 * ⚠️ Display only. `X-Agent-Version` keeps sending the bare `AGENT_VERSION`: the hub
 * compares it against its pinned version, and a suffix would break that comparison.
 */
export function agentBuildLabel(env: Record<string, string | undefined> = process.env): string {
  const time = env.FH_BUILD_TIME?.trim();
  const sha = env.FH_BUILD_SHA?.trim();
  return [AGENT_VERSION, time ? `built ${time}` : null, sha ? sha.slice(0, 12) : null]
    .filter(Boolean)
    .join(" · ");
}
