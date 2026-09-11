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

**Captured against** `fh-toolkit` 0.3.0, build `341c44f`, 2026-09-11 — the
current tool, after the Phase E key cleanup (`/onboard` issues ONE key,
`COALITION_SIGNING_KEY`). If anything on screen differs from what is below, your
`fh-toolkit` is the authority and this transcript is stale.

## A Supporter run, start to finish

`fh-toolkit` with no arguments opens a small shell in the directory you ran it from; the
commands below are typed at its `fh-toolkit>` prompt. `fh-toolkit keygen` / `fh-toolkit init`
from your own shell do the same thing one command at a time.

```console
user@host:~$ mkdir fh-agent && cd fh-agent
user@host:~/fh-agent$ fh-toolkit
fh-toolkit 0.3.0
  build   341c44f0d0cc51b83904a21d98caacfd52895077
  built   2026-09-11T00:53:31Z
directory: /work
`help` lists the commands. `exit` or Ctrl-D leaves.

fh-toolkit> keygen
Wrote manifest-key.pem (KEEP SECRET — this signs your manifest).
Public key (manifest "pubkey", also saved to manifest-pubkey.txt):
Qm7cTf0aVYX1kPz9hL3sN8wRdU2eGxJ6yBtMoK4iA5c=

fh-toolkit> init
fh-toolkit init — this writes every onboarding file from your answers.

Which are you?
  1) Flux Hub Supporter — your own nodes, plus Foundation nodes on your idle
     capacity. Nothing for sale, no Stripe account needed.
  2) Flux Hub Operator  — the above, plus hardware rented out through the
     marketplace. You are merchant of record on your own Stripe account.
  choose 1 or 2 [2]: 1
  → Flux Hub Supporter

Provider slug (lowercase, PERMANENT once ingested): romeo-sierra
Display name [romeo-sierra]: RS Home Lab
Location (shown on your marketplace card): Trinity FL
Contact email: nodes@example.com
Owner wallet address (ZelID 1… or Flux t1…): t1VqL8mR2xKpN4cWfJ7yH3sD9gB5tZ6aQeU
Confirm owner address is exactly "t1VqL8mR2xKpN4cWfJ7yH3sD9gB5tZ6aQeU"? (y/N) [N]: y
Flux Hub environment — 1) production  2) staging [1]: 1
  → the agent will run ghcr.io/w2vy/fh-agent:latest
Flux app name for your Coalition [coalition-romeo-sierra]:
  → COALITION_URL will be https://coalition-romeo-sierra.app.runonflux.io

Proxmox API token (onboarding Step 0.1):
  Proxmox URL (an IP always works; a name must resolve INSIDE the container) — or `skip` [https://192.168.1.10:8006]: https://192.168.102.75:8006
  PROXMOX_TOKEN_ID [fh-agent@pve!agent]:
  PROXMOX_TOKEN_SECRET (printed once when you created it): 3b9d2c7e-4f1a-48e6-9a0b-7c5d1e2f8a64
  Wait while the token is verified…
  + Proxmox reachable and token accepted: https://192.168.102.75:8006
  + token holds the privileges the agent needs: 8 checked at / (self-reported by /access/permissions)
  + pve75: storage readable: read shared-iso (2 storage(s) visible)
  + pve75: bridges visible: vmbr0

Stripe — skipped: a Supporter sells nothing and needs no Stripe account.

Now your hardware. Everything above was about you; this is a stock-take.
Proxmox host name(s), comma-separated [pve75]: pve75

— host pve75 —
  storages on pve75: shared-iso(SSD) local-lvm(SSD) local(SSD)
    (2 more defined in the cluster but not usable here: backup-dir, raid5-storage)
  storage pool for VM images on pve75 (must be SSD) [shared-iso]: local-lvm
  shared-iso is shared — one ISO for the whole cluster, refreshed in one place.
  storage holding the ArcaneOS ISO on pve75 [shared-iso]: local
  how many node slots does pve75 support? [1]: 1
  WAN IP (blank when done — 0/1 placed): 203.0.113.186
    LAN gateway WITH prefix, e.g. 192.168.87.1/24: 192.168.186.1/24
    → VMs on 192.168.186.x/24, gateway 192.168.186.1
    Flux API port (Enter, or 'next' for the next WAN IP) [16127]: 16147
    · slot 1 of 1
      tier (cumulus/nimbus/stratus) [cumulus]: nimbus
      VM name: rs-186-n4
      LAN address — host number (e.g. 5 for 192.168.186.5) or a full IP: 4
      storage pool (SSD) [local-lvm]:
    → 192.168.186.4/24, gateway 192.168.186.1, WAN 203.0.113.186, API port 16147, storage local-lvm

These must be reachable from outside your LAN, or Flux Hub cannot pull stats:
  203.0.113.186 → 16147
  → MT_PUBKEY pinned from https://fluxhub.moltentech.us/api/mt-pubkey
Wrote config.env, secrets.env, .env.operator, data/inventory.json, flux-app-spec.json, compose.yaml, README.txt, manifest.json to /work (the directory you ran this from)

⭐ README.txt explains every file here and what to run when.

Already done, from the key in this directory:
  ✓ MANIFEST_KEY   filled in secrets.env and .env.operator
  ✓ MANIFEST_PUBKEY pinned in .env.operator (`fh-agent doctor` now compares, not skips)
  ✓ SESSION_SECRET generated
  ✓ manifest.json signed — this is the file you paste at /onboard
    (edit config.env later and it goes stale; re-run `fh-toolkit sign`)

Next, in order:
  1. open https://fluxhub.moltentech.us/onboard, paste manifest.json, sign with t1VqL8mR2xKpN4cWfJ7yH3sD9gB5tZ6aQeU
     → issues COALITION_SIGNING_KEY for secrets.env
  2. Stripe: not needed — you are not listing anything for sale.
  3. `fh-toolkit doctor`   ← run it here; it checks every file agrees
  4. `fh-toolkit env`      → env.json, the Flux "Import Environment Variables" blob
     built from config.env + secrets.env + manifest.json. CONTAINS SECRETS.
     then `docker compose up -d` here to start the agent (compose.yaml is written)
  5. deploy Flux app "coalition-romeo-sierra" as an ENTERPRISE app, import env.json
     → https://coalition-romeo-sierra.app.runonflux.io
     ⚠️  enterprise, not standard: a standard Flux app's environment is
         WORLD-READABLE, and yours holds your Stripe key.

fh-toolkit> exit
bye
user@host:~/fh-agent$
```

