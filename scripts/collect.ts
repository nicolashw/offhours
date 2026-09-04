/**
 * OffHours — core collector.
 *
 * One pass over every Robinhood Stock Token on Robinhood Chain (4663), reading:
 *
 *   - the Chainlink reference price and, just as importantly, its age. These
 *     feeds are 24h-heartbeat / 0.5%-deviation, `us_equities_24/5`: a reference
 *     that has not moved for eleven hours is behaving exactly as specified, so
 *     age is a first-class field, not an error flag.
 *   - the ERC-8056 uiMultiplier(), cross-checked against Robinhood's own REST
 *     value. Anything reading balanceOf() alone is wrong by this factor.
 *   - Uniswap V3 pool prices (contracts) and V4 pool prices (storage entries in
 *     the singleton PoolManager, read via extsload).
 *   - USD conversion through the on-chain USDG/USDe/ETH Chainlink feeds rather
 *     than a circular pool-derived rate.
 *
 * premiumBps compares the live AMM price against that reference. During the US
 * session it is a genuine basis. Outside it — the OffHours case — the reference
 * is frozen at the last regular-session print, so the same number reads as the
 * market's implied view of the next open. The snapshot records marketPhase and
 * feed age so the two are never conflated.
 *
 * Read-only throughout. No signing, no custody, no execution.
 */

import { encodeFunctionData, decodeAbiParameters, formatUnits, getAddress, type Address, type Hex } from "viem";
import { loadCfg, makeClient, multicall, withRetry, type Cfg, type CallResult } from "./rpc.js";
import { loadRegistry, type Asset } from "./registry.js";
import { loadPools, type Pools } from "./pools.js";
import { extsloadCalldata, stateSlotOf, addSlot, decodeSlot0, decodeLiquidity, LIQUIDITY_OFFSET } from "./v4.js";
import { marketPhase, type Phase } from "./market.js";

export { loadCfg } from "./rpc.js";

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const feedAbi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [
      { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" }, { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" }] },
] as const;

const v3PoolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
      { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" }, { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" }, { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" }] },
] as const;

/** Below this much virtual quote depth, a pool price is indicative at best. */
const MIN_DEPTH_USD = Number(process.env.MIN_DEPTH_USD ?? 5_000);

const call = (target: Address, callData: Hex) => ({ target, callData });
const cd = (abi: any, functionName: string) => encodeFunctionData({ abi, functionName }) as Hex;

/** Chainlink round, with the metadata needed to judge whether it still means anything. */
export type FeedRead = {
  address: Address; price: number; updatedAt: string; ageSec: number;
  heartbeat: number | null; thresholdPct: number | null;
  /** fresh <1h · aging <heartbeat · beyond-heartbeat = the feed has missed its own SLA */
  state: "fresh" | "aging" | "beyond-heartbeat";
};

export type PoolRead = {
  venue: "v3" | "v4";
  id: string;                 // pool address (v3) or poolId (v4)
  quote: string;
  fee: number;
  dynamicFee?: boolean;
  tickSpacing?: number;
  hooks?: Address;
  price: number;              // token priced in the quote asset
  priceUsd: number | null;
  liquidity: string;
  /**
   * Virtual quote-side reserve at the current tick, in USD.
   *
   * A drained concentrated-liquidity pool keeps its last sqrtPrice in storage
   * forever, so price alone cannot tell a live market from a fossil — several
   * tokens here quote a 15-19% "premium" out of pools with L = 0. This is the
   * number that separates them: y = L * sqrt(P) for a quote-as-token1 pool,
   * x = L / sqrt(P) when the quote is token0. It is the depth backing the
   * current price, not withdrawable TVL.
   */
  quoteDepthUsd: number | null;
};

