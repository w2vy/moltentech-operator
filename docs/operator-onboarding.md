# Flux Hub Onboarding

This is the runbook to join Flux Hub: you run Flux nodes on your own Proxmox, and — if
you choose to — customers rent them through Flux Hub (FH) and **pay you directly** on
your own Stripe account. FH never holds your Proxmox or Stripe credentials and never
opens an inbound connection to you.

## Which are you?

| | **Flux Hub Supporter** | **Flux Hub Operator** |
|---|---|---|
| Runs their own nodes | yes | yes |
| Runs **Foundation nodes** on idle capacity | yes | yes |
| Rents hardware out through the marketplace | no | yes |
| Stripe account | **not needed** | required — you are merchant of record |

A **Supporter** lends the capacity they are not using: Flux Hub places Foundation nodes
on their spare slots, alongside their own. Nothing is listed for sale, so there is no
price to set, no Stripe account to create, and three of the steps below do not apply.

An **Operator** does all of that and also offers hardware for rent.

`mt-manifest init` asks which you are as its first question, and the answer is published
in your signed manifest (`PROVIDER_LEVEL`), so FH has an explicit answer rather than
guessing from whether you happened to list a tier. You can change it later by re-signing
and re-pasting your manifest — nothing else about you changes.

> Steps marked **(Operator only)** can be skipped by a Supporter.

Either way you can still *receive* nodes: a rental an admin **assigns** to you involves
no payment method at all. Stripe is what lets strangers buy from you.

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
| **Coalition** | on the Flux Network (RunOnFlux.com) | **inbound** (manifest/stats/payments) | your restricted Stripe key + webhook secret |

```
                 ┌─────────────── Flux Hub (the only inbound-facing side) ───────────────┐
customer ─buy──▶ │ storefront → calls your Coalition /checkout → Stripe session          │
                 │ Stripe webhook → your Coalition → relays to FH /api/agent/payment     │
                 │ FH enqueues a job ──▶ your AGENT pulls it ──▶ provisions YOUR Proxmox │
                 │ FH pulls your Coalition /stats + /.well-known/mt-provider.json        │
                 └───────────────────────────────────────────────────────────────────────┘
```

## The shape of the whole thing

```
Step 0  Proxmox: token, storage, ISO          ← on your Proxmox
Step 1  keygen + config.env  ─────────────┐   ← on your agent host
Step 2  /onboard: paste + wallet-sign      ├─▶ THREE KEYS, issued once
Step 3  Stripe (Operator only)  ──────────┘   (webhook needs your Coalition URL, which
Step 4  Deploy the Coalition on Flux            you already chose in Step 1 — see below)
Step 5  Declare inventory.json
Step 6  Run the agent
Step 7  FH activates you → you are live
```

The one ordering constraint that used to be circular: **your Coalition URL is
deterministic**, `https://<flux-app-name>.app.runonflux.io/`. Choose the app name in
Step 1, write the URL into `config.env`, and everything downstream — the signed
manifest, the Stripe webhook endpoint, the agent's courier — can be filled in before the
app exists.

## Prerequisites

- **Proxmox** host(s) with an API **token** (not the root password) and an ISO storage
  every host can read. Step 0 creates the token; the agent stages the ISO for you.
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
  `apiPort`s, so FH can pull stats from outside your LAN.

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
pveum role add FluxHubAgent -privs \
  "VM.Allocate,VM.Clone,VM.Audit,VM.Config.CDROM,VM.Config.CPU,VM.Config.Disk,\
VM.Config.HWType,VM.Config.Memory,VM.Config.Network,VM.Config.Options,\
VM.Console,VM.Monitor,VM.PowerMgmt,\
Datastore.Allocate,Datastore.AllocateSpace,Datastore.AllocateTemplate,Datastore.Audit,\
Sys.Audit"
pveum user add fluxhub@pve
pveum acl modify / --users fluxhub@pve --roles FluxHubAgent
pveum user token add fluxhub@pve agent --privsep 0     # prints the secret ONCE
```

`--privsep 0` makes the token inherit the user's privileges; with privilege separation
on you must grant the ACL to the *token* as well. Copy the secret immediately — Proxmox
never shows it again. These two values are what the rest of onboarding calls
`PROXMOX_TOKEN_ID` and `PROXMOX_TOKEN_SECRET`, and `mt-manifest init` asks for them under
exactly those names:

| Variable | Value from the commands above |
|---|---|
| `PROXMOX_TOKEN_ID` | `fluxhub@pve!agent` — user, `!`, token name |
| `PROXMOX_TOKEN_SECRET` | the UUID printed once by `user token add` |

Keep both to hand. `init` **proves them on the spot**, so a mistyped secret or a token
that cannot allocate is caught here rather than five steps later — and it reuses the
connection to read your storage and node list, which is what fills in Step 0.2 for you.

⚠️ **Already onboarded under the old names? Keep them.** Operators set up before this
rename have a `MoltenTechAgent` role and a `moltentech@pve!agent` token. That token id is
baked into the `PROXMOX_TOKEN_ID` your agent authenticates with — it is a credential, not
a label. Renaming it breaks every Proxmox call the agent makes; there is nothing to gain
by changing it.

If a provision later fails with a 403 naming a privilege, add it to the role
(`pveum role modify FluxHubAgent -privs "…"`) rather than escalating to `PVEAdmin`.

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

### 0.3 Choose an ISO storage — you do not download the ISO

Pick an ISO storage every attested host can read and note its **storage ID**; it becomes
`PROXMOX_STORAGE_ISO`. That is the whole step: the agent downloads the ArcaneOS/FluxLive
ISO itself, checksum-verifies it, uploads it to that storage on every declared host at
startup and every 6h, and adopts the new name into `ARCANE_ISO` in-process (Step 5's *ISO
auto-refresh*).

⭐ **On a cluster, choose a shared storage** — NFS, CIFS, or anything Proxmox marks
`shared`. The agent stages the ISO onto whatever storage each host names, so a shared
target is written **once and seen by every node**, and a new ArcaneOS release lands
everywhere in one refresh. Name per-host storage instead and you get one copy per host,
each refreshed separately — which is one more place for a single host to sit on a stale
ISO. `mt-manifest init` labels shared storages in its list and offers one as the default:

```
storages on pve30: ssd(SSD) local-lvm(HDD) pve55-shared(NFS, shared) local(dir)
  (9 more defined in the cluster but not usable here: ss1, ss2, ss3, …)
