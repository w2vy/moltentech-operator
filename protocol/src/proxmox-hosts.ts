/**
 * One agent, several Proxmox endpoints: the per-host credentials in `.env.operator`.
 *
 * `PROXMOX_URL` / `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` reach one host or one cluster. A
 * standalone host that is not in that cluster has its own three, with its Proxmox node name on
 * the end (`PROXMOX_URL_PVE31`). A host with none of them uses the plain three, so an operator
 * with one host or one cluster changes nothing.
 *
 * The secret's NAME still contains TOKEN and SECRET: that is what `diagnose` and
 * `config-lint` recognise a credential by. A single JSON variable would have hidden it.
 */

export interface HostProxmoxCreds {
  url?: string;
  tokenId?: string;
  tokenSecret?: string;
}

const PREFIXES = [
  ["PROXMOX_TOKEN_SECRET_", "tokenSecret"],
  ["PROXMOX_TOKEN_ID_", "tokenId"],
  ["PROXMOX_URL_", "url"],
] as const;

/** `pve-31` → `PVE_31`: the node name as it ends an environment variable. */
export function hostEnvSuffix(nodeName: string): string {
  return nodeName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
}

/** The three variable names for a node, in the order they are written. */
export function hostEnvKeys(nodeName: string): { url: string; tokenId: string; tokenSecret: string } {
  const s = hostEnvSuffix(nodeName);
  return { url: `PROXMOX_URL_${s}`, tokenId: `PROXMOX_TOKEN_ID_${s}`, tokenSecret: `PROXMOX_TOKEN_SECRET_${s}` };
}

/** Is this a per-host Proxmox variable, and which of the three? */
export function hostEnvField(key: string): { suffix: string; field: keyof HostProxmoxCreds } | null {
  for (const [prefix, field] of PREFIXES) {
    if (key.startsWith(prefix) && key.length > prefix.length) return { suffix: key.slice(prefix.length), field };
  }
  return null;
}

/**
 * Every host with at least one non-empty per-host variable, by suffix.
 *
 * ⚠️ A host with SOME of its three is kept, incomplete, on purpose. Dropping it would send the
 * host's jobs to the plain `PROXMOX_*` endpoint, which is a different machine.
 */
export function parseHostEndpoints(env: Record<string, string | undefined>): Record<string, HostProxmoxCreds> {
  const out: Record<string, HostProxmoxCreds> = {};
  for (const [key, value] of Object.entries(env)) {
    const hit = hostEnvField(key);
    if (!hit || !value) continue;
    (out[hit.suffix] ??= {})[hit.field] = hit.field === "url" ? value.replace(/\/+$/, "") : value;
  }
  return out;
}

export function credsComplete(c: HostProxmoxCreds): c is Required<HostProxmoxCreds> {
  return Boolean(c.url && c.tokenId && c.tokenSecret);
}

/** Which of a host's three variables are missing, by name. */
export function missingHostKeys(suffix: string, c: HostProxmoxCreds): string[] {
  const keys = hostEnvKeys(suffix);
  return (["url", "tokenId", "tokenSecret"] as const).filter((f) => !c[f]).map((f) => keys[f]);
}

/** The credentials that reach `nodeName`: its own when it has any, else the plain ones. */
export function credsForNode(
  nodeName: string,
  plain: HostProxmoxCreds,
  perHost: Record<string, HostProxmoxCreds> = {}
): HostProxmoxCreds {
  return perHost[hostEnvSuffix(nodeName)] ?? plain;
}
