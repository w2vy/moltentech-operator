import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hostCheckScript, plannedVms, type HostCheckInput } from "./host-check";
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
  vms?: { id: number; conf: string; running?: boolean }[];
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

zfspool: local-zfs
\tpool rpool/data
\tcontent images,rootdir
`;

function run(host: HostCheckInput, fake: FakeHost): string {
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
  put("sys/kernel/mm/ksm/pages_sharing", "262144\n");
  put("sys/block/sda/queue/rotational", "1\n");
  put("sys/block/sdb/queue/rotational", "0\n");
  if (fake.zfs) {
    put("proc/spl/kstat/zfs/arcstats", `c_min 4 ${fake.zfs.arcMinMb * 1048576}\nc_max 4 ${fake.zfs.arcMaxMb * 1048576}\n`);
  }
  for (const vm of fake.vms ?? []) {
    put(`etc/pve/qemu-server/${vm.id}.conf`, vm.conf);
    if (vm.running) put(`var/run/qemu-server/${vm.id}.pid`, "1\n");
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
  /dev/nvme0n1) printf 'nvme0n1 disk\\n' ;;
  /dev/sdb3) printf 'sdb3 part\\nsdb disk\\n' ;;
  /dev/zd0) printf 'zd0 disk\\n' ;;
esac`
  );
  stub("pvs", `case "$*" in *vg_name=ssd*) echo "  /dev/sdb" ;; *vg_name=pve*) echo "  /dev/sda3" ;; esac`);
  stub("lvs", `case "$*" in *-S*) printf '  440.00\\n' ;; *) printf '  445.13\\n' ;; esac`);
  stub("systemctl", `exit ${fake.ksmtunedActive === false ? 3 : 0}`);
  stub("findmnt", "exit 1");
  stub(
    "zpool",
    fake.zfs
      ? `case "$*" in *-vHP*) printf 'rpool\\t464G\\n\\t/dev/sdb3\\t464G\\n' ;; *) echo rpool ;; esac`
      : "exit 1"
  );
  return execFileSync("bash", ["-c", hostCheckScript(host, "0.0.0-test")], {
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
  assert.doesNotMatch(out, /zram|KSM/);
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
  assert.match(out, /pve65: nothing left to do/);
});

test("fresh 2-cumulus box at default sizes: zram, KSM and smaller VMs to do", () => {
  const out = run({ ...pve65, vmMemoryMb: undefined }, { memMb: 15871, swaps: [["/dev/dm-9", "partition", 8192, -2]] });
  assert.match(out, /^TODO +1\. zram: none/m);
  assert.match(out, /systemctl stop zramswap; echo 1 > \/sys\/block\/zram0\/reset/);
  assert.match(out, /printf 'ALGO=zstd\\nSIZE=2048\\nPRIORITY=100\\n'/);
  assert.match(out, /^TODO +2\. KSM: 2 VMs .*KSM_THRES_COEF=20, want 50/m);
  assert.match(out, /sed -i 's\/\^#\\\?KSM_THRES_COEF=/);
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
  assert.match(out, /^TODO +4\. VM sizes: even at the smallest sizes \(23040 MB\) the host keeps -7169 MB/m);
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
  assert.match(out, /= 15360 MB, other running VMs 2048 MB; leaving -1537 MB for Proxmox\.\n/);
  assert.doesNotMatch(out, /old-test/);
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
  assert.match(cli("pve99").stdout + cli("pve99").stderr, /pve99 is not in/);
});
