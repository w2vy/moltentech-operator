/**
 * Which Stripe MODE the operator's key belongs to, reported to MoltenTech on every
 * response (`X-Stripe-Livemode`, beside `X-Coalition-Version`) so the marketplace can
 * mark a listing that cannot take real money.
 *
 * Derived from the key the Coalition actually charges with, NOT declared anywhere — a
 * declared field would be a second copy of the truth, free to disagree with the key on
 * the very listing a customer is about to pay. Stripe's own prefixes carry the mode:
 * `sk_test_…`/`rk_test_…` vs `sk_live_…`/`rk_live_…`.
 *
 * `null` means "don't say" — no key at all (a supporter who sells nothing, or payments
 * disabled), or a prefix this doesn't recognise. MT renders unknown as nothing rather
 * than as "live": guessing live on an unreadable key is the one wrong answer, since it
 * would clear a test listing to look like it takes money.
 */
export function stripeLiveMode(secretKey?: string): boolean | null {
  if (!secretKey) return null;
  if (/^[sr]k_live_/.test(secretKey)) return true;
  if (/^[sr]k_test_/.test(secretKey)) return false;
  return null;
}
