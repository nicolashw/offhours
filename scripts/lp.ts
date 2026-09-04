/**
 * OffHours — what a liquidity provider actually earned.
 *
 * The pools on this chain show fee yields that cannot be true as a return:
 * AMC's book takes ~$456k a day in fees against ~$1.5M of reserves. A number
 * like that survives only if something is eating it, and the candidate is
 * impermanent loss — these pools turn over their entire depth about 13 times a
 * day, so LPs are being traded against constantly.
 *
 * Nobody can answer this from state, because the public RPC discards it after
 * roughly half an hour. Events survive, though, and a Uniswap V3 Swap carries
 * both the price it left behind (sqrtPriceX96) and the in-range liquidity at
 * the time — which is exactly what is needed to replay a position:
 *
 *   fee share of one swap = amountIn * feeRate * (myLiquidity / poolLiquidity)
 *   full-range value      = 2 * L * sqrt(P), in token1 units
 *
 * So this deposits a hypothetical position at the start of a window, replays
 * every swap through it, and compares the result against having simply held the
 * two tokens. Full-range, because that is the position whose "impermanent loss"
 * is a defined quantity and whose result is comparable across pools. Real LPs
 * here concentrate, which multiplies both the fees and the losses; the
 * concentration factor is reported alongside so the gap is visible.
 *
 * Two positions are replayed side by side. The full-range one is the clean
 * baseline. The concentrated one is what LPs here actually run — the pools show
 * roughly 26x concentration — and it is where the risk lives: while the price
 * stays inside the band it earns that multiple of the fees, and when the price
 * leaves, the position has been converted entirely into whichever side was
 * falling and stops earning anything at all.
 *
 * The window can be placed in the past with --endHoursAgo, which is how the two
 * regimes get compared: the US session, when the underlying actually moves and
 * a band gets run over, against the overnight hours, when it does not.
 *
 * Usage: npm run lp -- --symbol AMC [--hours 8] [--endHoursAgo 0]
 *                     [--notional 10000] [--width 1] [--json]
 */

import { decodeAbiParameters, encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadCfg, makeClient, multicall, withRetry, getLogsAdaptive } from "./rpc.js";

const SWAP_TOPIC = keccak256(toHex("Swap(address,address,int256,int256,uint160,uint128,int24)"));
const Q96 = 2 ** 96;

const poolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "fee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;

export type Leg = {
  label: string;
  feesUsd: number;
  positionUsd: number;
  holdUsd: number;
  impermanentLossUsd: number;
  netUsd: number;
  netPct: number;
  annualisedPct: number;
  /** Share of swaps that happened while the position was earning. */
  inRangePct: number;
  /** How much of the in-range book this position would itself be. */
  poolSharePct: number;
  /**
   * How far the token has to move, in either direction, before the impermanent
   * loss cancels the fees this window earned. The strategy is short volatility:
   * this is the price at which being paid to make a market stops paying.
   */
  breakEvenMovePct: number | null;
};

export type LpResult = {
  symbol: string; pool: Address; feeBps: number;
  from: string; to: string; hours: number; swaps: number;
  notionalUsd: number;
  priceStart: number; priceEnd: number; priceMovePct: number;
  widthPct: number;
  legs: Leg[];
  poolVolumeUsd: number;
  poolFeesUsd: number;
  concentration: number;        // pool's implied full-range value / its real reserves
};

