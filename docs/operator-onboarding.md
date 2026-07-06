# MoltenTech Operator Onboarding

This is the runbook to join the MoltenTech marketplace as an **operator**: you host
Flux nodes on your own Proxmox, customers rent them through MoltenTech (MT), and they
**pay you directly** on your own Stripe account. MT never holds your Proxmox or Stripe
credentials and never opens an inbound connection to you.

## What you run

Two small components (both in the `moltentech-operator` repo):

| Component | Where it runs | Direction | Holds |
|---|---|---|---|
| **Agent** | on/beside your Proxmox (Docker + LAN reach to `:8006`) | **outbound only** | your Proxmox API token |
| **Coalition** | on Flux (ArcaneOS) | **inbound** (manifest/stats/payments) | your restricted Stripe key + webhook secret |

```
                 ┌────────────── MoltenTech (the only inbound-facing side) ──────────────┐
customer ─buy──▶ │ storefront → calls your Coalition /checkout → Stripe session           │
                 │ Stripe webhook → your Coalition → relays to MT /api/agent/payment       │
                 │ MT enqueues a job ──▶ your AGENT pulls it ──▶ provisions YOUR Proxmox   │
                 │ MT pulls your Coalition /stats + /.well-known/mt-provider.json           │
                 └───────────────────────────────────────────────────────────────────────┘
```

## Prerequisites

- **Proxmox** host(s) with the `arcane-mage` CLI available to the agent, an API
  **token** (not root password), and the ArcaneOS ISO present in your ISO storage.
- A trusted, always-on host with **Docker** and LAN line-of-sight to Proxmox `:8006`
  and outbound 443 (a sidecar VM/LXC is the clean default). The agent image bundles
  Node + Python + `arcane-mage`, so nothing else is needed on the host.
- A **Flux** deployment target for the Coalition (a small container; stateless).
- A **Stripe** account (you are merchant of record).
- Public reachability for your **Coalition URL** (Flux gives you a stable HTTPS URL)
  and your nodes' public `apiPort`s (so MT can pull stats from outside your LAN).

---

## Step 1 — Generate your signing key + config

From the `protocol/` package:

```sh
npm install
npm run manifest keygen        # writes manifest-key.pem (KEEP SECRET, 0600) + prints your pubkey
```

Create a **`config.env`** — your single **non-secret** source of truth. It drives *both*
the signed manifest and the Coalition's runtime config, so the two can never drift:

```sh
PROVIDER_SLUG=your-slug
PROVIDER_NAME=Your Operator Name
PROVIDER_LOCATION=City, Country
PROVIDER_CONTACT=ops@example.com
MT_BASE_URL=https://www.moltentech.us
COALITION_URL=https://<your-coalition>          # the stable HTTPS URL from Step 3
OWNER_ADDRESS=<your owner ZelID>                 # who the console authorizes actions for
MT_PUBKEY=<MT ed25519 pubkey, from MT /api/mt-pubkey>
TIERS_JSON=[{"tier":"nimbus","capacity":8,"storagePool":"local-lvm","priceCents":2200}]
TRIAL_DAYS=1
MANUAL_APPROVAL=false
```

Sign the manifest from it:

```sh
npm run manifest sign --key manifest-key.pem --from-config config.env --out manifest.json
npm run manifest verify --in manifest.json     # sanity: "OK — signature valid"
```

`manifest.json` is what your Coalition publishes. **Price is NOT in the manifest** —
`priceCents` in `TIERS_JSON` feeds runtime pricing only (Step 3) and the agent listing
(Step 4), so you change price without re-signing.

---

## Step 2 — Stripe setup

