/**
 * The bundle behind `fh-toolkit diagnose`: everything support would ask an operator to paste.
 *
 * This file is pure. The CLI gathers the inputs and writes the result; everything between,
 * which is the part that must never leak, is here where a test can reach it.
 *
 * ## How secrets stay out
 *
 * Three layers, because each one fails differently:
 *
 * 1. **Config goes through an approved list.** A key that is not on it reports only that it
 *    is set, so a key added next year stays private until someone decides otherwise.
 *    `secrets.env` reports names only, whatever the list says.
 * 2. **Free text is redacted.** Every value the operator's files hold is removed by exact
 *    match, which catches a secret no pattern could recognise. Patterns then catch secrets
 *    these files never held.
 * 3. **The finished bundle is scanned.** Any hit stops it. Structured fields are scanned and
 *    not redacted on purpose: a secret typed into an approved field means something is wrong
 *    with that field, and quietly blanking it would hide the problem.
 *
 * Log text can hold anything, so this bundle is data for a reader, never instructions.
 */
import type { BuildInfo } from "./build-info";
import type { DoctorReport, Finding } from "./config-lint";
import { normalizeInventory } from "./config-lint";
import type { ProxmoxSurvey } from "./proxmox-probe";

export const BUNDLE_FORMAT = "fh-diagnose/1";
export const LOG_TAIL_LINES = 2000;
/** How many of one line shape to keep, newest first. */
export const KEEP_PER_SHAPE = 20;
export const MAX_LINE_CHARS = 2000;
/** A few sentences. The logs and doctor carry the detail. */
export const MAX_NOTE_CHARS = 1000;

/** The temp file the wrapper writes. Anything else in FH_DIAGNOSE_LOGS is not ours to read. */
export const LOGS_FILE_RE = /^\.fh-diagnose-logs\.[A-Za-z0-9]+$/;

/** Keys whose VALUES may leave the box. Everything else reports "set" or "empty". */
const APPROVED_KEYS = new Set([
  "AGENT_DRY_RUN",
  "AGENT_INVENTORY_PATH",
  "AGENT_LISTING_JSON",
  "ARCANE_ISO",
  "COALITION_URL",
  "HOSTS",
  "MANIFEST_PATH",
  "MT_BASE_URL",
  "MT_PUBKEY",
  "OWNER_ADDRESS",
  "PORT",
  "PROVIDER_FLUX_PAYOUT_ADDRESS",
  "PROVIDER_LEVEL",
  "PROVIDER_LOCATION",
  "PROVIDER_NAME",
  "PROVIDER_REWARD_ADDRESS",
  "PROVIDER_SLUG",
  "PROVIDER_VM_PREFIX",
  "PROXMOX_NETWORK",
  "PROXMOX_STORAGE_IMAGES",
  "PROXMOX_STORAGE_IMPORT",
  "PROXMOX_STORAGE_ISO",
  "PROXMOX_TOKEN_ID",
  "PROXMOX_URL",
  "SESSION_TTL_HOURS",
  "TIER_PRICES_JSON",
  "TRIAL_DAYS",
]);

/** A key name that says its value is a credential, so finding that value anywhere stops the bundle. */
const CREDENTIAL_KEY = /KEY|SECRET|TOKEN|PASSWORD|HASH/;

/** Shorter values are too likely to be ordinary words to remove from a log. */
const MIN_SECRET_CHARS = 8;

