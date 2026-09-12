import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runCommand, CliError } from "./cli";
import { parseConfigEnv } from "./manifest-config";
import { readListing } from "./level-change";
import { renderConfigEnv, type HostAnswer } from "./scaffold";
import { verifyManifestObject } from "./signing";
import type { NameCheckRequest } from "./name-check";
import { ANSWERS, allFree, ctxFor, fakeFetch, keyedDir, quiet, scaffolded, type Hub } from "./cli-harness";

/**
 * `fh-toolkit inventory` — the stock-take on its own. Writes data/inventory.json and the
 * three lines derived from it: HOSTS (manifest field → re-sign), the agent's storage
 * pair (what a provision READS), and the listing's slot counts.
 */

const readInventory = (dir: string): Array<{ name: string; storageImages: string; slots: Array<{ vmName: string; apiPort: number }> }> =>
  JSON.parse(readFileSync(join(dir, "data", "inventory.json"), "utf8"));

const TWO_HOSTS: HostAnswer[] = [
  ...ANSWERS.hosts,
  {
    name: "pve-02",
    storageImages: "nvme",
    storageIso: "local",
    slots: [{ tier: "cumulus", vmName: "ac-pve-02-c1", ipAddress: "203.0.113.2", lanIp: "10.0.0.7/24", gateway: "10.0.0.1", apiPort: 16127 }],
  },
];

test("fresh: after `slug` + `stripe` + `proxmox`, --hosts writes inventory.json, HOSTS and the storage lines", async () => {
  const dir = keyedDir();
  writeFileSync(join(dir, "config.env"), renderConfigEnv({ ...ANSWERS, hosts: [], mtPubkey: "HUBKEY" }));
  // `stripe` before `inventory`, as init orders them: the tier list exists before the slots do.
  await quiet(() => runCommand("stripe", ["--dir", dir, "--price", "cumulus=7", "--yes"], { dir, interactive: false, fetch: fakeFetch() }));
  await quiet(() => runCommand("proxmox", ["--dir", dir, "--url", "https://10.0.0.2:8006", "--token-id", "a@pve!b", "--token-secret", "c", "--no-probe"], { dir, interactive: false, fetch: fakeFetch() }));
  writeFileSync(join(dir, "hosts.json"), JSON.stringify(TWO_HOSTS));
  const seen: NameCheckRequest[] = [];
  const { result, log } = await quiet(() => runCommand("inventory", ["--dir", dir, "--hosts", join(dir, "hosts.json")], { dir, interactive: false, fetch: fakeFetch(allFree, seen) }));
  assert.equal(result, 0);
  const inv = readInventory(dir);
  assert.deepEqual(inv.map((h) => h.name), ["pve-01", "pve-02"]);
  assert.equal(parseConfigEnv(readFileSync(join(dir, "config.env"), "utf8")).HOSTS, "pve-01,pve-02");
  const op = parseConfigEnv(readFileSync(join(dir, ".env.operator"), "utf8"));
  assert.equal(op.PROXMOX_STORAGE_IMAGES, "local-lvm", "from the FIRST host — env wins over inventory at provision");
  assert.equal(op.PROXMOX_STORAGE_ISO, "local");
  assert.deepEqual(readListing(readFileSync(join(dir, ".env.operator"), "utf8")), [{ tier: "cumulus", priceCents: 700, availableSlots: 3 }]);
  assert.deepEqual(seen, [{ hostNames: ["pve-01", "pve-02"], vmNames: ["ac-pve-01-c1", "ac-pve-01-c2", "ac-pve-02-c1"] }]);
  assert.match(log, /3 host\(s\)|2 host\(s\), 3 slot\(s\)/);
  assert.match(log, /re-reads data\/inventory\.json|force-recreate/);
});