1. Create a **restricted API key** (Stripe Dashboard → Developers → API keys →
   Create restricted key). Grant **only**:
   - Checkout Sessions: **Write**
   - Products: **Write**, Prices: **Read + Write** (the Coalition materializes your
     per-tier Price from the price you declare)
   - Subscriptions: **Write**
   - Billing Portal: **Write**

   Do **not** grant Refunds, Balance, or Payouts. The free-trial model means every
   failure path is a *cancel*, never a refund — the key never needs to move money.
   It's safe on ArcaneOS (the hosting node can't read it), but least privilege is
   good hygiene.

2. Create a **webhook endpoint** pointing at `https://<your-coalition>/webhook`,
   subscribed to: `customer.subscription.created`, `customer.subscription.deleted`,
   `invoice.payment_succeeded`, `invoice.payment_failed`, `charge.refunded`.
   Copy its **signing secret** (`whsec_…`).

---

## Step 3 — Deploy the Coalition on Flux (publish the manifest)

The Coalition runs as a **published Docker image** (`w2vy/coalition:0.1.0`) deployed as a
Flux App. Config, secrets, and your signed manifest are all supplied as **Flux environment
variables** — nothing to mount. It can serve your manifest before you have the MT-issued
keys (Step 5): deploy now with placeholder `AGENT_KEY`/`COALITION_KEY`; set the real values
in Step 5 (a **free** env re-import).

**1. Assemble the env.** Alongside `config.env` keep a private **`secrets.env`** (never
commit) — your Stripe key + webhook secret + a session secret, and the MT keys
(placeholder until Step 5):

```sh
# secrets.env
STRIPE_SECRET_KEY=rk_live_<restricted>
STRIPE_WEBHOOK_SECRET=whsec_<from step 2>
SESSION_SECRET=<openssl rand -hex 32>            # signs the console login cookie
AGENT_KEY=placeholder                            # real value in Step 5
COALITION_KEY=placeholder                        # real value in Step 5
```

Then build the Flux import blob from config + secrets + your signed manifest:

```sh
npm run manifest env --from-config config.env --secrets secrets.env \
  --manifest manifest.json --out env.json
```

`env.json` is a JSON array of `"KEY=value"`. It derives `TIER_PRICES_JSON` from your tiers
and embeds the signed manifest as `MANIFEST_JSON` (verifying the signature first). **It
contains secrets — do not commit it.**

**2. Register the Flux App:** Docker image `w2vy/coalition:0.1.0`, container port **8088**,
then paste `env.json` into the app's **Environment Variables → Import** (JSON array).

**3. Verify:** `https://<your-coalition>/health` → `{"ok":true,"provider":"…","coalitionVersion":"…"}`
and `/.well-known/mt-provider.json` returns your signed manifest.

Changing env later (rotate a secret, change tiers, re-sign the manifest) is just a **free
re-import** of a fresh `env.json` — regenerate it and paste it in; no redeploy transaction.

---

## Step 4 — Run the Agent

The agent is the published image **`w2vy/mt-agent`**. It runs on a trusted, always-on host
**beside your Proxmox** (a sidecar VM/LXC with Docker + LAN reach to `:8006`) — **not** on
Flux. It is outbound-only (no ports) and holds your Proxmox token + manifest key, so it must
live on infrastructure you control. (Image bundles Python + `arcane-mage`, so there is
nothing to build.)

Put your config in a private **`.env.operator`** (never commit):

```sh
MT_BASE_URL=https://www.moltentech.us
PROVIDER_SLUG=your-slug
AGENT_KEY=placeholder            # real value in Step 5
# Local Proxmox — creds NEVER leave your host. Use an address the CONTAINER can reach:
# your Proxmox LAN IP (not 127.0.0.1, which is the container's own loopback), or run with
# `--network host` if the agent runs on the Proxmox host itself.
PROXMOX_URL=https://<proxmox-lan-ip>:8006
PROXMOX_TOKEN_ID='root@pam!moltentech'
PROXMOX_TOKEN_SECRET=<secret>
PROXMOX_NETWORK=vmbr0
PROXMOX_STORAGE_IMAGES=local-lvm
PROXMOX_STORAGE_ISO=local
ARCANE_ISO=<your ArcaneOS ISO name>
# Offered price/capacity (re-asserted to MT each heartbeat):
AGENT_LISTING_JSON='[{"tier":"nimbus","priceCents":2200,"capacity":8,"availableSlots":8}]'
```