interface SecretPattern {
  rule: string;
  re: RegExp;
  /** Keeps the leading group, so a log still says WHICH setting was removed. */
  keepPrefix?: boolean;
  /** Removed from free text, but not a reason to stop: an address is private, not a credential. */
  redactOnly?: boolean;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { rule: "private-key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g },
  { rule: "stripe-key", re: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{8,}/g },
  { rule: "stripe-webhook-secret", re: /\bwhsec_[A-Za-z0-9+/=]{8,}/g },
  { rule: "jwt", re: /\beyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{5,}/g },
  { rule: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { rule: "proxmox-api-token", re: /PVEAPIToken=\S+/g },
  { rule: "bearer-token", re: /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi },
  { rule: "password-hash", re: /\$(?:6|5|y|2[aby])\$[^\s'"]+/g },
  { rule: "login-in-url", re: /:\/\/[^\s/:@]+:[^\s/@]+@/g },
  {
    rule: "named-secret",
    // A value needs a digit or real length: "PROXMOX_TOKEN_SECRET: missing" is a finding to keep.
    re: /(\b[\w-]*(?:password|passwd|secret|token|api[_-]?key)[\w-]*["']?\s*[:=]\s*["']?)(?!\[redacted)(?=[^\s"',}]*\d|[^\s"',}]{16,})[^\s"',}]{6,}/gi,
    keepPrefix: true,
  },
  // Long enough to pass a 64-hex txid, which support needs to see.
  { rule: "long-base64", re: /(?<![A-Za-z0-9+/])[A-Za-z0-9+/]{80,}={0,2}/g },
  { rule: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}/gi, redactOnly: true },
];

export interface EnvFiles {
  config?: string;
  secrets?: string;
  operator?: string;
}

export type ConfigEntry = { state: "set" | "empty"; value?: string };

export interface EnvSummary {
  config: Record<string, Record<string, ConfigEntry>>;
  /** Every value to remove from free text. */
  secrets: string[];
  /** The subset that must stop the bundle if found anywhere. */
  credentials: string[];
}

function envEntries(text: string | undefined): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const raw of (text ?? "").split("\n")) {
    const s = raw.trim();
    if (!s || s.startsWith("#")) continue;
    const i = s.indexOf("=");
    if (i < 1) continue;
    // Hashes sit in single quotes in .env.operator; the bare value is what a log would show.
    const value = s.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    out.push([s.slice(0, i).trim(), value]);
  }
  return out;
}

export function summarizeEnv(files: EnvFiles): EnvSummary {
  const config: EnvSummary["config"] = {};
  const secrets = new Set<string>();
  const credentials = new Set<string>();
  const sources: Array<[string, string | undefined, boolean]> = [
    ["config.env", files.config, false],
    ["secrets.env", files.secrets, true],
    [".env.operator", files.operator, false],
  ];
  for (const [name, text, namesOnly] of sources) {
    if (text === undefined) continue;
    const section: Record<string, ConfigEntry> = {};
    for (const [key, value] of envEntries(text)) {
      const entry: ConfigEntry = { state: value ? "set" : "empty" };
      if (APPROVED_KEYS.has(key)) {
        if (!namesOnly && value) entry.value = value;
      } else if (value.length >= MIN_SECRET_CHARS) {
        secrets.add(value);
        if (namesOnly || CREDENTIAL_KEY.test(key)) credentials.add(value);
      }
      section[key] = entry;
    }
    config[name] = section;
  }
  return { config, secrets: [...secrets], credentials: [...credentials] };
}

export type RedactionCounts = Record<string, number>;

export function redactText(text: string, secrets: string[], counts: RedactionCounts): string {
  let out = text;
  // Longest first, so a value that contains another is removed whole.
  for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
    const parts = out.split(secret);
    if (parts.length > 1) {
      counts["config-value"] = (counts["config-value"] ?? 0) + parts.length - 1;
      out = parts.join("[redacted:config-value]");
    }
  }
  for (const { rule, re, keepPrefix } of SECRET_PATTERNS) {
    out = out.replace(re, (...m: string[]) => {
      counts[rule] = (counts[rule] ?? 0) + 1;
      return `${keepPrefix ? m[1] : ""}[redacted:${rule}]`;
    });
  }
  return out;
}

export interface Leak {
  /** Where in the bundle, e.g. `config.config.env.PROVIDER_NAME.value`. Never the value. */
  path: string;
  rule: string;
}

export function scanForLeaks(value: unknown, credentials: string[]): Leak[] {
  const leaks: Leak[] = [];
  const check = (text: string, path: string): void => {
    if (credentials.some((c) => text.includes(c))) leaks.push({ path, rule: "config-credential" });
    for (const { rule, re, redactOnly } of SECRET_PATTERNS) {
      if (!redactOnly && text.search(re) >= 0) leaks.push({ path, rule });
    }
  };
  const walk = (node: unknown, path: string): void => {
    if (typeof node === "string") check(node, path);
    else if (Array.isArray(node)) node.forEach((item, i) => walk(item, `${path}[${i}]`));
    else if (node && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        const here = path ? `${path}.${key}` : key;
        check(key, here);
        walk(item, here);
      }
    }
  };
  walk(value, "");
  return leaks;
}

