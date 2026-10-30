/**
 * `fh-toolkit console-auth` — how an operator logs in to the nodes the agent provisions.
 *
 * Two lines of `.env.operator`, both stamped into a node's ArcaneOS config at PROVISION
 * (agent `executor.ts` → `ssh_pubkey` / `hashed_console`), so a change reaches only nodes
 * provisioned after the agent restarts:
 *
 *   OPERATOR_SSH_PUBKEY     an OpenSSH public key; empty = no key
 *   CONSOLE_PASSWORD_HASH   a crypt(3) hash; `!` (the agent's default) = password login locked
 *
 * The password is never stored, only its SHA-512 crypt hash (`$6$…`). ArcaneOS itself writes
 * yescrypt (`$y$…`), which Node has no implementation of; the shadow file accepts either, and
 * a yescrypt hash made elsewhere (`mkpasswd -m yescrypt`) is accepted as given.
 *
 * ⚠️ Both values are written single-QUOTED. Compose interpolates `$` in an `env_file` value,
 * so a bare `$6$salt$hash` reaches the agent as `$6` — measured on Compose v5.2.0, 10-29.
 */
import { createHash, randomBytes } from "node:crypto";

const CRYPT64 = "./0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const ROUNDS = 5000; // glibc's default: the hash then carries no `rounds=` field

function sha512(...parts: Buffer[]): Buffer {
  const h = createHash("sha512");
  for (const p of parts) h.update(p);
  return h.digest();
}

/** `n` bytes of `src` repeated — the P′ / S′ sequences of the spec. */
function repeatTo(src: Buffer, n: number): Buffer {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = src[i % src.length]!;
  return out;
}

/**
 * SHA-512 crypt, Ulrich Drepper's spec (https://www.akkadia.org/drepper/SHA-crypt.txt) — the
 * `$6$` that glibc's crypt(3) and `openssl passwd -6` produce. Default rounds only.
 */
export function sha512Crypt(password: string, salt?: string): string {
  const s = (salt ?? Array.from(randomBytes(16), (b) => CRYPT64[b % 64]).join("")).slice(0, 16);
  if (!/^[./0-9A-Za-z]+$/.test(s)) throw new Error("salt must be ./0-9A-Za-z");
  const P = Buffer.from(password, "utf8");
  const S = Buffer.from(s, "ascii");

  const B = sha512(P, S, P);
  const a = createHash("sha512").update(P).update(S);
  let i = P.length;
  for (; i > 64; i -= 64) a.update(B);
  a.update(B.subarray(0, i));
  for (let n = P.length; n > 0; n >>= 1) a.update(n & 1 ? B : P);
  const A = a.digest();

  const Pp = repeatTo(sha512(...Array(P.length).fill(P)), P.length);
  const Sp = repeatTo(sha512(...Array(16 + A[0]!).fill(S)), S.length);

  let C = A;
  for (let r = 0; r < ROUNDS; r++) {
    const c = createHash("sha512");
    c.update(r & 1 ? Pp : C);
    if (r % 3) c.update(Sp);
    if (r % 7) c.update(Pp);
    c.update(r & 1 ? C : Pp);
    C = c.digest();
  }

  const ORDER: Array<[number, number, number]> = [
    [0, 21, 42], [22, 43, 1], [44, 2, 23], [3, 24, 45], [25, 46, 4], [47, 5, 26], [6, 27, 48],
    [28, 49, 7], [50, 8, 29], [9, 30, 51], [31, 52, 10], [53, 11, 32], [12, 33, 54], [34, 55, 13],
    [56, 14, 35], [15, 36, 57], [37, 58, 16], [59, 17, 38], [18, 39, 60], [40, 61, 19], [62, 20, 41],
  ];
  let out = "";
  const b64 = (w: number, n: number) => {
    for (let k = 0; k < n; k++, w >>= 6) out += CRYPT64[w & 0x3f];
  };
  for (const [x, y, z] of ORDER) b64((C[x]! << 16) | (C[y]! << 8) | C[z]!, 4);
  b64(C[63]!, 2);
  return `$6$${s}$${out}`;
}

/** A crypt(3) hash the shadow file takes, or `!` (locked). Refuses a pasted PASSWORD. */
export function isConsoleHash(v: string): boolean {
  return v === "!" || /^\$(6|5|y|2[aby]|gy|7)\$[./0-9A-Za-z$=,]+$/.test(v);
}

const SSH_KEY_TYPES = [
  "ssh-ed25519",
  "ssh-rsa",
  "ecdsa-sha2-nistp256",
  "ecdsa-sha2-nistp384",
  "ecdsa-sha2-nistp521",
  "sk-ssh-ed25519@openssh.com",
  "sk-ecdsa-sha2-nistp256@openssh.com",
];

/**
 * Why `line` is not one OpenSSH public key (`<type> <base64> [comment]`), or null when it is.
 * The blob must name the same type as the prefix — arcane-mage parses the key with
 * `load_ssh_public_key` and fails the whole provision on a bad one, so it is caught here.
 */
export function sshPubkeyProblem(line: string): string | null {
  const parts = line.trim().split(/\s+/);
  const [type, blob] = parts;
  if (!type || !blob) return "an OpenSSH public key is `<type> <base64> [comment]` on one line (the .pub file)";
  if (type.includes("PRIVATE") || line.includes("-----BEGIN")) return "that is a PRIVATE key — give the .pub file";
  if (!SSH_KEY_TYPES.includes(type)) return `unknown key type${type.length <= 40 ? ` "${type}"` : ""} (expected ${SSH_KEY_TYPES.slice(0, 2).join(", ")}, ecdsa-…)`;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(blob)) return "the key's base64 part is damaged";
  const raw = Buffer.from(blob, "base64");
  const len = raw.length >= 4 ? raw.readUInt32BE(0) : -1;
  if (len < 0 || raw.subarray(4, 4 + len).toString("ascii") !== type) return "the key's base64 part does not match its type — copied whole?";
  return null;
}

/** The key alone, one line: `<type> <base64> [comment]` with whitespace collapsed. */
export function normalizeSshPubkey(line: string): string {
  return line.trim().split(/\s+/).join(" ");
}

/** `'…'` for `.env.operator` — see the ⚠️ above. Neither value can hold a `'`. */
export function quoteEnvValue(v: string): string {
  if (v.includes("'")) throw new Error("value cannot contain a single quote");
  return `'${v}'`;
}

/** A `.env.operator` value as Compose hands it to the agent: one layer of quotes off. */
export function unquoteEnvValue(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = v.match(/^'(.*)'$/) ?? v.match(/^"(.*)"$/);
  return m ? m[1] : v;
}
