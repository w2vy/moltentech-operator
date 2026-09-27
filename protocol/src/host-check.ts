/**
 * `fh-toolkit host-check <host>`: the small-RAM recipe, checked against one Proxmox host.
 *
 * The toolkit sees a host only through the Proxmox API, and the API cannot show what the
 * recipe turns on: zram, which disk a swap device lives on, ksmtuned's threshold. So the
 * verb prints a bash script, filled in with the host's planned VMs from the inventory, for
 * the operator to run ON the host (`fh-toolkit host-check pve1 | ssh root@pve1 bash`). The
 * script only reads; it prints the steps the host is missing, with their commands.
 *
 * The rule, from pve65 (2 × cumulus on 16 GB) and pve50 (1 × nimbus on 32 GB), 2026-09-26:
 * if the VMs leave the host its reserve, do nothing. Otherwise, in order —
 *   1. zram, 2 GB zstd, priority above any disk swap (always; free until used)
 *   2. KSM held on, KSM_THRES_COEF=50 (2+ VMs only — one VM has nothing to share)
 *   3. ≥4 GB of swap on a disk the VMs do not benchmark on; a thin volume in the VM pool
 *      is the fallback (it drags ddwrite at boot peaks). Required for ONE VM: pve50's
 *      first boot was OOM-killed with zram alone.
 *   4. smaller VMs (`vmMemoryMb`) — last, because it spends the RAM check's margin.
 */
import { HOST_RESERVE_MB, SMALL_RAM_DOCS, TIER_DEFAULT_MB, TIER_SQUEEZED_MB } from "./vm-memory";

/** zram below this is flagged. 2048 MB shows in /proc/swaps as ~2047. */
export const ZRAM_MIN_MB = 2048;
/** Disk swap below this is flagged — 4 GB got pve50's nimbus through its first boot. */
export const DISK_SWAP_MIN_MB = 4096;

