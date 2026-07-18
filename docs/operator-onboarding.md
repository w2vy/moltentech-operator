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

The signing tool is the published image **`ghcr.io/w2vy/mt-manifest`** — no source
checkout, no Node install. It's secret-free: your key is generated into the mounted
working directory, never baked into the image. Define a shorthand for it (persists for
this shell session; every `mt-manifest` command below reads/writes the **current
directory**, so run them all from the same folder):

```sh
alias mt-manifest='docker run --rm -v "$PWD:/work" -u "$(id -u):$(id -g)" ghcr.io/w2vy/mt-manifest'
mt-manifest keygen             # writes manifest-key.pem (KEEP SECRET, 0600) + prints your pubkey
```

Create a **`config.env`** — your single **non-secret** source of truth. It drives *both*
the signed manifest and the Coalition's runtime config, so the two can never drift:

> ⚠️ **Comments must be on their own line.** The parser only strips *full-line* `#`
> comments; a trailing `KEY=value   # note` keeps `value   # note` as the value. A
> stray inline comment on `COALITION_URL` breaks MT's ability to reach your Coalition.

```sh
PROVIDER_SLUG=your-slug
PROVIDER_NAME=Your Operator Name
PROVIDER_LOCATION=City, Country
PROVIDER_CONTACT=ops@example.com
MT_BASE_URL=https://www.moltentech.us
# COALITION_URL — the stable HTTPS URL your Coalition serves at (Step 3)
COALITION_URL=https://<your-coalition>
# OWNER_ADDRESS — the ZelID the console authorizes actions for
OWNER_ADDRESS=<your owner ZelID>
# MT_PUBKEY — optional; leave blank for now. Pin later from {MT_BASE_URL}/api/mt-pubkey
# once MT enables signing (503 until then). Only the Coalition consumes it.
MT_PUBKEY=
# HOSTS — the Proxmox hosts you attest, as a comma-separated list of ProxmoxHost.name.
# This is the owner-signed hardware list: MT rejects any inventory host not named here,
# so adding a machine later means re-signing the manifest (see "Ongoing operations").
HOSTS=pve-01,pve-02
# TIER_PRICES_JSON — runtime price in integer CENTS per tier. NOT in the signed manifest,
# so you can change price without re-signing.
TIER_PRICES_JSON={"cumulus":700,"nimbus":20000}
TRIAL_DAYS=1
MANUAL_APPROVAL=false
```

Sign the manifest from it:

```sh
mt-manifest sign --key manifest-key.pem --from-config config.env --out manifest.json
mt-manifest verify --in manifest.json          # sanity: "OK — signature valid"
```

`manifest.json` is what your Coalition publishes. **Price is NOT in the manifest** —
`TIER_PRICES_JSON` feeds runtime pricing only (Step 3) and the agent listing (Step 4), so
you change price without re-signing. What the manifest *does* carry is `HOSTS`: the
hardware you attest, owner-signed. Tiers and slot counts are not in the manifest either —
they derive from the inventory your agent asserts, constrained to the attested hosts.

---

## Step 2 — Stripe setup

1. Create a **restricted API key** (Stripe Dashboard → Developers → API keys →
   **Create restricted key**). This must be a *restricted* key (`rk_…`), **not** a
   standard secret key (`sk_…`) — a standard key can move money and read your whole
   account, which is exactly what the Coalition must never hold. To sandbox first,
   flip the dashboard to **Test mode** and mint an `rk_test_…`; the live `rk_live_…`
   is a separate key you create the same way once you go live. Grant **only**:
   - Checkout Sessions: **Write**
   - Products: **Write**, Prices: **Read + Write** (the Coalition materializes your
     per-tier Price from the price you declare)
   - Subscriptions: **Write**
   - Customer Portal: **Write** (Stripe renamed this from "Billing Portal" in the
     restricted-key permission list)

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

Same rule as `config.env`: **comments on their own line only** — a trailing comment
after `AGENT_KEY`/`COALITION_KEY` becomes part of the key and MT will reject it (401).

```sh
# secrets.env
STRIPE_SECRET_KEY=rk_live_<restricted>
STRIPE_WEBHOOK_SECRET=whsec_<from step 2>
# SESSION_SECRET — optional, local-only. Set = console view-gate on (wallet-login to
# view); blank = reads ungated. Node ACTIONS are wallet-signed either way.
SESSION_SECRET=<openssl rand -hex 32>
# AGENT_KEY / COALITION_KEY — set to "placeholder" now; paste the real values in Step 5.
AGENT_KEY=placeholder
COALITION_KEY=placeholder
```

Then build the Flux import blob from config + secrets + your signed manifest, reusing
the same `mt-manifest` shorthand from Step 1 (same shell / same directory):

```sh
mt-manifest env --from-config config.env --secrets secrets.env \
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
re-import** of a fresh `env.json` — regenerate it and paste it in, then use Flux's **Free
Deploy**.

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
ARCANE_ISO=<your ArcaneOS ISO name>   # auto-kept-current once you declare inventory (Step 6)
# Price + how many slots to offer for sale (re-asserted to MT each heartbeat).
# How much hardware you HAVE comes from your inventory, not from here.
AGENT_LISTING_JSON='[{"tier":"nimbus","priceCents":2200,"availableSlots":8}]'
```

