#!/usr/bin/env -S npx tsx
/**
 * mt-manifest — operator tooling to generate a signing key and produce a SIGNED
 * Provider Manifest for MoltenTech onboarding. Uses the same canonicalization +
 * ed25519 as MT's verifier (./signing), so a manifest this signs always verifies.
 *
 *   keygen [--out <dir>] [--force]      generate manifest-key.pem (KEEP SECRET) + print pubkey.
 *                                       Refuses to overwrite an existing key: MT pins its public
 *                                       half at first ingest, so replacing it means re-onboarding.
 *   init   [--out <dir>] [--answers <answers.json>] [--force]
 *                                       ~8 questions -> config.env, secrets.env (skeleton),
 *                                       .env.operator, inventory.json and the Flux app spec.
 *                                       --answers runs the SAME generator non-interactively.
 *   doctor [--dir <dir>]                check that the generated files agree with each other
 *                                       (file-level only; the credential checks live in
 *                                        `mt-agent doctor`, where the credentials are)
 *   sign   --key <pem> (--from-config <config.env> | --in <body.json>) [--out <manifest.json>]
 *                                       render body (from config.env) or read body.json,
 *                                       fill pubkey + publishedAt, sign, emit full manifest
 *   env    --from-config <config.env> --secrets <secrets.env> --manifest <manifest.json> [--out <env.json>]
 *                                       assemble the Flux "Import Environment Variables" blob (JSON array of
 *                                       "KEY=value"): non-secret config + secrets + the signed manifest as
 *                                       MANIFEST_JSON; passes TIER_PRICES_JSON through from config.env. --manifest may
 *                                       be a bare manifest OR an 'authorize' wrapper (owner-signed, shipped
 *                                       whole so MT ingests it owner-verified). Verifies the manifest (and any
 *                                       owner) signature first. Output contains SECRETS — never commit it.
 *   verify --in <manifest.json>         re-verify a signed manifest — accepts a bare manifest OR an
 *                                        'authorize' wrapper (whose owner signature is checked too)
 *   authorize --in <manifest.json>      LEGACY — the /onboard web flow is the supported path.
 *                                       Still serves the URL-fetch ingest path.
 *                                       print the owner-authorization message + a Zelcore
 *                                        deep link to sign (proves you control ownerAddress)
 *   authorize --in <manifest.json> --signature <b64> --out <signed-manifest.json>
 *                                        wrap the manifest + your wallet signature into the
 *                                        SignedProviderManifest MT ingests (proven identity)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ProviderManifest, ProviderManifestBody, manifestOwnerMessage, unwrapManifest } from "./manifest";
import { renderManifestBodyFromConfig, parseConfigEnv } from "./manifest-config";
import { runDoctor, formatReport, fetchTierMinimums, TIER_FLOORS_CENTS } from "./config-lint";
import {
  generateAll,
  validateAnswers,
  resolvedPrices,
  hasPaidTier,
  coalitionUrlFor,
  suggestFluxAppName,
  type Answers,
  type HostAnswer,
  type SlotAnswer,
} from "./scaffold";
import { verifyManifestOwnerSignature } from "./wallet";
import { buildZelcoreSignLink } from "./sign-launcher";
import {
  generateEd25519,
  exportPrivateKeyPem,
  importPrivateKeyPem,
  publicKeyBase64FromPrivate,
  signManifestBody,
  verifyManifestObject,
} from "./signing";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/**
 * The eight answers. Everything else in the five generated files is derived from
 * these — in particular COALITION_URL, which is asked for as a Flux APP NAME and
 * derived, because the URL is deterministic (`https://<app>.app.runonflux.io`) and
 * asking for it directly is what created the chicken-and-egg in the old runbook.
 */
