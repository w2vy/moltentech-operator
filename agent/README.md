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
| `AGENT_KEY` | yes | per-provider key (MT admin → Providers → Issue keys) |
| `PROVIDER_SLUG` | yes | your provider slug |
| `PROXMOX_URL` / `PROXMOX_TOKEN_ID` / `PROXMOX_TOKEN_SECRET` | for real provisioning | local only; never sent to MT |
| `AGENT_LISTING_JSON` | optional | price + slots offered per tier (heartbeat) |
| `AGENT_POLL_INTERVAL_MS` / `AGENT_LISTING_INTERVAL_MS` | optional | default 10s / 60s |
| `AGENT_DRY_RUN` | optional | `1` to skip Proxmox |

## Status

`v0.1.0` — control plane (claim/result/listing) complete and verified against the
live MoltenTech agent API. The arcane-mage executor (real Proxmox provisioning) is
the remaining integration point — see `src/executor.ts`; it reuses the same engine
as `apps/provisioner`. To be extracted to the public `moltentech-operator` repo.
