import { execFile } from "node:child_process";
import type { ExecFileException } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job, FailureClass } from "@moltentech/protocol";
import type { AgentConfig } from "./config";
import { checkOwnerAuth } from "./owner-auth";

export type ExecResult = { ok: boolean; message?: string; vmId?: number; failureClass?: FailureClass };
export type Executor = (job: Job, cfg: AgentConfig) => Promise<ExecResult>;

/**
 * Dry-run executor: acknowledges the job without touching Proxmox. Used in tests
 * and whenever the local Proxmox isn't configured, so the agent↔MT control plane
 * can run (and be verified) independently of a live hypervisor.
 */
export const dryRunExecutor: Executor = async (job) => ({
  ok: true,
  message: `[dry-run] ${job.action} ${job.slot.vmName} on ${job.slot.nodeName}`,
});

/**
 * Emit a value as a YAML double-quoted scalar. A JSON string literal is a valid YAML
 * 1.x double-quoted scalar (`\n`, `\"`, `\\`, `\uXXXX` all decode identically under
 * PyYAML `safe_load`), so the parsed value is byte-identical to the input while newlines
 * / quotes / indentation can no longer break out and inject YAML structure. Numeric and
 * boolean fields are emitted bare (they must keep their YAML type and aren't injectable).
 */
function yamlStr(v: string | number): string {
  return JSON.stringify(String(v));
}

/**
 * Build the arcane-mage provision YAML from a Job + the agent's LOCAL host config.
 * Mirrors apps/web/src/lib/yaml-generator.ts, but every hypervisor/host value comes
 * from the operator's own config (MT never sends Proxmox creds or storage IDs) and
 * the identity key arrives already decrypted in the Job. Pure + unit-testable.
 *
 * All string values go through `yamlStr()` — customer-controlled fields (flux_id,
 * identity_key, tx_id, discord/telegram) MUST NOT be interpolated raw, or a crafted
 * value with newlines could inject sibling YAML keys (e.g. override `hypervisor`).
 */
