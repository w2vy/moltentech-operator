import http from "node:http";
import { CheckoutInitRequest, ManageRequest } from "@moltentech/protocol";
import { readManifest, type CoalitionConfig } from "./config";
import type { StripeLike } from "./stripe";
import { handleCheckout, handleManage, handleWebhook } from "./payments";
import { getStatsSnapshot } from "./stats";
import { verifyMtRequest } from "./auth";
import {
  handleAgentPending,
  handleAgentAuthorizations,
  handleConsoleIndex,
  handleConsoleSign,
  handleConsoleAuthorize,
  handleSignStatus,
  handleZelcoreCallback,
  handleLoginPage,
  handleLoginSubmit,
  handleLoginCallback,
  handleLoginStatus,
  type ConsoleResult,
} from "./console";
import { verifySession } from "./session";
import { COALITION_VERSION } from "./version";

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * The inbound Coalition server. Public: the signed manifest + stats. Authenticated
 * (MT-issued coalitionKey): /checkout + /manage. Stripe-signed: /webhook (raw body).
 */
export function createServer(stripe: StripeLike, cfg: CoalitionConfig): http.Server {
  return http.createServer(async (req, res) => {
    // TEMP DEBUG (remove once the Zelcore-callback header mismatch is diagnosed):
    // log every inbound request so we can see exactly what Flux's ingress forwards
    // and whether Zelcore's callback attempt reaches us at all, on what path.
    console.error(
      `[debug/request] ${req.method} ${req.url} ` +
        `host=${JSON.stringify(req.headers["host"])} ` +
        `x-forwarded-host=${JSON.stringify(req.headers["x-forwarded-host"])} ` +
        `x-forwarded-proto=${JSON.stringify(req.headers["x-forwarded-proto"])} ` +
        `x-forwarded-for=${JSON.stringify(req.headers["x-forwarded-for"])} ` +
        `content-type=${JSON.stringify(req.headers["content-type"])} ` +
        `user-agent=${JSON.stringify(req.headers["user-agent"])}`
    );
    // Stamp every response with the running code version so MT (which pulls the
    // manifest + stats) can detect providers on an outdated coalition. setHeader
    // persists across whichever writeHead runs below.
    res.setHeader("X-Coalition-Version", COALITION_VERSION);
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    const sendResult = (r: ConsoleResult) => {
      res.writeHead(r.status, { "content-type": r.contentType, ...(r.headers ?? {}) });
      res.end(r.body);
    };
    try {
      const fullUrl = req.url ?? "/";
      const url = fullUrl.split("?")[0];
      const query = new URLSearchParams(fullUrl.split("?")[1] ?? "");
      const method = req.method ?? "GET";
      // The public origin this request came in on (through Caddy/Flux ingress), used
      // to build wallet callback URLs that point back to wherever the operator loaded
      // the page — not a hard-coded manifest field.
      const fProto = (String(req.headers["x-forwarded-proto"] ?? "http").split(",")[0] ?? "http").trim();
      const fHost = (String(req.headers["x-forwarded-host"] ?? req.headers["host"] ?? "").split(",")[0] ?? "").trim();
      const reqOrigin = fHost ? `${fProto}://${fHost}` : undefined;

      if (method === "GET" && url === "/.well-known/mt-provider.json") {
        try {
          const body = readManifest(cfg);
          res.writeHead(200, { "content-type": "application/json" });
          res.end(body);
        } catch {
          send(503, { error: "manifest not available" });
        }
        return;
      }
      if (method === "GET" && url === "/stats") {
        const snap = getStatsSnapshot();
        return snap ? send(200, snap) : send(503, { error: "stats not ready" });
      }
      if (method === "GET" && (url === "/health" || url === "/")) {
        return send(200, { ok: true, provider: cfg.providerSlug, coalitionVersion: COALITION_VERSION });
      }

      // Stripe webhook — verify on the RAW body (no JSON parse before signature check).
      if (method === "POST" && url === "/webhook") {
        const sig = (req.headers["stripe-signature"] as string) ?? "";
        const raw = await readBody(req);
        const status = await handleWebhook(stripe, cfg, raw, sig);
        return send(status, { received: status === 200 });
      }

      // MT -> Coalition: signature-authenticated (dual-accept legacy bearer). Read the
      // raw body first — the signature covers its hash, and we reject before parsing.
      if (method === "POST" && (url === "/checkout" || url === "/manage")) {
        const raw = await readBody(req);
        const authz = verifyMtRequest(cfg, "POST", url, raw, req.headers);
        if (!authz.ok) {
          return send(authz.status, { error: authz.error });
        }
        // Positive auth trace: the runbook's "confirm via:signature" needs a log line
        // on the success path (previously only failures were logged).
        console.log(`[coalition] POST ${url} authorized via=${authz.via}`);
        let json: unknown;
        try {
          json = JSON.parse(raw.toString() || "{}");
        } catch {
          return send(400, { error: "Invalid JSON" });
        }
        try {
          if (url === "/checkout") {
            const p = CheckoutInitRequest.safeParse(json);
            if (!p.success) return send(400, { error: "Invalid checkout request" });
            return send(200, await handleCheckout(stripe, cfg, p.data));
          } else {
            const p = ManageRequest.safeParse(json);
            if (!p.success) return send(400, { error: "Invalid manage request" });
            return send(200, await handleManage(stripe, p.data));
          }
        } catch (err) {
          return send(502, { error: (err as Error).message });
        }
      }

      // ── Owner-authorization courier (agent ⇄ console). ──
      // agent → coalition (manifest-signed): push pending / pull signed blobs.
      if (method === "POST" && url === "/agent/pending") {
        const raw = await readBody(req);
        return sendResult(handleAgentPending(cfg, raw, req.headers));
      }
      if (method === "GET" && url === "/agent/authorizations") {
        return sendResult(handleAgentAuthorizations(cfg, Buffer.alloc(0), req.headers));
      }
      // ── CV6 wallet-login (read-gate). Public: /console/login*. Gated (when
      // SESSION_SECRET set): the browser read/submit routes. NOT gated: the Zelcore
      // sign-callback (wallet-posted, no cookie — stays per-action-signature-gated)
      // and /agent/* (manifest-signed). ──
      if (method === "GET" && url === "/console/login") {
        return sendResult(handleLoginPage(cfg, reqOrigin));
      }
      if (method === "POST" && url === "/console/login") {
        const raw = await readBody(req);
        return sendResult(handleLoginSubmit(cfg, new URLSearchParams(raw.toString())));
      }
      if (method === "POST" && url === "/console/login-callback") {
        const raw = await readBody(req);
        return sendResult(handleLoginCallback(cfg, query, raw, String(req.headers["content-type"] ?? "")));
      }
      if (method === "GET" && url === "/console/login-status") {
        return sendResult(handleLoginStatus(cfg, query));
      }

      // Read-gate: when SESSION_SECRET is set, require a valid session for the
      // browser read/submit routes. Unset = open console (LAN/dev).
      const gated =
        (method === "GET" && (url === "/console" || url === "/console/sign" || url === "/console/sign-status")) ||
        (method === "POST" && url === "/console/authorize");
      if (cfg.sessionSecret && gated && !verifySession(cfg.sessionSecret, req.headers)) {
        // HTML pages → bounce to the login page; JSON/submit → 401.
        if (method === "GET" && (url === "/console" || url === "/console/sign")) {
          res.writeHead(302, { location: "/console/login" });
          return res.end();
        }
        return send(401, { error: "login required" });
      }

      // operator (browser): the console (read-gated above when login is enabled).
      if (method === "GET" && url === "/console") {
        return sendResult(handleConsoleIndex(cfg));
      }
      if (method === "GET" && url === "/console/sign") {
        // TEMP DEBUG (remove once the Zelcore-callback header mismatch is diagnosed):
        // print exactly what the Flux/Caddy ingress forwarded, since the Zelcore
        // callback URL is built from reqOrigin below.
        console.error(
          `[debug/console-sign] host=${JSON.stringify(req.headers["host"])} ` +
            `x-forwarded-host=${JSON.stringify(req.headers["x-forwarded-host"])} ` +
            `x-forwarded-proto=${JSON.stringify(req.headers["x-forwarded-proto"])} ` +
            `reqOrigin=${JSON.stringify(reqOrigin)}`
        );
        return sendResult(handleConsoleSign(cfg, query, reqOrigin));
      }
      // Sign page polls this to detect the Zelcore-callback (server-side) success.
      if (method === "GET" && url === "/console/sign-status") {
        return sendResult(handleSignStatus(query));
      }
      if (method === "POST" && url === "/console/authorize") {
        const raw = await readBody(req);
        return sendResult(handleConsoleAuthorize(cfg, new URLSearchParams(raw.toString())));
      }
      // Zelcore posts the signature back here automatically (deep-link callback).
      if (method === "POST" && url === "/console/zelcore-callback") {
        const raw = await readBody(req);
        return sendResult(handleZelcoreCallback(cfg, query, raw, String(req.headers["content-type"] ?? "")));
      }

      send(404, { error: "not found" });
    } catch (err) {
      console.error("[coalition] handler error:", (err as Error).message);
      send(500, { error: "internal" });
    }
  });
}
