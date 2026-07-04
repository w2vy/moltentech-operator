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
  HealthReport,
  type NodeHealth,
} from "@moltentech/protocol";
import { z } from "zod";
import { signAgentRequest } from "./signing";

/** How the client authenticates to MT: an asymmetric signature or the legacy bearer. */
export type MtClientAuth =
  | { kind: "signature"; key: KeyObject }
  | { kind: "bearer"; agentKey: string };

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
    if (this.auth.kind === "signature") {
      return signAgentRequest(this.auth.key, method, path, this.providerSlug, rawBody);
    }
    return { Authorization: `Bearer ${this.auth.agentKey}` };
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
    if (!res.ok) throw new Error(`claim failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`result failed: ${res.status}`);
  }

  /** Re-assert the operator's desired price/capacity (heartbeat + on change). */
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
    if (!res.ok) throw new Error(`listing failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`inventory failed: ${res.status}`);
  }

  /** Fetch the provider's privileged actions awaiting the owner's signature. */
  async getPendingAuth(): Promise<PendingAuthItem[]> {
    const path = "/api/agent/pending-auth";
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers("GET", path, "") });
    if (!res.ok) throw new Error(`pending-auth fetch failed: ${res.status}`);
    const parsed = z.object({ items: z.array(PendingAuthItem) }).safeParse(await res.json());
    if (!parsed.success) throw new Error("invalid pending-auth payload");
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
    if (!res.ok) throw new Error(`authorize failed: ${res.status}`);
  }

  /** Fetch this provider's live nodes so the agent knows which local VMs to health-check. */
  async getNodes(): Promise<
    { tier: string; host: string; apiPort: number; vmName: string; nodeName: string }[]
  > {
    const path = "/api/agent/nodes";
    const res = await fetch(`${this.baseUrl}${path}`, { headers: this.headers("GET", path, "") });
    if (!res.ok) throw new Error(`nodes fetch failed: ${res.status}`);
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
    if (!res.ok) throw new Error(`health report failed: ${res.status}`);
  }

  // providerSlug is set by the caller via withProvider() so requests can stamp it
  // (into the payload and, when signing, the request envelope + X-Agent-Slug header).
  private providerSlug = "";
  withProvider(slug: string): this {
    this.providerSlug = slug;
    return this;
  }
}