```

Storages belonging to *other* hosts are listed separately rather than as choices: a
cluster defines storage globally, so every host's storage list also carries every other
host's local pools.

⚠️ The auto-staging is scoped to **declared inventory**. Skip Step 5 and the agent has no
record of your node names: `ARCANE_ISO` then stays whatever you set by hand, and a
provision against a stale build fails outright. If you are staging an ISO manually for
that reason, note its filename too.

---

## Step 1 — Generate your signing key + config

The signing tool is the published image **`ghcr.io/w2vy/mt-manifest`** — no source
checkout, no Node install. It's secret-free: your key is generated into the mounted
working directory, never baked into the image.

⚠️ **Define it as a shell function, not an alias.** An alias does not expand when it
appears as an argument to another command, so wrapping it (in a script, a `time`, a
capture harness, `sudo`, `watch`) fails with `command not found`.

```sh
mt-manifest() {
  local img=ghcr.io/w2vy/mt-manifest:latest
  local stamp="${XDG_CACHE_HOME:-$HOME/.cache}/mt-manifest.pulled"
  # Refresh the image at most once every 48h, tracked by a stamp file.
  if [ ! -e "$stamp" ] || [ -n "$(find "$stamp" -mmin +2880 2>/dev/null)" ]; then
    if docker pull -q "$img" >/dev/null 2>&1; then
      mkdir -p "$(dirname "$stamp")" && touch "$stamp"
    else
      echo "note: could not refresh $img — using the cached image" >&2
    fi
  fi
  docker run --rm -i -v "$PWD:/work" -u "$(id -u):$(id -g)" "$img" "$@"
}
mt-manifest keygen             # writes manifest-key.pem (KEEP SECRET, 0600) + prints your pubkey
```

⚠️ **The `-i` is load-bearing.** Without it the container gets no stdin, and `init` — the
only subcommand that asks questions — prints its first prompt and exits at EOF, with no
error. Every other subcommand works fine, so the tool looks half-broken rather than
mis-invoked.

⚠️ **`docker run` never re-pulls**, so without the refresh above you keep running whatever
image you first pulled — for as long as that is, while the docs describe a newer one. That
is what the stamp file is for: one pull every 48 hours, roughly a second when the image is
already current (it is a digest check; no layers move). If the registry is unreachable it
says so once and runs the cached image rather than blocking you.

`find -mmin +2880` is deliberate: `-mtime +2` rounds to whole days and would mean *older
than 72h*, which you would only notice as a refresh that did not happen. To pull on every
invocation instead, drop the whole block and add `--pull always` to the `docker run`.

**Run `keygen` before `init`, in that order.** `init` requires the key: it fills
`MANIFEST_KEY` in both env files from it and pins `MANIFEST_PUBKEY`, and it refuses to
run without it rather than writing files with three holes in them.

Every `mt-manifest` command below reads and writes the **current directory** — run them
all from the same folder.

### ⭐ The fast path: `mt-manifest init`

`init` asks about eight questions and writes **every** file this guide would otherwise
have you create by hand — `config.env`, a `secrets.env` skeleton, `.env.operator`,
`inventory.json`, and the Flux app spec:

```sh
mt-manifest init
```

It exists because the values in those files are **duplicated across them**, and every
transcription is a chance to make a deployment that half-works. `init` derives each
duplicate from one answer, so whole categories of failure stop being possible rather
than merely being checked for:

- `COALITION_URL` is derived from your Flux **app name** — the URL is always
  `https://<app>.app.runonflux.io`, so you never have to know it in advance.
- `HOSTS` and the host names in `inventory.json` come from the same answer, so the
  unattested-host rejection cannot happen.
- **Your LAN is one answer per WAN IP**: the gateway *with* its prefix,
  `192.168.87.1/24`. Every slot address is then either a host number (`5` →
  `192.168.87.5/24`) or a full IP, and it always carries the prefix. A bare `lanIp`
  becomes `/32`, and the node boots with no gateway and is reachable by nobody — asking
  for the prefix once is what makes that unwritable rather than merely detected later.
- **Slots are grouped under the WAN IP they answer on.** A host is not one public
  address: pve40 fronts several, and each carries its own LAN. So the loop is *WAN IP →
  its LAN → the nodes behind it*, and you type each WAN IP once no matter how many nodes
  sit on it. Type `next` at the port prompt to move to the next WAN IP; leave the WAN IP
  blank when every slot is placed.
- **API ports are allocated, not asked 31 times**: each slot's prompt is pre-filled with
  the next port, so Enter is the whole answer. The block is **16127–16197 in steps of
  10** — they all end in 7 — and it **restarts at 16127 for every WAN IP**, because a
  port only collides with another node on the same public address. Type a port yourself
  and the wizard carries on from there. That block is also *why* a WAN IP tops out at
  eight slots: Flux serves a small run of consecutive ports per node, so there is no
  ninth. When the block is spent, `init` moves you to the next WAN IP and says so. At the
  end you get the port-forward list *grouped by WAN IP*, which is the shape of the
  firewall rules you have to create.
