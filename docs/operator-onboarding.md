# MoltenTech Operator Onboarding

This is the runbook to join the MoltenTech marketplace as an **operator**: you host
Flux nodes on your own Proxmox, customers rent them through MoltenTech (MT), and they
**pay you directly** on your own Stripe account. MT never holds your Proxmox or Stripe
credentials and never opens an inbound connection to you.

> **Rewritten 2026-08-08 from the first from-zero onboarding ever performed.** The
> previous revision documented a CLI ownership ceremony (`mt-manifest authorize` →
> Zelcore deep link → `--signature`) and required the Coalition to exist *before* you
> could onboard. Both are gone: onboarding is now a **paste-and-sign web flow** at
> `{MT_BASE_URL}/onboard` that needs no Coalition and issues your keys inline, so the
> Coalition is deployed **once**, already holding its real keys. Every ⚠️ in this
> document is a trap that actually bit during that run.

## What you run

Two small components (both in the `moltentech-operator` repo):

| Component | Where it runs | Direction | Holds |
|---|---|---|---|
| **Agent** | on/beside your Proxmox (Docker + LAN reach to `:8006`) | **outbound only** | your Proxmox API token + your manifest key |
| **Coalition** | on Flux (ArcaneOS) | **inbound** (manifest/stats/payments) | your restricted Stripe key + webhook secret |

```
                 ┌────────────── MoltenTech (the only inbound-facing side) ──────────────┐
customer ─buy──▶ │ storefront → calls your Coalition /checkout → Stripe session           │
                 │ Stripe webhook → your Coalition → relays to MT /api/agent/payment       │
                 │ MT enqueues a job ──▶ your AGENT pulls it ──▶ provisions YOUR Proxmox   │
                 │ MT pulls your Coalition /stats + /.well-known/mt-provider.json           │
                 └───────────────────────────────────────────────────────────────────────┘
```

## The shape of the whole thing

```
Step 0  Proxmox: token, storage, ISO          ← on your Proxmox
Step 1  keygen + config.env  ─────────────┐   ← on your agent host
Step 2  /onboard: paste + wallet-sign      ├─▶ THREE KEYS, issued once
Step 3  Stripe: restricted key + webhook  ─┘   (webhook needs your Coalition URL, which
Step 4  Deploy the Coalition on Flux            you already chose in Step 1 — see below)
Step 5  Declare inventory.json
Step 6  Run the agent
Step 7  MT activates you → you are live
```

The one ordering constraint that used to be circular: **your Coalition URL is
deterministic**, `https://<flux-app-name>.app.runonflux.io/`. Choose the app name in
Step 1, write the URL into `config.env`, and everything downstream — the signed
manifest, the Stripe webhook endpoint, the agent's courier — can be filled in before the
app exists.

## Prerequisites

- **Proxmox** host(s) with an API **token** (not the root password) and the ArcaneOS ISO
  in a shared ISO storage. Step 0 creates the token.
- A trusted, always-on host with **Docker** and LAN line-of-sight to Proxmox `:8006`
  and outbound 443 (a sidecar VM/LXC is the clean default). The agent image bundles
  Node + Python + `arcane-mage`, so nothing else is needed on that host.
- A **Flux** account with enough FLUX to register an app (the Coalition is a small,
  stateless container).
- A **Stripe** account (you are merchant of record).
- A **Flux wallet** (SSP or Zelcore) holding the address you will use as your
  `OWNER_ADDRESS`. This wallet signs onboarding and every privileged node action
  forever after — use one you will still control in a year.
- Public reachability for your Coalition URL (Flux provides it) and your nodes' public
  `apiPort`s, so MT can pull stats from outside your LAN.

---

## Step 0 — Prepare Proxmox

### 0.1 Create an API token

⚠️ **A path-scoped token cannot work.** Scoping a token to `/nodes/<host>` looks
tempting on a cluster, but `VM.Allocate` is checked on `/vms/<vmid>` or `/pool/<pool>`,
the vmid namespace is cluster-wide, and pools are the only supported partition — which
the tooling never passes. The token below is **cluster-wide by design**; if you run a
cluster, understand that this token can allocate VMs on any node in it.