Create a small **dedicated subdirectory** for `inventory.json` (Step 6) — `./agent-data/` —
and mount that *directory* (not the single file) read-only to `/data`, which is where
`AGENT_INVENTORY_PATH` resolves inside the container; without it, the agent fails at
startup with `ENOENT: inventory.json` the moment `AGENT_INVENTORY_PATH` is set.

```sh
mkdir -p agent-data && mv inventory.json agent-data/inventory.json   # once inventory.json exists (Step 6)
```

Mount the directory, not the file: a single-file bind mount pins the container to
that file's *inode*, and most editors save atomically via write-new-then-rename,
which detaches the mount from the file — edits on the host silently stop reaching the
container (no error, it just keeps serving stale content) until the container is
recreated. A directory mount doesn't have this problem — edits inside it, however
they're saved, are always visible on the next read. Keep `data/` scoped to only
`inventory.json` — `.env.operator` and anything else you keep alongside it (e.g.
`manifest-key.pem`, if you sign manifests on this same host) have no business being
readable inside the container:

Validate connectivity/auth to MT first, **without touching Proxmox**:

```sh
docker run --rm --env-file .env.operator -v "$PWD/agent-data:/data:ro" -e AGENT_DRY_RUN=1 w2vy/mt-agent:latest
# expect: "provider=… mt=… dryRun=true …" then a poll to MT (a 401 until your Step 5 keys)
```

Then run it for real (long-running, auto-restart):

```sh
docker run -d --name mt-agent --restart unless-stopped --env-file .env.operator -v "$PWD/agent-data:/data:ro" w2vy/mt-agent:latest
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
     Flux App via **Free Deploy**.
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
agent **re-reads the file every heartbeat**, edits apply without a restart — **only
if you mounted `./agent-data` as a directory** (Step 4); a single-file mount silently stops
seeing edits (see the mount note in Step 4). (Alt: inline `AGENT_INVENTORY_JSON`;
absent = don't declare.)

**ISO auto-refresh:** declaring inventory here also turns on automatic ArcaneOS/FluxLive
ISO staging — every `nodeName` above (with its `storageIso`, or `PROXMOX_STORAGE_ISO` if
omitted) gets checked against the RunOnFlux release feed every 6h (`AGENT_REFRESH_ISO_INTERVAL_MS`
to change it), downloaded + checksum-verified + uploaded automatically when a newer build
ships, and `ARCANE_ISO` is adopted in-process for the next provision — no more hand-refreshing
the ISO or hitting "Unable to find ISO image on hypervisor" on a stale build. This is *why*
Step 6 is worth doing even for a single-host operator, not just for multi-slot bookkeeping.
Without declared inventory, the agent has no local record of your Proxmox node name and
falls back to today's static behavior (`ARCANE_ISO` never auto-updates).

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
- **Listing**: within a minute the agent's heartbeat sets your price + slots offered at MT
  (admin → Providers shows `lastAsserted`).
- **Stats**: MT pulls `/stats`; benchmarks/uptime appear on your card.
- **Checkout (test)**: with Stripe in test mode, rent one of your tiers from
  `/providers` → you get a Stripe Checkout (your account) with a trial → MT records a
  rental → your agent provisions the node → result flows back.

## After provisioning: the collateral guard

A freshly-provisioned node doesn't go live immediately. Flux rejects a fluxnode
START whose collateral UTXO has under ~100 confirmations and applies a DoS-score
cooldown, so MT withholds the customer's "go start your node" email until the
node's benchmarks pass **and** its collateral clears 100 confirmations
(typically ~50 minutes after the collateral funding tx is mined).

**Your Coalition owns this check, not the agent.** Every ~2 minutes it polls
each of your still-maturing nodes' benchmark endpoint plus the public Flux
blockchain API and reports the measurements to MT, which decides when to flip
the node's status and email the customer. You can see the live state — which
nodes are still held, and why — on your own `/console` page (a read-only
section appears whenever a node is maturing). This is why the Coalition must
stay running after a node provisions, not just during checkout — it's already a
hard requirement (checkout depends on it too), so this adds no new operational
burden, just an expanded role for a component you're already running.

## Ongoing operations

- **Change price / slots offered**: update the agent's `AGENT_LISTING_JSON` and recreate the
  container (`docker restart` does NOT reload `--env-file` changes), and
  update `TIER_PRICES_JSON` in `config.env` → re-run `manifest env` → re-import
  `env.json` (free) so the Coalition's prices match. No re-signing.
- **Add or remove a host**: add its `ProxmoxHost.name` to `HOSTS` in `config.env`, then
  re-`sign` + re-`authorize` (wallet) the manifest, re-run `manifest env`, re-import
  `env.json`, and have MT re-ingest. Until then MT **rejects the whole inventory assert**
  with a 409 naming the unattested host — this is the point of the attestation, so plan a
  host addition around a signing session rather than a config edit.
- **Change identity**: edit `config.env`, re-`sign` the manifest, re-run
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