- **Questions are in the order you can answer them**: who you are, then what you sell,
  then a per-host stock-take of the hardware last — with your Proxmox's own node and
  storage names offered as the defaults, because `init` has already connected by then.
- Prices are asked in **dollars** and converted, so an extra zero cannot slip in.
  Each tier has a minimum FH will accept; `init` defaults to it and refuses less.

If you are running nodes only for yourself, answer **Supporter**: the scaffold then
lists no tiers, says so where Stripe would have been asked about, and offers nothing for
sale. An Operator offers every slot they declared — `init` no longer asks, because the
answer was always "all of them"; hold some back later by editing `AGENT_LISTING_JSON` in
`config.env`.

A Supporter can still be *given* nodes: a rental an admin **assigns** to you involves no
payment method at all. Stripe is what lets strangers buy from you.
- **`init` finishes what it can.** It signs `manifest.json` for you — the file Step 2
  asks you to paste — so there is no separate `sign` command to remember on a first run.
  `MANIFEST_KEY` is derived from `manifest-key.pem`
  and written to both files, `MANIFEST_PUBKEY` is pinned, `SESSION_SECRET` is generated,
  and you are asked for the Proxmox token pair (Step 0.1 already printed it) and — if
  you are selling — your Stripe keys.
- So an empty value in the generated `secrets.env` means **another system has to issue
  it**, not that a question was skipped. On a self-hoster's first run exactly three are
  empty: `AGENT_KEY`, `COALITION_KEY`, `COALITION_SIGNING_KEY`, all minted by `/onboard`.
  Each comment stays on its own line, because a comment after `=` becomes part of the
  value — which is why the file is generated rather than described.

Re-runnable and scriptable: `mt-manifest init --answers answers.json` takes the same
answers as a file and runs the same generator, so you can fix one typo without
re-answering everything.

### Check your work at any point: `mt-manifest doctor`

```sh
mt-manifest doctor
```

Reads whichever of the files exist and reports anything that disagrees — values that
differ between two files, an inventory host missing from `HOSTS`, a `lanIp` with no
`/NN`, a `$(…)` that will ship literally, a trailing comment swallowed into a value, a
secret sitting in a non-secret file, a price under the platform floor, or a courier
that will start silently disabled. By default it holds no credentials and touches no
network.

Empty values in a fresh `secrets.env` are reported as **not yet filled**, naming the
step that issues each one — that is expected on first run, not an error. After `init`
there should be exactly three of them (five if you are selling and have not created the
Stripe endpoint yet); anything else is worth looking at.

Two opt-in flags cross the file boundary deliberately, because the two costliest
failures are invisible to any amount of file comparison. Both are read-only:

```sh
mt-manifest doctor --check-proxmox   # the token really works; your image storage really is an SSD
mt-manifest doctor --check-stripe    # the webhook endpoint is on YOUR Stripe account
```

`--check-proxmox` connects with the credentials in `.env.operator`, proves the token,
checks the role holds the privileges the agent uses on every provision — naming any that
are missing, with the `pveum role modify` line that adds them — and resolves
`PROXMOX_STORAGE_IMAGES` through LVM to the physical device to see whether it spins.
`init` runs these same checks the moment you type the token; this is for re-runs and for
files you filled in by hand.

⚠️ **Prefer an IP address in `PROXMOX_URL`.** `mt-manifest` runs in a container, so a
hostname is resolved by the *container*, not by your shell — `pve30` can work at your
prompt and fail inside. The probe tells those apart rather than blaming your token.

⚠️ The deeper agent-side checks (CA trust store, the ISO actually present in the ISO
storage, `MANIFEST_KEY` matching the pinned pubkey) still run in the agent image as
`mt-agent doctor` (Step 6).

⚠️ **`keygen` is a once-ever act.** `manifest-key.pem` *is* your provider identity: FH
pins its public half as `Provider.manifestPubkey` at onboarding, and re-running `keygen`
silently overwrites it, after which every signature you produce is rejected. Back it up
before you go further. Recovery is possible — re-paste a manifest signed with the new
key at `/onboard` and sign with the pinned owner wallet — but it is a deliberate
rotation, not an accident you want to have.

Create a **`config.env`** — your single **non-secret** source of truth. It drives *both*
the signed manifest and the Coalition's runtime config, so the two can never drift:

> ⚠️ **Comments must be on their own line.** The parser only strips *full-line* `#`
> comments; a trailing `KEY=value   # note` keeps `value   # note` as the value. A
> stray inline comment on `COALITION_URL` breaks FH's ability to reach your Coalition.

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
# NOT necessarily the ZelID that owns your Flux app: that identity is whatever you are
# logged into FluxOS as in Step 4, and the two can differ. This one is the wallet you
# will sign with at /onboard.
OWNER_ADDRESS=<the wallet address you sign with>
# PROVIDER_LEVEL — supporter (own nodes + Foundation nodes, nothing for sale) or
# operator (also rents hardware out). Optional: omitted means operator, which is what
# every provider onboarded before this field existed is.
PROVIDER_LEVEL=operator
# MT_PUBKEY — FILL THIS IN. Fetch it now: curl {MT_BASE_URL}/api/mt-pubkey
# Only the Coalition consumes it, to verify FH's inbound calls are really from FH.
#
# ⚠️ Leaving it blank is a DELAYED failure, not a deferred decision. Onboarding, the
# agent and node provisioning all work without it; what breaks later is the
# checkout/manage leg, and it breaks quietly — so the symptom shows up long after the
# step that caused it.
#
# ⚠️ It is PER-FH. Each Flux Hub instance has its own signing key, so a Coalition
# moved between instances (e.g. staging -> production) needs MT_PUBKEY changed as well
# as MT_BASE_URL; repointing the URL alone leaves it pinned to the old instance's key.
# Neither field is in the signed manifest, so changing both needs NO re-sign — edit
# config.env, re-run `mt-manifest env`, re-import.
MT_PUBKEY=<your FH pubkey>
# HOSTS — the Proxmox hosts you attest, as a comma-separated list of ProxmoxHost.name.
# This is the owner-signed hardware list: FH rejects any inventory host not named here,
# so adding a machine later means re-signing the manifest (see "Ongoing operations").
HOSTS=pve-01,pve-02
# TIER_PRICES_JSON — runtime price in integer CENTS per tier. NOT in the signed manifest,
# so you can change price without re-signing. Must be >= the platform floor for the tier
# (cumulus $7, nimbus $20, stratus $40) — FH rejects a listing below it with a 422.
# CHECK YOUR ZEROS: these are CENTS, so nimbus at $20 is 2000, not 20000.
TIER_PRICES_JSON={"cumulus":700,"nimbus":2000}
TRIAL_DAYS=1
MANUAL_APPROVAL=false
```

Sign the manifest from it. **If you used `init`, this is already done** — it wrote a
signed `manifest.json` from the same `config.env`, and you only need this command again
after you EDIT `config.env`:

```sh
mt-manifest sign          # key, config and output all default to what `init` wrote
mt-manifest verify --in manifest.json
# expect: OK — manifest signature valid (bare manifest, no owner authorization)
```

⚠️ **A signed manifest is a snapshot of `config.env`.** Change a price, a host, your
trial length — anything that reaches the manifest — and `manifest.json` still carries the
OLD values, correctly signed. Submitting it then ingests the old provider with every
signature valid, which nothing downstream can detect. `mt-manifest doctor` compares the
two and fails with `MANIFEST_STALE`, naming the fields that moved; `mt-manifest sign`
clears it.

⚠️ **"bare manifest, no owner authorization" is the correct and expected result.** Under
the old flow you then ran `mt-manifest authorize` to wrap it in a wallet signature. You
do not any more — the wallet signature happens in your browser in Step 2 and is retained
by FH. **The bare `manifest.json` is what you submit and what your Coalition publishes.**

`manifest.json` carries `HOSTS` (the hardware you attest, owner-signed) and your
identity. It does **not** carry price — `TIER_PRICES_JSON` feeds runtime pricing only —
and it does not carry tiers or slot counts, which derive from the inventory your agent
asserts, constrained to the attested hosts.

---

## Step 2 — Onboard: paste and sign

Open **`{MT_BASE_URL}/onboard`** in a browser on a machine with your wallet. You do
**not** need a login, a Coalition, or anything deployed — only `manifest.json`.

1. **Paste the whole of `manifest.json`** into the box and press **Continue**. FH
   verifies the ed25519 signature and shows you the slug you are claiming and the owner
   address the manifest declares. Check that address — it is the wallet you must sign
   with, and it is taken from the bytes you signed, not from anything you can change now.
2. **Sign with your wallet.** SSP signs in-browser; "Sign with Zelcore" opens a deep
   link and posts the signature back automatically. The page holds your manifest the
   whole time — FH never stores an unverified manifest server-side.
3. **You are handed three keys, shown once.** Copy all three immediately (the page has a
   "Copy all three (`secrets.env`)" button):

   | Key | Direction | Where it goes |
   |---|---|---|
   | `AGENT_KEY` | your agent + Coalition → FH | Coalition env (Step 4); optional on the agent (Step 6) |
   | `COALITION_KEY` | FH → your Coalition (`/checkout`, `/manage`) | Coalition env only |
   | `COALITION_SIGNING_KEY` | signs your Coalition's outbound reports to FH | **store it; nothing reads it yet** |

⚠️ **`COALITION_SIGNING_KEY` has no consumer today.** It is issued ahead of the Phase D
verifier so nobody onboarded in the meantime has to be re-opened. FH keeps only the
public half, which means **the copy you were just shown is the only one that exists** —
if you lose it, the only recovery is an admin key re-issue that rotates all three, and
that means a fresh `env.json` import plus an agent restart. Put it somewhere durable
alongside `manifest-key.pem` and forget about it until Phase D ships.

Your provider now exists at FH in status `pending`. Step 7 activates it.

> **Re-running `/onboard` later is safe and is the supported path** for refreshing your
> attested `HOSTS` or rotating your manifest key: paste the newly signed manifest, sign
> with the same pinned owner wallet. Keys are **not** re-issued on a refresh — only a
> first ingest issues them.

---

## Step 3 — Stripe setup *(Operator only)*

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
   Least privilege matters here more than it looks: this key lives in your Coalition's
   Flux app environment, and how you deploy that app decides who can read it (Step 4).

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

The Coalition runs as a **published Docker image** (`w2vy/coalition:0.2.8`) deployed as
a Flux App. Config, secrets, and your signed manifest are all supplied as **Flux
environment variables** — nothing to mount. Because Step 2 already gave you the real
keys, this is a **single deploy**; there is no placeholder-then-re-import round trip.

The generated `flux-app-spec.json` carries **no `owner`** on purpose. FluxOS sets it from
the ZelID you are logged in as (it overwrites any value an imported spec supplies), and
that identity is not necessarily your `OWNER_ADDRESS`. Registering through the Flux API
directly rather than the UI is the one case where you must supply an owner yourself.

**1. Assemble the secrets.** Alongside `config.env` keep a private **`secrets.env`**
(never commit, `chmod 600`):

Same rule as `config.env`: **comments on their own line only** — a trailing comment
after `AGENT_KEY`/`COALITION_KEY` becomes part of the key and FH will reject it (401).

```sh
# secrets.env
STRIPE_SECRET_KEY=rk_live_<restricted>
STRIPE_WEBHOOK_SECRET=whsec_<from step 3>
# SESSION_SECRET — SET THIS. Any long random string; it is only an HMAC key for the
# console session cookie, so `openssl rand -hex 32` is all it needs to be. Leave it
# blank and the console still works, but the NODE DASHBOARD IS WITHHELD — your
# Coalition is a public Flux App, and without this there is no login gate, so the
# dashboard would publish your node names, tiers, live status and your customers'
# rental codes to anyone with the URL. Node ACTIONS are wallet-signed either way.
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
mt-manifest env          # in the scaffold directory: reads config.env, secrets.env,
                         # manifest.json and writes env.json beside them