export function buildProvisionYaml(job: Job, cfg: AgentConfig): string {
  const { slot, nodeConfig } = job;
  if (!nodeConfig) throw new Error(`Job ${job.jobId} has no nodeConfig (required to provision)`);
  const h = cfg.host;
  const L: string[] = [];

  L.push("nodes:");
  L.push("  - hypervisor:");
  L.push(`      node: ${yamlStr(slot.nodeName)}`);
  L.push(`      vm_name: ${yamlStr(slot.vmName)}`);
  L.push(`      node_tier: ${yamlStr(slot.tier)}`);
  L.push(`      network: ${yamlStr(slot.network ?? h.network)}`);
  L.push(`      iso_name: ${yamlStr(h.arcaneIso)}`);
  L.push(`      storage_images: ${yamlStr(slot.storagePool ?? h.storageImages)}`);
  L.push(`      storage_iso: ${yamlStr(h.storageIso)}`);
  L.push(`      storage_import: ${yamlStr(h.storageImport)}`);
  L.push("      start_on_creation: true");
  if (slot.vmId != null) L.push(`      vm_id: ${slot.vmId}`);
  if (slot.startupConfig) L.push(`      startup_config: ${yamlStr(slot.startupConfig)}`);
  if (slot.diskLimit != null) L.push(`      disk_limit: ${slot.diskLimit}`);
  if (slot.cpuLimit != null) L.push(`      cpu_limit: ${slot.cpuLimit}`);
  if (slot.networkLimit != null) L.push(`      network_limit: ${slot.networkLimit}`);

  L.push("    system:");
  L.push(`      hostname: ${yamlStr(slot.vmName)}`);
  L.push(`      hashed_console: ${yamlStr(h.consoleHash)}`);
  if (h.sshPubkey) L.push(`      ssh_pubkey: ${yamlStr(h.sshPubkey)}`);

  L.push("    network:");
  L.push("      ip_allocation: static");
  L.push("      address_config:");
  L.push(`        address: ${yamlStr(slot.lanIp)}`);
  L.push(`        gateway: ${yamlStr(slot.gateway)}`);
  L.push("        dns:");
  L.push(`          - ${yamlStr(slot.dns1)}`);
  L.push(`          - ${yamlStr(slot.dns2)}`);
  if (slot.vlan != null) L.push(`      vlan: ${slot.vlan}`);
  if (slot.rateLimit != null) L.push(`      rate_limit: ${slot.rateLimit}`);

  L.push("    fluxnode:");
  L.push("      identity:");
  L.push(`        flux_id: ${yamlStr(nodeConfig.fluxId)}`);
  L.push(`        identity_key: ${yamlStr(nodeConfig.fluxIdentityKey)}`);
  L.push(`        output_id: ${nodeConfig.collateralVout}`);
  L.push(`        tx_id: ${yamlStr(nodeConfig.collateralTxid)}`);
  L.push("      network:");
  L.push(`        upnp_port: ${slot.apiPort}`);
  L.push(`        router_address: ${yamlStr(slot.gateway)}`);

  const hasDiscord = nodeConfig.discordUserId && nodeConfig.discordWebhook;
  const hasTelegram = nodeConfig.telegramBotToken && nodeConfig.telegramChatId;
  if (hasDiscord || hasTelegram) {
    L.push("      notifications:");
    if (hasDiscord) {
      L.push("        discord:");
      L.push(`          user_id: ${yamlStr(nodeConfig.discordUserId!)}`);
      L.push(`          webhook_url: ${yamlStr(nodeConfig.discordWebhook!)}`);
    }
    if (hasTelegram) {
      L.push("        telegram:");
      L.push(`          bot_token: ${yamlStr(nodeConfig.telegramBotToken!)}`);
      L.push(`          chat_id: ${yamlStr(nodeConfig.telegramChatId!)}`);
    }
  }

  return L.join("\n") + "\n";
}

/** One entry of arcane-mage's per-stage provisioning trace. */
type AmStep = { ok?: boolean; message?: string };

export type AmResult = {
  error: ExecFileException | null;
  stdout: string;
  stderr: string;
  json: {
    ok?: boolean;
    error?: string;
    vm_id?: number;
    changed?: boolean;
    iso?: string;
    previous?: string;
    build?: string;
    severity?: string;
    release?: string;
    /**
     * Per-host provisioning trace. arcane-mage has always emitted this under
     * `--json` (`__main__.py` builds it from the provisioner's step callback),
     * but the agent never declared it and so silently dropped it — which is why
     * a failure only ever reported the hardcoded generic `error: "Provisioning
     * failed"` plus whatever noise was on stderr.
     */
    nodes?: Array<{
      hostname?: string;
      ok?: boolean;
      /** May arrive as a STRING on the provision path — see `coerceVmId`. */
      vm_id?: number | string;
      steps?: AmStep[];
    }>;
  } | null;
};

/** Invoke the arcane-mage CLI with the LOCAL Proxmox creds as subcommand options. */
/**
 * Replace every occurrence of the Proxmox token secret with a placeholder.
 *
 * Found live on staging 2026-08-09: a failed provision stored
 * `Command failed: arcane-mage provision --url … --token mt-agent@pve!agent=<secret> …`
 * in `ProvisionLog.output`, which renders verbatim in `/admin/logs`. `execFile` builds
 * its error message from the full argv, so ANY non-zero exit leaked the credential into
 * MT's database — on prod as well as staging, for every operator.
 *
 * Substring replacement rather than a pattern: the secret is known exactly here, and a
 * `--token \S+` regex would miss it wherever arcane-mage echoes the value on its own
 * (tracebacks, request logs) without the flag in front of it.
 */
export function redactToken(text: string, secret?: string): string {
  // A one- or two-character "secret" would turn the whole text into placeholders; only
  // redact something long enough to actually be a credential.
  if (!secret || secret.length < 8) return text;
  return text.split(secret).join("<redacted>");
}

