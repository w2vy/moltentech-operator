# `fh-toolkit init` — a full run

A **redacted transcript** of one real onboarding, from `keygen` to a signed
`manifest.json`. It is here so you can see the shape of the run before you start one:
what gets asked, in what order, and what `init` writes at the end.

The run below is a **Supporter** — your own nodes plus Foundation nodes on your idle
capacity, nothing listed for sale, no Stripe account. That is the recommended first
step: it is the shortest path to a live agent, and it is the whole of onboarding minus
the money. The [second block](#what-an-operator-answers-differently) at the end shows
the handful of places an **Operator** run diverges — the same questions, plus tiers,
prices and Stripe.

**Redacted.** Every secret in this transcript was replaced with a same-format random
value — the manifest pubkey, the Proxmox token secret and the owner wallet address. The
public IP is in the `203.0.113.0/24` documentation range, the shell prompt is
`user@host`, and cluster-only storage names were trimmed. **Nothing here is a working
value** — do not copy one out.

**Captured against** `fh-toolkit` 0.3.0, build `a08d194`, 2026-09-13 — the current
tool, with the hub-first `init` (environment, then slug and VM-name prefix checked
against that hub), the per-file `slug` / `proxmox` / `stripe` / `inventory` commands, and
the `fh-agent` verbs. The cluster the probe listed was trimmed to three nodes. If anything
on screen differs from what is below, your `fh-toolkit` is the authority and this
transcript is stale.

## A Supporter run, start to finish

`fh-toolkit` with no arguments opens a small shell in the directory you ran it from; the
commands below are typed at its `fh-toolkit>` prompt. `fh-toolkit keygen` / `fh-toolkit init`
from your own shell do the same thing one command at a time.

```console
user@host:~$ mkdir fh-agent && cd fh-agent
user@host:~/fh-agent$ fh-toolkit
fh-toolkit 0.3.0
  build   a08d19412df0a5b4ffe734c2e222a0b5b29892fe
  built   2026-09-13T12:18:25Z
directory: /work
`help` lists the commands. `exit` or Ctrl-D leaves.

fh-toolkit> keygen
Wrote manifest-key.pem (KEEP SECRET — this signs your manifest).
Public key (manifest "pubkey", also saved to manifest-pubkey.txt):
Hda0us5va3rmegSNLcQpr0kaqu+b8Af8qRT4thA48Bw=

fh-toolkit> init
fh-toolkit init — this writes every onboarding file from your answers.

Flux Hub environment — 1) production  2) staging [1]: 2
  → https://staging.moltentech.us; the agent will run ghcr.io/w2vy/fh-agent:staging

Which are you?
  1) Flux Hub Supporter — your own nodes, plus Foundation nodes on your idle
     capacity. Nothing for sale, no Stripe account needed.
  2) Flux Hub Operator  — the above, plus hardware rented out through the
     marketplace. You are merchant of record on your own Stripe account.
  choose 1 or 2 [2]: 1
  → Flux Hub Supporter

Provider slug (lowercase, PERMANENT once ingested): cute-cats
VM name prefix (2–8 lowercase letters/digits, starting with a letter, ending in '-' (e.g. mt-); PERMANENT once ingested) [cc-]:
Display name [cute-cats]: Cute Cats
Location (shown on your marketplace card): US-WEST
Contact email: nodes@example.com
Owner wallet address (ZelID 1… or Flux t1…): t17gzsDFuzvstQRTN4QSwEbm9mBm4YYASYU
Confirm owner address is exactly "t17gzsDFuzvstQRTN4QSwEbm9mBm4YYASYU"? (y/N) [N]: y
Flux app name for your Coalition [coalition-cute-cats]:
  → COALITION_URL will be https://coalition-cute-cats.app.runonflux.io

Proxmox API token (onboarding Step 0.1):
  Proxmox URL (an IP always works; a name must resolve INSIDE the container) — or `skip` [https://192.168.1.10:8006]: https://pve75:8006
  PROXMOX_TOKEN_ID [fh-agent@pve!agent]: fluxhub@pve!agent
  PROXMOX_TOKEN_SECRET (printed once when you created it): 1f7fc36b-b579-441f-b87c-1520d2b7c5ac
  Wait while the token is verified…
  + Proxmox reachable and token accepted: https://pve75:8006
  + token holds the privileges the agent needs: 8 checked at / (self-reported by /access/permissions)
  + cluster nodes visible: pve30, pve55, pve75
  + pve30: storage readable: read local (12 storage(s) visible)
  + pve30: bridges visible: vmbr0
  + pve55: storage readable: read pve55-shared (12 storage(s) visible)
  + pve55: bridges visible: vmbr0, vmbr1, vmbr102, vmbr187
  + pve75: storage readable: read pve55-shared (12 storage(s) visible)
  + pve75: bridges visible: vmbr0

Stripe — skipped: a Supporter sells nothing and needs no Stripe account.

Now your hardware. Everything above was about you; this is a stock-take.
Proxmox host name(s), comma-separated [pve30,pve55,pve75]: pve75

— host pve75 —
  storages on pve75: pve55-shared(SSD) local-lvm(SSD) local(SSD)
    (9 more defined in the cluster but not usable here: ss1, ss8, raid5-storage, ss2, ss15, ssd, ss3, backup-dir, ss4)
  storage pool for VM images on pve75 (must be SSD) [pve55-shared]: local-lvm
  pve55-shared is shared — one ISO for the whole cluster, refreshed in one place.
  storage holding the ArcaneOS ISO on pve75 [pve55-shared]: local
  how many node slots does pve75 support? [1]: 1
  WAN IP (blank when done — 0/1 placed): 203.0.113.186
    LAN gateway WITH prefix, e.g. 192.168.87.1/24: 192.168.186.1/24
    → VMs on 192.168.186.x/24, gateway 192.168.186.1
    Flux API port (Enter, or 'next' for the next WAN IP) [16127]: 16147
    · slot 1 of 1
      tier (cumulus/nimbus/stratus) [cumulus]:
      VM name suffix (after "cc-") [pve75-c1]: 186-c4
      LAN address — host number (e.g. 5 for 192.168.186.5) or a full IP: 4
      storage pool (SSD) [local-lvm]:
    → 192.168.186.4/24, gateway 192.168.186.1, WAN 203.0.113.186, API port 16147, storage local-lvm

These must be reachable from outside your LAN, or Flux Hub cannot pull stats:
  203.0.113.186 → 16147
  → MT_PUBKEY pinned from https://staging.moltentech.us/api/mt-pubkey
Wrote config.env, secrets.env, .env.operator, data/inventory.json, flux-app-spec.json, compose.yaml, README.txt, manifest.json to /work (the directory you ran this from)

⭐ README.txt explains every file here and what to run when.

Already done, from the key in this directory:
  ✓ MANIFEST_KEY   filled in secrets.env and .env.operator
  ✓ MANIFEST_PUBKEY pinned in .env.operator (`fh-agent doctor` now compares, not skips)
  ✓ SESSION_SECRET generated
  ✓ manifest.json signed — this is the file you paste at /onboard
    (edit config.env later and it goes stale; re-run `fh-toolkit sign`)

Next, in order:
  1. open https://staging.moltentech.us/onboard, paste manifest.json, sign with t17gzsDFuzvstQRTN4QSwEbm9mBm4YYASYU
     → issues COALITION_SIGNING_KEY for secrets.env
  2. Stripe: not needed — you are not listing anything for sale.
  3. `fh-toolkit doctor`   ← run it here; it checks every file agrees
  4. `fh-toolkit env`      → env.json, the Flux "Import Environment Variables" blob
     built from config.env + secrets.env + manifest.json. CONTAINS SECRETS.
     then `fh-agent start` here to run the agent (compose.yaml is written)
  5. deploy Flux app "coalition-cute-cats" as an ENTERPRISE app, import env.json
     → https://coalition-cute-cats.app.runonflux.io
     ⚠️  enterprise, not standard: a standard Flux app's environment is
         WORLD-READABLE, and yours holds your signing keys.

fh-toolkit> exit
bye
user@host:~/fh-agent$
```

A few lines are worth stopping on.

- **The hub comes first now.** `init` asks which Flux Hub you are onboarding against
  before anything else, because the answer decides the agent image `compose.yaml` pins
  (`:staging` above; `:latest` for production) and where the slug and VM-name prefix are
  checked. Both are **permanent once ingested**; the prefix (`cc-` here, derived from the
  slug) is what every VM you provision will be named under, and `init` refuses one the hub
  already knows.
- **The Proxmox probe drives the rest of the stock-take.** Once the token verifies, `init`
  reads your real cluster — every node, its storages and bridges — and offers them as
  defaults, and it tells you which cluster storages are *not* usable on the host you pick.
  A hostname works only if it resolves *inside* the container (the Step 0.5 wrapper mounts
  `/etc/hosts` for exactly this); an IP always works. A failed probe re-asks rather than
  warning and carrying on.
- **The VM name is a suffix.** You are asked for the part after the prefix (`186-c4` →
  `cc-186-c4`), so every name you choose is already in your namespace.
- **`Stripe — skipped` is not a question you missed.** A Supporter sells nothing, so the run
  never asks, and `env.json` comes out with 11 variables instead of 12. It still holds
  your signing keys, so *enterprise* still applies — step 5 says so.
- **`/onboard` issues one key**, `COALITION_SIGNING_KEY`, and you paste it into
  `secrets.env` before `fh-toolkit doctor`. Your agent signs with `MANIFEST_KEY`, which
  `init` already filled in.
- **Step 4 ends in `fh-agent start`**, the shell function from Step 0.5 — not a compose
  command. `fh-agent doctor` first (onboarding Step 7), then `start`.

## What an Operator answers differently

An Operator run is the same run with money added: you answer `2` at "Which are you?",
name the tiers you will sell and their prices, and hand over a restricted Stripe key.
Nothing about the hardware stock-take, the manifest key, or the Flux app changes.

These are the only places the transcript above differs — the same run, answered as an
Operator. It is also, line for line, what `fh-toolkit stripe` asks (the per-file command
for this block) and what `fh-toolkit level --set operator` asks when you upgrade later:
the three share one implementation, so they cannot drift apart — the
[upgrade transcript](#upgrading-later-fh-toolkit-level---set-operator) below shows it.
The price floors are fetched from the hub you chose, not baked in.

```console
  choose 1 or 2 [2]: 2
  → Flux Hub Operator

…

Which tiers will you offer? (cumulus/nimbus/stratus, comma-separated) [cumulus]:
  monthly price for cumulus in DOLLARS (floor $2.50) [2.50]: 7.00

Stripe — you are merchant of record; Flux Hub never holds these.
  STRIPE_SECRET_KEY (rk_… / sk_…), blank to fill in later: rk_test_51T4WQ……………………………………………………………………CHI
  STRIPE_WEBHOOK_SECRET (whsec_…), blank if the endpoint does not exist yet: whsec_BzjZ……………………Y4k

…

Offered for sale: 1 cumulus (all of them — edit AGENT_LISTING_JSON in .env.operator to hold any back).

…

  2. Stripe: create the webhook endpoint against your Coalition URL.
     ⚠️  the webhook secret is bound to THAT endpoint — a secret from another
         endpoint fails silently and checkout never completes.

…

user@host:~/fh-agent$ fh-toolkit env
Wrote env.json (12 vars). Contains SECRETS — do NOT commit; import it into your Flux app's Environment Variables.
```

The two Stripe keys are shown head…tail with the middle elided, because a full-length
stand-in is indistinguishable from a live key to a secret scanner.

Note what an Operator run does **not** ask: which slots to list. Every slot you declared
is offered — the answer was always "all of them" — and you hold some back afterwards by
editing `AGENT_LISTING_JSON` in `.env.operator`. On an Operator's first run `secrets.env`
has three empty values rather than one: the key `/onboard` mints, plus the Stripe pair
if the webhook endpoint does not exist yet.

## Upgrading later: `fh-toolkit level --set operator`

The same Supporter, deciding to sell. Captured 2026-09-13 on the same build, from the
directory `init` wrote. `level` with no flags says where you stand; `--set operator` takes
the Operator answers as flags (or asks them, exactly the block above, when a flag is
missing) and shows the diff before writing anything.

```console
user@host:~/fh-agent$ fh-toolkit level
PROVIDER_LEVEL  supporter   (config.env)
signed manifest supporter   (manifest.json — in sync)
tiers for sale  none
Stripe          not configured — a Supporter needs no Stripe account

To sell hardware:  fh-toolkit level --set operator
user@host:~/fh-agent$ fh-toolkit level --set operator --price cumulus=7 --stripe-key rk_test_51T4WQ……………………………………………………………………CHI --stripe-webhook whsec_BzjZ……………………Y4k
level: supporter → operator

  config.env    PROVIDER_LEVEL: supporter → operator
  config.env    TIER_PRICES_JSON: {} → {"cumulus":700}
  secrets.env   STRIPE_SECRET_KEY: set
  secrets.env   STRIPE_WEBHOOK_SECRET: set
  .env.operator AGENT_LISTING_JSON: [] → [{"tier":"cumulus","priceCents":700,"availableSlots":1}]

Apply these changes? [y/N]: y

Wrote config.env, secrets.env, .env.operator (previous versions kept as *.bak)

PROVIDER_LEVEL is in your SIGNED manifest, so Flux Hub needs a re-ingest:
  1. fh-toolkit sign
  2. paste manifest.json at https://staging.moltentech.us/onboard and sign with your owner wallet
     — the hub re-ingests there; nothing this command wrote reaches it until you do

Stripe (you are merchant of record; Flux Hub never holds these):
  3. register a webhook endpoint at <your coalition>/webhook, then:
     fh-toolkit doctor --check-stripe    ← catches a key from the wrong account
  4. fh-toolkit env, re-import env.json into the Flux app, redeploy

AGENT_LISTING_JSON changed in .env.operator, which the agent reads ONLY at start:
  fh-agent restart    (= docker compose up -d --force-recreate; `docker restart` does NOT reload it)

Note: README.txt still describes your old level. It is generated documentation,
not configuration — nothing reads it.
user@host:~/fh-agent$
```

Three things the output is careful about. **It touched three files and named every
change** before asking — `manifest.json`, your issued keys, `SESSION_SECRET` and
`data/inventory.json` are all untouched, which is the reason this command exists instead
of `init --force`. **Nothing has reached Flux Hub yet**: `PROVIDER_LEVEL` is inside the
signed manifest, so the hub learns about it only when you `sign` and re-paste at
`/onboard`. Until then `fh-toolkit doctor` reports `MANIFEST_STALE` and the hub still has
you as a Supporter. And **the agent has not seen the listing yet**: `AGENT_LISTING_JSON`
is what makes a card on `/providers`, the agent reads it only at start, and the last step
names the one command that reloads it — `fh-agent restart`. The Stripe key it asked for is
one you create yourself under onboarding Step 3, with that step's exact permission list —
the upgrade does not create one for you.

### The Stripe half — webhook, `doctor --check-stripe`, first sale

Captured 2026-09-11 on an earlier build (`341c44f`); only the output shown has been
checked against the current one. The webhook endpoint was created in the
Stripe dashboard (Developers → Webhooks) pointing at `<COALITION_URL>/webhook` with the
five events from onboarding Step 3, and its `whsec_` is the one the upgrade above already
asked for. After `fh-toolkit env` and a redeploy of the Coalition with the new `env.json`:

```console
user@host:~/fh-agent$ fh-toolkit doctor --check-stripe
checked config.env, secrets.env, .env.operator, inventory.json, manifest.json, stripe API reached, test mode — 0 error(s), 0 warning(s)
everything agrees.
```

That line is the only proof you get before money moves that the endpoint is on **your**
Stripe account and points at **your** Coalition — the two failures that otherwise show
up as a checkout that silently never completes. (Recorded on an earlier build the last
item read `stripe (live)`, meaning the live API was reached; it now names the key's mode
instead, because next to an `rk_test_` key "live" reads as live mode.)

Then a rental from a second wallet, Stripe test card `4242 4242 4242 4242`:

- Stripe → Coalition `/webhook` → hub: `[agent-auth] /api/agent/payment authorized via=coalition provider=moltentech-test2` — the rental exists the moment the Coalition relays the event.
- The slot had been idle-filled with a Foundation node. The paid rental **evicted it**
  (stop → delete → collateral back to the pool two minutes later), then provisioned the
  customer's VM on the same slot with a fresh VMID.
- The VM carries the stamp an operator can audit from the Proxmox UI alone:
  tags `cumulus;flux-hub;paid`, description `kind: paid / rental: MT-… / sub: sub_… /
  term: recurring (monthly)`. A Stripe trial is `paid` — it is a subscription, so it never
  self-destructs the way a free grant does.

Nothing in `~/fh-agent` changed for the sale. The Coalition holds the Stripe keys, the
hub holds the rental, and the agent's only part was asserting `AGENT_LISTING_JSON` so the
card existed to click.