```

Every path defaults to the name `init` wrote, so there is nothing to type. Override any
of them if your layout differs, or add `--stdout` to print instead of writing a file:

```sh
mt-manifest env --from-config config.env --secrets secrets.env \
  --manifest manifest.json --out env.json
```

`env.json` is a JSON array of `"KEY=value"`. It embeds your manifest as `MANIFEST_JSON`
(verifying the signature first) and passes `TIER_PRICES_JSON` through. **It contains
secrets — do not commit it.**

You never set a variable on the Flux app by hand: non-secret settings live in
`config.env`, secrets in `secrets.env`, and `mt-manifest env` merges both into
`env.json`, which is the only thing the app ever sees. So `SESSION_SECRET` goes in
**`secrets.env`** and reaches Flux via `env.json` — changing it later means editing
`secrets.env`, re-running the command above, and re-importing.

⚠️ A **blank** value is dropped, not passed through as empty: `mt-manifest env` omits
any variable with no value, so leaving `SESSION_SECRET=` in `secrets.env` is identical
to never listing it, and the console will withhold the node dashboard.

**2. Register the Flux App:** Docker image `w2vy/coalition:0.2.8`, container port
**8088**, then supply `env.json` as the app's environment.

🔒 **Register it as an ENTERPRISE app.** That is the whole answer to both problems
below; there is no second option to weigh up. The environment is encrypted into a single
`enterprise` blob with `environmentParameters: []`, and Flux Cloud is used to carry it —
you do not choose or upload that separately. Both production Coalitions are deployed
this way.

Two reasons it is not optional:

- **Your secrets would otherwise be public.** A Flux app's plaintext environment is
  **world-readable**, and `env.json` holds your Stripe secret key. Anything that leaves
  it in the clear hands your merchant credentials to anyone who looks.
- **It would not fit anyway.** Flux caps a plaintext environment parameter at 400
  characters and `MANIFEST_JSON` is far longer, so pasting `env.json` into
  **Environment Variables → Import** fails with *"App component coalition environment
  MANIFEST_JSON=… is too long. Maximum of 400 characters is allowed"*.

**3. Verify:** `<COALITION_URL>/health` → `{"ok":true,"provider":"…","coalitionVersion":"…"}`
and `<COALITION_URL>/.well-known/mt-provider.json` returns your manifest.

Changing env later (rotate a secret, change tiers, re-sign the manifest) is a **free
re-import** of a fresh `env.json`, then Flux's **Free Deploy**.

⚠️ **A secret-only change can leave the app spec byte-identical**, in which case the
re-import is a silent no-op. Always verify downstream (`/health`, a real checkout)
rather than trusting that the import took.

⚠️ **Pin the version this guide names; do not pin an OLDER one.** A published image
predating a protocol change cannot complete onboarding — `coalition:0.2.4` was built one
day before the protocol gained owner-attested `hardware[]`, and the hub 409s an unattested
host, so that tag can never finish onboarding no matter how carefully you follow this.

The versions above (`coalition:0.2.8`, `mt-agent:0.3.0`) are what production runs and are
known to complete the whole flow. `:latest` also works and is what the fleet tracks, but
pinning is what makes YOUR onboarding reproducible: if a run half-succeeds, you want to be
able to say which image did it.

⚠️ **`mt-manifest` is the exception — use `:latest` for it.** Its publish workflow emits
only `latest` and a commit SHA, so its `0.1.0`/`0.2.0` tags are stale hand-pushed
leftovers: `0.2.0` has no `doctor` and no `authorize` subcommand at all, so pinning it
would break this guide's own instructions. Pin it to a commit SHA if you need
reproducibility today.

---

## Step 5 — Declare your inventory (no DB hand-edits)

Your agent-managed hosts and slots are **declared by you**, not inserted into FH's
database by an admin. Create a **dedicated subdirectory** for it — the agent mounts that
directory, and nothing else in it should be readable by the container:

**`init` already wrote this** — `data/inventory.json`, in a directory of its own, because
that directory is what the agent bind-mounts at `/data` in Step 6. Edit it in place:

```sh
$EDITOR data/inventory.json
```

If you are writing one by hand instead, `mkdir -p data` first. Keep `data/` scoped to
`inventory.json` alone — `.env.operator` and `manifest-key.pem` have no business being
readable inside the agent container.

```json
[
  {
    "name": "pve25-lab",
    "nodeName": "pve25",
    "apiUrl": "https://pve25:8006",
    "network": "vmbr0",
    "storageImages": "ssd",
    "storageIso": "shared-iso",
    "slots": [
      { "vmName": "mt-you-n1", "tier": "nimbus", "lanIp": "192.168.1.51/24",
        "ipAddress": "203.0.113.51", "gateway": "192.168.1.1", "apiPort": 16197,
        "network": "vmbr0", "storagePool": "ssd" }
    ]
  }
]
```

- `name` is the globally-unique host label (`ProxmoxHost.name`), distinct from
  `nodeName` (the Proxmox node). Every `name` here **must** appear in `HOSTS` in
  `config.env` — FH rejects the *whole* assert with a 409 naming any unattested host.
- ⚠️ **`lanIp` needs its CIDR suffix.** A bare `192.168.1.51` is interpreted as `/32`,
  the VM comes up with no route to its gateway, and the node never reaches the network.
- `storageImages` / `storageIso` override the agent's defaults per host — use them when
  hosts differ (see Step 0.2; this is where you keep VMs off the spinning disk).
- ⚠️ **Repeat `network` and `storagePool` on every SLOT.** FH builds your `Slot` rows from
  the per-slot fields only, so a host-level-only value leaves every Slot row with an empty
  `storagePool`/`network` — silently, and `doctor` still passes because it checks the
  host-level value you did write. Provisioning follows the same precedence
  (`slot.storagePool ?? host.storageImages`, `slot.network ?? host.network`), so per-slot
  values are also what let one machine carry slots on two bridges or two pools.
  `mt-manifest init` writes both levels for you.
- Omit optional fields like `vlan`/`rateLimit` rather than setting them `null`.
  `dns1`/`dns2` default to `8.8.8.8`/`1.1.1.1`.

The agent asserts this to FH (`PUT /api/agent/inventory`) on startup and each heartbeat,
**provider-scoped**: FH upserts your `ProxmoxHost`/`Slot` rows, never touches another
operator's inventory, and never hard-deletes a rented slot.

⚠️ **The assert is upsert-only.** Deleting a host or slot from this file removes
*nothing* at FH — the rows stay, and the slots stay sellable. Retiring hardware is an
admin action, not a file edit.

Because the agent **re-reads the file every heartbeat**, edits apply without a restart —
**only if you mount `./data` as a directory** (Step 6). (Alternative: inline
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
# The PUBLIC half, from manifest-pubkey.txt. Not a secret: it is the pin `mt-agent
# doctor` compares MANIFEST_KEY against. Leave it out and that check can only report
# `skip`, so a wrong key is not caught until FH rejects a signature.
MANIFEST_PUBKEY=<contents of manifest-pubkey.txt>
AGENT_KEY=<agentKey from /onboard>
OWNER_ADDRESS=<the wallet address you sign with>
COALITION_URL=https://<your-coalition>
AGENT_INVENTORY_PATH=/data/inventory.json
# Local Proxmox — creds NEVER leave your host. Use an address the CONTAINER can reach:
# your Proxmox LAN IP (not 127.0.0.1, which is the container's own loopback), or run with
# `--network host` if the agent runs on the Proxmox host itself.
PROXMOX_URL=https://<proxmox-lan-ip>:8006
PROXMOX_TOKEN_ID='fluxhub@pve!agent'
PROXMOX_TOKEN_SECRET=<secret from Step 0.1>
PROXMOX_NETWORK=vmbr0
PROXMOX_STORAGE_IMAGES=<a ROTA=0 storage ID — see Step 0.2>
PROXMOX_STORAGE_ISO=<your ISO storage ID>
ARCANE_ISO=<your ArcaneOS ISO name>
# Price + how many slots to offer for sale (re-asserted to FH each heartbeat).
# How much hardware you HAVE comes from your inventory, not from here.
AGENT_LISTING_JSON='[{"tier":"nimbus","priceCents":2200,"availableSlots":8}]'
```

### `MANIFEST_KEY`: what it is and how to produce it

`MANIFEST_KEY` is **not a new key and it does not change**. It is the base64 encoding of
`manifest-key.pem` — the same file `keygen` wrote in Step 1 — flattened to one line so
it survives an env var. Encoding it twice gives the identical string; if it ever changes,
your key changed, and that is a problem.

**`mt-manifest init` already wrote it into both files**, so there is normally nothing to
do here. To produce it by hand (an env file you maintain yourself, or a value you
emptied):

```sh
base64 -w0 manifest-key.pem       # paste the output as the literal value
```

🔴 **If `MANIFEST_KEY` is empty, do NOT run `keygen` to "get it back".** `keygen` mints a
NEW identity, and FH still holds the public half of the old one — every signature you
then produce is rejected. The value comes from the key you already have.

⚠️ **`docker --env-file` performs no shell expansion.** Writing
`MANIFEST_KEY=$(base64 -w0 manifest-key.pem)` into `.env.operator` stores and transmits
that text *literally*. Auth then fails as a bare **401** with nothing pointing at the
cause. The same applies to `${VAR}` and to wrapping quotes — `--env-file` values are
taken verbatim, quotes included.

To confirm the key is the right one, decode it and compare the derived pubkey with the
`Provider.manifestPubkey` FH pinned for you at onboarding.

### Mount the directory, not the file

Mount `./data` read-only at `/data`, which is where `AGENT_INVENTORY_PATH`
resolves inside the container. A **single-file** bind mount pins the container to that
file's *inode*, and most editors save atomically via write-new-then-rename, which
detaches the mount — host edits silently stop reaching the container (no error, it just
keeps serving stale content) until the container is recreated.

### Dry run, then run

### ⭐ First, the hypervisor preflight: `mt-agent doctor`

Before any VM is created, run the credentialed checks — read-only, creates nothing:

```sh
docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" \
  w2vy/mt-agent:0.3.0 doctor
