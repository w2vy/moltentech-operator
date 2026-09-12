import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpDir } from "./test-tmp";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline/promises";
import { runCommand, CliError, type Ctx } from "./cli";
import { parseConfigEnv } from "./manifest-config";
import { generateEd25519, exportPrivateKeyPem } from "./signing";
import { verifyManifestObject } from "./signing";
import type { NameCheckRequest, NameCheckResponse } from "./name-check";

/**
 * `fh-toolkit slug` — the identity block of `init` on its own. Driven in-process: a
 * scripted readline answers each prompt as it is printed, and a fake hub answers the
 * name checks, so nothing here touches a terminal or the network.
 */

/** Feed `answers` one per prompt. "" = Enter (take the default). */
function scriptedRl(answers: string[]): { rl: ReturnType<typeof createInterface>; transcript: () => string } {
  const input = new PassThrough();
  const output = new PassThrough();
  let out = "";
  const queue = [...answers];
  output.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    out += text;
    // Every prompt ends in ": " — that is the moment readline is waiting for a line.
    if (/: $/.test(text)) {
      const next = queue.shift();
      setImmediate(() => input.write(`${next ?? ""}\n`));
    }
  });
  const rl = createInterface({ input, output, terminal: false });
  return { rl, transcript: () => out };
}

type Hub = (req: NameCheckRequest) => Partial<NameCheckResponse>;
function fakeFetch(hub: Hub, seen: NameCheckRequest[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/onboard/check-names")) {
      const req = JSON.parse(String(init?.body)) as NameCheckRequest;
      seen.push(req);
      return new Response(JSON.stringify({ advisory: true, ...hub(req) }), { status: 200 });
    }
    if (url.endsWith("/api/mt-pubkey")) return new Response(JSON.stringify({ pubkey: "HUBKEY" }), { status: 200 });
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

const allFree: Hub = (req) => {
  const ok = (value: string) => ({ value, available: true });
  return {
    ...(req.slug ? { slug: ok(req.slug) } : {}),
    ...(req.vmNamePrefix ? { vmNamePrefix: ok(req.vmNamePrefix) } : {}),
    ...(req.name ? { name: ok(req.name) } : {}),
  };
};

function ctxFor(dir: string, answers: string[], hub: Hub, seen: NameCheckRequest[] = []): { ctx: Ctx; transcript: () => string } {
  const { rl, transcript } = scriptedRl(answers);
  return { ctx: { dir, interactive: false, rl, fetch: fakeFetch(hub, seen) }, transcript };
}

const quiet = async <T>(fn: () => Promise<T>): Promise<{ result: T; log: string }> => {
  const orig = console.log;
  let log = "";
  console.log = (...a: unknown[]) => void (log += a.join(" ") + "\n");
  try {
    return { result: await fn(), log };
  } finally {
    console.log = orig;
  }
};

test("fresh directory: writes a config.env with the identity filled and the stock-take blank", async () => {
  const dir = tmpDir("fh-slug-");
  const seen: NameCheckRequest[] = [];
  // env=staging, level=operator, slug, prefix (default), name (default), location, contact, owner, confirm, app name
  const { ctx } = ctxFor(dir, ["2", "2", "acme-cloud", "", "", "Berlin", "ops@acme.example", "1OwnerAddr", "y", ""], allFree, seen);
  const { result, log } = await quiet(() => runCommand("slug", ["--dir", dir], ctx));
  assert.equal(result, 0);
  const env = parseConfigEnv(readFileSync(join(dir, "config.env"), "utf8"));
  assert.equal(env.MT_BASE_URL, "https://staging.moltentech.us");
  assert.equal(env.PROVIDER_SLUG, "acme-cloud");
  assert.equal(env.PROVIDER_VM_PREFIX, "ac-", "the default prefix is the slug's initials");
  assert.equal(env.PROVIDER_NAME, "acme-cloud");
  assert.equal(env.PROVIDER_LEVEL, "operator");
  assert.equal(env.OWNER_ADDRESS, "1OwnerAddr");
  assert.equal(env.COALITION_URL, "https://coalition-acme-cloud.app.runonflux.io");
  assert.equal(env.MT_PUBKEY, "HUBKEY", "the pubkey of the hub that was CHOSEN, fetched after the answer");
  assert.equal(env.HOSTS, "");
  assert.equal(env.TIER_PRICES_JSON, "{}");
  assert.match(log, /identity only/);
  // Three hub calls: slug, prefix, name — each after its own answer, none carrying `self`.
  assert.deepEqual(seen.map((r) => Object.keys(r).join(",")), ["slug", "vmNamePrefix", "name"]);
});

test("a taken slug and a taken prefix are re-asked at the prompt, not discovered at ingest", async () => {
  const dir = tmpDir("fh-slug-");
  const hub: Hub = (req) => {
    const r = allFree(req);
    if (req.slug === "moltentech") r.slug = { value: "moltentech", available: false, reason: "taken" };
    if (req.vmNamePrefix === "mt-") r.vmNamePrefix = { value: "mt-", available: false, reason: "taken" };
    if (req.vmNamePrefix === "fh-") r.vmNamePrefix = { value: "fh-", available: false, reason: "reserved" };
    return r;
  };
  //           env  lvl  slug(taken) slug   prefix(taken) prefix(bad fmt) prefix(reserved: offline rule) prefix  name  loc contact owner y app
  const { ctx, transcript } = ctxFor(dir, ["1", "2", "moltentech", "molten-two", "mt-", "MT-", "fh-", "m2-", "", "", "", "1Owner", "y", ""], hub);
  const { result, log } = await quiet(() => runCommand("slug", ["--dir", dir], ctx));
  assert.equal(result, 0);
  const env = parseConfigEnv(readFileSync(join(dir, "config.env"), "utf8"));
  assert.equal(env.PROVIDER_SLUG, "molten-two");
  assert.equal(env.PROVIDER_VM_PREFIX, "m2-");
  assert.equal(env.MT_BASE_URL, "https://fluxhub.moltentech.us");
  // The prompt was repeated twice for the slug and four times for the prefix.
  assert.equal((transcript().match(/Provider slug/g) ?? []).length, 2);
  assert.equal((transcript().match(/VM name prefix \(/g) ?? []).length, 4);
  const t = log;
  assert.match(t, /slug "moltentech" is already registered/);
  assert.match(t, /prefix "mt-" is already registered/);
  assert.match(t, /"MT-" is not a usable VM name prefix/);
  assert.match(t, /"fh-" is reserved for Foundation nodes/);
});

test("an unreachable hub is one note, and the scaffold still completes", async () => {
  const dir = tmpDir("fh-slug-");
  const { rl } = scriptedRl(["1", "1", "lonely-op", "", "", "", "", "1Owner", "y", ""]);
  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const { result, log } = await quiet(() => runCommand("slug", ["--dir", dir], { dir, interactive: false, rl, fetch: down }));
  assert.equal(result, 0);
  const notes = log.match(/could not reach .* to check names/g) ?? [];
  assert.equal(notes.length, 1, "warned once, not once per prompt");
  const env = parseConfigEnv(readFileSync(join(dir, "config.env"), "utf8"));
  assert.equal(env.PROVIDER_SLUG, "lonely-op");
  assert.equal(env.PROVIDER_LEVEL, "supporter");
});

function scaffolded(dir: string, extra = ""): void {
  writeFileSync(
    join(dir, "config.env"),
    [
      "PROVIDER_SLUG=acme-cloud",
      "PROVIDER_NAME=Acme Cloud",
      "PROVIDER_CONTACT=ops@acme.example",
      "MT_BASE_URL=https://fluxhub.moltentech.us",
      "COALITION_URL=https://coalition-acme-cloud.app.runonflux.io",
      "OWNER_ADDRESS=1Owner",
      "PROVIDER_LEVEL=operator",
      "MT_PUBKEY=OLDKEY",
      "HOSTS=pve-01",
      'TIER_PRICES_JSON={"cumulus":700}',
      "TRIAL_DAYS=1",
      "MANUAL_APPROVAL=false",
      extra,
      "",
    ].join("\n")
  );
}

test("existing config.env: only slug, prefix, name and hub are asked; the rest is kept", async () => {
  const dir = tmpDir("fh-slug-");
  scaffolded(dir);
  const seen: NameCheckRequest[] = [];
  // env (Enter = keep prod), slug (Enter), prefix (no default in the file → suggested "ac-"; type "acm-"), name (Enter)
  const { ctx, transcript } = ctxFor(dir, ["", "", "acm-", ""], allFree, seen);
  const { result, log } = await quiet(() => runCommand("slug", ["--dir", dir], ctx));
  assert.equal(result, 0);
  const text = readFileSync(join(dir, "config.env"), "utf8");
  const env = parseConfigEnv(text);
  assert.equal(env.PROVIDER_VM_PREFIX, "acm-");
  assert.equal(env.PROVIDER_SLUG, "acme-cloud");
  assert.equal(env.PROVIDER_NAME, "Acme Cloud");
  assert.equal(env.MT_PUBKEY, "OLDKEY", "hub unchanged → pubkey untouched");
  assert.equal(env.HOSTS, "pve-01");
  assert.equal(env.TIER_PRICES_JSON, '{"cumulus":700}');
  assert.match(text, /^# PROVIDER_VM_PREFIX — /m, "the new key arrives with its comment");
  assert.ok(existsSync(join(dir, "config.env.bak")));
  assert.doesNotMatch(transcript(), /Which are you|Owner wallet|Flux app name|Location/);
  assert.match(log, /PROVIDER_VM_PREFIX: \(unset\) → acm-/);
  // Every hub call names the provider as `self`, so its own registered rows do not count.
  assert.ok(seen.length >= 2);
  assert.ok(seen.every((r) => r.self === "acme-cloud"), JSON.stringify(seen));
});

test("existing config.env, same answers: nothing written", async () => {
  const dir = tmpDir("fh-slug-");
  scaffolded(dir, "PROVIDER_VM_PREFIX=ac-");
  const before = readFileSync(join(dir, "config.env"), "utf8");
  const { ctx } = ctxFor(dir, ["", "", "", ""], allFree);
  const { result, log } = await quiet(() => runCommand("slug", ["--dir", dir], ctx));
  assert.equal(result, 0);
  assert.match(log, /Nothing to change/);
  assert.equal(readFileSync(join(dir, "config.env"), "utf8"), before);
  assert.equal(existsSync(join(dir, "config.env.bak")), false);
});

test("changing the slug is refused at the prompt without --force — it is a new provider, not a rename", async () => {
  const dir = tmpDir("fh-slug-");
  scaffolded(dir, "PROVIDER_VM_PREFIX=ac-");
  // env, slug (try to change → refused → Enter keeps), prefix, name
  const { ctx, transcript } = ctxFor(dir, ["", "acme-two", "", "", ""], allFree);
  const { result, log } = await quiet(() => runCommand("slug", ["--dir", dir], ctx));
  assert.equal(result, 0);
  assert.match(log, /a different one is a NEW provider, not a rename/);
  assert.equal((transcript().match(/Provider slug/g) ?? []).length, 2, "asked again");
  assert.equal(parseConfigEnv(readFileSync(join(dir, "config.env"), "utf8")).PROVIDER_SLUG, "acme-cloud");
});

test("--force allows the slug change, re-signs manifest.json, and a hub move refreshes MT_PUBKEY", async () => {
  const dir = tmpDir("fh-slug-");
  scaffolded(dir, "PROVIDER_VM_PREFIX=ac-");
  const { privateKey } = generateEd25519();
  writeFileSync(join(dir, "manifest-key.pem"), exportPrivateKeyPem(privateKey));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ stale: true }));
  // env → staging, slug → acme-two (allowed), prefix (keep), name → "Acme Two"
  const { ctx } = ctxFor(dir, ["2", "acme-two", "", "Acme Two"], allFree);
  const { result, log } = await quiet(() => runCommand("slug", ["--dir", dir, "--force"], ctx));
  assert.equal(result, 0);
  const env = parseConfigEnv(readFileSync(join(dir, "config.env"), "utf8"));
  assert.equal(env.PROVIDER_SLUG, "acme-two");
  assert.equal(env.PROVIDER_NAME, "Acme Two");
  assert.equal(env.MT_BASE_URL, "https://staging.moltentech.us");
  assert.equal(env.MT_PUBKEY, "HUBKEY", "the new hub's pubkey");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Record<string, unknown>;
  assert.equal(verifyManifestObject(manifest), true, "re-signed with the local key");
  assert.equal((manifest.provider as { slug: string; vmNamePrefix: string }).slug, "acme-two");
  assert.equal((manifest.provider as { slug: string; vmNamePrefix: string }).vmNamePrefix, "ac-");
  assert.ok(existsSync(join(dir, "manifest.json.bak")));
  assert.match(log, /manifest\.json \(re-signed\)/);
  assert.match(log, /paste manifest\.json at https:\/\/staging\.moltentech\.us\/onboard/);
});

