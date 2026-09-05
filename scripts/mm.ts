/**
 * OffHours — the market maker's own books.
 *
 * lp.ts simulates a position. This reads a real one.
 *
 * A single address holds 71-100% of the minted liquidity in every Stock Token
 * book measured, rebalancing every ~31 seconds inside a ±0.6% band. Whether that
 * operation is profitable is the question the whole "should anyone provide
 * liquidity here" argument rests on, and it does not need simulating: Uniswap V3
 * emits everything an LP puts in and takes out.
 *
 *   Mint    -> amount0/amount1 deposited
 *   Burn    -> liquidity removed, credited to tokensOwed (no tokens move)
 *   Collect -> amount0/amount1 actually withdrawn: principal plus fees
 *
 * So over a complete history, in token terms:
 *
 *   profit = collected + still-in-the-pool - deposited
 *
 * Valued at one price, that is exactly profit-versus-holding: the same
 * comparison lp.ts makes, but from the operator's own ledger rather than a
 * hypothetical. The scan has to start before the pool's first Mint, otherwise
 * the opening position is unknown and the whole subtraction is meaningless —
 * historical state is gone after half an hour, so it cannot be recovered any
 * other way.
 *
 * Usage: npm run mm -- --symbol AMC [--owner 0x...] [--from-blocks 5000000] [--json]
 */

import {
  decodeAbiParameters, encodeFunctionData, encodePacked, getAddress, keccak256, toHex,
  type Address, type Hex,
} from "viem";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { loadCfg, makeClient, multicall, withRetry, getLogsAdaptive } from "./rpc.js";

const MINT = keccak256(toHex("Mint(address,address,int24,int24,uint128,uint256,uint256)"));
const BURN = keccak256(toHex("Burn(address,int24,int24,uint128,uint256,uint256)"));
const COLLECT = keccak256(toHex("Collect(address,address,int24,int24,uint128,uint128)"));

const poolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
      { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" }, { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" }, { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" }] },
  { type: "function", name: "positions", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [
      { name: "liquidity", type: "uint128" }, { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" }, { name: "tokensOwed1", type: "uint128" }] },
] as const;

const args = process.argv.slice(2);
const arg = (f: string, d: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : d);
const symbol = arg("--symbol", "AMC").toUpperCase();
const owner = getAddress(arg("--owner", "0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3"));
const fromBlocks = BigInt(arg("--from-blocks", "5000000"));

const cfg = loadCfg();
const client = makeClient(cfg);
const snap = JSON.parse(readFileSync("data/latest.json", "utf8"));
const row = snap.rows.find((r: any) => r.symbol === symbol);
if (!row) throw new Error(`${symbol} not in data/latest.json`);
const poolRow = (row.pools ?? []).filter((p: any) => p.venue === "v3" && (p.tvlUsd ?? 0) > 0)
  .sort((a: any, b: any) => b.tvlUsd - a.tvlUsd)[0];
if (!poolRow) throw new Error(`${symbol} has no V3 pool with reserves`);
const pool = getAddress(poolRow.id);

const meta = await multicall(client, cfg, [
  { target: pool, callData: encodeFunctionData({ abi: poolAbi, functionName: "token0" }) },
  { target: pool, callData: encodeFunctionData({ abi: poolAbi, functionName: "slot0" }) },
]);
const token0 = (decodeAbiParameters([{ type: "address" }], meta[0].returnData) as [Address])[0];
const [sqrtNowX96] = decodeAbiParameters([{ type: "uint160" }], `0x${meta[1].returnData.slice(2, 66)}` as Hex) as [bigint];
const sqrtNow = Number(sqrtNowX96) / 2 ** 96;

const quote = snap.quotes[poolRow.quote];
const quoteIsToken0 = token0.toLowerCase() === quote.address.toLowerCase();
const dec0 = quoteIsToken0 ? quote.decimals : row.decimals;
const dec1 = quoteIsToken0 ? row.decimals : quote.decimals;
const P = sqrtNow * sqrtNow * 10 ** (dec0 - dec1);           // token0 priced in token1
const usd0 = quoteIsToken0 ? (quote.usd ?? 1) : P * (quote.usd ?? 1);
const usd1 = quoteIsToken0 ? (quote.usd ?? 1) / P : (quote.usd ?? 1);
const name0 = quoteIsToken0 ? poolRow.quote : symbol;
const name1 = quoteIsToken0 ? symbol : poolRow.quote;

const head = await withRetry(() => client.getBlockNumber(), "bn");
const from = head > fromBlocks ? head - fromBlocks : 0n;
process.stderr.write(`${symbol} pool ${pool}\nowner ${owner}\nscanning ${from}..${head}\n`);

const pad = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const scan = (topics: (Hex | null)[]) =>
  getLogsAdaptive(client, { address: pool, topics }, from, head, undefined, 500_000n);

const mints = await scan([MINT, pad(owner)]);
process.stderr.write(`  ${mints.length} mints\n`);
const burns = await scan([BURN, pad(owner)]);
process.stderr.write(`  ${burns.length} burns\n`);
const collects = await scan([COLLECT, pad(owner)]);
process.stderr.write(`  ${collects.length} collects\n`);
if (!mints.length) throw new Error("no mints found for this owner — widen --from-blocks");

const firstBlock = BigInt((mints as any[])[0].blockNumber);
if (firstBlock - from < 20_000n) {
  process.stderr.write(`  WARNING: first mint sits ${firstBlock - from} blocks into the window — widen --from-blocks or the opening position is unknown\n`);
}
const [bStart, bEnd] = await Promise.all([
  withRetry(() => client.getBlock({ blockNumber: firstBlock }), "bs"),
  withRetry(() => client.getBlock({ blockNumber: head }), "be"),
]);
const hours = Number(bEnd.timestamp - bStart.timestamp) / 3600;

// Mint's data is (sender, amount, amount0, amount1) — the sender address leads,
// and dropping it shifts every amount one word left. Collect's is (recipient,
// amount0, amount1). Both index owner, tickLower, tickUpper as topics 1-3.
let dep0 = 0n, dep1 = 0n, col0 = 0n, col1 = 0n;
const ranges = new Set<string>();
const tickOf = (t: string) => Number(BigInt.asIntN(24, BigInt(t)));
for (const l of mints as any[]) {
  const [, , a0, a1] = decodeAbiParameters(
    [{ type: "address" }, { type: "uint128" }, { type: "uint256" }, { type: "uint256" }],
    `0x${l.data.slice(2, 2 + 64 * 4)}` as Hex,
  ) as [Address, bigint, bigint, bigint];
  dep0 += a0; dep1 += a1;
  ranges.add(`${tickOf(l.topics[2])}:${tickOf(l.topics[3])}`);
}
for (const l of collects as any[]) {
  const [, a0, a1] = decodeAbiParameters(
    [{ type: "address" }, { type: "uint128" }, { type: "uint128" }], `0x${l.data.slice(2, 2 + 64 * 3)}` as Hex,
  ) as [Address, bigint, bigint];
  col0 += a0; col1 += a1;
  ranges.add(`${tickOf(l.topics[2])}:${tickOf(l.topics[3])}`);
}
for (const l of burns as any[]) ranges.add(`${tickOf(l.topics[2])}:${tickOf(l.topics[3])}`);

// What is still sitting in the pool: open liquidity plus anything burned but not yet collected.
const rangeList = [...ranges].map((r) => r.split(":").map(Number) as [number, number]);
const keys = rangeList.map(([lo, hi]) =>
  keccak256(encodePacked(["address", "int24", "int24"], [owner, lo, hi])));
const posRes = await multicall(client, cfg, keys.map((k) => ({
  target: pool, callData: encodeFunctionData({ abi: poolAbi, functionName: "positions", args: [k] }),
})));

const sqrtAt = (tick: number) => 1.0001 ** (tick / 2);
let open0 = 0, open1 = 0, owed0 = 0, owed1 = 0, openL = 0;
posRes.forEach((r, i) => {
  if (!r.success || r.returnData === "0x") return;
  const [L, , , t0, t1] = decodeAbiParameters(
    [{ type: "uint128" }, { type: "uint256" }, { type: "uint256" }, { type: "uint128" }, { type: "uint128" }],
    r.returnData,
  ) as [bigint, bigint, bigint, bigint, bigint];
  owed0 += Number(t0); owed1 += Number(t1);
  if (L === 0n) return;
  const [lo, hi] = rangeList[i];
  const a = sqrtAt(lo), b = sqrtAt(hi), p = Math.min(Math.max(sqrtNow, a), b);
  const l = Number(L);
  openL += l;
  open0 += l * (1 / p - 1 / b);
  open1 += l * (p - a);
});

// The owner holds most of these books, so its reconstructed position should sit
// just under the pool's actual reserves. If it does not, the reconstruction is
// wrong and every number below it is too.
const erc20 = [{ type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] }] as const;
const token1Addr = quoteIsToken0 ? getAddress(row.token) : getAddress(quote.address);
const bal = await multicall(client, cfg, [token0, token1Addr].map((t) => ({
  target: t as Address, callData: encodeFunctionData({ abi: erc20, functionName: "balanceOf", args: [pool] }),
})));
const poolBal = bal.map((r) => (r.success && r.returnData !== "0x"
  ? Number((decodeAbiParameters([{ type: "uint256" }], r.returnData) as [bigint])[0]) : 0));

const h = (raw: number, dec: number) => raw / 10 ** dec;
const deposited = { t0: h(Number(dep0), dec0), t1: h(Number(dep1), dec1) };
const collected = { t0: h(Number(col0), dec0), t1: h(Number(col1), dec1) };
const still = { t0: h(open0 + owed0, dec0), t1: h(open1 + owed1, dec1) };

const d0 = collected.t0 + still.t0 - deposited.t0;
const d1 = collected.t1 + still.t1 - deposited.t1;
const profitUsd = d0 * usd0 + d1 * usd1;
const capitalUsd = still.t0 * usd0 + still.t1 * usd1;

const poolHas = { t0: h(poolBal[0], dec0), t1: h(poolBal[1], dec1) };
const coverage = {
  t0: poolHas.t0 > 0 ? (still.t0 / poolHas.t0) * 100 : 0,
  t1: poolHas.t1 > 0 ? (still.t1 / poolHas.t1) * 100 : 0,
};

const result = {
  symbol, pool, owner, hours, cycles: mints.length, poolHas, coverage,
  deposited, collected, still,
  deltaToken0: d0, deltaToken1: d1,
  profitUsd, capitalUsd,
  returnOnCapitalPct: capitalUsd > 0 ? (profitUsd / capitalUsd) * 100 : 0,
  annualisedPct: capitalUsd > 0 ? (profitUsd / capitalUsd) * (8760 / hours) * 100 : 0,
  grossDepositedUsd: deposited.t0 * usd0 + deposited.t1 * usd1,
};

if (args.includes("--json")) {
  mkdirSync("data/mm", { recursive: true });
  writeFileSync(`data/mm/${symbol}.json`, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
} else {
  const n = (x: number, d = 2) => x.toLocaleString("en-US", { maximumFractionDigits: d });
  const u = (x: number) => `${x < 0 ? "-" : ""}$${Math.abs(x).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  console.log(`\n${symbol} — the dominant LP's own ledger`);
  console.log(`pool ${pool}`);
  console.log(`${mints.length.toLocaleString()} mints / ${burns.length.toLocaleString()} burns / ${collects.length.toLocaleString()} collects over ${hours.toFixed(1)}h`);
  console.log(`re-positioning every ${(hours * 3600 / Math.max(mints.length, 1)).toFixed(0)}s on average\n`);
  console.table([
    { "": "deposited (Mint)",   [name0]: n(deposited.t0), [name1]: n(deposited.t1) },
    { "": "withdrawn (Collect)",[name0]: n(collected.t0), [name1]: n(collected.t1) },
    { "": "still in the pool",  [name0]: n(still.t0),     [name1]: n(still.t1) },
    { "": "net change",         [name0]: n(d0),           [name1]: n(d1) },
  ]);
  console.log(`\npool actually holds          ${n(poolHas.t0)} ${name0} / ${n(poolHas.t1)} ${name1}`);
  console.log(`this owner accounts for      ${coverage.t0.toFixed(1)}% / ${coverage.t1.toFixed(1)}% of that`);
  console.log(`capital currently deployed   ${u(capitalUsd)}`);
  console.log(`profit vs having just held   ${u(profitUsd)}   ${result.returnOnCapitalPct >= 0 ? "+" : ""}${result.returnOnCapitalPct.toFixed(2)}% on deployed capital over ${hours.toFixed(1)}h`);
  console.log(`naive annualisation          ${result.annualisedPct >= 0 ? "+" : ""}${n(result.annualisedPct, 0)}%\n`);
  console.log(`Both token columns priced at the current pool price; "net change" is what the operator`);
  console.log(`ended up with beyond what it put in. Fees accrued since its last Collect are not counted,`);
  console.log(`which understates the result by roughly one rebalancing interval.\n`);
}
