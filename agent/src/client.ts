import type { KeyObject } from "node:crypto";
import {
  SCHEMA_VERSION,
  Job,
  JobResult,
  ListingAssert,
  type ListingTier,
  InventoryAssert,
  type InventoryHost,
  PendingAuthItem,
  type OwnerAuth,
  NodeStateList,
  type NodeStateItem,
  HealthReport,
  type NodeHealth,
  hubError,
} from "@moltentech/protocol";
import { z } from "zod";
import { signAgentRequest } from "./signing";

/**
 * How the client authenticates to MT. One way, since Phase E step 4 (2026-09-07): a
 * signature over the request envelope.
 *
 * Kept as a tagged union of one rather than collapsed to a bare `KeyObject`, because the
 * shape is what makes adding a second mechanism a deliberate act with a name — which is
 * how the bearer got removed cleanly rather than being tangled through every call site.
 */
export type MtClientAuth = { kind: "signature"; key: KeyObject };

/**
 * Typed, outbound-only client for the MoltenTech agent API. Requests are
 * authenticated either by signing a canonical request envelope with the manifest
 * key (Phase B) or by the legacy per-provider bearer; responses are validated
 * against the shared protocol schemas.
 */
export class MtClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: MtClientAuth
  ) {}

  /** Auth headers for one request; the signed envelope binds method/path/slug/body. */
  private authHeaders(method: string, path: string, rawBody: string): Record<string, string> {
    return signAgentRequest(this.auth.key, method, path, this.providerSlug, rawBody);
  }

  private headers(method: string, path: string, rawBody: string): Record<string, string> {
    return { "Content-Type": "application/json", ...this.authHeaders(method, path, rawBody) };
  }

  /** Claim (lease) any provisioning jobs MT has queued for this provider. */
  async claimJobs(): Promise<Job[]> {
    const path = "/api/agent/jobs/claim";
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers("POST", path, ""),
    });
    if (!res.ok) throw await hubError("claim", res);
    const body = (await res.json()) as { jobs?: unknown[] };
    return (body.jobs ?? []).map((j) => Job.parse(j));
  }

  /** Report a finished job; MT runs the slot/rental transitions. */
  async postResult(result: JobResult): Promise<void> {
    JobResult.parse(result);
    const path = `/api/agent/jobs/${result.jobId}/result`;
    const raw = JSON.stringify(result);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers("POST", path, raw),
      body: raw,
    });
    if (!res.ok) throw await hubError("result", res);
  }

  /** Re-assert the operator's desired price + slots offered (heartbeat + on change). */
  async assertListing(tiers: ListingTier[]): Promise<void> {
    const payload: ListingAssert = {
      schemaVersion: SCHEMA_VERSION,
      providerSlug: this.providerSlug,
      assertedAt: new Date().toISOString(),
      tiers,
    };
    ListingAssert.parse(payload);
    const path = "/api/agent/listing";
    const raw = JSON.stringify(payload);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: this.headers("PUT", path, raw),
      body: raw,
    });
    if (!res.ok) throw await hubError("listing", res);
  }

  /** Declare the operator's agent-managed hosts + slots so MT materializes them. */
  async assertInventory(hosts: InventoryHost[]): Promise<void> {
    const payload: InventoryAssert = {
      schemaVersion: SCHEMA_VERSION,
      providerSlug: this.providerSlug,
      assertedAt: new Date().toISOString(),
      hosts,
    };
    InventoryAssert.parse(payload);
    const path = "/api/agent/inventory";
    const raw = JSON.stringify(payload);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: this.headers("PUT", path, raw),
      body: raw,
    });
    if (!res.ok) throw await hubError("inventory", res);
  }

  /** Fetch the provider's privileged actions awaiting the owner's signature. */
  async getPendingAuth(): Promise<PendingAuthItem[]> {
    const path = "/api/agent/pending-auth";
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers("GET", path, "") });
    if (!res.ok) throw await hubError("pending-auth fetch", res);
    const parsed = z.object({ items: z.array(PendingAuthItem) }).safeParse(await res.json());
    if (!parsed.success) throw new Error("invalid pending-auth payload");
    return parsed.data.items;
  }

  /** Fetch the provider's full slot state (status + rental) for the console dashboard. */
  async getState(): Promise<NodeStateItem[]> {
    const path = "/api/agent/state";
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers("GET", path, "") });
    if (!res.ok) throw await hubError("state fetch", res);
    const parsed = NodeStateList.safeParse(await res.json());
    if (!parsed.success) throw new Error("invalid state payload");
    return parsed.data.items;
  }

  /** Relay an operator-signed authorization to MT (queues the privileged job). */
  async submitAuthorize(slotId: string, ownerAuth: OwnerAuth): Promise<void> {
    const path = "/api/agent/authorize";
    const raw = JSON.stringify({ slotId, ownerAuth });
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: this.headers("POST", path, raw),
      body: raw,
    });
    if (!res.ok) throw await hubError("authorize", res);
  }

  /** Fetch this provider's live nodes so the agent knows which local VMs to health-check. */
  async getNodes(): Promise<
    { tier: string; host: string; apiPort: number; vmName: string; nodeName: string }[]
  > {
    const path = "/api/agent/nodes";
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers("GET", path, "") });
    if (!res.ok) throw await hubError("nodes fetch", res);
    const body = (await res.json()) as {
      nodes?: { tier: string; host: string; apiPort: number; vmName: string; nodeName: string }[];
    };
    return body.nodes ?? [];
  }

  /** Report per-VM running state gathered from the LOCAL Proxmox. */
  async reportHealth(nodes: NodeHealth[]): Promise<void> {
    const payload: HealthReport = {
      schemaVersion: SCHEMA_VERSION,
      providerSlug: this.providerSlug,
      reportedAt: new Date().toISOString(),
      nodes,
    };
    HealthReport.parse(payload);
    const path = "/api/agent/health";
    const raw = JSON.stringify(payload);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "PUT",
      headers: this.headers("PUT", path, raw),
      body: raw,
    });
    if (!res.ok) throw await hubError("health report", res);
  }

  // providerSlug is set by the caller via withProvider() so requests can stamp it
  // (into the payload and, when signing, the request envelope + X-Agent-Slug header).
  private providerSlug = "";
  withProvider(slug: string): this {
    this.providerSlug = slug;
    return this;
  }
}
