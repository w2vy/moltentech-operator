# @moltentech/protocol

Shared **wire contracts** for the MoltenTech multi-provider marketplace — the
single source of truth for the JSON exchanged between the three components:

| Component | Repo (planned) | Role | Trust |
|---|---|---|---|
| MT web app | `moltentech` (private) | storefront + system of record + job queue | the only inbound-facing leg |
| Operator **agent** | `moltentech-operator/agent` (public) | provisions local Proxmox | outbound-only; holds local Proxmox creds |
| Operator **Coalition** | `moltentech-operator/coalition` (public) | manifest + stats + **payments** | inbound; holds the operator's restricted Stripe key (safe on ArcaneOS) |

Each schema is a [zod](https://zod.dev) object (runtime validation) with an
inferred TypeScript type. JSON Schema can be generated from these later for any
non-TS consumer.

## Messages

| # | Message | Direction | Auth |
|---|---|---|---|
| — | `ProviderManifest` | operator → published; **MT pulls** | ed25519 signature |
| 1 | `CheckoutInitRequest` / `Response` | MT → Coalition | MT-issued key |
| 2 | `PaymentEvent` | Coalition → MT | per-provider key |
| 3 | `Job` | MT → agent (**pull**) | per-provider key |
| 4 | `JobResult` | agent → MT | per-provider key |
| 5 | `ListingAssert` | agent → MT | per-provider key |
| 6 | `StatsSnapshot` | Coalition → published; **MT pulls** | none (public, signed manifest gates identity) |
| 7 | `ManageRequest` / `Response` | MT → Coalition | MT-issued key |

## Key design points (encoded here)

- **No Stripe Connect.** Each operator processes payments on its own standalone
  Stripe account via its Coalition. MT holds **no** operator Stripe creds.
- **Free trial → no refunds.** Subscriptions start with a 1–7 day trial; every
  failure path is a *cancel*, not a refund (`PaymentEvent` has no refund-on-signup
  path; the restricted key needs `Subscriptions: write`, never `Refunds`).
- **One price input.** The operator declares `priceCents` once; it flows through
  `ListingAssert` (MT mirror) and the Coalition's Stripe Price (actual charge);
  `CheckoutInitResponse.priceCents` lets MT confirm *charged == listed*.
- **`Job` carries no hypervisor creds** — the agent injects its own.
- **Idempotency** via `PaymentEvent.stripeEventId` and `CheckoutInitRequest.idempotencyKey`.

## Signing CLI (`mt-manifest`)

Operator tooling to produce a signed Provider Manifest (shares this package's
ed25519 + canonicalization, so it always verifies on MT's side). Ships as the
published image **`ghcr.io/w2vy/mt-manifest`** so operators need no source checkout
or Node — it's secret-free (your key is generated into the mounted workdir, never
baked in):

```sh
alias mt-manifest='docker run --rm -v "$PWD:/work" -u "$(id -u):$(id -g)" ghcr.io/w2vy/mt-manifest'
mt-manifest keygen                                                       # -> manifest-key.pem (KEEP SECRET) + pubkey
mt-manifest sign --key manifest-key.pem --from-config config.env --out manifest.json
mt-manifest verify --in manifest.json

# Owner-authorize: prove you control config.env's OWNER_ADDRESS (two steps — the
# first prints the message + a Zelcore deep link, then you re-run with the signature)
mt-manifest authorize --in manifest.json
mt-manifest authorize --in manifest.json --signature <base64> --out signed-manifest.json

mt-manifest env  --from-config config.env --secrets secrets.env --manifest signed-manifest.json --out env.json
```

Commands: `keygen` (ed25519 keypair); `sign` (canonical-sign the manifest —
`--from-config config.env` is the current flow; legacy `init` + `--in
manifest.body.json` still work); `verify`; `authorize` (wallet-sign the manifest so
MT ingests it **owner-verified** — turns its blind-TOFU pubkey pin into proven
ownership, auto-accepts a later key rotation from the same owner, and auto-issues
your agent/coalition keys on a first ingest); and `env` (assemble the Coalition's
Flux `env.json` = config + secrets + embedded signed manifest). `env` takes either a
bare manifest or the `authorize` wrapper and ships it whole, so the owner signature
reaches MT. `sign` stamps `pubkey`
(from the key) + a fresh `publishedAt`, schema-validates, signs the canonical bytes,
and self-verifies. Publish `manifest.json` at the Coalition's
`/.well-known/mt-provider.json`; the MT admin ingests that URL.

From source instead (dev): `npm install`, then `npm run manifest <cmd>` in this package.

## Status

`v0.1.0` — contracts + signing CLI. Not yet: generated JSON Schema. Lives in the
`moltentech` repo for now; to be extracted to the public `moltentech-operator` repo.
