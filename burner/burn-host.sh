#!/bin/bash
# burn-host.sh — the half of fh-burner that runs ON the Proxmox host (as root).
#
#   burn-host.sh --image <fh-burner-X.qcow2> --tier <name> --n <N> --mem <MB> --cores <C>
#                [--pool <storage>] [--fill max|<pct>] [--keep]
#
# Burn-in for an EMPTY host, before it carries nodes: clone N burn VMs sized like the
# slots, and at each step k = 1..N have all k VMs fill their memory, then run a CPU and
# a disk test at the same moment, while the host is sampled. The verdict is about the
# HOST surviving — free memory, swap, memory pressure, OOM kills — not about the
# scores, which are reported only as a drop from the 1-VM step.
#
# Proven on pve25 (09-27): one nimbus at 31744 MB, fill=max → WARN with zram + swap +
# KSM on (54 MB left, 2.9 GB swapped), FAIL with them off (the host OOM-killed the VM).
#
# Safety: burn VMs have no network; VMIDs 9901+ (template 9900), tag fh-burn. Every
# burn VM is destroyed on exit, including Ctrl-C, unless --keep. The run stops early on
# a FAIL condition so it never drives the host further than it takes to prove one.
set -uo pipefail

TMPL=9900; BASE=9900; POOL=local-lvm; FILL=max; KEEP=0; IMAGE=""; TIER=""; N=0; MEM=0; CORES=0
while [ $# -gt 0 ]; do
  case $1 in
    --image) IMAGE=$2; shift ;;   --tier) TIER=$2; shift ;;   --n) N=$2; shift ;;
    --mem) MEM=$2; shift ;;       --cores) CORES=$2; shift ;; --pool) POOL=$2; shift ;;
    --fill) FILL=$2; shift ;;     --keep) KEEP=1 ;;
    *) echo "burn-host: unknown argument $1" >&2; exit 2 ;;
  esac; shift
done
[ -f "$IMAGE" ] && [ -n "$TIER" ] && [ "$N" -gt 0 ] && [ "$MEM" -gt 0 ] && [ "$CORES" -gt 0 ] \
  || { echo "usage: burn-host.sh --image F --tier T --n N --mem MB --cores C [--pool P] [--fill max|pct] [--keep]" >&2; exit 2; }

R=/var/tmp/fh-burn/$(date +%Y%m%d-%H%M%S)-$TIER-$N; mkdir -p "$R"
ids() { seq $((BASE+1)) $((BASE+$1)); }
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$R/log"; }

# ── refuse to start on a host that is not empty of burn VMs ────────────────────────
for id in $(ids "$N"); do
  qm status "$id" >/dev/null 2>&1 && { echo "burn-host: VM $id already exists (an earlier burn not cleaned up?) — remove it first" >&2; exit 1; }
done