export interface HostCheckInput {
  name: string;
  /** The Proxmox storage id the VM disks go on (inventory `storageImages`). */
  storageImages: string;
  vmMemoryMb?: Record<string, number>;
  slots: { tier: string }[];
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The VM sizes this host will build at: its `vmMemoryMb`, else the tier default. */
export function plannedVms(host: HostCheckInput): { tier: string; mb: number }[] {
  return host.slots
    .filter((s) => TIER_DEFAULT_MB[s.tier] !== undefined)
    .map((s) => ({ tier: s.tier, mb: host.vmMemoryMb?.[s.tier] ?? TIER_DEFAULT_MB[s.tier]! }));
}

export function hostCheckScript(host: HostCheckInput, version: string): string {
  const vms = plannedVms(host);
  const vmMb = vms.reduce((a, v) => a + v.mb, 0);
  const squeezedMb = vms.reduce((a, v) => a + Math.min(v.mb, TIER_SQUEEZED_MB[v.tier]!), 0);
  const squeeze: Record<string, number> = {};
  for (const v of vms) if (v.mb > TIER_SQUEEZED_MB[v.tier]!) squeeze[v.tier] = TIER_SQUEEZED_MB[v.tier]!;
  const vmList = vms.map((v) => `${v.tier} ${v.mb}`).join(", ") || "none";
  return `#!/bin/bash
# fh-toolkit host-check for ${host.name} (fh-toolkit ${version}).
# Run it ON the Proxmox host, as root:   fh-toolkit host-check ${host.name} | ssh root@<host> bash
# Read-only: it changes nothing. It prints the small-RAM steps this host is missing
# (${SMALL_RAM_DOCS}).
R="\${HC_ROOT:-}"
HOST=${shq(host.name)}
POOL=${shq(host.storageImages)}
NVM=${vms.length}
VM_MB=${vmMb}
SQUEEZED_MB=${squeezedMb}
VM_LIST=${shq(vmList)}
SQUEEZE_JSON=${shq(JSON.stringify(squeeze))}
todo=0
say() { printf '%-5s %s\\n' "$1" "$2"; [ "$1" = TODO ] && todo=$((todo + 1)); return 0; }
cmd() { printf '        %s\\n' "$@"; }

mem_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' "$R/proc/meminfo")
free_mb=$((mem_mb - VM_MB))
echo "$HOST: $mem_mb MB RAM; planned VMs ($VM_LIST MB) = $VM_MB MB, leaving $free_mb MB for Proxmox."
if [ "$NVM" -eq 0 ] || [ "$free_mb" -ge ${HOST_RESERVE_MB} ]; then
  say OK "RAM fits (Proxmox keeps ${HOST_RESERVE_MB} MB or more) - nothing to do."
  exit 0
fi
echo "That is under the ${HOST_RESERVE_MB} MB Proxmox should keep. The steps, in order:"
echo

# Disks under a block device (a partition, LV or file's filesystem), by name.
disks_of() { lsblk -nrso NAME,TYPE "$1" 2>/dev/null | awk '$2 == "disk" { print $1 }' | sort -u; }

# --- 1. zram -----------------------------------------------------------------------------
zram_mb=0; zram_prio=-999; disk_prio=-999; disk_mb=0; swap_devs=""
while read -r name type kb _used prio; do
  case "$name" in Filename|"") continue ;; esac
  mb=$((kb / 1024))
  case "$name" in
    /dev/zram*) zram_mb=$((zram_mb + mb)); [ "$prio" -gt "$zram_prio" ] && zram_prio=$prio ;;
    *) disk_mb=$((disk_mb + mb)); [ "$prio" -gt "$disk_prio" ] && disk_prio=$prio
       if [ "$type" = file ]; then dev=$(findmnt -nvo SOURCE -T "$R$name" 2>/dev/null); else dev=$name; fi
       swap_devs="$swap_devs $dev" ;;
  esac
done < "$R/proc/swaps"
if [ "$zram_mb" -ge $((${ZRAM_MIN_MB} - 64)) ] && [ "$zram_prio" -gt "$disk_prio" ]; then
  say OK "1. zram: $zram_mb MB, priority $zram_prio (above disk swap)."
else
  if [ "$zram_mb" -eq 0 ]; then say TODO "1. zram: none. 2 GB of compressed swap in RAM, used before any disk:"
  else say TODO "1. zram: $zram_mb MB at priority $zram_prio - want ${ZRAM_MIN_MB} MB, above disk swap ($disk_prio):"; fi
  cmd "apt install zram-tools" \\
      "printf 'ALGO=zstd\\\\nSIZE=${ZRAM_MIN_MB}\\\\nPRIORITY=100\\\\n' > /etc/default/zramswap" \\
      "systemctl stop zramswap; echo 1 > /sys/block/zram0/reset; systemctl start zramswap" \\
      "swapon --show        # (a plain restart cannot resize a zram device already in use)"
fi

# --- 2. KSM ------------------------------------------------------------------------------
if [ "$NVM" -lt 2 ]; then
  say SKIP "2. KSM: one VM - it has no second copy of its pages to merge."
else
  coef=$(sed -n 's/^KSM_THRES_COEF=\\([0-9]*\\).*/\\1/p' "$R/etc/ksmtuned.conf" 2>/dev/null | tail -1)
  coef=\${coef:-20}
  shared_mb=$(( $(cat "$R/sys/kernel/mm/ksm/pages_sharing" 2>/dev/null || echo 0) * 4 / 1024 ))
  if systemctl is-active --quiet ksmtuned 2>/dev/null && [ "$coef" -ge 50 ]; then
    say OK "2. KSM: ksmtuned running, KSM_THRES_COEF=$coef, sharing $shared_mb MB now."
  else
    say TODO "2. KSM: $NVM VMs share identical pages; hold KSM on (KSM_THRES_COEF=$coef, want 50):"
    cmd "apt install ksm-control-daemon" \\
        "sed -i 's/^#\\\\?KSM_THRES_COEF=.*/KSM_THRES_COEF=50/' /etc/ksmtuned.conf" \\
        "systemctl enable --now ksmtuned; systemctl restart ksmtuned"
  fi
fi

# --- 3. Swap on a disk the VMs do not benchmark on ----------------------------------------
vg=""; tp=""; pool_disks=""
stype=$(awk -v p="$POOL" '$1 ~ /:$/ && $2 == p { sub(/:$/, "", $1); print $1 }' "$R/etc/pve/storage.cfg" 2>/dev/null)
field() { awk -v p="$POOL" -v k="$1" '$1 ~ /:$/ { on = ($2 == p) } on && $1 == k { print $2 }' "$R/etc/pve/storage.cfg" 2>/dev/null; }
case "$stype" in
  lvmthin|lvm) vg=$(field vgname); tp=$(field thinpool)
    for pv in $(pvs --noheadings -o pv_name -S "vg_name=$vg" 2>/dev/null); do pool_disks="$pool_disks $(disks_of "$pv")"; done ;;
  dir) pool_disks=$(disks_of "$(findmnt -nvo SOURCE -T "$R$(field path)" 2>/dev/null)") ;;
esac
pool_disks=$(echo $pool_disks)
on_pool=0; off_pool=0
for d in $swap_devs; do
  for disk in $(disks_of "$d"); do
    case " $pool_disks " in *" $disk "*) on_pool=1 ;; *) off_pool=1 ;; esac
  done
done
need="recommended"; [ "$NVM" -eq 1 ] && need="REQUIRED - one VM's first boot peaks while it downloads the chain, and was killed without it"
if [ "$disk_mb" -ge $((${DISK_SWAP_MIN_MB} - 64)) ] && [ "$off_pool" -eq 1 ]; then
  say OK "3. Disk swap: $disk_mb MB, off the VM disk\${pool_disks:+ ($pool_disks)}."
elif [ "$disk_mb" -ge $((${DISK_SWAP_MIN_MB} - 64)) ] && [ "$on_pool" -eq 1 ]; then
  say WARN "3. Disk swap: $disk_mb MB, but on the VM disk ($pool_disks) - host swapping during a benchmark drags ddwrite. Better on its own SSD/NVMe."
else
  if [ -n "$pool_disks" ]; then where="VM disk: $pool_disks"; else where="VM storage '$POOL'"; fi
  say TODO "3. Disk swap: $disk_mb MB - want ${DISK_SWAP_MIN_MB} MB or more, on a disk the VMs do not use ($need). $where."
  echo "      Best - a separate SSD/NVMe (an M.2 card works; it need not boot). CHECK <disk> - mkswap erases it:"
  cmd "lsblk -d -o NAME,TRAN,SIZE,MODEL" \\
      "mkswap -L fhswap /dev/<disk>" \\
      "echo 'LABEL=fhswap none swap sw,pri=10 0 0' >> /etc/fstab; swapon -a; swapon --show"
  if [ "$stype" = lvmthin ] && [ -n "$tp" ]; then
    pool_gb=$(lvs --noheadings --units g --nosuffix -o lv_size "$vg/$tp" 2>/dev/null | awk '{ printf "%d", $1 }')
    used_gb=$(lvs --noheadings --units g --nosuffix -o lv_size -S "pool_lv=$tp" "$vg" 2>/dev/null | awk '{ s += $1 } END { printf "%d", s }')
    echo "      Fallback - a thin volume in the VM pool (costs some ddwrite at boot peaks). Pool $vg/$tp is \${pool_gb:-?} GiB,"
    echo "      volumes in it \${used_gb:-?} GiB: keep node disks + swap within the pool."
    cmd "lvcreate -V 4G -T $vg/$tp -n swap" \\
        "mkswap /dev/$vg/swap" \\
        "echo '/dev/$vg/swap none swap sw,pri=10 0 0' >> /etc/fstab; swapon -a; swapon --show"
  fi
fi

# --- 4. Smaller VMs -----------------------------------------------------------------------
if [ "$SQUEEZE_JSON" = "{}" ]; then
  say OK "4. VM sizes: already at the smallest size that passes the RAM check with margin."
else
  say TODO "4. VM sizes: still short - build smaller VMs (they pass the RAM check). Host keeps $((mem_mb - SQUEEZED_MB)) MB:"
  cmd "fh-toolkit inventory    # set vmMemoryMb $SQUEEZE_JSON on $HOST"
fi
echo
if [ "$todo" -eq 0 ]; then echo "$HOST: nothing left to do."; else echo "$HOST: $todo step(s) to do. Re-run this after them."; fi
`;
}
