# fh-burner

Burn-in for an **empty** Proxmox host before it carries nodes. `fh-toolkit burn <host>`
(coming) boots N burn VMs sized like the host's slots and ramps them 1..N. At each step
every VM fills its memory, then all of them run a CPU test and a disk write at the same
moment, while the host is sampled.

The verdict is about the **host** surviving, not the scores:

| Verdict | When |
|---|---|
| **FAIL** | kernel OOM, hung task or I/O error; a burn VM stops or its guest agent goes silent; MemAvailable < 200 MB with < 512 MB swap free; memory pressure (full) > 40% |
| **WARN** | MemAvailable < 1 GB, any swap-out, or memory pressure (full) > 5% |
| **OK** | none of the above |

EPS and MB/s are reported as a drop from the 1-VM step. They are not Flux benchmark
numbers: sysbench here runs at Flux's settings (`--cpu-max-prime=60000`), but on pve25
it read ~15% under what the Flux benchmark reported for a real nimbus on that same
host, and no `dd` flag set matches Flux's `ddwrite`.

Proven on pve25 (i7-4770, 32 GB): one nimbus at 31744 MB with `--fill max` is **WARN**
with zram + disk swap + KSM on (54 MB left, 2.9 GB swapped out) and **FAIL** with them
off (the host OOM-killed the burn VM).

## Files

| File | Runs | What |
|---|---|---|
| `build-image.sh` | CI | Debian 13 genericcloud + sysbench + qemu-guest-agent + `burn-run` → `fh-burner-<ver>.qcow2` |
| `burn-run` | in each burn VM | one phase (`mem`, `eps`, `dd`, `memfree`, `version`), started at a shared time |
| `fh-burner-grow` (+ `.service`) | in each burn VM, first boot | grows `/` to the disk (cloud-init is disabled) |
| `burn-host.sh` | on the host, as root | builds template 9900 from the image, clones 9901+, ramps, samples, verdict |
| `VERSION` | — | release tag `fh-burner-v<VERSION>` |

Burn VMs have **no network**: the host drives them through the qemu-guest-agent socket.
They are tagged `fh-burn` and destroyed on exit (also on Ctrl-C) unless `--keep`.
Results stay on the host in `/var/tmp/fh-burn/<run>/` (`log`, `host.csv`, per-VM JSON).

## Release

`publish-fh-burner.yml`: a PR touching `burner/` builds the image as a 2-day workflow
artifact (boot it on a real host before releasing). Releasing is a manual dispatch on
master; bump `VERSION` for any image change — an existing release tag is never replaced.

## Run by hand (until `fh-toolkit burn` exists)

```bash
# on the host, as root
burn-host.sh --image /var/lib/vz/fh-burn/fh-burner-0.1.0.qcow2 \
  --tier nimbus --n 1 --mem 31744 --cores 8 --pool local-lvm --fill max
```
