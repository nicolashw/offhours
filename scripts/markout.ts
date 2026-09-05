/**
 * OffHours — does a dynamic-fee hook actually protect liquidity providers?
 *
 * Everything measured so far says the fee income on this chain does not survive:
 * across five books read from their own ledgers, impermanent loss consumed
 * 82-113% of what the pools took in. Fables is the one project selling a fix —
 * a Uniswap V4 hook that raises the fee when a trade is more likely to be
 * against the LP, aimed squarely at the toxic flow a tokenised stock attracts
 * when its underlying market is shut. This measures whether it works.
 *
 * The test is markout, not simulation. For each swap, the pool's inventory
 * changes by (amount0, amount1); revalue that change at the price some minutes
 * later and you have what the trade was actually worth to the LP:
 *
 *   markout = amount0 * P_later + amount1
 *
 * The fee stays in the pool, so it is already inside those amounts: a positive
 * markout means the fee covered the adverse move, a negative one means it did
 * not. Comparing the same token's Fables pool against its plain V3 pool over the
 * same blocks is as close to a controlled experiment as this chain allows.
 *
 * V3 and V4 sign their Swap amounts from opposite sides of the trade, so the
 * convention is detected from the data rather than assumed — a flipped sign
 * would invert the entire result.
 *
 * Usage: npm run markout -- --symbol HIMS [--hours 6] [--horizon 5]
 */

import { decodeAbiParameters, encodeFunctionData, getAddress, keccak256, toHex, type Address, type Hex } from "viem";
import { readFileSync } from "node:fs";
import { loadCfg, makeClient, multicall, withRetry, getLogsAdaptive, type Cfg } from "./rpc.js";