Validate connectivity/auth to MT first, **without touching Proxmox**:

```sh
docker run --rm --env-file .env.operator -e AGENT_DRY_RUN=1 w2vy/mt-agent:latest
# expect: "provider=… mt=… dryRun=true …" then a poll to MT (a 401 until your Step 5 keys)
```

Then run it for real (long-running, auto-restart):

```sh
docker run -d --name mt-agent --restart unless-stopped --env-file .env.operator w2vy/mt-agent:latest
```

(Or use `docker-compose.operator.yml` with `image: w2vy/mt-agent` instead of `build:`.)
`priceCents` must be ≥ the MT platform floor and should match `TIER_PRICES_JSON` in the
Coalition. For the manifest-signed courier + owner authorization, also set `MANIFEST_KEY`,
`OWNER_ADDRESS`, and `COALITION_URL` — see **Step 7**.

---

## Step 5 — Onboarding handshake with MoltenTech

1. **Send MT your manifest URL** (`https://<your-coalition>/.well-known/mt-provider.json`).
2. MT admin **ingests** it (verifies your signature, creates your provider as
   `pending`) and **issues two keys**, shown once:
   - **`agentKey`** — your agent + Coalition use it to talk *to* MT.
   - **`coalitionKey`** — MT uses it to call *your* Coalition (`/checkout`, `/manage`).
3. Set the real keys:
   - **Coalition**: put `AGENT_KEY=<agentKey>` + `COALITION_KEY=<coalitionKey>` in
     `secrets.env`, re-run `npm run manifest env …`, and **re-import `env.json`** into the
     Flux App (free — no redeploy tx).
   - **Agent**: `AGENT_KEY=<agentKey>` (remove `AGENT_DRY_RUN` once Proxmox is ready).
4. MT admin **activates** your provider → your cards go live on `/providers`.

---

## Step 6 — Declare your inventory (no DB hand-edits)

Your agent-managed hosts and slots are **declared by you**, not inserted into MT's
database by an admin. Write a local `inventory.json` and point the agent at it:

```sh
AGENT_INVENTORY_PATH=/data/inventory.json
```

```json
[
  {
    "name": "pve25-lab",
    "nodeName": "pve25",
    "apiUrl": "https://pve25:8006",
    "slots": [
      { "vmName": "mt-you-n1", "tier": "nimbus", "lanIp": "192.168.1.51",
        "ipAddress": "203.0.113.51", "gateway": "192.168.1.1", "apiPort": 16197,
        "storagePool": "local-lvm" }
    ]
  }
]
```

(`name` is the globally-unique host label = `ProxmoxHost.name`, distinct from
`nodeName`. Omit optional fields like `vlan`/`rateLimit` rather than setting them
`null`. `dns1`/`dns2` default to `8.8.8.8`/`1.1.1.1` if omitted.)