async function askAnswers(minimums: Record<string, number> = TIER_FLOORS_CENTS): Promise<Answers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def?: string): Promise<string> => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def || "";
  };
  try {
    console.log("mt-manifest init — this writes every onboarding file from your answers.\n");

    const providerSlug = await ask("Provider slug (lowercase, PERMANENT once ingested)");
    const providerName = await ask("Display name", providerSlug);
    const providerLocation = await ask("Location (shown on your marketplace card)", "");
    const providerContact = await ask("Contact email", "");

    // Echoed back and confirmed: this address is baked into the bytes signed at
    // /onboard, so a typo means re-signing everything downstream.
    let ownerAddress = "";
    for (;;) {
      ownerAddress = await ask("Owner wallet address (ZelID 1… or Flux t1…)");
      const yes = (await ask(`Confirm owner address is exactly "${ownerAddress}"? (y/N)`, "N")).toLowerCase();
      if (yes === "y" || yes === "yes") break;
    }

    // Offered as a choice, never free text by default: free-typing this is what put
    // half a deployment on staging and half on prod.
    const which = await ask("MoltenTech environment — 1) production  2) staging", "1");
    const mtBaseUrl = which.startsWith("2") ? "https://staging.moltentech.us" : "https://www.moltentech.us";

    const fluxAppName = await ask("Flux app name for your Coalition", suggestFluxAppName(providerSlug));
    console.log(`  → COALITION_URL will be ${coalitionUrlFor(fluxAppName)}`);

    const hosts: HostAnswer[] = [];
    const hostNames = (await ask("Proxmox host name(s), comma-separated"))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const name of hostNames) {
      console.log(`\n— host ${name} —`);
      // The highest-value question in the list: a spinning-disk default wastes an
      // entire provision + benchmark cycle and reports no cause. `mt-agent doctor`
      // is what actually proves ROTA=0; here we just make it a deliberate answer.
      const storageImages = await ask(`  storage pool for VM images on ${name} (must NOT be a spinning disk)`);
      const storageIso = await ask(`  storage holding the ArcaneOS ISO on ${name}`, "pve55-shared");
      const slots: SlotAnswer[] = [];
      const count = Number(await ask(`  how many slots on ${name}?`, "1"));
      for (let i = 0; i < count; i++) {
        console.log(`  · slot ${i + 1} of ${count}`);
        const tier = await ask(`    tier (${Object.keys(minimums).join("/")})`, "cumulus");
        const vmName = await ask("    VM name");
        const ipAddress = await ask("    public WAN IP");
        const lanIp = await ask("    LAN IP with prefix, e.g. 192.168.87.2/24");
        const gateway = await ask("    LAN gateway");
        const apiPort = Number(await ask("    Flux API port", "16127"));
        slots.push({ tier, vmName, ipAddress, lanIp, gateway, apiPort });
      }
      hosts.push({ name, storageImages, storageIso, slots });
    }

    // Prices in DOLLARS, then multiplied — which deletes the extra-zero class of bug
    // rather than validating against it.
    const draft: Answers = { providerSlug, providerName, ownerAddress, mtBaseUrl, fluxAppName, hosts };
    const tierPricesCents: Record<string, number> = {};
    const tiers = [...new Set(hosts.flatMap((h) => h.slots.map((s) => s.tier)))].sort();
    console.log("");
    for (const tier of tiers) {
      const floor = minimums[tier] ?? 0;
      const dollars = await ask(
        `Monthly price for ${tier} in DOLLARS (floor $${(floor / 100).toFixed(2)})`,
        (floor / 100).toFixed(2)
      );
      tierPricesCents[tier] = Math.round(Number(dollars) * 100);
    }

    return {
      ...draft,
      providerLocation: providerLocation || undefined,
      providerContact: providerContact || undefined,
      tierPricesCents,
    };
  } finally {
    rl.close();
  }
}

