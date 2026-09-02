# `mt-manifest init` — a full run

A **redacted transcript** of one real onboarding, from `keygen` to a signed
`manifest.json` and the Flux env blob. It is here so you can see the shape of the run
before you start one: what gets asked, in what order, and what `init` writes at the end.

The run below is a **Supporter** — your own nodes plus Foundation nodes on your idle
capacity, nothing listed for sale, no Stripe account. That is the recommended first
step: it is the shortest path to a live agent, and it is the whole of onboarding minus
the money. The [second block](#what-an-operator-answers-differently) at the end shows
the handful of places an **Operator** run diverges — the same questions, plus tiers,
prices and Stripe.

**Redacted.** Every secret in this transcript was replaced with a same-format random
value — the manifest pubkey, the Proxmox token secret and the owner wallet address. The
public IP is in the `203.0.113.0/24` documentation range, the shell prompt is
`user@host`, and the cluster is a single Proxmox host. **Nothing here is a working
value** — do not copy one out.

**Captured against** `@moltentech/protocol` 0.1.0 — `protocol/` at `e9d9da6`, 2026-09-02.
`init`'s prompts change as the wizard gains checks; if what you see on screen differs
from what is below, your `mt-manifest` is the authority and this transcript is stale.

## A Supporter run, start to finish

```console
user@host:/tmp$ mkdir fh-agent
user@host:/tmp$ cd fh-agent/
user@host:/tmp/fh-agent$ mt-manifest keygen
Wrote manifest-key.pem (KEEP SECRET — this signs your manifest).
Public key (manifest "pubkey", also saved to manifest-pubkey.txt):
bwHAjXTT7OMZBjnFe182ownZgyPdklFKBQDNk9tfxGE=
user@host:/tmp/fh-agent$ mt-manifest init
mt-manifest init — this writes every onboarding file from your answers.

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
Owner wallet address (ZelID 1… or Flux t1…): 1HLy2EVVJbDNNXoVxKGgY3HdN422m6hCfe
Confirm owner address is exactly "1HLy2EVVJbDNNXoVxKGgY3HdN422m6hCfe"? (y/N) [N]: y
Flux Hub environment — 1) production  2) staging [1]:
Flux app name for your Coalition [coalition-romeo-sierra]:
  → COALITION_URL will be https://coalition-romeo-sierra.app.runonflux.io

Proxmox API token (onboarding Step 0.1):
  Proxmox URL (an IP always works; a name must resolve INSIDE the container) — or `skip` [https://192.168.1.10:8006]: https://pve50:8006
  PROXMOX_TOKEN_ID [fluxhub@pve!agent]: fluxhub@pve!agent
  PROXMOX_TOKEN_SECRET (printed once when you created it): 8feca418-68a1-4b05-a83b-d1412062db0b
  Wait while the token is verified…
  x Proxmox reachable and token accepted: cannot resolve the hostname in https://pve50:8006. Inside a container, names resolve in the CONTAINER — use an IP address, or a name this container can resolve. The token is not implicated.
  → fix the above and retry, or `skip` to go on unverified [retry]:
  Proxmox URL (an IP always works; a name must resolve INSIDE the container) — or `skip` [https://pve50:8006]: https://192.168.102.50:8006
  PROXMOX_TOKEN_ID [fluxhub@pve!agent]:
  PROXMOX_TOKEN_SECRET (Enter keeps the one you typed):
  Wait while the token is verified…
  + Proxmox reachable and token accepted: https://192.168.102.50:8006
  + token holds the privileges the agent needs: 6 checked at /
  + cluster nodes visible: pve50

Stripe — skipped: a Supporter sells nothing and needs no Stripe account.

Now your hardware. Everything above was about you; this is a stock-take.
Proxmox host name(s), comma-separated [pve50]:

— host pve50 —
  storage pool for VM images on pve50 (must be SSD): local-lvm
  storage holding the ArcaneOS ISO on pve50 [pve55-shared]: local-lvm
  how many node slots does pve50 support? [1]: 2
  WAN IP (blank when done — 0/2 placed): 203.0.113.186
    LAN gateway WITH prefix, e.g. 192.168.87.1/24: 192.168.186.1/24
    → VMs on 192.168.186.x/24, gateway 192.168.186.1
    Flux API port (Enter, or 'next' for the next WAN IP) [16127]: 16167
    · slot 1 of 2
      tier (cumulus/nimbus/stratus) [cumulus]:
      VM name: rs-186-c6
      LAN address — host number (e.g. 5 for 192.168.186.5) or a full IP: 6
      storage pool (SSD) [local-lvm]:
    → 192.168.186.6/24, gateway 192.168.186.1, WAN 203.0.113.186, API port 16167, storage local-lvm
    Flux API port (Enter, or 'next' for the next WAN IP) [16177]: 16187
    · slot 2 of 2
      tier (cumulus/nimbus/stratus) [cumulus]:
      VM name: rs-186-c8
      LAN address — host number (e.g. 5 for 192.168.186.5) or a full IP: 8
      storage pool (SSD) [local-lvm]:
    → 192.168.186.8/24, gateway 192.168.186.1, WAN 203.0.113.186, API port 16187, storage local-lvm

These must be reachable from outside your LAN, or Flux Hub cannot pull stats:
  203.0.113.186 → 16167, 16187
  → MT_PUBKEY pinned from https://fluxhub.moltentech.us/api/mt-pubkey
Wrote config.env, secrets.env, .env.operator, data/inventory.json, flux-app-spec.json, compose.yaml, README.txt, manifest.json to /work (the directory you ran this from)

⭐ README.txt explains every file here and what to run when.

Already done, from the key in this directory:
  ✓ MANIFEST_KEY   filled in secrets.env and .env.operator
  ✓ MANIFEST_PUBKEY pinned in .env.operator (`mt-agent doctor` now compares, not skips)
  ✓ SESSION_SECRET generated
  ✓ manifest.json signed — this is the file you paste at /onboard
    (edit config.env later and it goes stale; re-run `mt-manifest sign`)

Next, in order:
  1. open https://fluxhub.moltentech.us/onboard, paste manifest.json, sign with 1HLy2EVVJbDNNXoVxKGgY3HdN422m6hCfe
     → issues AGENT_KEY, COALITION_KEY, COALITION_SIGNING_KEY for secrets.env
  2. Stripe: not needed — you are not listing anything for sale.
  3. `mt-manifest doctor`   ← run it here; it checks every file agrees
  4. `mt-manifest env`      → env.json, the Flux "Import Environment Variables" blob
     built from config.env + secrets.env + manifest.json. CONTAINS SECRETS.
     then `docker compose up -d` here to start the agent (compose.yaml is written)
  5. deploy Flux app "coalition-romeo-sierra" as an ENTERPRISE app, import env.json
     → https://coalition-romeo-sierra.app.runonflux.io
     ⚠️  enterprise, not standard: a standard Flux app's environment is
         WORLD-READABLE, and yours holds your Stripe key.
user@host:/tmp/fh-agent$ # edit secrets.env and replace the AGENT_KEY, COALITION_KEY and COALITION_SIGNING_KEY provided by ingest signing
user@host:/tmp/fh-agent$ mt-manifest doctor
checked config.env, secrets.env, .env.operator, inventory.json, manifest.json — 0 error(s), 0 warning(s)
everything agrees.
user@host:/tmp/fh-agent$ mt-manifest env
note: no paid tiers listed — building env.json without Stripe keys.
Wrote env.json (11 vars). Contains SECRETS — do NOT commit; import it into your Flux app's Environment Variables.
user@host:/tmp/fh-agent$ # Deploy the Flux app using the template created flux-app-spec.json and then import env.json as the components Environment Vars
user@host:/tmp/fh-agent$ # They need to be uploaded to Flux Cloud because they are big, also select Enterprise App so the app spec is also encrypted
user@host:/tmp/fh-agent$ # See the README.txt for assistance and then start the agent
user@host:/tmp/fh-agent$ #docker compose up -d
user@host:/tmp/fh-agent$
```

Two lines above are worth stopping on. The first Proxmox URL was a **hostname**, and the
probe failed on it: `mt-manifest` runs in a container, so the name has to resolve
*there*, and an IP always does. A failed probe re-asks rather than warning and carrying
on, because a verified token is also what lets `init` offer your real node and storage
names as defaults. And `Stripe — skipped` is not a question you missed: a Supporter sells
nothing, so the run never asks, and `env.json` comes out with 11 variables instead of 12.

## What an Operator answers differently

An Operator run is the same run with money added: you answer `2` at the first question,
name the tiers you will sell and their prices, and hand over a restricted Stripe key.
Nothing about the hardware stock-take, the manifest key, or the Flux app changes.

These are the only places the transcript above differs — the same run, answered as an
Operator. It is also, line for line, what upgrading from Supporter to Operator later
adds.

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

user@host:/tmp/fh-agent$ mt-manifest env
Wrote env.json (12 vars). Contains SECRETS — do NOT commit; import it into your Flux app's Environment Variables.
```

The two Stripe keys are shown head…tail with the middle elided, because a full-length
stand-in is indistinguishable from a live key to a secret scanner.

Note what an Operator run does **not** ask: which slots to list. Every slot you declared
is offered — the answer was always "all of them" — and you hold some back afterwards by
editing `AGENT_LISTING_JSON` in `config.env`. On an Operator's first run `secrets.env`
has five empty values rather than three: the three `/onboard` mints, plus the Stripe
pair if the webhook endpoint does not exist yet.