function runArcaneMage(args: string[], cfg: AgentConfig, timeoutMs: number): Promise<AmResult> {
  const token = `${cfg.proxmox.tokenId}=${cfg.proxmox.tokenSecret}`;
  const [subcommand, ...rest] = args;
  const fullArgs = [subcommand!, "--url", cfg.proxmox.url!, "--token", token, ...rest];
  return new Promise((resolve) => {
    execFile("arcane-mage", fullArgs, { timeout: timeoutMs }, (error, stdout, stderr) => {
      // Scrub HERE, at the single choke point, rather than at each of the ~6 call sites
      // that build a message — every one of them (success and failure, message, stdout,
      // stderr) is downstream of this, so one redaction covers all of them and a future
      // seventh call site inherits it for free.
      const scrub = (s: string) => redactToken(s, cfg.proxmox.tokenSecret);
      let scrubbed: ExecFileException | null = null;
      if (error) {
        // Rebuild rather than mutate: `error.message` is what carries the argv, but
        // `code`/`killed`/`signal` are what classifyAmFailure reads, so they must survive
        // exactly (killed/signal ⇒ "unknown", ENOENT ⇒ "permanent").
        scrubbed = Object.assign(new Error(scrub(error.message)), error, {
          message: scrub(error.message),
        }) as ExecFileException;
      }
      const out = scrub(stdout);
      resolve({ error: scrubbed, stdout: out, stderr: scrub(stderr), json: parseAmJson(out) });
    });
  });
}

const TIMEOUT = { provision: 300_000, delete: 120_000, reprovision: 420_000, refreshIso: 1_200_000 };

/**
 * Recover arcane-mage's `--json` payload from stdout.
 *
 * A bare `JSON.parse(stdout)` is too brittle: any stray line written to stdout by
 * a Python dependency (a warning, a progress line) drops the ENTIRE structured
 * payload and silently degrades us to stderr-only — exactly the blindness this
 * phase exists to remove. So fall back to scanning for the last line that parses
 * as a JSON object.
 */
export function parseAmJson(stdout: string): AmResult["json"] {
  const whole = stdout.trim();
  if (!whole) return null;
  try {
    return JSON.parse(whole);
  } catch {
    /* fall through to the line scan */
  }
  const lines = whole.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {
      /* not this line */
    }
  }
  return null;
}

/** Messages of the failed steps in arcane-mage's per-host trace, outermost first. */
export function failedSteps(r: AmResult): string[] {
  const out: string[] = [];
  for (const node of r.json?.nodes ?? []) {
    for (const step of node.steps ?? []) {
      if (step.ok === false && step.message?.trim()) out.push(step.message.trim());
    }
  }
  return out;
}

/**
 * Failures that are safe AND worth retrying. Every one of these is raised by
 * arcane-mage's PRE-FLIGHT checks — before anything on the hypervisor has been
 * mutated — so a retry cannot leave a half-built VM behind, and the condition
 * (quorum, node reachability, API availability) is exactly the kind that clears
 * on its own. MT-0010 was this class: a cluster-proxy wobble that also dropped
 * the agent's health pass from 22 nodes to 17 in the same tick.
 */
const TRANSIENT = [
  /lost quorum/i,
  /is offline in cluster/i,
  /Unable to get Proxmox api version/i,
  /Unable to get Proxmox storage state/i,
  /Unable to list VMs/i,
  /**
   * Teardown's equivalent of the API-unreachable cases above. `deprovision` against
   * an unreachable Proxmox dies during node discovery with NO `nodes[]` trace, so it
   * matched nothing and classified `unknown` — meaning a teardown could never
   * auto-retry a fault a provision retries happily. Discovery is strictly read-only,
   * so nothing can be half-mutated when it fails; this is caught by `json.error`
   * rather than a failed step, which the haystack already covers.
   */
  /Unable to discover hypervisor nodes/i,
];

