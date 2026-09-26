/**
 * VM RAM for a host that cannot fit a tier's default size.
 *
 * arcane-mage builds each tier at a fixed size (cumulus 8192, nimbus 32768, stratus 65536 MB).
 * FluxOS only checks the RAM the guest REPORTS, and the guest reports about 0.2–1.2 GB less
 * than it is given, so a smaller VM still passes. On a host whose RAM is about what its nodes
 * need (2 cumulus on 16 GB, 1 nimbus on 32 GB) the default overcommits it, the host swaps, and
 * the ddwrite benchmark fails. `vmMemoryMb` on the inventory host overrides the size.
 *
 * Measured (2026-09-25/26): cumulus 7680 → 7.3 (gate 7; 7424 → 7.0, zero margin, 7168 fails),
 * nimbus 31744 → 30.0 (gate 30; 31232 fails), stratus 64000 → 61.3 (gate not yet pinned down).
 */

export const TIER_DEFAULT_MB: Record<string, number> = { cumulus: 8192, nimbus: 32768, stratus: 65536 };
/** The smallest size seen to pass each tier's RAM gate with some margin. */
export const TIER_SQUEEZED_MB: Record<string, number> = { cumulus: 7680, nimbus: 31744, stratus: 64000 };
/** What the host itself should keep (PVE daemons, kernel slab, corosync, telegraf). */
export const HOST_RESERVE_MB = 2048;
/** What Proxmox itself was measured using with its VMs stopped (pve50, 09-26: ~1.4 GB). */
export const HOST_OVERHEAD_MB = 1536;
/** Where the operator docs explain KSM, zram and swap for these hosts. */
export const SMALL_RAM_DOCS = 'operator-onboarding.md Step 0.6 "Small-RAM hosts"';

export interface VmMemoryPlan {
  /** Only the tiers this host carries, at their squeezed size. */
  vmMemoryMb: Record<string, number>;
  /** RAM left for the host at the default sizes, and at the squeezed sizes. */
  freeAtDefault: number;
  freeSqueezed: number;
}

/**
 * The override to suggest, or undefined when the defaults already leave the host its reserve.
 * `tiers` is one entry per slot (e.g. ["cumulus", "cumulus"]).
 */
export function planVmMemory(hostMb: number, tiers: string[]): VmMemoryPlan | undefined {
  const known = tiers.filter((t) => TIER_DEFAULT_MB[t] !== undefined);
  if (known.length === 0) return undefined;
  const sum = (m: Record<string, number>) => known.reduce((a, t) => a + (m[t] ?? 0), 0);
  const freeAtDefault = hostMb - sum(TIER_DEFAULT_MB);
  if (freeAtDefault >= HOST_RESERVE_MB) return undefined;
  const vmMemoryMb: Record<string, number> = {};
  for (const t of new Set(known)) vmMemoryMb[t] = TIER_SQUEEZED_MB[t]!;
  return { vmMemoryMb, freeAtDefault, freeSqueezed: hostMb - sum(TIER_SQUEEZED_MB) };
}

export interface VmMemoryAdvice {
  lines: string[];
  question: string;
  /** What Enter answers. No when the build is expected to be killed as it stands. */
  defaultYes: boolean;
}

/**
 * What `init` says about a plan. Three cases, from what happened on real hosts:
 *
 *   - fits: the squeezed sizes leave the host its reserve.
 *   - tight, 2+ VMs (pve65: 2 × cumulus on 16 GB): works once KSM and zram are on — the VMs
 *     share identical pages, KSM saved ~1–3 GB there.
 *   - tight, ONE VM (pve50: 1 × nimbus on 32 GB): KSM has nothing to merge, zram alone was
 *     not enough, and the first boot was OOM-killed 6 min in while it downloaded the chain.
 *     4 GB of swap on the SSD got it through (low point 58 MB free). Default No.
 */
export function vmMemoryAdvice(host: string, hostMb: number, plan: VmMemoryPlan, vmCount: number): VmMemoryAdvice {
  const sizes = Object.entries(plan.vmMemoryMb)
    .map(([tier, mb]) => `${tier} ${mb} MB`)
    .join(", ");
  const lines = [
    `${host} has ${hostMb} MB of RAM. At the default VM sizes its nodes leave the host ` +
      `${plan.freeAtDefault} MB — it would swap, and swapping fails the Flux disk benchmark.`,
    `Smaller VMs still pass the RAM check: ${sizes} (host keeps ${plan.freeSqueezed} MB).`,
  ];
  if (plan.freeSqueezed >= HOST_RESERVE_MB) {
    return { lines, question: `Build ${host}'s VMs at ${sizes}? (Y/n)`, defaultYes: true };
  }
  const below = `${plan.freeSqueezed} MB is below the ~${HOST_OVERHEAD_MB} MB Proxmox itself needs`;
  if (vmCount >= 2) {
    lines.push(
      `${below}. ${vmCount} VMs share identical memory pages through KSM: turn on KSM and zram ` +
        `first (${SMALL_RAM_DOCS}), or expect disk-benchmark failures.`
    );
    return { lines, question: `Build ${host}'s VMs at ${sizes}? (Y/n)`, defaultYes: true };
  }
  lines.push(
    `⚠ ${below}, and one VM gets no help from KSM. Its first boot peaks while it downloads the ` +
      `chain and is killed without swap. Add at least 4 GB of swap on the SSD first (${SMALL_RAM_DOCS}).`
  );
  return { lines, question: `Build ${host}'s VM at ${sizes} anyway? (y/N)`, defaultYes: false };
}
