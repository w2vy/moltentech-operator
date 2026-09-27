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
 *
 * CPU: node VMs count at their full vCPUs (a tier's core count is a hard requirement); other
 * VMs at their busiest 30 minutes of the last month, from Proxmox's own history (gateways idle
 * at ~0.4 of a core). Over the host's threads is a WARN with the size of it — 1.6 over 64
 * threads is not 0.4 over 4.
 *
 * `--room` asks the other question: could this host take one more node? It tries stratus,
 * nimbus, cumulus in turn against spare RAM (clean, or at the squeezed size with the steps
 * above and a KSM credit), free space in the VM storage, and CPU threads, and names the
 * largest that fits. CPU over the threads is a warning with its size, never a no — except one
 * VM wanting more threads than the host has, which Proxmox refuses.
 *
 * `--room <tier>` plans that one node: what is short, the levers that would close it (a
 * smaller gateway, say) with their size, and then the steps for the host with it added.
 */
import { TIER_VM_SIZES } from "./proxmox-probe";
import { HOST_RESERVE_MB, SMALL_RAM_DOCS, TIER_DEFAULT_MB, TIER_SQUEEZED_MB } from "./vm-memory";

/** zram below this is flagged. 2048 MB shows in /proc/swaps as ~2047. */
export const ZRAM_MIN_MB = 2048;
/** Disk swap below this is flagged — 4 GB got pve50's nimbus through its first boot. */
export const DISK_SWAP_MIN_MB = 4096;
/** Below this at the smallest VM sizes there are too many VMs. pve50 works at 255, with zram + swap. */
export const SQUEEZED_FLOOR_MB = 200;
/** The ZFS ARC cap for a tight host; ARC min goes to half of it (a max at or under min is ignored). */
export const ARC_CAP_MB = 1024;
/**
 * What KSM saves per node VM after the first, when it cannot be read yet: pve65 (2 × cumulus)
 * ~0.9 GB, pve40 (16 × cumulus) 20.4 GB = ~1.3 GB each (2026-09-27). The lower one.
 */
export const KSM_PER_VM_MB = 900;
/** A non-node VM (a gateway) is not suggested below this: OPNsense runs at 2048 on pve40. */
export const OTHER_VM_MIN_MB = 2048;