```

It exits non-zero if anything fails, so it works as a gate. It checks that Proxmox is
reachable and your token is accepted, that the CA trust store is present, that each
`storageImages` id exists **and is not a spinning disk**, that `storageIso` actually
holds the ArcaneOS ISO, and that `MANIFEST_KEY` decodes to a key whose public half is
the one FH pinned.

⚠️ **The storage check is the one that pays for this step.** A pool on rotational media
provisions fine and then fails benchmarks with no visible cause — the single most
expensive silent failure in this whole guide (§0.2). `doctor` resolves the storage id
through its LVM volume group to the actual device and refuses it, e.g.:

```
FAIL  pve30: storageImages "local-lvm" is not rotational
      local-lvm → VG pve → /dev/sda (rotational) — VMs will land on a spinning disk
```

If it reports `could not resolve …`, the storage is not LVM-backed and you must confirm
the media yourself; an honest "cannot tell" is deliberate rather than a guess.

Validate connectivity/auth to FH first, **without touching Proxmox**:

```sh
docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" \
  -e AGENT_DRY_RUN=1 w2vy/mt-agent:0.3.0
# expect: provider=… mt=… dryRun=true auth=signature ownerAuth=enforced courier=on
```

Read that banner. `auth=signature` means `MANIFEST_KEY` loaded; `courier=on` means the
owner-authorization courier is live.

⚠️ **The courier switches itself off silently** unless `MANIFEST_KEY` **and**
`COALITION_URL` **and** `OWNER_ADDRESS` are all set. There is no warning — you simply
never receive authorization requests, and deletes/reprovisions sit forever.

Then run it for real. **`init` wrote `compose.yaml` for you** — pinned image, `./data`
mounted as a read-only directory, its own project name, no published ports:

```sh
docker compose up -d          # start
docker compose logs -f        # watch
docker compose down           # stop and remove
```

⚠️ **After editing `.env.operator`, use `docker compose up -d --force-recreate`.**
`docker compose restart` re-reads nothing, and whether plain `up -d` notices a changed
`env_file`'s *contents* varies by compose version. Same trap as `docker restart` with
`--env-file`, and the single most common reason a corrected key keeps returning 401.

The equivalent without compose, if you prefer:

```sh
docker run -d --name mt-agent --restart unless-stopped \
  --env-file .env.operator -v "$PWD/data:/data:ro" w2vy/mt-agent:0.3.0
