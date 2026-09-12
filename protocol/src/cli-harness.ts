/**
 * In-process test harness for the interactive commands: a scripted readline that
 * answers each prompt as it is printed, a fake hub, and a scaffolded operator directory.
 * Shared by the per-file command tests (slug has its own older copy of the first two).
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createInterface } from "node:readline/promises";
import { runCommand, type Ctx } from "./cli";
import { generateEd25519, exportPrivateKeyPem } from "./signing";
import type { NameCheckRequest, NameCheckResponse } from "./name-check";
import type { Answers } from "./scaffold";

/** Feed `answers` one per prompt. "" = Enter (take the default). */
export function scriptedRl(answers: string[]): { rl: ReturnType<typeof createInterface>; transcript: () => string } {
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

export type Hub = (req: NameCheckRequest) => Partial<NameCheckResponse>;

export const allFree: Hub = (req) => {
  const ok = (value: string) => ({ value, available: true });
  return {
    ...(req.slug ? { slug: ok(req.slug) } : {}),
    ...(req.vmNamePrefix ? { vmNamePrefix: ok(req.vmNamePrefix) } : {}),
    ...(req.name ? { name: ok(req.name) } : {}),
    ...(req.hostNames ? { hostNames: req.hostNames.map(ok) } : {}),
    ...(req.vmNames ? { vmNames: req.vmNames.map(ok) } : {}),
  };
};

/** Tier floors the fake hub serves — the same numbers as the bundled table. */
export const FLOORS = { cumulus: 250, nimbus: 700, stratus: 1400 };

export function fakeFetch(hub: Hub = allFree, seen: NameCheckRequest[] = []): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/onboard/check-names")) {
      const req = JSON.parse(String(init?.body)) as NameCheckRequest;
      seen.push(req);
      return new Response(JSON.stringify({ advisory: true, ...hub(req) }), { status: 200 });
    }
    if (url.endsWith("/api/mt-pubkey")) return new Response(JSON.stringify({ pubkey: "HUBKEY" }), { status: 200 });
    if (url.endsWith("/api/tiers")) {
      const tiers = Object.entries(FLOORS).map(([key, minPriceCents]) => ({ key, minPriceCents, listPriceCents: minPriceCents }));
      return new Response(JSON.stringify({ tiers }), { status: 200 });
    }
    return new Response("nope", { status: 404 });
  }) as unknown as typeof fetch;
}

export function ctxFor(dir: string, answers: string[], hub: Hub = allFree, seen: NameCheckRequest[] = []): { ctx: Ctx; transcript: () => string } {
  const { rl, transcript } = scriptedRl(answers);
  return { ctx: { dir, interactive: false, rl, fetch: fakeFetch(hub, seen) }, transcript };
}

/** Run `fn` with console.log captured. */
export const quiet = async <T>(fn: () => Promise<T>): Promise<{ result: T; log: string }> => {
  const orig = console.log;
  const origErr = console.error;
  let log = "";
  console.log = (...a: unknown[]) => void (log += a.join(" ") + "\n");
  console.error = (...a: unknown[]) => void (log += a.join(" ") + "\n");
  try {
    return { result: await fn(), log };
  } finally {
    console.log = orig;
    console.error = origErr;
  }
};

export const ANSWERS: Answers = {
  providerSlug: "acme-cloud",
  vmNamePrefix: "ac-",
  providerName: "Acme Cloud",
  ownerAddress: "1Owner",
  mtBaseUrl: "https://staging.moltentech.us",
  fluxAppName: "coalition-acme-cloud",
  level: "operator",
  tierPricesCents: { cumulus: 700 },
  proxmoxUrl: "https://10.0.0.2:8006",
  proxmoxTokenId: "fh-agent@pve!agent",
  proxmoxTokenSecret: "old-secret",
  stripeSecretKey: "rk_test_old",
  hosts: [
    {
      name: "pve-01",
      storageImages: "local-lvm",
      storageIso: "local",
      slots: [
        { tier: "cumulus", vmName: "ac-pve-01-c1", ipAddress: "203.0.113.1", lanIp: "10.0.0.5/24", gateway: "10.0.0.1", apiPort: 16127 },
        { tier: "cumulus", vmName: "ac-pve-01-c2", ipAddress: "203.0.113.1", lanIp: "10.0.0.6/24", gateway: "10.0.0.1", apiPort: 16137 },
      ],
    },
  ],
};

/** A temp dir with a signing key. */
export function keyedDir(prefix = "fh-cmd-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const { privateKey } = generateEd25519();
  writeFileSync(join(dir, "manifest-key.pem"), exportPrivateKeyPem(privateKey));
  return dir;
}

/** A fully scaffolded operator directory, as `init --answers` leaves it. */
export async function scaffolded(answers: Answers = ANSWERS): Promise<string> {
  const dir = keyedDir();
  writeFileSync(join(dir, "answers.json"), JSON.stringify(answers));
  const { result } = await quiet(() =>
    runCommand("init", ["--out", dir, "--answers", join(dir, "answers.json")], { dir, interactive: false, fetch: fakeFetch() })
  );
  if (result !== 0) throw new Error("scaffold failed");
  return dir;
}
