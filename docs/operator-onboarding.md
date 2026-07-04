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
- A trusted, always-on host with **Docker + Node** and LAN line-of-sight to Proxmox
  `:8006` and outbound 443 (a sidecar VM/LXC is the clean default).
- A **Flux** deployment target for the Coalition (a small container; stateless).
- A **Stripe** account (you are merchant of record).
- Public reachability for your **Coalition URL** (Flux gives you a stable HTTPS URL)
  and your nodes' public `apiPort`s (so MT can pull stats from outside your LAN).

---

## Step 1 — Generate your signing key + manifest

From the `protocol/` package:

```sh
npm install
npm run manifest keygen        # writes manifest-key.pem (KEEP SECRET, 0600) + prints your pubkey
npm run manifest init          # writes manifest.body.json — edit it (see below)
```

Edit `manifest.body.json`:
- `provider.slug` — your desired identifier (lowercase-kebab; MT confirms it).
- `provider.name` / `location` / `description` / `contact`.
- `coalitionUrl` — the stable HTTPS base URL your Coalition will serve at (Step 3).
- `tiers` — the tiers you offer with `capacity` (max nodes) and `storagePool`.
- `trialDays` (1–7), `serviceFlags` (delegation/whiteLabel/SLA/languages/…).

Then sign it:

```sh
npm run manifest sign --key manifest-key.pem --in manifest.body.json --out manifest.json
npm run manifest verify --in manifest.json     # sanity: "OK — signature valid"
```

`manifest.json` is what your Coalition publishes. **Price is NOT in the manifest** —
you declare it in the agent's listing (Step 4), where you can change it without
re-signing.

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

## Step 3 — Deploy the Coalition (publish the manifest)

The Coalition needs the MT-issued keys (Step 5) to do payments, but it can serve your
manifest before then. Deploy it now with placeholder values for the keys you don't
have yet, so MT can fetch your manifest; you'll set the real keys and redeploy in
Step 5.

Place `manifest.json` where `MANIFEST_PATH` points. Environment:

```sh
PROVIDER_SLUG=your-slug
MT_BASE_URL=https://www.moltentech.us
MANIFEST_PATH=./manifest.json
TIER_PRICES_JSON='{"nimbus":2200,"cumulus":700}'   # cents/mo, per tier (>= MT floor)
TRIAL_DAYS=1
STRIPE_SECRET_KEY=rk_live_<restricted>
STRIPE_WEBHOOK_SECRET=whsec_<from step 2>
AGENT_KEY=placeholder            # real value in Step 5
COALITION_KEY=placeholder          # real value in Step 5
# npm start
```

Confirm `https://<your-coalition>/.well-known/mt-provider.json` returns your signed
manifest and `/stats` responds.

---

## Step 4 — Configure the Agent

Deploy the agent on/beside Proxmox. Environment:

```sh
MT_BASE_URL=https://www.moltentech.us
PROVIDER_SLUG=your-slug
AGENT_KEY=placeholder            # real value in Step 5
PROXMOX_URL=https://127.0.0.1:8006
PROXMOX_TOKEN_ID='root@pam!moltentech'
PROXMOX_TOKEN_SECRET=<secret>
# local YAML defaults (your Proxmox):
PROXMOX_NETWORK=vmbr0
PROXMOX_STORAGE_IMAGES=local-lvm
PROXMOX_STORAGE_ISO=local
ARCANE_ISO=<your ArcaneOS ISO name>
# your offered price/capacity (re-asserted to MT on a heartbeat):
AGENT_LISTING_JSON='[{"tier":"nimbus","priceCents":2200,"capacity":8,"availableSlots":8}]'
```

Run with `AGENT_DRY_RUN=1` first to validate connectivity/auth to MT without
touching Proxmox. (`priceCents` must be ≥ the MT platform floor and should match
`TIER_PRICES_JSON` in the Coalition.)

---

## Step 5 — Onboarding handshake with MoltenTech

1. **Send MT your manifest URL** (`https://<your-coalition>/.well-known/mt-provider.json`).
2. MT admin **ingests** it (verifies your signature, creates your provider as
   `pending`) and **issues two keys**, shown once:
   - **`agentKey`** — your agent + Coalition use it to talk *to* MT.
   - **`coalitionKey`** — MT uses it to call *your* Coalition (`/checkout`, `/manage`).
3. Set the real keys and **redeploy**:
   - **Coalition**: `AGENT_KEY=<agentKey>`, `COALITION_KEY=<coalitionKey>`.
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

- **Change price/capacity**: update `AGENT_LISTING_JSON` (and `TIER_PRICES_JSON` to
  match) and restart the agent — it re-asserts; MT converges. No re-signing.
- **Change identity/tiers offered**: edit + re-`sign` the manifest, redeploy the Flux
  App; MT re-pulls.
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
