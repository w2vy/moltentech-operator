import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostCheckScript, plannedVms, type HostCheckInput, type HostCheckOptions } from "./host-check";
import { tmpDir } from "./test-tmp";

/**
 * A fake Proxmox host: files under HC_ROOT, and stub lsblk/pvs/lvs/systemctl/findmnt on
 * PATH. Disks: sda = boot HDD (pve VG), sdb = the VM SSD (ssd VG, thin pool `data`).
 */
interface FakeHost {
  memMb: number;
  /** /proc/swaps rows: [name, type, MB, priority]. */
  swaps: [string, string, number, number][];
  ksmCoef?: number;
  ksmtunedActive?: boolean;
  /** ZFS: a pool `rpool` on sdb3, and the ARC's max/min. */
  zfs?: { arcMaxMb: number; arcMinMb: number };
  /** /etc/pve/qemu-server/<id>.conf bodies; `running` writes the pid file. */
  vms?: { id: number; conf: string; running?: boolean; busiest?: number }[];
  /** Physical cores behind the threads (default: one per thread). */
  physCores?: number;
  /** KSM pages_sharing, in MB (default 1024). */
  ksmMb?: number;
  /** CPU threads in /proc/cpuinfo (default 16), and the thin pool's size / volumes in GB. */
  threads?: number;
  pool?: [number, number];
  /** sda is a PERC virtual disk. */
  raid?: boolean;
}

const STORAGE_CFG = `dir: local
\tpath /var/lib/vz
\tcontent iso

lvmthin: local-lvm
\tthinpool data
\tvgname pve

lvmthin: ssd
\tthinpool data
\tvgname ssd
\tcontent images,rootdir

lvm: ss1
\tvgname ss1
\tcontent images,rootdir

lvm: ss2
\tvgname ss2
\tcontent images,rootdir

zfspool: local-zfs
\tpool rpool/data
\tcontent images,rootdir
`;

function run(host: HostCheckInput, fake: FakeHost, opts: HostCheckOptions = {}): string {
  const root = tmpDir("fh-hostcheck-");
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  };
  put("proc/meminfo", `MemTotal:       ${fake.memMb * 1024} kB\nMemFree:  1000 kB\n`);
  put(
    "proc/swaps",
    "Filename\t\t\t\tType\t\tSize\t\tUsed\t\tPriority\n" +
      fake.swaps.map(([n, t, mb, p]) => `${n}\t${t}\t${mb * 1024}\t0\t${p}\n`).join("")
  );
  put("etc/pve/storage.cfg", STORAGE_CFG);
  put("etc/ksmtuned.conf", fake.ksmCoef === undefined ? "# KSM_THRES_COEF=20\n" : `KSM_THRES_COEF=${fake.ksmCoef}\n`);
  put("sys/kernel/mm/ksm/pages_sharing", `${(fake.ksmMb ?? 1024) * 256}\n`);
  const threads = fake.threads ?? 16;
  const phys = fake.physCores ?? threads;
  put(
    "proc/cpuinfo",
    Array.from({ length: threads }, (_, i) => `processor\t: ${i}\nphysical id\t: 0\ncore id\t\t: ${i % phys}\n\n`).join("")
  );
  put("sys/block/sda/queue/rotational", "1\n");
  put("sys/block/sdb/queue/rotational", "0\n");
  if (fake.raid) put("sys/block/sda/device/model", "PERC H710       \n");
  if (fake.zfs) {
    put("proc/spl/kstat/zfs/arcstats", `c_min 4 ${fake.zfs.arcMinMb * 1048576}\nc_max 4 ${fake.zfs.arcMaxMb * 1048576}\n`);
  }
  for (const vm of fake.vms ?? []) {
    put(`etc/pve/qemu-server/${vm.id}.conf`, vm.conf);
    if (vm.running) put(`var/run/qemu-server/${vm.id}.pid`, "1\n");
    // Proxmox's history: one quiet 30-min point and the busiest, as a share of 2 vCPUs.
    if (vm.busiest !== undefined)
      put(`rrd/${vm.id}.json`, JSON.stringify([{ cpu: 0.1, maxcpu: 2 }, { cpu: vm.busiest / 2, maxcpu: 2 }, { time: 1 }]));
  }
  const bin = join(root, "bin");
  const stub = (name: string, body: string) => {
    put(`bin/${name}`, `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  stub(
    "lsblk",
    `case "\${@: -1}" in
  /dev/dm-9|/dev/pve/swap) printf 'dm-9 lvm\\nsda3 part\\nsda disk\\n' ;;
  /dev/dm-20|/dev/ssd/swap) printf 'dm-20 lvm\\nssd-data-tpool lvm\\nsdb disk\\n' ;;
  /dev/sdb) printf 'sdb disk\\n' ;;
  /dev/sdc) printf 'sdc disk\\n' ;;
  /dev/sdd) printf 'sdd disk\\n' ;;
  /dev/nvme0n1) printf 'nvme0n1 disk\\n' ;;
  /dev/sdb3) printf 'sdb3 part\\nsdb disk\\n' ;;
  /dev/zd0) printf 'zd0 disk\\n' ;;