/**
 * Drop repeats, keeping the newest of each line shape.
 *
 * Measured on staging 2026-11-04: an agent at rest logs two heartbeat lines a minute. Of
 * 9930 lines over 3.4 days, 9878 were those two and only 18 shapes existed at all, so a
 * plain tail of 2000 reached back 16 hours and showed nothing but heartbeats. A failure
 * from yesterday is the line support needs, and it is rare by nature, so rarity decides
 * what stays. The shape ignores the timestamp and every number.
 */
export function collapseRepeats(lines: string[]): { kept: string[]; repeats: Array<{ line: string; total: number; dropped: number }> } {
  const shapeOf = (line: string): string => line.replace(/^\d{4}-\d\d-\d\dT\S+\s/, "").replace(/\d+/g, "N");
  const seen = new Map<string, { line: string; total: number }>();
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    const shape = shapeOf(line);
    const entry = seen.get(shape) ?? { line, total: 0 };
    entry.total += 1;
    seen.set(shape, entry);
    if (entry.total <= KEEP_PER_SHAPE) kept.push(line);
  }
  const repeats = [...seen.values()]
    .filter((e) => e.total > KEEP_PER_SHAPE)
    .map((e) => ({ line: e.line, total: e.total, dropped: e.total - KEEP_PER_SHAPE }));
  return { kept: kept.reverse(), repeats };
}

export type LogsState =
  /** No file came through: an old wrapper, or a run with no wrapper. */
  | { status: "not-provided" }
  /** The wrapper ran from another directory than the one read. */
  | { status: "missing" }
  | { status: "read"; text: string };

const HOST_FIELDS = ["name", "nodeName", "network", "storageImages", "storageIso", "storageImport"];
const SLOT_FIELDS = ["vmName", "tier", "ipAddress", "lanIp", "gateway", "apiPort", "network", "storagePool"];

type Row = Record<string, unknown>;

function pick(row: Row, fields: string[]): Row {
  return Object.fromEntries(fields.filter((f) => row[f] !== undefined).map((f) => [f, row[f]]));
}

function inventoryHosts(text: string | undefined): Array<Row & { slots: Row[] }> | null {
  if (text === undefined) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const rows = normalizeInventory(parsed);
  if (!rows) return null;
  return (rows as Row[]).map((row) => ({
    ...pick(row, HOST_FIELDS),
    slots: (Array.isArray(row.slots) ? (row.slots as Row[]) : []).map((slot) => pick(slot, SLOT_FIELDS)),
  }));
}

function narrowSurvey(survey: ProxmoxSurvey) {
  const storages = Object.fromEntries(
    Object.entries(survey.storages).map(([node, options]) => [
      node,
      options.map(({ id, type, rotational, why, content, shared, active }) => ({ id, type, rotational, why, content, shared, active })),
    ])
  );
  const vms = Object.fromEntries(
    Object.entries(survey.vms ?? {}).map(([node, list]) => [
      node,
      list.map(({ vmid, name, status, cpus, maxmem, maxdisk, tags }) => ({ vmid, name, status, cpus, maxmem, maxdisk, tags })),
    ])
  );
  return { nodes: survey.nodes, storages, vms, memoryMb: survey.memoryMb ?? {} };
}

export interface BundleInput {
  now: Date;
  toolkit: BuildInfo;
  wrapper: string;
  agentRunning?: string;
  focusVm?: string;
  /** `--note`: the trouble in the operator's words. */
  note?: string;
  files: EnvFiles;
  report: DoctorReport;
  probeOutput: string[];
  inventoryText?: string;
  survey?: ProxmoxSurvey;
  logs: LogsState;
}

