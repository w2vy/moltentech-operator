# MoltenTech Operator

Source-available bundle for running a **MoltenTech marketplace operator** — host
Flux nodes on your own Proxmox hardware and sell that capacity through the
MoltenTech marketplace. You stay merchant of record (your own Stripe, or FLUX);
MoltenTech holds **none** of your hypervisor or payment credentials and opens
**no** inbound connection to you.

## Architecture

Three components, each isolated by trust boundary:

| Component | Where it runs | Holds | Network |
|-----------|---------------|-------|---------|
| **`agent/`** | A trusted always-on host with LAN reach to your Proxmox `:8006` | Your **local Proxmox token** | Outbound only — pulls provision jobs from MoltenTech, never receives a push |
| **`coalition/`** | A Flux node (ArcaneOS) — the inbound leg | Your **restricted Stripe key + webhook secret** (if using Stripe) | Inbound: serves the signed manifest + stats; relays Stripe webhooks outbound to MoltenTech |
| **`protocol/`** | Shared library | — | The typed wire contracts (zod) both legs speak + the manifest signing CLI |

The **agent** provisions your local Proxmox via the bundled
[`arcane-mage`](https://github.com/w2vy/arcane-mage) fork (cluster support
included) — submoduled here, so a standalone box *or* a full PVE cluster both
work with one agent. Credentials never leave your machines.

## Quick start

```bash
git clone --recurse-submodules https://github.com/w2vy/moltentech-operator.git
cd moltentech-operator
cp .env.operator.example .env.operator   # fill the subset each host needs

# On the operator's Proxmox box (or any Docker host with LAN reach to :8006):
docker compose -f docker-compose.operator.yml --profile agent    up -d --build

# On your Flux node (the inbound leg):
docker compose -f docker-compose.operator.yml --profile coalition up -d --build
```

Already cloned without submodules? `git submodule update --init --recursive`.

## Onboarding

Full step-by-step (sign your manifest → configure Stripe → deploy both legs →
hand off to MoltenTech for key issuance + activation) is in
[`docs/operator-onboarding.md`](docs/operator-onboarding.md).

Sign your provider manifest with the bundled CLI:

```bash
cd protocol && npm install
npm run manifest keygen          # ed25519 keypair (manifest-key.pem — keep private)
npm run manifest init            # body template
npm run manifest sign            # stamps pubkey + signs the canonical body
npm run manifest verify          # self-check
```

## Secrets

Nothing secret is ever committed. `.env.operator`, `manifest.json`,
`manifest-key.pem`, and the pubkey/body files are gitignored. The manifest
carries **no** secrets — your Proxmox token and Stripe keys live only in
`.env.operator` on the host that needs them.

## License

MIT — see [LICENSE](LICENSE).
