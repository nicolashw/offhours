/** OffHours — human-readable CLI over collect(). Usage: npm run verify [-- --json --dump-rest] */
import { collect, loadCfg } from "./collect.js";

const JSON_OUT = process.argv.includes("--json");
const DUMP_REST = process.argv.includes("--dump-rest");

const cfg = loadCfg();
const snap = await collect(cfg, { dumpRest: DUMP_REST });

if (JSON_OUT) {
  console.log(JSON.stringify(snap, null, 2));
} else {
  console.log(`\nOffHours verify — chain ${snap.chainId} @ block ${snap.block}  (${snap.ts})`);
  console.log(`tokens: ${snap.tokenSource}`);
  console.log(`factory: ${snap.factory ?? "n/a"}  WETH9: ${snap.weth9 ?? "n/a"}`);
  console.log(`ETH/USD: ${snap.ethUsd?.toFixed(2) ?? "n/a"}  (${snap.ethUsdSource})\n`);
  console.table(
    snap.rows.map((r) => ({
      symbol: r.symbol,
      feed: r.feedPrice?.toFixed(4) ?? "-",
      age: r.feedAgeSec != null ? `${Math.round(r.feedAgeSec / 60)}m${r.stale ? " !" : ""}` : "-",
      uiMult: r.uiMultiplier?.toFixed(6) ?? "-",
      poolUsd: r.poolUsd?.toFixed(4) ?? "-",
      quote: r.bestQuote ?? "-",
      premBps: r.premiumBps ?? "-",
      pools: r.pools?.length ?? 0,
      note: r.error ? r.error.slice(0, 36) : r.feed ? "" : "no feed",
    })),
  );
  console.log(`\n"!" = feed older than 1h. Feeds are deviation-triggered, so age is a signal in itself,`);
  console.log(`not just a data-quality flag: a stale reference means the pool is the only live price.\n`);
}