test("a pinned prefix change is warned about when a manifest already exists", async () => {
  const dir = tmpDir("fh-slug-");
  scaffolded(dir, "PROVIDER_VM_PREFIX=ac-");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ stale: true }));
  const { ctx } = ctxFor(dir, ["", "", "acm-", ""], allFree);
  const { result, log } = await quiet(() => runCommand("slug", ["--dir", dir], ctx));
  assert.equal(result, 0);
  assert.match(log, /pinned by the hub at first ingest/);
  // No key here → the stale manifest is named, not silently left.
  assert.match(log, /manifest-key\.pem is not here to re-sign it/);
});

test("unknown flags are refused like every other command", async () => {
  await assert.rejects(runCommand("slug", ["--yes"], { dir: ".", interactive: false }), CliError);
});

// ── doctor and init --answers use the same check ─────────────────────────────

test("doctor asks the hub as `self` and reports its verdicts; an unreachable hub is an unproven line", async () => {
  const dir = tmpDir("fh-slug-");
  scaffolded(dir, "PROVIDER_VM_PREFIX=ac-");
  writeFileSync(join(dir, "inventory.json"), JSON.stringify([{ name: "pve-01", slots: [{ vmName: "ac-c1", lanIp: "10.0.0.1/24" }] }]));
  const seen: NameCheckRequest[] = [];
  const taken = fakeFetch(
    (req) => ({ slug: { value: req.slug!, available: false, reason: "taken" }, vmNames: [{ value: "ac-c1", available: false, reason: "taken" }] }),
    seen
  );
  const { result, log } = await quiet(() => runCommand("doctor", ["--dir", dir], { dir, interactive: false, fetch: taken }));
  assert.equal(result, 1);
  assert.match(log, /SLUG_TAKEN_BY_OTHER/);
  assert.match(log, /VMNAME_TAKEN/);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { self: "acme-cloud", slug: "acme-cloud", name: "Acme Cloud", vmNamePrefix: "ac-", hostNames: ["pve-01"], vmNames: ["ac-c1"] });

  const down = (async () => {
    throw new Error("ECONNREFUSED");
  }) as unknown as typeof fetch;
  const offline = await quiet(() => runCommand("doctor", ["--dir", dir], { dir, interactive: false, fetch: down }));
  assert.equal(offline.result, 0, offline.log);
  // Counted in the summary line; named in full only when nothing else is reported
  // (the report lists unproven checks under "every file agrees" — existing behaviour).
  assert.match(offline.log, /[1-9]\d* unproven/);
});

