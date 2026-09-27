#!/bin/bash
# burn-host.sh — the half of fh-burner that runs ON the Proxmox host (as root).
# `fh-toolkit burn <host>` fetches it from the fh-burner release and runs it; it also
# runs by hand:
#
#   burn-host.sh --image <fh-burner-X.qcow2> --plan "<tier>:<MB>:<cores>:<pool> ..."
#                [--fill max|<pct>] [--no-retry] [--keep]
#
# Burn-in for an EMPTY host, before it carries nodes: one burn VM per planned node, sized
# like it. At step k = 1..N the k-th VM fills its memory while all k VMs write to disk
# (swap I/O and node writes collide on a real host), then all k run a CPU test and a disk
# test at the same moment. The host is sampled throughout.
#
# The verdict is about the HOST surviving, not the scores (reported only as a drop from
# the 1-VM step):
#   FAIL  kernel OOM / hung task / I/O error; a burn VM stops or its guest agent goes
#         silent; the host stalls (a 1-s sample > 6 s late); MemAvailable < 200 MB with
#         < 512 MB swap free; memory pressure (full) > 40% — thrashing
#   WARN  MemAvailable < 1 GB, any swap-out, or memory pressure (full) > 5%
#   OK    none of those
# `--fill max` (the default) has each VM use all its RAM, where a node's page cache ends
# up. When that FAILs, the ramp runs again at 90% (unless --no-retry), so the report says
# how far from the edge the host is, not only that it is past it.
#
# Proven on pve25 (i7-4770, 32 GB, 09-27), one nimbus at 31744 MB with the disk busy:
# full → FAIL with or without zram + swap + KSM (with none: OOM kill); 90% → WARN.
#
# Safety: burn VMs have no network; template 9900, VMs 9901+, tag fh-burn. Every burn VM
# is destroyed on exit, including Ctrl-C, unless --keep. A ramp stops at its first FAIL,
# so the host is driven no further than it takes to prove one.
set -uo pipefail

TMPL=9900; BASE=9900; FILL=max; KEEP=0; RETRY=1; IMAGE=""; PLAN=""
while [ $# -gt 0 ]; do
  case $1 in
    --image) IMAGE=$2; shift ;;  --plan) PLAN=$2; shift ;;  --fill) FILL=$2; shift ;;
    --keep) KEEP=1 ;;            --no-retry) RETRY=0 ;;
    *) echo "burn-host: unknown argument $1" >&2; exit 2 ;;
  esac; shift
