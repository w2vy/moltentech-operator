import { execFile } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Job } from "@moltentech/protocol";
import type { AgentConfig } from "./config";
import { checkOwnerAuth } from "./owner-auth";

export type ExecResult = { ok: boolean; message?: string; vmId?: number };
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
 * Build the arcane-mage provision YAML from a Job + the agent's LOCAL host config.
 * Mirrors apps/web/src/lib/yaml-generator.ts, but every hypervisor/host value comes
 * from the operator's own config (MT never sends Proxmox creds or storage IDs) and
 * the identity key arrives already decrypted in the Job. Pure + unit-testable.
 */
export function buildProvisionYaml(job: Job, cfg: AgentConfig): string {
  const { slot, nodeConfig } = job;
  if (!nodeConfig) throw new Error(`Job ${job.jobId} has no nodeConfig (required to provision)`);
  const h = cfg.host;
  const L: string[] = [];

  L.push("nodes:");
  L.push("  - hypervisor:");
  L.push(`      node: ${slot.nodeName}`);
  L.push(`      vm_name: ${slot.vmName}`);
  L.push(`      node_tier: ${slot.tier}`);
  L.push(`      network: ${h.network}`);
  L.push(`      iso_name: ${h.arcaneIso}`);
  L.push(`      storage_images: ${slot.storagePool ?? h.storageImages}`);
  L.push(`      storage_iso: ${h.storageIso}`);
  L.push(`      storage_import: ${h.storageImport}`);
  L.push("      start_on_creation: true");
  if (slot.vmId != null) L.push(`      vm_id: ${slot.vmId}`);
  if (slot.startupConfig) L.push(`      startup_config: "${slot.startupConfig}"`);
  if (slot.diskLimit != null) L.push(`      disk_limit: ${slot.diskLimit}`);
  if (slot.cpuLimit != null) L.push(`      cpu_limit: ${slot.cpuLimit}`);
  if (slot.networkLimit != null) L.push(`      network_limit: ${slot.networkLimit}`);

  L.push("    system:");
  L.push(`      hostname: ${slot.vmName}`);
  L.push(`      hashed_console: "${h.consoleHash}"`);
  if (h.sshPubkey) L.push(`      ssh_pubkey: ${h.sshPubkey}`);

  L.push("    network:");
  L.push("      ip_allocation: static");
  L.push("      address_config:");
  L.push(`        address: ${slot.lanIp}`);
  L.push(`        gateway: ${slot.gateway}`);
  L.push("        dns:");
  L.push(`          - ${slot.dns1}`);
  L.push(`          - ${slot.dns2}`);
  if (slot.vlan != null) L.push(`      vlan: ${slot.vlan}`);
  if (slot.rateLimit != null) L.push(`      rate_limit: ${slot.rateLimit}`);

  L.push("    fluxnode:");
  L.push("      identity:");
  L.push(`        flux_id: ${nodeConfig.fluxId}`);
  L.push(`        identity_key: ${nodeConfig.fluxIdentityKey}`);
  L.push(`        output_id: ${nodeConfig.collateralVout}`);
  L.push(`        tx_id: ${nodeConfig.collateralTxid}`);
  L.push("      network:");
  L.push(`        upnp_port: ${slot.apiPort}`);
  L.push(`        router_address: ${slot.gateway}`);

  const hasDiscord = nodeConfig.discordUserId && nodeConfig.discordWebhook;
  const hasTelegram = nodeConfig.telegramBotToken && nodeConfig.telegramChatId;
  if (hasDiscord || hasTelegram) {
    L.push("      notifications:");
    if (hasDiscord) {
      L.push("        discord:");
      L.push(`          user_id: "${nodeConfig.discordUserId}"`);
      L.push(`          webhook_url: ${nodeConfig.discordWebhook}`);
    }
    if (hasTelegram) {
      L.push("        telegram:");
      L.push(`          bot_token: "${nodeConfig.telegramBotToken}"`);
      L.push(`          chat_id: "${nodeConfig.telegramChatId}"`);
    }
  }

  return L.join("\n") + "\n";
}

type AmResult = { error: Error | null; stdout: string; stderr: string; json: { ok?: boolean; error?: string; vm_id?: number } | null };

/** Invoke the arcane-mage CLI with the LOCAL Proxmox creds as subcommand options. */
function runArcaneMage(args: string[], cfg: AgentConfig, timeoutMs: number): Promise<AmResult> {
  const token = `${cfg.proxmox.tokenId}=${cfg.proxmox.tokenSecret}`;
  const [subcommand, ...rest] = args;
  const fullArgs = [subcommand!, "--url", cfg.proxmox.url!, "--token", token, ...rest];
  return new Promise((resolve) => {
    execFile("arcane-mage", fullArgs, { timeout: timeoutMs }, (error, stdout, stderr) => {
      let json: AmResult["json"] = null;
      try {
        json = JSON.parse(stdout.trim());
      } catch {
        /* non-JSON output */
      }
      resolve({ error, stdout, stderr, json });
    });
  });
}

const TIMEOUT = { provision: 300_000, delete: 120_000, reprovision: 420_000 };

async function deprovision(job: Job, cfg: AgentConfig): Promise<ExecResult> {
  const r = await runArcaneMage(
    ["deprovision", "--json", "--force", "--vm-name", job.slot.vmName, "--node", job.slot.nodeName],
    cfg,
    TIMEOUT.delete
  );
  const ok = r.json?.ok === true || !!r.json?.error?.includes("not found");
  return { ok, message: (r.stdout + "\n" + r.stderr).trim().slice(0, 4000) };
}

async function provision(job: Job, cfg: AgentConfig): Promise<ExecResult> {
  const yamlPath = join(tmpdir(), `mt-${job.jobId}-${randomUUID()}.yaml`);
  writeFileSync(yamlPath, buildProvisionYaml(job, cfg), { mode: 0o600 });
  try {
    const r = await runArcaneMage(["provision", "--json", "-c", yamlPath], cfg, TIMEOUT.provision);
    return {
      ok: r.json?.ok === true,
      message: r.json?.ok ? undefined : (r.json?.error ?? (r.stdout + "\n" + r.stderr).trim().slice(0, 4000)),
      vmId: typeof r.json?.vm_id === "number" ? r.json.vm_id : undefined,
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
      return { ok: false, message: `owner authorization refused: ${decision.reason}` };
    }
    return inner(job, cfg);
  };
}

export function pickExecutor(cfg: AgentConfig): Executor {
  return withOwnerAuthGate(cfg.dryRun ? dryRunExecutor : arcaneMageExecutor);
}
