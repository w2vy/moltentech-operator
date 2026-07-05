import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The running Coalition code version. Reported to MoltenTech on every response
 * (the `X-Coalition-Version` header + the `/health` body), so MT can see which
 * providers are on an outdated coalition and nudge them to sync their fork.
 *
 * Overridable via the `COALITION_VERSION` env (e.g. a build-injected git tag/SHA);
 * otherwise it falls back to this package's `version`. Since operators update by
 * syncing their fork, the package.json version they carry == the version they run.
 */
function pkgVersion(): string {
  try {
    const p = fileURLToPath(new URL("../package.json", import.meta.url));
    return (JSON.parse(readFileSync(p, "utf8")).version as string) ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export const COALITION_VERSION = process.env.COALITION_VERSION || pkgVersion();
