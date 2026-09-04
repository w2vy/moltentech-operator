import type { KeyObject } from "node:crypto";
import {
  MAX_CONCURRENT_PER_PAIR,
  SCHEMA_VERSION,
  type InventoryHost,
  type LoanOffer,
  type LoanOfferDeclaration,
  type SignedLoanOffer,
} from "@moltentech/protocol";
import { loanOfferNonce, signLoanOffer } from "@moltentech/protocol/loan-signing";

/**
 * §0.4 steps 1–2 — the lender operator declares a slot loanable, and their agent turns that
 * declaration into a signed `LoanOffer`.
 *
 * The split matters. The operator writes down only what they actually hold: which slot, who may
 * borrow it, for how long, until when. Everything derivable — their own slug, the slot's tier,
 * the schema version, the nonce — the agent fills in, because every derivable field an operator
 * retypes is a field they can get wrong, and a wrong tier or lender slug inside a SIGNED record
 * is not a typo, it is a bad contract that verifies.
 *
 * ⛔ Nothing here provisions, deletes, or talks to the hub. It reads a file and produces records.
 */

/** Why a declaration did not become an offer. Each is something the operator must fix. */
export type OfferRefusal =
  /** The slot is not in this agent's `inventory.json` — you cannot lend hardware you do not declare. */
  | "slot-not-in-inventory"
  /** `borrowerSlug` is this operator's own slug. Lending to yourself is not a loan. */
  | "self-borrow"
  /** `offerExpiresAt` has already passed — the offer is dead on arrival. */
  | "offer-expired"
  /** Two declarations share a (borrower, revision) — which one a request answers is ambiguous. */
  | "duplicate-revision"
  /** `maxConcurrent` above the platform ceiling. */
  | "over-concurrency-ceiling";

export type OfferBuildResult = {
  offers: LoanOffer[];
  refused: Array<{ declaration: LoanOfferDeclaration; reason: OfferRefusal }>;
};

/**
 * Build offers from declarations, refusing the ones that cannot become a sound contract.
 *
 * Pure — inventory and the clock come in as arguments — so every fence below is testable without
 * a hypervisor, a key, or a hub.
 *
 * The fences, and what each one prevents:
 *
 * 1. **The slot must be in inventory.** `inventory.json` is what this operator has told the hub
 *    they own; offering anything else would sign a promise about hardware the agent does not
 *    manage and could not honour. It is also where the TIER comes from, so an offer can never
 *    advertise a tier that disagrees with the slot's own declaration.
 * 2. **No self-borrow.** A loan moves a node between two operators (§3a). Same slug on both
 *    sides is a misconfiguration, and it would produce a record whose two halves are the same
 *    party.
 * 3. **The offer must not already have expired.** Signing a dead offer costs nothing but hands
 *    the operator a blob that can never be accepted, with no clue why.
 * 4. **One (borrower, revision) per offer set.** A request names its offer by revision (§7 step
 *    3); two offers sharing one would make "which offer did this answer" unanswerable, and the
 *    scan would resolve it by iteration order.
 * 5. **`maxConcurrent` within the ceiling.** Enforced here as well as in the schema, because the
 *    default is applied here and a default is exactly where a ceiling gets quietly skipped.
 *
 * Refusals are RETURNED, not thrown: one bad declaration must not cost the operator the offers
 * that are fine, and the caller logs each one by name.
 */
export function buildLoanOffers(
  declarations: LoanOfferDeclaration[],
  inventory: InventoryHost[],
  lenderSlug: string,
  now: Date,
  maxConcurrentCeiling = 2
): OfferBuildResult {
  const offers: LoanOffer[] = [];
  const refused: OfferBuildResult["refused"] = [];

  // (nodeName, vmName) -> tier, straight off the operator's own inventory.
  const tiers = new Map<string, string>();
  for (const host of inventory) {
    for (const slot of host.slots) {
      tiers.set(`${host.nodeName}/${slot.vmName}`, slot.tier);
    }
  }

  const seen = new Set<string>();

  for (const d of declarations) {
    const key = `${d.borrowerSlug}#${d.revision}`;
    if (seen.has(key)) {
      refused.push({ declaration: d, reason: "duplicate-revision" });
      continue;
    }

    if (d.borrowerSlug === lenderSlug) {
      refused.push({ declaration: d, reason: "self-borrow" });
      continue;
    }

    const tier = tiers.get(`${d.nodeName}/${d.vmName}`);
    if (!tier) {
      refused.push({ declaration: d, reason: "slot-not-in-inventory" });
      continue;
    }

    if (new Date(d.offerExpiresAt).getTime() <= now.getTime()) {
      refused.push({ declaration: d, reason: "offer-expired" });
      continue;
    }

    const maxConcurrent = d.maxConcurrent ?? MAX_CONCURRENT_PER_PAIR;
    if (maxConcurrent > maxConcurrentCeiling) {
      refused.push({ declaration: d, reason: "over-concurrency-ceiling" });
      continue;
    }

    // Only mark the pair used once the declaration has actually produced an offer, so a
    // refusal does not shadow a later good declaration that legitimately reuses the revision.
    seen.add(key);

    const body = {
      schemaVersion: SCHEMA_VERSION,
      revision: d.revision,
      lenderSlug,
      borrowerSlug: d.borrowerSlug,
      borrowerPubkey: d.borrowerPubkey,
      slots: [{ vmName: d.vmName, nodeName: d.nodeName, tier }],
      maxDurationHours: d.maxDurationHours,
      maxConcurrent,
      offerExpiresAt: d.offerExpiresAt,
      issuedAt: d.issuedAt,
    };
    offers.push({ ...body, nonce: loanOfferNonce(body) } as LoanOffer);
  }

  return { offers, refused };
}

/**
 * Sign each offer with the lender's own agent key — the record as it travels to the borrower.
 *
 * Returns [] when no key is configured rather than throwing. An operator running the legacy
 * `AGENT_KEY` bearer has no manifest key to sign with, and that must degrade to "you cannot make
 * offers yet", never to a crashed agent: the loan feature is additive and must not be able to
 * take down provisioning for an operator who does not use it.
 *
 * ⚠️ The lender's own scan does NOT consume these. It reads the UNSIGNED offers from the same
 * build, because a local file is trusted for being local (§7 step 1). Signing is for the copy
 * that leaves the box.
 */
export function signLoanOffers(offers: LoanOffer[], key?: KeyObject): SignedLoanOffer[] {
  if (!key) return [];
  return offers.map((o) => signLoanOffer(o, key));
}
