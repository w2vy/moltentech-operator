# Flux Hub Operator Toolkit

Reference for the two commands an operator types: **`mt-manifest`** (scaffold, sign,
validate, assemble) and **`mt-agent`** (the long-running agent, plus its preflight).

This is a *reference*, not a runbook. It answers "what does this flag do, what does this
command read and write, what happens if I get it wrong". For the ordered from-zero
walkthrough, see [`operator-onboarding.md`](operator-onboarding.md). For what each file in
your operator directory *is*, see [`FluxHub-overview.md`](FluxHub-overview.md).

> **On the names.** The platform is **Flux Hub**; these docs use that name throughout.
> The binaries, images and environment variables are still `mt-*` (`mt-manifest`,
> `mt-agent`, `MT_BASE_URL`, `MT_PUBKEY`) and will keep those names until the rename
> ships. **Every command in this document is literal** — type it exactly as written.

---

## The two tools at a glance

| | `mt-manifest` | `mt-agent` |
|---|---|---|
| Image | `ghcr.io/w2vy/mt-manifest:latest` | `w2vy/mt-agent:latest` |
| Lifetime | one-shot, run by hand | long-running daemon |
| Runs where | your agent host, in your operator directory | same host, via `compose.yaml` |
| Holds secrets | no — your key is generated into the mounted directory, never baked in | yes — Proxmox token, manifest key |
| Network | offline by default; only the `--check-*` flags reach out | outbound only, always |

`mt-manifest` produces the files. `mt-agent` consumes two of them (`.env.operator`,
`data/inventory.json`) and does the work.

---

## Running them

### `mt-manifest` — define it as a shell function

⚠️ **A function, not an alias.** An alias does not expand when it appears as an argument
to another command, so wrapping it (in a script, `time`, `sudo`, `watch`, a capture
harness) fails with `command not found`.

```sh
mt-manifest() {
  local img=ghcr.io/w2vy/mt-manifest:latest
  local stamp="${XDG_CACHE_HOME:-$HOME/.cache}/mt-manifest.pulled"
  # `--refresh` is consumed HERE and never passed on: the CLI runs inside the container
  # and cannot pull its own image. Alone it pulls and stops; followed by a command it
  # pulls and then runs it. A failed pull aborts rather than quietly using the old image.
  if [ "$1" = "--refresh" ]; then
    shift
    docker pull "$img" || return 1
    mkdir -p "$(dirname "$stamp")" && touch "$stamp"
    [ $# -eq 0 ] && return 0
  fi
  # Refresh the image at most once every 48h, tracked by a stamp file.
  if [ ! -e "$stamp" ] || [ -n "$(find "$stamp" -mmin +2880 2>/dev/null)" ]; then
    if docker pull -q "$img" >/dev/null 2>&1; then
      mkdir -p "$(dirname "$stamp")" && touch "$stamp"
    else
      echo "note: could not refresh $img — using the cached image" >&2
    fi
  fi
  # /etc/hosts read-only so hostnames resolve inside the container as they do at your
  # prompt — see the caveat in operator-onboarding.md Step 0.5 for the loopback edge.
  docker run --rm -i -v "$PWD:/work" -v /etc/hosts:/etc/hosts:ro -u "$(id -u):$(id -g)" "$img" "$@"
}
```

`mt-manifest --refresh` forces the pull the stamp would otherwise defer — alone it pulls
and stops, and followed by a command (`mt-manifest --refresh doctor --check-hub`) it pulls
and then runs it. It has to live in the wrapper: the CLI runs *inside* the container and
cannot replace its own image.

Three things in that wrapper are load-bearing:

- **`-i`** — without it the container gets no stdin and `init`, the only subcommand that
  asks questions, prints its first prompt and exits at EOF with no error. Every other
  subcommand still works, so the tool looks half-broken rather than mis-invoked.
- **`-v "$PWD:/work"`** — the container's `/work` *is* your operator directory. Every
  path default below (`.`) resolves there, which is why the commands take no arguments
  when you run them in the right place.