const args = process.argv.slice(2);
const arg = (f: string, d?: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const symbol = (arg("--symbol") ?? "").toUpperCase();
const hours = Number(arg("--hours", "8"));
const notionalUsd = Number(arg("--notional", "10000"));
const widthPct = Number(arg("--width", "1"));
const endHoursAgo = Number(arg("--endHoursAgo", "0"));
if (!symbol) throw new Error("usage: npm run lp -- --symbol AMC [--hours 8] [--notional 10000]");

const cfg = loadCfg();
const client = makeClient(cfg);
const snap = JSON.parse(readFileSync("data/latest.json", "utf8"));
const row = snap.rows.find((r: any) => r.symbol === symbol);
if (!row) throw new Error(`${symbol} not in data/latest.json — run \`npm run snapshot\` first`);

// The deepest V3 pool: V4 reserves are commingled in the singleton and cannot be
// attributed per pool, so a position in one cannot be valued honestly.
const poolRow = (row.pools ?? [])
  .filter((p: any) => p.venue === "v3" && (p.tvlUsd ?? 0) > 0)
  .sort((a: any, b: any) => b.tvlUsd - a.tvlUsd)[0];
if (!poolRow) throw new Error(`${symbol} has no V3 pool with reserves`);
const pool = getAddress(poolRow.id);

const meta = await multicall(client, cfg, ["token0", "token1", "fee"].map((fn) => ({
  target: pool, callData: encodeFunctionData({ abi: poolAbi, functionName: fn as any }),
})));
const token0 = (decodeAbiParameters([{ type: "address" }], meta[0].returnData) as [Address])[0];
const token1 = (decodeAbiParameters([{ type: "address" }], meta[1].returnData) as [Address])[0];
const feePpm = Number((decodeAbiParameters([{ type: "uint24" }], meta[2].returnData) as [number])[0]);

const quoteCfg = snap.quotes[poolRow.quote];
const quoteIsToken0 = token0.toLowerCase() === quoteCfg.address.toLowerCase();
const dec0 = quoteIsToken0 ? quoteCfg.decimals : row.decimals;
const dec1 = quoteIsToken0 ? row.decimals : quoteCfg.decimals;
const quoteUsd = quoteCfg.usd ?? 1;

/** Human price of token0 in token1. */
const priceOf = (sqrtP: number) => sqrtP * sqrtP * 10 ** (dec0 - dec1);
/** USD prices of each side at a given pool price. */
const usdOf = (P: number) => quoteIsToken0
  ? { p0: quoteUsd, p1: quoteUsd / P }
  : { p0: P * quoteUsd, p1: quoteUsd };

const tip = await withRetry(() => client.getBlockNumber(), "blockNumber");
// ~0.101 s/block, measured; both ends are refined below from real timestamps.
const BLOCKS_PER_SEC = 1 / 0.101;
const head = tip - BigInt(Math.round(endHoursAgo * 3600 * BLOCKS_PER_SEC));
const span = BigInt(Math.round(hours * 3600 * BLOCKS_PER_SEC));
const from = head - span;
const [b0, b1] = await Promise.all([
  withRetry(() => client.getBlock({ blockNumber: from }), "b0"),
  withRetry(() => client.getBlock({ blockNumber: head }), "b1"),
]);
const seconds = Number(b1.timestamp - b0.timestamp);

process.stderr.write(`${symbol} · pool ${pool} · fee ${feePpm / 10_000}% · replaying ${span} blocks (${(seconds / 3600).toFixed(1)}h)\n`);
const logs = await getLogsAdaptive(client, { address: pool, topics: [SWAP_TOPIC] }, from, head, undefined, 50_000n);
if (logs.length < 2) throw new Error(`only ${logs.length} swaps in the window — widen --hours`);
logs.sort((a: any, b: any) =>
  Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
process.stderr.write(`${logs.length} swaps\n`);

type Swap = { a0: bigint; a1: bigint; sqrtP: number; liq: number };
const swaps: Swap[] = logs.map((l: any) => {
  const [a0, a1, sqrtX96, liq] = decodeAbiParameters(
    [{ type: "int256" }, { type: "int256" }, { type: "uint160" }, { type: "uint128" }],
    `0x${l.data.slice(2, 2 + 64 * 4)}` as Hex,
  ) as [bigint, bigint, bigint, bigint];
  return { a0, a1, sqrtP: Number(sqrtX96) / Q96, liq: Number(liq) };
});

// Deposit at the price the window opened at.
const sqrtStart = swaps[0].sqrtP;
const priceStart = priceOf(sqrtStart);
const usdStart = usdOf(priceStart);
const feeRate = feePpm / 1e6;

/**
 * Replay one position.
 *
 * Amounts follow the standard V3 range formulas, in raw units:
 *   below the band  all token0   a0 = L(1/√pa - 1/√pb)
 *   inside          both         a0 = L(1/√P  - 1/√pb),  a1 = L(√P - √pa)
 *   above           all token1                            a1 = L(√pb - √pa)
 * Fees accrue only while the price is inside, and only in proportion to the
 * position's share of the liquidity that was actually in range at that moment.
 */
function replay(label: string, sqrtLo: number, sqrtHi: number): Leg {
  const amounts = (L: number, sqrtP: number) => {
    const p = Math.min(Math.max(sqrtP, sqrtLo), sqrtHi);
    return { a0: L * (1 / p - 1 / sqrtHi), a1: L * (p - sqrtLo) };
  };
  const valueUsd = (L: number, sqrtP: number, usd: { p0: number; p1: number }) => {
    const { a0, a1 } = amounts(L, sqrtP);
    return (a0 / 10 ** dec0) * usd.p0 + (a1 / 10 ** dec1) * usd.p1;
  };

  const perL = valueUsd(1, sqrtStart, usdStart);
  if (!(perL > 0)) return { label, feesUsd: 0, positionUsd: 0, holdUsd: 0, impermanentLossUsd: 0, netUsd: 0, netPct: 0, annualisedPct: 0, inRangePct: 0, poolSharePct: 0, breakEvenMovePct: null };
  const L = notionalUsd / perL;
  const start = amounts(L, sqrtStart);

  // Entering the pool dilutes it, including for the entrant: the historical
  // `liquidity` already contains every real LP, so the share of a newcomer is
  // L / (existing + L), not L / existing. On a tight band L is large and the
  // difference is the whole answer rather than a rounding detail.
  let fee0 = 0, fee1 = 0, inRange = 0, shareSum = 0;
  for (const sw of swaps) {
    if (sw.liq <= 0) continue;
    if (sw.sqrtP < sqrtLo || sw.sqrtP > sqrtHi) continue;   // out of band: earns nothing
    inRange++;
    const share = L / (sw.liq + L);
    shareSum += share;
    if (sw.a0 > 0n) fee0 += Number(sw.a0) * feeRate * share;
    if (sw.a1 > 0n) fee1 += Number(sw.a1) * feeRate * share;
  }

  const sqrtEnd = swaps[swaps.length - 1].sqrtP;
  const usdEnd = usdOf(priceOf(sqrtEnd));
  const positionUsd = valueUsd(L, sqrtEnd, usdEnd);
  const holdUsd = (start.a0 / 10 ** dec0) * usdEnd.p0 + (start.a1 / 10 ** dec1) * usdEnd.p1;
  const feesUsd = (fee0 / 10 ** dec0) * usdEnd.p0 + (fee1 / 10 ** dec1) * usdEnd.p1;
  const impermanentLossUsd = positionUsd - holdUsd;
  const netUsd = feesUsd + impermanentLossUsd;

  // Same position, same fees, but ask what a move of m would have cost. Beyond
  // the band the position is entirely one asset while the holder is still half
  // in the other, so the loss keeps growing linearly — this walks outwards until
  // it swallows the fees.
  let breakEvenMovePct: number | null = null;
  for (let m = 0.1; m <= 90; m += 0.1) {
    const sqrtShocked = sqrtStart * Math.sqrt(1 - m / 100);
    const usdShock = usdOf(priceOf(sqrtShocked));
    const pos = valueUsd(L, sqrtShocked, usdShock);
    const hold = (start.a0 / 10 ** dec0) * usdShock.p0 + (start.a1 / 10 ** dec1) * usdShock.p1;
    if (feesUsd + (pos - hold) <= 0) { breakEvenMovePct = m; break; }
  }

  return {
    label, feesUsd, positionUsd, holdUsd, impermanentLossUsd, netUsd, breakEvenMovePct,
    netPct: (netUsd / notionalUsd) * 100,
    annualisedPct: (netUsd / notionalUsd) * (8760 / (seconds / 3600)) * 100,
    inRangePct: (inRange / swaps.length) * 100,
    poolSharePct: inRange ? (shareSum / inRange) * 100 : 0,
  };
}

const concentration = (poolRow.depthScore ?? 0) / (poolRow.tvlUsd || 1);

// Volume is a property of the pool, not of any one position.
let vol0 = 0, vol1 = 0;
for (const sw of swaps) { if (sw.a0 > 0n) vol0 += Number(sw.a0); if (sw.a1 > 0n) vol1 += Number(sw.a1); }

const sqrtEnd = swaps[swaps.length - 1].sqrtP;
const priceEnd = priceOf(sqrtEnd);
const usdEnd = usdOf(priceEnd);

/**
 * A symmetric band [P/k, P*k] concentrates capital by 1/(1 - 1/sqrt(k)), so the
 * band that matches what this pool's LPs are actually running is k = (c/(c-1))^2
 * for an observed concentration c. Simulating a ±1% band and calling it "what
 * LPs get here" would be measuring a position nobody holds.
 */
const bandFor = (pct: number) => Math.sqrt(1 + pct / 100);
const matchedK = concentration > 1.05 ? (concentration / (concentration - 1)) ** 2 : 1.5;
const matchedPct = (matchedK - 1) * 100;
const legs = [
  replay("full range", sqrtStart / 1e6, sqrtStart * 1e6),
  replay(`±${matchedPct.toFixed(1)}% — this pool's actual ${concentration.toFixed(0)}x`, sqrtStart / Math.sqrt(matchedK), sqrtStart * Math.sqrt(matchedK)),
  replay(`±${widthPct}% band`, sqrtStart / bandFor(widthPct), sqrtStart * bandFor(widthPct)),
];

const poolVolumeUsd = (vol0 / 10 ** dec0) * usdEnd.p0 + (vol1 / 10 ** dec1) * usdEnd.p1;
const poolFeesUsd = poolVolumeUsd * feeRate;

const result: LpResult = {
  symbol, pool, feeBps: feePpm / 100,
  from: new Date(Number(b0.timestamp) * 1000).toISOString(),
  to: new Date(Number(b1.timestamp) * 1000).toISOString(),
  hours: seconds / 3600, swaps: swaps.length, notionalUsd, widthPct,
  priceStart: quoteIsToken0 ? 1 / priceStart : priceStart,
  priceEnd: quoteIsToken0 ? 1 / priceEnd : priceEnd,
  priceMovePct: 0, legs,
  poolVolumeUsd, poolFeesUsd, concentration,
};
result.priceMovePct = (result.priceEnd / result.priceStart - 1) * 100;

if (args.includes("--json")) {
  mkdirSync("data/lp", { recursive: true });
  writeFileSync(`data/lp/${symbol}.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} else {
  const u = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  const pct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(3)}%`;
  console.log(`\n${symbol} — ${result.hours.toFixed(1)}h, ${swaps.length.toLocaleString()} swaps, pool fee ${result.feeBps} bps`);
  console.log(`token price ${result.priceStart.toFixed(4)} -> ${result.priceEnd.toFixed(4)}  (${result.priceMovePct >= 0 ? "+" : ""}${result.priceMovePct.toFixed(2)}%)`);
  console.log(`pool did ${u(poolVolumeUsd)} of volume, paying ${u(poolFeesUsd)} to all LPs`);
  console.log(`real LPs here run about ${concentration.toFixed(0)}x concentrated\n`);
  console.table(legs.map((l) => ({
    position: l.label,
    "fees": u(l.feesUsd),
    "impermanent loss": u(l.impermanentLossUsd),
    "net vs holding": u(l.netUsd),
    "net %": pct(l.netPct),
    "annualised": `${l.annualisedPct >= 0 ? "+" : ""}${l.annualisedPct.toFixed(0)}%`,
    "earning": `${l.inRangePct.toFixed(0)}% of swaps`,
    "you'd be": `${l.poolSharePct.toFixed(1)}% of the book`,
    "wiped out by a move of": l.breakEvenMovePct == null ? ">90%" : `${l.breakEvenMovePct.toFixed(1)}%`,
  })));
  console.log(`on ${u(notionalUsd)} deposited at the start of the window. One window is not a return —`);
  console.log(`the annualised column is arithmetic, not a forecast.\n`);
}