```sh
# On a Proxmox node, as root:
pveum role add MoltenTechAgent -privs \
  "VM.Allocate,VM.Clone,VM.Audit,VM.Config.CDROM,VM.Config.CPU,VM.Config.Disk,\
VM.Config.HWType,VM.Config.Memory,VM.Config.Network,VM.Config.Options,\
VM.Console,VM.Monitor,VM.PowerMgmt,\
Datastore.Allocate,Datastore.AllocateSpace,Datastore.AllocateTemplate,Datastore.Audit,\
Sys.Audit"
pveum user add moltentech@pve
pveum acl modify / --users moltentech@pve --roles MoltenTechAgent
pveum user token add moltentech@pve agent --privsep 0     # prints the secret ONCE
```

`--privsep 0` makes the token inherit the user's privileges; with privilege separation
on you must grant the ACL to the *token* as well. Copy the secret immediately — Proxmox
never shows it again. The token ID is `moltentech@pve!agent`.

If a provision later fails with a 403 naming a privilege, add it to the role
(`pveum role modify MoltenTechAgent -privs "…"`) rather than escalating to `PVEAdmin`.

### 0.2 Pick the right storage — this one fails silently

⚠️ **Do not accept `local-lvm` because it is the default.** On a mixed-disk host the
default LVM volume group frequently sits on a spinning disk while the SSD is a separate
pool. Nothing errors: VMs provision fine, then every node **fails its benchmark** with
no cause you can see.

```sh
pvesm status                        # the storage IDs — this is what PROXMOX_STORAGE_* wants
pvs -o pv_name,vg_name              # which physical device backs each volume group
lsblk -o NAME,ROTA,SIZE,TYPE        # ROTA=1 is spinning rust; ROTA=0 is solid state
```

Trace your intended image storage back to a device with `ROTA=0` before you write it
into `.env.operator` in Step 6.

⚠️ **`PROXMOX_STORAGE_IMAGES` wants a storage *ID*, not a volume group name.** If
`pvesm status` lists `ssd`, the value is `ssd` — not the underlying VG.

### 0.3 Stage the ArcaneOS ISO

Put the ArcaneOS/FluxLive ISO in an ISO storage every attested host can read (a shared
NFS/CIFS storage if you have more than one host). Note its storage ID and filename;
they become `PROXMOX_STORAGE_ISO` / `ARCANE_ISO`. Once you declare inventory (Step 5)
the agent keeps the ISO current automatically.

---

## Step 1 — Generate your signing key + config

The signing tool is the published image **`ghcr.io/w2vy/mt-manifest`** — no source
checkout, no Node install. It's secret-free: your key is generated into the mounted
working directory, never baked into the image.

⚠️ **Define it as a shell function, not an alias.** An alias does not expand when it
appears as an argument to another command, so wrapping it (in a script, a `time`, a
capture harness, `sudo`, `watch`) fails with `command not found`.

```sh
mt-manifest() { docker run --rm -v "$PWD:/work" -u "$(id -u):$(id -g)" ghcr.io/w2vy/mt-manifest "$@"; }
mt-manifest keygen             # writes manifest-key.pem (KEEP SECRET, 0600) + prints your pubkey
```

Every `mt-manifest` command below reads and writes the **current directory** — run them
all from the same folder.