export function buildBundle(input: BundleInput) {
  const env = summarizeEnv(input.files);
  const redactions: RedactionCounts = {};
  const clean = (text: string): string => redactText(text, env.secrets, redactions);
  const cleanFinding = (f: Finding): Finding => ({
    ...f,
    message: clean(f.message),
    ...(f.summary !== undefined ? { summary: clean(f.summary) } : {}),
    ...(f.fix !== undefined ? { fix: clean(f.fix) } : {}),
  });

  let logLines: string[] = [];
  let logStatus: "collected" | "empty" | "not-provided" | "missing" = input.logs.status === "read" ? "empty" : input.logs.status;
  let logsTrimmed = false;
  let logRepeats: ReturnType<typeof collapseRepeats>["repeats"] = [];
  if (input.logs.status === "read") {
    // Redact whole, THEN split: a private key spans lines.
    const lines = clean(input.logs.text).split("\n");
    while (lines.at(-1)?.trim() === "") lines.pop();
    const { kept, repeats } = collapseRepeats(lines);
    logRepeats = repeats;
    logsTrimmed = kept.length > LOG_TAIL_LINES;
    logLines = kept.slice(-LOG_TAIL_LINES).map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l));
    if (logLines.length > 0) logStatus = "collected";
  }

  // Redacted like the logs: people paste things into a note.
  const note = clean(input.note?.trim() ?? "").slice(0, MAX_NOTE_CHARS) || null;
  const proxmox = input.survey ? narrowSurvey(input.survey) : null;
  const inventory = inventoryHosts(input.inventoryText);
  const vm = input.focusVm;
  const focus =
    vm === undefined
      ? null
      : {
          vm,
          proxmox:
            Object.entries(proxmox?.vms ?? {}).flatMap(([node, list]) => list.filter((v) => v.name === vm).map((v) => ({ node, ...v })))[0] ?? null,
          inventory:
            (inventory ?? []).flatMap((h) => h.slots.filter((s) => s.vmName === vm).map((s) => ({ host: h.name, ...s })))[0] ?? null,
        };

  const bundle = {
    format: BUNDLE_FORMAT,
    createdAt: input.now.toISOString(),
    toolkit: input.toolkit,
    wrapper: input.wrapper,
    agentRunning: input.agentRunning ?? "unknown",
    focus,
    note,
    config: env.config,
    doctor: {
      findings: input.report.findings.map(cleanFinding),
      filesChecked: input.report.filesChecked,
      minimumsSource: input.report.minimumsSource,
      unproven: (input.report.unproven ?? []).map(clean),
      probeOutput: input.probeOutput.map(clean),
    },
    inventory,
    proxmox,
    logs: { status: logStatus, trimmed: logsTrimmed, repeats: logRepeats, lines: logLines },
    redactions,
  };
  return { bundle, leaks: scanForLeaks(bundle, env.credentials) };
}

export type Bundle = ReturnType<typeof buildBundle>["bundle"];

export function bundleFileName(configText: string | undefined, createdAt: string): string {
  const slug = /^PROVIDER_SLUG=([a-z0-9-]+)/m.exec(configText ?? "")?.[1] ?? "operator";
  return `fh-diagnose-${slug}-${createdAt.slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}.json`;
}

/** What the operator reads before deciding to pass the file on. */
export function bundleSummary(bundle: Bundle): string[] {
  const errors = bundle.doctor.findings.filter((f) => f.severity === "error").length;
  const removed = Object.entries(bundle.redactions).map(([rule, n]) => `${rule} ×${n}`);
  const dropped = bundle.logs.repeats.reduce((n, r) => n + r.dropped, 0);
  const logNote: Record<string, string> = {
    collected:
      `${bundle.logs.lines.length} lines${bundle.logs.trimmed ? ` (the last ${LOG_TAIL_LINES})` : ""}` +
      (dropped > 0 ? `, ${dropped} repeats left out and counted` : ""),
    empty: "EMPTY: no agent output here. Is the agent running in this directory?",
    "not-provided": "NOT INCLUDED: run `fh-toolkit diagnose` at your shell prompt, not inside a session. If it stays missing, run `fh-toolkit --update-wrapper` first.",
    missing: "NOT INCLUDED: run this from your operator directory, without --dir.",
  };
  return [
    "",
    `Doctor findings: ${bundle.doctor.findings.length} (${errors} error${errors === 1 ? "" : "s"})`,
    `Proxmox survey:  ${bundle.proxmox ? `${bundle.proxmox.nodes.length} node(s)` : "NOT INCLUDED: Proxmox could not be reached"}`,
    `Inventory:       ${bundle.inventory ? `${bundle.inventory.length} host(s)` : "NOT INCLUDED: none found"}`,
    `Agent logs:      ${logNote[bundle.logs.status]}`,
    `Secrets removed: ${removed.length > 0 ? removed.join(", ") : "none found in the text"}`,
    ...(bundle.note ? [`Your note:       ${bundle.note}`] : []),
    ...(bundle.focus ? [`Focus VM:        ${bundle.focus.vm}${bundle.focus.proxmox || bundle.focus.inventory ? "" : " (not found in Proxmox or the inventory)"}`] : []),
  ];
}
