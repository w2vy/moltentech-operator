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
 *   doctor [--dir <dir>] [--check-stripe] [--check-proxmox] [--check-hub]
 *                                       check that the generated files agree with each other.
 *                                       File-level and offline unless a --check-* flag asks
 *                                       otherwise: --check-stripe proves the webhook is on
 *                                       YOUR account, --check-proxmox proves the token works
 *                                       and the image storage does not spin, --check-hub proves
 *                                       the issued keys are still accepted by Flux Hub and by
 *                                       the DEPLOYED Coalition. All three read-only.
 *   sign   [--dir <dir>] [--key <pem>] [--from-config <config.env>] [--in <body.json>]
 *          [--out <manifest.json>] [--stdout]
 *                                       every path defaults to the file `init` wrote in <dir>,
 *                                       so re-signing after a config edit is `mt-manifest sign`.
 *                                       render body (from config.env) or read body.json,
 *                                       fill pubkey + publishedAt, sign, emit full manifest
 *   env    [--dir <dir>] [--from-config <config.env>] [--secrets <secrets.env>]
 *          [--manifest <manifest.json>] [--out <env.json>] [--stdout]
 *                                       every path defaults to the file `init` wrote in <dir>,
 *                                       so a finished scaffold needs no arguments at all.
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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { ProviderManifest, ProviderManifestBody, manifestOwnerMessage, unwrapManifest } from "./manifest";
import { renderManifestBodyFromConfig, parseConfigEnv } from "./manifest-config";
import { runDoctor, formatReport, fetchTierMinimums, TIER_FLOORS_CENTS } from "./config-lint";
import { probeStripeWiring } from "./stripe-wiring";
import { probeHub } from "./hub-probe";
import {
  probeProxmox,
  formatProbe,
  ssdImageStorages,
  isoStorages,
  describeStorage,
  type ProxmoxSurvey,
} from "./proxmox-probe";
import {
  DEFAULT_API_PORT,
  MAX_API_PORT,
  API_PORT_STRIDE,
  API_PORTS_PER_WAN,
  isFluxApiPort,
  parseLanNetwork,
  slotLanIp,
  isIPv4,
  vmNameProblem,
  SLUG_RE,
  type LanNetwork,
  generateAll,
  GENERATED_PATHS,
  fillManifestPubkey,
  needsMtPubkey,
  slotCountsByTier,
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

/**
 * Fill `.env.operator`'s MANIFEST_PUBKEY with the key just generated. Returns what
 * happened so `keygen` can report it — including "no-file", which is the normal case
 * for an operator who runs keygen before init.
 */
function backfillManifestPubkey(path: string, pubkey: string): "filled" | "already-set" | "no-file" {
  if (!existsSync(path)) return "no-file";
  const { text, result } = fillManifestPubkey(readFileSync(path, "utf8"), pubkey);
  if (result === "filled") writeFileSync(path, text, { mode: 0o600 });
  return result;
}

function die(msg: string): never {
  console.error(`error: ${msg}`);
  process.exit(1);
}

/**
 * The answers. Everything else in the five generated files is derived from these — in
 * particular COALITION_URL, which is asked for as a Flux APP NAME and derived, because
 * the URL is deterministic (`https://<app>.app.runonflux.io`) and asking for it
 * directly is what created the chicken-and-egg in the old runbook.
 *
 * ⚠️ Every value asked for here must also be readable from `--answers`, or the
 * scripted path writes a file the interactive path would have filled. That is exactly
 * how `MT_PUBKEY=` shipped empty to every non-interactive onboarding (operator#54).
 */
/**
 * MT's global signing pubkey, which the Coalition pins as `MT_PUBKEY` to verify that
 * inbound /checkout + /manage calls are really from MT.
 *
 * Returns "" when MT has signing disabled (503) or is unreachable, and SAYS SO — the
 * generated config.env still carries the key with an empty value, so the gap is visible
 * in the file rather than being an absent line nobody can notice. It is per-MT: a
 * Coalition moved between instances needs this changed as well as MT_BASE_URL.
 */
async function fetchMtPubkey(mtBaseUrl: string): Promise<string> {
  const url = `${mtBaseUrl.replace(/\/$/, "")}/api/mt-pubkey`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (res.status === 503) {
      console.log(`  → MT_PUBKEY: ${mtBaseUrl} has signing disabled (503) — leaving it blank.`);
      return "";
    }
    if (!res.ok) {
      console.log(`  ⚠ MT_PUBKEY: ${url} responded ${res.status} — leaving it blank, fill it in by hand.`);
      return "";
    }
    const pubkey = ((await res.json()) as { pubkey?: unknown } | null)?.pubkey;
    if (typeof pubkey !== "string" || !pubkey) {
      console.log(`  ⚠ MT_PUBKEY: ${url} returned no pubkey — leaving it blank, fill it in by hand.`);
      return "";
    }
    console.log(`  → MT_PUBKEY pinned from ${url}`);
    return pubkey;
  } catch (err) {
    console.log(`  ⚠ MT_PUBKEY: could not reach ${url} (${(err as Error).message}) — leaving it blank.`);
    return "";
  }
}