- **the stamp file** — `docker run` never re-pulls, so without it you keep running
  whatever image you first pulled, indefinitely, while the docs describe a newer one.
  `-mmin +2880` is deliberate: `-mtime +2` rounds to whole days and means *older than
  72h*, which you would only notice as a refresh that did not happen. To pull every time
  instead, drop the block and add `--pull always` to the `docker run`.

  Because of that window, a change that has merged can be up to two days from reaching
  your box. `mt-manifest version` says which build is actually answering:

  ```console
  $ mt-manifest version
  mt-manifest 0.1.0
    build   9c6f819c8600429701eeb50640cf3ca30ae1fe41
    built   2026-08-24T19:42:00Z
  ```

  The SHA is a commit in `moltentech-operator`, so `git log 9c6f819` says exactly what is
  and is not in the CLI you just ran — paste it into any bug report. A build with no
  image metadata reports `source checkout` instead of guessing.

### `mt-agent` — compose, written for you

`mt-manifest init` writes `compose.yaml` (pinned image, `./data` mounted read-only, its
own project name, no published ports):

```sh
docker compose up -d          # start
docker compose logs -f        # watch
docker compose down           # stop and remove
```

⚠️ **After editing `.env.operator`, use `docker compose up -d --force-recreate`.**
`docker compose restart` re-reads nothing, and whether a plain `up -d` notices a changed
`env_file`'s *contents* varies by compose version. This is the single most common reason
a corrected key keeps returning 401.

⚠️ **All three images track `:latest`, and nothing re-pulls on its own.** `docker run` and
`docker compose up -d` both use the image already on the host, so you keep running whatever
you first pulled — indefinitely. To take a newer build:

```sh
docker compose pull && docker compose up -d --force-recreate
```

The `mt-manifest` function above does this for you with its 48-hour stamp file; the agent
and the Coalition do not. Because the tag moves, **your files no longer record which build
is live** — `mt-manifest doctor --check-hub` reports the deployed Coalition build, and that
is what replaces a version pin. For a run you need to reproduce byte-for-byte, deploy a
digest (`w2vy/coalition@sha256:…`) instead of a tag.

One-shot invocations (`doctor`, dry runs) go direct:

```sh
docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" \
  w2vy/mt-agent:latest [doctor]
```

---

# `mt-manifest`

```
mt-manifest <keygen|init|doctor|sign|env|verify|authorize> [options]
```

`mt-manifest help` (also `--help`, `-h`, or no subcommand at all) prints the whole command
list, `doctor`'s live-check flags, and a pointer back to this document — exit 0. An unknown
subcommand prints the same list and exits 1.

**Every path option defaults to the file `init` wrote in the current directory.** Standing
in your operator directory, `doctor`, `sign` and `env` take no arguments at all.

| Command | One line | Reads | Writes |
|---|---|---|---|
| `keygen` | make your permanent signing identity | — | `manifest-key.pem`, `manifest-pubkey.txt` |
| `init` | interview → the whole scaffold, signed | `manifest-key.pem` | 8 files (see below) |
| `doctor` | prove every file agrees; optionally prove the live wiring | all of them | — |
| `sign` | re-sign after a `config.env` edit | `config.env`, key | `manifest.json` |
| `env` | assemble the Flux environment blob | config + secrets + manifest | `env.json` |
| `verify` | re-check a signature you were handed | a manifest | — |
| `authorize` | LEGACY owner-signature wrapper | a manifest | `signed-manifest.json` |
| `help` | the whole command list | — | — |

---

## `keygen`

```
mt-manifest keygen [--out <dir>] [--force]
```

Generates an ed25519 keypair. Writes `manifest-key.pem` (mode 0600 — **KEEP SECRET**;
this signs your manifest) and `manifest-pubkey.txt`, and prints the public half.

⚠️ **This key is a once-ever identity.** Flux Hub pins its public half at first ingest.
Replacing it means re-onboarding — and silently overwriting it orphans you with no error
anywhere: the manifest simply stops matching what FH holds. So `keygen` **refuses to
overwrite** an existing `manifest-key.pem`. `--force` is only for a deliberate rotation.

It also backfills `MANIFEST_PUBKEY` in `.env.operator` if that file exists **and the slot
is empty**. On a first run there is no `.env.operator` yet, so this is a no-op; it earns
its place on the rotation path. A non-empty slot is a deliberate pin and is left alone —
silently repointing it is how a rotation loses the old key.

