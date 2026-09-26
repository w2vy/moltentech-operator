/**
 * Proxmox API token setup — for the operator who reaches `fh-toolkit init` WITHOUT one.
 *
 * Step 0.1 of onboarding has the operator run four `pveum` lines as root. An operator who
 * skipped it met a prompt for a secret they did not have, and the only way on was to leave
 * the wizard. Now `askProxmox` asks first, and offers two ways to get a token:
 *
 *   1. `createAgentToken` does Step 0.1 through the Proxmox API, with the root@pam password
 *      typed once. It is used for this one login and never written anywhere.
 *   2. `tokenSetupCommands` prints the same four lines to paste into an ssh session.
 *
 * Both create exactly what the docs create (`docs/operator-onboarding.md` Step 0.1): role
 * `FluxHubAgent`, user `fh-agent@pve`, an ACL at `/`, and token `fh-agent@pve!agent` with
 * `privsep 0`. Unlike `proxmox-probe.ts` this file WRITES to the hypervisor, which is why
 * it lives apart from the read-only probe.
 */

import https from "node:https";
import { explainProxmoxError } from "./proxmox-probe";

const insecureAgent = new https.Agent({ rejectUnauthorized: false });

export const AGENT_ROLE = "FluxHubAgent";
export const AGENT_USER = "fh-agent@pve";
export const AGENT_TOKEN_NAME = "agent";
export const AGENT_TOKEN_ID = `${AGENT_USER}!${AGENT_TOKEN_NAME}`;

/** The documented FluxHubAgent role — docs/operator-onboarding.md Step 0.1, verbatim. */
export const AGENT_ROLE_PRIVS = [
  "VM.Allocate",
  "VM.Clone",
  "VM.Audit",
  "VM.Config.CDROM",
  "VM.Config.CPU",
  "VM.Config.Disk",
  "VM.Config.HWType",
  "VM.Config.Memory",
  "VM.Config.Network",
  "VM.Config.Options",
  "VM.Console",
  "VM.PowerMgmt",
  "Datastore.Allocate",
  "Datastore.AllocateSpace",
  "Datastore.AllocateTemplate",
  "Datastore.Audit",
  "SDN.Audit",
  "SDN.Use",
  "Sys.Audit",
];

/** The four lines an operator pastes as root on the Proxmox host. */
export function tokenSetupCommands(): string[] {
  return [
    `pveum role add ${AGENT_ROLE} -privs "${AGENT_ROLE_PRIVS.join(",")}"`,
    `pveum user add ${AGENT_USER}`,
    `pveum acl modify / --users ${AGENT_USER} --roles ${AGENT_ROLE}`,
    `pveum user token add ${AGENT_USER} ${AGENT_TOKEN_NAME} --privsep 0`,
  ];
}

export interface PveResponse {
  status: number;
  /** Proxmox puts its error text in the HTTP reason phrase, not the body. */
  reason: string;
  body: string;
}

export type PveRequest = (
  method: "GET" | "POST" | "PUT",
  url: string,
  path: string,
  opts?: { form?: Record<string, string>; ticket?: string; csrf?: string }
) => Promise<PveResponse>;

/** Body and headers for a Proxmox API call — pure, so the header rules are testable. */
export function pveRequestParts(opts: { form?: Record<string, string>; ticket?: string; csrf?: string } = {}): {
  body: string | undefined;
  headers: Record<string, string>;
} {
  const body = opts.form ? new URLSearchParams(opts.form).toString() : undefined;
  const headers: Record<string, string> = {};
  if (body !== undefined) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    // pveproxy refuses chunked uploads ("HTTP 501 chunked transfer encoding not supported"),
    // which is what node sends when no length is given. Found on the first live run, 09-26.
    headers["Content-Length"] = String(Buffer.byteLength(body));
  }
  if (opts.ticket) headers.Cookie = `PVEAuthCookie=${opts.ticket}`;
  if (opts.csrf) headers.CSRFPreventionToken = opts.csrf;
  return { body, headers };
}

