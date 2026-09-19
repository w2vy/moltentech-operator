/**
 * Where the inventory lives — decided by the SAME variables the agent reads, not by a
 * layout the toolkit assumes.
 *
 * `fh-toolkit init` writes `data/inventory.json` and a compose that mounts `./data:/data`,
 * so `AGENT_INVENTORY_PATH=/data/inventory.json` and the toolkit's hard-coded path agreed by
 * construction. An operator with another layout — moltentech's prod stack mounts
 * `./config:/config` and sets `AGENT_INVENTORY_PATH=/config/operator_inventory.json` — got a
 * doctor that silently skipped every inventory check and an `inventory` command that would
 * have written a file the agent never reads (tom, 2026-09-19: "doctor should follow config
 * variables").
 *
 * Resolution order, all pure so it is testable:
 *   1. `AGENT_INVENTORY_JSON`  — inline; there is no file. Doctor lints the text.
 *   2. `AGENT_INVENTORY_PATH`  — a CONTAINER path. Translated to a host path through the
 *                                compose file's bind mounts (`./host:/container[:ro]`); with
 *                                no compose or no matching mount, the leading `/` is dropped
 *                                and the rest taken relative to the operator dir, which is
 *                                what every scaffolded layout amounts to.
 *   3. neither                 — the legacy `data/inventory.json`, then `inventory.json`.
 */
export type InventorySource =
  | { kind: "inline"; text: string; label: string }
  | { kind: "file"; relPath: string; label: string; via: "AGENT_INVENTORY_PATH" | "default" };

/** `./data:/data:ro` → { host: "data", container: "/data" }; only bind mounts under the dir. */
export function composeBindMounts(composeText: string): Array<{ host: string; container: string }> {
  const mounts: Array<{ host: string; container: string }> = [];
  for (const raw of composeText.split("\n")) {
    const m = /^\s*-\s*["']?(\.\/[^:"'\s]+|\.):(\/[^:"'\s]*)(?::[a-z,]+)?["']?\s*(?:#.*)?$/.exec(raw);
    if (!m) continue;
    const host = m[1] === "." ? "" : m[1]!.replace(/^\.\//, "").replace(/\/$/, "");
    mounts.push({ host, container: m[2]!.replace(/\/$/, "") || "/" });
  }
  return mounts;
}

/** Translate a container path to a path relative to the operator dir. */
export function containerPathToHost(containerPath: string, mounts: Array<{ host: string; container: string }>): string {
  // Longest container prefix wins, so `/data/x` beats `/` when both are mounted.
  const sorted = [...mounts].sort((a, b) => b.container.length - a.container.length);
  for (const m of sorted) {
    if (containerPath === m.container || containerPath.startsWith(m.container === "/" ? "/" : m.container + "/")) {
      const rest = containerPath.slice(m.container === "/" ? 1 : m.container.length + 1);
      return [m.host, rest].filter(Boolean).join("/");
    }
  }
  return containerPath.replace(/^\/+/, "");
}

export function resolveInventorySource(
  operator: Record<string, string> | undefined,
  composeText: string | undefined,
  exists: (relPath: string) => boolean
): InventorySource {
  const inline = operator?.AGENT_INVENTORY_JSON;
  if (inline && inline.trim() !== "") return { kind: "inline", text: inline, label: "AGENT_INVENTORY_JSON (inline)" };
  const containerPath = operator?.AGENT_INVENTORY_PATH?.trim();
  if (containerPath) {
    const relPath = containerPathToHost(containerPath, composeText ? composeBindMounts(composeText) : []);
    return { kind: "file", relPath, label: `${relPath} (AGENT_INVENTORY_PATH=${containerPath})`, via: "AGENT_INVENTORY_PATH" };
  }
  const rel = exists("data/inventory.json") || !exists("inventory.json") ? "data/inventory.json" : "inventory.json";
  return { kind: "file", relPath: rel, label: rel, via: "default" };
}