⚠️ **`keygen` is a once-ever act.** `manifest-key.pem` *is* your provider identity: MT
pins its public half as `Provider.manifestPubkey` at onboarding, and re-running `keygen`
silently overwrites it, after which every signature you produce is rejected. Back it up
before you go further. Recovery is possible — re-paste a manifest signed with the new
key at `/onboard` and sign with the pinned owner wallet — but it is a deliberate
rotation, not an accident you want to have.

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
# COALITION_URL — the stable HTTPS URL your Coalition will serve at. Flux app URLs are
# deterministic: https://<your-flux-app-name>.app.runonflux.io. Choose the app name NOW
# and fill this in; the app itself is created in Step 4.
COALITION_URL=https://<your-coalition>
# OWNER_ADDRESS — the wallet address that signs onboarding and every privileged node
# action. It is baked into the bytes you sign in Step 2 — get it right the first time.
OWNER_ADDRESS=<your owner ZelID>
# MT_PUBKEY — optional; leave blank for now. Pin later from {MT_BASE_URL}/api/mt-pubkey
# once MT enables signing (503 until then). Only the Coalition consumes it.
MT_PUBKEY=
# HOSTS — the Proxmox hosts you attest, as a comma-separated list of ProxmoxHost.name.
# This is the owner-signed hardware list: MT rejects any inventory host not named here,
# so adding a machine later means re-signing the manifest (see "Ongoing operations").
HOSTS=pve-01,pve-02
# TIER_PRICES_JSON — runtime price in integer CENTS per tier. NOT in the signed manifest,
# so you can change price without re-signing. Must be >= the platform floor for the tier
# (cumulus $7, nimbus $20, stratus $40) — MT rejects a listing below it with a 422.
# CHECK YOUR ZEROS: these are CENTS, so nimbus at $20 is 2000, not 20000.
TIER_PRICES_JSON={"cumulus":700,"nimbus":2000}
TRIAL_DAYS=1
MANUAL_APPROVAL=false
```

Sign the manifest from it:

```sh
mt-manifest sign --key manifest-key.pem --from-config config.env --out manifest.json
mt-manifest verify --in manifest.json
# expect: OK — manifest signature valid (bare manifest, no owner authorization)
```

⚠️ **"bare manifest, no owner authorization" is the correct and expected result.** Under
the old flow you then ran `mt-manifest authorize` to wrap it in a wallet signature. You
do not any more — the wallet signature happens in your browser in Step 2 and is retained
by MT. **The bare `manifest.json` is what you submit and what your Coalition publishes.**

`manifest.json` carries `HOSTS` (the hardware you attest, owner-signed) and your
identity. It does **not** carry price — `TIER_PRICES_JSON` feeds runtime pricing only —
and it does not carry tiers or slot counts, which derive from the inventory your agent
asserts, constrained to the attested hosts.

---

## Step 2 — Onboard: paste and sign

Open **`{MT_BASE_URL}/onboard`** in a browser on a machine with your wallet. You do
**not** need a login, a Coalition, or anything deployed — only `manifest.json`.

1. **Paste the whole of `manifest.json`** into the box and press **Continue**. MT
   verifies the ed25519 signature and shows you the slug you are claiming and the owner
   address the manifest declares. Check that address — it is the wallet you must sign
   with, and it is taken from the bytes you signed, not from anything you can change now.
2. **Sign with your wallet.** SSP signs in-browser; "Sign with Zelcore" opens a deep
   link and posts the signature back automatically. The page holds your manifest the
   whole time — MT never stores an unverified manifest server-side.
3. **You are handed three keys, shown once.** Copy all three immediately (the page has a
   "Copy all three (`secrets.env`)" button):

   | Key | Direction | Where it goes |
   |---|---|---|
   | `AGENT_KEY` | your agent + Coalition → MT | Coalition env (Step 4); optional on the agent (Step 6) |
   | `COALITION_KEY` | MT → your Coalition (`/checkout`, `/manage`) | Coalition env only |
   | `COALITION_SIGNING_KEY` | signs your Coalition's outbound reports to MT | **store it; nothing reads it yet** |

⚠️ **`COALITION_SIGNING_KEY` has no consumer today.** It is issued ahead of the Phase D
verifier so nobody onboarded in the meantime has to be re-opened. MT keeps only the
public half, which means **the copy you were just shown is the only one that exists** —
if you lose it, the only recovery is an admin key re-issue that rotates all three, and
that means a fresh `env.json` import plus an agent restart. Put it somewhere durable
alongside `manifest-key.pem` and forget about it until Phase D ships.

Your provider now exists at MT in status `pending`. Step 7 activates it.

> **Re-running `/onboard` later is safe and is the supported path** for refreshing your
> attested `HOSTS` or rotating your manifest key: paste the newly signed manifest, sign
> with the same pinned owner wallet. Keys are **not** re-issued on a refresh — only a
> first ingest issues them.

---

## Step 3 — Stripe setup

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

2. Create a **webhook endpoint** pointing at `<COALITION_URL>/webhook`, subscribed to:
   `customer.subscription.created`, `customer.subscription.deleted`,
   `invoice.payment_succeeded`, `invoice.payment_failed`, `charge.refunded`.
   Copy its **signing secret** (`whsec_…`).

   ⚠️ **A `whsec_` is bound to the endpoint URL it was created for.** Never copy one
   from another Coalition, another environment, or a colleague — Stripe will keep
   delivering events to *that* endpoint and yours receives nothing. **Nothing errors**;
   checkout simply never completes. One Coalition URL = one endpoint = one `whsec_`.

   ⚠️ **Test and live mode are separate endpoints with separate secrets**, independent
   of which API key you use. A test-mode `rk_test_` paired with a live-mode `whsec_`
   fails the same silent way.

> **Known rough edge:** Stripe is currently *mandatory* — the Coalition refuses to start
> without both `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`, even if you list no paid
> tiers at all. Running nodes for yourself with no rentals should not require a Stripe
> account, and making payment config optional is planned. Until then, a test-mode
> restricted key is enough to satisfy the check.

---

## Step 4 — Deploy the Coalition on Flux

The Coalition runs as a **published Docker image** (`w2vy/coalition:latest`) deployed as
a Flux App. Config, secrets, and your signed manifest are all supplied as **Flux
environment variables** — nothing to mount. Because Step 2 already gave you the real
keys, this is a **single deploy**; there is no placeholder-then-re-import round trip.

**1. Assemble the secrets.** Alongside `config.env` keep a private **`secrets.env`**
(never commit, `chmod 600`):

Same rule as `config.env`: **comments on their own line only** — a trailing comment
after `AGENT_KEY`/`COALITION_KEY` becomes part of the key and MT will reject it (401).

```sh
# secrets.env
STRIPE_SECRET_KEY=rk_live_<restricted>
STRIPE_WEBHOOK_SECRET=whsec_<from step 3>
# SESSION_SECRET — optional, local-only. Set = console view-gate on (wallet-login to
# view); blank = reads ungated. Node ACTIONS are wallet-signed either way.
SESSION_SECRET=<openssl rand -hex 32>
# AGENT_KEY / COALITION_KEY — the real values from Step 2.
AGENT_KEY=<agentKey from /onboard>
COALITION_KEY=<coalitionKey from /onboard>
# COALITION_SIGNING_KEY — store it here for later. `mt-manifest env` ignores it today;
# nothing consumes it until Phase D. Keeping it beside the others is how you avoid
# losing the only copy.
COALITION_SIGNING_KEY=<coalitionSigningKey from /onboard>
```

Then build the Flux import blob from config + secrets + your signed manifest, reusing
the same `mt-manifest` function from Step 1 (same shell / same directory):

```sh
mt-manifest env --from-config config.env --secrets secrets.env \
  --manifest manifest.json --out env.json
