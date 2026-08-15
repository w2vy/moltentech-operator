import { isPrivilegedAction, type Job } from "@moltentech/protocol";
import { verifyOwnerAuth } from "@moltentech/protocol/wallet";
import type { AgentConfig } from "./config";

/**
 * Owner-authorization gate (Phase C). Privileged actions (delete/reprovision/move)
 * only run with the node owner's Flux-wallet signature, verified against the
 * operator's SELF-PINNED `OWNER_ADDRESS` — so a compromised MT that merely relays
 * a job can't move or delete a node. Enforcement is opt-in: with no `ownerAddress`
 * configured the agent keeps pre-cutover behavior (runs privileged jobs). Provision
 * (a paid, customer-initiated create) is never gated.
 */

// Anti-replay nonce store (freshness half is the auth's own expiry). In-process, so
// a restart forgets consumed nonces — acceptable given the short expiry window and
// per-operator scope; mirrors the request-envelope nonce store.
const seenNonces = new Map<string, number>(); // nonce -> expiry (ms epoch)

function rememberNonce(nonce: string, expiresAtMs: number): boolean {
  const now = Date.now();
  for (const [n, exp] of seenNonces) if (exp <= now) seenNonces.delete(n);
  if (seenNonces.has(nonce)) return false;
  seenNonces.set(nonce, expiresAtMs);
  return true;
}

export type OwnerAuthDecision = { ok: true } | { ok: false; reason: string };

/**
 * Is this a `delete` of a VM marked as Flux-Hub-destroyable?
 *
 * 🔒 The security argument rests on ONE property: this reads `job.slot.vmName`, the exact field
 * `deprovision()` passes to `arcane-mage --vm-name` (`executor.ts`). Gate and executor must name
 * the same object, or a job could be admitted on one name and destroy another — at which point the
 * marking proves nothing. **If the executor's argument ever changes, change this with it.**
 *
 * Scoped to `delete` deliberately. `reprovision` and `move` stay gated unconditionally: a naming
 * convention must never become a general privilege escalation, and relabelling a running node
 * requires `reprovision`, which is what keeps a mislabelled VM from being manufactured after the
 * fact.
 *
 * `startsWith`, not `includes` — `mt-fh-187-c3` is a customer VM whose name merely contains the
 * prefix, and must stay gated.
 */
function isFoundationDelete(job: Job, cfg: AgentConfig): boolean {
  if (job.action !== "delete") return false;
  const prefix = cfg.foundationVmPrefix;
  if (!prefix) return false; // operator disabled the exemption
  const vmName = job.slot?.vmName;
  if (typeof vmName !== "string" || vmName.length <= prefix.length) return false;
  return vmName.toLowerCase().startsWith(prefix);
}

/**
 * Decide whether a job may execute under the owner-auth policy. Cross-checks the
 * signed claim binds to THIS job (so a valid auth for one node can't authorize
 * another), verifies the signature/expiry against the pinned owner, and burns the
 * nonce (only after a good signature, so bad sigs can't evict a live nonce).
 */
export function checkOwnerAuth(
  job: Job,
  cfg: AgentConfig,
  opts?: { now?: number }
): OwnerAuthDecision {
  if (!isPrivilegedAction(job.action)) return { ok: true };
  if (!cfg.ownerAddress) return { ok: true }; // enforcement not enabled yet

  // Foundation eviction: machine-initiated, so no human exists to sign it. Permitted only for a
  // `delete` whose target VM carries the reserved prefix — see isFoundationDelete().
  if (isFoundationDelete(job, cfg)) return { ok: true };

  const auth = job.ownerAuth;
  if (!auth) return { ok: false, reason: "missing owner authorization" };
  if (
    auth.action !== job.action ||
    auth.providerSlug !== job.providerSlug ||
    auth.vmName !== job.slot.vmName ||
    auth.nodeName !== job.slot.nodeName
  ) {
    return { ok: false, reason: "authorization does not bind to this job" };
  }

  const verified = verifyOwnerAuth(auth, cfg.ownerAddress, opts);
  if (!verified.ok) return verified;

  if (!rememberNonce(auth.nonce, Date.parse(auth.expiresAt))) {
    return { ok: false, reason: "owner authorization already used (replay)" };
  }
  return { ok: true };
}
