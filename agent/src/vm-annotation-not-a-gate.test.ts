import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `JobSlot.vmTags` / `vmDescription` are DESCRIPTIVE, and the agent must never branch on them.
 *
 * They are MT's assertion arriving on a job. Every authorization gate in this agent exists to
 * survive a compromised MT relaying jobs, so a gate that reads a job field is not a gate at all:
 * `kind: foundation` in a tag string must never stand in for the `fh-` VM-name prefix, which is
 * bound to the object the delete acts on (see FOUNDATION_VM_PREFIX in protocol/src/messages.ts).
 *
 * The comments on those fields say so, but a comment decays. This fails the build instead.
 *
 * ⚠️ SCOPE — deliberately narrow. This guards reads of the JOB fields only. The same tag read
 * back FROM PROXMOX is the VM's own state, has the binding the job field lacks, and legitimately
 * gates: `brisk-expiring-liskov` destroys an expired free-trial VM off exactly such a read. So
 * this must not grow into a ban on the strings "tags"/"description" generally, or it will fail
 * that build for doing the correct thing.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const FIELDS = ["vmTags", "vmDescription"];

/** The ONLY shape allowed: forward the value into the provision YAML, unread and uninspected. */
const FORWARD = /^\s*if \(slot\.(vmTags|vmDescription)\) L\.push\(`\s+(tags|description): \$\{yamlStr\(slot\.\1\)\}`\);$/;

function agentSources(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .map((f) => join(SRC, f));
}

test("no agent source branches on the job's vmTags / vmDescription", () => {
  const offenders: string[] = [];
  for (const path of agentSources()) {
    const lines = readFileSync(path, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) return;
      if (!FIELDS.some((f) => line.includes(`slot.${f}`) || line.includes(`.slot.${f}`))) return;
      if (FORWARD.test(line)) return;
      offenders.push(`${path.split("/").pop()}:${i + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(
    offenders,
    [],
    "these read the job's vmTags/vmDescription outside the one allowed forward-to-YAML shape. " +
      "They are MT's assertion and gate nothing — if you need to act on a VM's annotation, read " +
      "it back from Proxmox, where it is bound to the VM:\n" +
      offenders.join("\n")
  );
});

test("the forwarding site still exists, so the guard above cannot pass vacuously", () => {
  const src = readFileSync(join(SRC, "executor.ts"), "utf8");
  const forwards = src.split("\n").filter((l) => FORWARD.test(l));
  assert.equal(
    forwards.length,
    2,
    "expected exactly the two forward-to-YAML lines in executor.ts; if the emit shape changed, " +
      "update FORWARD here — do not delete this test"
  );
});
