import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generateAll, renderAgentCompose, AGENT_IMAGE, type Answers } from "./scaffold";

/**
 * `compose.yaml` for the agent.
 *
 * The runbook's `docker run` line is six arguments long and every one of them fails
 * SILENTLY when wrong: a single-file /data mount detaches on the next editor save, a
 * missing `:ro` hands the agent write access to the only directory it reads, a project
 * name derived from the directory collides between two operator stacks, and `:latest`
 * means nobody can say afterwards which image half-completed an onboarding. None of
 * those produce an error message; they produce an agent that quietly does the wrong
 * thing. Generating the file is how they stop being possible rather than documented.
 */

const ANSWERS: Answers = {
  providerSlug: "acme-nodes",
  providerName: "Acme Nodes",
  ownerAddress: "t1owner",
  mtBaseUrl: "https://www.moltentech.us",
  fluxAppName: "coalition-acme-nodes",
  hosts: [
    {
      name: "pve-01",
      storageImages: "ssd",
      storageIso: "iso-store",
      slots: [
        {
          tier: "cumulus",
          vmName: "ac-c1",
          ipAddress: "203.0.113.10",
          lanIp: "192.168.1.10/24",
          gateway: "192.168.1.1",
          apiPort: 16127,
        },
      ],
    },
  ],
};

const compose = (): string => renderAgentCompose(ANSWERS);

test("init writes it, so there is nothing to copy out of the runbook", () => {
  assert.equal(generateAll(ANSWERS)["compose.yaml"], compose());
});

test("⭐ /data is mounted as a DIRECTORY and read-only", () => {
  // A single-file bind mount pins the container to that file's inode; most editors save
  // via write-new-then-rename, which detaches the mount. Host edits then stop reaching
  // the agent with no error — it just keeps serving the inventory it started with.
  assert.match(compose(), /^ {6}- \.\/data:\/data:ro$/m);
  assert.doesNotMatch(compose(), /inventory\.json:/, "never mount the file itself");
});

test("⭐ the project name is explicit, not inherited from the directory", () => {
  // Compose derives it from the working directory, so two operator stacks in
  // similarly-named directories share a project and fight over one container.
  assert.match(compose(), /^name: fh-agent-acme-nodes$/m);
});

test("the image is pinned, and pinned to what the doc says", () => {
  assert.match(compose(), new RegExp(`^ {4}image: ${AGENT_IMAGE.replace("/", "\\/")}$`, "m"));
  assert.doesNotMatch(AGENT_IMAGE, /:latest$/);
  assert.match(AGENT_IMAGE, /^w2vy\/mt-agent:\d+\.\d+\.\d+$/);

  // Same rule the Coalition image already lives under: an operator following the doc and
  // an operator running `init` must deploy the same code.
  const doc = fileURLToPath(new URL("../../docs/operator-onboarding.md", import.meta.url));
  if (!existsSync(doc)) return;
  const pins = [...new Set(readFileSync(doc, "utf8").match(/w2vy\/mt-agent:[^\s`)]+/g) ?? [])];
  assert.deepEqual(pins, [AGENT_IMAGE], "docs/operator-onboarding.md pins a different agent image");
});

test("⭐ the file says --force-recreate, because `restart` does not re-read env", () => {
  // The single most common reason a corrected key keeps returning 401. `docker compose
  // restart` re-reads nothing, and whether `up -d` notices a changed env_file's CONTENTS
  // varies by compose version — so the instruction has to be the one that always works.
  assert.match(compose(), /--force-recreate/);
  assert.match(compose(), /does NOT re-read \.env\.operator/);
});

test("no ports are published — the agent is outbound-only", () => {
  // It holds the Proxmox credentials. Nothing about it should be reachable.
  assert.doesNotMatch(compose(), /^\s*ports:/m);
  assert.match(compose(), /only dials OUT/);
});

test("it reads .env.operator, the file that holds the agent's secrets", () => {
  assert.match(compose(), /^ {4}env_file: \[\.env\.operator\]$/m);
});

test("restart: unless-stopped, so a reboot brings it back", () => {
  assert.match(compose(), /^ {4}restart: unless-stopped$/m);
});
