#!/usr/bin/env -S npx tsx
/**
 * mt-manifest — operator tooling to generate a signing key and produce a SIGNED
 * Provider Manifest for MoltenTech onboarding. Uses the same canonicalization +
 * ed25519 as MT's verifier (./signing), so a manifest this signs always verifies.
 *
 *   keygen [--out <dir>]                generate manifest-key.pem (KEEP SECRET) + print pubkey
 *   init   [--out <file>]               write a manifest body template to edit
 *   sign   --key <pem> (--from-config <config.env> | --in <body.json>) [--out <manifest.json>]
 *                                       render body (from config.env) or read body.json,
 *                                       fill pubkey + publishedAt, sign, emit full manifest
 *   env    --from-config <config.env> --secrets <secrets.env> --manifest <manifest.json> [--out <env.json>]
 *                                       assemble the Flux "Import Environment Variables" blob (JSON array of
 *                                       "KEY=value"): non-secret config + secrets + the signed manifest as
 *                                       MANIFEST_JSON; derives TIER_PRICES_JSON from TIERS_JSON. Verifies the
 *                                       manifest signature first. Output contains SECRETS — never commit it.
 *   verify --in <manifest.json>         re-verify a signed manifest
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderManifestBody } from "./manifest";
import { renderManifestBodyFromConfig, parseConfigEnv } from "./manifest-config";
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
  tiers: [{ tier: "nimbus", capacity: 8, storagePool: "local-lvm" }],
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

function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "keygen": {
      const dir = flag(args, "--out") ?? ".";
      const { publicKeyBase64, privateKey } = generateEd25519();
      const keyPath = join(dir, "manifest-key.pem");
      writeFileSync(keyPath, exportPrivateKeyPem(privateKey), { mode: 0o600 });
      writeFileSync(join(dir, "manifest-pubkey.txt"), publicKeyBase64 + "\n");
      console.log(`Wrote ${keyPath} (KEEP SECRET — this signs your manifest).`);
      console.log(`Public key (manifest "pubkey", also saved to manifest-pubkey.txt):\n${publicKeyBase64}`);
      break;
    }
    case "init": {
      const out = flag(args, "--out") ?? "manifest.body.json";
      writeFileSync(out, JSON.stringify(BODY_TEMPLATE, null, 2) + "\n");
      console.log(`Wrote manifest body template to ${out} — edit it, then 'sign'.`);
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
      // placeholder or a tampered/unsigned manifest.
      const manifestObj = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (!verifyManifestObject(manifestObj)) die(`${manifestPath}: manifest signature invalid — run 'sign' first`);

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

      // TIER_PRICES_JSON (runtime pricing) derived from TIERS_JSON's per-tier priceCents.
      let tiers: unknown;
      try {
        tiers = JSON.parse(needCfg("TIERS_JSON"));
      } catch {
        die("config.env: TIERS_JSON is not valid JSON");
      }
      if (!Array.isArray(tiers) || tiers.length === 0) die("config.env: TIERS_JSON must be a non-empty array");
      const prices: Record<string, number> = {};
      for (const t of tiers as Array<{ tier?: unknown; priceCents?: unknown }>) {
        if (!t || typeof t.tier !== "string") die('config.env: each TIERS_JSON entry needs a "tier"');
        if (!Number.isInteger(t.priceCents)) die(`config.env: TIERS_JSON (${String(t.tier)}): integer "priceCents" is required`);
        prices[t.tier as string] = t.priceCents as number;
      }
      put("TIER_PRICES_JSON", JSON.stringify(prices));

      // Secrets from secrets.env (required + optional SESSION_SECRET).
      put("AGENT_KEY", needSecret("AGENT_KEY"));
      put("COALITION_KEY", needSecret("COALITION_KEY"));
      put("STRIPE_SECRET_KEY", needSecret("STRIPE_SECRET_KEY"));
      put("STRIPE_WEBHOOK_SECRET", needSecret("STRIPE_WEBHOOK_SECRET"));
      put("SESSION_SECRET", secrets.SESSION_SECRET);

      // The signed manifest, minified to one line, served at /.well-known/mt-provider.json.
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
      const ok = verifyManifestObject(raw);
      console.log(ok ? "OK — signature valid" : "FAILED — signature invalid");
      process.exit(ok ? 0 : 1);
    }
    default:
      console.log("usage: mt-manifest <keygen|init|sign|env|verify> [options]\n");
      console.log("  keygen [--out <dir>]");
      console.log("  init   [--out <body.json>]");
      console.log("  sign   --key <pem> (--from-config <config.env> | --in <body.json>) [--out <manifest.json>]");
      console.log("  env    --from-config <config.env> --secrets <secrets.env> --manifest <manifest.json> [--out <env.json>]");
      console.log("  verify --in <manifest.json>");
      process.exit(cmd ? 1 : 0);
  }
}

main();
