#!/usr/bin/env -S npx tsx
/**
 * mt-authorize — owner-signer for privileged MoltenTech jobs (delete/reprovision/
 * move). The node owner authorizes an action by signing a canonical message with
 * their Flux wallet; the operator agent verifies it against its pinned OWNER_ADDRESS
 * (see verifyOwnerAuth), so even a compromised MT can't move or delete a node.
 *
 * In-wallet flow (preferred — the private key never leaves the wallet):
 *   1) mt-authorize prepare --action delete --provider <slug> --vm <name> --node <node> [--ttl 15]
 *        → prints the exact MESSAGE to sign (Zelcore/ZelID → "Sign Message") + a --claim token
 *   2) sign that message in your wallet, copy the signature
 *   3) mt-authorize assemble --claim <token> --signature <base64> [--owner <address>]
 *        → prints the OwnerAuth JSON to attach to the job
 *
 * Headless (a held key — W-priv leaves the wallet; use only if you accept that):
 *   mt-authorize sign --action delete --provider <slug> --vm <name> --node <node> \
 *                     --key <hex> [--type zelid|flux] [--ttl 15]
 *        → prints the OwnerAuth JSON (self-verified) + the signer address
 */
import { randomBytes } from "node:crypto";
import { JobAction, OwnerAuthClaim, OwnerAuth, ownerAuthMessage, isPrivilegedAction } from "./messages";
import { verifyOwnerAuth, signFluxMessage } from "./wallet";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/** Build (and validate) the owner-signed claim from CLI flags. */
function buildClaim(args: string[]): OwnerAuthClaim {
  const action = JobAction.parse(flag(args, "--action") ?? die("--action required"));
  if (!isPrivilegedAction(action)) die(`action '${action}' is not privileged (no authorization needed)`);
  const ttlMin = Number(flag(args, "--ttl") ?? 15);
  if (!Number.isFinite(ttlMin) || ttlMin <= 0) die("--ttl must be a positive number of minutes");
  const claim = {
    action,
    providerSlug: flag(args, "--provider") ?? die("--provider <slug> required"),
    vmName: flag(args, "--vm") ?? die("--vm <name> required"),
    nodeName: flag(args, "--node") ?? die("--node <node> required"),
    nonce: flag(args, "--nonce") ?? randomBytes(16).toString("hex"),
    expiresAt: new Date(Date.now() + ttlMin * 60_000).toISOString(),
  };
  const parsed = OwnerAuthClaim.safeParse(claim);
  if (!parsed.success) die(`invalid claim:\n${parsed.error.message}`);
  return parsed.data;
}

const encodeClaim = (c: OwnerAuthClaim): string => Buffer.from(JSON.stringify(c), "utf8").toString("base64");
function decodeClaim(token: string): OwnerAuthClaim {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(token, "base64").toString("utf8"));
  } catch {
    die("--claim is not a valid token (from `mt-authorize prepare`)");
  }
  const parsed = OwnerAuthClaim.safeParse(raw);
  if (!parsed.success) die(`--claim invalid:\n${parsed.error.message}`);
  return parsed.data;
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);

  switch (cmd) {
    case "prepare": {
      const claim = buildClaim(args);
      console.log("Sign this EXACT message in your Flux wallet (Zelcore/ZelID → Sign Message):");
      console.log("------------------------------------------------------------");
      console.log(ownerAuthMessage(claim));
      console.log("------------------------------------------------------------");
      console.log(`Expires ${claim.expiresAt}. Then run:\n`);
      console.log(`  mt-authorize assemble --claim ${encodeClaim(claim)} --signature <base64-from-wallet>\n`);
      break;
    }
    case "assemble": {
      const claim = decodeClaim(flag(args, "--claim") ?? die("--claim <token> required (from `prepare`)"));
      const signature = flag(args, "--signature") ?? die("--signature <base64> required");
      const parsed = OwnerAuth.safeParse({ ...claim, signature });
      if (!parsed.success) die(`invalid authorization:\n${parsed.error.message}`);
      const auth = parsed.data;
      const owner = flag(args, "--owner");
      if (owner) {
        const v = verifyOwnerAuth(auth, owner);
        if (!v.ok) die(`self-verification against --owner failed: ${v.reason}`);
        console.error(`# verified against owner ${owner}`);
      }
      process.stdout.write(JSON.stringify(auth, null, 2) + "\n");
      break;
    }
    case "sign": {
      const claim = buildClaim(args);
      const key = flag(args, "--key") ?? die("--key <hex private key> required");
      const type = (flag(args, "--type") ?? "zelid") as "zelid" | "flux";
      if (type !== "zelid" && type !== "flux") die("--type must be zelid or flux");
      const { address, signature } = signFluxMessage(key, ownerAuthMessage(claim), { type });
      const auth: OwnerAuth = { ...claim, signature };
      const v = verifyOwnerAuth(auth, address);
      if (!v.ok) die(`self-verification failed (internal): ${v.reason}`);
      console.error(`# signer address ${address} — must equal the agent's pinned OWNER_ADDRESS`);
      process.stdout.write(JSON.stringify(auth, null, 2) + "\n");
      break;
    }
    default:
      console.log("usage: mt-authorize <prepare|assemble|sign> [options]\n");
      console.log("  prepare  --action <delete|reprovision|move> --provider <slug> --vm <name> --node <node> [--ttl 15] [--nonce <hex>]");
      console.log("  assemble --claim <token> --signature <base64> [--owner <address>]");
      console.log("  sign     --action ... --provider ... --vm ... --node ... --key <hex> [--type zelid|flux] [--ttl 15]");
      process.exit(cmd ? 1 : 0);
  }
}

main();
