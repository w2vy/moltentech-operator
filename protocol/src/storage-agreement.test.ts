import { test } from "node:test";
import assert from "node:assert/strict";
import { lintStorageAgreement } from "./config-lint";
import { storageContentProblem, type StorageOption } from "./proxmox-probe";

// These two rules are the file-level and the live-level halves of the same 2026-08-29
// incident, in which a single provision took five attempts. Each test names the attempt it
// would have prevented, because the value of a check like this is entirely in how early it
// speaks — every one of these facts was knowable before the first attempt.

function opt(over: Partial<StorageOption> & { id: string }): StorageOption {
  return { type: "dir", rotational: null, why: "", content: [], shared: false, active: true, ...over };
}

// ── attempt 3: "Storage type missing on hypervisor" ────────────────────────────────────
test("⭐ inventory.json and PROXMOX_STORAGE_* disagreeing is an ERROR, not a note", () => {
  const findings = lintStorageAgreement(
    JSON.stringify([{ name: "pve50", storageIso: "local", storageImages: "local-lvm" }]),
    { PROXMOX_STORAGE_ISO: "local-lvm", PROXMOX_STORAGE_IMAGES: "local-lvm" }
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.rule, "STORAGE_DECLARED_NOT_USED");
  assert.equal(findings[0]!.severity, "error");
  // The message must say which one WINS. Knowing they differ is not enough to act on: the
  // operator had already "fixed" this in the file that turned out not to matter.
  assert.match(findings[0]!.message, /ENV value is what provisions/);
  assert.match(findings[0]!.message, /pve50/);
});

test("agreement is silent, and an absent inventory field is not a disagreement", () => {
  assert.deepEqual(
    lintStorageAgreement(JSON.stringify([{ name: "pve50", storageIso: "local" }]), {
      PROXMOX_STORAGE_ISO: "local",
    }),
    []
  );
  // No `storageIso` key at all means "use the agent default" — a real and common shape,
  // and flagging it would train operators to ignore this rule.
  assert.deepEqual(
    lintStorageAgreement(JSON.stringify([{ name: "pve50", storageImages: "local-lvm" }]), {
      PROXMOX_STORAGE_ISO: "local",
      PROXMOX_STORAGE_IMAGES: "local-lvm",
    }),
    []
  );
});

test("malformed inventory says nothing here — lintInventory already reports it", () => {
  assert.deepEqual(lintStorageAgreement("{not json", { PROXMOX_STORAGE_ISO: "local" }), []);
});

// ── attempts 1-2: an ISO storage that could never hold an ISO ──────────────────────────
test("⭐ a storage that cannot hold the content it is named for is caught, with the reason", () => {
  const options = [
    opt({ id: "local", content: ["iso", "backup", "import"] }),
    opt({ id: "local-lvm", type: "lvmthin", content: ["images"] }),
  ];
  const problem = storageContentProblem("local-lvm", options, "iso");
  assert.ok(problem, "local-lvm holds images only — it cannot be the ISO store");
  assert.match(problem, /lvmthin/);
  assert.match(problem, /cannot hold iso/);
  // Says where the failure WOULD have surfaced, which is the part that cost the time.
  assert.match(problem, /arcane-mage/);

  assert.equal(storageContentProblem("local", options, "iso"), undefined);
  assert.equal(storageContentProblem("local-lvm", options, "images"), undefined);
});

test("a storage the token cannot see is named as such, and lists what it can", () => {
  const problem = storageContentProblem("pve55-shared", [opt({ id: "local", content: ["iso"] })], "iso");
  assert.match(problem!, /not a storage this token can see/);
  assert.match(problem!, /local/);
});

test("⭐ an unjudgeable answer is silence, never a pass", () => {
  // No survey (the probe was skipped, or 403'd as it did on attempts 1-2) means there is
  // nothing to compare against. Returning undefined here is "not disproved" — callers must
  // not read it as "verified", which is why init still asks and doctor still warns.
  assert.equal(storageContentProblem("anything-at-all", [], "iso"), undefined);
  assert.equal(storageContentProblem("", [opt({ id: "local", content: ["iso"] })], "iso"), undefined);
});

test("an inactive storage is reported as unusable, but wrong TYPE outranks it", () => {
  const inactive = [opt({ id: "nfs-old", content: ["iso"], active: false })];
  assert.match(storageContentProblem("nfs-old", inactive, "iso")!, /not active/);
  // Both wrong: report the fact that does not change when the node comes back.
  const both = [opt({ id: "lvm-off", type: "lvmthin", content: ["images"], active: false })];
  assert.match(storageContentProblem("lvm-off", both, "iso")!, /cannot hold iso/);
});