test("init --answers: one composite check, printed as warnings, never fatal", async () => {
  const dir = tmpDir("fh-slug-");
  const { privateKey } = generateEd25519();
  writeFileSync(join(dir, "manifest-key.pem"), exportPrivateKeyPem(privateKey));
  const answers = {
    providerSlug: "acme-cloud",
    vmNamePrefix: "ac-",
    providerName: "Acme Cloud",
    ownerAddress: "1Owner",
    mtBaseUrl: "https://staging.moltentech.us",
    fluxAppName: "coalition-acme-cloud",
    level: "supporter",
    hosts: [{ name: "pve-01", storageImages: "local-lvm", storageIso: "local", slots: [{ tier: "cumulus", vmName: "ac-pve-01-c1", ipAddress: "203.0.113.1", lanIp: "10.0.0.5/24", gateway: "10.0.0.1", apiPort: 16127 }] }],
  };
  writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
  const seen: NameCheckRequest[] = [];
  const hub = fakeFetch((req) => ({ vmNamePrefix: { value: req.vmNamePrefix!, available: false, reason: "taken" } }), seen);
  const errs: string[] = [];
  const origErr = console.error;
  console.error = (...a: unknown[]) => void errs.push(a.join(" "));
  try {
    const { result } = await quiet(() => runCommand("init", ["--out", dir, "--answers", join(dir, "answers.json")], { dir, interactive: false, fetch: hub }));
    assert.equal(result, 0);
  } finally {
    console.error = origErr;
  }
  assert.ok(existsSync(join(dir, "config.env")), "files written despite the warning");
  assert.ok(errs.some((l) => /prefix "ac-" is already registered .* ingest will refuse this/.test(l)), errs.join("\n"));
  const check = seen.find((r) => r.vmNames);
  assert.deepEqual(check, { slug: "acme-cloud", name: "Acme Cloud", vmNamePrefix: "ac-", hostNames: ["pve-01"], vmNames: ["ac-pve-01-c1"] });
  // A VM name outside the prefix never reaches the hub: validateAnswers stops it first.
  writeFileSync(join(dir, "answers.json"), JSON.stringify({ ...answers, hosts: [{ ...answers.hosts[0], slots: [{ ...answers.hosts[0]!.slots[0], vmName: "mt-c1" }] }] }));
  await assert.rejects(
    runCommand("init", ["--out", dir, "--force", "--answers", join(dir, "answers.json")], { dir, interactive: false, fetch: hub }),
    (e: unknown) => e instanceof CliError && /vmName must start with the VM name prefix "ac-"/.test(e.message)
  );
});
