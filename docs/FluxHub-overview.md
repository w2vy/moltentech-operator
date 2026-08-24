# Flux Hub — the operator directory, file by file

What every file in your operator directory *is*: who writes it, who reads it, what is
secret, and what it costs you to change it.

This is the companion to the other two docs. [`operator-onboarding.md`](operator-onboarding.md)
is the ordered path from nothing to live; [`fh-toolkit.md`](fh-toolkit.md) is the command
reference. This one is what you want three weeks later, when a node is down and you are
staring at a directory trying to remember which file the agent actually reads.

> The platform is **Flux Hub**. The binaries, images and variables are still `mt-*`
> (`mt-manifest`, `mt-agent`, `MT_BASE_URL`, `MT_PUBKEY`) until the rename ships —
> everything named in this document is literal.

---

## The directory

`mt-manifest keygen` writes the first two; `mt-manifest init` writes the rest, except
`env.json`, which `mt-manifest env` produces once `/onboard` has filled in `secrets.env`.

```
operator/
├── manifest-key.pem        0600  🔑 your permanent identity. Irreplaceable.
├── manifest-pubkey.txt     0644     its public half
├── config.env              0644     non-secret configuration — the manifest is rendered FROM this
├── secrets.env             0600  🔑 the Coalition's secrets
├── .env.operator           0644  🔑 the AGENT's environment — holds Proxmox credentials
├── manifest.json           0644     signed. This is what you paste at /onboard
├── env.json                0600  🔑 assembled Flux environment — import target
├── flux-app-spec.json      0644     the Flux app definition
├── compose.yaml            0644     the agent service
├── README.txt              0644     this directory, in plain language. No secrets.
└── data/
    └── inventory.json      0644     your hosts and slots — the ONLY thing the agent may read here
```

⚠️ **`.env.operator` is 0644 and holds a live Proxmox token.** That is the generator's
choice — Docker's `env_file` must be readable by the invoking user — but it means the
directory's permissions are doing the work. Keep the directory itself private, and never
commit it.

### Three boundaries this layout enforces

| Boundary | What crosses it | What must not |
|---|---|---|
| **agent container** ← `./data:/data:ro` | `inventory.json` only | `.env.operator` and `manifest-key.pem` must never be readable inside the container. This is why inventory lives in `data/` and nothing else does. |
| **Flux app** ← `env.json` | Coalition config + the three issued keys + Stripe | `manifest-key.pem` never leaves this host. The Coalition holds `MANIFEST_KEY`'s *effects*, not your Proxmox creds. |
| **Flux Hub** ← `manifest.json` | your signed, owner-attested identity | every secret. The manifest is a public document; it is meant to be published at `/.well-known/mt-provider.json`. |

⭐ **`data/` is mounted as a directory, never as a file.** A single-file bind mount pins
the container to that file's inode, and most editors save by write-new-then-rename — which
silently detaches the mount, after which your edits stop reaching the agent with no error
anywhere.

---

## `manifest-key.pem` 🔑

**Written by** `mt-manifest keygen`, once, ever. **Read by** `mt-manifest sign` and `init`.

An ed25519 private key in PEM form. It signs your manifest, and its base64 form
(`MANIFEST_KEY`) is how the agent and the Coalition authenticate to Flux Hub.

⚠️ **This is a once-ever identity, and it is the one irreplaceable file here.** FH pins
its public half at first ingest. Lose it and you re-onboard; leak it and someone else can
sign as you. `keygen` refuses to overwrite an existing one — silently replacing it orphans
you with no error anywhere, because the manifest simply stops matching what FH holds.

**Back this up.** Everything else in this directory can be regenerated from your answers;
this cannot.

## `manifest-pubkey.txt`

**Written by** `keygen`. **Read by** `init` (to pin `MANIFEST_PUBKEY`) and
`doctor --check-hub`.

The base64 public half. Not a secret — publish it freely. Its job is to be the *pin*:
`mt-agent doctor` compares the key the agent actually loaded against it. Delete it and
`init` re-derives the value from the private key, so the pin cannot silently end up empty.

