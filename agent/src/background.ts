/**
 * Fire-and-forget helper for agent work that must never gate the job poll loop.
 *
 * The agent's startup used to `await` every priming task before entering
 * `pollOnce()`, including `refreshIsoOnce()` — which spends up to
 * `TIMEOUT.refreshIso` (20 min) PER declared host and talks to Proxmox. On a
 * degraded hypervisor the agent therefore sat in startup claiming **no jobs at
 * all**, while inventory/listing had already been asserted so `agentLastSeenAt`
 * stayed fresh and the hub saw a perfectly healthy agent doing nothing (#90).
 *
 * Detaching is the fix: priming still runs, it just cannot hold the loop. Errors
 * are logged rather than rethrown, because an unhandled rejection from a detached
 * promise would take the whole process down — the opposite of what a best-effort
 * background task should do.
 *
 * Lives in its own module (not index.ts) so tests can import it without
 * triggering index.ts's unconditional `main()` call — same reason as iso-refresh.ts.
 */
export function runDetached(label: string, fn: () => Promise<unknown>): void {
  let started: Promise<unknown>;
  try {
    started = Promise.resolve(fn());
  } catch (err) {
    // A synchronous throw from fn() never becomes a promise, so it would escape
    // the .catch() below and crash the process on an unhandled exception.
    console.error(`[agent] ${label} error:`, (err as Error).message);
    return;
  }
  void started.catch((err) => {
    console.error(`[agent] ${label} error:`, (err as Error)?.message ?? String(err));
  });
}
