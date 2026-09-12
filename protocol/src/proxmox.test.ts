import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, CliError } from "./cli";
import { parseConfigEnv } from "./manifest-config";
import { renderConfigEnv } from "./scaffold";
import { ANSWERS, ctxFor, fakeFetch, keyedDir, quiet, scaffolded } from "./cli-harness";

/**
 * `fh-toolkit proxmox` — the agent's PROXMOX_* credentials, on their own. Fresh: a whole
 * .env.operator from config.env's identity. Existing: the three lines, in place.
 */

test("fresh: writes .env.operator from config.env's identity, with the storage lines blank", async () => {
  const dir = keyedDir();
  writeFileSync(join(dir, "config.env"), renderConfigEnv({ ...ANSWERS, hosts: [], mtPubkey: "HUBKEY" }));
  const { result, log } = await quiet(() =>
    runCommand("proxmox", ["--dir", dir, "--url", "https://10.0.0.9:8006", "--token-id", "fh-agent@pve!agent", "--token-secret", "s3cret", "--no-probe"], { dir, interactive: false, fetch: fakeFetch() })
  );
  assert.equal(result, 0);
  const env = parseConfigEnv(readFileSync(join(dir, ".env.operator"), "utf8"));
  assert.equal(env.PROVIDER_SLUG, "acme-cloud");
  assert.equal(env.MT_BASE_URL, "https://staging.moltentech.us");
  assert.equal(env.COALITION_URL, "https://coalition-acme-cloud.app.runonflux.io");
  assert.equal(env.PROXMOX_URL, "https://10.0.0.9:8006");
  assert.equal(env.PROXMOX_TOKEN_SECRET, "s3cret");
  assert.equal(env.PROXMOX_STORAGE_IMAGES, "", "no host yet — `inventory` fills it");
  assert.equal(env.PROXMOX_STORAGE_ISO, "");
  assert.equal(env.AGENT_LISTING_JSON, "[]");
  assert.ok(env.MANIFEST_KEY, "MANIFEST_KEY from the key on disk, as init fills it");
  assert.ok(env.MANIFEST_PUBKEY, "and the pin");
  assert.match(log, /blank until you declare hosts/);
});

test("existing: only the three PROXMOX_* lines change, byte-for-byte elsewhere, .bak kept", async () => {
  const dir = await scaffolded();
  const before = readFileSync(join(dir, ".env.operator"), "utf8");
  const { result, log } = await quiet(() =>
    runCommand("proxmox", ["--dir", dir, "--token-secret", "new-secret", "--no-probe"], { dir, interactive: false, fetch: fakeFetch() })
  );
  assert.equal(result, 0);
  const after = readFileSync(join(dir, ".env.operator"), "utf8");
  assert.equal(readFileSync(join(dir, ".env.operator.bak"), "utf8"), before);
  const diff = after.split("\n").filter((l, i) => l !== before.split("\n")[i]);
  assert.deepEqual(diff, ["PROXMOX_TOKEN_SECRET=new-secret"]);
  assert.equal(parseConfigEnv(after).PROXMOX_URL, "https://10.0.0.2:8006", "the url was kept from the file");
  assert.match(log, /PROXMOX_TOKEN_SECRET: \(changed\)/, "the secret is never printed");
  assert.doesNotMatch(log, /new-secret/);
  assert.match(log, /force-recreate/);
});

test("existing, same values: nothing written", async () => {
  const dir = await scaffolded();
  const before = readFileSync(join(dir, ".env.operator"), "utf8");
  const { result, log } = await quiet(() =>
    runCommand("proxmox", ["--dir", dir, "--url", "https://10.0.0.2:8006", "--no-probe"], { dir, interactive: false, fetch: fakeFetch() })
  );
  assert.equal(result, 0);
  assert.match(log, /Nothing to change/);
  assert.equal(readFileSync(join(dir, ".env.operator"), "utf8"), before);
  assert.ok(!existsSync(join(dir, ".env.operator.bak")));
});

test("interactive: current values are the defaults, the secret is never echoed, `skip` writes nothing", async () => {
  const dir = await scaffolded();
  // url (Enter = current) → token id (Enter) → secret (Enter keeps) → probe fails (127.0.0.1:1 is not a hypervisor) → skip
  const { ctx, transcript } = ctxFor(dir, ["https://127.0.0.1:1", "", "", "skip"]);
  const { result, log } = await quiet(() => runCommand("proxmox", ["--dir", dir], ctx));
  assert.equal(result, 0);
  assert.match(transcript(), /\[https:\/\/10\.0\.0\.2:8006\]/, "the current URL is the default");
  assert.match(transcript(), /Enter keeps the current one/);
  assert.doesNotMatch(transcript(), /old-secret/);
  assert.match(log, /going on unverified/);
  assert.equal(parseConfigEnv(readFileSync(join(dir, ".env.operator"), "utf8")).PROXMOX_URL, "https://127.0.0.1:1", "skip still writes what was typed");
});

test("refusals: no config.env; a flag set missing a value; a failed probe without --yes", async () => {
  const bare = keyedDir();
  await assert.rejects(
    runCommand("proxmox", ["--dir", bare, "--url", "https://x:8006", "--no-probe"], { dir: bare, interactive: false, fetch: fakeFetch() }),
    (e: unknown) => e instanceof CliError && /run `fh-toolkit slug` first/.test(e.message)
  );
  const dir = keyedDir();
  writeFileSync(join(dir, "config.env"), renderConfigEnv({ ...ANSWERS, hosts: [] }));
  await assert.rejects(
    runCommand("proxmox", ["--dir", dir, "--url", "https://x:8006", "--no-probe"], { dir, interactive: false, fetch: fakeFetch() }),
    (e: unknown) => e instanceof CliError && /all needed/.test(e.message)
  );
  await assert.rejects(
    quiet(() => runCommand("proxmox", ["--dir", dir, "--url", "https://127.0.0.1:1", "--token-id", "a@pve!b", "--token-secret", "c"], { dir, interactive: false, fetch: fakeFetch() })),
    (e: unknown) => e instanceof CliError && /did not verify/.test(e.message)
  );
  assert.ok(!existsSync(join(dir, ".env.operator")), "nothing written on a failed probe");
  await assert.rejects(
    runCommand("proxmox", ["--dir", dir, "--bogus"], { dir, interactive: false }),
    (e: unknown) => e instanceof CliError && /unknown/.test(e.message)
  );
});