A few lines are worth stopping on.

- **The Proxmox probe drives the rest of the stock-take.** Once the token verifies, `init`
  reads your real storages and bridges and offers them as defaults, and it tells you which
  cluster storages are *not* usable on that host. Give it an **IP**: `fh-toolkit` runs in a
  container, so a hostname has to resolve *there*, and on most machines it will not. A
  failed probe re-asks rather than warning and carrying on.
- **`Stripe — skipped` is not a question you missed.** A Supporter sells nothing, so the run
  never asks, and `env.json` comes out with 11 variables instead of 12. (Step 5's warning
  about "your Stripe key" is the same text an Operator sees — a Supporter's `env.json`
  holds no Stripe key, but it still holds every other secret, so *enterprise* still applies.)
- **`/onboard` issues one key**, `COALITION_SIGNING_KEY`, and you paste it into
  `secrets.env` before `fh-toolkit doctor`. Your agent signs with `MANIFEST_KEY`, which
  `init` already filled in.

## What an Operator answers differently

An Operator run is the same run with money added: you answer `2` at the first question,
name the tiers you will sell and their prices, and hand over a restricted Stripe key.
Nothing about the hardware stock-take, the manifest key, or the Flux app changes.

These are the only places the transcript above differs — the same run, answered as an
Operator. It is also, line for line, what `fh-toolkit level --set operator` asks when you
upgrade later: the two share one implementation, so they cannot drift apart.

```console
  choose 1 or 2 [2]: 2
  → Flux Hub Operator

…

Which tiers will you offer? (cumulus/nimbus/stratus, comma-separated) [cumulus]:
  monthly price for cumulus in DOLLARS (floor $7.00) [7.00]:

Stripe — you are merchant of record; Flux Hub never holds these.
  STRIPE_SECRET_KEY (rk_… / sk_…), blank to fill in later: rk_test_Haatc……………………………………………………………………1Sr
  STRIPE_WEBHOOK_SECRET (whsec_…), blank if the endpoint does not exist yet: whsec_Dfv1……………………xdX

…

Offered for sale: 2 cumulus (all of them — edit AGENT_LISTING_JSON in config.env to hold any back).

…

  2. Stripe: create the webhook endpoint against your Coalition URL.
     ⚠️  the webhook secret is bound to THAT endpoint — a secret from another
         endpoint fails silently and checkout never completes.

…

user@host:/tmp/fh-agent$ fh-toolkit env
Wrote env.json (12 vars). Contains SECRETS — do NOT commit; import it into your Flux app's Environment Variables.
```

The two Stripe keys are shown head…tail with the middle elided, because a full-length
stand-in is indistinguishable from a live key to a secret scanner.

Note what an Operator run does **not** ask: which slots to list. Every slot you declared
is offered — the answer was always "all of them" — and you hold some back afterwards by
editing `AGENT_LISTING_JSON` in `config.env`. On an Operator's first run `secrets.env`
has three empty values rather than one: the key `/onboard` mints, plus the Stripe pair
if the webhook endpoint does not exist yet.