const BODY_TEMPLATE = {
  schemaVersion: 2,
  provider: {
    slug: "your-slug",
    name: "Your Operator Name",
    location: "City, Country",
    description: "Short description shown on the marketplace card.",
    contact: "ops@example.com",
  },
  coalitionUrl: "https://your-coalition.example",
  hardware: [{ name: "pve-01" }],
  trialDays: 1,
  manualApproval: false,
  serviceFlags: {
    delegationAvailable: false,
    autoRenew: true,
    whiteLabel: false,
    sla: "99.5%",
    languages: ["en"],
    supportChannels: "email",
    dataCenters: "City, Country",
  },
  trustedSelfClaim: false,
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "keygen": {
      const dir = flag(args, "--out") ?? ".";
      const keyPath = join(dir, "manifest-key.pem");
      // Your signing key is a ONCE-EVER identity: MT pins its public half at first
      // ingest, so silently overwriting it orphans the operator with no error
      // anywhere — the manifest simply stops matching what MT holds. Refusing costs
      // three lines; the alternative is unrecoverable.
      if (existsSync(keyPath) && !args.includes("--force")) {
        die(
          `${keyPath} already exists. This key is your PERMANENT identity — MT pinned its ` +
            `public half at first ingest, and replacing it means re-onboarding. ` +
            `Pass --force only if you are deliberately rotating it.`
        );
      }
      const { publicKeyBase64, privateKey } = generateEd25519();
      writeFileSync(keyPath, exportPrivateKeyPem(privateKey), { mode: 0o600 });
      writeFileSync(join(dir, "manifest-pubkey.txt"), publicKeyBase64 + "\n");
      console.log(`Wrote ${keyPath} (KEEP SECRET — this signs your manifest).`);
      console.log(`Public key (manifest "pubkey", also saved to manifest-pubkey.txt):\n${publicKeyBase64}`);
      break;
    }
    case "init": {
      // Replaces the vestigial body-template init: `sign --from-config` superseded
      // that flow, the rewritten runbook never mentions it, and BODY_TEMPLATE had
      // drifted (no ownerAddress). `sign --in <body.json>` still serves anyone with
      // a hand-built body.
      const dir = flag(args, "--out") ?? ".";
      const answersPath = flag(args, "--answers");
      const force = args.includes("--force");

      // Same rule as doctor: ask MT for the live minimums, fall back to the bundled
      // table. Done before the prompts so the wizard quotes the real floor.
      const liveMinimums = await fetchTierMinimums(
        process.env.MT_BASE_URL ?? "https://www.moltentech.us"
      );
      if (!liveMinimums) {
        console.error("note: could not reach MT for live tier minimums — using this tool's bundled copy.");
      }
      const minimums = liveMinimums ?? TIER_FLOORS_CENTS;

      let answers: Answers;
      if (answersPath) {
        // The non-interactive path is what makes this testable and re-runnable after
        // a typo. It drives the SAME generator as the prompts — there is no second
        // implementation to drift.
        try {
          answers = JSON.parse(readFileSync(answersPath, "utf8")) as Answers;
        } catch (e) {
          die(`${answersPath}: ${(e as Error).message}`);
        }
      } else {
        answers = await askAnswers(minimums);
      }

      const problems = validateAnswers(answers, minimums);
      if (problems.length > 0) die(`answers are not usable:\n  - ${problems.join("\n  - ")}`);

      const files = generateAll(answers);
      const existing = Object.keys(files).filter((f) => existsSync(join(dir, f)));
      if (existing.length > 0 && !force) {
        die(`refusing to overwrite existing file(s): ${existing.join(", ")} — pass --force to replace them.`);
      }
      for (const [name, text] of Object.entries(files)) {
        const mode = name === "secrets.env" ? 0o600 : 0o644;
        writeFileSync(join(dir, name), text, { mode });
      }

      const prices = resolvedPrices(answers);
      console.log(`Wrote ${Object.keys(files).join(", ")} to ${dir}\n`);
      console.log("Next, in order:");
      console.log("  1. mt-manifest keygen                     → manifest-key.pem (once, ever)");
      console.log("  2. paste base64 of that key into secrets.env AND .env.operator as MANIFEST_KEY");
      console.log(`  3. open ${answers.mtBaseUrl}/onboard, paste your manifest, sign with ${answers.ownerAddress}`);
      console.log("     → issues AGENT_KEY, COALITION_KEY, COALITION_SIGNING_KEY for secrets.env");
      if (hasPaidTier(prices)) {
        console.log("  4. Stripe: create a restricted key + a webhook endpoint.");
        console.log("     ⚠️  the webhook secret is bound to THAT endpoint — a secret from another");
        console.log("         endpoint fails silently and checkout never completes.");
      } else {
        console.log("  4. Stripe: not needed — you are not listing anything for sale.");
      }
      console.log(`  5. deploy Flux app "${answers.fluxAppName}" → ${coalitionUrlFor(answers.fluxAppName)}`);
      console.log("\nThen run `mt-manifest doctor` here to check every file agrees.");
      break;
    }
    case "doctor": {
      // The runbook's "which value must match where" table, executed. File-level
      // only: no network, no secrets held, no Proxmox credentials. The checks that
      // need credentials live in `mt-agent doctor`, where they already exist.
      const dir = flag(args, "--dir") ?? ".";
      const read = (f: string): string | undefined => {
        const p = join(dir, f);
        return existsSync(p) ? readFileSync(p, "utf8") : undefined;
      };
      // inventory.json sits beside the others during onboarding but is mounted at
      // data/ once the agent runs, so look in both rather than reporting it missing.
      const inventory = read("inventory.json") ?? read(join("data", "inventory.json"));
      const configText = read("config.env");
      // Price rules come from MT itself when we can reach it — the minimum is MT's to
      // set, and a copy in this repo is only a fallback. MT_BASE_URL is read from the
      // operator's own config so no flag is needed.
      const mtBaseUrl = configText ? parseConfigEnv(configText).MT_BASE_URL : undefined;
      const tierMinimums = mtBaseUrl ? ((await fetchTierMinimums(mtBaseUrl)) ?? undefined) : undefined;
      const report = runDoctor({
        configEnv: configText,
        secretsEnv: read("secrets.env"),
        envOperator: read(".env.operator"),
        inventoryJson: inventory,
        tierMinimums,
      });
      const { text, ok } = formatReport(report);
      console.log(text);
      if (!ok) process.exit(1);
      break;
    }
    case "sign": {
      const keyPath = flag(args, "--key") ?? die("--key <manifest-key.pem> required");
      const fromConfig = flag(args, "--from-config");
      const inPath = flag(args, "--in");
      if (!fromConfig && !inPath) die("provide --from-config <config.env> or --in <body.json>");
      const outPath = flag(args, "--out");

      const priv = importPrivateKeyPem(readFileSync(keyPath, "utf8"));
      let body: Record<string, unknown>;
      if (fromConfig) {
        try {
          body = renderManifestBodyFromConfig(readFileSync(fromConfig, "utf8"));
        } catch (e) {
          die((e as Error).message);
        }
      } else {
        body = JSON.parse(readFileSync(inPath!, "utf8"));
      }
      // The key is the source of truth for pubkey; stamp a fresh publishedAt.
      body.pubkey = publicKeyBase64FromPrivate(priv);
      body.publishedAt = new Date().toISOString();

      const parsed = ProviderManifestBody.safeParse(body);
      if (!parsed.success) die(`manifest body invalid:\n${parsed.error.message}`);

      const signature = signManifestBody(body, priv);
      const manifest = { ...body, signature };
      if (!verifyManifestObject(manifest)) die("self-verification failed (internal)");

      const out = JSON.stringify(manifest, null, 2) + "\n";
      if (outPath) {
        writeFileSync(outPath, out);
        console.log(`Wrote signed manifest to ${outPath}. Publish it at your Coalition's /.well-known/mt-provider.json`);
      } else {
        process.stdout.write(out);
      }
      break;
    }
    case "env": {
      const fromConfig = flag(args, "--from-config") ?? die("--from-config <config.env> required");
      const secretsPath = flag(args, "--secrets") ?? die("--secrets <secrets.env> required");
      const manifestPath = flag(args, "--manifest") ?? die("--manifest <manifest.json> required");
      const outPath = flag(args, "--out");

      const config = parseConfigEnv(readFileSync(fromConfig, "utf8"));
      const secrets = parseConfigEnv(readFileSync(secretsPath, "utf8"));

      // Verify the manifest is validly signed BEFORE shipping it as env — refuse a
      // placeholder or a tampered/unsigned manifest. Accepts either a bare
      // ProviderManifest OR a SignedProviderManifest wrapper (from 'authorize'); the
      // whole object is shipped verbatim so the owner signature reaches MT via the
      // /.well-known publish path.
      const manifestObj = JSON.parse(readFileSync(manifestPath, "utf8"));
      const { manifest: innerManifest, ownerSignature: manifestOwnerSig } = unwrapManifest(manifestObj);
      if (!verifyManifestObject(innerManifest)) die(`${manifestPath}: manifest signature invalid — run 'sign' first`);
      if (manifestOwnerSig != null) {
        // A wrapper MUST carry a valid owner signature or we refuse it — never ship a
        // wrapper whose owner authorization doesn't verify.
        const parsed = ProviderManifest.safeParse(innerManifest);
        if (!parsed.success) die(`${manifestPath}: signed wrapper's manifest is invalid:\n${parsed.error.message}`);
        if (!parsed.data.ownerAddress) die(`${manifestPath}: signed manifest is missing ownerAddress`);
        if (!verifyManifestOwnerSignature(parsed.data, manifestOwnerSig)) {
          die(`${manifestPath}: owner wallet signature does not verify against ownerAddress — re-run 'authorize'`);
        }
        if (config.OWNER_ADDRESS && config.OWNER_ADDRESS !== parsed.data.ownerAddress) {
          console.error(
            `warning: config.env OWNER_ADDRESS (${config.OWNER_ADDRESS}) differs from the signed ` +
              `manifest's ownerAddress (${parsed.data.ownerAddress}) — shipping the signed manifest's owner.`
          );
        }
      }

      const pairs: string[] = [];
      const put = (k: string, v: string | undefined): void => {
        if (v != null && v !== "") pairs.push(`${k}=${v}`);
      };
      const needCfg = (k: string): string => config[k] || die(`config.env: ${k} is required`);
      const needSecret = (k: string): string => secrets[k] || die(`secrets.env: ${k} is required`);

      // Non-secret runtime config from config.env (required + optional passthrough).
      put("PROVIDER_SLUG", needCfg("PROVIDER_SLUG"));
      put("MT_BASE_URL", needCfg("MT_BASE_URL"));
      for (const k of ["MT_PUBKEY", "OWNER_ADDRESS", "PORT", "TRIAL_DAYS", "SESSION_TTL_HOURS", "STATS_WINDOW_DAYS"]) {
        put(k, config[k]);
      }

      // TIER_PRICES_JSON is set explicitly in config.env ({tier: cents}); pass it through,
      // validating it is a JSON object of integer cents. Price is runtime-only and never
      // enters the signed manifest, so it changes without a re-sign.
      const pricesStr = needCfg("TIER_PRICES_JSON");
      let prices: unknown;
      try {
        prices = JSON.parse(pricesStr);
      } catch {
        die("config.env: TIER_PRICES_JSON is not valid JSON");
      }
      if (!prices || typeof prices !== "object" || Array.isArray(prices)) {
        die('config.env: TIER_PRICES_JSON must be an object like {"cumulus":700,"nimbus":20000}');
      }
      for (const [tier, cents] of Object.entries(prices as Record<string, unknown>)) {
        if (!Number.isInteger(cents)) die(`config.env: TIER_PRICES_JSON (${tier}): integer cents required`);
      }
      put("TIER_PRICES_JSON", JSON.stringify(prices));

      // Secrets from secrets.env (required + optional SESSION_SECRET).
      put("AGENT_KEY", needSecret("AGENT_KEY"));
      put("COALITION_KEY", needSecret("COALITION_KEY"));

      // NO_STRIPE: Stripe is required only when a tier is actually listed for sale.
      // A self-hoster running their own nodes on Foundation collateral has no
      // customers and should never have needed a Stripe account — but both keys were
      // hard-required here, so env.json could not be built at all without one.
      //
      // ⚠️ Selling nothing means listing NO tiers. A tier priced at 0 is not
      // expressible: MT enforces a minimum (`TierInfo.minPriceCents`) and 422s anything
      // under it. Unrelated to a "free rental", which is an admin-ASSIGNED rental and
      // needs no Stripe account whatever the tier costs.
      const paidTiers = Object.keys(prices as Record<string, number>);
      if (paidTiers.length > 0) {
        const missing = ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"].filter((k) => !secrets[k]);
        if (missing.length > 0) {
          die(
            `secrets.env: ${missing.join(" and ")} required because you list PAID tier(s): ` +
              `${paidTiers.join(", ")}. Use TIER_PRICES_JSON={} to sell nothing and skip Stripe.`
          );
        }
        put("STRIPE_SECRET_KEY", secrets.STRIPE_SECRET_KEY);
        put("STRIPE_WEBHOOK_SECRET", secrets.STRIPE_WEBHOOK_SECRET);
      } else if (secrets.STRIPE_SECRET_KEY || secrets.STRIPE_WEBHOOK_SECRET) {
        // Present but not needed: pass them through rather than dropping a key the
        // operator deliberately set, since dropping it would be its own silent failure.
        if (secrets.STRIPE_SECRET_KEY) put("STRIPE_SECRET_KEY", secrets.STRIPE_SECRET_KEY);
        if (secrets.STRIPE_WEBHOOK_SECRET) put("STRIPE_WEBHOOK_SECRET", secrets.STRIPE_WEBHOOK_SECRET);
      } else {
        console.error("note: no paid tiers listed — building env.json without Stripe keys.");
      }
      put("SESSION_SECRET", secrets.SESSION_SECRET);

      // The signed manifest (bare, or the whole SignedProviderManifest wrapper),
      // minified to one line, served verbatim at /.well-known/mt-provider.json.
      put("MANIFEST_JSON", JSON.stringify(manifestObj));

      const out = JSON.stringify(pairs, null, 2) + "\n";
      if (outPath) {
        writeFileSync(outPath, out, { mode: 0o600 });
        console.error(
          `Wrote ${outPath} (${pairs.length} vars). Contains SECRETS — do NOT commit; ` +
            `import it into your Flux app's Environment Variables.`
        );
      } else {
        process.stdout.write(out);
      }
      break;
    }
    case "verify": {
      const inPath = flag(args, "--in") ?? die("--in <manifest.json> required");
      const raw = JSON.parse(readFileSync(inPath, "utf8"));
      // Accept either shape an operator can hold: a bare manifest, or the
      // 'authorize' wrapper they publish. Verifying the wrapper's top level
      // could only ever fail (it carries no `signature` of its own), which
      // told operators their VALID manifest was broken.
      const { manifest, ownerSignature } = unwrapManifest(raw);
      if (!verifyManifestObject(manifest)) {
        console.log("FAILED — manifest signature invalid");
        process.exit(1);
      }
      if (ownerSignature == null) {
        console.log("OK — manifest signature valid (bare manifest, no owner authorization)");
        break;
      }
      // A wrapper is only as good as its owner signature; verify it too rather
      // than reporting OK on the ed25519 alone. Mirrors the checks in `env`.
      const parsed = ProviderManifest.safeParse(manifest);
      if (!parsed.success) {
        console.log("FAILED — signed wrapper's manifest is invalid");
        process.exit(1);
      }
      if (!parsed.data.ownerAddress) {
        console.log("FAILED — signed manifest is missing ownerAddress");
        process.exit(1);
      }
      if (!verifyManifestOwnerSignature(parsed.data, ownerSignature)) {
        console.log("FAILED — owner wallet signature does not verify against ownerAddress");
        process.exit(1);
      }
      console.log(`OK — manifest + owner signature valid (owner ${parsed.data.ownerAddress})`);
      break;
    }
    case "authorize": {
      // Prove you control the manifest's ownerAddress by wallet-signing it, turning
      // MT's blind-TOFU pubkey pin into proven ownership. Two-step (no browser in a
      // one-shot container): print message + Zelcore deep link, then re-run with the
      // resulting --signature to emit the SignedProviderManifest MT ingests.
      const inPath = flag(args, "--in") ?? die("--in <manifest.json> required");
      const signature = flag(args, "--signature");
      const outPath = flag(args, "--out");

      const raw = JSON.parse(readFileSync(inPath, "utf8"));
      if (!verifyManifestObject(raw)) die(`${inPath}: manifest signature invalid — run 'sign' first`);
      const parsed = ProviderManifest.safeParse(raw);
      if (!parsed.success) die(`${inPath}: not a valid signed manifest:\n${parsed.error.message}`);
      const manifest = parsed.data;
      if (!manifest.ownerAddress) {
        die(
          "manifest has no ownerAddress — add your Flux/ZelID wallet address as \"ownerAddress\" " +
            "in the body, re-run 'sign', then 'authorize'."
        );
      }
      const message = manifestOwnerMessage(manifest);

      if (!signature) {
        // Step 1: show what to sign.
        console.log("Sign this EXACT message with the wallet that owns the address below,");
        console.log(`then re-run with --signature <base64> --out signed-manifest.json:\n`);
        console.log(`owner address: ${manifest.ownerAddress}\n`);
        console.log("─── message ───");
        console.log(message);
        console.log("───────────────\n");
        console.log("Zelcore deep link (or paste the message into ZelID/SSP 'Sign Message'):");
        console.log(buildZelcoreSignLink({ message }));
        break;
      }

      // Step 2: validate the signature and emit the SignedProviderManifest.
      if (!verifyManifestOwnerSignature(manifest, signature)) {
        die(
          "signature does not verify against the manifest's ownerAddress — check you signed the " +
            "exact message with the right wallet (and that ownerAddress matches)."
        );
      }
      // Embed the RAW manifest (not `manifest`, the zod-parsed copy) — zod defaults
      // would add fields and break the detached ed25519 signature MT re-derives.
      const signed = { manifest: raw, ownerSignature: signature };
      const out = JSON.stringify(signed, null, 2) + "\n";
      if (outPath) {
        writeFileSync(outPath, out);
        console.log(
          `Wrote signed manifest to ${outPath}. Publish it at your Coalition's ` +
            `/.well-known/mt-provider.json (or hand it to the MT admin to ingest).`
        );
      } else {
        process.stdout.write(out);
      }
      break;
    }
    default:
      console.log("usage: mt-manifest <keygen|init|sign|env|verify|authorize> [options]\n");
      console.log("  keygen    [--out <dir>]");
      console.log("  init      [--out <body.json>]");
      console.log("  sign      --key <pem> (--from-config <config.env> | --in <body.json>) [--out <manifest.json>]");
      console.log("  env       --from-config <config.env> --secrets <secrets.env> --manifest <manifest|signed-manifest.json> [--out <env.json>]");
      console.log("  verify    --in <manifest.json>");
      console.log("  authorize --in <manifest.json> [--signature <b64> --out <signed-manifest.json>]");
      process.exit(cmd ? 1 : 0);
  }
}

main();