| Option | Default | Meaning |
|---|---|---|
| `--out <dir>` | `.` | where to write the key and pubkey |
| `--force` | off | overwrite an existing key — rotation only |

---

## `init`

```
mt-manifest init [--out <dir>] [--answers <answers.json>] [--force]
```

The installation interview. Roughly eight questions, then it writes and **signs** the
whole scaffold. This is the one command that needs `-i` on the `docker run`.

**Run `keygen` first.** `init` requires the key and checks for it **before the first
question** — it fills `MANIFEST_KEY` in two files from it and pins `MANIFEST_PUBKEY`, and
refuses to run rather than writing files with three holes in them.

### What it writes

| File | Mode | What it is |
|---|---|---|
| `config.env` | 0600 | non-secret configuration; the source the manifest is rendered from |
| `secrets.env` | 0600 | secret skeleton — `/onboard` fills in the three issued keys |
| `.env.operator` | 0600 | the agent's environment (Proxmox creds land here) |
| `data/inventory.json` | **0644** | your declared hosts and slots — published content, and the only file read from inside the container |
| `flux-app-spec.json` | 0600 | the Flux app definition for the Coalition |
| `compose.yaml` | 0600 | pinned `mt-agent` service, ready to `up -d` |
| `README.txt` | 0600 | your operating card: how to start, stop and watch the agent |
| `manifest.json` | 0600 | **signed** — this is what you paste at `/onboard` |

0600 is the default because a per-file judgement is a rule someone has to get right every
time a file is added, and getting it wrong once means a live Proxmox token readable by
every account on the host. `inventory.json` is the deliberate exception.

⭐ `inventory.json` goes in **`data/`**, not beside the rest. That directory is
bind-mounted into the agent at `/data`, and the mount is the **directory, not the file** —
a single-file mount pins the container to an inode that any atomic editor save detaches,
after which host edits silently stop reaching the agent. Nothing else may go in `data/`:
the agent must never be able to read `.env.operator` or `manifest-key.pem`.

### Refusals and precondition order

Both preconditions fire **before** the first question, which is the point:

1. **No `manifest-key.pem`** → dies telling you to run `keygen`.
2. **Any generated file already present** → refuses, listing them. `--force` replaces
   them: `manifest.json` is re-signed, a **new `SESSION_SECRET`** is generated (logging
   out any open Coalition sessions), and `data/inventory.json` is rewritten — it is
   authoritative over slot edits made anywhere else. `manifest-key.pem` is never touched.

### Derived, never asked

- **`MT_PUBKEY`** — fetched from `{MT_BASE_URL}/api/mt-pubkey`. Leaving it empty is a
  *delayed* failure: onboarding, the agent and provisioning all work without it, and only
  the checkout/manage leg breaks, long after the step that caused it. Fetched on **both**
  the interactive and `--answers` paths.
- **`MANIFEST_KEY`** — `base64 -w0` of the PEM, written into `secrets.env` and
  `.env.operator`.
- **`MANIFEST_PUBKEY`** — from `manifest-pubkey.txt`, or re-derived from the key if that
  file is gone, so a deleted pubkey file cannot leave the pin empty.
- **`SESSION_SECRET`** — 32 random bytes, hex. `--answers` may pin an existing value to
  keep sessions alive.
- **`COALITION_URL`** — derived from the Flux app name you choose
  (`https://<app>.app.runonflux.io`), never asked separately.
- **Tier minimums** — fetched live from Flux Hub before the prompts, so the wizard quotes
  the real floor; falls back to the bundled table with a note if FH is unreachable.

### Non-interactive: `--answers`

`--answers answers.json` drives the **same** generator as the prompts — there is no second
implementation to drift. This is the CI path and the re-run-after-a-typo path.

Shape (see `Answers` in `protocol/src/scaffold.ts` for the full type):

