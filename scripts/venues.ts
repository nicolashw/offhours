/**
 * OffHours — where the market-making income actually is.
 *
 * lp.ts answers "what would one position have earned" by replaying every swap
 * through it. That is exact but expensive, so it runs on one pool at a time.
 * This is the survey that decides which pool is worth that replay: for every V3
 * book with real reserves it measures the fee income the pool takes, the
 * reserves standing behind it, and who owns those reserves.
 *
 * The ratio that matters is fees over TVL. Any dollar added to a pool earns its
 * pro-rata share of the fees, so that ratio is the gross yield on new capital —
 * before the concentration a real position would run, and before the volatility
 * that pays for it. Ownership is measured because a book already provided
 * entirely by one continuously-rebalancing bot is a different proposition from
 * one with a dispersed set of LPs, even when the yield reads the same.
 *
 * Usage: npm run venues [-- --hours 2] [-- --top 25] [-- --json]
 */

import { decodeAbiParameters, encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadCfg, makeClient, multicall, withRetry, getLogsAdaptive, sleep } from "./rpc.js";

const SWAP = keccak256(toHex("Swap(address,address,int256,int256,uint160,uint128,int24)"));
const MINT = keccak256(toHex("Mint(address,address,int24,int24,uint128,uint256,uint256)"));

