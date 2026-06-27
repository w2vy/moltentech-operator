import http from "node:http";
import { readFileSync } from "node:fs";
import { CheckoutInitRequest, ManageRequest } from "@moltentech/protocol";
import type { FluxAppConfig } from "./config";
import type { StripeLike } from "./stripe";
import { handleCheckout, handleManage, handleWebhook } from "./payments";
import { getStatsSnapshot } from "./stats";

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * The inbound Flux App server. Public: the signed manifest + stats. Authenticated
 * (MT-issued fluxAppKey): /checkout + /manage. Stripe-signed: /webhook (raw body).
 */
export function createServer(stripe: StripeLike, cfg: FluxAppConfig): http.Server {
  return http.createServer(async (req, res) => {
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    try {
      const url = (req.url ?? "/").split("?")[0];
      const method = req.method ?? "GET";

      if (method === "GET" && url === "/.well-known/mt-provider.json") {
        try {
          const body = readFileSync(cfg.manifestPath, "utf8");
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
        return send(200, { ok: true, provider: cfg.providerSlug });
      }

      // Stripe webhook — verify on the RAW body (no JSON parse before signature check).
      if (method === "POST" && url === "/webhook") {
        const sig = (req.headers["stripe-signature"] as string) ?? "";
        const raw = await readBody(req);
        const status = await handleWebhook(stripe, cfg, raw, sig);
        return send(status, { received: status === 200 });
      }

      // MT -> Flux App, authenticated with the MT-issued key.
      if (method === "POST" && (url === "/checkout" || url === "/manage")) {
        if (req.headers["authorization"] !== `Bearer ${cfg.fluxAppKey}`) {
          return send(401, { error: "Unauthorized" });
        }
        let json: unknown;
        try {
          json = JSON.parse((await readBody(req)).toString() || "{}");
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

      send(404, { error: "not found" });
    } catch (err) {
      console.error("[flux-app] handler error:", (err as Error).message);
      send(500, { error: "internal" });
    }
  });
}