```jsonc
{
  "providerSlug": "acme",           // required
  "providerName": "Acme Hosting",   // required
  "providerLocation": "US-East",    // optional
  "providerContact": "ops@acme.io", // optional
  "ownerAddress": "1L1wz2w…",       // required — the wallet that signs forever after
  "mtBaseUrl": "https://www.moltentech.us",
  "fluxAppName": "acmecoalition",   // COALITION_URL is derived from this
  "level": "operator",              // or "supporter"
  "selling": true,                  // derived from `level` when omitted
  "tierPricesCents": { "nimbus": 2000 },   // CENTS. 2000 = $20, not 20000
  "hosts": [ /* HostAnswer[] */ ]
}
```

Answers are validated as a set (`validateAnswers`) before anything is written; problems
are listed and nothing is generated.

⚠️ **`level` vs `selling`.** They answer different questions. `level` is what you signed
up as and is **published in the signed manifest**; `selling` is whether *this* scaffold
lists anything. A supporter who later adds a tier changes `selling` without re-declaring
who they are. Changing `level` needs a re-sign and a re-paste.

⚠️ **Selling nothing is an EMPTY price list, never a tier priced at 0.** FH enforces a
per-tier minimum (`minPriceCents`, 700 at the lowest) and 422s anything under it, so 0 is
not expressible. This is unrelated to a *free rental*, which is a rental an admin
**assigns** — it needs no Stripe account whatever the tier costs.

### After it runs

`init` prints what it already did and what is still outstanding. The signed
`manifest.json` is the file you paste at `{MT_BASE_URL}/onboard`.

⚠️ **The signed manifest is a snapshot of `config.env`.** Edit `config.env` afterwards and
it is stale — `doctor` compares the two and says so, which is what makes signing
automatically here safe. The fix is `mt-manifest sign`.

---

## `doctor`

```
mt-manifest doctor [--dir <dir>] [--check-stripe] [--check-proxmox] [--check-hub]
```

The onboarding "which value must match where" table, executed. Exits **non-zero** on any
error finding, so it works as a gate in a script.

**File-level and offline by default.** It reads `config.env`, `secrets.env`,
`.env.operator`, `manifest.json` and `inventory.json` (looking in both `data/` and the
current directory) and reports where they disagree. No credential leaves the disk unless
you pass a `--check-*` flag. The last line of the report is the command you have to run
next.

Tier price minimums come from Flux Hub live when `MT_BASE_URL` is reachable, falling back
to this tool's bundled copy — the minimum is FH's to set.

### File-level findings

| Rule | What it caught |
|---|---|
| `NOT_YET_FILLED` | a placeholder that was never replaced |
| `MANIFEST_STALE` | `config.env` changed after `manifest.json` was signed → re-run `sign` |
| `MANIFEST_SIG_INVALID` / `MANIFEST_UNPARSEABLE` | the manifest does not verify, or is not readable |
| `PRICE_BELOW_FLOOR` | a listed price under FH's per-tier minimum → 422 on listing |
| `PRICE_ZEROS` | a value that looks like dollars where cents were meant |
| `PRICE_NOT_INTEGER_CENTS` / `PRICE_MALFORMED` / `PRICE_UNKNOWN_TIER` | `TIER_PRICES_JSON` shape |
| `PRICE_DISAGREES_ACROSS_FILES` | Coalition price ≠ listing price → 502 at checkout |
| `HOSTS_UNATTESTED` | an inventory host not named in the signed `HOSTS` list → FH rejects it |
| `LANIP_NO_CIDR` | a bare `lanIp` (silently becomes `/32`) |
| `INVENTORY_MALFORMED` / `LISTING_MALFORMED` / `LISTING_NOT_AN_ARRAY` | shape errors |
| `COURIER_SILENT_OFF` | the courier will disable itself with no warning (see below) |
| `SECRET_IN_NONSECRET_CONFIG` | a secret sitting in a non-secret config file |
| `ENV_DUPLICATED_ACROSS_FILES` | the same key in two files, able to drift |
| `CFG_INLINE_COMMENT` | a trailing `# note` — it becomes part of the value |
| `ENVFILE_QUOTED_VALUE` / `ENVFILE_NO_EXPANSION` | quoting and `$VAR` traps in env-file syntax |

### `--check-proxmox`

Reads `PROXMOX_URL` / `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` from `.env.operator`
and proves the token actually works. Read-only; nothing is created. Skipped with a
message if any of the three is absent.