export interface HostCheckInput {
  name: string;
  /** The Proxmox storage id the VM disks go on (inventory `storageImages`). */
  storageImages: string;
  vmMemoryMb?: Record<string, number>;
  /** `storagePool` overrides `storageImages` for that slot's disk (pve40: ss1–ss4). */
  slots: { tier: string; vmName?: string; storagePool?: string | null }[];
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The VM sizes this host will build at: its `vmMemoryMb`, else the tier default. */
export function plannedVms(host: HostCheckInput): { tier: string; mb: number }[] {
  return host.slots
    .filter((s) => TIER_DEFAULT_MB[s.tier] !== undefined)
    .map((s) => ({ tier: s.tier, mb: host.vmMemoryMb?.[s.tier] ?? TIER_DEFAULT_MB[s.tier]! }));
}

export interface HostCheckOptions {
  /** Report the largest tier that one more node could be, instead of the steps. */
  room?: boolean;
  /** Plan one more node of this tier: what is short, what would fix it, then the steps. */
  roomTier?: string;
}

export function hostCheckScript(host: HostCheckInput, version: string, opts: HostCheckOptions = {}): string {
  const vms = plannedVms(host);
  const vmMb = vms.reduce((a, v) => a + v.mb, 0);
  const squeezedMb = vms.reduce((a, v) => a + Math.min(v.mb, TIER_SQUEEZED_MB[v.tier]!), 0);
  const squeeze: Record<string, number> = {};
  for (const v of vms) if (v.mb > TIER_SQUEEZED_MB[v.tier]!) squeeze[v.tier] = TIER_SQUEEZED_MB[v.tier]!;
  // The storages the slots' disks go on — what the agent uses: the slot's pool, else the host's.
  const pools = [...new Set(host.slots.map((s) => s.storagePool || host.storageImages))];
  if (pools.length === 0) pools.push(host.storageImages);
  const counts = new Map<string, number>();
  for (const v of vms) counts.set(`${v.tier} ${v.mb}`, (counts.get(`${v.tier} ${v.mb}`) ?? 0) + 1);
  const vmList = [...counts].map(([k, n]) => (n > 1 ? `${n} × ${k}` : k)).join(", ") || "none";
  const slotSizes = host.slots
    .filter((s) => s.vmName && TIER_DEFAULT_MB[s.tier] !== undefined)
    .map((s) => `${s.vmName} ${host.vmMemoryMb?.[s.tier] ?? TIER_DEFAULT_MB[s.tier]!} ${s.tier} ${s.storagePool || host.storageImages}`)
    .join("\n");
  // tier, default MB, squeezed MB, disk GB, cores — largest first.
  const tierTable = TIER_VM_SIZES.map(
    (t) => `${t.tier} ${t.memMb} ${TIER_SQUEEZED_MB[t.tier] ?? t.memMb} ${t.diskGb} ${t.cores}`
  ).join("\n");
  // --room <tier>: the host's plan with that slot added, for the steps after the verdict.
  const planTier = opts.roomTier;
  const plan = planTier ? plannedVms({ ...host, slots: [...host.slots, { tier: planTier }] }) : vms;
  const planSqueeze: Record<string, number> = {};
  for (const v of plan) if (v.mb > TIER_SQUEEZED_MB[v.tier]!) planSqueeze[v.tier] = TIER_SQUEEZED_MB[v.tier]!;
  return `#!/bin/bash
# fh-toolkit host-check for ${host.name} (fh-toolkit ${version}).
# Run it ON the Proxmox host, as root:   fh-toolkit host-check ${host.name} | ssh root@<host> bash
# Read-only: it changes nothing. ${
    opts.roomTier
      ? `It plans one more ${opts.roomTier} on this host: what is short, and the steps.`
      : opts.room
      ? "It reports the largest node this host has room to add."
      : `It prints the small-RAM steps this host is missing
# (${SMALL_RAM_DOCS}).`
  }
R="\${HC_ROOT:-}"
HOST=${shq(host.name)}
POOLS=${shq(pools.join(" "))}
NVM=${vms.length}
VM_MB=${vmMb}
SQUEEZED_MB=${squeezedMb}
VM_LIST=${shq(vmList)}
SQUEEZE_JSON=${shq(JSON.stringify(squeeze))}
SLOT_SIZES=${shq(slotSizes)}
TIER_TABLE=${shq(tierTable)}
ROOM=${opts.room && !planTier ? 1 : 0}
PLAN_TIER=${shq(planTier ?? "")}
PLAN_NVM=${plan.length}
PLAN_VM_MB=${plan.reduce((a, v) => a + v.mb, 0)}
PLAN_SQUEEZED_MB=${plan.reduce((a, v) => a + Math.min(v.mb, TIER_SQUEEZED_MB[v.tier]!), 0)}
PLAN_NEW_MB=${planTier ? plan[plan.length - 1]!.mb : 0}
PLAN_SQUEEZE_JSON=${shq(JSON.stringify(planSqueeze))}
todo=0
say() { printf '%-5s %s\\n' "$1" "$2"; [ "$1" = TODO ] && todo=$((todo + 1)); return 0; }
cmd() { printf '        %s\\n' "$@"; }
# Disks under a block device (a partition, LV, zpool member or file's filesystem), by name.
disks_of() { lsblk -nrso NAME,TYPE "$1" 2>/dev/null | awk '$2 == "disk" { print $1 }' | sort -u; }
# "sda (HDD)": a disk and what it is.
disk_kind() {
  case "$1" in nvme*) echo "$1 (NVMe)"; return ;; zd*) echo "$1 (ZFS volume)"; return ;; esac
  # A RAID controller reports its virtual disks as spinning whatever is behind them.
  case "$(cat "$R/sys/block/$1/device/model" 2>/dev/null)" in *PERC*|*RAID*|*MR9*|*LOGICAL*|*"Smart Array"*) echo "$1 (RAID)"; return ;; esac
  case "$(cat "$R/sys/block/$1/queue/rotational" 2>/dev/null)" in 1) echo "$1 (HDD)" ;; 0) echo "$1 (SSD)" ;; *) echo "$1" ;; esac
}

