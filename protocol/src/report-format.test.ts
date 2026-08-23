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
  fix: "mt-manifest sign",
};
const WARN: Finding = {
  rule: "NOT_YET_FILLED",
  severity: "warning",
  file: "secrets.env",
  line: 17,
  message: "AGENT_KEY is empty — supplied by the /onboard web flow, after you sign.",
};

test("⭐ errors come first, whatever order the rules produced them in", () => {
  const OTHER: Finding = { ...ERR, rule: "ENV_DUPLICATED_ACROSS_FILES", fix: undefined, summary: undefined };
  const { text } = formatReport(report([WARN, OTHER]));
  const head = text.split("\n\n")[0]!.split("\n");
  assert.match(head[0]!, /^ERROR/);
  assert.match(head[1]!, /^warn/);
});

test("⭐ a finding with a one-command fix is the LAST line of the report", () => {
  // In the middle of a headline list it is one line among nine. Last, after the counts,
  // it is the next thing the operator types — which is what it is.
  const { text } = formatReport(report([ERR, WARN]));
  const lines = text.split("\n").filter(Boolean);
  assert.match(lines.at(-1)!, /\[MANIFEST_STALE\] .*re-run `mt-manifest sign`/);
  // ...and it is not ALSO in the headline block at the top.
  assert.match(lines[0]!, /^warn/);
});

test("the fix line is separated from the counts by a blank line", () => {
  const out = formatReport(report([ERR])).text;
  assert.match(out, /error\(s\).*\n\nERROR .*MANIFEST_STALE/s);
});

test("no fix-bearing finding means no trailing block", () => {
  const out = formatReport(report([WARN])).text;
  assert.match(out.split("\n").filter(Boolean).at(-1)!, /^checked /);
});

test("⭐ the headline carries the FIX, not the first half of the diagnosis", () => {
  const line = formatReport(report([ERR])).text.split("\n").filter(Boolean).at(-1)!;
  assert.match(line, /re-run `mt-manifest sign`/);
  assert.ok(line.length < 120, "a headline that wraps is not a headline");
  assert.ok(!line.includes("Pasting it at /onboard"), "detail belongs in the detail block");
});

test("the detail block still says everything, above the closing instruction", () => {
  const { text } = formatReport(report([ERR]));
  assert.match(text, /Pasting it at \/onboard would ingest the OLD values/);
  assert.ok(
    text.indexOf("Pasting it at /onboard") < text.indexOf("re-run `mt-manifest sign`"),
    "diagnosis, then the instruction that closes the report"
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

test("⭐ a headline never truncates inside brackets, leaving an unbalanced '('", () => {
  // Observed on prod 2026-08-23. Stripe quotes its own error verbatim inside our
  // parenthetical, so the first period landed mid-quote:
  //   "could not read the Stripe account (403: Permission denied."
  // — an unbalanced "(" that also cut off the half naming the permission to grant. A
  // headline that reads as a truncation bug costs more than the length it saved.
  const { text } = formatReport({
    filesChecked: ["secrets.env"],
    minimumsSource: "api",
    findings: [
      {
        rule: "STRIPE_ENDPOINTS_UNREADABLE",
        severity: "warning",
        file: "secrets.env",
        message:
          "could not list webhook endpoints (403: Permission denied. The provided key does " +
          "not have webhook_read). Grant it and re-run.",
      },
    ],
  });
  const headline = text.split("\n")[0]!;
  assert.doesNotMatch(headline, /\(403: Permission denied\.$/, "cut inside the parenthetical");
  assert.match(headline, /webhook_read\)\./, "the bracket closes before the headline ends");
});

test("brackets do not stop a headline that legitimately ends after them", () => {
  const { text } = formatReport({
    filesChecked: ["config.env"],
    minimumsSource: "api",
    findings: [
      { rule: "R", severity: "error", file: "config.env", message: "bad value (see above). More detail here." },
    ],
  });
  assert.match(text.split("\n")[0]!, /bad value \(see above\)\.$/);
});