The check that pays for the flag: it resolves `PROXMOX_STORAGE_IMAGES` through its LVM
volume group to the real device and **fails if it is rotational**:

```
DOC_DEFAULT_STORAGE_IS_HDD  PROXMOX_STORAGE_IMAGES="local-lvm" is ROTATIONAL on pve30
```

⚠️ A pool on spinning media provisions fine and then **fails every benchmark with nothing
in any log to say why**. `init` runs this at the moment the token is typed; the flag is
for re-runs and for a directory filled in by hand.

### `--check-stripe`

The only check that puts a secret in memory and the only one that talks to a third party.
All read-only GETs. Needs `STRIPE_SECRET_KEY` (from `secrets.env` or `.env.operator`) and
`COALITION_URL`.

| Finding | Meaning |
|---|---|
| `STRIPE_KEY_IS_MT_PLATFORM_ACCOUNT` | that is Flux Hub's account, not yours |
| `STRIPE_WEBHOOK_FOREIGN_COALITION` | the endpoint points at **someone else's** Coalition — sales fan out to them |
| `STRIPE_WEBHOOK_NOT_REGISTERED` | no endpoint for your Coalition — checkout never completes |
| `STRIPE_KEY_MODE_MISMATCH` | test key against a live endpoint, or the reverse |
| `STRIPE_KEY_INVALID` / `STRIPE_UNREACHABLE` / `STRIPE_ACCOUNT_UNREADABLE` / `STRIPE_ENDPOINTS_UNREADABLE` | could not complete the check |

⚠️ A well-formed config wired to the **wrong Stripe account** is invisible to any amount
of file comparison, and fails only after a customer has paid.

### `--check-hub`

The only probe that proves a **key** rather than a configuration. Needs `MT_BASE_URL`; uses
`AGENT_KEY`, `COALITION_KEY`, `COALITION_URL`, `manifest-pubkey.txt` and `manifest.json`.

| Check | Proves |
|---|---|
| `AGENT_KEY → Flux Hub` | FH still accepts the key your agent authenticates with |
| `COALITION_KEY → deployed Coalition` | the deployed Coalition still accepts it |
| `deployed manifest` | what the Coalition actually serves is signed by **your** key, and is not older than your local `manifest.json` |
| `deployed Coalition build` | which build is live |

⚠️ This exists because **every passive signal you have is key-blind.** FH's stats pull is
unauthenticated, so a Coalition holding a dead credential looks exactly like a healthy one
until a customer's checkout fails.

---

## `sign`

```
mt-manifest sign [--dir <dir>] [--key <pem>]
                 [--from-config <config.env> | --in <body.json>]
                 [--out <manifest.json>] [--stdout]
```

Renders the manifest body from `config.env`, fills in `pubkey` and `publishedAt`, signs
it, and writes the full manifest. **In your operator directory this is just
`mt-manifest sign`** — that is the command you type most often, because it is what
`doctor` tells you to run after any `config.env` edit.

| Option | Default | Meaning |
|---|---|---|
| `--dir <dir>` | `.` | base for every other default |
| `--key <pem>` | `<dir>/manifest-key.pem` | signing key |
| `--from-config <f>` | `<dir>/config.env` | render the body from config (the normal path) |
| `--in <body.json>` | — | sign a hand-built body instead; suppresses the config default |
| `--out <f>` | `<dir>/manifest.json` | where to write |
| `--stdout` | off | write to stdout instead of a file |

With `--in`, `pubkey` and `publishedAt` are overwritten from the key and the clock, the
body is schema-checked, and the result is self-verified before it is emitted.

**What needs a re-sign and what does not.** The manifest carries your identity and your
attested hardware list — `HOSTS`, `OWNER_ADDRESS`, `PROVIDER_LEVEL`. Change any of those
and you must re-sign **and re-paste**. `TIER_PRICES_JSON`, `MT_BASE_URL` and `MT_PUBKEY`
are *not* in the signed manifest: change them, re-run `env`, re-import — no re-sign.

---

## `env`

```
mt-manifest env [--dir <dir>] [--from-config <config.env>] [--secrets <secrets.env>]
                [--manifest <manifest.json>] [--out <env.json>] [--stdout]
```

