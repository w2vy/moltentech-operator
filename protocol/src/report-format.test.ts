import { test } from "node:test";
import assert from "node:assert/strict";
import { formatReport, type DoctorReport, type Finding } from "./config-lint";

/**
 * The report is READ, and it was not readable.
 *
 * A real run (prod-pve30, 2026-08-23) produced two errors and five warnings, each a
 * full-sentence message wrapping over several terminal lines, printed in file order — so
 * the routine "not yet filled" warnings came first and the error that actually stopped
 * the deployment could not be picked out at a glance.
 *
 * Two blocks: headlines you scan, then details you read. Errors first in both.
 */

const report = (findings: Finding[]): DoctorReport => ({
  findings,
  filesChecked: ["config.env", "manifest.json"],
  minimumsSource: "api",
});

const ERR: Finding = {
  rule: "MANIFEST_STALE",
  severity: "error",
  file: "manifest.json",
  message: "manifest.json was signed from an older config.env (differs at: coalitionUrl). Pasting it at /onboard would ingest the OLD values, correctly signed.",
  summary: "signed from an older config.env (coalitionUrl) — re-run `mt-manifest sign`",
};
const WARN: Finding = {
  rule: "NOT_YET_FILLED",
  severity: "warning",
  file: "secrets.env",
  line: 17,
  message: "AGENT_KEY is empty — supplied by the /onboard web flow, after you sign.",
};

test("⭐ errors come first, whatever order the rules produced them in", () => {
  const { text } = formatReport(report([WARN, ERR]));
  const head = text.split("\n\n")[0]!.split("\n");
  assert.match(head[0]!, /^ERROR/);
  assert.match(head[1]!, /^warn/);
});

test("⭐ the headline block carries the FIX, not the first half of the diagnosis", () => {
  const { text } = formatReport(report([ERR]));
  const first = text.split("\n")[0]!;
  assert.match(first, /re-run `mt-manifest sign`/);
  assert.ok(first.length < 120, "a headline that wraps is not a headline");
  assert.ok(!first.includes("Pasting it at /onboard"), "detail belongs in the second block");
});

test("the detail block still says everything, below the headlines", () => {
  const { text } = formatReport(report([ERR]));
  assert.match(text, /Pasting it at \/onboard would ingest the OLD values/);
  assert.ok(
    text.indexOf("re-run `mt-manifest sign`") < text.indexOf("Pasting it at /onboard"),
    "headline first"
  );
});

test("a one-sentence finding is NOT printed twice", () => {
  // Most findings are already a single sentence; repeating them verbatim would double the
  // length of the report to say nothing new.
  const { text } = formatReport(report([WARN]));
  assert.equal(text.split("AGENT_KEY is empty").length - 1, 1);
});

test("a headline is never truncated at an abbreviation", () => {
  // "…supplied by `pveum user token add` — the id, e.g." reads as a broken tool.
  const { text } = formatReport(
    report([
      {
        rule: "NOT_YET_FILLED",
        severity: "warning",
        file: ".env.operator",
        message: "PROXMOX_TOKEN_ID is empty — supplied by `pveum user token add` — the id, e.g. `fluxhub@pve!agent`. The agent cannot make a single Proxmox call until it is filled.",
      },
    ])
  );
  assert.match(text.split("\n")[0]!, /`fluxhub@pve!agent`\.$/);
});

test("a clean run says so and reports ok", () => {
  const { text, ok } = formatReport(report([]));
  assert.equal(ok, true);
  assert.match(text, /everything agrees/);
});

test("ok tracks errors only — warnings are not failures", () => {
  assert.equal(formatReport(report([WARN])).ok, true);
  assert.equal(formatReport(report([ERR])).ok, false);
});
