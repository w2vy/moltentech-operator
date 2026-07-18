import { SCHEMA_VERSION } from "./common";

/**
 * Render a Provider Manifest *body* (unsigned; no `pubkey`/`publishedAt`/`signature`)
 * from an operator's `config.env` — the single file they edit in the coalition
 * template. This is the `sign --from-config` half of the manifest CLI: it keeps the
 * operator to ONE source of truth (config.env) that drives both the runtime coalition
 * config and the signed manifest, so the two can never drift.
 *
 * Mapping:
 *   PROVIDER_SLUG/NAME/LOCATION/DESCRIPTION/CONTACT -> provider.*
 *   COALITION_URL                                   -> coalitionUrl
 *   HOSTS=pve20,pve40,…                             -> hardware[{name}] (the owner-attested
 *                                                      Proxmox host rows; tiers/counts
 *                                                      derive from the agent's inventory)
 *   TRIAL_DAYS                                      -> trialDays
 *   MANUAL_APPROVAL ("true"/"false")                -> manualApproval
 *   OWNER_ADDRESS                                   -> ownerAddress (optional; the
 *                                                      wallet that authorizes this
 *                                                      manifest's pubkey — see below)
 *   (fixed)                                         -> serviceFlags defaults,
 *                                                      schemaVersion, trustedSelfClaim
 *
 * `OWNER_ADDRESS` may be a ZelID (`1…`) or a Flux (`t1…`) address — `verifyFluxSignature`
 * is address-form agnostic (tries both message magics), so either works as long as the
 * operator later `authorize`s the manifest with the matching wallet surface. It is the
 * SAME key already read by the `env` command (agent OWNER_ADDRESS) and the Coalition
 * console, so config.env stays the one source of truth. Omitting it renders a bare
 * (legacy, blind-TOFU) body exactly as before.
 *
 * Throws `Error` (never exits) on malformed input, so callers/tests can react.
 */
export function parseConfigEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    env[s.slice(0, i).trim()] = s.slice(i + 1).trim();
  }
  return env;
}

export function renderManifestBodyFromConfig(configText: string): Record<string, unknown> {
  const env = parseConfigEnv(configText);
  const need = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`config.env: ${k} is required`);
    return v;
  };

  const provider: Record<string, unknown> = { slug: need("PROVIDER_SLUG"), name: need("PROVIDER_NAME") };
  if (env.PROVIDER_LOCATION) provider.location = env.PROVIDER_LOCATION;
  if (env.PROVIDER_DESCRIPTION) provider.description = env.PROVIDER_DESCRIPTION;
  if (env.PROVIDER_CONTACT) provider.contact = env.PROVIDER_CONTACT;

  const coalitionUrl = need("COALITION_URL");

  // The owner-attested hardware list: the ProxmoxHost.name of every machine this operator
  // is allowed to serve from. MT pins these at ingest and rejects any inventory host that
  // isn't on the list, so a stolen agent key can't graft in a foreign machine.
  const hostsStr = need("HOSTS");
  const hardware = hostsStr
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name }));
  if (hardware.length === 0) throw new Error("config.env: HOSTS must list ≥1 host name");

  const body: Record<string, unknown> = {
    schemaVersion: SCHEMA_VERSION,
    provider,
    coalitionUrl,
    hardware,
    trialDays: Number(env.TRIAL_DAYS ?? 1),
    manualApproval: env.MANUAL_APPROVAL === "true",
    serviceFlags: { delegationAvailable: false, autoRenew: true, whiteLabel: false, languages: ["en"] },
    trustedSelfClaim: false,
  };
  // Optional owner wallet that authorizes this manifest's pubkey (proven, not blind,
  // TOFU). Included only when set, so a legacy config still renders a bare body.
  if (env.OWNER_ADDRESS) body.ownerAddress = env.OWNER_ADDRESS;
  return body;
}
