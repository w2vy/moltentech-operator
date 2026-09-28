# fh-burner

Burn-in for an **empty** Proxmox host before it carries nodes. `fh-toolkit burn <host>`
([docs](../docs/fh-toolkit.md#burn)) boots N burn VMs sized like the host's slots and ramps them 1..N. At each step
the new VM fills its memory while every VM writes to disk, then all of them run a CPU test
and a disk write at the same moment, while the host is sampled.

The verdict is about the **host** surviving, not the scores:

| Verdict | When |
|---|---|
| **FAIL** | kernel OOM, hung task or I/O error; a burn VM stops or its guest agent goes silent; the host stalls (a 1-s sample > 6 s late); MemAvailable < 200 MB with < 512 MB swap free; memory pressure (full) > 40% |
| **WARN** | MemAvailable < 1 GB, any swap-out, or memory pressure (full) > 5% |
| **OK** | none of the above |
| **ERROR** | a burn VM could not be created or started (storage, a leftover VM). Says nothing about the host; no 90% re-run; exit 3 |

EPS and MB/s are reported as a drop from the 1-VM step. They are not Flux benchmark
numbers: sysbench here runs at Flux's settings (`--cpu-max-prime=60000`), but on pve25
it read ~15% under what the Flux benchmark reported for a real nimbus on that same
host, and no `dd` flag set matches Flux's `ddwrite`.

`--fill max` (the default) has each VM use all its memory; when that FAILs the ramp runs
again at 90%. On pve25 (i7-4770, 32 GB), one nimbus at 31744 MB with the disk busy: all
memory **FAIL**s with zram + disk swap + KSM on (thrashing, host stalled 12 s), with only
HDD swap (stalled 8–9 s, guest agent lost), and with no swap (OOM kill); 90% is a **WARN**.

## Files

| File | Runs | What |
|---|---|---|
| `build-image.sh` | CI | Debian 13 genericcloud + sysbench + qemu-guest-agent + `burn-run` → `fh-burner-<ver>.qcow2`, plus `burn-host.sh` as `fh-burner-<ver>-host.sh` |
| `burn-run` | in each burn VM | one phase (`mem`, `eps`, `dd`, `memfree`, `version`), started at a shared time |
| `fh-burner-grow` (+ `.service`) | in each burn VM, first boot | grows `/` to the disk (cloud-init is disabled) |
| `burn-host.sh` | on the host, as root | builds template 9900 from the image, full-clones 9901+ onto each entry's storage, ramps, samples, verdict |
| `VERSION` | — | release tag `fh-burner-v<VERSION>` |

Burn VMs have **no network**: the host drives them through the qemu-guest-agent socket.
They are tagged `fh-burn` and destroyed on exit (also on Ctrl-C) unless `--keep`.
Results stay on the host in `/var/tmp/fh-burn/<run>/` (`log`, `host.csv`, per-VM JSON).

## Release

`publish-fh-burner.yml`: a PR touching `burner/` builds the image as a 2-day workflow
artifact (boot it on a real host before releasing). Releasing is a manual dispatch on
master; bump `VERSION` for any change to the image or the controller — an existing release
tag is never replaced — and point `BURNER_VERSION` in `protocol/src/burn.ts` at it.

## Run by hand

`fh-toolkit burn` does this for you. By hand, on the host as root, with the release files
downloaded next to each other:

```bash
bash fh-burner-0.2.2-host.sh --image /var/lib/vz/fh-burn/fh-burner-0.2.2.qcow2 \
  --plan "nimbus:31744:8:local-lvm cumulus:7424:4:ss1" [--fill max|<pct>] [--no-retry] [--keep]
```

One `tier:MB:cores:storage` per burn VM, in the order they are added. The template goes on
the first entry's storage.