test("existing: a host added re-signs manifest.json, refreshes HOSTS and the listing count", async () => {
  const dir = await scaffolded();
  const manifestBefore = readFileSync(join(dir, "manifest.json"), "utf8");
  writeFileSync(join(dir, "hosts.json"), JSON.stringify(TWO_HOSTS));
  const { result, log } = await quiet(() => runCommand("inventory", ["--dir", dir, "--hosts", join(dir, "hosts.json")], { dir, interactive: false, fetch: fakeFetch() }));
  assert.equal(result, 0);
  assert.equal(parseConfigEnv(readFileSync(join(dir, "config.env"), "utf8")).HOSTS, "pve-01,pve-02");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  assert.notEqual(readFileSync(join(dir, "manifest.json"), "utf8"), manifestBefore);
  assert.ok(verifyManifestObject(manifest));
  assert.deepEqual(manifest.hardware.map((h: { name: string }) => h.name), ["pve-01", "pve-02"]);
  assert.ok(existsSync(join(dir, "manifest.json.bak")));
  assert.ok(existsSync(join(dir, "data", "inventory.json.bak")));
  assert.deepEqual(readListing(readFileSync(join(dir, ".env.operator"), "utf8")), [{ tier: "cumulus", priceCents: 700, availableSlots: 3 }]);
  assert.match(log, /paste manifest\.json/);
});

test("a host or slot dropped from the file is named: the agent is upsert-only", async () => {
  const dir = await scaffolded();
  const one: HostAnswer[] = [{ ...ANSWERS.hosts[0]!, slots: [ANSWERS.hosts[0]!.slots[0]!] }];
  writeFileSync(join(dir, "hosts.json"), JSON.stringify(one));
  const { result, log } = await quiet(() => runCommand("inventory", ["--dir", dir, "--hosts", join(dir, "hosts.json")], { dir, interactive: false, fetch: fakeFetch() }));
  assert.equal(result, 0);
  assert.match(log, /upsert-only — `ac-pve-01-c2` stays on Flux Hub/);
  assert.equal(readInventory(dir)[0]!.slots.length, 1);
  assert.equal(parseConfigEnv(readFileSync(join(dir, "config.env"), "utf8")).HOSTS, "pve-01", "unchanged → no re-sign");
  assert.ok(!existsSync(join(dir, "manifest.json.bak")));
  assert.deepEqual(readListing(readFileSync(join(dir, ".env.operator"), "utf8")), [{ tier: "cumulus", priceCents: 700, availableSlots: 1 }], "all offered → follows the count down");
});

test("a deliberate hold-back in the listing survives a re-run, clamped to what is declared", async () => {
  const dir = await scaffolded();
  const opPath = join(dir, ".env.operator");
  writeFileSync(opPath, readFileSync(opPath, "utf8").replace(/^AGENT_LISTING_JSON=.*$/m, 'AGENT_LISTING_JSON=[{"tier":"cumulus","priceCents":700,"availableSlots":1}]'));
  writeFileSync(join(dir, "hosts.json"), JSON.stringify(TWO_HOSTS));
  await quiet(() => runCommand("inventory", ["--dir", dir, "--hosts", join(dir, "hosts.json")], { dir, interactive: false, fetch: fakeFetch() }));
  assert.deepEqual(readListing(readFileSync(opPath, "utf8")), [{ tier: "cumulus", priceCents: 700, availableSlots: 1 }], "1 of 3 is still a hold-back");
  const one: HostAnswer[] = [{ ...ANSWERS.hosts[0]!, slots: [] }];
  writeFileSync(join(dir, "hosts.json"), JSON.stringify(one));
  await quiet(() => runCommand("inventory", ["--dir", dir, "--hosts", join(dir, "hosts.json")], { dir, interactive: false, fetch: fakeFetch() }));
  assert.deepEqual(readListing(readFileSync(opPath, "utf8")), [{ tier: "cumulus", priceCents: 700, availableSlots: 0 }], "clamped to the declared count");
});

test("same hosts again: nothing written; --dry-run never writes", async () => {
  const dir = await scaffolded();
  writeFileSync(join(dir, "hosts.json"), JSON.stringify(ANSWERS.hosts));
  const same = await quiet(() => runCommand("inventory", ["--dir", dir, "--hosts", join(dir, "hosts.json")], { dir, interactive: false, fetch: fakeFetch() }));
  assert.equal(same.result, 0);
  assert.match(same.log, /Nothing to change/);
  assert.ok(!existsSync(join(dir, "data", "inventory.json.bak")));
  writeFileSync(join(dir, "hosts.json"), JSON.stringify(TWO_HOSTS));
  const dry = await quiet(() => runCommand("inventory", ["--dir", dir, "--hosts", join(dir, "hosts.json"), "--dry-run"], { dir, interactive: false, fetch: fakeFetch() }));
  assert.match(dry.log, /HOSTS: pve-01 → pve-01,pve-02/);
  assert.match(dry.log, /nothing written/);
  assert.equal(readInventory(dir).length, 1);
});

