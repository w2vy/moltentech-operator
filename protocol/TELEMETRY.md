# Coalition telemetry → hub: per-node samples and events

Design record for plan `amiable-delegating-diffie` Phase 7 (§8.2, §8.6, §9.6, §9.7). This is
the one Phase 7 artifact that crosses the hub/Coalition boundary; everything else in the phase
is a consumer or a producer of what is written here.

## What exists today, and the gap

| Path | Direction | Cadence | Carries |
|---|---|---|---|
| `GET /stats` on the Coalition, pulled by the hub `[pull-stats]` loop | Coalition → hub | 15 min pull / 5 min collect | `StatsSnapshot.tiers[]` — per-tier **aggregates** (mean EPS, mean ddwrite, uptime %) |
| `POST /api/agent/lifecycle` | Coalition → hub | 2 min | `LifecycleNodeStatus[]` — per node: `benchmarkPassed`, `collateralConfs`, `onDeterministicList` |
| `POST /api/agent/health` | agent → hub | agent cadence | per VM: Proxmox `running`/`status` |
| hub `[collect]` (provisioner) | hub → every node's `ip:apiPort` | 30 min (+5 min pre-active) | the full `getbenchmarks` payload → `SlotBenchmark` + InfluxDB `flux_benchmark` |

The Coalition's `stats.ts` already polls every node's `getbenchmarks` externally and then
**throws the per-node samples away** after averaging them. The hub polls the same endpoints
again from w2vy to fill `SlotBenchmark` and Influx. At 40 nodes that is a harmless
duplicate; at thousands it is the §8.2 wall (one process, one WAN, every node, every half
hour), and it is a path a small supporter cannot opt out of (§8.6).

Separately, the hub learns that a node has expired or stopped passing only by scanning: the
`[delegate-start]` loop re-derives every active node's det-list state every 5 minutes. The
Coalition already observes the same transition two minutes after it happens and says nothing.

## Decision 1 — `SCHEMA_VERSION` stays 2

The plan said "bump to 3". The protocol's own rule (see the `failureClass` and
`onDeterministicList` comments in `messages.ts`) is that the `Envelope` pins `schemaVersion`
with `z.literal()`, so a bump is a **flag day** that 400s every deployed agent and Coalition
the moment the hub redeploys. Both additions here are optional fields on the wire, Zod strips
unknown keys, and every mixed-version pairing degrades to today's behaviour. No bump.

## Decision 2 — `StatsSnapshot.nodes[]` (optional, additive)

```ts
export const NodeSample = z.object({
  vmName: z.string().min(1),
  /** The Coalition reached the node's benchmark API this pass. */
  reachable: z.boolean(),
  /** Raw `getbenchmarks` fields, exactly as the hub's collect reads them. Absent when unreachable. */
  status: z.string().min(1).optional(),        // data.status — the tier-pass string
  epsMultithread: z.number().optional(),       // data.eps_multithread ?? data.eps
  cores: z.number().int().positive().optional(),
  ddwrite: z.number().optional(),              // MB/s
  benchmarkTime: z.number().int().optional(),  // data.time — unix seconds of the node's last run
  downloadSpeed: z.number().optional(),        // Mbit/s
  uploadSpeed: z.number().optional(),
  ping: z.number().optional(),                 // ms
});

StatsSnapshot = Envelope.extend({
  …existing…,
  /** Per-node samples behind `tiers[]`. Optional: a pre-Phase-7 Coalition omits it. */
  nodes: z.array(NodeSample).optional(),
});
```

Rules:
- **Raw, not derived.** `epsPerCore` and `thresholdPass` are hub derivations (tier thresholds
  live in the hub); the Coalition ships what the node said. Same relay-raw-facts pattern as
  `LifecycleNodeStatus` and `PaymentEvent`.
- **`reachable` is operator-asserted** and feeds a public number
  ([[feedback_public_uptime_is_mean_reachable_over_all_polls]]). The hub therefore keeps an
  independent **audit sample**: each `[collect]` pass still polls a rotating ~5 % (min 1) of
  agent-managed nodes itself and compares. Divergence (Coalition says reachable, hub audit
  says not, or vice-versa, on the same pass) raises an `alert` — it is signal about the
  operator, not noise to smooth.
