import { test } from "node:test";
import assert from "node:assert/strict";
import { composeBindMounts, containerPathToHost, resolveInventorySource } from "./inventory-source";

const COMPOSE = `name: fh-agent-acme
services:
  agent:
    image: w2vy/fh-agent:latest
    env_file: [.env.operator]
    volumes:
      - ./config:/config:ro
      - "./data:/data"
`;

test("compose bind mounts are read from the volumes list", () => {
  assert.deepEqual(composeBindMounts(COMPOSE), [
    { host: "config", container: "/config" },
    { host: "data", container: "/data" },
  ]);
});

test("a container path maps through the mount, longest prefix first, else falls back to relative", () => {
  const mounts = composeBindMounts(COMPOSE);
  assert.equal(containerPathToHost("/config/operator_inventory.json", mounts), "config/operator_inventory.json");
  assert.equal(containerPathToHost("/data/inventory.json", mounts), "data/inventory.json");
  assert.equal(containerPathToHost("/elsewhere/inv.json", mounts), "elsewhere/inv.json");
  assert.equal(containerPathToHost("/data/inventory.json", []), "data/inventory.json");
});

test("the toolkit follows the agent's own variables, in the agent's order (tom, 2026-09-19)", () => {
  const never = () => false;
  // moltentech prod: /config mount, non-default file name.
  const prod = resolveInventorySource({ AGENT_INVENTORY_PATH: "/config/operator_inventory.json" }, COMPOSE, never);
  assert.deepEqual(prod, {
    kind: "file",
    relPath: "config/operator_inventory.json",
    label: "config/operator_inventory.json (AGENT_INVENTORY_PATH=/config/operator_inventory.json)",
    via: "AGENT_INVENTORY_PATH",
  });
  // Inline wins over a path.
  const inline = resolveInventorySource({ AGENT_INVENTORY_JSON: "[]", AGENT_INVENTORY_PATH: "/data/inventory.json" }, COMPOSE, never);
  assert.equal(inline.kind, "inline");
  // Scaffolded default: same answer as before this existed.
  const scaffold = resolveInventorySource({ AGENT_INVENTORY_PATH: "/data/inventory.json" }, undefined, never);
  assert.equal(scaffold.kind === "file" && scaffold.relPath, "data/inventory.json");
  // No variable at all: legacy lookup, data/ first, flat file only when data/ is absent and it exists.
  assert.equal((resolveInventorySource({}, undefined, never) as { relPath: string }).relPath, "data/inventory.json");
  assert.equal((resolveInventorySource(undefined, undefined, (p) => p === "inventory.json") as { relPath: string }).relPath, "inventory.json");
});
