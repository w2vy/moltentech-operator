# @moltentech/protocol

Shared **wire contracts** for the MoltenTech multi-provider marketplace — the
single source of truth for the JSON exchanged between the three components:

| Component | Repo (planned) | Role | Trust |
|---|---|---|---|
| MT web app | `moltentech` (private) | storefront + system of record + job queue | the only inbound-facing leg |
| Operator **agent** | `moltentech-operator/agent` (public) | provisions local Proxmox | outbound-only; holds local Proxmox creds |
| Operator **Flux App** | `moltentech-operator/flux-app` (public) | manifest + stats + **payments** | inbound; holds the operator's restricted Stripe key (safe on ArcaneOS) |

Each schema is a [zod](https://zod.dev) object (runtime validation) with an
inferred TypeScript type. JSON Schema can be generated from these later for any
non-TS consumer.

## Messages

| # | Message | Direction | Auth |
|---|---|---|---|
| — | `ProviderManifest` | operator → published; **MT pulls** | ed25519 signature |
| 1 | `CheckoutInitRequest` / `Response` | MT → Flux App | MT-issued key |
| 2 | `PaymentEvent` | Flux App → MT | per-provider key |
| 3 | `Job` | MT → agent (**pull**) | per-provider key |
| 4 | `JobResult` | agent → MT | per-provider key |
| 5 | `ListingAssert` | agent → MT | per-provider key |
| 6 | `StatsSnapshot` | Flux App → published; **MT pulls** | none (public, signed manifest gates identity) |
| 7 | `ManageRequest` / `Response` | MT → Flux App | MT-issued key |

## Key design points (encoded here)

- **No Stripe Connect.** Each operator processes payments on its own standalone
  Stripe account via its Flux App. MT holds **no** operator Stripe creds.
- **Free trial → no refunds.** Subscriptions start with a 1–7 day trial; every
  failure path is a *cancel*, not a refund (`PaymentEvent` has no refund-on-signup
  path; the restricted key needs `Subscriptions: write`, never `Refunds`).
- **One price input.** The operator declares `priceCents` once; it flows through
  `ListingAssert` (MT mirror) and the Flux App's Stripe Price (actual charge);
  `CheckoutInitResponse.priceCents` lets MT confirm *charged == listed*.
- **`Job` carries no hypervisor creds** — the agent injects its own.
- **Idempotency** via `PaymentEvent.stripeEventId` and `CheckoutInitRequest.idempotencyKey`.

## Signing CLI (`mt-manifest`)

Operator tooling to produce a signed Provider Manifest (shares this package's
ed25519 + canonicalization, so it always verifies on MT's side):

```sh
npm install
npm run manifest keygen            # -> manifest-key.pem (KEEP SECRET) + prints pubkey
npm run manifest init              # -> manifest.body.json template (edit it)
npm run manifest sign --key manifest-key.pem --in manifest.body.json --out manifest.json
npm run manifest verify --in manifest.json
```

`sign` stamps `pubkey` (from the key) + a fresh `publishedAt`, schema-validates the
body, signs the canonical bytes, and self-verifies. Publish `manifest.json` at the
Flux App's `/.well-known/mt-provider.json`; the MT admin ingests that URL.

## Status

`v0.1.0` — contracts + signing CLI. Not yet: generated JSON Schema. Lives in the
`moltentech` repo for now; to be extracted to the public `moltentech-operator` repo.
