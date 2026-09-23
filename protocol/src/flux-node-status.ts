/**
 * What a running Flux node says about itself — `GET /daemon/getfluxnodestatus` — narrowed to
 * the facts the existing-node scan pre-fills: tier, the WAN ip:port the chain has, and the
 * collateral outpoint.
 *
 * Shape measured on prod nodes 2026-09-23:
 *   `{ status: "success", data: { status: "CONFIRMED", ip: "47.206.56.184:16197",
 *     tier: "CUMULUS", txhash: "<64 hex>", outidx: "0", collateral: "COutPoint(…, 0)", … } }`
 * - `tier` is UPPERCASE; `outidx` is a STRING.
 * - `ip` OMITS the port when it is the default 16127 (`"47.206.56.185"`).
 * - A daemon still starting answers `{ status: "error", data: { message: "Loading block index..." } }`.
 *
 * Probed on the WAN address, never the LAN: node VLANs are isolated, and on 2026-09-23 the LAN
 * port timed out from every machine tried while the WAN answered from all of them.
 */

export const FLUX_DEFAULT_API_PORT = 16127;

export interface FluxNodeStatus {
  /** `CONFIRMED`, `STARTED`, `DOS_BANNED`, … as the daemon reports it. */
  status: string;
  /** Lowercased tier (`cumulus`), or undefined when the node has none yet. */
  tier?: string;
  ip: string;
  apiPort: number;
  collateral?: { txid: string; vout: number };
}

/** Parse the response body; null for an error answer or an unrecognised shape. */
export function parseFluxNodeStatus(body: unknown): FluxNodeStatus | null {
  if (typeof body !== "object" || body === null) return null;
  const b = body as { status?: unknown; data?: Record<string, unknown> };
  if (b.status !== "success" || typeof b.data !== "object" || b.data === null) return null;
  const d = b.data;
  if (typeof d.status !== "string" || typeof d.ip !== "string") return null;
  const m = /^(.+?)(?::(\d+))?$/.exec(d.ip);
  const ip = m?.[1] ?? d.ip;
  const apiPort = m?.[2] ? Number(m[2]) : FLUX_DEFAULT_API_PORT;
  const vout = typeof d.outidx === "number" ? d.outidx : Number(d.outidx);
  const txid = typeof d.txhash === "string" ? d.txhash : "";
  return {
    status: d.status,
    ...(typeof d.tier === "string" && d.tier ? { tier: d.tier.toLowerCase() } : {}),
    ip,
    apiPort,
    ...(/^[0-9a-f]{64}$/i.test(txid) && Number.isInteger(vout) && vout >= 0 ? { collateral: { txid, vout } } : {}),
  };
}

/** Ask a node at its WAN ip:port. Null when it cannot be reached or answers an error. */
export async function fetchFluxNodeStatus(
  ip: string,
  apiPort: number,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 6000
): Promise<FluxNodeStatus | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`http://${ip}:${apiPort}/daemon/getfluxnodestatus`, { signal: controller.signal });
    if (!res.ok) return null;
    return parseFluxNodeStatus(await res.json());
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