/** Failures where a retry provably cannot help. */
const PERMANENT = [/already exists on node/i, /Unable to generate vm config/i];

/**
 * Classify a failed arcane-mage run for MT's retry queue.
 *
 * Deliberately conservative: anything not positively recognised is `unknown`, and
 * MT never auto-retries `unknown`. That matters because most of arcane-mage's
 * mutating steps collapse their real cause to a bare bool before the CLI sees it
 * — "Unable to create VM on hypervisor" could be a transient 595 or a full disk,
 * and the difference is not recoverable here. Those land in the admin queue with
 * the failed stage named, which is still a large improvement on a generic string.
 *
 * A timeout is `unknown` for the same reason: the VM may be half-created, so a
 * blind retry is not obviously safe.
 */
export function classifyAmFailure(r: AmResult): FailureClass {
  // arcane-mage missing entirely is a deployment fault, not a hypervisor blip.
  if (r.error?.code === "ENOENT") return "permanent";
  if (r.error?.killed || r.error?.signal) return "unknown";

  const haystack = [...failedSteps(r), r.json?.error ?? ""].join("\n");
  if (PERMANENT.some((re) => re.test(haystack))) return "permanent";
  if (TRANSIENT.some((re) => re.test(haystack))) return "transient";
  return "unknown";
}

/**
 * Build the richest failure message for a failed arcane-mage run. The structured
 * `json.error` is usually a one-liner; the real diagnostic (Python traceback,
 * Proxmox API detail) lands on stderr. Combine both (plus any spawn/timeout error)
 * so ProvisionLog.output carries enough to debug — the old code dropped stderr
 * whenever json.error was present, blind-siding Phase 0 debugging.
 *
 * The failed STEP messages lead, because they name which stage actually broke.
 * `json.error` on a provision failure is the hardcoded string "Provisioning
 * failed", which says nothing; stderr is where the pydantic noise lives and is
 * therefore last, so a verbose warning stream can no longer push the real signal
 * past the 4000-char cap.
 */
export function amFailure(r: AmResult): string {
  const parts: string[] = [];
  const steps = failedSteps(r);
  if (steps.length) parts.push(steps.map((s) => `[step] ${s}`).join("\n"));
  for (const s of [r.json?.error, r.error?.message, r.stderr]) {
    const t = s?.trim();
    if (t && !parts.includes(t)) parts.push(t);
  }
  return (parts.join("\n\n") || r.stdout.trim() || "arcane-mage failed with no output").slice(0, 4000);
}

async function deprovision(job: Job, cfg: AgentConfig): Promise<ExecResult> {
  const r = await runArcaneMage(
    ["deprovision", "--json", "--force", "--vm-name", job.slot.vmName, "--node", job.slot.nodeName],
    cfg,
    TIMEOUT.delete
  );
  const ok = r.json?.ok === true || !!r.json?.error?.includes("not found");
  return {
    ok,
    message: ok ? (r.stdout + "\n" + r.stderr).trim().slice(0, 4000) : amFailure(r),
    failureClass: ok ? undefined : classifyAmFailure(r),
  };
}

/**
 * Coerce arcane-mage's `vm_id` to a number, accepting the string form.
 *
 * Proxmox's `GET /cluster/nextid` returns the id as a JSON **string** (`"105"`), and
 * nothing on arcane-mage's provision path coerces it: `VmConfig` is a stdlib
 * `@dataclass` so `vmid: int` is an unenforced annotation, and pydantic dataclasses
 * do not validate on assignment, so the string reaches `Hypervisor.vm_id` and is
 * emitted as `"vm_id": "105"`. The previous `typeof === "number"` guard therefore
 * dropped EVERY provision vmid — `Slot.vmId` was NULL on every agent-path success
 * since the path first existed (#92).
 *
 * The deprovision path is unaffected (it reads ints straight from the VM listing),
 * which is exactly why the bug hid for so long. Accepting both shapes keeps this
 * correct whichever way arcane-mage is fixed upstream.
 */
