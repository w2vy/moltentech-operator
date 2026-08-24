# `mt-manifest init` — a full run

A **redacted transcript** of one real operator onboarding, from `keygen` to a signed
`manifest.json` and the Flux env blob. It is here so you can see the shape of the run
before you start one: what gets asked, in what order, and what `init` writes at the end.

**Redacted.** Every secret in this transcript was replaced with a same-format random
value — the manifest pubkey, the Proxmox token secret and the owner wallet address. The
two Stripe keys are additionally shown head…tail with the middle elided, because a
full-length stand-in is indistinguishable from a live key to a secret scanner. The
public IP is in the `203.0.113.0/24` documentation range, the shell prompt is
`user@host`, and the cluster was reduced to a single Proxmox host. **Nothing here is a working value** — do not copy one out.

**Captured against** `@moltentech/protocol` 0.1.0 — `protocol/` at `c3b7469`, 2026-08-24.
`init`'s prompts change as the wizard gains checks; if what you see on screen differs
from what is below, your `mt-manifest` is the authority and this transcript is stale.

```console
user@host:/tmp$ mkdir fh-agent
user@host:/tmp$ cd fh-agent/
user@host:/tmp/fh-agent$ mt-manifest keygen
Wrote manifest-key.pem (KEEP SECRET — this signs your manifest).
Public key (manifest "pubkey", also saved to manifest-pubkey.txt):
6OeYm59dw36AhO757xI3EkXk7zCOU9WZ2H/AXvqavdI=
user@host:/tmp/fh-agent$ mt-manifest init
mt-manifest init — this writes every onboarding file from your answers.

Which are you?
  1) Flux Hub Supporter — your own nodes, plus Foundation nodes on your idle
     capacity. Nothing for sale, no Stripe account needed.
  2) Flux Hub Operator  — the above, plus hardware rented out through the
     marketplace. You are merchant of record on your own Stripe account.
  choose 1 or 2 [2]: 2
  → Flux Hub Operator

Provider slug (lowercase, PERMANENT once ingested): victor-yankee
Display name [victor-yankee]: W2VY Nodes
Location (shown on your marketplace card): Tampa FL
Contact email: ops@example.com
Owner wallet address (ZelID 1… or Flux t1…): 1U3ZGMXVcZ2sjtpQU6KTWapFauSpUdfaY3
Confirm owner address is exactly "1U3ZGMXVcZ2sjtpQU6KTWapFauSpUdfaY3"? (y/N) [N]: y
Flux Hub environment — 1) production  2) staging [1]:
Flux app name for your Coalition [coalition-victor-yankee]:
  → COALITION_URL will be https://coalition-victor-yankee.app.runonflux.io

Proxmox API token (onboarding Step 0.1):
  Proxmox URL (an IP is safest — this runs inside a container) [https://192.168.1.10:8006]: https://pve30:8006
  PROXMOX_TOKEN_ID [fluxhub@pve!agent]:
  PROXMOX_TOKEN_SECRET (printed once when you created it): 229fb838-2934-96ee-f4d7-177c4776d754
  Wait while the token is verified…
  + Proxmox reachable and token accepted: https://pve30:8006
  + token holds the privileges the agent needs: 6 checked at /
  + cluster nodes visible: pve30
Which tiers will you offer? (cumulus/nimbus/stratus, comma-separated) [cumulus]:
  monthly price for cumulus in DOLLARS (floor $7.00) [7.00]:

Stripe — you are merchant of record; Flux Hub never holds these.
  STRIPE_SECRET_KEY (rk_… / sk_…), blank to fill in later: rk_test_Haatc……………………………………………………………………1Sr
  STRIPE_WEBHOOK_SECRET (whsec_…), blank if the endpoint does not exist yet: whsec_Dfv1……………………xdX

Now your hardware. Everything above was about you; this is a stock-take.
Proxmox host name(s), comma-separated [pve30]: pve30

— host pve30 —
  storages on pve30: local(dir) local-lvm(HDD) ssd(SSD) nfs-shared(NFS, shared)
  storage pool for VM images on pve30 (must be SSD) [ssd]:
  nfs-shared is shared — one ISO for the whole cluster, refreshed in one place.
  storage holding the ArcaneOS ISO on pve30 [nfs-shared]:
  how many node slots does pve30 support? [1]: 2
  WAN IP (blank when done — 0/2 placed): 203.0.113.187
    LAN gateway WITH prefix, e.g. 192.168.87.1/24: 192.168.87.1/24
    → VMs on 192.168.87.x/24, gateway 192.168.87.1
    Flux API port (Enter, or 'next' for the next WAN IP) [16127]:
    · slot 1 of 2
      tier (cumulus) [cumulus]:
      VM name: vy-187-c2
      LAN address — host number (e.g. 5 for 192.168.87.5) or a full IP: 2
      storage pool (SSD) [ssd]:
    → 192.168.87.2/24, gateway 192.168.87.1, WAN 203.0.113.187, API port 16127, storage ssd
    Flux API port (Enter, or 'next' for the next WAN IP) [16137]:
    · slot 2 of 2
      tier (cumulus) [cumulus]:
      VM name: vy-187-c3
      LAN address — host number (e.g. 5 for 192.168.87.5) or a full IP: 3
      storage pool (SSD) [ssd]:
    → 192.168.87.3/24, gateway 192.168.87.1, WAN 203.0.113.187, API port 16137, storage ssd

These must be reachable from outside your LAN, or Flux Hub cannot pull stats:
  203.0.113.187 → 16127, 16137

Offered for sale: 2 cumulus (all of them — edit AGENT_LISTING_JSON in config.env to hold any back).
  → MT_PUBKEY pinned from https://www.moltentech.us/api/mt-pubkey
Wrote config.env, secrets.env, .env.operator, data/inventory.json, flux-app-spec.json, compose.yaml, README.txt, manifest.json to /work (the directory you ran this from)

⭐ README.txt explains every file here and what to run when.

Already done, from the key in this directory:
  ✓ MANIFEST_KEY   filled in secrets.env and .env.operator
  ✓ MANIFEST_PUBKEY pinned in .env.operator (`mt-agent doctor` now compares, not skips)
  ✓ SESSION_SECRET generated
  ✓ manifest.json signed — this is the file you paste at /onboard
    (edit config.env later and it goes stale; re-run `mt-manifest sign`)

Next, in order:
  1. open https://www.moltentech.us/onboard, paste manifest.json, sign with 1U3ZGMXVcZ2sjtpQU6KTWapFauSpUdfaY3
     → issues AGENT_KEY, COALITION_KEY, COALITION_SIGNING_KEY for secrets.env
  2. Stripe: create the webhook endpoint against your Coalition URL.
     ⚠️  the webhook secret is bound to THAT endpoint — a secret from another
         endpoint fails silently and checkout never completes.
  3. `mt-manifest doctor`   ← run it here; it checks every file agrees
  4. `mt-manifest env`      → env.json, the Flux "Import Environment Variables" blob
     built from config.env + secrets.env + manifest.json. CONTAINS SECRETS.
     then `docker compose up -d` here to start the agent (compose.yaml is written)
  5. deploy Flux app "coalition-victor-yankee" as an ENTERPRISE app, import env.json
     → https://coalition-victor-yankee.app.runonflux.io
     ⚠️  enterprise, not standard: a standard Flux app's environment is
         WORLD-READABLE, and yours holds your Stripe key.
user@host:/tmp/fh-agent$ # edit secrets.env and replace the AGENT_KEY, COALITION_KEY and COALITION_SIGNING_KEY provided by ingest signing
user@host:/tmp/fh-agent$ mt-manifest doctor
checked config.env, secrets.env, .env.operator, inventory.json, manifest.json — 0 error(s), 0 warning(s)
everything agrees.
user@host:/tmp/fh-agent$ mt-manifest env
Wrote env.json (12 vars). Contains SECRETS — do NOT commit; import it into your Flux app's Environment Variables.
user@host:/tmp/fh-agent$ # Deploy the Flux app using the template created flux-app-spec.json and then import env.json as the components Environment Vars
user@host:/tmp/fh-agent$ # They need to be uploaded to Flux Cloud becuase they are big, also select Enterprize App so the app spec is also encrypted
user@host:/tmp/fh-agent$ # See the README.txt for assistance and then start the agent
user@host:/tmp/fh-agent$ #docker compose up -d
user@host:/tmp/fh-agent$
user@host:/tmp/fh-agent$

```
