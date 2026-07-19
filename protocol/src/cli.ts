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
 *                                       MANIFEST_JSON; passes TIER_PRICES_JSON through from config.env. --manifest may
 *                                       be a bare manifest OR an 'authorize' wrapper (owner-signed, shipped
 *                                       whole so MT ingests it owner-verified). Verifies the manifest (and any
 *                                       owner) signature first. Output contains SECRETS — never commit it.
 *   verify --in <manifest.json>         re-verify a signed manifest — accepts a bare manifest OR an
 *                                        'authorize' wrapper (whose owner signature is checked too)
 *   authorize --in <manifest.json>      print the owner-authorization message + a Zelcore
 *                                        deep link to sign (proves you control ownerAddress)
 *   authorize --in <manifest.json> --signature <b64> --out <signed-manifest.json>
 *                                        wrap the manifest + your wallet signature into the
 *                                        SignedProviderManifest MT ingests (proven identity)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderManifest, ProviderManifestBody, manifestOwnerMessage, unwrapManifest } from "./manifest";
import { renderManifestBodyFromConfig, parseConfigEnv } from "./manifest-config";
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
      put("STRIPE_SECRET_KEY", needSecret("STRIPE_SECRET_KEY"));
      put("STRIPE_WEBHOOK_SECRET", needSecret("STRIPE_WEBHOOK_SECRET"));
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