Assembles the Flux **"Import Environment Variables"** blob: a JSON array of `"KEY=value"`
strings. In a finished scaffold it needs no arguments. Output is mode **0600** and
**contains secrets — never commit it.**

It verifies the manifest signature *before* shipping it, so a placeholder or tampered
manifest is refused rather than deployed. `--manifest` accepts a bare manifest **or** an
`authorize` wrapper; a wrapper's owner signature is verified too, and the whole object
ships verbatim so the owner authorization reaches FH intact. If `config.env`'s
`OWNER_ADDRESS` differs from a wrapper's `ownerAddress`, it warns and ships the signed
manifest's owner.

**What lands in the blob:** `PROVIDER_SLUG`, `MT_BASE_URL` (both required), then
`MT_PUBKEY`, `OWNER_ADDRESS`, `PORT`, `TRIAL_DAYS`, `SESSION_TTL_HOURS`,
`STATS_WINDOW_DAYS` if set; `TIER_PRICES_JSON` (validated as an object of integer cents);
`AGENT_KEY` and `COALITION_KEY` (required); Stripe keys per the rule below;
`SESSION_SECRET`; and `MANIFEST_JSON`, the signed manifest minified to one line and served
verbatim at `/.well-known/mt-provider.json`. Empty values are dropped.

**Stripe is required only if you list a paid tier.** With one or more tiers priced,
missing `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` is fatal. With `TIER_PRICES_JSON={}`
it builds without them and says so — but if you set them anyway they are passed through
rather than dropped, since dropping a key you deliberately set is its own silent failure.

⚠️ Deploy the Flux app as an **enterprise** app. A standard Flux app's environment is
**world-readable**, and this blob holds your Stripe key.

---

## `verify`

```
mt-manifest verify --in <manifest.json>
```

Re-verifies a signed manifest. Accepts either shape you can hold — a bare manifest, or an
`authorize` wrapper, whose owner signature is checked as well (verifying a wrapper's top
level could only ever fail, which used to tell operators their valid manifest was broken).

```
OK — manifest signature valid (bare manifest, no owner authorization)
OK — manifest + owner signature valid (owner 1L1wz2w…)
FAILED — manifest signature invalid                     # exit 1
FAILED — owner wallet signature does not verify against ownerAddress
```

---

## `authorize` *(legacy)*

```
mt-manifest authorize --in <manifest.json>
mt-manifest authorize --in <manifest.json> --signature <b64> --out <signed-manifest.json>
```

⚠️ **The `/onboard` web flow is the supported path.** `authorize` remains for the
URL-fetch ingest path.

Two steps, because a one-shot container has no browser. The first prints the exact
message to sign, the owner address, and a Zelcore deep link. The second validates your
signature against the manifest's `ownerAddress` and emits the `SignedProviderManifest`.

The wrapper embeds the **raw** manifest, not a schema-parsed copy — zod defaults would add
fields and break the detached signature FH re-derives.

---

# `mt-agent`

```
mt-agent [doctor]
```

No flags: everything is configured through `.env.operator`. With no argument it runs the
outbound-only main loop — it pulls jobs and pushes results and listing to Flux Hub;
nothing connects in. It holds the local Proxmox credentials, which never leave your host.

⚠️ **One agent controls one Proxmox system.** To run more than one host from a single
agent, enable Proxmox clustering; the agent detects cluster mode automatically.

## `mt-agent doctor`

The **credentialed** half of onboarding validation. `mt-manifest doctor` proves the files
agree with each other but is deliberately secret-free and cannot ask the hypervisor
anything; these checks need the Proxmox token, which lives here and nowhere else.
Read-only — no VM is created — and exits non-zero on any failure, so it gates a bring-up
before the first provision rather than after a wasted benchmark cycle.

```sh
docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" \
  w2vy/mt-agent:latest doctor
```

It checks that Proxmox is reachable and the token accepted; that the CA trust store is
present; per declared host, that `storageImages` exists **and is not rotational** and that
`storageIso` exists and holds the ArcaneOS ISO; and that the `MANIFEST_KEY` the process
**actually loaded** matches the `MANIFEST_PUBKEY` pin — which is what catches the "the
restart didn't reload it" class rather than just re-reading a file.