---

## `config.env` — non-secret configuration

**Written by** `init`. **Read by** `sign` (renders the manifest body from it), `env`,
`doctor`. **Never read by** the agent or the Coalition at runtime — this file is a
*source*, not an environment.

⚠️ **Comments must be on their own line.** Everything after `=` is the value, so a
trailing `# note` becomes part of it and surfaces far away as a bare 401. `doctor` flags
this as `CFG_INLINE_COMMENT`.

| Key | Signed? | Notes |
|---|:--:|---|
| `PROVIDER_SLUG` | ✅ | permanent — Flux Hub knows you by this |
| `PROVIDER_NAME` | ✅ | |
| `PROVIDER_LOCATION` / `PROVIDER_CONTACT` / `PROVIDER_DESCRIPTION` | ✅ | optional; omitted when empty |
| `COALITION_URL` | ✅ | derived from your Flux app name; `https://<app>.app.runonflux.io` |
| `OWNER_ADDRESS` | ✅ | the wallet that signs onboarding and every privileged action, forever |
| `PROVIDER_LEVEL` | ✅ | `supporter` or `operator`; absent means operator |
| `HOSTS` | ✅ | comma-separated `ProxmoxHost.name` — **the owner-attested hardware list** |
| `TRIAL_DAYS` | ✅ | 1–7 |
| `MANUAL_APPROVAL` | ✅ | require approval before provisioning a trial |
| `MT_BASE_URL` | ❌ | which Flux Hub instance |
| `MT_PUBKEY` | ❌ | FH's own signing pubkey, which the Coalition pins |
| `TIER_PRICES_JSON` | ❌ | `{tier: cents}` — **runtime only** |

**The signed column is the whole point of this table.** Change anything marked ✅ and the
manifest is stale: re-run `sign`, then **re-paste at `/onboard`**. Change anything marked
❌ and you only re-run `env` and re-import — no re-sign, no re-paste.

⚠️ **`HOSTS` is an attestation, not a list of names.** FH pins it at ingest and rejects
any inventory host that is not on it, which is what stops a stolen agent key grafting in a
foreign machine. Adding a Proxmox host is therefore a re-sign *and* a re-paste, not an
inventory edit. (`doctor` catches the mismatch as `HOSTS_UNATTESTED`.)

⚠️ **`MT_PUBKEY` empty is a delayed failure.** `init` fetches it from
`{MT_BASE_URL}/api/mt-pubkey`. Onboarding, the agent and provisioning all work fine
without it — what breaks is checkout/manage, as a 401 from *your own* Coalition, long
after the step that caused it. It is per-instance: moving a Coalition from staging to
production needs this changed as well as `MT_BASE_URL`.

⚠️ **`TIER_PRICES_JSON` is CENTS.** $20 is `2000`, not `20000`. `doctor` has a rule for
exactly this (`PRICE_ZEROS`), because the mistake reads as plausible. Selling nothing is
`{}` — never a tier priced at 0, which FH 422s against its per-tier floor.

## `secrets.env` 🔑 — the Coalition's secrets

**Written by** `init` as a skeleton; you fill in three values. **Read by** `env` and
`doctor`. Mode 0600. **Never commit it, and never paste these into `config.env`.**

| Key | Source | If empty |
|---|---|---|
| `MANIFEST_KEY` | filled by `init` from the key on disk | the Coalition cannot authenticate |
| `AGENT_KEY` | **`/onboard`, shown once** | agent falls back to nothing |
| `COALITION_KEY` | **`/onboard`, shown once** | Coalition cannot authenticate |
| `COALITION_SIGNING_KEY` | **`/onboard`, shown once** | no consumer *today* — Phase D uses it |
| `SESSION_SECRET` | generated by `init` | the console **withholds the node dashboard** |
| `STRIPE_SECRET_KEY` | Stripe dashboard → API keys (use a restricted key) | `env` refuses if you list a paid tier |
| `STRIPE_WEBHOOK_SECRET` | shown once when you create the endpoint | checkout never completes |

