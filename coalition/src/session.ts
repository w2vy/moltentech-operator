/**
 * Console session cookie (CV6 wallet-login read-gate). The cookie is a low-value
 * HMAC token that proves the browser completed a wallet login — it gates VIEWING
 * the console, nothing more. Every privileged ACTION is still individually
 * wallet-signed (the OwnerAuth blob), so a stolen cookie can read operational
 * state but CANNOT authorize a node action. The coalition stays keyless-for-actions;
 * the only secret here is the cookie-signing `SESSION_SECRET`.
 */
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const SESSION_COOKIE = "mt_console";

/** Fresh single-use challenge nonce (hex). */
export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

/**
 * The wallet app the login was signed with. Display-only: the sign pages show only that
 * wallet's button (every console signature comes from the same owner address). Unset for
 * a pasted-signature login or a cookie minted before this existed — those show both.
 */
export type LoginWallet = "ssp" | "zelcore";

/** Narrow an untrusted value to a `LoginWallet`, or undefined. */
export function parseLoginWallet(value: unknown): LoginWallet | undefined {
  return value === "ssp" || value === "zelcore" ? value : undefined;
}

/** Mint a `Set-Cookie` value binding `addr` for `ttlMs`, HMAC-signed with `secret`. */
export function mintSessionCookie(secret: string, addr: string, ttlMs: number, wallet?: LoginWallet): string {
  const payload = Buffer.from(
    JSON.stringify({ addr, exp: Date.now() + ttlMs, ...(wallet ? { wallet } : {}) }),
    "utf8"
  ).toString("base64url");
  const mac = createHmac("sha256", secret).update(payload).digest("hex");
  const maxAge = Math.floor(ttlMs / 1000);
  // Path=/console so it only rides console requests; Secure requires HTTPS (Flux
  // ingress in prod, Caddy tls internal on the testbed).
  return `${SESSION_COOKIE}=${payload}.${mac}; HttpOnly; Secure; SameSite=Strict; Path=/console; Max-Age=${maxAge}`;
}

/** Verify the session cookie from request headers; returns the bound addr (+ login wallet) or null. */
export function verifySession(
  secret: string,
  headers: IncomingHttpHeaders
): { addr: string; wallet?: LoginWallet } | null {
  const raw = readCookie(headers, SESSION_COOKIE);
  if (!raw) return null;
  const dot = raw.lastIndexOf(".");
  if (dot < 1) return null;
  const payload = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  const expected = createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const { addr, exp, wallet } = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      addr: string;
      exp: number;
      wallet?: unknown;
    };
    if (typeof exp !== "number" || exp <= Date.now() || typeof addr !== "string") return null;
    const w = parseLoginWallet(wallet);
    return w ? { addr, wallet: w } : { addr };
  } catch {
    return null;
  }
}

function readCookie(headers: IncomingHttpHeaders, name: string): string | null {
  const cookie = headers["cookie"];
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}