```
FAIL  pve30: storageImages "local-lvm" is not rotational
      local-lvm → VG pve → /dev/sda (rotational) — VMs will land on a spinning disk
```

`could not resolve …` means the storage is not LVM-backed and you must confirm the media
yourself — an honest "cannot tell" rather than a guess. With no declared inventory, only
the hypervisor-wide checks run and it says so.

## Dry run

Validates connectivity and auth to Flux Hub **without touching Proxmox**:

```sh
docker run --rm --env-file .env.operator -v "$PWD/data:/data:ro" \
  -e AGENT_DRY_RUN=1 w2vy/mt-agent:latest
# provider=… mt=… auth=signature ownerAuth=enforced courier=on dryRun=true poll=10000ms
```

Read that banner — it is the agent reporting every decision it made about its own
configuration. **Reading the startup banner**, below, decodes each field.

⚠️ **The courier switches itself off silently** unless `MANIFEST_KEY` **and**
`COALITION_URL` **and** `OWNER_ADDRESS` are all set. There is no warning — you simply never
receive authorization requests, and deletes and reprovisions sit forever.
(`mt-manifest doctor` catches this as `COURIER_SILENT_OFF`.)

## Operating the agent

`init` writes `compose.yaml`, so day-to-day operation is plain compose in your operator
directory. There is no `mt-manifest start` — and deliberately so: `mt-manifest` runs as a
container with only your working directory mounted, and giving it control of the host's
Docker would mean handing `/var/run/docker.sock` to the one tool that holds your signing
key. Compose is already the right interface.

| Want to | Run |
|---|---|
| start it | `docker compose up -d` |
| is it running? | `docker compose ps` |
| watch it | `docker compose logs -f` (Ctrl-C stops watching, not the agent) |
| recent logs only | `docker compose logs --tail 50` |
| stop it | `docker compose down` |
| **apply a settings change** | `docker compose up -d --force-recreate` |
| take a newer build | `docker compose pull && docker compose up -d --force-recreate` |
| run a one-off check | `docker compose run --rm agent doctor` |

⚠️ **`restart` is not on that list, and its absence is the point.** `docker compose
restart` re-reads nothing; neither does `docker restart`. The agent comes back on the old
values and fails in exactly the same way, which reads as "my fix didn't work". Always
`--force-recreate` after touching `.env.operator`.

### Reading the startup banner

The agent's first log line is a summary of every decision it made about its own
configuration. Read it before anything else:

```
[agent] provider=acme mt=https://www.moltentech.us auth=signature ownerAuth=enforced \
        courier=on dryRun=false poll=10000ms listing=60000ms
```

| Field | Good | What the other value means |
|---|---|---|
| `auth=` | `signature` | `bearer` — it fell back to the legacy `AGENT_KEY`; `MANIFEST_KEY` did not load |
| `ownerAuth=` | `enforced` | `off` — `OWNER_ADDRESS` is unset; privileged actions are not owner-checked |
| `courier=` | `on` | `off` — **you will never receive authorization requests**, and deletes/reprovisions sit forever |
| `dryRun=` | `false` | `true` — it is pretending. Forced on when `PROXMOX_URL` or `PROXMOX_TOKEN_SECRET` did not load |

### When something is wrong

1. `mt-manifest doctor` — do the files still agree? Changes nothing; its last line is
   usually the command to run next.
2. `mt-manifest doctor --check-proxmox --check-hub` — do the credentials still work?
3. `docker compose logs --tail 50` — and read the banner above.

| Symptom | Cause |
|---|---|
| a corrected key still 401s | the container was `restart`ed, not `--force-recreate`d |
| deletes and reprovisions never complete | `courier=off` — needs `MANIFEST_KEY` **and** `COALITION_URL` **and** `OWNER_ADDRESS` |
| nodes provision fine, then fail every benchmark | VM storage is on a spinning disk — `mt-agent doctor` |
| `self-signed certificate in certificate chain` | the image is missing its CA store; not your network, not Proxmox |
| inventory edits have no effect | `data/` was mounted as a file, not a directory |
| your listing vanished from Flux Hub | agent or Coalition unreachable; FH hides it and restores it on its own |
| checkout 502s | Coalition price ≠ listing price (`mt-manifest doctor`) |
| checkout 401s | `MT_PUBKEY` empty in the Coalition's environment |