```

`env.json` is a JSON array of `"KEY=value"`. It embeds your manifest as `MANIFEST_JSON`
(verifying the signature first) and passes `TIER_PRICES_JSON` through. **It contains
secrets — do not commit it.**

**2. Register the Flux App:** Docker image `w2vy/coalition:latest`, container port
**8088**, then supply `env.json` as the app's environment.

⚠️ **Flux caps a plaintext environment parameter at 400 characters, and `MANIFEST_JSON`
is far longer than that.** Pasting `env.json` straight into **Environment Variables →
Import** fails validation with *"App component coalition environment MANIFEST_JSON=… is
too long. Maximum of 400 characters is allowed"*. Two supported ways past it:

- **Flux Cloud storage** (what a normal operator should do): upload `env.json` to Flux
  Cloud storage and reference it from the app spec. This is a standard option in the
  registration UI; the size cap does not apply.
- **An enterprise app**, whose environment is encrypted into a single `enterprise` blob
  with `environmentParameters: []`. Both existing production Coalitions are deployed
  this way.

**3. Verify:** `<COALITION_URL>/health` → `{"ok":true,"provider":"…","coalitionVersion":"…"}`
and `<COALITION_URL>/.well-known/mt-provider.json` returns your manifest.

Changing env later (rotate a secret, change tiers, re-sign the manifest) is a **free
re-import** of a fresh `env.json`, then Flux's **Free Deploy**.

⚠️ **A secret-only change can leave the app spec byte-identical**, in which case the
re-import is a silent no-op. Always verify downstream (`/health`, a real checkout)
rather than trusting that the import took.

⚠️ **Do not pin an old Coalition tag.** A published image predating a protocol change
cannot complete onboarding; use `:latest` unless you have been told otherwise.

---

## Step 5 — Declare your inventory (no DB hand-edits)

Your agent-managed hosts and slots are **declared by you**, not inserted into MT's
database by an admin. Create a **dedicated subdirectory** for it — the agent mounts that
directory, and nothing else in it should be readable by the container:

```sh
mkdir -p agent-data
$EDITOR agent-data/inventory.json
```

```json
[
  {
    "name": "pve25-lab",
    "nodeName": "pve25",
    "apiUrl": "https://pve25:8006",
    "storageImages": "ssd",
    "storageIso": "shared-iso",
    "slots": [
      { "vmName": "mt-you-n1", "tier": "nimbus", "lanIp": "192.168.1.51/24",
        "ipAddress": "203.0.113.51", "gateway": "192.168.1.1", "apiPort": 16197 }
    ]
  }
]
```

- `name` is the globally-unique host label (`ProxmoxHost.name`), distinct from
  `nodeName` (the Proxmox node). Every `name` here **must** appear in `HOSTS` in
  `config.env` — MT rejects the *whole* assert with a 409 naming any unattested host.
- ⚠️ **`lanIp` needs its CIDR suffix.** A bare `192.168.1.51` is interpreted as `/32`,
  the VM comes up with no route to its gateway, and the node never reaches the network.
- `storageImages` / `storageIso` override the agent's defaults per host — use them when
  hosts differ (see Step 0.2; this is where you keep VMs off the spinning disk).
- Omit optional fields like `vlan`/`rateLimit` rather than setting them `null`.
  `dns1`/`dns2` default to `8.8.8.8`/`1.1.1.1`.

The agent asserts this to MT (`PUT /api/agent/inventory`) on startup and each heartbeat,
**provider-scoped**: MT upserts your `ProxmoxHost`/`Slot` rows, never touches another
operator's inventory, and never hard-deletes a rented slot.

⚠️ **The assert is upsert-only.** Deleting a host or slot from this file removes
*nothing* at MT — the rows stay, and the slots stay sellable. Retiring hardware is an
admin action, not a file edit.

Because the agent **re-reads the file every heartbeat**, edits apply without a restart —
**only if you mount `./agent-data` as a directory** (Step 6). (Alternative: inline
`AGENT_INVENTORY_JSON`; absent entirely = don't declare.)

**ISO auto-refresh:** declaring inventory also turns on automatic ArcaneOS/FluxLive ISO
staging — every `nodeName` above (with its `storageIso`, or `PROXMOX_STORAGE_ISO` if
omitted) is checked against the RunOnFlux release feed every 6h
(`AGENT_REFRESH_ISO_INTERVAL_MS` to change), downloaded + checksum-verified + uploaded
when a newer build ships, and `ARCANE_ISO` is adopted in-process for the next provision
— no more hand-refreshing the ISO or hitting "Unable to find ISO image on hypervisor" on
a stale build. Without declared inventory the agent has no record of your node names and
`ARCANE_ISO` never auto-updates.

---

## Step 6 — Run the agent

The agent is the published image **`w2vy/mt-agent`**. It runs on a trusted, always-on
host **beside your Proxmox** — **not** on Flux. It is outbound-only (no ports) and holds
your Proxmox token + manifest key, so it must live on infrastructure you control.

Put its config in a private **`.env.operator`** (never commit, `chmod 600`):

```sh
MT_BASE_URL=https://www.moltentech.us
PROVIDER_SLUG=your-slug
# Auth. MANIFEST_KEY (asymmetric signing) is preferred; AGENT_KEY is the legacy bearer.
# At least one must be set — keep both while you roll over.
MANIFEST_KEY=<base64 of manifest-key.pem — see below>
AGENT_KEY=<agentKey from /onboard>
OWNER_ADDRESS=<your owner ZelID>
COALITION_URL=https://<your-coalition>
AGENT_INVENTORY_PATH=/data/inventory.json
# Local Proxmox — creds NEVER leave your host. Use an address the CONTAINER can reach:
# your Proxmox LAN IP (not 127.0.0.1, which is the container's own loopback), or run with
# `--network host` if the agent runs on the Proxmox host itself.
PROXMOX_URL=https://<proxmox-lan-ip>:8006
PROXMOX_TOKEN_ID='moltentech@pve!agent'
PROXMOX_TOKEN_SECRET=<secret from Step 0.1>
PROXMOX_NETWORK=vmbr0
PROXMOX_STORAGE_IMAGES=<a ROTA=0 storage ID — see Step 0.2>
PROXMOX_STORAGE_ISO=<your ISO storage ID>
ARCANE_ISO=<your ArcaneOS ISO name>
# Price + how many slots to offer for sale (re-asserted to MT each heartbeat).
# How much hardware you HAVE comes from your inventory, not from here.
AGENT_LISTING_JSON='[{"tier":"nimbus","priceCents":2200,"availableSlots":8}]'
```

### `MANIFEST_KEY`: what it is and how to produce it

`MANIFEST_KEY` is **not a new key and it does not change**. It is the base64 encoding of
`manifest-key.pem` — the same file `keygen` wrote in Step 1 — flattened to one line so
it survives an env var. Encoding it twice gives the identical string; if it ever changes,
your key changed, and that is a problem.

```sh
base64 -w0 manifest-key.pem       # paste the output as the literal value
```

⚠️ **`docker --env-file` performs no shell expansion.** Writing
`MANIFEST_KEY=$(base64 -w0 manifest-key.pem)` into `.env.operator` stores and transmits
that text *literally*. Auth then fails as a bare **401** with nothing pointing at the
cause. The same applies to `${VAR}` and to wrapping quotes — `--env-file` values are
taken verbatim, quotes included.

To confirm the key is the right one, decode it and compare the derived pubkey with the
`Provider.manifestPubkey` MT pinned for you at onboarding.

### Mount the directory, not the file

Mount `./agent-data` read-only at `/data`, which is where `AGENT_INVENTORY_PATH`
resolves inside the container. A **single-file** bind mount pins the container to that
file's *inode*, and most editors save atomically via write-new-then-rename, which
detaches the mount — host edits silently stop reaching the container (no error, it just
keeps serving stale content) until the container is recreated. Keep `agent-data/` scoped
to `inventory.json` alone: `.env.operator` and `manifest-key.pem` have no business being
readable inside the container.

### Dry run, then run

Validate connectivity/auth to MT first, **without touching Proxmox**:

```sh
docker run --rm --env-file .env.operator -v "$PWD/agent-data:/data:ro" \
  -e AGENT_DRY_RUN=1 w2vy/mt-agent:latest
