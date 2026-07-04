import type { KeyObject } from "node:crypto";
import {
  AuthorizationList,
  type PendingAuthItem,
  type SignedAuthorization,
} from "@moltentech/protocol";
import { signAgentRequest } from "./signing";

/**
 * Outbound client to the operator's own Coalition console (WS3 courier). The
 * agent pushes the pending-authorization list and polls for the operator-signed
 * blobs. Authenticated with the manifest key (same one used for agent → MT); the
 * coalition verifies it against the manifest pubkey it serves. Outbound-only — the
 * agent dials the coalition, never the reverse.
 */
export class CoalitionClient {
  constructor(
    private readonly baseUrl: string,
    private readonly key: KeyObject,
    private readonly slug: string
  ) {}

  private headers(method: string, path: string, rawBody: string): Record<string, string> {
    return { "Content-Type": "application/json", ...signAgentRequest(this.key, method, path, this.slug, rawBody) };
  }

  /** Push the current pending-authorization list for the operator to sign. */
  async pushPending(items: PendingAuthItem[]): Promise<void> {
    const path = "/agent/pending";
    const raw = JSON.stringify({ items });
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers("POST", path, raw),
      body: raw,
    });
    if (!res.ok) throw new Error(`coalition pending push failed: ${res.status}`);
  }

  /** Pull the operator-signed authorizations queued since the last poll. */
  async pollAuthorizations(): Promise<SignedAuthorization[]> {
    const path = "/agent/authorizations";
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers("GET", path, "") });
    if (!res.ok) throw new Error(`coalition authorizations poll failed: ${res.status}`);
    const parsed = AuthorizationList.safeParse(await res.json());
    if (!parsed.success) throw new Error("invalid authorizations payload");
    return parsed.data.items;
  }
}
