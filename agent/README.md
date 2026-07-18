# @moltentech/operator-agent

Outbound-only provisioning agent an operator runs on (or beside) their Proxmox.
It **pulls** jobs from MoltenTech, executes them on the **local** Proxmox, and
**pushes** results + listing back. It holds the local Proxmox credentials and the
per-provider agent key; it opens **no inbound** path.

```
MoltenTech  ──(agent pulls)──▶  POST /api/agent/jobs/claim   ─┐
                                                              │ execute on local Proxmox (arcane-mage)
MoltenTech  ◀──(agent pushes)─  POST /api/agent/jobs/{id}/result
MoltenTech  ◀──(heartbeat)────  PUT  /api/agent/listing  (price/slots offered)
```

Stats and payments are NOT here — those live on the operator's **Coalition** (the
inbound leg). This agent is control-plane only; the Flux nodes run on Proxmox.

## Run

```sh
npm install
MT_BASE_URL=https://www.moltentech.us \
AGENT_KEY=<per-provider agent key from MT admin> \
PROVIDER_SLUG=<your-slug> \
PROXMOX_URL=https://127.0.0.1:8006 \
PROXMOX_TOKEN_ID='root@pam!agent' \
PROXMOX_TOKEN_SECRET=<secret> \
AGENT_LISTING_JSON='[{"tier":"nimbus","priceCents":2200,"availableSlots":3}]' \
npm start
```

`AGENT_DRY_RUN=1` (or omitting Proxmox creds) runs the control loop without
touching Proxmox — useful to validate connectivity/auth against MoltenTech.

## Config (env)

| Var | Required | Notes |
|---|---|---|
| `MT_BASE_URL` | yes | MoltenTech base URL |
| `PROVIDER_SLUG` | yes | your provider slug |
| `MANIFEST_KEY` | **one of** | base64 PKCS#8 PEM of your manifest ed25519 key — the agent SIGNS its requests. Preferred. |
| `AGENT_KEY` | **one of** | legacy per-provider bearer (MT admin → Providers → Issue keys). Startup fails only if BOTH are unset; if both are set, signing wins. |
| `OWNER_ADDRESS` | recommended | your Flux/ZelID address. Set = the agent REFUSES privileged jobs (delete/reprovision/move) without a matching owner signature. Unset = enforcement off. Never sourced from MT. |
| `COALITION_URL` | for the courier | your Coalition's base URL. **Unset silently means `courier=off`** — check the startup banner. |
| `AGENT_INVENTORY_PATH` / `AGENT_INVENTORY_JSON` | to declare hardware | the hosts + slots you declare to MT (path is re-read each heartbeat, so edits apply without a restart). MT materializes ProxmoxHost/Slot rows from this — it is the source of truth for what hardware exists, and MT rejects any host not in your owner-signed manifest. |
| `PROXMOX_URL` / `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` | for real provisioning | local only; never sent to MT |
| `PROXMOX_NETWORK` / `PROXMOX_STORAGE_IMAGES` / `PROXMOX_STORAGE_ISO` / `PROXMOX_STORAGE_IMPORT` | optional | per-host defaults stamped into the provision YAML (`vmbr0` / `local-lvm` / `local` / `local`) |
| `ARCANE_ISO` | optional | ArcaneOS ISO filename to stage (default `FluxLive.iso`) |
| `OPERATOR_SSH_PUBKEY` / `CONSOLE_PASSWORD_HASH` | optional | stamped into provisioned nodes |
| `AGENT_LISTING_JSON` | optional | price + slots offered per tier (heartbeat). This is SELLING intent — how much hardware you HAVE comes from the inventory above. |
| `AGENT_POLL_INTERVAL_MS` / `AGENT_LISTING_INTERVAL_MS` / `AGENT_HEALTH_INTERVAL_MS` / `AGENT_REFRESH_ISO_INTERVAL_MS` | optional | default 10s / 60s / 60s / 6h |
| `AGENT_DRY_RUN` | optional | `1` to skip Proxmox |

> **Changing any of these needs the container RECREATED, not restarted** — `docker restart`
> does not reload `--env-file`.

## Status

`v0.1.0` — control plane (claim/result/listing) complete and verified against the
live MoltenTech agent API. The arcane-mage executor (real Proxmox provisioning) is
the remaining integration point — see `src/executor.ts`; it reuses the same engine
as `apps/provisioner`. To be extracted to the public `moltentech-operator` repo.