async function askAnswers(minimums: Record<string, number> = TIER_FLOORS_CENTS): Promise<Answers> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (q: string, def?: string): Promise<string> => {
    const a = (await rl.question(def ? `${q} [${def}]: ` : `${q}: `)).trim();
    return a || def || "";
  };
  /**
   * Ask until the answer is usable, printing WHY each time.
   *
   * Every rule here also exists in `validateAnswers`, which runs after the last question
   * and `die()`s — so a mistyped tier used to cost the whole wizard, thirty answers back.
   * Checking at the prompt is the same rule applied where the mistake is made, while the
   * operator is still looking at the question that caused it.
   */
  const askUntil = async (
    q: string,
    problem: (answer: string) => string | undefined,
    def?: string
  ): Promise<string> => {
    for (;;) {
      const answer = await ask(q, def);
      const why = problem(answer);
      if (!why) return answer;
      console.log(`    ${why}`);
    }
  };
  try {
    console.log("mt-manifest init — this writes every onboarding file from your answers.\n");

    // Asked FIRST because it decides which of the later questions exist at all. A
    // Supporter is not a degenerate operator — it is the level most participants will
    // hold, and it has no Stripe account to ask about, no prices to set, and nothing
    // listed for sale.
    console.log("Which are you?");
    console.log("  1) Flux Hub Supporter — your own nodes, plus Foundation nodes on your idle");
    console.log("     capacity. Nothing for sale, no Stripe account needed.");
    console.log("  2) Flux Hub Operator  — the above, plus hardware rented out through the");
    console.log("     marketplace. You are merchant of record on your own Stripe account.");
    const levelAnswer = await ask("  choose 1 or 2", "2");
    const level: "supporter" | "operator" = levelAnswer.startsWith("1") ? "supporter" : "operator";
    console.log(`  → Flux Hub ${level === "supporter" ? "Supporter" : "Operator"}\n`);

    const providerSlug = await askUntil("Provider slug (lowercase, PERMANENT once ingested)", (v) =>
      SLUG_RE.test(v)
        ? undefined
        : "lowercase letters, digits and hyphens, 3-40 characters, not starting or ending with a hyphen."
    );
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
    const which = await ask("Flux Hub environment — 1) production  2) staging", "1");
    const mtBaseUrl = which.startsWith("2") ? "https://staging.moltentech.us" : "https://www.moltentech.us";

    const fluxAppName = await ask("Flux app name for your Coalition", suggestFluxAppName(providerSlug));
    console.log(`  → COALITION_URL will be ${coalitionUrlFor(fluxAppName)}`);

    // Step 0.1 has already produced these by the time init runs, and leaving them for
    // later meant the agent could not make a single Proxmox call until the operator
    // hand-edited .env.operator. Asked, not derived — init holds no cluster to ask.
    // Prompts are labelled with the ENVIRONMENT VARIABLE each answer becomes, not with a
    // prose description of it. The operator is holding the output of Step 0.1 — two values
    // the runbook names as PROXMOX_TOKEN_ID and PROXMOX_TOKEN_SECRET — and matching those
    // names here removes the guess about which half goes where.
    console.log("\nProxmox API token (onboarding Step 0.1):");
    const proxmoxUrl = await ask("  Proxmox URL (an IP is safest — this runs inside a container)", "https://192.168.1.10:8006");
    const proxmoxTokenId = await ask("  PROXMOX_TOKEN_ID", "fluxhub@pve!agent");
    const proxmoxTokenSecret = await ask("  PROXMOX_TOKEN_SECRET (printed once when you created it)");

    // ⭐ Proved HERE, not five steps later in `mt-agent doctor`. A mistyped secret, a
    // path-scoped token, a URL the container cannot resolve — all of them used to
    // surface long after the step that caused them, in a different tool.
    //
    // Never fatal: this is a scaffolder, and an operator whose hypervisor is behind a
    // VPN or momentarily down must still be able to generate their files.
    let survey: ProxmoxSurvey | undefined;
    if (proxmoxUrl && proxmoxTokenId && proxmoxTokenSecret) {
      // Several seconds of silence with no cursor is indistinguishable from a hang, and
      // this is the one prompt that goes to the network before answering.
      console.log("  Wait while the token is verified…");
      const probe = await probeProxmox({
        url: proxmoxUrl,
        tokenId: proxmoxTokenId,
        tokenSecret: proxmoxTokenSecret,
      });
      console.log(formatProbe(probe.checks));
      survey = probe.survey;
      if (!probe.ok) {
        console.log("  → continuing anyway; fix the above, then re-run `mt-manifest doctor --check-proxmox`.");
      }
    }

    // ── Pricing, before inventory ────────────────────────────────────────────────
    // What you SELL is a business decision; what hardware you have is a stock-take.
    // Asking them in that order means the tier list exists before the slots do, so each
    // slot picks from it instead of inventing tier names the price map then has to chase.
    const tierPricesCents: Record<string, number> = {};
    if (level === "operator") {
      const known = Object.keys(minimums);
      const offered = (
        await askUntil(
          `Which tiers will you offer? (${known.join("/")}, comma-separated)`,
          (v) => {
            const picked = v.split(",").map((t) => t.trim()).filter(Boolean);
            if (picked.length === 0) return "name at least one tier.";
            const bad = picked.filter((t) => !known.includes(t));
            return bad.length > 0 ? `unknown tier(s): ${bad.join(", ")}. FH knows ${known.join(", ")}.` : undefined;
          },
          "cumulus"
        )
      )
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      // Prices in DOLLARS, then multiplied — which deletes the extra-zero class of bug
      // rather than validating against it.
      for (const tier of offered) {
        const floor = minimums[tier] ?? 0;
        const dollars = await askUntil(
          `  monthly price for ${tier} in DOLLARS (floor $${(floor / 100).toFixed(2)})`,
          (v) => {
            const cents = Math.round(Number(v) * 100);
            if (!/^\$?\d+(\.\d{1,2})?$/.test(v.trim())) return `"${v}" is not an amount in dollars.`;
            // FH 422s anything under the floor, so accepting it here only moves the
            // failure to a place with less context.
            return cents < floor ? `$${(cents / 100).toFixed(2)} is below the $${(floor / 100).toFixed(2)} floor FH enforces.` : undefined;
          },
          (floor / 100).toFixed(2)
        );
        tierPricesCents[tier] = Math.round(Number(dollars.replace("$", "")) * 100);
      }
    }
    const tiers = Object.keys(tierPricesCents);

    // Only an operator with something for sale has a Stripe account to be asked about.
    // The secret key exists already (dashboard → API keys); the WEBHOOK secret does not
    // — it is minted when the endpoint is created against the Coalition URL, which is a
    // real wait. Offer it, accept empty, and let `doctor` keep naming it.
    let stripeSecretKey = "";
    let stripeWebhookSecret = "";
    if (tiers.length > 0) {
      console.log("\nStripe — you are merchant of record; Flux Hub never holds these.");
      stripeSecretKey = await ask("  STRIPE_SECRET_KEY (rk_… / sk_…), blank to fill in later", "");
      stripeWebhookSecret = await ask("  STRIPE_WEBHOOK_SECRET (whsec_…), blank if the endpoint does not exist yet", "");
    } else {
      // Said out loud, not silently skipped: a Supporter who sees nothing here cannot tell
      // whether the tool forgot to ask or decided they do not need one.
      console.log("\nStripe — skipped: a Supporter sells nothing and needs no Stripe account.");
    }

    // ── Inventory, last, one host at a time ──────────────────────────────────────
    console.log("\nNow your hardware. Everything above was about you; this is a stock-take.");
    const hosts: HostAnswer[] = [];
    // Defaulted to what the cluster actually reports, so the names cannot be mistyped
    // and an operator who forgot a node sees it listed.
    const hostNames = (await ask("Proxmox host name(s), comma-separated", survey?.nodes.join(",")))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    // Ports are a property of the WAN IP, not of the host — one public address can front
    // slots on two different hypervisors, and those slots share the one block. Tracked
    // across the whole scaffold so a WAN IP reused on a second host resumes where it left
    // off instead of handing out 16127 twice.
    const usedPorts = new Map<string, Set<number>>();

    // Asked once and carried forward: hosts usually share a LAN, and re-typing it per
    // host is how one of them ends up on a different prefix by accident.
    let lastNetwork: string | undefined;

    for (const name of hostNames) {
      console.log(`\n— host ${name} —`);
      // The highest-value question in the list: a spinning-disk default wastes an entire
      // provision + benchmark cycle and reports NO cause. When the probe answered, the
      // safe options are printed and the default is one of them — the operator has to go
      // out of their way to pick a spinning disk instead of having to know not to.
      const options = survey?.storages[name] ?? [];
      const ssd = ssdImageStorages(options);
      const iso = isoStorages(options);
      if (options.length > 0) {
        // Only what this host can actually use is listed as a choice. A cluster defines
        // storages globally, so every host's storage list also carries the per-host VGs of
        // every OTHER host — printing those as "?" made the useful two lines hard to find.
        const here = options.filter((o) => o.active);
        const elsewhere = options.filter((o) => !o.active);
        console.log(`  storages on ${name}: ` + here.map((o) => `${o.id}(${describeStorage(o)})`).join(" "));
        if (elsewhere.length > 0) {
          console.log(`    (${elsewhere.length} more defined in the cluster but not usable here: ` +
            `${elsewhere.map((o) => o.id).join(", ")})`);
        }
        if (ssd.length === 0) {
          console.log("  ⚠ no storage on this host resolved to solid state — check the answer you give below.");
        }
      }
      const storageImages = await ask(`  storage pool for VM images on ${name} (must be SSD)`, ssd[0]?.id);
      const chosen = options.find((o) => o.id === storageImages);
      if (chosen?.rotational === true) {
        console.log(`  ⚠ ${storageImages} is ROTATIONAL: ${chosen.why}`);
        console.log("    Nodes on it provision fine and then fail every benchmark, with no visible cause.");
      }
      // Shared is the recommendation, and it is worth one line of why: the agent refreshes
      // the ArcaneOS ISO onto whatever each host names, so a shared target is staged ONCE
      // for the cluster while per-host storage is a copy per host to keep current.
      if (iso[0]?.shared) {
        console.log(`  ${iso[0].id} is shared — one ISO for the whole cluster, refreshed in one place.`);
      }
      const storageIso = await ask(`  storage holding the ArcaneOS ISO on ${name}`, iso[0]?.id ?? "pve55-shared");

      const capacity = Math.max(1, Math.trunc(Number(await ask(`  how many node slots does ${name} support?`, "1"))) || 1);

      // ── Slots, grouped by WAN IP ────────────────────────────────────────────────
      // A host is not one public address. pve40 fronts several, and each WAN IP carries
      // its own LAN — so WAN IP is the OUTER loop and the LAN network is asked once per
      // WAN IP, not once per host and not once per slot. Asked per slot (the old shape),
      // the same address got retyped for every node on it, and Flux refuses a duplicated
      // WAN IP + port pair with an error that names neither.
      const slots: SlotAnswer[] = [];
      while (slots.length < capacity) {
        const ipAddress = await askUntil(
          `  WAN IP (blank when done — ${slots.length}/${capacity} placed)`,
          (v) => (v === "" || isIPv4(v) ? undefined : `"${v}" is not an IPv4 address. Flux needs the address itself, not a hostname.`),
          ""
        );
        if (!ipAddress) break;

        // ⭐ ONE answer for the whole LAN: gateway AND prefix. Asked separately, the prefix
        // is what gets left off a lanIp — and a bare lanIp silently becomes /32, so the
        // node boots with no route out and is reachable by nobody.
        let net: LanNetwork | undefined;
        while (!net) {
          const answer = await ask("    LAN gateway WITH prefix, e.g. 192.168.87.1/24", lastNetwork);
          try {
            net = parseLanNetwork(answer);
            lastNetwork = answer;
          } catch (e) {
            console.log(`      ${(e as Error).message}`);
          }
        }
        console.log(`    → VMs on ${net.base}x/${net.prefix}, gateway ${net.gateway}`);

        // ⭐ Ports restart at 16127 for every WAN IP. Two nodes on 16127 collide only when
        // they share a public address.
        const used = usedPorts.get(ipAddress) ?? new Set<number>();
        usedPorts.set(ipAddress, used);
        const firstFree = (): number => {
          let p = DEFAULT_API_PORT;
          while (used.has(p)) p += API_PORT_STRIDE;
          return p;
        };
        let nextPort = firstFree();

        while (slots.length < capacity) {
          // The block runs out at 16197 — that is WHY a WAN IP carries at most eight
          // slots. Rather than let the operator type a ninth port that Flux will not
          // serve, the loop moves itself on to the next WAN IP and says so.
          if (nextPort > MAX_API_PORT) {
            console.log(
              `    no port left on ${ipAddress}: ${DEFAULT_API_PORT}–${MAX_API_PORT} is the whole ` +
                `block (${API_PORTS_PER_WAN} slots). More capacity needs another WAN IP.`
            );
            break;
          }
          // The port prompt doubles as the "another node behind this WAN IP?" question, so
          // the common answer — Enter, take the next port — costs one keystroke, and moving
          // on costs one word.
          const portAnswer = await ask(`    Flux API port (Enter, or 'next' for the next WAN IP)`, String(nextPort));
          if (portAnswer.toLowerCase() === "next") break;
          const apiPort = Number(portAnswer);
          if (!isFluxApiPort(apiPort)) {
            // Named precisely, because both halves are load-bearing and neither is
            // guessable: Flux serves this block only, and a port off the stride overlaps
            // the previous node's ports — which surfaces as THAT node going unreachable.
            console.log(
              `      ${portAnswer} is not usable: Flux API ports run ${DEFAULT_API_PORT}–${MAX_API_PORT} ` +
                `in steps of ${API_PORT_STRIDE}, so they all end in ${DEFAULT_API_PORT % 10}.`
            );
            continue;
          }
          if (used.has(apiPort)) {
            console.log(`      ${apiPort} is already taken on ${ipAddress}.`);
            continue;
          }

          console.log(`    · slot ${slots.length + 1} of ${capacity}`);
          // Offered tiers when the operator priced some; otherwise every tier FH knows.
          // A tier that is not on the list is not a tier — it used to be accepted here and
          // rejected by validateAnswers after the last question.
          const allowed = tiers.length > 0 ? tiers : Object.keys(minimums);
          const tier = await askUntil(
            `      tier (${allowed.join("/")})`,
            (v) => (allowed.includes(v) ? undefined : `"${v}" is not one of: ${allowed.join(", ")}.`),
            allowed[0]
          );
          const vmName = await askUntil("      VM name", (v) =>
            slots.some((s) => s.vmName === v) || hosts.some((h) => h.slots.some((s) => s.vmName === v))
              ? `"${v}" is already used by another slot.`
              : vmNameProblem(v)
          );
          let lanIp = "";
          while (!lanIp) {
            const answer = await ask(`      LAN address — host number (e.g. 5 for ${net.base}5) or a full IP`);
            try {
              lanIp = slotLanIp(answer, net);
            } catch (e) {
              console.log(`        ${(e as Error).message}`);
            }
          }
          // Per slot, defaulted to the host's pool. Almost always the default — but a host
          // with two SSD pools has no other way to say which node lands where, and the
          // agent already honours `slot.storagePool ?? host.storageImages`.
          const storagePool = await ask("      storage pool (SSD)", storageImages);
          console.log(
            `    → ${lanIp}, gateway ${net.gateway}, WAN ${ipAddress}, API port ${apiPort}, storage ${storagePool}`
          );
          slots.push({
            tier,
            vmName,
            ipAddress,
            lanIp,
            gateway: net.gateway,
            apiPort,
            ...(storagePool && storagePool !== storageImages ? { storagePool } : {}),
          });
          // Advance from the port that was USED, not from a running count: an operator who
          // types 16157 to leave room for something else gets 16167 next, still on stride
          // and still inside the block.
          used.add(apiPort);
          nextPort = Math.max(apiPort + API_PORT_STRIDE, firstFree());
        }
      }
      hosts.push({ name, storageImages, storageIso, slots });
    }

    // Printed as WAN IP → ports, because that is the shape of the port-forward the
    // operator has to go and create. A flat range is not actionable when the slots sit
    // behind more than one public address.
    const byWan = new Map<string, number[]>();
    for (const h of hosts) for (const s of h.slots) byWan.set(s.ipAddress, [...(byWan.get(s.ipAddress) ?? []), s.apiPort]);
    if (byWan.size > 0) {
      console.log("\nThese must be reachable from outside your LAN, or Flux Hub cannot pull stats:");
      for (const [wan, ports] of byWan) console.log(`  ${wan} → ${ports.join(", ")}`);
    }

    // A Supporter lists nothing, so `tiers` is empty above and no price was asked.
    // Selling nothing is an EMPTY price list, never a tier priced at zero: FH enforces a
    // per-tier minimum and 422s anything under it, so a 0 is not even expressible.
    const draft: Answers = { providerSlug, providerName, ownerAddress, mtBaseUrl, fluxAppName, hosts, level };

    // DERIVED from the level, not asked. An Operator offers everything they declared; a
    // Supporter offers nothing. Holding slots back is a real thing to want, but it is a
    // later edit to config.env by someone who already knows why — not a question worth
    // putting in front of every first-time onboarding, where the honest default was the
    // answer every time. FH also clamps this to the live available count, so the number
    // here can never oversell.
    const counts = slotCountsByTier(draft);
    const availableSlots: Record<string, number> = {};
    for (const tier of tiers) availableSlots[tier] = counts[tier] ?? 0;
    if (tiers.length > 0) {
      console.log(
        `\nOffered for sale: ${tiers.map((t) => `${availableSlots[t]} ${t}`).join(", ")} ` +
          `(all of them — edit AGENT_LISTING_JSON in config.env to hold any back).`
      );
    }

    return {
      ...draft,
      providerLocation: providerLocation || undefined,
      providerContact: providerContact || undefined,
      selling: level === "operator",
      tierPricesCents,
      availableSlots,
      proxmoxUrl: proxmoxUrl || undefined,
      proxmoxTokenId: proxmoxTokenId || undefined,
      proxmoxTokenSecret: proxmoxTokenSecret || undefined,
      stripeSecretKey: stripeSecretKey || undefined,
      stripeWebhookSecret: stripeWebhookSecret || undefined,
    };
  } finally {
    rl.close();
  }
}