The agent asserts this to MT (`PUT /api/agent/inventory`) on startup and each
heartbeat, **provider-scoped**: MT upserts your `ProxmoxHost`/`Slot` rows and never
touches another operator's inventory, never hard-deletes a rented slot. Because the
agent **re-reads the file every heartbeat**, edits apply without a restart. (Alt:
inline `AGENT_INVENTORY_JSON`; absent = don't declare.)

## Step 7 — The operator console (authorize deletes/reprovisions)

Owner authorization for privileged actions (delete / reprovision / move) is done in
**your own** Coalition console — MT never prompts for it. Turn the courier on:

```sh
# agent (needs MANIFEST_KEY + OWNER_ADDRESS):
COALITION_URL=https://<your-coalition>
```

Flow, all key-holders outbound-only:

1. A customer cancels → MT marks the slot `pending_delete`.
2. Your **agent** fetches the pending list (`GET /api/agent/pending-auth`, signed) and
   **pushes it to your Coalition console**.
3. You open `https://<your-coalition>/console`, click the pending action, and **sign it
   in your wallet** (SSP in-browser, or "Sign with Zelcore" — the deep link posts the
   signature back automatically). The console verifies the signature recovers to
   `OWNER_ADDRESS` before queueing it — that per-action signature **is** the login.
4. Your agent **polls the console**, re-verifies the signature locally, and relays it to
   MT (`POST /api/agent/authorize`) → MT enqueues the job → the agent executes it.

The Coalition holds **no keys** and never calls MT — it's a UI + signature courier. The
manifest key (agent↔console auth) stays on the agent; the owner key stays in your
wallet. Wrong-owner, expired, and replayed signatures are refused at both the console
and the agent.

---

## Key reference (which secret lives where)

| Secret | Generated by | Lives | Shared with |
|---|---|---|---|
| `manifest-key.pem` | you (keygen) | your machine only | **nobody** |
| manifest `pubkey` | derived | in the manifest | public |
| `agentKey` | MT (issue keys) | agent **and** Coalition env | you (once) |
| `coalitionKey` | MT (issue keys) | Coalition env | you (once) |
| Stripe restricted key | you (Stripe) | Coalition env | nobody |
| Stripe webhook secret | you (Stripe) | Coalition env | nobody |
| Proxmox API token | you (Proxmox) | agent env | nobody |

MT stores only a **hash** of `agentKey` and an **encrypted** copy of `coalitionKey`.
It stores **none** of your Stripe or Proxmox credentials.

---

## Verify it works

- **Manifest**: MT admin shows your provider with the right tiers, `Coalition URL`,
  and freshness once it pulls stats/listing.
- **Listing**: within a minute the agent's heartbeat sets your price/capacity at MT
  (admin → Providers shows `lastAsserted`).
- **Stats**: MT pulls `/stats`; benchmarks/uptime appear on your card.
- **Checkout (test)**: with Stripe in test mode, rent one of your tiers from
  `/providers` → you get a Stripe Checkout (your account) with a trial → MT records a
  rental → your agent provisions the node → result flows back.

## Ongoing operations

- **Change price/capacity**: update the agent's `AGENT_LISTING_JSON` and restart it, and
  update `priceCents` in `config.env`'s `TIERS_JSON` → re-run `manifest env` → re-import
  `env.json` (free) so the Coalition's `TIER_PRICES_JSON` matches. No re-signing.
- **Change identity/tiers offered**: edit `config.env`, re-`sign` the manifest, re-run
  `manifest env`, and re-import `env.json` (free); MT re-pulls.
- **Staleness**: if MT stops seeing fresh stats *and* listing past the TTL, your
  provider auto-hides from the marketplace (data retained) and auto-re-lists on the
  next fresh update — so keep the agent and Coalition running.
- **Rotate keys**: MT admin re-issues `agentKey`/`coalitionKey` (old ones stop working);
  update both components. Rotate your Stripe restricted key in the Stripe dashboard.
- **Customer cancel/refund**: cancellation is free during the trial; afterward you are
  merchant of record — refunds/disputes are handled in your Stripe dashboard.

## Trust model (why this is safe)

- You hold **all** your own secrets; MT holds none of them. The agent is outbound-only
  with no inbound ports. The Coalition's only secrets are a restricted Stripe key +
  webhook secret, and ArcaneOS prevents the hosting node from reading them.
- Jobs MT sends your agent carry slot/network params + the customer's Flux identity
  key over TLS, but **never** Proxmox credentials — the agent injects its own.
- Collateral is a wallet UTXO, safe on any host; the residual risk (node identity-key
  exposure, uptime) is yours to manage and is reflected in your card's stats + reviews.