export const pveRequest: PveRequest = (method, url, path, opts = {}) =>
  new Promise((resolve, reject) => {
    const { body, headers } = pveRequestParts(opts);
    const req = https.request(new URL(`${url}${path}`), { method, agent: insecureAgent, headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, reason: res.statusMessage ?? "", body: data }));
    });
    req.on("error", reject);
    req.setTimeout(10_000, () => req.destroy(new Error("timed out after 10s")));
    if (body) req.write(body);
    req.end();
  });

/**
 * Is anything answering as Proxmox at `url`? Unauthenticated `/version` is a 401 on every
 * PVE, so ANY HTTP status proves the URL; only a network failure is a no.
 */
export async function proxmoxAlive(
  url: string,
  req: PveRequest = pveRequest
): Promise<{ ok: true } | { ok: false; detail: string }> {
  try {
    await req("GET", url, "/api2/json/version");
    return { ok: true };
  } catch (e) {
    return { ok: false, detail: explainProxmoxError(e as Error, url) };
  }
}

const exists = (r: PveResponse): boolean => /already exists/i.test(`${r.reason} ${r.body}`);
const failed = (what: string, r: PveResponse): Error =>
  new Error(`${what} failed: HTTP ${r.status} ${r.reason}`.trim());

/**
 * Step 0.1 through the API. Re-runnable: an existing role is reset to the documented
 * privileges, and an existing user or ACL is fine. An existing TOKEN is not — Proxmox shows
 * a secret only when it is created, so there is nothing to read back.
 */
export async function createAgentToken(
  url: string,
  login: { username: string; password: string },
  req: PveRequest = pveRequest
): Promise<{ tokenId: string; tokenSecret: string }> {
  const t = await req("POST", url, "/api2/json/access/ticket", { form: login });
  if (t.status === 401) throw new Error(`login refused for ${login.username} — wrong password?`);
  if (t.status >= 400) throw failed("login", t);
  const data = (JSON.parse(t.body).data ?? {}) as { ticket?: string; CSRFPreventionToken?: string; NeedTFA?: number };
  if (data.NeedTFA || !data.ticket || !data.CSRFPreventionToken) {
    throw new Error(`${login.username} uses two-factor login, which this cannot complete — use the commands instead.`);
  }
  const auth = { ticket: data.ticket, csrf: data.CSRFPreventionToken };
  const privs = AGENT_ROLE_PRIVS.join(",");

  const role = await req("POST", url, "/api2/json/access/roles", { ...auth, form: { roleid: AGENT_ROLE, privs } });
  if (role.status >= 400) {
    if (!exists(role)) throw failed(`creating role ${AGENT_ROLE}`, role);
    const reset = await req("PUT", url, `/api2/json/access/roles/${AGENT_ROLE}`, { ...auth, form: { privs } });
    if (reset.status >= 400) throw failed(`updating role ${AGENT_ROLE}`, reset);
  }

  const user = await req("POST", url, "/api2/json/access/users", { ...auth, form: { userid: AGENT_USER } });
  if (user.status >= 400 && !exists(user)) throw failed(`creating user ${AGENT_USER}`, user);

  const acl = await req("PUT", url, "/api2/json/access/acl", {
    ...auth,
    form: { path: "/", users: AGENT_USER, roles: AGENT_ROLE },
  });
  if (acl.status >= 400) throw failed("granting the role at /", acl);

  const tok = await req("POST", url, `/api2/json/access/users/${encodeURIComponent(AGENT_USER)}/token/${AGENT_TOKEN_NAME}`, {
    ...auth,
    form: { privsep: "0" },
  });
  if (tok.status >= 400) {
    if (exists(tok)) {
      throw new Error(
        `token ${AGENT_TOKEN_ID} already exists, and Proxmox shows a secret only once. Use it if you have ` +
          `the secret, or remove it (pveum user token remove ${AGENT_USER} ${AGENT_TOKEN_NAME}) and run this again.`
      );
    }
    throw failed(`creating token ${AGENT_TOKEN_ID}`, tok);
  }
  const value = (JSON.parse(tok.body).data ?? {}) as { value?: string; "full-tokenid"?: string };
  if (!value.value) throw new Error("Proxmox created the token but returned no secret");
  return { tokenId: value["full-tokenid"] ?? AGENT_TOKEN_ID, tokenSecret: value.value };
}