- **Freshness gate.** The hub skips its own poll of a node only when the provider's last
  pulled snapshot carried `nodes[]` **and** `collectedAt` is younger than 2 × the pull
  interval. Anything older, or a snapshot without `nodes[]`, and the hub polls that
  provider's nodes exactly as it does today. This is the mixed-version fallback and the
  "Coalition down" fallback in one rule. The skip covers **active** slots only: bring-up
  (`bootstrap`/`benchmark`/`awaiting_start`) stays hub-polled, because that pass needs a
  `benchmarkTime` the hub read itself and the node's `data.error` text, which a
  `NodeSample` does not carry (hub #311, `lib/coalition-samples.ts`).
- Hub side: `[pull-stats]` (web, `lib/provider-stats.ts`) upserts the samples into
  `SlotBenchmark` with a new `source = 'coalition'` + `sampledAt`; the provisioner's
  `[collect]` stays the **only Influx writer** — for a slot with a fresh Coalition sample it
  writes the Influx line from the `SlotBenchmark` row instead of fetching. The web app still
  never gets an Influx client.

## Decision 3 — `POST /api/agent/events` (Coalition → hub, signed like `/lifecycle`)

```ts
export const AgentEventKind = z.enum([
  "node_expired",      // onDeterministicList true → false between two lifecycle passes
  "node_recovered",    // false → true, or unreachable → reachable
  "benchmark_failed",  // benchmarkPassed true → false
  "node_unreachable",  // reachable true → false between two stats passes
]);

export const AgentEvent = z.object({
  kind: AgentEventKind,
  vmName: z.string().min(1),
  observedAt: Timestamp,
  /** One line of operator-side context; never parsed by the hub. */
  detail: z.string().max(200).optional(),
});

export const EventReport = Envelope.extend({
  providerSlug: ProviderSlug,
  reportedAt: Timestamp,
  events: z.array(AgentEvent).min(1).max(200),
});
```

Rules:
- **Events are hints, never facts.** The hub's only response to an event is to **schedule its
  own verification** — a det-list lookup / benchmark read on its next tick — and to record the
  verdict. Nothing broadcasts, demotes, or emails on an event alone. The `[delegate-start]`
  guards (`lib/delegate-start.ts`) are untouched; an event can only make a node be looked at
  sooner, never skip a guard.
- **Edge-triggered, Coalition-side.** The Coalition emits when a node's measured state
  *changes* between two of its own passes; it does not re-send a standing condition. It keeps
  the last-seen state in memory only (the Coalition is stateless across restarts — the first
  pass after a restart establishes a baseline and emits nothing).
- **Delivery is best-effort.** A failed POST is logged and dropped; the hub's periodic sweep
  is the safety net and remains authoritative. No queue, no retry storm.
- Hub side: `AgentEvent` table `(id, providerId, vmName, kind, observedAt, receivedAt,
  verifiedAt?, verdict confirmed|refuted|stale, detail?)`; one row per (provider, vmName,
  kind, observedAt) — duplicates are 200 + ignored. `verdict = refuted` (the hub looked and
  disagrees) is an alert for the same reason as an audit divergence. Surfaced on the admin
  overview and, per [[feedback_nodes_belong_to_the_operator_not_admin]], on the operator's
  fleet page.
- What this buys later, not now: `[delegate-start]` can drop from "scan every active node
  every tick" to "scan `awaiting_start` + verified events + an hourly full sweep". At today's
  size the one-fetch det-list makes the full scan cheap, so that switch is **not** part of
  Phase 7; the schema is defined now so the hub side is a pure consumer when it is.

## Deploy order (hub and agents move together — [[feedback_mt_agent_image_tag_convention]])

1. **Protocol + Coalition** (this repo, one PR train): schema + tests; Coalition keeps its
   per-node samples and emits events. Publishing the Coalition image is safe against an old
   hub: `nodes[]` is stripped as an unknown key, `/api/agent/events` answers 404 and the
   Coalition logs one line per failed report.
2. **Hub** (`moltentech`, separate PR): submodule pin bump; `SlotBenchmark.source/sampledAt`
   migration; `AgentEvent` migration; `[pull-stats]` ingests `nodes[]`; `[collect]` skips
   fresh Coalition-covered slots + audit sample + divergence alert; `/api/agent/events` route;
   admin/operator surfaces.
3. Promote the Coalition to `:latest` only after the hub is on prod.

## Out of scope

- The agent (`fh-agent`) does not change. Health stays agent → hub.
- Operators holding their own delegate key; `StartAttempt.requestedBy = coalition_event`.
- Any hub decision made *from* an event rather than from the hub's own verification.