export type Row = {
  symbol: string; name: string; token: Address; decimals: number;
  isin: string | null;
  uiMultiplier: number | null;      // on-chain ERC-8056
  restMultiplier: number | null;    // Robinhood's own value
  multiplierMismatch: boolean;      // the two disagree beyond float noise — investigate before trusting balances
  rawTotalSupply: number | null;    // balanceOf/totalSupply units, pre-multiplier
  adjTotalSupply: number | null;    // what a share count actually is
  feed: FeedRead | null;
  pools: PoolRead[];
  best: { venue: string; id: string; quote: string; priceUsd: number; quoteDepthUsd: number | null } | null;
  poolUsd: number | null;
  /** Total virtual quote depth across every live pool for this token, in USD. */
  depthUsd: number;
  /**
   * How much the premium is worth believing:
   *   ok    — the price comes from a pool with real depth behind it
   *   thin  — priced, but under MIN_DEPTH_USD; treat as indicative only
   *   empty — every pool has L = 0; the price is a fossil of the last trade
   *   none  — no pool, or no Chainlink reference to compare against
   */
  quality: "ok" | "thin" | "empty" | "none";
  premiumBps: number | null;
  /** premiumBps, but only when the market is shut and the reference is frozen. */
  impliedMoveBps: number | null;
  note?: string;
};

export type Snapshot = {
  ts: string; chainId: number; block: string;
  market: { phase: Phase; etTime: string; offHours: boolean };
  registryFetchedAt: string; poolsDiscoveredAt: string;
  quotes: Record<string, { address: Address; usd: number | null; decimals: number; feedAgeSec: number | null }>;
  counts: { assets: number; withFeed: number; withPool: number; priced: number; trustworthy: number; beyondHeartbeat: number };
  rows: Row[];
};

/** Depth backing the quoted price: the virtual quote reserve at the current tick. */
function quoteDepth(sqrtPriceX96: bigint, liquidity: bigint, quoteIsToken0: boolean, quoteDec: number): number | null {
  if (liquidity === 0n) return 0;
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  if (!isFinite(sqrtP) || sqrtP <= 0) return null;
  const L = Number(liquidity);
  const raw = quoteIsToken0 ? L / sqrtP : L * sqrtP;
  const v = raw / 10 ** quoteDec;
  return isFinite(v) ? v : null;
}

function priceFromSqrt(sqrtPriceX96: bigint, token0: Address, token: Address, tokenDec: number, quoteDec: number): number {
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const p1per0 = sqrtP * sqrtP;
  const isT0 = token0.toLowerCase() === token.toLowerCase();
  return (isT0 ? p1per0 : 1 / p1per0) * 10 ** (tokenDec - quoteDec);
}

function decodeFeed(dRes: CallResult, rRes: CallResult, address: Address, a: Asset | null, now: number): FeedRead | null {
  if (!dRes.success || !rRes.success) return null;
  const [dec] = decodeAbiParameters([{ type: "uint8" }], dRes.returnData) as [number];
  const r = decodeAbiParameters(
    [{ type: "uint80" }, { type: "int256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint80" }],
    rRes.returnData,
  ) as [bigint, bigint, bigint, bigint, bigint];
  const price = Number(formatUnits(r[1], dec));
  const updated = Number(r[3]);
  const ageSec = now - updated;
  const heartbeat = a?.feedHeartbeat ?? null;
  const state: FeedRead["state"] =
    ageSec < 3600 ? "fresh" : heartbeat && ageSec >= heartbeat ? "beyond-heartbeat" : "aging";
  return {
    address, price, updatedAt: new Date(updated * 1000).toISOString(), ageSec,
    heartbeat, thresholdPct: a?.feedThresholdPct ?? null, state,
  };
}

