import {
  SCHEMA_VERSION,
  Job,
  JobResult,
  ListingAssert,
  type ListingTier,
} from "@moltentech/protocol";

/**
 * Typed, outbound-only client for the MoltenTech agent API. All calls are
 * Bearer-authenticated with the per-provider agent key; responses are validated
 * against the shared protocol schemas.
 */
export class MtClient {
  constructor(
    private readonly baseUrl: string,
    private readonly agentKey: string
  ) {}

  private headers(): Record<string, string> {
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.agentKey}` };
  }

  /** Claim (lease) any provisioning jobs MT has queued for this provider. */
  async claimJobs(): Promise<Job[]> {
    const res = await fetch(`${this.baseUrl}/api/agent/jobs/claim`, {
      method: "POST",
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`claim failed: ${res.status}`);
    const body = (await res.json()) as { jobs?: unknown[] };
    return (body.jobs ?? []).map((j) => Job.parse(j));
  }

  /** Report a finished job; MT runs the slot/rental transitions. */
  async postResult(result: JobResult): Promise<void> {
    JobResult.parse(result);
    const res = await fetch(`${this.baseUrl}/api/agent/jobs/${result.jobId}/result`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(result),
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
    const res = await fetch(`${this.baseUrl}/api/agent/listing`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error(`listing failed: ${res.status}`);
  }

  // providerSlug is set by the caller via withProvider() so assertListing can stamp it.
  private providerSlug = "";
  withProvider(slug: string): this {
    this.providerSlug = slug;
    return this;
  }
}
