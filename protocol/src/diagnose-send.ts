/**
 * Sends a `fh-toolkit diagnose` bundle to the hub and turns the reply into lines to print.
 *
 * The answer comes from an AI that read logs strangers can write to, so it is text to show and
 * nothing here acts on it. Control characters are removed so it cannot drive the terminal.
 */
import { randomBytes } from "node:crypto";
import {
  HEADER_AGENT_NONCE,
  HEADER_AGENT_SIGNATURE,
  HEADER_AGENT_SLUG,
  HEADER_AGENT_TIMESTAMP,
} from "./common";
import type { HubHttp } from "./hub-probe";
import { bodyHash, importPrivateKeyPem, signRequest, type RequestEnvelope } from "./signing";

const PATH = "/api/agent/diagnose";

/** The hub gives the AI 85 s and Cloudflare stops at 100 s, so this only catches a dead link. */
const SEND_TIMEOUT_MS = 110_000;

export const sendHttp: HubHttp = async (req) => {
  const res = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  return { status: res.status, text: await res.text().catch(() => ""), headers: {} };
};

export interface SendInput {
  mtBaseUrl: string;
  /** `MANIFEST_KEY` from secrets.env: base64 of the PKCS#8 PEM. */
  manifestKey: string;
  providerSlug: string;
  /** The bundle as compact JSON. */
  body: string;
}

export type SendResult =
  | { sent: true; lines: string[] }
  | { sent: false; lines: string[] };

const plain = (value: unknown): string =>
  // eslint-disable-next-line no-control-regex
  String(value ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, "");

const FILE_NOTE = "Your file is still here. Send it to Flux Hub support if you need help.";

export function answerLines(reply: Record<string, unknown>): string[] {
  const id = plain(reply.id);
  if (reply.status !== "answered") {
    return [
      "",
      "Flux Hub saved your file but has no AI answer right now.",
      `Contact Flux Hub support and quote ${id}.`,
    ];
  }
  const steps = Array.isArray(reply.steps) ? reply.steps.map(plain) : [];
  return [
    ...(reply.replay === true ? ["", `Nothing has changed since ${id}, so this is the same answer.`] : []),
    "",
    `Likely cause (${plain(reply.confidence)} confidence):`,
    ...plain(reply.cause).split("\n").map((l) => `  ${l}`),
    ...(steps.length > 0 ? ["", "What to do:", ...steps.map((s, i) => `  ${i + 1}. ${s}`)] : []),
    "",
    ...(reply.escalate === true ? ["This one needs a person. Contact Flux Hub support."] : []),
    `Support ID: ${id}. Quote it if you contact Flux Hub support.`,
  ];
}

/** The answer sits beside the file that was sent, under the same name. */
export function answerPath(bundlePath: string): string {
  return bundlePath.replace(/\.json$/, "") + ".answer.txt";
}

/** The hub's words for a 429. A hub or a reply that does not say why means the daily limit. */
export function refusalLine(text: string): string {
  try {
    const reply = JSON.parse(text) as { reason?: unknown; waiting?: unknown };
    if (reply.reason === "review") {
      const waiting = Array.isArray(reply.waiting) ? reply.waiting.map(plain).join(", ") : "";
      return `Flux Hub support has not reviewed your earlier answers yet${waiting ? ` (${waiting})` : ""}. You can send a new file once one is reviewed. A file with no changes still gets its saved answer.`;
    }
  } catch {
    // Not JSON: the daily line below is still the honest guess for a 429.
  }
  return "You reached the daily limit for diagnose. Try again tomorrow.";
}

export async function sendBundle(input: SendInput, http: HubHttp = sendHttp): Promise<SendResult> {
  const url = `${input.mtBaseUrl.replace(/\/+$/, "")}${PATH}`;
  let res: Awaited<ReturnType<HubHttp>>;
  try {
    const key = importPrivateKeyPem(Buffer.from(input.manifestKey, "base64").toString("utf8"));
    const env: RequestEnvelope = {
      method: "POST",
      path: PATH,
      slug: input.providerSlug,
      issuedAt: new Date().toISOString(),
      nonce: randomBytes(16).toString("hex"),
      bodyHash: bodyHash(input.body),
    };
    res = await http({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        [HEADER_AGENT_SIGNATURE]: signRequest(env, key),
        [HEADER_AGENT_TIMESTAMP]: env.issuedAt,
        [HEADER_AGENT_NONCE]: env.nonce,
        [HEADER_AGENT_SLUG]: input.providerSlug,
      },
      body: input.body,
    });
  } catch (err) {
    return { sent: false, lines: [`Could not reach ${url}: ${(err as Error).message}`, FILE_NOTE] };
  }

  if (res.status === 200) {
    try {
      return { sent: true, lines: answerLines(JSON.parse(res.text) as Record<string, unknown>) };
    } catch {
      return { sent: false, lines: ["Flux Hub sent back something unreadable.", FILE_NOTE] };
    }
  }
  const refused: Record<number, string> = {
    401: "Flux Hub rejected your signature. Run `fh-toolkit doctor --check-hub`.",
    404: "This Flux Hub does not offer diagnose yet.",
    413: "The file is too large to send.",
    429: refusalLine(res.text),
  };
  return { sent: false, lines: [refused[res.status] ?? `Flux Hub answered ${res.status}.`, FILE_NOTE] };
}