const args = process.argv.slice(2);
const arg = (f: string, d: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const hours = Number(arg("--hours", "2"));
const top = Number(arg("--top", "25"));

const cfg = loadCfg();
const client = makeClient(cfg);
const snap = JSON.parse(readFileSync("data/latest.json", "utf8"));

type Book = {
  symbol: string; pool: Address; quote: string; feePpm: number;
  tvlUsd: number; concentration: number; tokenUsd: number;
  quoteIsToken0?: boolean; qDec: number; tDec: number;
};

const books: Book[] = [];
for (const r of snap.rows) {
  for (const p of r.pools ?? []) {
    if (p.venue !== "v3" || (p.tvlUsd ?? 0) < 25_000) continue;
    books.push({
      symbol: r.symbol, pool: getAddress(p.id), quote: p.quote, feePpm: p.fee,
      tvlUsd: p.tvlUsd, concentration: (p.depthScore ?? 0) / (p.tvlUsd || 1),
      tokenUsd: r.poolUsd ?? 0, qDec: snap.quotes[p.quote]?.decimals ?? 18, tDec: r.decimals,
    });
  }
}
books.sort((a, b) => b.tvlUsd - a.tvlUsd);
const picked = books.slice(0, top);
process.stderr.write(`${picked.length} V3 books over $25k, ${new Set(picked.map((b) => b.symbol)).size} tokens\n`);

// token0 tells us which side of each Swap is the quote.
const t0abi = [{ type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const t0res = await multicall(client, cfg, picked.map((b) => ({
  target: b.pool, callData: encodeFunctionData({ abi: t0abi, functionName: "token0" }) })));
picked.forEach((b, i) => {
  if (!t0res[i]?.success) return;
  const t0 = (decodeAbiParameters([{ type: "address" }], t0res[i].returnData) as [Address])[0];
  b.quoteIsToken0 = t0.toLowerCase() === snap.quotes[b.quote]?.address?.toLowerCase();
});

const head = await withRetry(() => client.getBlockNumber(), "bn");
const span = BigInt(Math.round((hours * 3600) / 0.101));
const [b0, b1] = await Promise.all([
  withRetry(() => client.getBlock({ blockNumber: head - span }), "b0"),
  withRetry(() => client.getBlock({ blockNumber: head }), "b1"),
]);
const seconds = Number(b1.timestamp - b0.timestamp);
const perDay = 86400 / seconds;

process.stderr.write(`scanning swaps over ${(seconds / 3600).toFixed(1)}h...\n`);
const swapLogs = await getLogsAdaptive(
  client, { address: picked.map((b) => b.pool) as any, topics: [SWAP] }, head - span, head, undefined, 40_000n);
process.stderr.write(`${swapLogs.length} swaps\n`);

const byPool = new Map<string, { vol: number; swaps: number }>();
for (const l of swapLogs as any[]) {
  const b = picked.find((x) => x.pool.toLowerCase() === l.address.toLowerCase());
  if (!b || b.quoteIsToken0 === undefined) continue;
  const [a0, a1] = decodeAbiParameters([{ type: "int256" }, { type: "int256" }], `0x${l.data.slice(2, 130)}` as Hex) as [bigint, bigint];
  const q = Math.abs(Number(b.quoteIsToken0 ? a0 : a1)) / 10 ** b.qDec;
  const e = byPool.get(b.pool) ?? { vol: 0, swaps: 0 };
  e.vol += q * (snap.quotes[b.quote]?.usd ?? 0); e.swaps++;
  byPool.set(b.pool, e);
}

process.stderr.write(`scanning liquidity ownership...\n`);
type Own = { owners: number; topPct: number; topOwner: string; mints: number };
const ownership = new Map<string, Own>();
for (const [i, b] of picked.entries()) {
  try {
    const mints = await getLogsAdaptive(
      client, { address: b.pool, topics: [MINT] }, head - 250_000n, head, undefined, 125_000n);
    const liq = new Map<string, bigint>();
    for (const l of mints as any[]) {
      const owner = getAddress("0x" + l.topics[1].slice(26));
      const [amount] = decodeAbiParameters([{ type: "uint128" }], `0x${l.data.slice(2, 66)}` as Hex) as [bigint];
      liq.set(owner, (liq.get(owner) ?? 0n) + amount);
    }
    const total = [...liq.values()].reduce((t, v) => t + v, 0n);
    const sorted = [...liq.entries()].sort((x, y) => (y[1] > x[1] ? 1 : -1));
    ownership.set(b.pool, {
      owners: liq.size,
      topPct: total > 0n ? Number((sorted[0][1] * 10000n) / total) / 100 : 0,
      topOwner: sorted[0]?.[0] ?? "",
      mints: mints.length,
    });
  } catch { /* leave unknown */ }
  process.stderr.write(`  ${i + 1}/${picked.length} ${b.symbol}\n`);
  await sleep(120);
}

const rows = picked.map((b) => {
  const v = byPool.get(b.pool) ?? { vol: 0, swaps: 0 };
  const feesWindow = v.vol * (b.feePpm / 1e6);
  const feesDay = feesWindow * perDay;
  const o = ownership.get(b.pool);
  return {
    symbol: b.symbol, pool: b.pool, quote: b.quote, feeBps: b.feePpm / 100,
    tvlUsd: b.tvlUsd, volumeDayUsd: v.vol * perDay, swapsDay: Math.round(v.swaps * perDay),
    feesDayUsd: feesDay,
    yieldDayPct: b.tvlUsd > 0 ? (feesDay / b.tvlUsd) * 100 : 0,
    turnoverDay: b.tvlUsd > 0 ? (v.vol * perDay) / b.tvlUsd : 0,
    concentration: b.concentration,
    lpOwners: o?.owners ?? null, topLpPct: o?.topPct ?? null, topLp: o?.topOwner ?? null, mints: o?.mints ?? null,
    /** What $10k added to this book would take of the daily fees, before concentrating. */
    entrantDayUsd: b.tvlUsd > 0 ? feesDay * (10_000 / (b.tvlUsd + 10_000)) : 0,
  };
}).filter((r) => r.feesDayUsd > 0).sort((a, b) => b.yieldDayPct - a.yieldDayPct);

if (args.includes("--json")) {
  mkdirSync("data", { recursive: true });
  writeFileSync("data/venues.json", JSON.stringify({ ts: new Date().toISOString(), hours: seconds / 3600, rows }, null, 2) + "\n");
  console.log(JSON.stringify(rows, null, 2));
} else {
  const u = (n: number) => n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k` : `$${n.toFixed(0)}`;
  console.log(`\nwindow ${(seconds / 3600).toFixed(1)}h · ${swapLogs.length.toLocaleString()} swaps · figures per day\n`);
  console.table(rows.map((r) => ({
    token: r.symbol,
    fee: `${r.feeBps}bps`,
    TVL: u(r.tvlUsd),
    "volume/day": u(r.volumeDayUsd),
    "fees/day": u(r.feesDayUsd),
    "yield/day": `${r.yieldDayPct.toFixed(2)}%`,
    turnover: `${r.turnoverDay.toFixed(0)}x`,
    "LPs": r.lpOwners ?? "?",
    "top LP": r.topLpPct == null ? "?" : `${r.topLpPct.toFixed(0)}%`,
    "$10k earns/day": `$${r.entrantDayUsd.toFixed(0)}`,
  })));
  const lps = new Map<string, number>();
  for (const r of rows) if (r.topLp && (r.topLpPct ?? 0) > 50) lps.set(r.topLp, (lps.get(r.topLp) ?? 0) + 1);
  if (lps.size) {
    console.log(`\ndominant LPs (>50% of minted liquidity):`);
    for (const [a, n] of [...lps.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${a}  in ${n} of ${rows.length} books`);
  }
  console.log(`\n"$10k earns/day" is the pro-rata share of fees before concentrating a position,`);
  console.log(`and before the volatility that pays for it. Run \`npm run lp -- --symbol X\` for the risk side.\n`);
}
