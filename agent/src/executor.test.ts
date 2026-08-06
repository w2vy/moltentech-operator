import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { Job } from "@moltentech/protocol";
import type { AgentConfig } from "./config";
import { buildProvisionYaml, classifyAmFailure, amFailure, parseAmJson } from "./executor";
import type { AmResult } from "./executor";

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

// ─────────────────────────────────────────────────────────────────────────────
// Failure classification (Phase 2 of the job retry queue).
//
// The rule under test is deliberately asymmetric: recognising a failure as
// `transient` licenses MT to re-run the job unattended, so the bar for that
// verdict is high and everything unrecognised must fall through to `unknown`.
// ─────────────────────────────────────────────────────────────────────────────

/** Shape a fake arcane-mage run whose provision trace ends in `messages`. */
function amRun(messages: string[], extra: Partial<AmResult> = {}): AmResult {
  return {
    error: null,
    stdout: "",
    stderr: "",
    json: {
      ok: false,
      error: "Provisioning failed",
      nodes: [
        {
          hostname: "pve25",
          ok: false,
          steps: [
            { ok: true, message: "Validated hypervisor" },
            ...messages.map((message) => ({ ok: false, message })),
          ],
        },
      ],
    },
    ...extra,
  };
}

test("classify: pre-flight cluster failures are transient", () => {
  // Both are raised before anything is mutated, and both are the MT-0010 class.
  assert.equal(classifyAmFailure(amRun(["Cluster has lost quorum, refusing to provision"])), "transient");
  assert.equal(classifyAmFailure(amRun(["Node 'pve25' is offline in cluster"])), "transient");
});

test("classify: unreachable Proxmox API is transient", () => {
  assert.equal(classifyAmFailure(amRun(["Unable to get Proxmox api version"])), "transient");
  assert.equal(classifyAmFailure(amRun(["Unable to get Proxmox storage state"])), "transient");
  assert.equal(classifyAmFailure(amRun(["Unable to list VMs on pve25"])), "transient");
});

test("classify: a name collision is permanent", () => {
  assert.equal(
    classifyAmFailure(amRun(["VM name 'mt-186-n4' already exists on node 'pve25'"])),
    "permanent"
  );
  assert.equal(classifyAmFailure(amRun(["Unable to generate vm config"])), "permanent");
});

test("classify: permanent wins over transient when both appear", () => {
  // A run can trip several steps; the permanent one decides, because retrying
  // cannot clear it no matter how transient its neighbour was.
  assert.equal(
    classifyAmFailure(
      amRun(["Node 'pve25' is offline in cluster", "VM name 'x' already exists on node 'pve30'"])
    ),
    "permanent"
  );
});

test("classify: mutating steps stay unknown — the real cause never reaches us", () => {
  // arcane-mage collapses the Proxmox HTTP status to a bool before the CLI sees
  // it, so these could be a transient 595 or a full disk. Never auto-retry.
  for (const m of [
    "Unable to create VM on hypervisor",
    "Unable to start VM on hypervisor",
    "Unable to upload Config image to hypervisor",
    "Unable to clean up disk images on hypervisor",
  ]) {
    assert.equal(classifyAmFailure(amRun([m])), "unknown", m);
  }
});

test("classify: a timeout is unknown, not transient", () => {
  // The VM may be half-built; a blind retry is not obviously safe.
  const killed = amRun([], { error: Object.assign(new Error("timeout"), { killed: true }) });
  assert.equal(classifyAmFailure(killed), "unknown");
});

test("classify: a missing arcane-mage binary is permanent", () => {
  const enoent = amRun([], { error: Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" }) });
  assert.equal(classifyAmFailure(enoent), "permanent");
});

test("classify: no trace at all is unknown", () => {
  // Exactly MT-0010's stored evidence: pydantic noise on stderr, nothing else.
  const bare: AmResult = {
    error: null,
    stdout: "",
    stderr: "PydanticSerializationUnexpectedValue: Expected 6 fields but got 5",
    json: { ok: false, error: "Provisioning failed" },
  };
  assert.equal(classifyAmFailure(bare), "unknown");
});

test("failure message leads with the failed step, not the generic error", () => {
  const msg = amFailure(amRun(["Node 'pve25' is offline in cluster"], { stderr: "pydantic noise" }));
  assert.match(msg, /^\[step\] Node 'pve25' is offline in cluster/);
  // stderr is retained for debugging, but demoted below the real signal.
  assert.ok(msg.indexOf("pydantic noise") > msg.indexOf("[step]"));
});

test("parseAmJson survives stray stdout above the payload", () => {
  // A single stray line used to drop the entire structured payload.
  const out = 'warning: deprecated flag\n{"ok":false,"error":"Provisioning failed"}';
  assert.deepEqual(parseAmJson(out), { ok: false, error: "Provisioning failed" });
});

test("parseAmJson returns null when there is no JSON at all", () => {
  assert.equal(parseAmJson("Traceback (most recent call last):"), null);
});
