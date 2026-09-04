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
import { loadPools, activeV4, type Pools } from "./pools.js";
import { extsloadCalldata, stateSlotOf, addSlot, decodeSlot0, decodeLiquidity, LIQUIDITY_OFFSET } from "./v4.js";
import { marketPhase, type Phase } from "./market.js";

export { loadCfg } from "./rpc.js";

const erc20BalanceAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

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

/** Below this much virtual quote depth across all venues, a price is indicative at best. */
const MIN_DEPTH_USD = Number(process.env.MIN_DEPTH_USD ?? 50_000);

/** Relative distance from the depth-weighted median past which a pool stops being a price. */
const OUTLIER_TOL = 0.10;

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
   * Quote-normalised liquidity: y = L*sqrt(P), or x = L/sqrt(P) when the quote
   * is token0. Comparable across pools of the same token and zero for a drained
   * one, which is what makes it useful — but NOT a dollar amount. It is the
   * virtual reserve of a full-range position with this L, and for the tight
   * ranges these pools actually use it overshoots wildly: SGOV's deepest pool
   * scores $1.19B against a token whose entire supply is worth $1.5M.
   */
  depthScore: number | null;
  /**
   * Real money in the pool, in USD.
   *
   * V3 pools hold their own reserves, so this is `balanceOf` on both sides —
   * exact. V4 pools do not exist as contracts and their reserves are commingled
   * inside the singleton PoolManager, so per-pool reserves cannot be read at
   * all; the manager's balance of the token is apportioned across that token's
   * V4 pools by depthScore and doubled for the quote side. `tvlBasis` says
   * which of the two you are looking at.
   */
  tvlUsd: number | null;
  tvlBasis?: "reserves" | "allocated";
  /** Reserve inputs, kept so TVL can be valued at the consensus price rather than the pool's own. */
  tokenUnits?: number | null;
  quoteSideUsd?: number | null;
  /**
   * Priced more than OUTLIER_TOL away from the depth-weighted median of this
   * token's live pools, so excluded from the consensus.
   *
   * V4 lets anyone open a pool at any fee, and they have: DELL alone has pools
   * at 40%, 90% and 95% fee quoting $693, $3527 and $45 against a real market
   * at $521. They hold a few hundred dollars each and never trade, but they are
   * real initialised pools, so they are kept and flagged rather than hidden.
   */
  outlier?: boolean;
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
  best: { venue: string; id: string; quote: string; priceUsd: number; tvlUsd: number | null } | null;
  /** Depth-weighted price across every live pool — the venue-blind number. */
  poolUsd: number | null;
  /**
   * Depth-weighted dispersion of pool prices, in bps of the consensus.
   * Near zero means the venues are arbitraged against each other; a wide value
   * means the "price" is really one pool's opinion and the premium below
   * inherits that uncertainty.
   */
  dispersionBps: number | null;
  /** Live pools that survived the outlier filter and set the consensus price. */
  livePools: number;
  /** Virtual quote depth across the pools that make up the consensus, in USD. */
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

/** Depth-weighted median price — the robust centre before outliers are judged. */
function weightedMedian(items: Array<{ p: number; w: number }>): number | null {
  const xs = items.filter((i) => i.w > 0 && isFinite(i.p) && i.p > 0).sort((a, b) => a.p - b.p);
  const total = xs.reduce((s, i) => s + i.w, 0);
  if (!total) return null;
  let acc = 0;
  for (const i of xs) { acc += i.w; if (acc >= total / 2) return i.p; }
  return xs[xs.length - 1].p;
}

