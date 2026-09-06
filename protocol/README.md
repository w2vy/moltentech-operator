# @moltentech/protocol

Shared **wire contracts** for the Flux Hub multi-provider marketplace — the
single source of truth for the JSON exchanged between the three components:

| Component | Repo (planned) | Role | Trust |
|---|---|---|---|
| FH web app | `moltentech` (private) | storefront + system of record + job queue | the only inbound-facing leg |
| Operator **agent** | `moltentech-operator/agent` (public) | provisions local Proxmox | outbound-only; holds local Proxmox creds |
| Operator **Coalition** | `moltentech-operator/coalition` (public) | manifest + stats + **payments** | inbound; holds the operator's restricted Stripe key (safe on ArcaneOS) |

Each schema is a [zod](https://zod.dev) object (runtime validation) with an
inferred TypeScript type. JSON Schema can be generated from these later for any
non-TS consumer.

## Messages

| # | Message | Direction | Auth |
|---|---|---|---|
| — | `ProviderManifest` | operator → published; **FH pulls** | ed25519 signature |
| 1 | `CheckoutInitRequest` / `Response` | FH → Coalition | FH-issued key |
| 2 | `PaymentEvent` | Coalition → FH | per-provider key |
| 3 | `Job` | FH → agent (**pull**) | per-provider key |
| 4 | `JobResult` | agent → FH | per-provider key |
| 5 | `ListingAssert` | agent → FH | per-provider key |
| 6 | `StatsSnapshot` | Coalition → published; **FH pulls** | none (public, signed manifest gates identity) |
| 7 | `ManageRequest` / `Response` | FH → Coalition | FH-issued key |

## Key design points (encoded here)

- **No Stripe Connect.** Each operator processes payments on its own standalone
  Stripe account via its Coalition. FH holds **no** operator Stripe creds.
- **Free trial → no refunds.** Subscriptions start with a 1–7 day trial; every
  failure path is a *cancel*, not a refund (`PaymentEvent` has no refund-on-signup
  path; the restricted key needs `Subscriptions: write`, never `Refunds`).
- **One price input.** The operator declares `priceCents` once; it flows through
  `ListingAssert` (FH mirror) and the Coalition's Stripe Price (actual charge);
  `CheckoutInitResponse.priceCents` lets FH confirm *charged == listed*.
- **`Job` carries no hypervisor creds** — the agent injects its own.
- **Idempotency** via `PaymentEvent.stripeEventId` and `CheckoutInitRequest.idempotencyKey`.

## Signing CLI (`fh-toolkit`)

Operator tooling to produce a signed Provider Manifest (shares this package's
ed25519 + canonicalization, so it always verifies on FH's side). Ships as the
published image **`ghcr.io/w2vy/fh-toolkit`** so operators need no source checkout
or Node — it's secret-free (your key is generated into the mounted workdir, never
baked in):

```sh
# A shell FUNCTION, not an alias: an alias does not expand as an argument to another
# command. The -i is required — without stdin, `init` prints one prompt and exits at EOF.
# `docker run` never re-pulls, so refresh the image every 48h (see the onboarding doc for
# the stamp-file version); --pull always is the one-liner alternative.
fh-toolkit() { docker run --rm -i --pull always -v "$PWD:/work" -u "$(id -u):$(id -g)" ghcr.io/w2vy/fh-toolkit "$@"; }
fh-toolkit keygen                                                       # -> manifest-key.pem (KEEP SECRET) + pubkey
fh-toolkit sign --key manifest-key.pem --from-config config.env --out manifest.json
fh-toolkit verify --in manifest.json

# Owner proof happens in the browser: paste manifest.json at /onboard and sign there.
# Flux Hub builds the {manifest, ownerSignature} wrapper itself.

fh-toolkit env  --from-config config.env --secrets secrets.env --manifest manifest.json --out env.json
```

Commands: `keygen` (ed25519 keypair); `init` (interview → the whole scaffold); `sign`
(canonical-sign the manifest — `--from-config config.env` is the current flow; `--in
manifest.body.json` still works); `doctor` (prove the files agree, and optionally the
live wiring); `verify`; and `env` (assemble the Coalition's Flux `env.json` = config +
secrets + embedded signed manifest). Run it with no arguments for an interactive
session. Owner proof is the `/onboard` web flow's job — you wallet-sign in the browser,
which turns FH's blind-TOFU pubkey pin into proven ownership, auto-accepts a later key
rotation from the same owner, and auto-issues your agent/coalition keys on a first
ingest. `env` takes either a bare manifest or an owner-signed wrapper and ships it
whole, so an owner signature you were handed still reaches FH. `sign` stamps `pubkey`
(from the key) + a fresh `publishedAt`, schema-validates, signs the canonical bytes,
and self-verifies. Publish `manifest.json` at the Coalition's
`/.well-known/mt-provider.json`; the FH admin ingests that URL.

From source instead (dev): `npm install`, then `npm run manifest <cmd>` in this package.

## Status

`v0.1.0` — contracts + signing CLI. Not yet: generated JSON Schema. Lives in the
`moltentech` repo for now; to be extracted to the public `moltentech-operator` repo.