test("refusals: no prefix yet; a VM name outside the prefix; a slot with a bare lanIp", async () => {
  const dir = keyedDir();
  writeFileSync(join(dir, "config.env"), "PROVIDER_SLUG=acme-cloud\nMT_BASE_URL=https://staging.moltentech.us\n");
  writeFileSync(join(dir, "hosts.json"), JSON.stringify(ANSWERS.hosts));
  await assert.rejects(
    runCommand("inventory", ["--dir", dir, "--hosts", join(dir, "hosts.json")], { dir, interactive: false, fetch: fakeFetch() }),
    (e: unknown) => e instanceof CliError && /run `fh-toolkit slug` first/.test(e.message)
  );
  const ok = await scaffolded();
  const bad: HostAnswer[] = [{ ...ANSWERS.hosts[0]!, slots: [{ ...ANSWERS.hosts[0]!.slots[0]!, vmName: "mt-c1" }, { ...ANSWERS.hosts[0]!.slots[1]!, lanIp: "10.0.0.6" }] }];
  writeFileSync(join(ok, "hosts.json"), JSON.stringify(bad));
  await assert.rejects(
    runCommand("inventory", ["--dir", ok, "--hosts", join(ok, "hosts.json")], { dir: ok, interactive: false, fetch: fakeFetch() }),
    (e: unknown) => e instanceof CliError && /must start with the VM name prefix "ac-"/.test(e.message) && /needs a \/NN suffix/.test(e.message)
  );
});

test("interactive re-run over an existing file is Enter-through and reproduces it", async () => {
  const dir = await scaffolded();
  rmSync(join(dir, ".env.operator")); // no token → no survey; storage names come from the file
  const before = readInventory(dir);
  // hosts(Enter) → images(Enter) → iso(Enter) → capacity(Enter=2)
  //   WAN(Enter) → LAN gw(Enter) → port(Enter) → tier(Enter) → suffix(Enter) → LAN(Enter) → pool(Enter)
  //   port(Enter = 16137) → tier → suffix → LAN → pool
  const answers = ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", ""];
  const { ctx, transcript } = ctxFor(dir, answers);
  const { result, log } = await quiet(() => runCommand("inventory", ["--dir", dir], ctx));
  assert.equal(result, 0, log);
  assert.match(transcript(), /\[pve-01\]/);
  assert.match(transcript(), /\[10\.0\.0\.1\/24\]/, "the LAN network is rebuilt from gateway + lanIp prefix");
  assert.match(transcript(), /\[pve-01-c2\]/, "the suffix default is the current name minus the prefix");
  assert.match(transcript(), /\[16137\]/);
  assert.deepEqual(readInventory(dir), before);
  assert.match(log, /Nothing to change/);
});

test("interactive re-run: a second host typed at the first prompt, the rest defaulted", async () => {
  const dir = await scaffolded();
  rmSync(join(dir, ".env.operator"));
  const hub: Hub = (req) => allFree(req);
  const answers = [
    "pve-01,pve-02",                                  // hosts
    "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", // pve-01 Enter-through (15 prompts)
    "nvme", "local", "1",                             // pve-02: images, iso, capacity
    "203.0.113.2", "10.0.0.1/24", "", "", "", "7", "", // WAN, LAN gw, port, tier, suffix, LAN host, pool
  ];
  const { ctx } = ctxFor(dir, answers, hub);
  const { result, log } = await quiet(() => runCommand("inventory", ["--dir", dir], ctx));
  assert.equal(result, 0, log);
  const inv = readInventory(dir);
  assert.deepEqual(inv.map((h) => h.name), ["pve-01", "pve-02"]);
  assert.equal(inv[1]!.slots[0]!.vmName, "ac-pve-02-c1");
  assert.equal(parseConfigEnv(readFileSync(join(dir, "config.env"), "utf8")).HOSTS, "pve-01,pve-02");
  assert.ok(verifyManifestObject(JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"))));
});