export async function collect(cfg: Cfg = loadCfg()): Promise<Snapshot> {
  const client = makeClient(cfg);
  const reg = loadRegistry();
  const pools: Pools = loadPools();
  const now = Math.floor(Date.now() / 1000);
  const block = await withRetry(() => client.getBlockNumber(), "blockNumber");

  // ---- quote assets: decimals + their own Chainlink USD price ----
  const qCalls = cfg.quoteTokens.flatMap((q) => [
    call(getAddress(q.address), cd(erc20Abi, "decimals")),
    ...(q.feed ? [call(getAddress(q.feed), cd(feedAbi, "decimals")), call(getAddress(q.feed), cd(feedAbi, "latestRoundData"))] : []),
  ]);
  const qRes = await multicall(client, cfg, qCalls);
  const quotes: Snapshot["quotes"] = {};
  const quoteDec = new Map<string, number>();
  const quoteUsd = new Map<string, number>();
  {
    let i = 0;
    for (const q of cfg.quoteTokens) {
      const dRes = qRes[i++];
      const dec = dRes.success ? (decodeAbiParameters([{ type: "uint8" }], dRes.returnData) as [number])[0] : 18;
      let usd: number | null = null, ageSec: number | null = null;
      if (q.feed) {
        const f = decodeFeed(qRes[i++], qRes[i++], getAddress(q.feed), null, now);
        if (f) { usd = f.price; ageSec = f.ageSec; }
      }
      quoteDec.set(q.symbol, dec);
      if (usd != null) quoteUsd.set(q.symbol, usd);
      quotes[q.symbol] = { address: getAddress(q.address), usd, decimals: dec, feedAgeSec: ageSec };
    }
  }

  // ---- per-asset token state ----
  const assets = reg.assets;
  const tokCalls = assets.flatMap((a) => [
    call(a.token, cd(erc20Abi, "uiMultiplier")),
    call(a.token, cd(erc20Abi, "totalSupply")),
  ]);
  const tokRes = await multicall(client, cfg, tokCalls);

  // ---- per-asset feeds ----
  const feedAssets = assets.filter((a) => a.feed);
  const feedCalls = feedAssets.flatMap((a) => [
    call(a.feed!, cd(feedAbi, "decimals")),
    call(a.feed!, cd(feedAbi, "latestRoundData")),
  ]);
  const feedRes = await multicall(client, cfg, feedCalls);
  const feedBySymbol = new Map<string, FeedRead>();
  feedAssets.forEach((a, i) => {
    const f = decodeFeed(feedRes[i * 2], feedRes[i * 2 + 1], a.feed!, a, now);
    if (f) feedBySymbol.set(a.symbol, f);
  });

  // ---- V3 pools ----
  const v3Calls = pools.v3.flatMap((p) => [
    call(p.pool, cd(v3PoolAbi, "token0")),
    call(p.pool, cd(v3PoolAbi, "slot0")),
    call(p.pool, cd(v3PoolAbi, "liquidity")),
  ]);
  const v3Res = v3Calls.length ? await multicall(client, cfg, v3Calls) : [];

  // ---- V4 pools (singleton storage) ----
  const v4Calls = pools.v4.flatMap((p) => {
    const s = stateSlotOf(p.poolId);
    return [
      call(cfg.v4PoolManager, extsloadCalldata(s)),
      call(cfg.v4PoolManager, extsloadCalldata(addSlot(s, LIQUIDITY_OFFSET))),
    ];
  });
  const v4Res = v4Calls.length ? await multicall(client, cfg, v4Calls) : [];

  // ---- assemble ----
  const poolsBySymbol = new Map<string, PoolRead[]>();
  const push = (s: string, p: PoolRead) => { const l = poolsBySymbol.get(s) ?? []; l.push(p); poolsBySymbol.set(s, l); };
  const decBySymbol = new Map(assets.map((a) => [a.symbol, a.decimals]));
  const toUsd = (price: number, quote: string) => {
    const u = quoteUsd.get(quote);
    return u != null && isFinite(price) ? price * u : null;
  };

  pools.v3.forEach((p, i) => {
    const [t0r, s0r, lqr] = [v3Res[i * 3], v3Res[i * 3 + 1], v3Res[i * 3 + 2]];
    if (!t0r?.success || !s0r?.success) return;
    const [t0] = decodeAbiParameters([{ type: "address" }], t0r.returnData) as [Address];
    const [sqrtP] = decodeAbiParameters([{ type: "uint160" }], `0x${s0r.returnData.slice(2, 66)}` as Hex) as [bigint];
    if (sqrtP === 0n) return; // initialised but never priced
    const liq = lqr?.success ? (decodeAbiParameters([{ type: "uint128" }], lqr.returnData) as [bigint])[0] : 0n;
    const qDec = quoteDec.get(p.quote) ?? 18;
    const price = priceFromSqrt(sqrtP, t0, p.token, decBySymbol.get(p.symbol) ?? 18, qDec);
    const depth = quoteDepth(sqrtP, liq, t0.toLowerCase() !== p.token.toLowerCase(), qDec);
    push(p.symbol, {
      venue: "v3", id: p.pool, quote: p.quote, fee: p.fee, price, priceUsd: toUsd(price, p.quote),
      liquidity: liq.toString(), quoteDepthUsd: depth == null ? null : toUsd(depth, p.quote),
    });
  });

  pools.v4.forEach((p, i) => {
    const [s0r, lqr] = [v4Res[i * 2], v4Res[i * 2 + 1]];
    if (!s0r?.success) return;
    const { sqrtPriceX96 } = decodeSlot0(s0r.returnData);
    if (sqrtPriceX96 === 0n) return;
    const liq = lqr?.success ? decodeLiquidity(lqr.returnData) : 0n;
    const qDec = quoteDec.get(p.quote) ?? 18;
    const price = priceFromSqrt(sqrtPriceX96, p.currency0, p.token, decBySymbol.get(p.symbol) ?? 18, qDec);
    const depth = quoteDepth(sqrtPriceX96, liq, p.currency0.toLowerCase() !== p.token.toLowerCase(), qDec);
    push(p.symbol, {
      venue: "v4", id: p.poolId, quote: p.quote, fee: p.fee, dynamicFee: p.dynamicFee,
      tickSpacing: p.tickSpacing, hooks: p.hooks, price, priceUsd: toUsd(price, p.quote),
      liquidity: liq.toString(), quoteDepthUsd: depth == null ? null : toUsd(depth, p.quote),
    });
  });

  const phase = marketPhase();
  const rows: Row[] = assets.map((a, i) => {
    const mRes = tokRes[i * 2], sRes = tokRes[i * 2 + 1];
    const uiMultiplier = mRes?.success
      ? Number((decodeAbiParameters([{ type: "uint256" }], mRes.returnData) as [bigint])[0]) / 1e18 : null;
    const rawTotalSupply = sRes?.success
      ? Number(formatUnits((decodeAbiParameters([{ type: "uint256" }], sRes.returnData) as [bigint])[0], a.decimals)) : null;
    const mismatch =
      uiMultiplier != null && a.restMultiplier != null && Math.abs(uiMultiplier - a.restMultiplier) > 1e-9;

    const ps = (poolsBySymbol.get(a.symbol) ?? []).filter((p) => isFinite(p.price) && p.price > 0);
    // Depth decides, not price: a drained pool still reports its last sqrtPrice.
    const priced = ps.filter((p) => p.priceUsd != null);
    const live = priced.filter((p) => (p.quoteDepthUsd ?? 0) > 0);
    const best = [...(live.length ? live : priced)].sort((x, y) => (y.quoteDepthUsd ?? 0) - (x.quoteDepthUsd ?? 0))[0] ?? null;
    const poolUsd = best?.priceUsd ?? null;
    const depthUsd = live.reduce((s, p) => s + (p.quoteDepthUsd ?? 0), 0);

    const feed = feedBySymbol.get(a.symbol) ?? null;
    const premiumBps = poolUsd != null && feed && feed.price > 0
      ? Math.round((poolUsd / feed.price - 1) * 10_000) : null;
    const quality: Row["quality"] =
      premiumBps == null ? "none" : !live.length ? "empty" : depthUsd < MIN_DEPTH_USD ? "thin" : "ok";

    return {
      symbol: a.symbol, name: a.name, token: a.token, decimals: a.decimals, isin: a.isin,
      uiMultiplier, restMultiplier: a.restMultiplier, multiplierMismatch: mismatch,
      rawTotalSupply,
      adjTotalSupply: rawTotalSupply != null && uiMultiplier != null ? rawTotalSupply * uiMultiplier : null,
      feed, pools: ps,
      best: best ? { venue: best.venue, id: best.id, quote: best.quote, priceUsd: best.priceUsd!, quoteDepthUsd: best.quoteDepthUsd } : null,
      poolUsd, depthUsd, quality, premiumBps,
      impliedMoveBps: phase.offHours && quality === "ok" ? premiumBps : null,
      note: !feed ? "no Chainlink reference — the AMM is the only price" : undefined,
    };
  });

  return {
    ts: new Date().toISOString(), chainId: cfg.chainId, block: block.toString(),
    market: phase,
    registryFetchedAt: reg.fetchedAt, poolsDiscoveredAt: pools.discoveredAt,
    quotes,
    counts: {
      assets: rows.length,
      withFeed: rows.filter((r) => r.feed).length,
      withPool: rows.filter((r) => r.pools.length).length,
      priced: rows.filter((r) => r.premiumBps != null).length,
      trustworthy: rows.filter((r) => r.quality === "ok").length,
      beyondHeartbeat: rows.filter((r) => r.feed?.state === "beyond-heartbeat").length,
    },
    rows,
  };
}