/**
 * Render + sign a manifest from config.env. Shared by `sign` and by `init`, which now
 * finishes the job rather than leaving the operator one undocumented command short of the
 * artifact its own closing steps told them to paste at /onboard.
 */
function signManifestFromConfig(configText: string, keyPem: string): Record<string, unknown> {
  const priv = importPrivateKeyPem(keyPem);
  let body: Record<string, unknown>;
  try {
    body = renderManifestBodyFromConfig(configText);
  } catch (e) {
    die((e as Error).message);
  }
  // The key is the source of truth for pubkey; stamp a fresh publishedAt.
  body.pubkey = publicKeyBase64FromPrivate(priv);
  body.publishedAt = new Date().toISOString();

  const parsed = ProviderManifestBody.safeParse(body);
  if (!parsed.success) die(`manifest body invalid:\n${parsed.error.message}`);

  const manifest = { ...body, signature: signManifestBody(body, priv) };
  if (!verifyManifestObject(manifest)) die("self-verification failed (internal)");
  return manifest;
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
      writeFileSync(join(dir, "manifest-pubkey.txt"), publicKeyBase64 + "\n", { mode: 0o600 });
      // The documented order is keygen THEN init, and `init` now REFUSES without a key —
      // so on a first run there is no .env.operator here yet and this is a no-op ("no-file").
      // It still earns its place for the ROTATION path (`keygen --force` beside files that
      // already exist). Only ever fills an EMPTY slot: a non-empty one is a deliberate pin,
      // and silently repointing it is how a rotation loses the old key.
      const backfilled = backfillManifestPubkey(join(dir, ".env.operator"), publicKeyBase64);
      console.log(`Wrote ${keyPath} (KEEP SECRET — this signs your manifest).`);
      console.log(`Public key (manifest "pubkey", also saved to manifest-pubkey.txt):\n${publicKeyBase64}`);
      if (backfilled === "filled") {
        console.log("Also filled MANIFEST_PUBKEY in .env.operator (mt-agent doctor pins against it).");
      } else if (backfilled === "already-set") {
        console.log(
          "note: .env.operator already pins a MANIFEST_PUBKEY — left as-is. If you are ROTATING, " +
            "update it by hand and re-onboard: MT still holds the old public half."
        );
      }
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

      // ⭐ The key is a PRECONDITION, and it is checked BEFORE the first question. It used
      // to be checked where its value is first USED — after every prompt and the MT_PUBKEY
      // fetch — so an operator without a key answered the whole wizard and then lost all
      // of it to a die(). A precondition that fires last is not a precondition.
      //
      // `keygen` first is the order the runbook teaches (Step 1) and the only one in which
      // MANIFEST_PUBKEY reaches .env.operator without hand-editing. Requiring it is also
      // the only way MANIFEST_KEY can be filled at all.
      const keyPath = join(dir, "manifest-key.pem");
      if (!existsSync(keyPath)) {
        die(
          `${keyPath} not found. Run \`mt-manifest keygen\` first — your signing key is your ` +
            `provider identity, and init fills MANIFEST_KEY and MANIFEST_PUBKEY from it.`
        );
      }

      // ⭐ ...and so is the overwrite check. It used to be derived from `generateAll()`,
      // which cannot run until every answer is in — so an operator re-running init in a
      // scaffolded directory answered the ENTIRE wizard and only then learned that nothing
      // would be written. Exactly the failure the key check above was moved to fix, in the
      // same function, missed because the two checks looked unrelated.
      const clobbered = GENERATED_PATHS.filter((f) => existsSync(join(dir, f)));
      if (clobbered.length > 0 && !force) {
        die(
          `refusing to overwrite existing file(s): ${clobbered.join(", ")}\n` +
            "  --force replaces them: manifest.json is re-signed, a NEW SESSION_SECRET is generated\n" +
            "  (logging out any open Coalition sessions), and data/inventory.json is rewritten —\n" +
            "  it is authoritative over slot edits made anywhere else. manifest-key.pem is never touched."
        );
      }

      // Same rule as doctor: ask MT for the live minimums, fall back to the bundled
      // table. Done before the prompts so the wizard quotes the real floor.
      const liveMinimums = await fetchTierMinimums(
        process.env.MT_BASE_URL ?? "https://www.moltentech.us"
      );
      if (!liveMinimums) {
        console.error("note: could not reach Flux Hub for live tier minimums — using this tool's bundled copy.");
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

      // DERIVED, never asked: MT publishes its signing pubkey, so making the operator
      // fetch and paste it only adds a step they can skip. Skipping it is a DELAYED
      // failure — onboarding, the agent and provisioning all succeed without it and
      // only checkout/manage breaks, long after the step that caused it.
      //
      // ⭐ This runs for BOTH paths on purpose. It used to live inside `askAnswers`, so
      // `init --answers` — the path CI drives, and the one a second operator is most
      // likely to use — silently wrote `MT_PUBKEY=` empty and shipped that delayed
      // failure by default. One call site is the fix; two is how it broke.
      //
      // After validateAnswers, so `mtBaseUrl` is known to be a usable https URL before
      // it is fetched: a garbage URL should produce the clear validation error, not a
      // confusing network warning ahead of it.
      if (needsMtPubkey(answers)) {
        answers.mtPubkey = await fetchMtPubkey(answers.mtBaseUrl);
      }

      const keyPem = readFileSync(keyPath, "utf8");
      // Exactly what the operator used to be told to produce by hand and paste into two
      // files. `base64 -w0` of the PEM — the single-line form agent/src/signing.ts decodes.
      const manifestKey = Buffer.from(keyPem, "utf8").toString("base64");
      // Prefer the file keygen wrote; derive from the key itself if it is missing, so a
      // deleted manifest-pubkey.txt cannot leave the pin empty (the failure that made
      // `mt-agent doctor`'s key check report `skip` on every onboarding so far).
      const pubkeyPath = join(dir, "manifest-pubkey.txt");
      let manifestPubkey: string;
      try {
        manifestPubkey = existsSync(pubkeyPath)
          ? readFileSync(pubkeyPath, "utf8").trim()
          : publicKeyBase64FromPrivate(importPrivateKeyPem(keyPem));
      } catch (e) {
        die(`${keyPath} is not a usable ed25519 private key: ${(e as Error).message}`);
      }
      // No external issuer, so there is nothing to wait for and no reason to send the
      // operator away to run openssl. Generated here rather than in the generator so the
      // generator stays pure and `--answers` can pin an existing value to keep sessions.
      const sessionSecret = answers.sessionSecret?.trim() || randomBytes(32).toString("hex");
      const files = generateAll(answers, { manifestPubkey, manifestKey, sessionSecret });
      // ⭐ inventory.json goes in data/, not beside the rest.
      //
      // That directory is bind-mounted into the agent container at /data, and the mount is
      // the DIRECTORY, not the file — a single-file mount pins the container to an inode
      // that any atomic editor save detaches, after which host edits silently stop
      // reaching the agent. Writing it flat meant the operator had to notice that and
      // build the directory themselves at Step 5; the layout is the same either way, so
      // the tool should produce it. Nothing else may go in there: the agent must never be
      // able to read .env.operator or manifest-key.pem.
      const outPathFor = (name: string): string =>
        name === "inventory.json" ? join(dir, "data", name) : join(dir, name);
      mkdirSync(join(dir, "data"), { recursive: true, mode: 0o700 });
      // ⭐ 0600 for EVERY generated file, not just the ones holding secrets.
      //
      // Two of these are credential files that were 0644 for no better reason than that
      // they are not called "secrets": `.env.operator` carries a live Proxmox token, and
      // env.json (written by `env`) carries the Stripe key. The rest are not secret, but a
      // per-file judgement is a rule someone has to re-make correctly every time a file is
      // added — and the one time it is made wrong is a token readable by every account on
      // the host. A uniform mode has no such failure mode.
      //
      // Nothing needs the group/other bits: `docker compose` reads .env.operator as the
      // INVOKING user, and the agent container runs as root, which reads a 0600 host file
      // through the bind mount regardless of its owner.
      //
      // ⚠️ Unless Docker runs with userns-remap, where the container's root maps to an
      // unprivileged host uid that cannot read data/inventory.json. That setup needs the
      // file group-readable and the group mapped — a deliberate change, not this default.
      for (const name of Object.keys(files)) {
        writeFileSync(outPathFor(name), files[name as keyof typeof files]!, { mode: 0o600 });
      }

      // ⭐ SIGN IT. init used to stop one command short of the artifact its own closing
      // steps then told the operator to paste at /onboard — "paste your manifest" with no
      // manifest anywhere on disk. Everything signing needs is in hand by now: the key it
      // required at the top, and the config.env it just wrote.
      //
      // ⚠️ A signed manifest is a SNAPSHOT of config.env. Edit config.env afterwards and
      // this file is stale — `doctor` compares the two and says so, which is the check
      // that makes signing here safe to do automatically.
      const manifest = signManifestFromConfig(files["config.env"]!, keyPem);
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });

      const prices = resolvedPrices(answers);
      // The full path, not `.`: this usually runs in a container whose /work IS the
      // operator's current directory, and "wrote them to ." leaves them looking for files
      // that are somewhere they cannot name.
      const outDir = resolve(dir);
      const where = outDir === "/work" ? `${outDir} (the directory you ran this from)` : outDir;
      const written = [...Object.keys(files), "manifest.json"]
        .map((f) => (f === "inventory.json" ? "data/inventory.json" : f))
        .join(", ");
      console.log(`Wrote ${written} to ${where}\n`);
      // Only steps that are genuinely still OUTSTANDING belong in this list. It used to
      // open with "1. mt-manifest keygen" — which init now requires to have happened
      // already — and with a base64-and-paste step init performs itself.
      // Pointed at explicitly: a generated README nobody is told about is a file nobody
      // opens, and this is the one written for the operator rather than for the tooling.
      console.log("⭐ README.txt explains every file here and what to run when.\n");
      console.log("Already done, from the key in this directory:");
      console.log("  ✓ MANIFEST_KEY   filled in secrets.env and .env.operator");
      console.log("  ✓ MANIFEST_PUBKEY pinned in .env.operator (`mt-agent doctor` now compares, not skips)");
      console.log("  ✓ SESSION_SECRET generated");
      console.log("  ✓ manifest.json signed — this is the file you paste at /onboard");
      console.log("    (edit config.env later and it goes stale; re-run `mt-manifest sign`)\n");
      console.log("Next, in order:");
      console.log(`  1. open ${answers.mtBaseUrl}/onboard, paste manifest.json, sign with ${answers.ownerAddress}`);
      console.log("     → issues AGENT_KEY, COALITION_KEY, COALITION_SIGNING_KEY for secrets.env");
      if (hasPaidTier(prices)) {
        console.log("  2. Stripe: create the webhook endpoint against your Coalition URL.");
        console.log("     ⚠️  the webhook secret is bound to THAT endpoint — a secret from another");
        console.log("         endpoint fails silently and checkout never completes.");
      } else {
        console.log("  2. Stripe: not needed — you are not listing anything for sale.");
      }
      // The step that used to be missing entirely. "deploy Flux app" is not something an
      // operator can act on: the app needs an environment, and nothing here said where it
      // comes from or that a command builds it. It is also the LAST thing that reads
      // secrets.env, so it belongs after /onboard has filled it in.
      console.log("  3. `mt-manifest doctor`   ← run it here; it checks every file agrees");
      console.log("  4. `mt-manifest env`      → env.json, the Flux \"Import Environment Variables\" blob");
      console.log("     built from config.env + secrets.env + manifest.json. CONTAINS SECRETS.");
      console.log("     then `docker compose up -d` here to start the agent (compose.yaml is written)");
      console.log(`  5. deploy Flux app "${answers.fluxAppName}" as an ENTERPRISE app, import env.json`);
      console.log(`     → ${coalitionUrlFor(answers.fluxAppName)}`);
      console.log("     ⚠️  enterprise, not standard: a standard Flux app's environment is");
      console.log("         WORLD-READABLE, and yours holds your Stripe key.");
      break;
    }
    case "doctor": {
      // The runbook's "which value must match where" table, executed. File-level by
      // DEFAULT: no network, no secrets held. Two opt-in flags cross that line on
      // purpose — `--check-stripe` and `--check-proxmox` — because the two failures
      // that cost the most (wrong Stripe account, spinning storage) are invisible to
      // any amount of file comparison. Without a flag, nothing here leaves the disk.
      const dir = flag(args, "--dir") ?? ".";
      const read = (f: string): string | undefined => {
        const p = join(dir, f);
        return existsSync(p) ? readFileSync(p, "utf8") : undefined;
      };
      // inventory.json sits beside the others during onboarding but is mounted at
      // data/ once the agent runs, so look in both rather than reporting it missing.
      const inventory = read(join("data", "inventory.json")) ?? read("inventory.json");
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
        manifestJson: read("manifest.json"),
        tierMinimums,
      });
      // Opt-in, because it is the only check that puts a secret in memory and the only
      // one that talks to a third party. Everything it does is a read-only GET. It
      // catches what no file can: a well-formed config wired to the WRONG Stripe
      // account, which fails only after a customer has paid.
      if (args.includes("--check-stripe")) {
        const secretsText = read("secrets.env");
        const operatorText = read(".env.operator");
        const secrets = secretsText ? parseConfigEnv(secretsText) : {};
        const operator = operatorText ? parseConfigEnv(operatorText) : {};
        const stripeSecretKey = secrets.STRIPE_SECRET_KEY || operator.STRIPE_SECRET_KEY;
        const coalitionUrl = configText ? parseConfigEnv(configText).COALITION_URL : undefined;
        if (!stripeSecretKey) {
          console.log("--check-stripe: no STRIPE_SECRET_KEY in secrets.env or .env.operator — skipped.\n");
        } else if (!coalitionUrl) {
          console.log("--check-stripe: no COALITION_URL in config.env — skipped.\n");
        } else {
          report.findings.push(
            ...(await probeStripeWiring({ stripeSecretKey, coalitionUrl, mtBaseUrl }))
          );
          report.filesChecked.push("stripe (live)");
        }
      }
      // Same opt-in bargain as --check-stripe: file-level doctor stays credential-free
      // and offline, and this flag is how you ask for the one thing no file can answer —
      // whether the token in .env.operator actually works, and whether the storage it
      // names spins. `init` runs these at the moment the token is typed; this is for
      // re-runs, and for an operator who filled the files in by hand.
      if (args.includes("--check-proxmox")) {
        const operatorText = read(".env.operator");
        const operator = operatorText ? parseConfigEnv(operatorText) : {};
        const url = operator.PROXMOX_URL;
        const tokenId = operator.PROXMOX_TOKEN_ID;
        const tokenSecret = operator.PROXMOX_TOKEN_SECRET;
        if (!url || !tokenId || !tokenSecret) {
          console.log("--check-proxmox: .env.operator is missing PROXMOX_URL / _TOKEN_ID / _TOKEN_SECRET — skipped.\n");
        } else {
          const probe = await probeProxmox({ url, tokenId, tokenSecret });
          console.log(`proxmox (live) — ${url}`);
          console.log(formatProbe(probe.checks) + "\n");
          for (const check of probe.checks) {
            if (check.status !== "fail") continue;
            report.findings.push({
              severity: "error",
              rule: "PROXMOX_CHECK_FAILED",
              file: ".env.operator",
              message: `${check.name}: ${check.detail}`,
            });
          }
          // The storage the operator actually configured, judged. This is the check that
          // exists because a `local-lvm` default on a WD Red provisions fine and then
          // fails every benchmark with nothing in any log to say why.
          const images = operator.PROXMOX_STORAGE_IMAGES;
          for (const [node, options] of Object.entries(probe.survey?.storages ?? {})) {
            const chosen = options.find((o) => o.id === images);
            if (chosen?.rotational === true) {
              report.findings.push({
                severity: "error",
                rule: "DOC_DEFAULT_STORAGE_IS_HDD",
                file: ".env.operator",
                message:
                  `PROXMOX_STORAGE_IMAGES="${images}" is ROTATIONAL on ${node} (${chosen.why}) — ` +
                  `nodes provision fine and then fail every benchmark, with no visible cause.`,
              });
            }
          }
          report.filesChecked.push("proxmox (live)");
        }
      }
      // The third opt-in probe, and the only one that proves a KEY rather than a
      // configuration. It exists because every passive signal an operator has is
      // key-blind: Flux Hub's stats pull is unauthenticated, so a Coalition holding a
      // dead credential presents exactly as a healthy one until a customer's checkout
      // fails. See hub-probe.ts for what is provable from here and what is not.
      if (args.includes("--check-hub")) {
        const secretsText = read("secrets.env");
        const operatorText = read(".env.operator");
        const secrets = secretsText ? parseConfigEnv(secretsText) : {};
        const operator = operatorText ? parseConfigEnv(operatorText) : {};
        const config = configText ? parseConfigEnv(configText) : {};
        if (!mtBaseUrl) {
          console.log("--check-hub: no MT_BASE_URL in config.env — skipped.\n");
        } else {
          const probe = await probeHub({
            mtBaseUrl,
            coalitionUrl: config.COALITION_URL,
            agentKey: secrets.AGENT_KEY || operator.AGENT_KEY,
            coalitionKey: secrets.COALITION_KEY || operator.COALITION_KEY,
            localPubkey: read("manifest-pubkey.txt"),
            localManifestJson: read("manifest.json"),
          });
          console.log(`hub (live) — ${mtBaseUrl}`);
          console.log(formatProbe(probe.checks) + "\n");
          report.findings.push(...probe.findings);
          report.filesChecked.push("hub (live)");
        }
      }
      const { text, ok } = formatReport(report);
      console.log(text);
      if (!ok) process.exit(1);
      break;
    }
    case "sign": {
      // Same defaults as `env`, for the same reason: every one of these names a file
      // `init` wrote into the directory you are standing in. The re-sign instruction that
      // `doctor` prints is the command an operator types most often, and it was 90
      // characters of paths they had no choice about.
      const dir = flag(args, "--dir") ?? ".";
      const inPath = flag(args, "--in");
      const keyPath = flag(args, "--key") ?? join(dir, "manifest-key.pem");
      const fromConfig = inPath ? flag(args, "--from-config") : (flag(args, "--from-config") ?? join(dir, "config.env"));
      const outPath = flag(args, "--out") ?? (args.includes("--stdout") ? undefined : join(dir, "manifest.json"));
      if (!existsSync(keyPath)) {
        die(`${keyPath} not found — run \`mt-manifest keygen\` first, or pass --key <pem>.`);
      }
      if (fromConfig && !existsSync(fromConfig)) die(`${fromConfig} not found — pass --from-config <config.env>.`);

      const keyPem = readFileSync(keyPath, "utf8");
      let manifest: Record<string, unknown>;
      if (fromConfig) {
        manifest = signManifestFromConfig(readFileSync(fromConfig, "utf8"), keyPem);
      } else {
        const priv = importPrivateKeyPem(keyPem);
        const body = JSON.parse(readFileSync(inPath!, "utf8")) as Record<string, unknown>;
        body.pubkey = publicKeyBase64FromPrivate(priv);
        body.publishedAt = new Date().toISOString();
        const parsed = ProviderManifestBody.safeParse(body);
        if (!parsed.success) die(`manifest body invalid:\n${parsed.error.message}`);
        manifest = { ...body, signature: signManifestBody(body, priv) };
        if (!verifyManifestObject(manifest)) die("self-verification failed (internal)");
      }

      const out = JSON.stringify(manifest, null, 2) + "\n";
      if (outPath) {
        // Same 0600 rule as everything `init` writes. Note writeFileSync only applies a
        // mode when it CREATES the file — re-signing over an existing manifest.json keeps
        // whatever mode that file already has.
        writeFileSync(outPath, out, { mode: 0o600 });
        console.log(`Wrote signed manifest to ${outPath}. Publish it at your Coalition's /.well-known/mt-provider.json`);
      } else {
        process.stdout.write(out);
      }
      break;
    }
    case "env": {
      // ⭐ Defaults, because `init` writes all four of these files under exactly these
      // names into one directory. Requiring three explicit paths meant the one command
      // standing between a finished scaffold and a deployable Flux app was also the
      // longest to type — and the runbook's own instruction ("run `mt-manifest env`")
      // did not actually work as written.
      const dir = flag(args, "--dir") ?? ".";
      const fromConfig = flag(args, "--from-config") ?? join(dir, "config.env");
      const secretsPath = flag(args, "--secrets") ?? join(dir, "secrets.env");
      const manifestPath = flag(args, "--manifest") ?? join(dir, "manifest.json");
      const outPath = flag(args, "--out") ?? (args.includes("--stdout") ? undefined : join(dir, "env.json"));
      for (const [what, path] of [
        ["config.env", fromConfig],
        ["secrets.env", secretsPath],
        ["manifest.json", manifestPath],
      ] as const) {
        if (!existsSync(path)) {
          die(
            `${path} not found. \`env\` assembles the Flux environment from the files \`init\` wrote ` +
              `(${what} among them) — run it in that directory, or pass --dir <dir>.`
          );
        }
      }

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
        writeFileSync(outPath, out, { mode: 0o600 });
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
      console.log("usage: mt-manifest <keygen|init|doctor|sign|env|verify|authorize> [options]\n");
      console.log("  keygen    [--out <dir>]");
      console.log("  init      [--out <dir>] [--answers <answers.json>] [--force]");
      console.log("  doctor    [--dir <dir>]");
      console.log("  sign      [--dir <dir>] [--key <pem>] [--from-config <config.env>|--in <body.json>]");
      console.log("            [--out <manifest.json>] [--stdout]   defaults to what `init` wrote");
      console.log("  env       [--dir <dir>] [--from-config <config.env>] [--secrets <secrets.env>]");
      console.log("            [--manifest <manifest|signed-manifest.json>] [--out <env.json>] [--stdout]");
      console.log("            defaults to the files `init` wrote in the current directory");
      console.log("  verify    --in <manifest.json>");
      console.log("  authorize --in <manifest.json> [--signature <b64> --out <signed-manifest.json>]");
      process.exit(cmd ? 1 : 0);
  }
}

main();
