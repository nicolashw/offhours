/**
 * OffHours — human-readable CLI over collect().
 * Usage: npm run verify [-- --json] [-- --all] [-- --symbol AAPL,NVDA]
 */
import { collect, loadCfg, type Row } from "./collect.js";

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);
const arg = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);

const snap = await collect(loadCfg());

if (has("--json")) {
  console.log(JSON.stringify(snap, null, 2));
  process.exit(0);
}

const pct = (n: number, d: number) => `${((n / d) * 100).toFixed(1)}%`;
const age = (s?: number | null) => (s == null ? "-" : s < 5400 ? `${Math.round(s / 60)}m` : `${(s / 3600).toFixed(1)}h`);
const bps = (b?: number | null) => (b == null ? "-" : `${b > 0 ? "+" : ""}${b}`);
const usd = (n?: number | null) =>
  n == null ? "-" : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;

console.log(`\nOffHours — chain ${snap.chainId} @ block ${snap.block}   ${snap.ts}`);
console.log(`market: ${snap.market.phase.toUpperCase()} (${snap.market.etTime})${snap.market.offHours ? "  <- off-hours: the AMM is the live price, the feed is a frozen reference" : ""}`);
console.log(`registry ${snap.registryFetchedAt.slice(0, 16)}Z · pools ${snap.poolsDiscoveredAt.slice(0, 16)}Z`);
console.log(
  `quotes: ` +
    Object.entries(snap.quotes).map(([s, q]) => `${s}=${q.usd?.toFixed(s === "WETH" ? 2 : 4) ?? "n/a"}(${age(q.feedAgeSec)})`).join("  "),
);
const c = snap.counts;
console.log(
  `\nassets ${c.assets} · with Chainlink feed ${c.withFeed} (${pct(c.withFeed, c.assets)}) · with an AMM pool ${c.withPool} (${pct(c.withPool, c.assets)})`,
);
console.log(`premium computable ${c.priced}, of which ${c.trustworthy} sit on a pool with real depth (the rest are drained or near-empty pools quoting a fossil price)`);
console.log(`feeds past their own 24h heartbeat: ${c.beyondHeartbeat}\n`);

const table = (title: string, rows: Row[]) => {
  if (!rows.length) return;
  console.log(title);
  console.table(rows.map((r) => ({
    symbol: r.symbol,
    feed: r.feed?.price.toFixed(2) ?? "-",
    age: age(r.feed?.ageSec),
    state: r.feed?.state ?? "no feed",
    poolUsd: r.poolUsd?.toFixed(2) ?? "-",
    venue: r.best ? `${r.best.venue}/${r.best.quote}` : "-",
    live: r.livePools,
    depth: usd(r.depthUsd),
    disp: r.dispersionBps == null ? "-" : `${r.dispersionBps}`,
    premBps: bps(r.premiumBps),
    q: r.quality,
    pools: r.pools.length,
    uiMult: r.uiMultiplier?.toFixed(6) ?? "-",
  })));
};

const symbolFilter = arg("--symbol");
if (symbolFilter) {
  const want = new Set(symbolFilter.split(",").map((s) => s.trim().toUpperCase()));
  const rows = snap.rows.filter((r) => want.has(r.symbol.toUpperCase()));
  table(`— selected —`, rows);
  for (const r of rows) {
    console.log(`\n${r.symbol}  ${r.name}`);
    console.log(`  token ${r.token}  decimals ${r.decimals}  isin ${r.isin ?? "-"}`);
    console.log(`  uiMultiplier(on-chain) ${r.uiMultiplier ?? "-"}   restMultiplier ${r.restMultiplier ?? "-"}${r.multiplierMismatch ? "   <- MISMATCH" : ""}`);
    console.log(`  totalSupply raw ${r.rawTotalSupply?.toFixed(4) ?? "-"} -> multiplier-adjusted ${r.adjTotalSupply?.toFixed(4) ?? "-"}`);
    console.log(`  total depth ${usd(r.depthUsd)} across ${r.livePools} live pools of ${r.pools.length}   quality ${r.quality}   dispersion ${r.dispersionBps ?? "-"}bps   premium ${bps(r.premiumBps)}bps`);
    console.table([...r.pools].sort((x, y) => (y.quoteDepthUsd ?? 0) - (x.quoteDepthUsd ?? 0)).slice(0, 14).map((p) => ({
      venue: p.venue, quote: p.quote, fee: p.dynamicFee ? "dynamic" : p.fee,
      price: p.price.toPrecision(8), usd: p.priceUsd?.toFixed(4) ?? "-",
      depth: usd(p.quoteDepthUsd), used: p.outlier ? "outlier" : (p.quoteDepthUsd ?? 0) > 0 ? "yes" : "empty", hooks: p.hooks && p.hooks !== "0x0000000000000000000000000000000000000000" ? p.hooks : "",
      id: p.id.slice(0, 12) + "…",
    })));
  }
} else if (has("--all")) {
  table("— all assets —", snap.rows);
} else {
  const priced = snap.rows.filter((r) => r.quality === "ok").sort((a, b) => b.premiumBps! - a.premiumBps!);
  table(`— richest to the reference (top 8, depth-backed pools only) —`, priced.slice(0, 8));
  table(`— cheapest to the reference (bottom 8, depth-backed pools only) —`, priced.slice(-8).reverse());
  const ghosts = snap.rows.filter((r) => r.premiumBps != null && r.quality !== "ok")
    .sort((a, b) => Math.abs(b.premiumBps!) - Math.abs(a.premiumBps!));
  table(`— excluded: pools with no depth behind the price (would be the top movers on a naive dashboard) —`, ghosts.slice(0, 8));
  const stale = snap.rows.filter((r) => r.feed).sort((a, b) => b.feed!.ageSec - a.feed!.ageSec).slice(0, 8);
  table(`— most stale references (this is the oracle-risk signal) —`, stale);
  const odd = snap.rows.filter((r) => r.uiMultiplier != null && Math.abs(r.uiMultiplier - 1) > 1e-9);
  table(`— multiplier != 1.0: balanceOf() understates these positions —`, odd);
  const mism = snap.rows.filter((r) => r.multiplierMismatch);
  if (mism.length) table(`— on-chain vs REST multiplier disagree —`, mism);
  console.log(`(pass --all for every asset, or --symbol AAPL,NVDA for pool-level detail)\n`);
}