/** Quote-normalised liquidity at the current tick (see PoolRead.depthScore). */
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
  const v4Pools = activeV4(pools);
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
  const v4Calls = v4Pools.flatMap((p) => {
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
      liquidity: liq.toString(), depthScore: depth == null ? null : toUsd(depth, p.quote), tvlUsd: null,
    });
  });

  v4Pools.forEach((p, i) => {
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
      liquidity: liq.toString(), depthScore: depth == null ? null : toUsd(depth, p.quote), tvlUsd: null,
    });
  });

  // ---- real money in each pool ----
  //
  // depthScore is liquidity, not dollars, and for tight ranges it overshoots by
  // orders of magnitude — so the weighting and the "is this a real market" gate
  // both run on actual reserves instead.
  //
  // V3 pools custody their own tokens, so this is two balanceOf calls. V4 pools
  // are storage entries and their reserves sit commingled in the singleton, so
  // per-pool reserves do not exist to be read: the manager's balance of the
  // token is split across that token's V4 pools by depthScore. Approximate, and
  // labelled as such, but bounded by a real balance rather than by an
  // extrapolation from L.
  const balOf = (token: Address, holder: Address) =>
    call(token, encodeFunctionData({ abi: erc20BalanceAbi, functionName: "balanceOf", args: [holder] }) as Hex);

  const v3ForBal = pools.v3.filter((p) => (poolsBySymbol.get(p.symbol) ?? []).some((x) => x.id === p.pool));
  const v4Symbols = [...new Set(v4Pools.map((p) => p.symbol))];
  const balCalls = [
    ...v3ForBal.flatMap((p) => [
      balOf(p.token, p.pool),
      balOf(getAddress(cfg.quoteTokens.find((q) => q.symbol === p.quote)!.address), p.pool),
    ]),
    ...v4Symbols.map((sym) => balOf(assets.find((a) => a.symbol === sym)!.token, cfg.v4PoolManager)),
  ];
  const balRes = balCalls.length ? await multicall(client, cfg, balCalls) : [];

  const num = (r: CallResult | undefined, dec: number) =>
    r?.success && r.returnData !== "0x"
      ? Number(formatUnits((decodeAbiParameters([{ type: "uint256" }], r.returnData) as [bigint])[0], dec))
      : null;

  v3ForBal.forEach((p, i) => {
    const pr = (poolsBySymbol.get(p.symbol) ?? []).find((x) => x.id === p.pool);
    if (!pr) return;
    pr.tokenUnits = num(balRes[i * 2], decBySymbol.get(p.symbol) ?? 18);
    const qUnits = num(balRes[i * 2 + 1], quoteDec.get(p.quote) ?? 18);
    pr.quoteSideUsd = qUnits == null ? null : toUsd(qUnits, p.quote);
    pr.tvlBasis = "reserves";
  });

  const v4Base = v3ForBal.length * 2;
  const v4ManagerUnits = new Map<string, number | null>();
  v4Symbols.forEach((sym, i) => v4ManagerUnits.set(sym, num(balRes[v4Base + i], decBySymbol.get(sym) ?? 18)));

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
    // Liveness is decided by liquidity, not by reserves: tokens sent to a pool
    // address sit in balanceOf without making it a market, and a pool at an
    // extreme tick would otherwise value them at an absurd price and take over
    // the median it is supposed to be judged against.
    const live = priced.filter((p) => (p.depthScore ?? 0) > 0);
    // Robust centre first, then judge each pool against it. Without this step a
    // handful of never-traded 90%-fee V4 pools drag the consensus and blow up the
    // dispersion of otherwise tightly-arbitraged names.
    const med = weightedMedian(live.map((p) => ({ p: p.priceUsd!, w: p.depthScore ?? 0 })));
    if (med) for (const p of live) p.outlier = Math.abs(p.priceUsd! / med - 1) > OUTLIER_TOL;
    const core = live.filter((p) => !p.outlier);

    const best = [...(core.length ? core : live.length ? live : priced)]
      .sort((x, y) => (y.depthScore ?? 0) - (x.depthScore ?? 0))[0] ?? null;

    // Depth-weighted consensus rather than "whichever pool happens to be deepest":
    // with 6.6k V4 pools alongside V3, a single venue's quote is an opinion, and the
    // spread between the venues that agree is information in its own right.
    let poolUsd: number | null = null;
    let dispersionBps: number | null = null;
    const wTotal = core.reduce((s, p) => s + (p.depthScore ?? 0), 0);
    if (core.length && wTotal > 0) {
      poolUsd = core.reduce((s, p) => s + p.priceUsd! * (p.depthScore ?? 0), 0) / wTotal;
      const varW = core.reduce((s, p) => s + (p.depthScore ?? 0) * (p.priceUsd! - poolUsd!) ** 2, 0) / wTotal;
      dispersionBps = poolUsd > 0 ? Math.round((Math.sqrt(varW) / poolUsd) * 10_000) : null;
    } else if (best) {
      poolUsd = best.priceUsd ?? null; // every pool drained: report the fossil, flagged as such
    }

    // Now that there is a price worth trusting, value the reserves at it. Doing
    // this the other way round lets a mispriced pool inflate its own weight.
    const px = poolUsd ?? 0;
    const v4Total = ps.filter((p) => p.venue === "v4").reduce((t, p) => t + (p.depthScore ?? 0), 0);
    const mgr = v4ManagerUnits.get(a.symbol) ?? null;
    for (const p of ps) {
      if (p.venue === "v3") {
        p.tvlUsd = p.tokenUnits == null ? null : p.tokenUnits * px + (p.quoteSideUsd ?? 0);
      } else {
        p.tvlUsd = mgr == null || v4Total <= 0 ? 0 : 2 * mgr * ((p.depthScore ?? 0) / v4Total) * px;
        p.tvlBasis = "allocated";
      }
    }
    const depthUsd = core.reduce((s, p) => s + (p.tvlUsd ?? 0), 0);

    const feed = feedBySymbol.get(a.symbol) ?? null;
    const premiumBps = poolUsd != null && feed && feed.price > 0
      ? Math.round((poolUsd / feed.price - 1) * 10_000) : null;
    const quality: Row["quality"] =
      premiumBps == null ? "none" : !core.length ? "empty" : depthUsd < MIN_DEPTH_USD ? "thin" : "ok";

    return {
      symbol: a.symbol, name: a.name, token: a.token, decimals: a.decimals, isin: a.isin,
      uiMultiplier, restMultiplier: a.restMultiplier, multiplierMismatch: mismatch,
      rawTotalSupply,
      adjTotalSupply: rawTotalSupply != null && uiMultiplier != null ? rawTotalSupply * uiMultiplier : null,
      feed, pools: ps,
      best: best ? { venue: best.venue, id: best.id, quote: best.quote, priceUsd: best.priceUsd!, tvlUsd: best.tvlUsd } : null,
      poolUsd, dispersionBps, livePools: core.length, depthUsd, quality, premiumBps,
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
