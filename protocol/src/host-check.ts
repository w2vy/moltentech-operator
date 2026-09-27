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
 *   4. smaller VMs (`vmMemoryMb`) — last, because it spends the RAM check's margin; and when
 *      even the smallest sizes leave the host under ~200 MB (pve50 runs at 255), too many VMs.
 * On ZFS a step 0 comes first: cap the ARC, which otherwise takes up to half the RAM.
 *
 * It also compares the VMs Proxmox has with the inventory (a VM that runs a size the next
 * rebuild will change, e.g. pve65 at 7424 while the inventory said 7680), and names running
 * VMs the inventory does not know (gateways) — listed, and counted in the RAM arithmetic.
 */
import { HOST_RESERVE_MB, SMALL_RAM_DOCS, TIER_DEFAULT_MB, TIER_SQUEEZED_MB } from "./vm-memory";

/** zram below this is flagged. 2048 MB shows in /proc/swaps as ~2047. */
export const ZRAM_MIN_MB = 2048;
/** Disk swap below this is flagged — 4 GB got pve50's nimbus through its first boot. */
export const DISK_SWAP_MIN_MB = 4096;
/** Below this at the smallest VM sizes there are too many VMs. pve50 works at 255, with zram + swap. */
export const SQUEEZED_FLOOR_MB = 200;
/** The ZFS ARC cap for a tight host; ARC min goes to half of it (a max at or under min is ignored). */
export const ARC_CAP_MB = 1024;