**Empty-but-present is a deliberate third state.** `doctor` reports it as `NOT_YET_FILLED`,
never as an error, so a fresh scaffold does not read as broken. Exactly three values are
left empty on purpose — the ones `/onboard` mints. Everything else `init` could know, it
filled in.

⚠️ **`COALITION_SIGNING_KEY` has no consumer yet and is displayed exactly once.** Store it
now or it is gone. It is not currently checked by anything, so nothing will remind you.

⚠️ **`STRIPE_WEBHOOK_SECRET` is bound to the specific endpoint it came from.** A secret
copied from a different endpoint fails *silently* — checkout simply never completes.
`doctor --check-stripe` is what proves the endpoint is yours and registered.

⚠️ **Env files run no shell.** `MANIFEST_KEY=$(base64 …)` ships literally.

## `.env.operator` 🔑 — the agent's environment

**Written by** `init`. **Read by** `mt-agent` (via `env_file` in `compose.yaml`) and by
`doctor`'s `--check-proxmox` / `--check-hub`.

This is the only file holding your **Proxmox token**, and those credentials never leave
your host — the agent dials out and nothing dials in.

The full variable table lives in [`fh-toolkit.md`](fh-toolkit.md).
What matters *about the file*:

- ⚠️ **Editing it is not enough.** `docker compose restart` re-reads nothing, and whether
  a plain `up -d` notices changed `env_file` *contents* varies by compose version. Use
  `docker compose up -d --force-recreate`. This is the single most common reason a
  corrected key keeps returning 401.
- ⚠️ **`MANIFEST_KEY` here is a genuine second copy**, not a duplicate to be tidied away:
  the agent and the Coalition each read their own environment. `doctor` knows this pair is
  legitimate; `ENV_DUPLICATED_ACROSS_FILES` is about values that can *drift*.
