# Coupons and Loans

Two tabs on Flux Hub that give nodes away or move them: **Coupons** (offers you sign for
customers) and **Loans** (running one of your nodes on another operator's hardware for a while).

## Coupons

**Where:** Flux Hub → **Coupons** (`/operator/grants`). A Supporter sees this tab as **Claim a
node**: a Supporter only ever claims a node for its own wallet there.

Everything you issue is signed with your **owner wallet**. The hub stores the exact text you
signed, and your Coalition checks the signature again before it charges a card, so the hub alone
can never discount your sales.

### Two kinds

| | Coupon (with a code) | Free-node link (no code) |
|---|---|---|
| Customer uses it by | typing the code at checkout, by card or FLUX | opening the link and signing in |
| Price | your tier price less the discount | free |
| Uses | as many as you set | one |

### The form

- **Tier**: the tier the offer is for.
- **Recipient** (optional): a customer's sign-in ID or email. Blank means anyone with the code or link.
- **Code valid for (days)**: how long new customers can start a rental with it. Rentals already
  started keep their terms.
- **Coupon code**: what customers type, e.g. `HALFOFF30`. Blank makes a free-node link instead.
- **Discount (%)**: 1–100. 100 means free for the period.
- **For**: 30, 60 or 90 days, meaning **1, 2 or 3 calendar months**: the period ends on the same
  day of the month it started. Or **always**.
- **Then** (after the period): **full price**, **a smaller discount** (N % off from then on), or
  **end the rental**.
- **Uses**: total uses, card and FLUX together.
- **Once per customer**: a customer can use this code once, on either payment method.
- **First rental with you only**: only a customer who has never rented from you, on either
  payment method.

### What the customer pays

One rule for both payment methods: **a month costs the tier price × (1 − discount), rounded down
to the cent.** At checkout the customer clicks **Have a coupon code?**, types it and clicks
**Apply**, and sees the prices, e.g. *$3.50/mo for 3 months (50% off), then $7.00/mo*. Checkout
will not continue with a code typed but not applied.

**By card**
- The subscription is charged the coupon price. A 100 % coupon is a $0 item, and the card is still
  collected for later.
- **When the period ends with a new price** (full, or the smaller discount), the change needs
  **your signature**. It waits in **To sign → Signing Queue** on Flux Hub and on your Coalition
  console. You are reminded 7 days and 1 day before the renewal. If it is not signed by the
  renewal, the customer keeps the coupon price for that renewal and the change waits for the next
  one. The hub never applies an unsigned price change.
- **"End the rental"**: the subscription is set to cancel at the end of the last coupon period. No
  signature is needed, because nothing more is charged. If the customer clicks *Don't cancel* in
  Stripe's portal, the hub sets it to cancel again.

**By FLUX**
- The period starts when the 24-hour trial ends. Every FLUX payment is priced month by month: the
  coupon price for months that start inside the period, the after price for the rest.
- A 100 % coupon needs no payment: the rental runs through the trial plus the period.
- "End the rental": a payment that would run past the period end is refused, and the rental ends
  at the period end.

### Counting uses

A use is taken when the customer starts checkout, so two customers cannot both take the last use.
It is given back if the checkout is not completed: a card checkout after 24 hours, a FLUX trial
when it ends unpaid. **Withdraw** stops new uses; rentals already made keep their terms.

### What you need

- Card coupons: Coalition **0.9.0** or later; the after-period price change needs **0.10.0** and
  agent **0.11.83**. With an older Coalition the code box is hidden on card checkout (FLUX still
  works).
- A Stripe promotion code created in your Stripe dashboard is a different thing: those are not
  coupons in Flux Hub, and a Flux Hub coupon creates nothing in your Stripe account.

## Loans

**Where:** Flux Hub → **My Fleet → Loans** (`/operator/borrow`).

When your hardware is down, a loan runs one of your customers' nodes on another provider's idle
slot, paid in **credit hours** (one per hour). Your customer's rental and billing do not change.
When the loan ends, the node is rebuilt on your own slot.

The page shows:
1. **Your nodes on loan**: where each one runs, its status, until when, and the controls to end it.
2. **Borrowed onto your hardware**: other operators' nodes running on your slots. You earn your
   Foundation rate while they run. The borrower ends a loan, or it ends by itself at the date shown.
3. **Borrow a node**: the providers with idle slots (Supporters first), with your credit balance.

To move one particular node, use **Deploy elsewhere** on its row in My Fleet; it opens this page
narrowed to that node's tier.