# expect: provider=… mt=… dryRun=true auth=signature ownerAuth=enforced courier=on
```

Read that banner. `auth=signature` means `MANIFEST_KEY` loaded; `courier=on` means the
owner-authorization courier is live.

⚠️ **The courier switches itself off silently** unless `MANIFEST_KEY` **and**
`COALITION_URL` **and** `OWNER_ADDRESS` are all set. There is no warning — you simply
never receive authorization requests, and deletes/reprovisions sit forever.

Then run it for real:

```sh
docker run -d --name mt-agent --restart unless-stopped \
  --env-file .env.operator -v "$PWD/agent-data:/data:ro" w2vy/mt-agent:latest
```

⚠️ **`docker restart` does NOT reload `--env-file` changes.** Any env edit requires
`docker rm -f mt-agent` and a fresh `docker run`. This is the single most common reason
a "fixed" key keeps returning 401.

⚠️ If you see **"self-signed certificate in certificate chain"**, the image is missing
its CA store — it is not a middlebox on your network and not a Proxmox cert problem.

(Or use `docker-compose.operator.yml` with `image: w2vy/mt-agent` instead of `build:`.
⚠️ The compose files hardcode a project name, so a second stack on the same host **must**
pass `-p <name>` or the two will fight over the same containers.)

`priceCents` must be ≥ the MT platform floor and should match `TIER_PRICES_JSON` in the
Coalition.

---

## Step 7 — Activation and the operator console

MT reviews your `pending` provider and **activates** it; your cards then appear on
`/providers`. Within a minute of activation the agent's heartbeat publishes your price
and slots offered (admin → Providers shows `lastAsserted`).

Owner authorization for privileged actions (delete / reprovision / move) is done in
**your own** Coalition console — MT never prompts for it:

1. A customer cancels → MT marks the slot `pending_delete`.
2. Your **agent** fetches the pending list (`GET /api/agent/pending-auth`, signed) and
   **pushes it to your Coalition console**.
3. You open `<COALITION_URL>/console`, click the pending action, and **sign it in your
   wallet** (SSP in-browser, or "Sign with Zelcore" — the deep link posts the signature
   back automatically). The console verifies the signature recovers to `OWNER_ADDRESS`
   before queueing it — that per-action signature **is** the login.
4. Your agent **polls the console**, re-verifies the signature locally, and relays it to
   MT (`POST /api/agent/authorize`) → MT enqueues the job → the agent executes it.

⚠️ **A failed relay destroys the signed blob.** The Coalition hands it over exactly
once; if the handoff fails you must sign the action again. The courier log is the only
place this is visible.

The Coalition holds **no keys** for this and never calls MT — it is a UI + signature
courier. The manifest key (agent↔console auth) stays on the agent; the owner key stays
in your wallet. Wrong-owner, expired, and replayed signatures are refused at both the
console and the agent.

---

## Verify it works end to end

- **Manifest**: MT admin shows your provider with the right `Coalition URL`, attested
  hosts, and freshness once it pulls stats/listing.
- **Inventory**: your hosts appear with the slots you declared, in `available`.
- **Listing**: your price + slots offered land at MT within a heartbeat.
- **Stats**: MT pulls `/stats`; benchmarks/uptime appear on your card.
- **Checkout (test)**: with Stripe in test mode, rent one of your tiers from
  `/providers` → you get a Stripe Checkout (your account) with a trial → MT records a
  rental → your agent provisions the node → result flows back.
- **Authorization**: cancel that test rental and confirm the pending action shows up in
  `<COALITION_URL>/console`.

## Which value must match where

Nothing compares these for you, and each pair has bitten a real onboarding:

| Value | Appears in | Must equal |
|---|---|---|
| `PROVIDER_SLUG` | `config.env`, `.env.operator` | itself, and the slug in the signed manifest |
| `MT_BASE_URL` | `config.env`, `.env.operator` | itself — a staging/prod mix leaves you half-onboarded |
| `OWNER_ADDRESS` | `config.env`, `.env.operator`, your wallet | the address you signed with at `/onboard` |
| `COALITION_URL` | `config.env`, `.env.operator`, Stripe endpoint | the real Flux app URL |
| `AGENT_KEY` | `secrets.env` → `env.json`, `.env.operator` | the value issued at `/onboard` |
| `MANIFEST_KEY` | `.env.operator` | `base64 -w0 manifest-key.pem` |
| tier price | `TIER_PRICES_JSON`, `AGENT_LISTING_JSON` | each other, and ≥ the platform floor |
| host names | `HOSTS` in `config.env`, `inventory.json` | each other (409 otherwise) |

## After provisioning: the collateral guard

A freshly-provisioned node doesn't go live immediately. Flux rejects a fluxnode START
whose collateral UTXO has under ~100 confirmations and applies a DoS-score cooldown, so
MT withholds the customer's "go start your node" email until the node's benchmarks pass
**and** its collateral clears 100 confirmations (typically ~50 minutes after the
collateral funding tx is mined).

**Your Coalition owns this check, not the agent.** Every ~2 minutes it polls each of
your still-maturing nodes' benchmark endpoint plus the public Flux blockchain API and
reports the measurements to MT, which decides when to flip the node's status and email
the customer. You can see the live state — which nodes are still held, and why — on your
own `/console` page. This is why the Coalition must stay running after a node
provisions, not just during checkout.

## Key reference (which secret lives where)

| Secret | Generated by | Lives | Shared with |
|---|---|---|---|
| `manifest-key.pem` | you (`keygen`) | your machine + agent (`MANIFEST_KEY`) | **nobody** |
| manifest `pubkey` | derived | in the manifest, pinned at MT | public |
| owner wallet key | you | your wallet only | **nobody** |
| `agentKey` | MT (`/onboard`) | agent **and** Coalition env | you (once) |
| `coalitionKey` | MT (`/onboard`) | Coalition env | you (once) |
| `coalitionSigningKey` | MT (`/onboard`) | your safe keeping — no consumer yet | you (once, only copy) |
| Stripe restricted key | you (Stripe) | Coalition env | nobody |
| Stripe webhook secret | you (Stripe) | Coalition env | nobody |
| Proxmox API token | you (Proxmox) | agent env | nobody |

MT stores only a **hash** of `agentKey`, an **encrypted** copy of `coalitionKey`, and
the **public** half of `coalitionSigningKey`. It stores **none** of your Stripe or
Proxmox credentials, and never the private half of anything you generated.

## Ongoing operations

- **Change price / slots offered**: update `AGENT_LISTING_JSON` and **recreate** the
  agent container (`docker rm -f` + `docker run` — `restart` does not reload
  `--env-file`), and update `TIER_PRICES_JSON` in `config.env` → re-run `mt-manifest
  env` → re-import `env.json` (free) so the Coalition's prices match. No re-signing.
- **Add or remove a host**: add its `ProxmoxHost.name` to `HOSTS` in `config.env`,
  re-`sign`, re-paste at `/onboard` and sign with your pinned owner wallet, then re-run
  `mt-manifest env` and re-import `env.json`. Until MT re-ingests, it **rejects the
  whole inventory assert** with a 409 naming the unattested host — that is the point of
  the attestation, so plan a host addition around a signing session, not a config edit.
  (Removing a host from `HOSTS` narrows what the agent may declare; it does **not**
  delete existing rows — see Step 5.)
- **Add or remove slots on an attested host**: edit `inventory.json`. No re-sign, no
  restart. Removals do not delete (upsert-only).
- **Change identity** (name, location, contact, Coalition URL): edit `config.env`,
  re-`sign`, re-paste at `/onboard`, re-run `mt-manifest env`, re-import `env.json`.
- **Rotate your manifest key**: `keygen` a new one, re-`sign`, re-paste at `/onboard`
  and sign with the pinned owner wallet — that is the only accepted rotation path. Then
  update `MANIFEST_KEY` on the agent and recreate the container. Your issued keys are
  unaffected and are not re-issued.
- **Rotate the issued keys**: an MT admin re-issues all three at once (the old ones stop
  working immediately); update `secrets.env`, re-import `env.json`, and recreate the
  agent container.
- **Staleness**: if MT stops seeing fresh stats *and* listing past the TTL, your
  provider auto-hides from the marketplace (data retained) and auto-re-lists on the next
  fresh update — so keep the agent and Coalition running.
- **Customer cancel/refund**: cancellation is free during the trial; afterward you are
  merchant of record — refunds/disputes are handled in your Stripe dashboard.

## Trust model (why this is safe)

- You hold **all** your own secrets; MT holds none of them. The agent is outbound-only
  with no inbound ports. The Coalition's only secrets are a restricted Stripe key +
  webhook secret, and ArcaneOS prevents the hosting node from reading them.
- Ownership is proven by a wallet signature over your own manifest's bytes. MT can
  neither forge it nor change your owner address without a deliberate admin recovery
  action.
- Jobs MT sends your agent carry slot/network params + the customer's Flux identity key
  over TLS, but **never** Proxmox credentials — the agent injects its own. That identity
  key is node-scoped and cannot touch collateral.
- Collateral is a wallet UTXO, safe on any host; the residual risk (node identity-key
  exposure, uptime) is yours to manage and is reflected in your card's stats + reviews.