---

## `.env.operator` reference

| Variable | Default | Notes |
|---|---|---|
| `MANIFEST_KEY` | — | base64 of the PEM; asymmetric auth, **preferred** |
| `MANIFEST_PUBKEY` | — | the **public** pin `doctor` compares against. Not a secret. Leave it out and that check can only report `skip`, so a wrong key is not caught until FH rejects a signature |
| `AGENT_KEY` | — | legacy bearer auth. At least one of these two must be set; keep both while rolling over |
| `OWNER_ADDRESS` | — | enables owner-auth enforcement + the courier |
| `COALITION_URL` | — | trailing slash stripped; required for the courier |
| `PROXMOX_URL` | — | an address the **container** can reach: your Proxmox LAN IP, not `127.0.0.1` (which is the container's own loopback). Or run with `--network host` if the agent is on the Proxmox host |
| `PROXMOX_TOKEN_ID` | — | e.g. `fluxhub@pve!agent` — a **credential, not a label**; renaming it breaks every Proxmox call |
| `PROXMOX_TOKEN_SECRET` | — | |
| `PROXMOX_NETWORK` | `vmbr0` | |
| `PROXMOX_STORAGE_IMAGES` | `local-lvm` | ⚠️ the default is frequently the spinning disk — see `--check-proxmox` |
| `PROXMOX_STORAGE_ISO` | `local` | must be readable by every host |
| `PROXMOX_STORAGE_IMPORT` | `local` | |
| `ARCANE_ISO` | `FluxLive.iso` | |
| `OPERATOR_SSH_PUBKEY` | `""` | |
| `CONSOLE_PASSWORD_HASH` | `!` | |
| `AGENT_INVENTORY_PATH` | — | normally `/data/inventory.json`; `AGENT_INVENTORY_JSON` is the inline alternative |
| `AGENT_LISTING_JSON` | — | what to offer for sale, re-asserted each heartbeat. How much hardware you **have** comes from inventory, not from here |
| `AGENT_DRY_RUN` | `0` | `1` = talk to FH, touch nothing |
| `AGENT_POLL_INTERVAL_MS` | `10000` | job poll |
| `AGENT_LISTING_INTERVAL_MS` | `60000` | listing re-assert |
| `AGENT_HEALTH_INTERVAL_MS` | `60000` | health push |
| `AGENT_REFRESH_ISO_INTERVAL_MS` | `21600000` | 6h ISO refresh |
| `FOUNDATION_VM_PREFIX` | built-in | lowercased on load |

⚠️ **Mount the directory, not the file** — `-v "$PWD/data:/data:ro"`. A single-file bind
mount pins the container to an inode that an atomic editor save detaches, after which your
edits silently stop reaching the agent.

⚠️ **"self-signed certificate in certificate chain"** means the image is missing its CA
store. It is not a middlebox on your network and not a Proxmox certificate problem.

---

## Which command, when

| Situation | Run |
|---|---|
| First time, from nothing | `keygen` → `init` → paste `manifest.json` at `/onboard` |
| `/onboard` gave me three keys | put them in `secrets.env`, then `doctor` |
| Everything is filled in — is it right? | `doctor`, then `doctor --check-proxmox --check-stripe` |
| I edited `config.env` | `sign`, then `env`, then re-import to Flux |
| I changed a price | `env`, then re-import — **no re-sign** |
| I added a Proxmox host | edit `HOSTS` in `config.env` → `sign` → **re-paste at `/onboard`** → `env` → re-import |
| Ready to deploy the Coalition | `env` → import `env.json` into the Flux app (**enterprise**) |
| Ready to start the agent | `mt-agent doctor`, then `docker compose up -d` |
| Checkout is failing and nothing looks wrong | `doctor --check-hub --check-stripe` |
| I changed `.env.operator` | `docker compose up -d --force-recreate` |
| Someone handed me a manifest | `verify --in <file>` |