done
read -r -a SPEC <<< "$PLAN"
N=${#SPEC[@]}
usage="usage: burn-host.sh --image F --plan \"tier:MB:cores:pool ...\" [--fill max|pct] [--no-retry] [--keep]"
[ -f "$IMAGE" ] && [ "$N" -gt 0 ] || { echo "$usage" >&2; exit 2; }
for s in "${SPEC[@]}"; do
  [[ $s =~ ^[a-z]+:[0-9]+:[0-9]+:[A-Za-z0-9_.-]+$ ]] || { echo "burn-host: bad plan entry '$s'" >&2; echo "$usage" >&2; exit 2; }
done
spec() { local IFS=:; read -r -a f <<< "${SPEC[$(($1-1))]}"; echo "${f[$2]}"; }  # spec <k> <0 tier|1 MB|2 cores|3 pool>
TPOOL=$(spec 1 3)

RUN=/var/tmp/fh-burn/$(date +%Y%m%d-%H%M%S); mkdir -p "$RUN"
R=$RUN   # the current ramp's directory
ids() { seq $((BASE+1)) $((BASE+$1)); }
log() { echo "$(date +%H:%M:%S) $*" | tee -a "$R/log"; }

# ── refuse to start over leftover burn VMs ──────────────────────────────────────────
for id in $(ids "$N"); do
  qm status "$id" >/dev/null 2>&1 && { echo "burn-host: VM $id already exists (an earlier burn not cleaned up?) — remove it first" >&2; exit 1; }
done

# ── template from the image (rebuilt when the image version changes) ───────────────
ver=$(basename "$IMAGE" .qcow2); ver=${ver#fh-burner-}
if [ -f "$IMAGE.sha256" ]; then
  (cd "$(dirname "$IMAGE")" && sha256sum -c --quiet "$(basename "$IMAGE").sha256") || { echo "burn-host: checksum mismatch on $IMAGE" >&2; exit 1; }
fi
have=$(qm config $TMPL 2>/dev/null | awk -F': ' '/^description:/{print $2}')
tpool_have=$(qm config $TMPL 2>/dev/null | awk -F'[ :,]+' '/^scsi0:/{print $2}')
if [ "$have" != "fh-burner $ver" ] || [ "$tpool_have" != "$TPOOL" ]; then
  if qm status $TMPL >/dev/null 2>&1; then
    qm config $TMPL | grep -q '^tags:.*fh-burn' || { echo "burn-host: VM $TMPL exists and is not an fh-burner template — refusing to touch it" >&2; exit 1; }
    qm destroy $TMPL --purge 1 >/dev/null
  fi
  log "building template $TMPL from fh-burner $ver on $TPOOL"
  qm create $TMPL --name fh-burner-tmpl --tags fh-burn --description "fh-burner $ver" --ostype l26 \
    --cpu host --cores 1 --memory 1024 --scsihw virtio-scsi-single --agent 1 \
    --serial0 socket --vga serial0 >/dev/null || exit 1
  qm set $TMPL --scsi0 "$TPOOL:0,import-from=$IMAGE,discard=on,iothread=1,ssd=1" --boot order=scsi0 >/dev/null || { qm destroy $TMPL --purge 1; exit 1; }
  qm disk resize $TMPL scsi0 20G >/dev/null && qm template $TMPL >/dev/null || { qm destroy $TMPL --purge 1; exit 1; }
fi

# ── host sampler: 1 s while memory fills (a 5-s sampler missed the dip before an OOM on
#    pve25), 5 s otherwise ─────────────────────────────────────────────────────────────
psi() { awk -v k="$2" '$1==k{split($2,a,"="); print a[2]}' "/proc/pressure/$1"; }
sample() {
  echo "t,step,phase,mem_avail_mb,psi_mem_full10,psi_io_full10,psi_cpu_some10,ksm_sharing_mb,swap_used_mb,pswpin,pswpout,load1,zram_mb" > "$R/host.csv"
  local last=0 nap=5 now ma pm pi pc ks su sf si so zr ph
  while :; do
    now=$(date +%s)
    # A 1-s sample that arrives >6 s late means the HOST froze (pve25: 8–12 s with a
    # nimbus at full fill while its disk was busy) — nodes would stall with it.
    [ "$nap" = 1 ] && [ "$last" -gt 0 ] && [ $((now - last)) -gt 6 ] && fail "host stalled $((now - last)) s"
    last=$now
    ma=$(awk '/MemAvailable/{print int($2/1024)}' /proc/meminfo)
    pm=$(psi memory full); pi=$(psi io full); pc=$(psi cpu some)
    ks=$(( $(cat /sys/kernel/mm/ksm/pages_sharing) * 4 / 1024 ))
    read -r su sf < <(free -m | awk '/Swap/{print $3, $4}')
    si=$(awk '/^pswpin/{print $2}' /proc/vmstat); so=$(awk '/^pswpout/{print $2}' /proc/vmstat)
    zr=$(awk '{printf "%d", $1/1048576}' /sys/block/zram0/mm_stat 2>/dev/null || echo 0)
    ph=$(cat "$R/.phase" 2>/dev/null)
    echo "$now,$(cat "$R/.step" 2>/dev/null),$ph,$ma,$pm,$pi,$pc,$ks,$su,$si,$so,$(cut -d' ' -f1 /proc/loadavg),$zr" >> "$R/host.csv"
    { [ "$ma" -lt 200 ] && [ "$sf" -lt 512 ]; } && fail "MemAvailable $ma MB with $sf MB swap free"
    awk -v p="$pm" 'BEGIN{exit !(p>40)}' && fail "memory pressure full $pm% (thrashing)"
    case $ph in mem|ddfill) nap=1 ;; *) nap=5 ;; esac
    sleep $nap
  done
}

