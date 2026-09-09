import { z } from "zod";

/**
 * The hub's "you are still who you say you are, but you may not act" answer
 * (Flux Hub codd Phase 4).
 *
 * A suspended or retired provider still holds a valid signing key, so its requests
 * authenticate and are then refused on STANDING — 403, never 401, with a reason written
 * for the operator rather than for the hub. This module is here, in the shared protocol,
 * because both callers hit the same wall: the agent's eleven routes and the Coalition's
 * three, and a refusal explained to one and swallowed by the other is the worse of the two
 * outcomes made permanent.
 */
export const HubRefusal = z.object({
  /** Machine-readable and stable — `provider_suspended` / `provider_retired` today. */
  error: z.string(),
  providerStatus: z.string().optional(),
  /** The operator-facing sentence. This is the whole reason the body exists. */
  reason: z.string(),
});
export type HubRefusal = z.infer<typeof HubRefusal>;

/**
 * Turn a failed hub response into an error worth reading.
 *
 * `nodes list failed: 401` is undiagnosable from the operator's side — the same line
 * whether the clock skewed, the key is wrong, or their provider was retired last Tuesday.
 * Discarding the body the hub now sends would leave exactly the silence Phase 4 removes.
 *
 * Best-effort by construction: a 502 from a reverse proxy is HTML, and failing to parse it
 * must never replace the status code the caller needs to see. Never throws.
 */
export async function hubError(label: string, res: Response): Promise<Error> {
  try {
    const parsed = HubRefusal.safeParse(await res.json());
    if (parsed.success) {
      const status = parsed.data.providerStatus ? ` (provider ${parsed.data.providerStatus})` : "";
      return new Error(`${label} refused: ${res.status}${status} — ${parsed.data.reason}`);
    }
  } catch {
    // Not JSON, or no body at all. Fall through to the status line.
  }
  return new Error(`${label} failed: ${res.status}`);
}
