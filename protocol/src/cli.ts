#!/usr/bin/env -S npx tsx
/**
 * mt-manifest — operator tooling to generate a signing key and produce a SIGNED
 * Provider Manifest for MoltenTech onboarding. Uses the same canonicalization +
 * ed25519 as MT's verifier (./signing), so a manifest this signs always verifies.
 *
 *   keygen [--out <dir>]                generate manifest-key.pem (KEEP SECRET) + print pubkey
 *   init   [--out <file>]               write a manifest body template to edit
 *   sign   --key <pem> --in <body.json> [--out <manifest.json>]
 *                                       fill pubkey + publishedAt, sign, emit full manifest
 *   verify --in <manifest.json>         re-verify a signed manifest
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ProviderManifestBody } from "./manifest";
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
  schemaVersion: 1,
  provider: {
    slug: "your-slug",
    name: "Your Operator Name",
    location: "City, Country",
    description: "Short description shown on the marketplace card.",
    contact: "ops@example.com",
  },
  fluxAppUrl: "https://your-flux-app.example",
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
      const inPath = flag(args, "--in") ?? die("--in <body.json> required");
      const outPath = flag(args, "--out");

      const priv = importPrivateKeyPem(readFileSync(keyPath, "utf8"));
      const body: Record<string, unknown> = JSON.parse(readFileSync(inPath, "utf8"));
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
        console.log(`Wrote signed manifest to ${outPath}. Publish it at your Flux App's /.well-known/mt-provider.json`);
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
      console.log("usage: mt-manifest <keygen|init|sign|verify> [options]\n");
      console.log("  keygen [--out <dir>]");
      console.log("  init   [--out <body.json>]");
      console.log("  sign   --key <pem> --in <body.json> [--out <manifest.json>]");
      console.log("  verify --in <manifest.json>");
      process.exit(cmd ? 1 : 0);
  }
}

main();