const V3_SWAP = keccak256(toHex("Swap(address,address,int256,int256,uint160,uint128,int24)"));
const V4_SWAP = keccak256(toHex("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
const FABLES_HOOK = getAddress("0x62019aA6b71B61AbfBFF1a44C68B1e6584e940c0");

const args = process.argv.slice(2);
const arg = (f: string, d: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const symbol = arg("--symbol", "HIMS").toUpperCase();
const hours = Number(arg("--hours", "6"));
const horizons = arg("--horizon", "1,5,30,120").split(",").map(Number);

const cfg: Cfg = loadCfg();
const client = makeClient(cfg);
const snap = JSON.parse(readFileSync("data/latest.json", "utf8"));
const poolsCfg = JSON.parse(readFileSync("config/pools.json", "utf8"));
const row = snap.rows.find((r: any) => r.symbol === symbol);
if (!row) throw new Error(`${symbol} not in data/latest.json`);

const v3 = (row.pools ?? []).filter((p: any) => p.venue === "v3" && (p.tvlUsd ?? 0) > 0)
  .sort((a: any, b: any) => b.tvlUsd - a.tvlUsd)[0];
const v4 = poolsCfg.v4.find((p: any) => p.symbol === symbol && p.hooks === FABLES_HOOK && p.active !== false);
if (!v3) throw new Error(`${symbol} has no V3 pool`);
if (!v4 && !args.includes("--v3only")) throw new Error(`${symbol} has no live pool on the dynamic-fee hook — pass --v3only to measure the V3 book alone`);

// Orientation and decimals, per pool.
const t0abi = [{ type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
const [t0r] = await multicall(client, cfg, [{ target: getAddress(v3.id), callData: encodeFunctionData({ abi: t0abi, functionName: "token0" }) }]);
const v3Token0 = (decodeAbiParameters([{ type: "address" }], t0r.returnData) as [Address])[0];
const quote = snap.quotes[v3.quote];
const v3QuoteIsT0 = v3Token0.toLowerCase() === quote.address.toLowerCase();
const v4QuoteIsT0 = v4 ? v4.currency0.toLowerCase() === quote.address.toLowerCase() : false;

type Venue = {
  label: string; kind: "v3" | "v4";
  dec0: number; dec1: number; quoteIsT0: boolean;
  fixedFeePpm: number | null;
};
const venues: Venue[] = [
  { label: `V3 ${v3.fee / 10000}% 固定`, kind: "v3",
    dec0: v3QuoteIsT0 ? quote.decimals : row.decimals, dec1: v3QuoteIsT0 ? row.decimals : quote.decimals,
    quoteIsT0: v3QuoteIsT0, fixedFeePpm: v3.fee },
  ...(v4 ? [{ label: `动态费率 hook V4`, kind: "v4" as const,
    dec0: v4QuoteIsT0 ? quote.decimals : row.decimals, dec1: v4QuoteIsT0 ? row.decimals : quote.decimals,
    quoteIsT0: v4QuoteIsT0, fixedFeePpm: null }] : []),
];

const head = await withRetry(() => client.getBlockNumber(), "bn");
const span = BigInt(Math.round(hours * 3600 / 0.101));

process.stderr.write(`${symbol} · ${hours}h window · markout at ${horizons.join("/")} min\n`);

type Swap = { block: bigint; a0: number; a1: number; sqrtP: number; feePpm: number };

async function load(v: Venue): Promise<Swap[]> {
  const logs = v.kind === "v3"
    ? await getLogsAdaptive(client, { address: getAddress(v3.id), topics: [V3_SWAP] }, head - span, head, undefined, 60_000n)
    : await getLogsAdaptive(client, { address: cfg.v4PoolManager, topics: [V4_SWAP, v4.poolId as Hex] }, head - span, head, undefined, 60_000n);
  process.stderr.write(`  ${v.label}: ${logs.length} swaps\n`);
  return (logs as any[]).map((l) => {
    if (v.kind === "v3") {
      const [a0, a1, sq] = decodeAbiParameters(
        [{ type: "int256" }, { type: "int256" }, { type: "uint160" }], `0x${l.data.slice(2, 2 + 64 * 3)}` as Hex,
      ) as [bigint, bigint, bigint];
      return { block: BigInt(l.blockNumber), a0: Number(a0), a1: Number(a1), sqrtP: Number(sq) / 2 ** 96, feePpm: v.fixedFeePpm! };
    }
    const [a0, a1, sq, , , fee] = decodeAbiParameters(
      [{ type: "int128" }, { type: "int128" }, { type: "uint160" }, { type: "uint128" }, { type: "int24" }, { type: "uint24" }],
      `0x${l.data.slice(2, 2 + 64 * 6)}` as Hex,
    ) as [bigint, bigint, bigint, bigint, number, number];
    return { block: BigInt(l.blockNumber), a0: Number(a0), a1: Number(a1), sqrtP: Number(sq) / 2 ** 96, feePpm: Number(fee) };
  }).sort((x, y) => Number(x.block - y.block));
}

/**
 * Which side of the trade do the amounts describe?
 *
 * A pool that takes in token0 gets cheaper in token0 terms, so its sqrtPrice
 * falls. Correlating the sign of amount0 against the price move recovers the
 * convention without trusting either ABI's wording.
 */
function poolSideSign(sw: Swap[]): number {
  let agree = 0, n = 0;
  for (let i = 1; i < sw.length; i++) {
    const d = sw[i].sqrtP - sw[i - 1].sqrtP;
    if (d === 0 || sw[i].a0 === 0) continue;
    n++;
    if (Math.sign(sw[i].a0) !== Math.sign(d)) agree++;   // pool receives token0 -> price down
  }
  return n === 0 ? 1 : (agree / n > 0.5 ? 1 : -1);
}

const results: any[] = [];
for (const v of venues) {
  const sw = await load(v);
  if (sw.length < 20) { process.stderr.write(`  ${v.label}: too few swaps, skipping\n`); continue; }
  const sign = poolSideSign(sw);
  for (const horizonMin of horizons) {
  const horizonBlocks = BigInt(Math.round(horizonMin * 60 / 0.101));
  const price = (s: Swap) => s.sqrtP * s.sqrtP * 10 ** (v.dec0 - v.dec1);      // token0 in token1
  const quoteUsd = quote.usd ?? 1;
  const toUsd1 = v.quoteIsT0 ? (price(sw[0]) > 0 ? quoteUsd / price(sw[0]) : 0) : quoteUsd;

  let volUsd = 0, feesUsd = 0, markoutUsd = 0, counted = 0;
  let feeMin = Infinity, feeMax = 0, feeWeighted = 0;
  let j = 0;
  for (let i = 0; i < sw.length; i++) {
    const s = sw[i];
    const a0 = sign * s.a0, a1 = sign * s.a1;                                   // pool's own deltas
    const target = s.block + horizonBlocks;
    while (j < sw.length - 1 && sw[j].block < target) j++;
    if (sw[j].block < target) break;                                            // no future price yet
    const pLater = price(sw[j]);
    // Inventory change revalued at the later price, expressed in token1 then USD.
    const mo = (a0 / 10 ** v.dec0) * pLater + (a1 / 10 ** v.dec1);
    const usdPerToken1 = v.quoteIsT0 ? (pLater > 0 ? quoteUsd / pLater : 0) : quoteUsd;
    const vol = Math.abs(a1 / 10 ** v.dec1) * usdPerToken1;
    if (!isFinite(mo) || !isFinite(vol) || vol <= 0) continue;
    markoutUsd += mo * usdPerToken1;
    volUsd += vol;
    feesUsd += vol * (s.feePpm / 1e6);
    feeWeighted += (s.feePpm / 100) * vol;
    feeMin = Math.min(feeMin, s.feePpm / 100); feeMax = Math.max(feeMax, s.feePpm / 100);
    counted++;
  }
  results.push({
    label: v.label, horizonMin, swaps: counted, sign, volUsd, feesUsd, markoutUsd,
    feeBpsAvg: volUsd > 0 ? feeWeighted / volUsd : 0, feeMin, feeMax,
    feeBpsOfVol: volUsd > 0 ? (feesUsd / volUsd) * 10_000 : 0,
    markoutBps: volUsd > 0 ? (markoutUsd / volUsd) * 10_000 : 0,
    adverseBps: volUsd > 0 ? ((markoutUsd - feesUsd) / volUsd) * 10_000 : 0,
  });
  }
}

const u = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
console.log(`\n${symbol} · ${hours}h\n`);
console.table(results.map((r) => ({
  场所: r.label,
  "markout 视界": `${r.horizonMin} min`,
  成交: r.swaps.toLocaleString(),
  成交额: u(r.volUsd),
  "实收费率": `${r.feeBpsAvg.toFixed(1)} bps`,
  手续费收入: u(r.feesUsd),
  "净 markout": u(r.markoutUsd),
  "净(bps)": r.markoutBps.toFixed(1),
  "被套走(bps)": r.adverseBps.toFixed(1),
})));
console.log(`\n「净 markout」= 池子库存按该视界之后的价格重估，手续费已含在内。正数 = LP 赚。`);
console.log(`「被套走」= 净 markout 减去手续费收入，也就是价格移动从 LP 身上拿走的部分。\n`);
for (const r of results) console.log(`  ${r.label}: 符号检测 ${r.sign > 0 ? "事件即池子视角" : "事件为交易者视角，已翻转"}`);