export function coerceVmId(v: unknown): number | undefined {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined;
}

async function provision(job: Job, cfg: AgentConfig): Promise<ExecResult> {
  const yamlPath = join(tmpdir(), `mt-${job.jobId}-${randomUUID()}.yaml`);
  writeFileSync(yamlPath, buildProvisionYaml(job, cfg), { mode: 0o600 });
  try {
    const r = await runArcaneMage(["provision", "--json", "-c", yamlPath], cfg, TIMEOUT.provision);
    const ok = r.json?.ok === true;
    return {
      ok,
      message: ok ? undefined : amFailure(r),
      vmId: coerceVmId(r.json?.vm_id),
      failureClass: ok ? undefined : classifyAmFailure(r),
    };
  } finally {
    // Scrub the YAML — it briefly held the customer's Flux identity key.
    try {
      unlinkSync(yamlPath);
    } catch {
      /* already gone */
    }
  }
}

export type IsoRefreshResult = {
  ok: boolean;
  changed?: boolean;
  iso?: string;
  previous?: string;
  build?: string;
  severity?: string;
  release?: string;
  error?: string;
};

/** Check the RunOnFlux release feed and stage a newer ArcaneOS/FluxLive ISO on `node`
 * if one isn't already staged. Thin wrapper over `arcane-mage refresh-iso`. */
export async function refreshIso(
  node: string,
  storageIso: string,
  currentIso: string | undefined,
  cfg: AgentConfig
): Promise<IsoRefreshResult> {
  const args = ["refresh-iso", "--json", "--node", node, "--storage-iso", storageIso];
  if (currentIso) args.push("--current-iso", currentIso);
  const r = await runArcaneMage(args, cfg, TIMEOUT.refreshIso);
  if (r.json && typeof r.json.ok === "boolean") {
    return { ...r.json, ok: r.json.ok };
  }
  return { ok: false, error: amFailure(r) };
}

/**
 * Real executor: provisions/tears down on the LOCAL Proxmox via arcane-mage. The
 * agent injects its own creds (cfg.proxmox); the Job never carries them.
 */
export const arcaneMageExecutor: Executor = async (job, cfg) => {
  if (!cfg.proxmox.url || !cfg.proxmox.tokenId || !cfg.proxmox.tokenSecret) {
    throw new Error("Proxmox creds not configured (set PROXMOX_URL/TOKEN_ID/TOKEN_SECRET or AGENT_DRY_RUN=1)");
  }
  switch (job.action) {
    case "provision":
      return provision(job, cfg);
    case "delete":
      return deprovision(job, cfg);
    case "reprovision": {
      await deprovision(job, cfg); // best-effort remove any existing VM
      return provision(job, cfg);
    }
    case "move":
      // Cross-host move is an MT-internal operation; an operator agent provisions
      // the target (the source teardown, if any, comes as a separate delete job).
      return provision(job, cfg);
  }
};

/**
 * Wrap an executor with the owner-authorization gate: privileged actions
 * (delete/reprovision/move) are refused unless a valid owner signature accompanies
 * the job. Applies regardless of dry-run vs real, so the policy holds everywhere.
 */
function withOwnerAuthGate(inner: Executor): Executor {
  return async (job, cfg) => {
    const decision = checkOwnerAuth(job, cfg);
    if (!decision.ok) {
      // `permanent`: re-running the identical job produces the identical refusal.
      // Recovery is a human re-authorizing (which spawns a REPLACEMENT row), not
      // a retry of this one — precisely MT-0010's teardown leg.
      return {
        ok: false,
        message: `owner authorization refused: ${decision.reason}`,
        failureClass: "permanent",
      };
    }
    return inner(job, cfg);
  };
}

export function pickExecutor(cfg: AgentConfig): Executor {
  return withOwnerAuthGate(cfg.dryRun ? dryRunExecutor : arcaneMageExecutor);
}