# The VM storages: their disks, and each one's free space in GB (unset when unknown).
# stype/vg/tp/zp describe the first, for the swap fallback in step 3.
field() { awk -v p="$1" -v k="$2" '$1 ~ /:$/ { on = ($2 == p) } on && $1 == k { print $2 }' "$R/etc/pve/storage.cfg" 2>/dev/null; }
declare -A pfree
pool_disks=""; stype=""; vg=""; tp=""; zp=""; POOL=\${POOLS%% *}
for P in $POOLS; do
  t=$(awk -v p="$P" '$1 ~ /:$/ && $2 == p { sub(/:$/, "", $1); print $1 }' "$R/etc/pve/storage.cfg" 2>/dev/null)
  pv_vg=$(field "$P" vgname); pv_tp=$(field "$P" thinpool); pv_zp=$(field "$P" pool); free=""; size=""; used=""
  case "$t" in
    lvmthin|lvm)
      for pv in $(pvs --noheadings -o pv_name -S "vg_name=$pv_vg" 2>/dev/null); do pool_disks="$pool_disks $(disks_of "$pv")"; done
      if [ "$t" = lvmthin ]; then
        size=$(lvs --noheadings --units g --nosuffix -o lv_size "$pv_vg/$pv_tp" 2>/dev/null | awk '{ printf "%d", $1 }')
        used=$(lvs --noheadings --units g --nosuffix -o lv_size -S "pool_lv=$pv_tp" "$pv_vg" 2>/dev/null | awk '{ s += $1 } END { printf "%d", s }')
        [ -n "$size" ] && free=$((size - \${used:-0}))
      else free=$(vgs --noheadings --units g --nosuffix -o vg_free "$pv_vg" 2>/dev/null | awk '{ printf "%d", $1 }'); fi ;;
    zfspool)
      for v in $(zpool list -vHP "\${pv_zp%%/*}" 2>/dev/null | awk '$1 ~ /^\\/dev\\// { print $1 }'); do pool_disks="$pool_disks $(disks_of "$v")"; done
      free=$(zfs get -Hp -o value available "$pv_zp" 2>/dev/null | awk '{ printf "%d", $1 / 1073741824 }') ;;
    dir)
      pool_disks="$pool_disks $(disks_of "$(findmnt -nvo SOURCE -T "$R$(field "$P" path)" 2>/dev/null)")"
      free=$(df -BG --output=avail "$R$(field "$P" path)" 2>/dev/null | awk 'NR == 2 { printf "%d", $1 }') ;;
  esac
  [ -n "$free" ] && pfree[$P]=$free
  if [ "$P" = "$POOL" ]; then stype=$t; vg=$pv_vg; tp=$pv_tp; zp=$pv_zp; pool_gb=\${size:-}; used_gb=\${used:-}; fi
done
pool_disks=$(echo $(printf '%s\\n' $pool_disks | sort -u))

mem_mb=$(awk '/^MemTotal:/ { print int($2 / 1024) }' "$R/proc/meminfo")
# ZFS keeps a cache (ARC) in RAM, by default up to half of it; count its ceiling.
arc_mb=0; arc_min_mb=0
if [ -n "$(zpool list -H -o name 2>/dev/null)" ]; then
  arc_mb=$(awk '$1 == "c_max" { print int($3 / 1048576) }' "$R/proc/spl/kstat/zfs/arcstats" 2>/dev/null)
  arc_min_mb=$(awk '$1 == "c_min" { print int($3 / 1048576) }' "$R/proc/spl/kstat/zfs/arcstats" 2>/dev/null)
  arc_mb=\${arc_mb:-0}; arc_min_mb=\${arc_min_mb:-0}
fi