export interface HostCheckInput {
  name: string;
  /** The Proxmox storage id the VM disks go on (inventory `storageImages`). */
  storageImages: string;
  vmMemoryMb?: Record<string, number>;
  slots: { tier: string; vmName?: string }[];
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
  const slotSizes = host.slots
    .filter((s) => s.vmName && TIER_DEFAULT_MB[s.tier] !== undefined)
    .map((s) => `${s.vmName} ${host.vmMemoryMb?.[s.tier] ?? TIER_DEFAULT_MB[s.tier]!}`)
    .join("\n");
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
SLOT_SIZES=${shq(slotSizes)}
todo=0
say() { printf '%-5s %s\\n' "$1" "$2"; [ "$1" = TODO ] && todo=$((todo + 1)); return 0; }
cmd() { printf '        %s\\n' "$@"; }

mem_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' "$R/proc/meminfo")
# ZFS keeps a cache (ARC) in RAM, by default up to half of it; count its ceiling.
arc_mb=0; arc_min_mb=0
if [ -n "$(zpool list -H -o name 2>/dev/null)" ]; then
  arc_mb=$(awk '$1 == "c_max" { print int($3 / 1048576) }' "$R/proc/spl/kstat/zfs/arcstats" 2>/dev/null)
  arc_min_mb=$(awk '$1 == "c_min" { print int($3 / 1048576) }' "$R/proc/spl/kstat/zfs/arcstats" 2>/dev/null)
  arc_mb=\${arc_mb:-0}; arc_min_mb=\${arc_min_mb:-0}
fi

# The VMs Proxmox has, against the inventory. Running VMs it does not know (a gateway) use RAM
# too, so they count; their lines print after the summary.
others=""; other_mb=0; vm_lines=()
for f in "$R"/etc/pve/qemu-server/*.conf; do
  [ -e "$f" ] || continue
  id=$(basename "$f" .conf)
  read -r vname vmem pmem < <(awk '/^\\[/ { sec = $1 }
    sec == "" && $1 == "name:" { n = $2 } sec == "" && $1 == "memory:" { m = $2 }
    sec == "[PENDING]" && $1 == "memory:" { p = $2 }
    END { print (n == "" ? "-" : n), (m == "" ? 512 : m), p }' "$f")
  # A Foundation idle-fill VM is the slot's name with "fh-" in front.
  planned=$(printf '%s\\n' "$SLOT_SIZES" | awk -v n="$vname" -v m="\${vname#fh-}" '$1 == n || $1 == m { print $2; exit }')
  if [ -n "$planned" ]; then
    if [ -n "$pmem" ] && [ "$pmem" = "$planned" ]; then
      vm_lines+=("$(say WARN "VM $vname ($id): $planned MB is pending - it applies when the VM is shut down and started.")")
    elif [ "$vmem" != "$planned" ]; then
      vm_lines+=("$(say WARN "VM $vname ($id): runs $vmem MB, but the inventory builds it at $planned MB - the next rebuild changes it."
        cmd "fh-toolkit inventory    # to keep $vmem MB: vmMemoryMb on $HOST" \\
            "qm set $id --memory $planned    # or the inventory's size - then shut the VM down and start it")")
    fi
  elif [ -e "$R/var/run/qemu-server/$id.pid" ]; then
    others="\${others:+$others, }$vname ($id) $vmem MB"; other_mb=$((other_mb + vmem))
  fi
done
[ -n "$others" ] && vm_lines+=("$(say NOTE "Running VMs not in the inventory, counted: $others.")")
free_mb=$((mem_mb - VM_MB - other_mb - arc_mb))
extra=""
[ "$other_mb" -gt 0 ] && extra="$extra, other running VMs $other_mb MB"
[ "$arc_mb" -gt 0 ] && extra="$extra, ZFS cache up to $arc_mb MB"
echo "$HOST: $mem_mb MB RAM; planned VMs ($VM_LIST MB) = $VM_MB MB$extra; leaving $free_mb MB for Proxmox."
[ \${#vm_lines[@]} -gt 0 ] && printf '%s\\n' "\${vm_lines[@]}"
if [ "$NVM" -eq 0 ] || [ "$free_mb" -ge ${HOST_RESERVE_MB} ]; then
  say OK "RAM fits (Proxmox keeps ${HOST_RESERVE_MB} MB or more) - nothing to do."
  exit 0
fi
echo "That is under the ${HOST_RESERVE_MB} MB Proxmox should keep. The steps, in order:"
echo

# --- 0. ZFS cache ------------------------------------------------------------------------
if [ "$arc_mb" -gt $((${ARC_CAP_MB} + 64)) ]; then
  say TODO "0. ZFS cache (ARC): up to $arc_mb MB of RAM - cap it at ${ARC_CAP_MB} MB so the VMs get the rest:"
  cmd "echo $((${ARC_CAP_MB} / 2 * 1048576)) > /sys/module/zfs/parameters/zfs_arc_min" \\
      "echo $((${ARC_CAP_MB} * 1048576)) > /sys/module/zfs/parameters/zfs_arc_max" \\
      "echo 'options zfs zfs_arc_min=$((${ARC_CAP_MB} / 2 * 1048576)) zfs_arc_max=$((${ARC_CAP_MB} * 1048576))' > /etc/modprobe.d/zfs.conf" \\
      "update-initramfs -u -k all    # so it holds after a reboot"
elif [ "$arc_mb" -gt 0 ]; then
  say OK "0. ZFS cache (ARC): capped at $arc_mb MB."
fi

# Disks under a block device (a partition, LV, zpool member or file's filesystem), by name.
disks_of() { lsblk -nrso NAME,TYPE "$1" 2>/dev/null | awk '$2 == "disk" { print $1 }' | sort -u; }
# "sda (HDD)": a disk and what it is.
disk_kind() {
  case "$1" in nvme*) echo "$1 (NVMe)"; return ;; zd*) echo "$1 (ZFS volume)"; return ;; esac
  case "$(cat "$R/sys/block/$1/queue/rotational" 2>/dev/null)" in 1) echo "$1 (HDD)" ;; 0) echo "$1 (SSD)" ;; *) echo "$1" ;; esac
}

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
  zfspool) zp=$(field pool)
    for v in $(zpool list -vHP "\${zp%%/*}" 2>/dev/null | awk '$1 ~ /^\\/dev\\// { print $1 }'); do pool_disks="$pool_disks $(disks_of "$v")"; done ;;
  dir) pool_disks=$(disks_of "$(findmnt -nvo SOURCE -T "$R$(field path)" 2>/dev/null)") ;;
esac
pool_disks=$(echo $pool_disks)
on_pool=0; off_pool=0; on_zvol=""; swap_on=""
for d in $swap_devs; do
  for disk in $(disks_of "$d"); do
    case "$disk" in zd*) on_zvol="$on_zvol $d" ;; esac
    case " $pool_disks " in *" $disk "*) on_pool=1 ;; *) off_pool=1 ;; esac
    swap_on="\${swap_on:+$swap_on, }$(disk_kind "$disk")"
  done
done
need="recommended"; [ "$NVM" -eq 1 ] && need="REQUIRED - one VM's first boot peaks while it downloads the chain, and was killed without it"
if [ -n "$on_zvol" ]; then
  say TODO "3. Disk swap: $disk_mb MB on $swap_on - swap on a ZFS volume can hang the host when memory runs short. Move it to a disk of its own:"
  cmd "swapoff$on_zvol; sed -i '/zd[0-9]\\|zvol/s/^/#/' /etc/fstab    # then add the disk below"
  cmd "lsblk -d -o NAME,TRAN,SIZE,MODEL" \\
      "mkswap -L fhswap /dev/<disk>    # CHECK <disk> - mkswap erases it" \\
      "echo 'LABEL=fhswap none swap sw,pri=10 0 0' >> /etc/fstab; swapon -a; swapon --show"
elif [ "$disk_mb" -ge $((${DISK_SWAP_MIN_MB} - 64)) ] && [ -z "$pool_disks" ]; then
  say WARN "3. Disk swap: $disk_mb MB on \${swap_on:-?}, but cannot tell which disk VM storage '$POOL' (\${stype:-not in storage.cfg}) uses - check it is not that one."
elif [ "$disk_mb" -ge $((${DISK_SWAP_MIN_MB} - 64)) ] && [ "$off_pool" -eq 1 ]; then
  say OK "3. Disk swap: $disk_mb MB on $swap_on, off the VM disk ($pool_disks)."
elif [ "$disk_mb" -ge $((${DISK_SWAP_MIN_MB} - 64)) ] && [ "$on_pool" -eq 1 ]; then
  say WARN "3. Disk swap: $disk_mb MB on $swap_on - the VM disk. If benchmarks fail on ddwrite, move swap to a small SSD/NVMe of its own (an M.2 PCIe card works)."
else
  if [ -n "$pool_disks" ]; then where="VM disk: $pool_disks"; else where="VM storage '$POOL'"; fi
  say TODO "3. Disk swap: $disk_mb MB - want ${DISK_SWAP_MIN_MB} MB or more, on a disk the VMs do not use ($need). $where."
  echo "      Best - a separate SSD/NVMe (an M.2 card works; it need not boot). CHECK <disk> - mkswap erases it:"
  cmd "lsblk -d -o NAME,TRAN,SIZE,MODEL" \\
      "mkswap -L fhswap /dev/<disk>" \\
      "echo 'LABEL=fhswap none swap sw,pri=10 0 0' >> /etc/fstab; swapon -a; swapon --show"
  if [ "$stype" = zfspool ]; then
    echo "      No fallback on ZFS: swap on a ZFS volume can hang the host. Without a spare disk, use zram and step 4."
  elif [ "$stype" = lvmthin ] && [ -n "$tp" ]; then
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
# The ARC shrinks toward its minimum when the VMs need the RAM, so count only that here.
left_mb=$((mem_mb - SQUEEZED_MB - other_mb - arc_min_mb))
if [ "$left_mb" -lt ${SQUEEZED_FLOOR_MB} ]; then
  say TODO "4. VM sizes: even at the smallest sizes ($SQUEEZED_MB MB) the host keeps $left_mb MB, under the ~${SQUEEZED_FLOOR_MB} MB seen working. Too many VMs for this RAM:"
  cmd "fh-toolkit inventory    # take a slot off $HOST - or add RAM"
elif [ "$SQUEEZE_JSON" = "{}" ]; then
  say OK "4. VM sizes: already at the smallest size that passes the RAM check with margin."
else
  say TODO "4. VM sizes: still short - build smaller VMs (they pass the RAM check). Host keeps $((mem_mb - SQUEEZED_MB)) MB:"
  cmd "fh-toolkit inventory    # set vmMemoryMb $SQUEEZE_JSON on $HOST"
fi
echo
if [ "$todo" -eq 0 ]; then echo "$HOST: nothing left to do."; else echo "$HOST: $todo step(s) to do. Re-run this after them."; fi
`;
}