esac`
  );
  stub("pvs", `case "$*" in *vg_name=ssd*) echo "  /dev/sdb" ;; *vg_name=pve*) echo "  /dev/sda3" ;; *vg_name=ss1*) echo "  /dev/sdc" ;; *vg_name=ss2*) echo "  /dev/sdd" ;; esac`);
  stub("vgs", `case "$*" in *ss1*) echo "  13.70" ;; *ss2*) echo "  893.00" ;; esac`);
  const [poolGb, usedGb] = fake.pool ?? [445.13, 440];
  stub("lvs", `case "$*" in *-S*) printf '  ${usedGb}\\n' ;; *) printf '  ${poolGb}\\n' ;; esac`);
  stub(
    "systemctl",
    `case "$*" in *ActiveEnterTimestamp*) echo "Sat 2026-09-26 10:00:00 EDT" ;; *) exit ${fake.ksmtunedActive === false ? 3 : 0} ;; esac`
  );
  put("sys/kernel/mm/ksm/full_scans", "412\n");
  stub("findmnt", "exit 1");
  stub("pvesh", `id=$(echo "$2" | cut -d/ -f5); cat "$HC_ROOT/rrd/$id.json" 2>/dev/null || exit 1`);
  stub(
    "zpool",
    fake.zfs
      ? `case "$*" in *-vHP*) printf 'rpool\\t464G\\n\\t/dev/sdb3\\t464G\\n' ;; *) echo rpool ;; esac`
      : "exit 1"
  );
  return execFileSync("bash", ["-c", hostCheckScript(host, "0.0.0-test", opts)], {
    env: { ...process.env, HC_ROOT: root, PATH: `${bin}:${process.env.PATH}` },
    encoding: "utf8",
  });
}

const pve65: HostCheckInput = {
  name: "pve65",
  storageImages: "ssd",
  vmMemoryMb: { cumulus: 7680 },
  slots: [{ tier: "cumulus" }, { tier: "cumulus" }],
};
const pve50: HostCheckInput = { name: "pve50", storageImages: "ssd", vmMemoryMb: { nimbus: 31744 }, slots: [{ tier: "nimbus" }] };

test("planned sizes: vmMemoryMb wins, the tier default otherwise, unknown tiers dropped", () => {
  assert.deepEqual(plannedVms({ ...pve65, vmMemoryMb: undefined, slots: [{ tier: "cumulus" }, { tier: "mystery" }] }), [
    { tier: "cumulus", mb: 8192 },
  ]);
  assert.deepEqual(plannedVms(pve50), [{ tier: "nimbus", mb: 31744 }]);
});

test("a host with room: nothing to do, no steps listed", () => {
  const out = run({ ...pve65, name: "big" }, { memMb: 64221, swaps: [] });
  assert.match(out, /^OK +RAM fits/m);
  assert.doesNotMatch(out, /zram:|KSM:/);
});

test("pve65 as tuned (zram 2 GB prio 100, KSM coef 50, HDD swap): every step OK", () => {
  const out = run(pve65, {
    memMb: 15871,
    swaps: [
      ["/dev/zram0", "partition", 2047, 100],
      ["/dev/dm-9", "partition", 8192, -2],
    ],
    ksmCoef: 50,
  });
  assert.match(out, /^OK +1\. zram: 2047 MB, priority 100/m);
  assert.match(out, /^OK +2\. KSM: .*sharing 1024 MB/m);
  assert.match(out, /^OK +3\. Disk swap: 8192 MB on sda \(HDD\), off the VM disk \(sdb\)/m);
  assert.match(out, /^OK +4\. VM sizes/m);
  assert.match(out, /KSM is saving 1024 MB on top \(412 full scans, ksmtuned up [^,]+, its config changed \d+m ago\)\./);
  assert.match(out, /pve65: nothing left to do/);
});

test("fresh 2-cumulus box at default sizes: zram, KSM and smaller VMs to do", () => {
  const out = run({ ...pve65, vmMemoryMb: undefined }, { memMb: 15871, swaps: [["/dev/dm-9", "partition", 8192, -2]] });
  assert.match(out, /^TODO +1\. zram: none/m);
  assert.match(out, /systemctl stop zramswap; echo 1 > \/sys\/block\/zram0\/reset/);
  assert.match(out, /printf 'ALGO=zstd\\nSIZE=2048\\nPRIORITY=100\\n'/);
  assert.match(out, /^TODO +2\. KSM: 2 VMs .*KSM_THRES_COEF=20, want 50/m);
  assert.match(out, /sed -i '\/KSM_THRES_COEF=\/d' \/etc\/ksmtuned\.conf; echo KSM_THRES_COEF=50 >> \/etc\/ksmtuned\.conf/);
  assert.match(out, /^TODO +4\. VM sizes: .*\n.*vmMemoryMb \{"cumulus":7680\} on pve65/m);
  assert.match(out, /pve65: 3 step\(s\) to do/);
});

test("zram below disk swap priority is flagged", () => {
  const out = run(pve65, {
    memMb: 15871,
    swaps: [
      ["/dev/zram0", "partition", 2047, -3],
      ["/dev/dm-9", "partition", 8192, -2],
    ],
    ksmCoef: 50,
  });
  assert.match(out, /^TODO +1\. zram: 2047 MB at priority -3 - want 2048 MB, above disk swap \(-2\)/m);
});

test("pve50 before the fix (one nimbus, no swap): zram TODO, KSM skipped, swap REQUIRED with the pool fallback", () => {
  const out = run(pve50, { memMb: 31999, swaps: [] });
  assert.match(out, /^TODO +1\. zram/m);
  assert.match(out, /^SKIP +2\. KSM: one VM/m);
  assert.match(out, /^TODO +3\. Disk swap: 0 MB .*REQUIRED/m);
  assert.match(out, /VM disk: sdb/);
  assert.match(out, /mkswap -L fhswap \/dev\/<disk>/);
  assert.match(out, /Pool ssd\/data is 445 GiB,\n.*volumes in it 440 GiB/);
  assert.match(out, /lvcreate -V 4G -T ssd\/data -n swap/);
  assert.match(out, /^OK +4\. VM sizes/m);
});

test("pve50 as fixed (swap is a thin LV in the VM pool): WARN, not TODO", () => {
  const out = run(pve50, {
    memMb: 31999,
    swaps: [
      ["/dev/zram0", "partition", 2047, 100],
      ["/dev/dm-20", "partition", 4095, 10],
    ],
  });
  assert.match(out, /^WARN +3\. Disk swap: 4095 MB on sdb \(SSD\) - the VM disk\. If benchmarks fail on ddwrite/m);
  assert.match(out, /pve50: nothing left to do/);
});

test("swap on its own NVMe: OK", () => {
  const out = run(pve50, {
    memMb: 31999,
    swaps: [
      ["/dev/zram0", "partition", 2047, 100],
      ["/dev/nvme0n1", "partition", 8192, 10],
    ],
  });
  assert.match(out, /^OK +3\. Disk swap: 8192 MB on nvme0n1 \(NVMe\), off the VM disk \(sdb\)/m);
});

test("VM storage the script cannot map to a disk (e.g. zfspool): WARN, never a false OK", () => {
  const out = run({ ...pve50, storageImages: "nosuch" }, {
    memMb: 31999,
    swaps: [
      ["/dev/zram0", "partition", 2047, 100],
      ["/dev/dm-9", "partition", 8192, -2],
    ],
  });
  assert.match(out, /^WARN +3\. Disk swap: 8192 MB on sda \(HDD\), but cannot tell which disk VM storage 'nosuch' \(not in storage.cfg\)/m);
});

const pve65Zfs: HostCheckInput = { ...pve65, storageImages: "local-zfs", vmMemoryMb: { cumulus: 7424 } };

test("ZFS at its default ARC: step 0 caps it, pool disk found, no swap fallback on ZFS", () => {
  const out = run(pve65Zfs, { memMb: 15871, swaps: [["/dev/zram0", "partition", 2047, 100]], ksmCoef: 50, zfs: { arcMaxMb: 7935, arcMinMb: 495 } });
  assert.match(out, /= 14848 MB, ZFS cache up to 7935 MB; leaving -6912 MB/);
  assert.match(out, /^TODO +0\. ZFS cache \(ARC\): up to 7935 MB/m);
  assert.match(out, /echo 1073741824 > \/sys\/module\/zfs\/parameters\/zfs_arc_max/);
  assert.match(out, /options zfs zfs_arc_min=536870912 zfs_arc_max=1073741824/);
  assert.match(out, /^TODO +3\. Disk swap: 0 MB .*VM disk: sdb\./m);
  assert.match(out, /No fallback on ZFS/);
  assert.doesNotMatch(out, /lvcreate/);
  assert.match(out, /^OK +4\. VM sizes/m);
});

test("ZFS with the ARC capped: step 0 OK", () => {
  const out = run(pve65Zfs, { memMb: 15871, swaps: [["/dev/zram0", "partition", 2047, 100]], ksmCoef: 50, zfs: { arcMaxMb: 1024, arcMinMb: 512 } });
  assert.match(out, /^OK +0\. ZFS cache \(ARC\): capped at 1024 MB/m);
});

test("swap on a ZFS volume: TODO, never OK", () => {
  const out = run(pve65Zfs, {
    memMb: 15871,
    swaps: [
      ["/dev/zram0", "partition", 2047, 100],
      ["/dev/zd0", "partition", 8192, -2],
    ],
    ksmCoef: 50,
    zfs: { arcMaxMb: 1024, arcMinMb: 512 },
  });
  assert.match(out, /^TODO +3\. Disk swap: 8192 MB on zd0 \(ZFS volume\) - swap on a ZFS volume can hang/m);
  assert.match(out, /swapoff \/dev\/zd0;/);
});

test("too many VMs for the RAM, even at the smallest sizes: step 4 says so", () => {
  const three = { ...pve65, slots: [{ tier: "cumulus" }, { tier: "cumulus" }, { tier: "cumulus" }] };
  const out = run(three, { memMb: 15871, swaps: [["/dev/zram0", "partition", 2047, 100]], ksmCoef: 50 });
  assert.match(out, /^TODO +4\. VM sizes: even at the smallest sizes \(23040 MB\) the host keeps -5369 MB \(counting ~1800 MB KSM saves\)/m);
  assert.match(out, /take a slot off pve65/);
});

test("VMs on the host against the inventory: size drift, a pending size, and running gateways counted", () => {
  const host = { ...pve65, slots: [{ tier: "cumulus", vmName: "mt-65-1" }, { tier: "cumulus", vmName: "mt-65-2" }] };
  const out = run(host, {
    memMb: 15871,
    swaps: [["/dev/zram0", "partition", 2047, 100]],
    ksmCoef: 50,
    vms: [
      { id: 101, conf: "name: mt-65-1\nmemory: 7424\n", running: true },
      { id: 102, conf: "name: fh-mt-65-2\nmemory: 8192\n\n[PENDING]\nmemory: 7680\n", running: true },
      { id: 110, conf: "name: opnsense\nmemory: 2048\n", running: true },
      { id: 111, conf: "name: old-test\nmemory: 4096\n" },
    ],
  });
  assert.match(out, /^WARN +VM mt-65-1 \(101\): runs 7424 MB, but the inventory builds it at 7680 MB/m);
  assert.match(out, /qm set 101 --memory 7680/);
  assert.match(out, /^WARN +VM fh-mt-65-2 \(102\): 7680 MB is pending/m);
  assert.match(out, /^NOTE +Running VMs not in the inventory, counted: opnsense \(110\) 2048 MB\.$/m);
  assert.match(out, /= 15360 MB, other running VMs 2048 MB; leaving -1537 MB for Proxmox\.\nKSM is saving 1024 MB on top \(412 full scans, ksmtuned up [^)]*\)\.\n/);
  assert.doesNotMatch(out, /old-test/);
});

const pve25: HostCheckInput = {
  name: "pve25",
  storageImages: "ssd",
  slots: [
    { tier: "nimbus", vmName: "mt-25-n1" },
    { tier: "nimbus", vmName: "mt-25-n2" },
    { tier: "nimbus", vmName: "mt-25-n3" },
  ],
};
const nimbusConf = (n: number) => ({ id: 100 + n, conf: `name: mt-25-n${n}\nmemory: 32768\ncores: 8\n`, running: true });

test("--room: RAM, disk and threads for each tier; the largest that fits is named", () => {
  const out = run(
    pve25,
    { memMb: 128843, swaps: [], threads: 40, pool: [1800, 880], vms: [nimbusConf(1), nimbusConf(2)] },
    { room: true }
  );
  // n3 is not built yet: its 440 GB and 8 threads are taken off first → 480 GB, 16 threads free.
  assert.match(out, /^NO +stratus: RAM short .*; disk short \(880 GB needed, 480 free\); CPU ok \(16 of 16 threads free\)\./m);
  // 128 GB less 3 × 32768 leaves 30.5 GB: a 4th nimbus fits only squeezed; a cumulus fits clean.
  assert.match(out, /^YES +nimbus: RAM tight - at 31744 MB, with the small-RAM steps and ~1800 MB KSM saves the others; disk ok \(440 of 480 GB free\); CPU ok \(8 of 16 threads free\)\./m);
  assert.match(out, /^YES +cumulus: RAM ok at 8192 MB/m);
  assert.match(out, /pve25: the largest that fits is one nimbus, at 31744 MB \(vmMemoryMb\)/);
  assert.doesNotMatch(out, /zram:|KSM:/);
});

test("--room: a tight host fits only at the squeezed size, and says to run the steps", () => {
  const out = run(
    { ...pve65, slots: [{ tier: "cumulus" }] },
    { memMb: 15871, swaps: [], threads: 8, pool: [900, 220] },
    { room: true }
  );
  assert.match(out, /^YES +cumulus: RAM tight - at 7680 MB, with the small-RAM steps/m);
  assert.match(out, /the largest that fits is one cumulus, at 7680 MB \(vmMemoryMb\) with the small-RAM steps/);
});

test("--room: gateways and short threads can leave no room", () => {
  const out = run(
    { ...pve65, slots: [{ tier: "cumulus", vmName: "a" }, { tier: "cumulus", vmName: "b" }] },
    { memMb: 15871, swaps: [], threads: 8, pool: [1400, 440], vms: [{ id: 110, conf: "name: opn\nmemory: 2048\ncores: 2\n", running: true }] },
    { room: true }
  );
  // CPU over is a warning with its size, never the reason for a NO; RAM is.
  assert.match(out, /^NO +cumulus: RAM short .*CPU ok, but 14 of 8 threads \(6 over, 75%\)\./m);
  assert.match(out, /pve65: no room for another node\./);
});

test("the printed KSM command works on the shipped '# KSM_THRES_COEF=20' line", () => {
  const out = run({ ...pve65, vmMemoryMb: undefined }, { memMb: 15871, swaps: [] });
  const line = out.split("\n").find((l) => l.includes("sed -i '/KSM_THRES_COEF=/d'"))!.trim();
  const dir = tmpDir("fh-hostcheck-ksm-");
  const conf = join(dir, "ksmtuned.conf");
  writeFileSync(conf, "# KSM_MONITOR_INTERVAL=60\n# KSM_THRES_COEF=20\n# KSM_THRES_CONST=2048\n");
  execFileSync("bash", ["-c", line.split("/etc/ksmtuned.conf").join(conf)]);
  assert.equal(execFileSync("bash", ["-c", `grep -c '^KSM_THRES_COEF=50$' ${conf}; grep -c KSM_THRES_COEF ${conf}`], { encoding: "utf8" }), "1\n1\n");
});

test("slots on their own storage (pve40: ss1, ss2): their disks are the VM disks, not the host's storageImages", () => {
  const host: HostCheckInput = {
    name: "pve40",
    storageImages: "local-lvm",
    slots: [
      { tier: "cumulus", vmName: "a", storagePool: "ss1" },
      { tier: "cumulus", vmName: "b", storagePool: "ss2" },
    ],
  };
  const out = run(host, { memMb: 15871, swaps: [["/dev/dm-9", "partition", 8192, -2]], raid: true });
  assert.match(out, /^OK +3\. Disk swap: 8192 MB on sda \(RAID\), off the VM disk \(sdc sdd\)\./m);
  const room = run(host, { memMb: 64000, swaps: [], threads: 32, vms: [] }, { room: true });
  // a and b are not built: 220 GB each off ss1 (13 → -207) and ss2 (893 → 673); ss2 has the most.
  assert.match(room, /^YES +nimbus: .*disk ok \(440 of 673 GB free on ss2\)/m);
});

const gw = (busiest: number) => ({ id: 120, conf: "name: OPNsense-186\nmemory: 2048\ncores: 2\n", running: true, busiest });

test("CPU: other VMs count at their busiest 30 min; over the threads is a WARN that says by how much", () => {
  const two = { ...pve65, slots: [{ tier: "cumulus", vmName: "a" }, { tier: "cumulus", vmName: "b" }] };
  const out = run(two, { memMb: 64000, swaps: [], threads: 8, vms: [gw(0.85)] });
  assert.match(
    out,
    /^WARN +CPU: 8\.9 of 8 threads \(0\.9 over, 11\.2%\) - nodes 8 \+ other VMs at their busiest 30 min 0\.9 \(OPNsense-186 0\.9\)\./m
  );
  assert.doesNotMatch(run(two, { memMb: 64000, swaps: [], threads: 12, vms: [gw(0.85)] }), /CPU:/);
});

test("--room: threads are counted, hyperthreads or not; only one VM wider than the host is a no", () => {
  const big = run({ ...pve65, slots: [] }, { memMb: 257000, swaps: [], threads: 32, physCores: 8, pool: [2000, 0] }, { room: true });
  assert.match(big, /^YES +stratus: RAM ok .*CPU ok \(16 of 32 threads free\)\./m);
  const small = run({ ...pve65, slots: [] }, { memMb: 257000, swaps: [], threads: 8, pool: [2000, 0] }, { room: true });
  assert.match(small, /^NO +stratus: .*CPU short \(16 threads for one VM, the host has 8\)\./m);
  assert.match(small, /^YES +nimbus: .*CPU ok \(8 of 8 threads free\)\./m);
});

test("--room: pve20 — a 4th nimbus fits with KSM's credit when the gateway is 2 GB, not at 4 GB", () => {
  const pve20 = (gwMb: number): HostCheckInput => ({
    name: "pve20",
    storageImages: "ssd",
    vmMemoryMb: { nimbus: 31744 },
    slots: [
      { tier: "nimbus", vmName: "mt-186-n9" },
      { tier: "nimbus", vmName: "n10" },
      { tier: "nimbus", vmName: "n11" },
    ],
  });
  const fake = (gwMb: number): FakeHost => ({
    memMb: 128837,
    swaps: [],
    threads: 40,
    pool: [2000, 0],
    ksmMb: 0,
    vms: [{ id: 120, conf: `name: OPNsense-186\nmemory: ${gwMb}\ncores: 2\n`, running: true, busiest: 0.77 }],
  });
  const at2 = run(pve20(2048), fake(2048), { room: true });
  // 128837 − 3 × 31744 − 2048 − 31744 = −187, + 2 × 900 KSM = 1613.
  assert.match(at2, /^YES +nimbus: RAM tight - at 31744 MB, with the small-RAM steps and ~1800 MB KSM saves the others;/m);
  assert.match(at2, /Build it alone, after the other VMs have settled/);
  // 40 threads − 24 for nodes = 16 free for nodes; the gateway's 0.8 does not block.
  assert.match(at2, /^YES +nimbus: .*CPU ok \(8 of 15\.2 threads free\)\./m);
  assert.match(run(pve20(4096), fake(4096), { room: true }), /^NO +nimbus: RAM short by 635 MB even at 31744 MB/m);
});

test("--room: KSM configured minutes ago and saving little yet - says to run it again in 5 minutes", () => {
  const vm = (n: number) => ({ id: 200 + n, conf: `name: c${n}\nmemory: 7680\ncores: 4\n`, running: true });
  const host = { ...pve65, slots: [1, 2, 3].map((n) => ({ tier: "cumulus", vmName: `c${n}` })) };
  const young = run(host, { memMb: 64000, swaps: [], ksmMb: 100, vms: [vm(1), vm(2), vm(3)] }, { room: true });
  // ksmtuned.conf was just written by the fake, so its config changed "0m ago".
  assert.match(young, /KSM started 0m ago and is still merging \(saving 100 MB so far\) - run this again in 5 minutes\./);
  assert.doesNotMatch(run(host, { memMb: 64000, swaps: [], ksmMb: 4000, vms: [vm(1), vm(2), vm(3)] }, { room: true }), /run this again/);
});

test("--room nimbus on pve20: RAM short, the gateway named as the fix with its size, then the steps with 4 nimbus", () => {
  const host: HostCheckInput = {
    name: "pve20",
    storageImages: "ssd",
    vmMemoryMb: { nimbus: 32000 },
    slots: [
      { tier: "nimbus", vmName: "mt-186-n9" },
      { tier: "nimbus", vmName: "n10" },
      { tier: "nimbus", vmName: "n11" },
    ],
  };
  const out = run(
    host,
    {
      memMb: 128837,
      swaps: [["/dev/dm-9", "partition", 8192, -2]],
      threads: 32,
      pool: [2400, 440],
      ksmMb: 0,
      ksmtunedActive: false,
      vms: [
        { id: 109, conf: "name: mt-186-n9\nmemory: 32000\ncores: 8\n", running: true },
        { id: 120, conf: "name: OPNsense-186\nmemory: 4096\ncores: 2\n", running: true, busiest: 0.77 },
      ],
    },
    { room: true, roomTier: "nimbus" }
  );
  assert.match(out, /^One more nimbus, at 32000 MB:$/m);
  assert.match(out, /^NO +RAM: short by 635 MB, even at the smallest sizes, counting ~1800 MB KSM saves the others\. What would close it:/m);
  assert.match(out, /OPNsense-186 \(120\) from 4096 to 2048 MB frees 2048 MB: +qm set 120 --memory 2048/);
  assert.match(out, /- that is enough \(2048 MB of 635\)\./);
  assert.match(out, /^OK +Disk: 440 of 1080 GB free\./m);
  assert.match(out, /^WARN +CPU ok, but 32\.8 of 32 threads \(0\.8 over, 2\.5%\)\./m);

  // Then the steps for pve20 with 4 nimbus: KSM (off here) and smaller VMs.
  assert.match(out, /With it, pve20's VMs = 128000 MB, leaving -3259 MB for Proxmox\./);
  assert.match(out, /^TODO +2\. KSM: 4 VMs share identical pages/m);
  assert.match(out, /^TODO +4\. VM sizes: .*Host keeps -2235 MB, plus ~2700 MB KSM saves:\n.*vmMemoryMb \{"nimbus":31744\} on pve20/m);
  assert.doesNotMatch(out, /Room for one more node/);
  // Last, everything it takes, in order: the RAM fix, then the steps by name.
  assert.match(
    out,
    /pve20: one more nimbus fits once you:\n  1\. shrink OPNsense-186 to 2048 MB\n  2\. do the steps: 1\. zram, 2\. KSM, 4\. VM sizes\nThen add it with fh-toolkit inventory, and build it alone, after the other VMs have settled\.\n$/
  );
});

test("--room cumulus with room to spare: fits, nothing to do first", () => {
  const out = run(pve65, { memMb: 64000, swaps: [], threads: 32, pool: [2000, 0] }, { room: true, roomTier: "cumulus" });
  assert.match(out, /pve65: one more cumulus fits\.\nThen add it with fh-toolkit inventory/);
});

test("--room nimbus with no fix big enough: says it does not fit, and why", () => {
  const out = run({ ...pve65, slots: [{ tier: "cumulus", vmName: "a" }] }, { memMb: 15871, swaps: [], threads: 16, pool: [2000, 0] }, { room: true, roomTier: "nimbus" });
  assert.match(out, /pve65: one more nimbus does not fit: RAM is short by \d+ MB, more than shrinking other VMs frees\.\n$/);
});

test("ksmtuned stopped is a TODO even with the right coefficient", () => {
  const out = run(pve65, { memMb: 15871, swaps: [["/dev/zram0", "partition", 2047, 100]], ksmCoef: 50, ksmtunedActive: false });
  assert.match(out, /^TODO +2\. KSM/m);
});

test("a host name with a quote cannot break out of the script", () => {
  const script = hostCheckScript({ ...pve65, name: "a'b; rm -rf /" }, "t");
  assert.match(script, /^HOST='a'\\''b; rm -rf \/'$/m);
});

test("the CLI: picks the host from the inventory, names the choices when it cannot", () => {
  const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));
  const dir = tmpDir("fh-hostcheck-cli-");
  writeFileSync(join(dir, "config.env"), "PROVIDER_SLUG=hc-test\n");
  mkdirSync(join(dir, "data"));
  const inv = (hosts: HostCheckInput[]) =>
    writeFileSync(
      join(dir, "data/inventory.json"),
      JSON.stringify(hosts.map((h) => ({ ...h, storageIso: "local", slots: h.slots.map((s, i) => ({ ...s, vmName: `x-${h.name}-${i}` })) })))
    );
  const cli = (...args: string[]) =>
    spawnSync("npx", ["tsx", CLI, "host-check", "--dir", dir, ...args], { encoding: "utf8" });

  inv([pve50]);
  const one = cli();
  assert.equal(one.status, 0, one.stderr);
  assert.match(one.stdout, /^#!\/bin\/bash\n# fh-toolkit host-check for pve50/);
  assert.match(one.stdout, /^VM_LIST='nimbus 31744'$/m);

  inv([pve50, pve65]);
  const which = cli();
  assert.notEqual(which.status, 0);
  assert.match(which.stdout + which.stderr, /which host\? .*pve50, pve65/);
  assert.match(cli("pve65").stdout, /^NVM=2$/m);
  assert.match(cli("pve65", "--room").stdout, /^ROOM=1$/m);
  const tier = cli("pve65", "--room", "nimbus").stdout;
  assert.match(tier, /^PLAN_TIER='nimbus'$/m);
  assert.match(tier, /^# fh-toolkit host-check for pve65/m);
  assert.match(cli("pve99").stdout + cli("pve99").stderr, /pve99 is not in/);
});