# any env edit then needs: docker rm -f mt-agent && the above again
```

⚠️ If you see **"self-signed certificate in certificate chain"**, the image is missing
its CA store — it is not a middlebox on your network and not a Proxmox cert problem.

(`docker-compose.operator.yml` in the repo is a different thing: it **builds from a
source checkout** and runs both legs. The generated `compose.yaml` is the one you want.)

`priceCents` must be ≥ the FH platform floor and should match `TIER_PRICES_JSON` in the
Coalition.

---

## Step 7 — Activation and the operator console

FH reviews your `pending` provider and **activates** it; your cards then appear on
`/providers`. Within a minute of activation the agent's heartbeat publishes your price
and slots offered (admin → Providers shows `lastAsserted`).

Owner authorization for privileged actions is a **wallet signature you make yourself**.
There are two places you can make it, and they are equivalent — the same claim, the same
signature, the same verification by your agent.

⚠️ **Which actions you can sign today.** Your agent enforces a signature on all three
privileged actions — `delete`, `reprovision` and `move` — but only two of them have a
place to sign:

| action | signable | how |
|---|---|---|
| `delete` | ✅ | the flow below — a cancellation puts the slot in `pending_delete` |
| `move` | ✅ | as a `delete`: moving a rental queues a teardown of the source slot, and that is what appears in your queue |
| `reprovision` | ❌ **not yet** | no signing surface exists; the job is refused with `owner authorization refused: missing owner authorization` |

**Nobody can authorize a reprovision right now — not you, and not Flux Hub.** If a node
needs one, see "When to contact Flux Hub admin" at the end of this step. A job-driven signing
queue that covers all three is the next piece of work on this.

**Your own Coalition console is the primary path**, and the only one that works without a
Flux Hub login:

1. A customer cancels → FH marks the slot `pending_delete`.
2. Your **agent** fetches the pending list (`GET /api/agent/pending-auth`, signed) and
   **pushes it to your Coalition console**.
3. You open `<COALITION_URL>/console`, click the pending action, and **sign it in your
   wallet** (SSP in-browser, or "Sign with Zelcore" — the deep link posts the signature
   back automatically). The console verifies the signature recovers to `OWNER_ADDRESS`
   before queueing it — that per-action signature **is** the login.
4. Your agent **polls the console**, re-verifies the signature locally, and relays it to
   FH (`POST /api/agent/authorize`) → FH enqueues the job → the agent executes it.

⚠️ **A failed relay destroys the signed blob.** The Coalition hands it over exactly
once; if the handoff fails you must sign the action again. The courier log is the only
place this is visible.

### The alternative: signing at Flux Hub's `/operator`

If you sign in at `{MT_BASE_URL}` with your `OWNER_ADDRESS` wallet, Flux Hub shows the
same pending teardowns at **`/operator`** and lets you sign them there. Sign with SSP
in-page, or "Open in Zelcore" — the deep link posts the signature back on its own and the
page continues without you pasting anything. A paste box is there as a fallback for
signing on a different machine.

This is an **alternative to, not a replacement for**, your Coalition console. Use whichever
is in front of you:

- your console works with **no Flux Hub account at all** and is the one to rely on;
- `/operator` is convenient when you are already signed in to Flux Hub, and it does not
  depend on your Coalition being reachable.

The trust model is identical either way. Flux Hub is a **dumb relay**: it shape-checks
the signed claim, binds it to the slot it names, and stores it. **Your agent re-verifies
the signature against its own pinned owner address before it deletes anything**, so a
compromised Flux Hub still cannot destroy your nodes. The claim is bound to one action
on one node and expires, so it cannot be replayed against another.

The Coalition holds **no keys** for this and never calls FH — it is a UI + signature
courier. The manifest key (agent↔console auth) stays on the agent; the owner key stays
in your wallet. Wrong-owner, expired, and replayed signatures are refused at both the
console and the agent.

### When to contact Flux Hub admin

You own the hardware, so most problems are yours to fix on your own Proxmox. Two are not,
and improvising on them will leave Flux Hub's view of the slot out of step with reality:

- **A node needs reprovisioning.** The usual reason is a rented node that boots but whose
  ArcaneOS data crypt did not come up — the VM keeps running, so nothing looks obviously
  dead from the outside. As above, there is no way to authorize a reprovision yet. Do not
  rebuild the VM by hand: Flux Hub's record of the slot would still describe the old one.
  Report it to Flux Hub admin instead.
- **A slot is stuck in `provisioning` or `pending_delete`** and signing does not clear it.

Include the **VM name** (e.g. `mt-187-c4`), your **provider slug**, and roughly **when** it
happened — that is enough to find the job.

---

## Verify it works end to end

- **Manifest**: FH admin shows your provider with the right `Coalition URL`, attested
  hosts, and freshness once it pulls stats/listing.
- **Inventory**: your hosts appear with the slots you declared, in `available`.
- **Listing**: your price + slots offered land at FH within a heartbeat.
- **Stats**: FH pulls `/stats`; benchmarks/uptime appear on your card.
- **Checkout (test)**: with Stripe in test mode, rent one of your tiers from
  `/providers` → you get a Stripe Checkout (your account) with a trial → FH records a
  rental → your agent provisions the node → result flows back.
- **Authorization**: cancel that test rental and confirm the pending action shows up in
  `<COALITION_URL>/console` — and, if you have a Flux Hub login, at `/operator` too.
  Signing in either place should complete the teardown; watch the slot return to
  `available`.

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
FH withholds the customer's "go start your node" email until the node's benchmarks pass
**and** its collateral clears 100 confirmations (typically ~50 minutes after the
collateral funding tx is mined).

**Your Coalition owns this check, not the agent.** Every ~2 minutes it polls each of
your still-maturing nodes' benchmark endpoint plus the public Flux blockchain API and
reports the measurements to FH, which decides when to flip the node's status and email
the customer. You can see the live state — which nodes are still held, and why — on your
own `/console` page. This is why the Coalition must stay running after a node
provisions, not just during checkout.

## Key reference (which secret lives where)

| Secret | Generated by | Lives | Shared with |
|---|---|---|---|
| `manifest-key.pem` | you (`keygen`) | your machine + agent (`MANIFEST_KEY`) | **nobody** |
| manifest `pubkey` | derived | in the manifest, pinned at FH | public |
| owner wallet key | you | your wallet only | **nobody** |
| `agentKey` | FH (`/onboard`) | agent **and** Coalition env | you (once) |
| `coalitionKey` | FH (`/onboard`) | Coalition env | you (once) |
| `coalitionSigningKey` | FH (`/onboard`) | your safe keeping — no consumer yet | you (once, only copy) |
| Stripe restricted key | you (Stripe) | Coalition env | nobody |
| Stripe webhook secret | you (Stripe) | Coalition env | nobody |
| Proxmox API token | you (Proxmox) | agent env | nobody |

FH stores only a **hash** of `agentKey`, an **encrypted** copy of `coalitionKey`, and
the **public** half of `coalitionSigningKey`. It stores **none** of your Stripe or
Proxmox credentials, and never the private half of anything you generated.

## Ongoing operations

- **Change price / slots offered**: update `AGENT_LISTING_JSON` and **recreate** the
  agent container (`docker rm -f` + `docker run` — `restart` does not reload
  `--env-file`), and update `TIER_PRICES_JSON` in `config.env` → re-run `mt-manifest
  env` → re-import `env.json` (free) so the Coalition's prices match. No re-signing.
- **Add or remove a host**: add its `ProxmoxHost.name` to `HOSTS` in `config.env`,
  re-`sign`, re-paste at `/onboard` and sign with your pinned owner wallet, then re-run
  `mt-manifest env` and re-import `env.json`. Until FH re-ingests, it **rejects the
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
- **Rotate the issued keys**: an FH admin re-issues all three at once (the old ones stop
  working immediately); update `secrets.env`, re-import `env.json`, and recreate the
  agent container.
- **Staleness**: if FH stops seeing fresh stats *and* listing past the TTL, your
  provider auto-hides from the marketplace (data retained) and auto-re-lists on the next
  fresh update — so keep the agent and Coalition running.
- **Customer cancel/refund**: cancellation is free during the trial; afterward you are
  merchant of record — refunds/disputes are handled in your Stripe dashboard.

## Trust model (why this is safe)

- You hold **all** your own secrets; FH holds none of them. The agent is outbound-only
  with no inbound ports. The Coalition's only secrets are a restricted Stripe key +
  webhook secret — and they are protected by deploying the Coalition as a Flux
  **enterprise app**, whose environment is encrypted (Step 4). Nothing about ArcaneOS
  is involved: ArcaneOS is what the rented node VMs boot, not what the Coalition runs on.
- Ownership is proven by a wallet signature over your own manifest's bytes. FH can
  neither forge it nor change your owner address without a deliberate admin recovery
  action.
- Jobs FH sends your agent carry slot/network params + the customer's Flux identity key
  over TLS, but **never** Proxmox credentials — the agent injects its own. That identity
  key is node-scoped and cannot touch collateral.
- Collateral is a wallet UTXO, safe on any host; the residual risk (node identity-key
  exposure, uptime) is yours to manage and is reflected in your card's stats + reviews.
