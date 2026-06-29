import { loadConfig } from "./config";
import { createStripe } from "./stripe";
import { createServer } from "./server";
import { collectStats } from "./stats";

const STATS_INTERVAL_MS = 5 * 60_000;

async function main() {
  const cfg = loadConfig();
  const stripe = createStripe(cfg.stripeSecretKey);

  await collectStats(cfg).catch((e) => console.error("[coalition] initial stats error:", e.message));
  setInterval(() => {
    collectStats(cfg).catch((e) => console.error("[coalition] stats error:", e.message));
  }, STATS_INTERVAL_MS);

  const server = createServer(stripe, cfg);
  server.listen(cfg.port, () => {
    console.log(`[coalition] provider=${cfg.providerSlug} listening on :${cfg.port} (mt=${cfg.mtBaseUrl})`);
  });

  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("[coalition] fatal:", err);
  process.exit(1);
});
