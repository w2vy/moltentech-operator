# Adding a Proxmox host

You already run an agent against one Proxmox host or cluster, and you have another machine to
add. There are two ways, and one agent serves both:

| | **Standalone** | **In a cluster** |
|---|---|---|
| The new host | stays on its own | joins your existing host's cluster |
| The agent reaches it | at its own address, with its own token | through the cluster's one address |
| If one host is down | the others are not affected | two hosts: the other refuses changes |
| Good for | two hosts, different sites, hosts with nodes on them already | three or more hosts side by side |

Standalone needs fh-agent 0.11.97 and fh-toolkit 0.6.53 or newer (`fh-agent version`,
`fh-toolkit version`). 0.11.95 and 0.11.96 work too, but can report a failed teardown for a VM that
was destroyed.

| | Step | Where | Standalone | Cluster |
|---|---|---|---|---|
| 1 | [Install Proxmox](#1-install-proxmox) | new host | yes | yes |
| 2 | [Create the cluster](#2-create-the-cluster-first-time-only) (first time only) | existing host | — | yes |
| 3 | [Check and burn in the host](#3-check-and-burn-in-the-host) | agent host → new host | yes | yes |
| 4 | [Join the cluster](#4-join-the-cluster) | new host | — | yes |
| 4s | [Give the agent its login](#4s-standalone-give-the-agent-its-login) | agent host | yes | — |
| 5 | [Attest the host](#5-attest-the-host) | agent host, Flux, `/onboard` | yes | yes |
| 6 | [Add it to your inventory](#6-add-it-to-your-inventory) | agent host | yes | yes |
| 7 | [Offer the slots](#7-offer-the-slots-operators-only) (Operators only) | agent host | yes | yes |
| 8 | [Verify](#8-verify) | hub | yes | yes |

⚠️ **The order matters:**

- **Attest (5) before inventory (6).** Flux Hub answers an inventory that names an unattested
  host with a 409 and rejects **all** of it, your existing hosts included.
- **Burn in (3) before inventory (6).** A new slot starts as `available`. Once the inventory is
  accepted, a node can be placed on it.
- **Standalone: login (4s) before inventory (6).** Without it the agent looks for the new host at
  your first host's address, and its jobs fail.

The examples use `pve1` (`192.168.1.11`) for the host you already have and `pve2`
(`192.168.1.12`) for the new one.

## Before you start

Both ways:

- **Its Proxmox node name must be different from every other host's.** Jobs and signatures name a
  host by it. Two hosts both called `pve` cannot be told apart; rename the new one at install.
- **Time** is in sync on every host.
- **A wallet session** if you paste the manifest at `/onboard` in step 5: it asks for your owner
  wallet's signature.

Standalone:

- **The agent host reaches the new host on TCP 8006**, and you reach it by ssh for step 3.

- **Flux nodes already on the new host** can stay: see
  [A host that already runs Flux nodes](#a-host-that-already-runs-flux-nodes-standalone).

Cluster:

- **The new host must have no VMs or containers.** A join replaces everything in its
  `/etc/pve`, and VM ids would clash. Back guests up with `vzdump` and restore them under a new
  id afterwards.
- **Two standalone hosts, both with nodes on them?** Keep one as the first cluster member. The
  other has to be emptied before it can join.
- **Same Proxmox version** on every host, so update them first.
- **Final hostname and IP.** Neither can be changed once the host is in a cluster.
- **Network:** hosts reach each other on UDP 5405–5412 and TCP 22 and 8006, with low, steady
  latency. Do not stretch a cluster across sites.

⚠️ **A two-host cluster needs both hosts up.** With one down the other loses quorum: running VMs
keep running, but Proxmox refuses changes, so nothing can be built or started until the other
returns. A third host, or a [QDevice](https://pve.proxmox.com/wiki/Cluster_Manager) on any small
always-on Linux box, fixes that.

## 1. Install Proxmox

1. In the BIOS, turn on virtualization (VT-x/AMD-V) and power-on after an AC loss.
2. Install Proxmox VE with the final hostname and a static IP.
3. Give it the bridge your nodes use (normally `vmbr0`). Nodes on a VLAN need a VLAN-aware
   bridge that carries it.
4. Update it and reboot:
   ```bash
   apt update && apt full-upgrade
   reboot
   ```
5. Put the name in `/etc/hosts` on every Proxmox host and on the agent host:
   ```
   192.168.1.12 pve2.localdomain pve2
   ```

**Optional: Wake-on-LAN**, to start the host from another machine on its network. Turn it on in the
BIOS (`Wake on LAN`, with `Deep Sleep` / `ErP` off). Many network drivers turn it off again at every
boot, so check, with the port's name from `bridge-ports` in `/etc/network/interfaces`:

```bash
ethtool nic0 | grep Wake-on       # last line must be "Wake-on: g"; "d" is off
```

If it says `d`, a unit arms it at every boot:

```bash
cat > /etc/systemd/system/wol-nic0.service <<'EOF'
[Unit]
Description=Arm Wake-on-LAN on nic0
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/ethtool -s nic0 wol g

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now wol-nic0.service
```

Reboot and check again. Then test it once while someone can reach the power button.

**Storage, in a cluster.** A cluster has one storage list for all hosts, so after the join the new host uses
the cluster's definitions. A `local-lvm` defined as volume group `pve`, thin pool `data` works
only if this host has that too, which the standard installer creates. Check it:

```bash
lvs                    # expect LV "data" in VG "pve"
lsblk -o NAME,ROTA,SIZE,TYPE,MODEL
```

**Storage, standalone.** Any names you like: they go in this host's inventory entry. `local` must
take ISO images and imports:

```bash
pvesm set local --content iso,vztmpl,backup,import
```

**Both.** The pool must be solid state (`ROTA=0`) and hold every planned node: 220 GB per Cumulus, 440 GB
per Nimbus, 880 GB per Stratus. A 1 TB drive leaves about 800 GB after Proxmox, which is **too
small for a Stratus or two Nimbus**. To grow the pool with a second, empty drive:

```bash
ls -l /dev/disk/by-id/            # use the by-id name; nvme0/nvme1 can swap on reboot
wipefs -a /dev/disk/by-id/<disk>  # ERASES that drive
pvcreate /dev/disk/by-id/<disk>
vgextend pve /dev/disk/by-id/<disk>
lvextend -l +100%FREE pve/data /dev/disk/by-id/<disk>
```

The pool then spans both drives: if either fails, every node on it is lost.

## 2. Create the cluster (first time only)

**Cluster only.** Also skip this if `pvecm status` on the existing host already shows a cluster.

On the **existing** host, the one with the nodes and your agent's token:

```bash
pvecm create <cluster-name>       # permanent; cannot be renamed
pvecm status
```

Its VMs, storage and API token stay as they are, and the agent keeps using it.

## 3. Check and burn in the host

`host-check` and `burn` read the host from an inventory. Use a **separate copy**, so the host is
not declared to Flux Hub yet. In your operator directory on the agent host:

```sh
mkdir -p newhost/data
cp config.env newhost/
$EDITOR newhost/data/inventory.json     # ONLY the new host, as in step 6
```

```sh
fh-toolkit host-check pve2 --dir newhost | ssh root@pve2 bash
fh-toolkit burn       pve2 --dir newhost | ssh root@pve2 bash
```

`host-check` only reads; do what it lists and run it again. `burn` creates throwaway VMs and
removes them. What the verdicts mean:
[Step 0.6](operator-onboarding.md#06-small-ram-hosts-16-gb--32-gb-desktops) and
[Step 0.7](operator-onboarding.md#07-burn-in-a-new-host-before-it-carries-nodes). Do not go on
after a `FAIL`.

Check that nothing is left behind (to join a cluster the host must be empty):

```bash
qm list; pct list                 # on pve2: both empty
```

## 4. Join the cluster

**Cluster only.** On the **new** host:

```bash
pvecm add 192.168.1.11 --link0 192.168.1.12
```

`192.168.1.11` is any host already in the cluster; `--link0` is the new host's own IP. It asks
for that cluster host's root password and to accept its fingerprint. In the web UI instead:
existing host **Datacenter → Cluster → Join Information → Copy Information**, then new host
**Datacenter → Cluster → Join Cluster**. The UI session on the new host drops; log in again.

Check it from any host in the cluster:

```bash
pvecm status                      # Quorate: Yes, and one more node than before
pvesh get /nodes/pve2/storage     # your image and ISO storages show active 1
```

- **No new token.** Users, roles and tokens belong to the cluster, so the agent's existing token
  covers the new host. A token made on the new host before the join is gone.
- **Leave `PROXMOX_URL` alone.** The agent reaches every host through that one endpoint.
- **Other hosts' local storages** show inactive on the new host. Limit each to its own host
  under **Datacenter → Storage → Edit → Nodes**.

## 4s. Standalone: give the agent its login

In your operator directory on the agent host, with the node name Proxmox shows:

```sh
fh-toolkit proxmox --host pve2
```

Give it the new host's own address (`https://192.168.1.12:8006`; an IP always works). Answer **n**
to "already have a token" and it creates `fh-agent@pve!agent` on the new host, then checks that the
login works and that the host really is called `pve2`. It writes three lines to `.env.operator`:

```
PROXMOX_URL_PVE2=https://192.168.1.12:8006
PROXMOX_TOKEN_ID_PVE2=fh-agent@pve!agent
PROXMOX_TOKEN_SECRET_PVE2=…
```

The plain `PROXMOX_URL` / `_TOKEN_ID` / `_TOKEN_SECRET` stay as they are: every host without lines of
its own uses them. A host with only some of its three lines is refused, never sent to the plain ones.

```sh
fh-agent restart                  # the agent reads .env.operator only at start
fh-agent logs
```

The log shows `own Proxmox endpoint for PVE2 (no inventory host by that name yet)`. That is right
until step 6. `PROXMOX_NETWORK` and `PROXMOX_STORAGE_*` are shared defaults: a host that differs says
so in its inventory entry (`network`, `storageImages`, `storageIso`). The import storage has no
per-host setting and must have the same name on every host, normally `local`.

Keep these lines for as long as the host has nodes. Without them its teardowns fail, with a message
naming the lines.

## 5. Attest the host

In your operator directory on the agent host:

1. Add the host to `HOSTS` in `config.env`:
   ```
   HOSTS=pve1,pve2
   ```
2. Re-sign and rebuild the Coalition's environment:
   ```sh
   fh-toolkit sign
   fh-toolkit doctor
   fh-toolkit env
   ```
3. Re-import `env.json` on Flux: **My Applications → your Coalition → Update**, then steps 4–9
   of [flux-app-registration.md](flux-app-registration.md), then **Free Deploy**.
4. Flux Hub reads the new manifest from your Coalition within 15 minutes. To apply it at once,
   paste `manifest.json` at `{MT_BASE_URL}/onboard` and sign with your owner wallet. Do the
   re-import as well, so the Coalition serves the same manifest.
5. Check that the Coalition serves the new host:
   ```sh
   curl -s <COALITION_URL>/.well-known/mt-provider.json | grep -o '"pve2"'
   fh-toolkit doctor --check-hub
   ```
   `doctor --check-hub` compares your files with your **Coalition**. It does not show what Flux
   Hub has read, so without the `/onboard` paste, wait the 15 minutes.

Adding a name to `HOSTS` before the inventory has it is harmless.

## 6. Add it to your inventory

Add the host to `data/inventory.json`:

```json
{
  "name": "pve2",
  "nodeName": "pve2",
  "apiUrl": "https://pve2:8006",
  "network": "vmbr0",
  "storageImages": "local-lvm",
  "storageIso": "local",
  "slots": [
    { "vmName": "mt-you-n2", "tier": "nimbus", "ipAddress": "203.0.113.51",
      "lanIp": "192.168.1.52/24", "gateway": "192.168.1.1", "apiPort": 16137,
      "network": "vmbr0", "storagePool": "local-lvm" }
  ]
}
```

- `name` matches `HOSTS`; `nodeName` is the name Proxmox shows. Standalone: the `_PVE2` in step 4s
  comes from `nodeName`.
- `apiUrl` is for reading only. The agent never connects to it.
- `vmName` is new, and starts with your VM name prefix.
- Each `ipAddress` + `apiPort` pair is used once. `lanIp` needs its `/24`.
- Every field: [Step 5 of onboarding](operator-onboarding.md#step-5--declare-your-inventory-no-db-hand-edits).

```sh
fh-toolkit doctor --check-proxmox
fh-agent logs
```

The agent re-reads the file within about a minute; no restart. The log shows the new count:

```
[agent] declared inventory: 2 host(s), 4 slot(s)
```

A new standalone host gets its FluxLive ISO at the agent's next refresh, up to 6 hours away. To have
it now: `fh-agent restart`. The first copy is about 3 GB; `fh-agent doctor` fails on that host's ISO
until it has landed.

`inventory failed: 409` means the hub refused it; see [If something goes wrong](#if-something-goes-wrong).

`fh-toolkit inventory` can write the entry for you, but it changes the inventory **and** re-signs
the manifest in one go. Use it here, after step 5, when `HOSTS` already has the host.

Once it is accepted, delete the copy from step 3: `rm -r newhost`.

### A host that already runs Flux nodes (standalone)

Skip `burn` in step 3: it refuses a host with its node VMs on it. Do 4s and 5 as above. In this
step, the slot that stands for a running VM carries an `existingVm` with the VM's id and its
current Proxmox name:

```json
{ "vmName": "mt-you-n2", "tier": "nimbus", "ipAddress": "203.0.113.51",
  "lanIp": "192.168.1.52/24", "gateway": "192.168.1.1", "apiPort": 16137,
  "network": "vmbr0", "storagePool": "local-lvm",
  "existingVm": { "vmid": 900, "name": "oldnode" } }
```

`ipAddress` and `apiPort` are the ones the node already answers on.
[`fh-toolkit inventory`](fh-toolkit.md#inventory) finds such VMs and writes the mark for you.

⚠️ **Put the mark in the first time the host goes into the inventory.** Without it the slot is
`available`, and a second node can be built for the same IP and port.

The slot shows in `maintenance` on My Fleet. Click **Adopt as my node**: the VM is renamed to the
slot's `vmName`, keeps running, and is your own node. Ending that rental later **destroys the VM**,
after your owner signature. The mark can then come out of the file.

## 7. Offer the slots (Operators only)

Inventory says what you **have**; `AGENT_LISTING_JSON` in `.env.operator` says what you **offer**.
Raise `availableSlots` for the tier, then:

```sh
fh-agent restart                  # the agent reads its listing only at start
```

Jobs go to a tier's oldest free slot first, so a first node would land on an existing host. To try
the new host, **Park** the other free slots of that tier on My Fleet, claim, then **Return to sale**.

A tier you have never sold also needs a price: `fh-toolkit stripe --price <tier>=<usd>`, then
`fh-toolkit env` and the re-import from step 5. Supporters skip this step.

## 8. Verify

- **My Fleet** (`/operator/fleet`) shows the host and its slots.
- `fh-agent logs` shows no `inventory failed` and no ISO error for the new host.
- The first node goes provision → bootstrap → benchmark → active.

## If something goes wrong

| You see | Do |
|---|---|
| `inventory failed: 409` | The hub does not have the host attested yet, or a `vmName` is outside your prefix or belongs to someone else. Take the new host back out of `data/inventory.json` now; your other hosts recover on the next heartbeat. Finish step 5, then add it again. **Do not leave it:** after two hours without an accepted inventory, your unrented slots are disavowed. |
| `Proxmox endpoint for pve2 is incomplete — missing …` in the log at start, or a job fails with `Proxmox credentials for pve2 are incomplete` | Step 4s: the named `_PVE2` line is missing or empty. Add it, then `fh-agent restart`. The other hosts keep working meanwhile. |
| The log says `proxmox query failed for node pve2: proxmox 500` and `ISO refresh failed on pve2 … hostname lookup 'pve2' failed` | All three `_PVE2` lines are gone, so the agent asks your first host for pve2. Put them back (step 4s), then `fh-agent restart`. |
| `fh-toolkit proxmox --host pve2`: `token … already exists` | Left from an earlier login. Use its secret if you have it. If not, on pve2: `pveum user token remove fh-agent@pve agent`, then run it again. |
| A teardown fails with `… was not torn down: Proxmox at … has no node pve2` | The agent asked another host: the `_PVE2` lines are gone, or their name does not match `nodeName`. Fix them, `fh-agent restart`, then sign the teardown again in the **Signing Queue**. Nothing was destroyed; the VM is still running. |
| A teardown fails with `… was not torn down: pve2 is offline`, or `Unable to discover hypervisor nodes` (standalone) | The host is off or does not answer, so the VM may still be on it. Bring it back, then sign the teardown again in the **Signing Queue**: a signature works once, so **Retry** on the Jobs page is refused. |
| A teardown signed while the host shuts down fails with `can't lock file … got timeout` | Proxmox's own shutdown holds the VM. Once the host is back, sign it again. |
| A teardown succeeds with `VM '…' not found`, and the slot is in maintenance | The VM was already gone. Check that, then **Return to sale** on My Fleet. |
| `fh-agent doctor` says `ENOTFOUND` for a host name the running agent reaches | Wrapper older than v12: `fh-toolkit --update-wrapper`. Or use the IP. |
| `fh-agent doctor` dies with `ENOENT … inventory.json` while the running agent is fine | `doctor` sees only `data/`. Move the inventory to `data/inventory.json`, mount `./data:/data:ro` in `compose.yaml`, set `AGENT_INVENTORY_PATH=/data/inventory.json` in `.env.operator`, then `fh-agent restart`. |
| `fh-agent doctor` fails on the ISO of a host you just added | The first copy is still downloading (about 3 GB). Run it again once the log shows it landed. |
| `doctor`: `HOST_PROXMOX_UNUSED` | Normal between 4s and 6. After 6, the name in the lines does not match a `nodeName`. |
| `pvecm add` refuses: guests exist | Step 3's check. Move or remove every VM and container on the new host. |
| `pvecm add` cannot connect | Firewall: UDP 5405–5412, TCP 22 and 8006, both ways. |
| `local-lvm` inactive on the new host | Its volume group or thin pool is named differently (step 1). |
| `Network not present on hypervisor` | The bridge is missing on the new host, or the token lacks `SDN.Audit` / `SDN.Use` ([Step 0.1](operator-onboarding.md#01-create-an-api-token)). |
| Plain `ssh pve1` from the new host: `Host key verification failed` | Proxmox keeps its own per-node key files, so this alone does not mean the cluster is broken. Judge by `pvecm status`. |
| `Renewed cluster CA certificate` during the join | Only matters if you imported the cluster's CA somewhere: import the new `/etc/pve/pve-root-ca.pem` there. |
| No network after swapping the host's motherboard | The network port's name or MAC changed. `ip -br link` shows the new name: put it in `bridge-ports` in `/etc/network/interfaces`, then `ifreload -a`. |

## Taking it out again

**Standalone**, in this order; your other hosts are not affected:

1. End or move its nodes. Keep its three login lines until the last one is torn down.
2. Take its entry out of `data/inventory.json`. Within about a minute its free slots show
   `Disavowed` on My Fleet.
3. **My Fleet → No longer in your inventory → Retire** each slot, then **Retire host** if it is still
   listed. This deletes their history on Flux Hub and cannot be undone. More:
   [Retiring a host](operator-onboarding.md#retiring-a-host).
4. In `.env.operator`, lower `availableSlots` in `AGENT_LISTING_JSON` (Operators) and delete the
   host's three lines, then `fh-agent restart`.
5. On the host, remove the agent's token:
   ```bash
   pveum user token remove fh-agent@pve agent
   ```

Leaving its name in `HOSTS` is harmless. To put it back, with the name still in `HOSTS`: 4s, 6 and 7.

**Cluster:** [retire it from Flux Hub](operator-onboarding.md#retiring-a-host) first. Then, with
every VM off it and the host **powered off for good**, run `pvecm delnode pve2` on a remaining host.
To put the same machine back in the cluster, reinstall Proxmox on it first.
