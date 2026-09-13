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