SAMPLER=""
destroy_vms() {
  for id in $(ids "$N"); do
    qm status "$id" >/dev/null 2>&1 && { qm stop "$id" --skiplock 1 >/dev/null 2>&1; qm destroy "$id" --purge 1 >/dev/null 2>&1; }
  done
}
stop_sampler() { [ -n "$SAMPLER" ] && kill "$SAMPLER" 2>/dev/null; SAMPLER=""; }
cleanup() {
  trap '' PIPE   # the ssh session may be gone; cleaning up must not die writing to it
  stop_sampler
  if [ "$KEEP" = 1 ]; then log "--keep: burn VMs left running"; return; fi
  destroy_vms; log "cleaned up"
}
trap cleanup EXIT
trap 'exit 1' INT TERM HUP PIPE   # Ctrl-C, or the ssh session dropping

phase() { echo "$1" > "$R/.phase"; }
# Every FAIL reason, the first of each kind (the sampler would repeat them every second).
fail() { local kind=${1%% [0-9]*}; grep -qF "$kind" "$R/.abort" 2>/dev/null || echo "$1" >> "$R/.abort"; }
reasons() { paste -sd';' "$R/.abort" | sed 's/;/; /g'; }
aborted() { [ -f "$R/.abort" ] && { log "ABORT: $(reasons)"; return 0; }; return 1; }
# Fatal: kernel OOM / hung task / I/O errors since the ramp began; a burn VM not running,
# or its guest agent silent.
fatal() {
  local bad=0 m st id
  m=$(journalctl -k --since "$KSINCE" --no-pager 2>/dev/null | grep -Ei "out of memory|oom-kill|killed process|blocked for more than|hung_task|i/o error|ext4-fs error|buffer i/o|kvm.*(error|fail)" | tail -5)
  [ -n "$m" ] && { log "FATAL kernel: $m"; bad=1; }
  for id in $(ids "$1"); do
    st=$(qm status "$id" | awk '{print $2}')
    [ "$st" != running ] && { log "FATAL: VM $id is $st"; bad=1; continue; }
    timeout 15 qm guest cmd "$id" ping >/dev/null 2>&1 || { log "FATAL: VM $id guest agent silent 15 s"; bad=1; }
  done
  [ $bad = 1 ] && fail "fatal (see FATAL lines)"
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
field() { grep -o "\"$2\":\"\\?[^,\"}]*" "$1" | head -1 | sed 's/.*:"\?//'; }
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

VERDICTS=()
# One ramp at one fill level; appends "<fill>|<FAIL|WARN|OK>|<detail>" to VERDICTS.
ramp() {
  local fill=$1 k id id2 up i T pids lo pk out v
  R=$RUN/fill-$fill; mkdir -p "$R"; KSINCE=$(date "+%Y-%m-%d %H:%M:%S")
  echo 0 > "$R/.step"; sample & SAMPLER=$!
  log "ramp: $N VM(s), fill=$fill — ${SPEC[*]}"
  sleep 15   # idle baseline
  for k in $(seq 1 "$N"); do
    id=$((BASE+k)); echo "$k" > "$R/.step"; phase boot
    local pool; pool=$(spec "$k" 3)
    local clone=(qm clone $TMPL "$id" --name "fh-burn-$k")
    [ "$pool" != "$TPOOL" ] && clone+=(--full 1 --storage "$pool")
    "${clone[@]}" >/dev/null && qm set "$id" --memory "$(spec "$k" 1)" --cores "$(spec "$k" 2)" --tags fh-burn >/dev/null && qm start "$id" >/dev/null \
      || { fail "could not start VM $id ($(spec "$k" 0) on $pool)"; aborted; break; }
    up=0; for i in $(seq 90); do qm guest cmd "$id" ping >/dev/null 2>&1 && { up=1; break; }; sleep 2; done
    [ $up = 1 ] || { fail "VM $id guest agent never answered"; aborted; break; }
    log "step $k: VM $id ($(spec "$k" 0), $(spec "$k" 1) MB, $(spec "$k" 2) cores, $pool) up after $((i*2)) s"
    # The new VM fills its memory (the older ones still hold theirs) while EVERY VM
    # writes to disk: on a real host, swap I/O and the nodes' own writes collide, and
    # that is where ddwrite dips come from. 8 GB so the writes outlast the fill.
    phase mem
    T=$(( $(date +%s) + 2 )); pids=""
    for id2 in $(ids "$k"); do
      ( qm guest exec "$id2" --timeout 900 -- burn-run dd "$T" 8192 2>&1 | json > "$R/$k-ddfill-$id2.json" ) &
      pids="$pids $!"
    done
    qm guest exec "$id" --timeout 900 -- burn-run mem "$T" "$fill" 2>&1 | json > "$R/$k-mem-$id.json"
    log "step $k: memory held in $(field "$R/$k-mem-$id.json" secs) s"
    phase ddfill; wait $pids
    for id2 in $(ids "$k"); do log "step $k: VM $id2 dd during fill=$(field "$R/$k-ddfill-$id2.json" rate)"; done
    fatal "$k"; aborted && break
    sleep 10; phase settle; sleep 20
    fatal "$k"; aborted && break
    run_all "$k" eps 30 180; aborted && break
    run_all "$k" dd 2048 600; aborted && break
    fatal "$k"; aborted && break
    for id2 in $(ids "$k"); do
      log "step $k: VM $id2 eps=$(field "$R/$k-eps-$id2.json" eps) dd=$(field "$R/$k-dd-$id2.json" rate)"
    done
  done
  phase done; sleep 10; stop_sampler

  awk -F, 'NR>1 && $2!="" {s=$2; if(!(s in mn)||$4<mn[s])mn[s]=$4; if($5>pm[s])pm[s]=$5; if($6>pi[s])pi[s]=$6; if($9>sw[s])sw[s]=$9; if($13>zr[s])zr[s]=$13; if(!(s in so0))so0[s]=$11; so1[s]=$11; if($8>ks[s])ks[s]=$8}
    END{for(s in mn) printf "step %s: min MemAvailable %d MB | swap peak %d MB, swapped out %d MB | zram %d MB | KSM %d MB | peak mem-full %.2f%%, io-full %.2f%%\n", s, mn[s], sw[s], (so1[s]-so0[s])*4/1024, zr[s], ks[s], pm[s], pi[s]}' "$R/host.csv" | sort | tee -a "$R/log"
  read -r lo pk out < <(awk -F, 'NR>1 && $2!="" && $2!="0" {if(!m||$4<m)m=$4; if($5>p)p=$5; if(!s0)s0=$11; s1=$11} END{printf "%d %.2f %d\n", m, p, (s1-s0)*4/1024}' "$R/host.csv")
  if [ -f "$R/.abort" ]; then v="FAIL|$(reasons)"
  elif [ "$lo" -lt 1024 ] || [ "$out" -gt 0 ] || awk -v p="$pk" 'BEGIN{exit !(p>5)}'; then
    v="WARN|lowest MemAvailable $lo MB, swapped out $out MB, memory pressure full $pk%"
  else v="OK|lowest MemAvailable $lo MB, no swapping"; fi
  VERDICTS+=("$fill|$v")
  log "VERDICT (fill $fill): ${v%%|*} — ${v#*|}"
}

log "fh-burner $ver on $(hostname): $N VM(s) — ${SPEC[*]} → $RUN"
ramp "$FILL"
if [ "$RETRY" = 1 ] && [ "$FILL" = max ] && [[ ${VERDICTS[0]} == max\|FAIL* ]]; then
  R=$RUN; log "full fill FAILED — cleaning up, then the same ramp at 90%"
  destroy_vms; sleep 30
  ramp 90
fi

R=$RUN
echo
log "════ fh-burner verdict for $(hostname) ════"
for v in "${VERDICTS[@]}"; do
  f=${v%%|*}; rest=${v#*|}
  [ "$f" = max ] && f="all of each VM's memory" || f="$f% of each VM's memory"
  log "  $f: ${rest%%|*} — ${rest#*|}"
done
log "  results: $RUN"
