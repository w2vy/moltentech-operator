import { loadConfig } from "./config";
import { createStripe } from "./stripe";
import { createServer } from "./server";
import { collectStats } from "./stats";
import { checkCollateralOnce } from "./collateral";

const STATS_INTERVAL_MS = 5 * 60_000;
// Gates a customer-visible action (the Start cue), so poll faster than stats —
// matches the first-party central poller's retry cadence.
const COLLATERAL_INTERVAL_MS = 2 * 60_000;

async function main() {
  const cfg = loadConfig();
  // Deferred: `new Stripe(undefined)` throws at construction, so a free-tier operator
  // could never start. loadConfig has already refused the dangerous combination — a
  // PAID tier with no keys — so reaching here without a key means every tier is free.
  const stripe = cfg.stripeSecretKey ? createStripe(cfg.stripeSecretKey) : null;
  if (!stripe) console.log("[coalition] no Stripe key — nothing is listed for sale; payment routes disabled");

  await collectStats(cfg).catch((e) => console.error("[coalition] initial stats error:", e.message));
  setInterval(() => {
    collectStats(cfg).catch((e) => console.error("[coalition] stats error:", e.message));
  }, STATS_INTERVAL_MS);

  await checkCollateralOnce(cfg).catch((e) => console.error("[coalition] initial collateral check error:", e.message));
  setInterval(() => {
    checkCollateralOnce(cfg).catch((e) => console.error("[coalition] collateral check error:", e.message));
  }, COLLATERAL_INTERVAL_MS);

  const server = createServer(stripe, cfg);
  server.listen(cfg.port, () => {
    console.log(`[coalition] provider=${cfg.providerSlug} listening on :${cfg.port} (mt=${cfg.mtBaseUrl})`);
    // The startup auth readout the Phase D runbook asked for. It used to report which of
    // two paths this box would take; since Phase E step 4 there is only one, so it says so
    // flatly — a line that can only ever print one thing is still worth printing, because
    // its ABSENCE is how you spot a Coalition running an older image.
    console.log("[coalition] auth: outbound=signed inbound=signature (legacy bearers removed)");
    if (cfg.legacyBearersPresent.length > 0) {
      // Not a warning about danger — they authenticate nothing now. It is the only chance
      // the operator gets to be told the lines in their env.json are dead.
      console.log(
        `[coalition] ${cfg.legacyBearersPresent.join(" and ")} ` +
          `${cfg.legacyBearersPresent.length === 1 ? "is" : "are"} set but no longer used — safe to delete`
      );
    }
  });

  const stop = () => server.close(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((err) => {
  console.error("[coalition] fatal:", err);
  process.exit(1);
});