- ⚠️ **`PROXMOX_URL` must be reachable from inside the container** — your Proxmox LAN IP,
  not `127.0.0.1` (that is the container's own loopback).
- ⚠️ **`PROXMOX_TOKEN_ID` is a credential, not a label.** Renaming the token breaks every
  Proxmox call the agent makes.
- ⚠️ **`PROXMOX_STORAGE_IMAGES` defaults to `local-lvm`**, which on a mixed-disk host is
  frequently the spinning one. Nodes then provision fine and fail every benchmark with no
  visible cause. `doctor --check-proxmox` and `mt-agent doctor` both resolve it to the real
  device and refuse it.
- ⚠️ **`AGENT_LISTING_JSON` is an array** of `{tier, priceCents, availableSlots}`, and its
  prices must agree with `TIER_PRICES_JSON` in `config.env` or the Coalition and FH quote
  different numbers (`PRICE_DISAGREES_ACROSS_FILES` → a 502 at checkout).
  `availableSlots` is a **throttle, not a capacity claim** — FH clamps it to your live
  available slots, so you can offer fewer than you have and never more.

## `data/inventory.json` — your hosts and slots

**Written by** `init`. **Read by** the agent (mounted read-only at `/data/inventory.json`)
and by `doctor`, which looks in both `data/` and the current directory.

A JSON **array** of hosts. This is the declaration of what hardware you actually have —
distinct from `HOSTS` in `config.env`, which is the *signed attestation* of which machines
you are allowed to serve from. Both must agree.

**Host fields:** `name` (the globally-unique `ProxmoxHost.name`), `nodeName` (the Proxmox
node the agent provisions on), `apiUrl`, `network`, `storageImages`, `storageIso`, `slots[]`.

**Slot fields:** `tier`, `vmName`, `ipAddress`, `lanIp`, `gateway`, `apiPort`, plus
optional `network`, `storagePool`, `vlan`, `vmId`, `dns1`/`dns2`, `priceCents`,
`diskLimit`, `cpuLimit`, `networkLimit`, `rateLimit`, `startupConfig`.

⚠️ **`apiUrl` is the cluster endpoint, the same for every host** — not a self-pointing URL
per machine.

⚠️ **`lanIp` needs its CIDR suffix.** A bare address silently becomes `/32`, and the node
can then reach nothing. `doctor` flags it as `LANIP_NO_CIDR`.

⚠️ **`network` and `storagePool` are per-slot overrides**, absent meaning "use the host's".
One machine can carry slots on different bridges or pools — which is also how a single
slot quietly ends up on a spinning pool while its neighbours are fine.

⚠️ **This file is authoritative, and the agent overwrites from it.** Editing slots
anywhere else — including in FH's database — loses to the next inventory assert. Edit here.
Removing a host from this file does **not** delete anything upstream; inventory is
upsert-only.

## `manifest.json` — your signed identity

**Written by** `init` (which signs it for you) and by `sign`. **Read by** `env`, `doctor`,
`verify`, and by whoever ingests it. **Pasted by you** at `{MT_BASE_URL}/onboard`.

A public document: the manifest body plus a detached ed25519 `signature` over the
canonical JSON of every other field. `env` embeds it whole as `MANIFEST_JSON`, and the
Coalition serves it verbatim at `/.well-known/mt-provider.json`.

The body carries `schemaVersion`, `provider{slug,name,…}`, `coalitionUrl`, `pubkey`,
`ownerAddress`, `hardware[]` (from `HOSTS`), `level`, `trialDays`, `manualApproval`,
`serviceFlags`, `trustedSelfClaim` and `publishedAt`.

⚠️ **It is a SNAPSHOT of `config.env`.** Edit config afterwards and this file is stale.
`doctor` compares the two and says so (`MANIFEST_STALE`) — that check is what makes it
safe for `init` to sign automatically. The fix is `mt-manifest sign`.

⚠️ **`trustedSelfClaim` is always `false` and is ignored by FH.** It exists so that a
naive operator cannot grant themselves trust by editing a field. `level` is the same shape
of thing: a *declaration*, not an authorization — FH decides what you may do from its own
records.

⚠️ **Signature checking runs on the RAW object.** Never round-trip this file through a
tool that adds or reorders fields; schema defaults that materialise during parsing are
fields the signer never signed, and the signature stops verifying.

## `env.json` 🔑 — the Flux import blob

**Written by** `env`, mode 0600. **Read by** you, once, when you import it into your Flux
app's Environment Variables. **Contains secrets — never commit it.**

A JSON array of `"KEY=value"` strings: the non-secret config, the secrets, and the signed
manifest minified onto one line as `MANIFEST_JSON`. `env` verifies the manifest signature
before it will build this, so a placeholder or tampered manifest is refused rather than
deployed.

⚠️ **Deploy the Flux app as an ENTERPRISE app.** A standard Flux app's environment is
**world-readable**, and this blob holds your Stripe key.

⚠️ **A secret-only change can leave the app spec byte-identical**, in which case the
re-import is a silent no-op. Verify downstream — `/health`, a real checkout, or
`doctor --check-hub` — rather than trusting that the import took.

## `flux-app-spec.json` — the Flux app definition

**Written by** `init`. **Read by** you, when registering the app on FluxOS.

Version 8 spec: one `coalition` service on `w2vy/coalition:latest`, port 33001 → container
8088, 0.5 CPU / 1000 MB / 5 GB, 3 instances, `expire: 22000`.

⚠️ **`owner` is deliberately absent, and that is not an omission.** A Flux app is owned by
the **ZelID you register from** — a different identity from `OWNER_ADDRESS`, and one this
generator cannot know. FluxOS assigns it from your logged-in ZelID and overwrites anything
imported. (The API path *does* require an owner, so registering directly rather than
through the UI means supplying your own.)

⚠️ Every field here already exists in your answers. Hand-editing this file has so far
produced nothing but JSON syntax errors.

## `compose.yaml` — the agent service

**Written by** `init`. **Read by** `docker compose`.

Pinned to `w2vy/mt-agent:latest`, `restart: unless-stopped`, `env_file: [.env.operator]`,
`./data:/data:ro`, and an explicit project name `fh-agent-<slug>`.

⚠️ **The project name is explicit on purpose.** Compose otherwise derives it from the
directory, so two operator stacks in similarly-named directories share a project and fight
over one container.

⚠️ **No published ports, and that is the security model.** The agent only dials out — Flux
Hub on 443 and your Proxmox on 8006. Nothing reaches it from the internet, which is what
makes it safe for it to hold Proxmox credentials at all.

⚠️ **`:latest` does not re-pull.** `docker compose up -d` runs the image already on the
host. Take a newer build with `docker compose pull && docker compose up -d --force-recreate`.

## `README.txt`

**Written by** `init`. Plain text on purpose: it opens in anything, on a machine with no
browser, over ssh.

⚠️ **It carries no secrets, by design** — slug, app name, URLs, host names only. It is the
one generated file that is safe to paste into a support thread, and it must stay that way.

## `signed-manifest.json` *(only if you used `authorize`)*

The legacy `SignedProviderManifest` wrapper: `{manifest, ownerSignature}`. The `/onboard`
web flow is the supported path and produces no such file; this one exists for the
URL-fetch ingest path. `env` and `verify` accept it wherever a bare manifest is accepted,
and check the owner signature too.

---

## The same value in more than one place

| Value | Lives in | Must match |
|---|---|---|
| `MANIFEST_KEY` | `secrets.env`, `.env.operator` | each other — legitimate copies, since agent and Coalition read different files |
| public key | `manifest-pubkey.txt`, `MANIFEST_PUBKEY` in `.env.operator`, `pubkey` in `manifest.json` | all three, and what FH pinned at first ingest |
| `OWNER_ADDRESS` | `config.env`, `.env.operator`, `ownerAddress` in `manifest.json` | all three |
| `COALITION_URL` | `config.env`, `.env.operator`, `coalitionUrl` in `manifest.json`, the Stripe endpoint | all four |
| prices | `TIER_PRICES_JSON` in `config.env`, `AGENT_LISTING_JSON` in `.env.operator`, slot `priceCents` | each other, and ≥ FH's per-tier floor |
| host names | `HOSTS` in `config.env`, `hardware[]` in `manifest.json`, `name` in `inventory.json` | all three |

`mt-manifest doctor` is this table, executed. Run it after any edit.

---

## What a change costs

| You changed | Then |
|---|---|
| a price | `env` → re-import. **No re-sign.** |
| `MT_BASE_URL` or `MT_PUBKEY` | `env` → re-import. **No re-sign** (neither is in the manifest). |
| `HOSTS`, `OWNER_ADDRESS`, `PROVIDER_LEVEL`, `COALITION_URL`, trial/approval | `sign` → **re-paste at `/onboard`** → `env` → re-import |
| a slot, an IP, a storage pool | edit `data/inventory.json`; the agent picks it up |
| anything in `.env.operator` | `docker compose up -d --force-recreate` |
| a secret in `secrets.env` | `env` → re-import → verify downstream (the spec may be byte-identical) |
| `SESSION_SECRET` | everyone is logged out of the console. That is all. |
| `manifest-key.pem` | you are re-onboarding. FH holds the old public half. |

---

## If you back up one thing

**`manifest-key.pem`.** It is the only file here that cannot be regenerated — everything
else falls back out of `mt-manifest init` given your answers. Store it the way you would
store a wallet key.

The three values from `/onboard` (`AGENT_KEY`, `COALITION_KEY`, `COALITION_SIGNING_KEY`)
are shown **once** and live only in `secrets.env`, so back that up too — or be ready to
have FH reissue them.

⚠️ **The wallet behind `OWNER_ADDRESS` is not in this directory at all**, and it signs
every privileged node action forever. Use one you will still control in a year.