# Tenths as "1.6"; CPU is counted in tenths of a thread.
f10() {
  local v=$1 sign=""; [ "$v" -lt 0 ] && { sign=-; v=$((-v)); }
  if [ $((v % 10)) -eq 0 ]; then printf '%s%d' "$sign" $((v / 10)); else printf '%s%d.%d' "$sign" $((v / 10)) $((v % 10)); fi
}
# A VM's busiest 30 minutes of the last month, in tenths of a thread; empty with no history.
busiest10() {
  pvesh get "/nodes/localhost/qemu/$1/rrddata" --timeframe month --cf AVERAGE --output-format json 2>/dev/null |
    tr '{}' '\n\n' | awk -F, '{ c = ""; m = ""
      for (i = 1; i <= NF; i++) { split($i, kv, ":"); gsub(/"/, "", kv[1]); if (kv[1] == "cpu") c = kv[2]; if (kv[1] == "maxcpu") m = kv[2] }
      if (c != "" && m != "") { n++; v = c * m; if (v > max) max = v } }
      END { if (n) printf "%d", max * 10 + 0.999 }'
}
threads=$(grep -c '^processor' "$R/proc/cpuinfo" 2>/dev/null); threads=\${threads:-0}
ksm_mb=$(( $(cat "$R/sys/kernel/mm/ksm/pages_sharing" 2>/dev/null || echo 0) * 4 / 1024 ))

# The VMs Proxmox has, against the inventory. Running VMs it does not know (a gateway) use RAM
# too, so they count; their lines print after the summary.
others=""; other_mb=0; other_vms=""; vm_lines=(); node_cpu=0; other_cpu10=0; other_cpus=""; built=" "; nodes_built=0
for f in "$R"/etc/pve/qemu-server/*.conf; do
  [ -e "$f" ] || continue
  id=$(basename "$f" .conf)
  read -r vname vmem vcpu pmem < <(awk '/^\\[/ { sec = $1 }
    sec == "" && $1 == "name:" { n = $2 } sec == "" && $1 == "memory:" { m = $2 }
    sec == "" && $1 == "cores:" { c = $2 } sec == "" && $1 == "sockets:" { k = $2 }
    sec == "[PENDING]" && $1 == "memory:" { p = $2 }
    END { print (n == "" ? "-" : n), (m == "" ? 512 : m), (c == "" ? 1 : c) * (k == "" ? 1 : k), p }' "$f")
  # A Foundation idle-fill VM is the slot's name with "fh-" in front.
  read -r slot planned < <(printf '%s\\n' "$SLOT_SIZES" | awk -v n="$vname" -v m="\${vname#fh-}" '$1 == n || $1 == m { print $1, $2; exit }')
  if [ -n "$planned" ]; then
    built="$built$slot "; node_cpu=$((node_cpu + vcpu)); nodes_built=$((nodes_built + 1))
    if [ -n "$pmem" ] && [ "$pmem" = "$planned" ]; then
      vm_lines+=("$(say WARN "VM $vname ($id): $planned MB is pending - it applies when the VM is shut down and started.")")
    elif [ "$vmem" != "$planned" ]; then
      vm_lines+=("$(say WARN "VM $vname ($id): runs $vmem MB, but the inventory builds it at $planned MB - the next rebuild changes it."
        cmd "fh-toolkit inventory    # to keep $vmem MB: vmMemoryMb on $HOST" \\
            "qm set $id --memory $planned    # or the inventory's size - then shut the VM down and start it")")
    fi
  elif [ -e "$R/var/run/qemu-server/$id.pid" ]; then
    others="\${others:+$others, }$vname ($id) $vmem MB"; other_mb=$((other_mb + vmem)); other_vms="$other_vms$vname:$id:$vmem "
    busy=$(busiest10 "$id"); [ -n "$busy" ] || busy=$((vcpu * 10))
    other_cpu10=$((other_cpu10 + busy)); other_cpus="\${other_cpus:+$other_cpus, }$vname $(f10 "$busy")"
  fi
done
[ -n "$others" ] && vm_lines+=("$(say NOTE "Running VMs not in the inventory, counted: $others.")")
# Slots in the inventory with no VM yet still need their threads and disk.
while read -r slot _mb tier sp; do
  [ -z "$slot" ] && continue
  case "$built" in *" $slot "*) continue ;; esac
  read -r _t _d _s dgb tc < <(printf '%s\\n' "$TIER_TABLE" | awk -v t="$tier" '$1 == t')
  node_cpu=$((node_cpu + \${tc:-0})); [ -n "\${pfree[$sp]:-}" ] && pfree[$sp]=$((pfree[$sp] - \${dgb:-0}))
done <<< "$SLOT_SIZES"
cpu10=$((node_cpu * 10 + other_cpu10)); free_cpu10=$((threads * 10 - cpu10))
if [ "$free_cpu10" -lt 0 ] && [ "$threads" -gt 0 ]; then
  over=$((-free_cpu10))
  vm_lines+=("$(say WARN "CPU: $(f10 $cpu10) of $threads threads ($(f10 $over) over, $(f10 $((over * 1000 / (threads * 10))))%) - nodes $node_cpu\${other_cpus:+ + other VMs at their busiest 30 min $(f10 $other_cpu10) ($other_cpus)}.")")
fi
# What KSM saves the node VMs: what it saves now, or the estimate for their number.
ksm_credit=0; [ "$NVM" -ge 2 ] && ksm_credit=$(( (NVM - 1) * ${KSM_PER_VM_MB} ))
[ "$ksm_mb" -gt "$ksm_credit" ] && ksm_credit=$ksm_mb
free_mb=$((mem_mb - VM_MB - other_mb - arc_mb))
extra=""
[ "$other_mb" -gt 0 ] && extra="$extra, other running VMs $other_mb MB"
[ "$arc_mb" -gt 0 ] && extra="$extra, ZFS cache up to $arc_mb MB"
# How settled that saving is: KSM's full passes over memory, how long ksmtuned has run, and
# when its config last changed. Under an hour and saving less than the built VMs should = young.
ago() { local s=$1; if [ "$s" -lt 3600 ]; then echo "$((s / 60))m"; elif [ "$s" -lt 86400 ]; then echo "$((s / 3600))h"; else echo "$((s / 86400))d $((s % 86400 / 3600))h"; fi; }
now=$(date +%s); ksm_note=""; ksm_young=0; young_for=999999
scans=$(cat "$R/sys/kernel/mm/ksm/full_scans" 2>/dev/null)
since=$(date -d "$(systemctl show ksmtuned -p ActiveEnterTimestamp --value 2>/dev/null)" +%s 2>/dev/null)
conf_at=$(stat -c %Y "$R/etc/ksmtuned.conf" 2>/dev/null)
ksm_when=""
[ -n "$since" ] && [ "$since" -gt 0 ] && { ksm_when="$ksm_when, ksmtuned up $(ago $((now - since)))"; young_for=$((now - since)); }
[ -n "$conf_at" ] && { ksm_when="$ksm_when, its config changed $(ago $((now - conf_at))) ago"; [ $((now - conf_at)) -lt "$young_for" ] && young_for=$((now - conf_at)); }
[ "$ksm_mb" -gt 0 ] && ksm_note="KSM is saving $ksm_mb MB on top (\${scans:-?} full scans$ksm_when)."
[ "$young_for" -lt 3600 ] && [ "$nodes_built" -ge 2 ] && [ "$ksm_mb" -lt $(( (nodes_built - 1) * ${KSM_PER_VM_MB} )) ] && ksm_young=1
echo "$HOST: $mem_mb MB RAM; planned VMs ($VM_LIST MB) = $VM_MB MB$extra; leaving $free_mb MB for Proxmox."
[ -n "$ksm_note" ] && echo "$ksm_note"
[ \${#vm_lines[@]} -gt 0 ] && printf '%s\\n' "\${vm_lines[@]}"

# CPU for one more node of N threads. Over the host's threads is a warning with its size, as in
# the check; only one VM wanting more threads than the host has is a no (Proxmox refuses it).
cpu_for() {
  local tc=$1 after=$((cpu10 + $1 * 10)) over
  over=$((after - threads * 10))
  if [ "$tc" -gt "$threads" ]; then echo "CPU short ($tc threads for one VM, the host has $threads)"
  elif [ "$over" -gt 0 ]; then echo "CPU ok, but $(f10 $after) of $threads threads ($(f10 $over) over, $(f10 $((over * 1000 / (threads * 10))))%)"
  else echo "CPU ok ($tc of $(f10 $free_cpu10) threads free)"; fi
}
# A new slot can go on any of the storages; the one with the most free space.
pool_free_gb=""; room_pool=""
for P in $POOLS; do
  f=\${pfree[$P]:-}; [ -z "$f" ] && continue
  if [ -z "$pool_free_gb" ] || [ "$f" -gt "$pool_free_gb" ]; then pool_free_gb=$f; room_pool=$P; fi
done
on=""; [ "$POOLS" != "$room_pool" ] && on=" on $room_pool"

# --- --room <tier>: one more node of that tier, what is short and what would fix it --------
if [ -n "$PLAN_TIER" ]; then
  read -r _t dmb smb dgb tc < <(printf '%s\\n' "$TIER_TABLE" | awk -v t="$PLAN_TIER" '$1 == t')
  echo
  echo "One more $PLAN_TIER, at $PLAN_NEW_MB MB:"
  short=0
  # RAM: clean at the planned size; else tight at the smallest sizes, with the KSM the others save.
  tight=$((mem_mb - SQUEEZED_MB - other_mb - arc_min_mb - smb + ksm_credit))
  ksm_txt=""; [ "$ksm_credit" -gt 0 ] && ksm_txt=", counting ~$ksm_credit MB KSM saves the others"
  if [ $((free_mb - PLAN_NEW_MB)) -ge ${HOST_RESERVE_MB} ]; then say OK "RAM: fits at $PLAN_NEW_MB MB."
  elif [ "$tight" -ge ${SQUEEZED_FLOOR_MB} ]; then say OK "RAM: fits tight - VMs at their smallest sizes and the small-RAM steps below$ksm_txt."
  else
    need=$((${SQUEEZED_FLOOR_MB} - tight)); short=1
    say NO "RAM: short by $need MB, even at the smallest sizes$ksm_txt. What would close it:"
    have=0
    for o in $other_vms; do
      IFS=: read -r on_name on_id on_mb <<< "$o"
      [ "$on_mb" -gt ${OTHER_VM_MIN_MB} ] || continue
      gain=$((on_mb - ${OTHER_VM_MIN_MB})); have=$((have + gain))
      cmd "$on_name ($on_id) from $on_mb to ${OTHER_VM_MIN_MB} MB frees $gain MB:  qm set $on_id --memory ${OTHER_VM_MIN_MB}, then shut it down and start it"
    done
    if [ "$have" -ge "$need" ]; then cmd "- that is enough ($have MB of $need)."
    else cmd "- not enough ($have MB of $need): take a slot off $HOST, or add RAM."; fi
  fi
  if [ -z "$pool_free_gb" ]; then say WARN "Disk: free space in '$POOLS' unknown - $dgb GB needed."
  elif [ "$pool_free_gb" -ge "$dgb" ]; then say OK "Disk: $dgb of $pool_free_gb GB free$on."
  else say NO "Disk: $dgb GB needed, $pool_free_gb free$on - short by $((dgb - pool_free_gb)) GB: a larger or extra SSD."; short=1; fi
  c=$(cpu_for "$tc")
  case "$c" in "CPU short"*) say NO "$c."; short=1 ;; *", but "*) say WARN "$c." ;; *) say OK "$c." ;; esac
  echo
  if [ "$short" = 1 ]; then echo "$HOST: one more $PLAN_TIER does not fit as it stands - the fixes are above."
  else echo "$HOST: one more $PLAN_TIER fits. Add it with fh-toolkit inventory, and build it alone, after the other VMs have settled."; fi
  [ "$ksm_young" = 1 ] && echo "KSM started $(ago "$young_for") ago and is still merging (saving $ksm_mb MB so far) - run this again in 5 minutes."
  # Then the steps for the host with it: the plan grows by the new slot.
  NVM=$PLAN_NVM; VM_MB=$PLAN_VM_MB; SQUEEZED_MB=$PLAN_SQUEEZED_MB; SQUEEZE_JSON=$PLAN_SQUEEZE_JSON
  free_mb=$((mem_mb - VM_MB - other_mb - arc_mb))
  ksm_credit=$(( (NVM - 1) * ${KSM_PER_VM_MB} )); [ "$ksm_mb" -gt "$ksm_credit" ] && ksm_credit=$ksm_mb
  echo
  echo "With it, $HOST's VMs = $VM_MB MB, leaving $free_mb MB for Proxmox."
fi

# --- --room: the largest node one more slot could be ---------------------------------------
if [ "$ROOM" = 1 ]; then
  echo
  echo "Room for one more node, largest first:"
  best=""; best_mb=""
  # The new VM's first boot comes before KSM merges it, so only the others' saving counts.
  ksm_txt=""; [ "$ksm_credit" -gt 0 ] && ksm_txt=" and ~$ksm_credit MB KSM saves the others"
  while read -r tier dmb smb dgb tc; do
    tight=$((mem_mb - SQUEEZED_MB - other_mb - arc_min_mb - smb + ksm_credit))
    if [ $((free_mb - dmb)) -ge ${HOST_RESERVE_MB} ]; then ram="RAM ok at $dmb MB"; fit=1
    elif [ "$tight" -ge ${SQUEEZED_FLOOR_MB} ]; then ram="RAM tight - at $smb MB, with the small-RAM steps$ksm_txt"; fit=2
    else ram="RAM short by $((${SQUEEZED_FLOOR_MB} - tight)) MB even at $smb MB"; fit=0; fi
    if [ -z "$pool_free_gb" ]; then disk="disk unknown ('$POOLS' free space)"
    elif [ "$pool_free_gb" -ge "$dgb" ]; then disk="disk ok ($dgb of $pool_free_gb GB free$on)"
    else disk="disk short ($dgb GB needed, $pool_free_gb free$on)"; fit=0; fi
    cpu=$(cpu_for "$tc"); [ "$tc" -gt "$threads" ] && fit=0
    if [ "$fit" -gt 0 ]; then
      say YES "$tier: $ram; $disk; $cpu."
      if [ -z "$best" ]; then best=$tier; [ "$fit" -eq 2 ] && best_mb=$smb; fi
    else say NO "$tier: $ram; $disk; $cpu."; fi
  done <<< "$TIER_TABLE"
  echo
  if [ -z "$best" ]; then echo "$HOST: no room for another node."
  elif [ -n "$best_mb" ]; then
    echo "$HOST: the largest that fits is one $best, at $best_mb MB (vmMemoryMb) with the small-RAM steps."
    echo "Add the slot with fh-toolkit inventory, then run fh-toolkit host-check $HOST for the steps."
    echo "Build it alone, after the other VMs have settled: a first boot briefly uses nearly all its RAM."
  else echo "$HOST: the largest that fits is one $best."; fi
  [ "$ksm_young" = 1 ] && echo "KSM started $(ago "$young_for") ago and is still merging (saving $ksm_mb MB so far) - run this again in 5 minutes."
  echo "(FluxOS benchmarks EPS itself; this counts threads. Adding VMs one at a time shows where a host really stops.)"
  exit 0
fi
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
  if systemctl is-active --quiet ksmtuned 2>/dev/null && [ "$coef" -ge 50 ]; then
    say OK "2. KSM: ksmtuned running, KSM_THRES_COEF=$coef, sharing $ksm_mb MB now."
  else
    say TODO "2. KSM: $NVM VMs share identical pages; hold KSM on (KSM_THRES_COEF=$coef, want 50):"
    cmd "apt install ksm-control-daemon" \\
        "sed -i '/KSM_THRES_COEF=/d' /etc/ksmtuned.conf; echo KSM_THRES_COEF=50 >> /etc/ksmtuned.conf" \\
        "systemctl enable --now ksmtuned; systemctl restart ksmtuned"
  fi
fi

# --- 3. Swap on a disk the VMs do not benchmark on ----------------------------------------
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
  say WARN "3. Disk swap: $disk_mb MB on \${swap_on:-?}, but cannot tell which disk VM storage '$POOLS' (\${stype:-not in storage.cfg}) uses - check it is not that one."
elif [ "$disk_mb" -ge $((${DISK_SWAP_MIN_MB} - 64)) ] && [ "$off_pool" -eq 1 ]; then
  say OK "3. Disk swap: $disk_mb MB on $swap_on, off the VM disk ($pool_disks)."
elif [ "$disk_mb" -ge $((${DISK_SWAP_MIN_MB} - 64)) ] && [ "$on_pool" -eq 1 ]; then
  say WARN "3. Disk swap: $disk_mb MB on $swap_on - the VM disk. If benchmarks fail on ddwrite, move swap to a small SSD/NVMe of its own (an M.2 PCIe card works)."
else
  if [ -n "$pool_disks" ]; then where="VM disk: $pool_disks"; else where="VM storage '$POOLS'"; fi
  say TODO "3. Disk swap: $disk_mb MB - want ${DISK_SWAP_MIN_MB} MB or more, on a disk the VMs do not use ($need). $where."
  echo "      Best - a separate SSD/NVMe (an M.2 card works; it need not boot). CHECK <disk> - mkswap erases it:"
  cmd "lsblk -d -o NAME,TRAN,SIZE,MODEL" \\
      "mkswap -L fhswap /dev/<disk>" \\
      "echo 'LABEL=fhswap none swap sw,pri=10 0 0' >> /etc/fstab; swapon -a; swapon --show"
  if [ "$stype" = zfspool ]; then
    echo "      No fallback on ZFS: swap on a ZFS volume can hang the host. Without a spare disk, use zram and step 4."
  elif [ "$stype" = lvmthin ] && [ -n "$tp" ]; then
    echo "      Fallback - a thin volume in the VM pool (costs some ddwrite at boot peaks). Pool $vg/$tp is \${pool_gb:-?} GiB,"
    echo "      volumes in it \${used_gb:-?} GiB: keep node disks + swap within the pool."
    cmd "lvcreate -V 4G -T $vg/$tp -n swap" \\
        "mkswap /dev/$vg/swap" \\
        "echo '/dev/$vg/swap none swap sw,pri=10 0 0' >> /etc/fstab; swapon -a; swapon --show"
  fi
fi

# --- 4. Smaller VMs -----------------------------------------------------------------------
# The ARC shrinks toward its minimum when the VMs need the RAM, so count only that here.
left_mb=$((mem_mb - SQUEEZED_MB - other_mb - arc_min_mb + ksm_credit))
if [ "$left_mb" -lt ${SQUEEZED_FLOOR_MB} ]; then
  say TODO "4. VM sizes: even at the smallest sizes ($SQUEEZED_MB MB) the host keeps $left_mb MB (counting ~$ksm_credit MB KSM saves), under the ~${SQUEEZED_FLOOR_MB} MB seen working. Too many VMs for this RAM:"
  cmd "fh-toolkit inventory    # take a slot off $HOST - or add RAM"
elif [ "$SQUEEZE_JSON" = "{}" ]; then
  say OK "4. VM sizes: already at the smallest size that passes the RAM check with margin."
else
  say TODO "4. VM sizes: still short - build smaller VMs (they pass the RAM check). Host keeps $((mem_mb - SQUEEZED_MB - other_mb - arc_mb)) MB, plus ~$ksm_credit MB KSM saves:"
  cmd "fh-toolkit inventory    # set vmMemoryMb $SQUEEZE_JSON on $HOST"
fi
echo
if [ "$todo" -eq 0 ]; then echo "$HOST: nothing left to do."; else echo "$HOST: $todo step(s) to do. Re-run this after them."; fi
`;
}
