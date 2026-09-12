/**
 * Client for the hub's pre-ingest name-availability check, `POST /api/onboard/check-names`.
 *
 * Advisory only: nothing is reserved, ingest re-checks and wins. The value is that a
 * taken slug or VM prefix is reported at the prompt where the operator can still change
 * it, instead of five steps later as a 409 from ingest — or, worse, as the misleading
 * "pubkey does not match" that a slug registered to someone ELSE produces.
 *
 * Shaped like `fetchTierMinimums`: injected fetch, a short abort, and `null` on ANY
 * failure — unreachable, 404 (an older hub), 429 (rate limit), malformed body. A wizard
 * that cannot reach the hub must still be able to scaffold; the callers print one
 * "names unchecked" line and carry on.
 *
 * Every request field is optional so `init` can check one answer at a time as it
 * prompts. `self` names the provider the caller already IS, so `doctor`/`level` — which
 * run for a registered provider — do not see their own slug and prefix as "taken". It is
 * a claim the hub cannot verify; the API is unauthenticated by design (see the plan).
 */

export interface NameCheckRequest {
  /** The caller's own slug; the hub excludes that provider's rows from every verdict. */
  self?: string;
  slug?: string;
  name?: string;
  vmNamePrefix?: string;
  hostNames?: string[];
  vmNames?: string[];
}

/** Why a value is unavailable. Unknown strings are passed through verbatim. */
export type NameCheckReason = "taken" | "reserved" | "invalid-format" | (string & {});
/** Advisory notes on a value that IS available. */
export type NameCheckWarning = "similar-to-existing" | "confusable" | (string & {});

export interface NameVerdict {
  value: string;
  available: boolean;
  reason?: NameCheckReason;
  warning?: NameCheckWarning;
}

export interface NameCheckResponse {
  advisory: true;
  /** The hub's own base URL, so a wizard pointed at the wrong registry can see it. */
  hub?: string;
  slug?: NameVerdict;
  name?: NameVerdict;
  vmNamePrefix?: NameVerdict;
  hostNames?: NameVerdict[];
  vmNames?: NameVerdict[];
  /** Format rules as prose, so a wizard can validate offline. */
  rules?: Record<string, string>;
}

function isVerdict(v: unknown): v is NameVerdict {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as NameVerdict).value === "string" &&
    typeof (v as NameVerdict).available === "boolean"
  );
}

/**
 * Returns the hub's verdicts, or `null` on any failure. Never throws.
 *
 * A malformed body is `null` too — a half-parsed answer would let one bad field print
 * as "available" — but the body is only required to be well-formed for the fields it
 * carries, so a hub that answers a subset of what was asked is still a valid answer.
 */
export async function checkNames(
  mtBaseUrl: string,
  req: NameCheckRequest,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000
): Promise<NameCheckResponse | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${mtBaseUrl.replace(/\/$/, "")}/api/onboard/check-names`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<NameCheckResponse>;
    if (typeof body !== "object" || body === null) return null;
    for (const k of ["slug", "name", "vmNamePrefix"] as const) {
      if (body[k] !== undefined && !isVerdict(body[k])) return null;
    }
    for (const k of ["hostNames", "vmNames"] as const) {
      const list = body[k];
      if (list !== undefined && (!Array.isArray(list) || !list.every(isVerdict))) return null;
    }
    return { ...body, advisory: true };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface NameFindings {
  /** Ingest WILL refuse these. */
  blocking: string[];
  /** Worth a look; ingest accepts them. */
  advisory: string[];
}

function unavailableText(what: string, v: NameVerdict): string {
  switch (v.reason) {
    case "taken":
      return `${what} "${v.value}" is already registered on this hub.`;
    case "reserved":
      return `${what} "${v.value}" is reserved (the Foundation's namespace).`;
    case "invalid-format":
      return `${what} "${v.value}" is not in the format the hub accepts.`;
    default:
      return `${what} "${v.value}" is not available${v.reason ? ` (${v.reason})` : ""}.`;
  }
}

function warningText(what: string, v: NameVerdict): string {
  switch (v.warning) {
    case "similar-to-existing":
      return `${what} "${v.value}" is very close to a provider already on this hub — a customer could confuse the two.`;
    case "confusable":
      return `${what} "${v.value}" looks like an existing provider's — the hub will flag it for an admin to review.`;
    default:
      return `${what} "${v.value}": ${v.warning}`;
  }
}

/**
 * The one place the verdicts become sentences, so `init`, `doctor` and `level` say the
 * same words for the same problem. Pure.
 */
export function describeNameFindings(resp: NameCheckResponse): NameFindings {
  const blocking: string[] = [];
  const advisory: string[] = [];
  const one = (what: string, v: NameVerdict | undefined): void => {
    if (!v) return;
    if (!v.available) blocking.push(unavailableText(what, v));
    else if (v.warning) advisory.push(warningText(what, v));
  };
  one("Provider slug", resp.slug);
  one("Display name", resp.name);
  one("VM name prefix", resp.vmNamePrefix);
  for (const v of resp.hostNames ?? []) one("Proxmox host", v);
  for (const v of resp.vmNames ?? []) one("VM name", v);
  return { blocking, advisory };
}
