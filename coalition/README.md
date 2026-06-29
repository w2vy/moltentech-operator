# @moltentech/operator-coalition

The operator's **inbound** leg, deployed on Flux (ArcaneOS). Stateless; holds the
operator's restricted Stripe key + webhook secret. Three jobs:

1. **Manifest** — serves the offline-signed `mt-provider.json` (MT pulls it).
2. **Stats** — publishes a `StatsSnapshot` at `/stats` (MT pulls it); the collector
   polls nodes' public apiPorts from an external vantage (hairpin-proof).
3. **Payments** — `/checkout` + `/manage` (called by MT with the MT-issued key) mint
   sessions / open the portal on the operator's Stripe; `/webhook` verifies Stripe
   events and **relays** them outbound to MT (`/api/agent/payment`). It only acks
   Stripe once MT accepts — Stripe's retry is the durable queue, so no DB is needed.

```
MT ──pull──▶ GET /.well-known/mt-provider.json , GET /stats
MT ──key───▶ POST /checkout , POST /manage
Stripe ────▶ POST /webhook ──relay(Bearer agentKey)──▶ MT /api/agent/payment
```

## Endpoints
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/.well-known/mt-provider.json` | none | signed manifest |
| GET | `/stats` | none | StatsSnapshot |
| POST | `/checkout` | `Bearer COALITION_KEY` | mint Checkout Session (trial) |
| POST | `/manage` | `Bearer COALITION_KEY` | billing portal / cancel |
| POST | `/webhook` | Stripe signature | verify + relay to MT |

## Run
```sh
npm install
PROVIDER_SLUG=my-op MT_BASE_URL=https://www.moltentech.us \
AGENT_KEY=<relay key (operator->MT)> COALITION_KEY=<MT-issued key (MT->operator)> \
STRIPE_SECRET_KEY=rk_live_<restricted> STRIPE_WEBHOOK_SECRET=whsec_... \
TIER_PRICES_JSON='{"nimbus":2200,"cumulus":700}' TRIAL_DAYS=1 \
MANIFEST_PATH=./manifest.json npm start
```

The **restricted** Stripe key needs only: Checkout Sessions (write), Prices
(read+write for materialization), Subscriptions (write), Billing Portal (write).
**No Refunds / Balance / Payouts** — the trial model means every failure is a
cancel, not a refund.

## Status
`v0.1.0` — manifest/stats serving + payments (checkout/manage/webhook→relay)
complete and verified with an injected Stripe + mock MT. Remaining integration
point: the real external **stats collector** (Flux-API polling). Sign the manifest
with `@moltentech/protocol/signing` (operator CLI). To be extracted to the public
`moltentech-operator` repo.
