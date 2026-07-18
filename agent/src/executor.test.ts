import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Job } from "@moltentech/protocol";
import type { AgentConfig } from "./config";
import { buildProvisionYaml } from "./executor";

// arcane-mage parses the config disk with PyYAML `yaml.safe_load`. Parse the generated
// YAML with the SAME loader so the test proves what the node would actually see.
function safeLoad(yaml: string): unknown {
  const out = execFileSync(
    "python3",
    ["-c", "import sys,json,yaml; json.dump(yaml.safe_load(sys.stdin.read()), sys.stdout)"],
    { input: yaml, encoding: "utf8" }
  );
  return JSON.parse(out);
}

const host: AgentConfig["host"] = {
  network: "vmbr0",
  storageImages: "local-lvm",
  storageIso: "local",
  storageImport: "local",
  arcaneIso: "FluxLive.iso",
  sshPubkey: "",
  consoleHash: "!",
};
const cfg = { host } as unknown as AgentConfig;

/** A Job with a valid slot; nodeConfig is supplied per-test (possibly hostile). */
function jobWith(nodeConfig: Record<string, unknown>): Job {
  return {
    schemaVersion: 1,
    jobId: "job-1",
    providerSlug: "moltentech",
    action: "provision",
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    slot: {
      vmName: "mt-186-n1",
      tier: "cumulus",
      nodeName: "pve20",
      ipAddress: "10.0.0.10",
      lanIp: "192.168.186.10/24",
      gateway: "192.168.186.1",
      dns1: "8.8.8.8",
      dns2: "1.1.1.1",
      vlan: 186,
      apiPort: 16127,
      network: null,
      storagePool: null,
      vmId: null,
      diskLimit: null,
      cpuLimit: null,
      networkLimit: null,
      startupConfig: null,
      rateLimit: null,
    },
    nodeConfig,
  } as unknown as Job;
}

// The YAML that an operator's node config disk looks like normally — sanity check that
// escaping did not change the parsed structure/values.
test("normal config renders a well-formed single node with operator hypervisor", () => {
  const yaml = buildProvisionYaml(
    jobWith({
      fluxId: "t1abcdefghijkmnopqrstuvwx",
      fluxIdentityKey: "Kx1abcdefghijkmnopqrstuvwxyz0123456789ABCDEFGHJKLMN",
      collateralTxid: "a".repeat(64),
      collateralVout: 0,
      discordUserId: null,
      discordWebhook: null,
      telegramBotToken: null,
      telegramChatId: null,
    }),
    cfg
  );
  const doc = safeLoad(yaml) as { nodes: Array<{ hypervisor: Record<string, unknown>; fluxnode: Record<string, unknown> }> };
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.nodes[0]!.hypervisor.node, "pve20");
  assert.equal(doc.nodes[0]!.hypervisor.vm_name, "mt-186-n1");
  assert.equal((doc.nodes[0]!.fluxnode as any).identity.flux_id, "t1abcdefghijkmnopqrstuvwx");
});

// The core security assertion: a hostile value that reaches buildProvisionYaml (bypassing
// the schema) must land as a STRING, never inject a sibling key that overrides hypervisor.
test("hostile discordWebhook cannot inject a sibling hypervisor key", () => {
  const payload =
    "http://x\n    hypervisor:\n      node: victim-pve\n      vm_id: 999\n      storage_images: victim-pool";
  const yaml = buildProvisionYaml(
    jobWith({
      fluxId: "t1abcdefghijkmnopqrstuvwx",
      fluxIdentityKey: "Kx1abcdefghijkmnopqrstuvwxyz0123456789ABCDEFGHJKLMN",
      collateralTxid: "a".repeat(64),
      collateralVout: 0,
      discordUserId: "12345",
      discordWebhook: payload,
      telegramBotToken: null,
      telegramChatId: null,
    }),
    cfg
  );
  const doc = safeLoad(yaml) as { nodes: Array<{ hypervisor: Record<string, unknown>; fluxnode: any }> };
  // Operator's hypervisor is intact — NOT overridden by the injected block.
  assert.equal(doc.nodes[0]!.hypervisor.node, "pve20");
  assert.equal(doc.nodes[0]!.hypervisor.vm_id, undefined);
  assert.equal(doc.nodes[0]!.hypervisor.storage_images, "local-lvm");
  // The payload round-trips verbatim as the webhook string value.
  assert.equal(doc.nodes[0]!.fluxnode.notifications.discord.webhook_url, payload);
});

test("hostile flux_id cannot inject structure either", () => {
  const payload = "id\n    hypervisor:\n      node: victim-pve";
  const yaml = buildProvisionYaml(
    jobWith({
      fluxId: payload,
      fluxIdentityKey: "Kx1abcdefghijkmnopqrstuvwxyz0123456789ABCDEFGHJKLMN",
      collateralTxid: "a".repeat(64),
      collateralVout: 0,
      discordUserId: null,
      discordWebhook: null,
      telegramBotToken: null,
      telegramChatId: null,
    }),
    cfg
  );
  const doc = safeLoad(yaml) as { nodes: Array<{ hypervisor: Record<string, unknown>; fluxnode: any }> };
  assert.equal(doc.nodes[0]!.hypervisor.node, "pve20");
  assert.equal(doc.nodes[0]!.fluxnode.identity.flux_id, payload);
});

// Per-host network: the slot carries its host's bridge (pve40 = vmbr184, not the agent's
// global vmbr0). A non-null slot.network overrides the host default; null falls back to it.
test("slot.network overrides the agent's global host network", () => {
  const base = jobWith({
    fluxId: "t1abcdefghijkmnopqrstuvwx",
    fluxIdentityKey: "Kx1abcdefghijkmnopqrstuvwxyz0123456789ABCDEFGHJKLMN",
    collateralTxid: "a".repeat(64),
    collateralVout: 0,
    discordUserId: null,
    discordWebhook: null,
    telegramBotToken: null,
    telegramChatId: null,
  });

  const override = { ...base, slot: { ...base.slot, network: "vmbr184" } } as Job;
  const overrideDoc = safeLoad(buildProvisionYaml(override, cfg)) as {
    nodes: Array<{ hypervisor: Record<string, unknown> }>;
  };
  assert.equal(overrideDoc.nodes[0]!.hypervisor.network, "vmbr184");

  // null slot.network → falls back to the agent's configured host.network (vmbr0).
  const fallbackDoc = safeLoad(buildProvisionYaml(base, cfg)) as {
    nodes: Array<{ hypervisor: Record<string, unknown> }>;
  };
  assert.equal(fallbackDoc.nodes[0]!.hypervisor.network, "vmbr0");
});

// Defense in depth: the protocol schema refuses a control char before it ever reaches
// the agent's YAML builder.
test("Job schema rejects control chars in nodeConfig strings", () => {
  assert.throws(() =>
    Job.parse({
      schemaVersion: 1,
      jobId: "job-1",
      providerSlug: "moltentech",
      action: "provision",
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      slot: {
        vmName: "mt-186-n1",
        tier: "cumulus",
        nodeName: "pve20",
        ipAddress: "10.0.0.10",
        gateway: "192.168.186.1",
        apiPort: 16127,
      },
      nodeConfig: {
        fluxId: "ok",
        fluxIdentityKey: "ok",
        collateralTxid: "ok",
        collateralVout: 0,
        discordWebhook: "http://x\n    hypervisor:\n      node: victim",
      },
    })
  );
});