# ── template from the image (rebuilt when the image version changes) ───────────────
ver=$(basename "$IMAGE" .qcow2); ver=${ver#fh-burner-}
if [ -f "$IMAGE.sha256" ]; then
  (cd "$(dirname "$IMAGE")" && sha256sum -c --quiet "$(basename "$IMAGE").sha256") || { echo "burn-host: checksum mismatch on $IMAGE" >&2; exit 1; }
fi
have=$(qm config $TMPL 2>/dev/null | awk -F': ' '/^description:/{print $2}')
if [ "$have" != "fh-burner $ver" ]; then
  if qm status $TMPL >/dev/null 2>&1; then
    qm config $TMPL | grep -q '^tags:.*fh-burn' || { echo "burn-host: VM $TMPL exists and is not an fh-burner template — refusing to touch it" >&2; exit 1; }
    qm destroy $TMPL --purge 1 >/dev/null
  fi
  log "building template $TMPL from fh-burner $ver on $POOL"
  qm create $TMPL --name fh-burner-tmpl --tags fh-burn --description "fh-burner $ver" --ostype l26 \
    --cpu host --cores 1 --memory 1024 --scsihw virtio-scsi-single --agent 1 \
    --serial0 socket --vga serial0 >/dev/null || exit 1
  qm set $TMPL --scsi0 "$POOL:0,import-from=$IMAGE,discard=on,iothread=1,ssd=1" --boot order=scsi0 >/dev/null || { qm destroy $TMPL --purge 1; exit 1; }
  qm disk resize $TMPL scsi0 20G >/dev/null && qm template $TMPL >/dev/null || { qm destroy $TMPL --purge 1; exit 1; }
fi

# ── host sampler: 1 s while memory fills (a 5 s sampler missed the dip before an OOM
#    on pve25), 5 s otherwise ───────────────────────────────────────────────────────
psi() { awk -v k="$2" '$1==k{split($2,a,"="); print a[2]}' "/proc/pressure/$1"; }
sample() {
  echo "t,step,phase,mem_avail_mb,psi_mem_full10,psi_io_full10,psi_cpu_some10,ksm_sharing_mb,swap_used_mb,pswpin,pswpout,load1,zram_mb" > "$R/host.csv"
  while :; do
    ma=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
    pm=$(psi memory full); pi=$(psi io full); pc=$(psi cpu some)
    ks=$(( $(cat /sys/kernel/mm/ksm/pages_sharing) * 4 / 1024 ))
    read -r su sf < <(free -m | awk '/Swap/{print $3, $4}')
    si=$(awk '/^pswpin/{print $2}' /proc/vmstat); so=$(awk '/^pswpout/{print $2}' /proc/vmstat)
    zr=$(awk '{printf "%d", $1/1048576}' /sys/block/zram0/mm_stat 2>/dev/null || echo 0)
    ph=$(cat "$R/.phase" 2>/dev/null)
    echo "$(date +%s),$(cat "$R/.step" 2>/dev/null),$ph,$ma,$pm,$pi,$pc,$ks,$su,$si,$so,$(cut -d' ' -f1 /proc/loadavg),$zr" >> "$R/host.csv"
    { [ "$ma" -lt 200 ] && [ "$sf" -lt 512 ]; } && echo "MemAvailable $ma MB with $sf MB swap free" > "$R/.abort"
    awk -v p="$pm" 'BEGIN{exit !(p>40)}' && echo "memory pressure full $pm% (thrashing)" > "$R/.abort"
    [ "$ph" = mem ] && sleep 1 || sleep 5
  done
}

SAMPLER=""
cleanup() {
  [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null
  if [ "$KEEP" = 1 ]; then log "--keep: burn VMs left running"; return; fi
  for id in $(ids "$N"); do
    qm status "$id" >/dev/null 2>&1 && { qm stop "$id" --skiplock 1 >/dev/null 2>&1; qm destroy "$id" --purge 1 >/dev/null 2>&1; }
  done
  log "cleaned up"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

phase() { echo "$1" > "$R/.phase"; }
aborted() { [ -f "$R/.abort" ] && { log "ABORT: $(cat "$R/.abort")"; return 0; }; return 1; }
KSINCE=$(date "+%Y-%m-%d %H:%M:%S")
# Fatal: kernel OOM / hung task / I/O errors since the start; a burn VM not running,
# or its guest agent silent.
fatal() {
  local bad=0 m st
  m=$(journalctl -k --since "$KSINCE" --no-pager 2>/dev/null | grep -Ei "out of memory|oom-kill|killed process|blocked for more than|hung_task|i/o error|ext4-fs error|buffer i/o|kvm.*(error|fail)" | tail -5)
  [ -n "$m" ] && { log "FATAL kernel: $m"; bad=1; }
  for id in $(ids "$1"); do
    st=$(qm status "$id" | awk '{print $2}')
    [ "$st" != running ] && { log "FATAL: VM $id is $st"; bad=1; continue; }
    timeout 15 qm guest cmd "$id" ping >/dev/null 2>&1 || { log "FATAL: VM $id guest agent silent 15 s"; bad=1; }
  done
  [ $bad = 1 ] && { echo fatal > "$R/.abort"; log "ABORT: fatal"; }
  return $bad
}
# `qm guest exec` answers with JSON, or with plain text such as "timeout reached,
# returning pid" — keep either, as one JSON line.
json() { python3 -c '
import sys, json
raw = sys.stdin.read()
try:
    d = json.loads(raw); print(d.get("out-data", "").strip() or json.dumps({"err": d}))
except ValueError:
    print(json.dumps({"err": raw.strip()}))'; }
# Run one phase on VMs 1..k at the same moment.
run_all() {  # run_all <k> <phase> <arg> <timeout>
  local k=$1 p=$2 a=$3 to=$4 T pids="" id
  T=$(( $(date +%s) + 5 )); phase "$p"
  for id in $(ids "$k"); do
    ( qm guest exec "$id" --timeout "$to" -- burn-run "$p" "$T" "$a" 2>&1 | json > "$R/$k-$p-$id.json" ) &
    pids="$pids $!"
  done
  wait $pids
}
field() { grep -o "\"$2\":\"\\?[^,\"}]*" "$1" | head -1 | sed 's/.*:"\?//'; }

echo 0 > "$R/.step"; sample & SAMPLER=$!
log "burn $TIER N=$N mem=${MEM}MB cores=$CORES fill=$FILL pool=$POOL image=$ver → $R"
sleep 15   # idle baseline
for k in $(seq 1 "$N"); do
  id=$((BASE+k)); echo "$k" > "$R/.step"; phase boot
  qm clone $TMPL "$id" --name "fh-burn-$k" >/dev/null && qm set "$id" --memory "$MEM" --cores "$CORES" --tags fh-burn >/dev/null && qm start "$id" \
    || { echo "could not start VM $id" > "$R/.abort"; aborted; break; }
  up=0; for i in $(seq 90); do qm guest cmd "$id" ping >/dev/null 2>&1 && { up=1; break; }; sleep 2; done
  [ $up = 1 ] || { echo "VM $id guest agent never answered" > "$R/.abort"; aborted; break; }
  log "step $k: VM $id up after $((i*2)) s"
  # The new VM fills its memory; the older ones still hold theirs.
  phase mem
  qm guest exec "$id" --timeout 900 -- burn-run mem 0 "$FILL" 2>&1 | json > "$R/$k-mem-$id.json"
  log "step $k: memory held in $(field "$R/$k-mem-$id.json" secs) s"
  aborted && break; fatal "$k" || break
  sleep 10; phase settle; sleep 20
  fatal "$k" || break
  run_all "$k" eps 30 180; aborted && break
  run_all "$k" dd 2048 600; aborted && break
  fatal "$k" || break
  for id2 in $(ids "$k"); do
    log "step $k: VM $id2 eps=$(field "$R/$k-eps-$id2.json" eps) dd=$(field "$R/$k-dd-$id2.json" rate)"
  done
done
phase done; sleep 10

# ── per-step host summary + verdict ─────────────────────────────────────────────────
awk -F, 'NR>1 && $2!="" {s=$2; if(!(s in mn)||$4<mn[s])mn[s]=$4; if($5>pm[s])pm[s]=$5; if($6>pi[s])pi[s]=$6; if($9>sw[s])sw[s]=$9; if($13>zr[s])zr[s]=$13; if(!(s in so0))so0[s]=$11; so1[s]=$11; if($8>ks[s])ks[s]=$8}
  END{for(s in mn) printf "step %s: min MemAvailable %d MB | swap peak %d MB, swapped out %d MB | zram %d MB | KSM %d MB | peak mem-full %.2f%%, io-full %.2f%%\n", s, mn[s], sw[s], (so1[s]-so0[s])*4/1024, zr[s], ks[s], pm[s], pi[s]}' "$R/host.csv" | sort | tee -a "$R/log"
read -r lo pk out < <(awk -F, 'NR>1 && $2!="" && $2!="0" {if(!m||$4<m)m=$4; if($5>p)p=$5; if(!s0)s0=$11; s1=$11} END{printf "%d %.2f %d\n", m, p, (s1-s0)*4/1024}' "$R/host.csv")
if [ -f "$R/.abort" ]; then v="FAIL — $(cat "$R/.abort")"
elif [ "$lo" -lt 1024 ] || [ "$out" -gt 0 ] || awk -v p="$pk" 'BEGIN{exit !(p>5)}'; then
  v="WARN — lowest MemAvailable $lo MB, swapped out $out MB, memory pressure full $pk%"
else v="OK — lowest MemAvailable $lo MB, no swapping"; fi
log "VERDICT: $v"
