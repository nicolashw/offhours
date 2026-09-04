/**
 * OffHours — core collector.
 *
 * Reads, per Stock Token on Robinhood Chain (4663):
 *   - Chainlink feed price + updatedAt  (feeds are deviation-triggered; staleness is itself a signal)
 *   - ERC-8056 uiMultiplier()           (1e18 scaled — confirmed empirically 2026-09-04)
 *   - Uniswap V3 pool prices against every configured quote (USD stables + WETH)
 *   - USD price of the token, converting WETH-quoted pools via a derived ETH/USD
 *   - premiumBps = poolUsd / feedPrice - 1
 *
 * Read-only. No signing, no custody, no execution.
 */

import { createPublicClient, http, formatUnits, getAddress, type Address } from "viem";
import { readFileSync, existsSync } from "node:fs";

export type QuoteCfg = { symbol: string; address: Address; usd: boolean };
export type Cfg = {
  chainId: number;
  rpcUrl: string;
  swapRouter02: Address;
  quoteTokens: QuoteCfg[];
  seedAssets: Array<{ symbol: string; token: Address; feed?: Address }>;
};

export function loadCfg(path = "config/chain.json"): Cfg {
  const c = JSON.parse(readFileSync(path, "utf8"));
  if (existsSync(".env")) {
    for (const line of readFileSync(".env", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    }
  }
  if (process.env.RPC_URL) c.rpcUrl = process.env.RPC_URL;
  return c;
}

const aggregatorV3Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: [
      { name: "roundId", type: "uint80" }, { name: "answer", type: "int256" },
      { name: "startedAt", type: "uint256" }, { name: "updatedAt", type: "uint256" },
      { name: "answeredInRound", type: "uint80" }] },
] as const;

const erc20Abi = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "uiMultiplier", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const swapRouter02Abi = [
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "WETH9", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

const uniV3FactoryAbi = [
  { type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;

const uniV3PoolAbi = [
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "liquidity", stateMutability: "view", inputs: [], outputs: [{ type: "uint128" }] },
  { type: "function", name: "slot0", stateMutability: "view", inputs: [], outputs: [
      { name: "sqrtPriceX96", type: "uint160" }, { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" }, { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" }, { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" }] },
] as const;

const FEE_TIERS = [100, 500, 3000, 10000] as const;
const ZERO = "0x0000000000000000000000000000000000000000";

export type PoolQuote = { pool: Address; quoteSymbol: string; usd: boolean; fee: number; price: number; liquidity: string };
export type Row = {
  symbol: string; token: Address; feed: Address | null;
  decimals?: number; uiMultiplier?: number | null;
  feedPrice?: number; feedUpdatedAt?: string; feedAgeSec?: number; stale?: boolean;
  pools?: PoolQuote[]; bestPool?: string; bestQuote?: string; poolPrice?: number;
  poolUsd?: number; premiumBps?: number; impliedEthUsd?: number; error?: string;
};
export type Snapshot = {
  ts: string; chainId: number; block: string; tokenSource: string;
  factory: string | null; weth9: string | null; ethUsd: number | null; ethUsdSource: string;
  rows: Row[];
};

/** Price of `token` in the quote token, from sqrtPriceX96. */
function poolPriceOfToken(sqrtPriceX96: bigint, token0: Address, token: Address, tokenDec: number, quoteDec: number): number {
  const sqrtP = Number(sqrtPriceX96) / 2 ** 96;
  const p1per0 = sqrtP * sqrtP;
  const isT0 = token0.toLowerCase() === token.toLowerCase();
  return (isT0 ? p1per0 : 1 / p1per0) * 10 ** (tokenDec - quoteDec);
}

function median(xs: number[]): number | null {
  const v = xs.filter((x) => isFinite(x) && x > 0).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

export async function collect(cfg: Cfg, opts: { dumpRest?: boolean } = {}): Promise<Snapshot> {
  const client = createPublicClient({ transport: http(cfg.rpcUrl) });
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlockNumber()]);

  let factory: Address | null = null, weth: Address | null = null;
  try {
    [factory, weth] = await Promise.all([
      client.readContract({ address: cfg.swapRouter02, abi: swapRouter02Abi, functionName: "factory" }) as Promise<Address>,
      client.readContract({ address: cfg.swapRouter02, abi: swapRouter02Abi, functionName: "WETH9" }) as Promise<Address>,
    ]);
  } catch { /* keep null */ }

  const quotes: QuoteCfg[] = [
    ...cfg.quoteTokens.map((q) => ({ ...q, address: getAddress(q.address) })),
    ...(weth ? [{ symbol: "WETH", address: getAddress(weth), usd: false }] : []),
  ];

  // ---- ETH/USD from a WETH<>stable pool, else derived later from token cross-rates ----
  let ethUsd: number | null = null;
  let ethUsdSource = "none";
  const stables = quotes.filter((q) => q.usd);
  if (weth && factory && stables.length) {
    const cands: Array<{ p: number; liq: bigint }> = [];
    for (const s of stables) for (const fee of FEE_TIERS) {
      try {
        const pool = (await client.readContract({ address: factory, abi: uniV3FactoryAbi, functionName: "getPool", args: [weth, s.address, fee] })) as Address;
        if (!pool || pool.toLowerCase() === ZERO) continue;
        const [t0, slot0, liq, sDec] = await Promise.all([
          client.readContract({ address: pool, abi: uniV3PoolAbi, functionName: "token0" }),
          client.readContract({ address: pool, abi: uniV3PoolAbi, functionName: "slot0" }),
          client.readContract({ address: pool, abi: uniV3PoolAbi, functionName: "liquidity" }),
          client.readContract({ address: s.address, abi: erc20Abi, functionName: "decimals" }),
        ]);
        cands.push({ p: poolPriceOfToken(slot0[0], t0 as Address, weth, 18, sDec), liq: liq as bigint });
      } catch { /* skip */ }
    }
    const best = cands.sort((a, b) => (a.liq > b.liq ? -1 : 1))[0];
    if (best && best.p > 0) { ethUsd = best.p; ethUsdSource = "WETH/stable pool"; }
  }

  // ---- asset discovery ----
  let assets = cfg.seedAssets.map((a) => ({ ...a, token: getAddress(a.token), feed: a.feed ? getAddress(a.feed) : undefined }));
  let tokenSource = "config.seedAssets";
  try {
    const res = await fetch("https://api.robinhood.com/rhj/assets", { headers: { accept: "application/json" } });
    const raw = await res.text();
    if (opts.dumpRest) { console.error("--- RAW /rhj/assets (first 4000 chars) ---"); console.error(raw.slice(0, 4000)); console.error("--- end ---"); }
    const body: any = JSON.parse(raw);
    const list: any[] = Array.isArray(body) ? body
      : body.results ?? body.assets ?? body.data ?? body.items ?? body.tokens ?? [];
    const out: typeof assets = [];
    const walk = (a: any) => {
      const symbol = a.symbol ?? a.ticker ?? a.underlying_symbol ?? a.underlyingSymbol;
      const deployments: any[] = a.deployments ?? a.chains ?? a.per_chain ?? a.addresses ?? [];
      const dep = deployments.find((d: any) => Number(d.chainId ?? d.chain_id) === cfg.chainId) ?? deployments[0];
      const token = dep?.address ?? dep?.token_address ?? dep?.tokenAddress ?? a.address ?? a.contract_address ?? a.contractAddress;
      const feed = dep?.priceFeed ?? dep?.price_feed ?? dep?.chainlink_feed ?? dep?.chainlinkFeed ?? a.price_feed ?? a.priceFeed;
      if (symbol && token) out.push({ symbol, token: getAddress(token), feed: feed ? getAddress(feed) : undefined });
    };
    for (const a of list) walk(a);
    if (out.length) {
      const seedFeeds = new Map(assets.map((s) => [s.symbol, s.feed]));
      assets = out.map((a) => (a.feed ? a : { ...a, feed: seedFeeds.get(a.symbol) }));
      tokenSource = `api.robinhood.com/rhj/assets (${out.length})`;
    } else {
      tokenSource = `config.seedAssets (REST parsed but empty; keys=${Object.keys(body).join("|").slice(0, 120)})`;
    }
  } catch (e) {
    tokenSource = `config.seedAssets (REST failed: ${(e as Error).message})`;
  }

  // ---- per-asset reads ----
  const rows: Row[] = [];
  const impliedEth: number[] = [];
  for (const a of assets) {
    const row: Row = { symbol: a.symbol, token: a.token, feed: a.feed ?? null };
    try {
      const [decimals] = await Promise.all([client.readContract({ address: a.token, abi: erc20Abi, functionName: "decimals" })]);
      row.decimals = decimals;
      try {
        const m = await client.readContract({ address: a.token, abi: erc20Abi, functionName: "uiMultiplier" });
        row.uiMultiplier = Number(m) / 1e18;
      } catch { row.uiMultiplier = null; }

      if (a.feed) {
        const [fd, rd] = await Promise.all([
          client.readContract({ address: a.feed, abi: aggregatorV3Abi, functionName: "decimals" }),
          client.readContract({ address: a.feed, abi: aggregatorV3Abi, functionName: "latestRoundData" }),
        ]);
        row.feedPrice = Number(formatUnits(rd[1], fd));
        const updatedAt = Number(rd[3]);
        row.feedUpdatedAt = new Date(updatedAt * 1000).toISOString();
        row.feedAgeSec = Math.floor(Date.now() / 1000) - updatedAt;
        row.stale = row.feedAgeSec > 3600;
      }

      if (factory) {
        const pools: PoolQuote[] = [];
        for (const q of quotes) for (const fee of FEE_TIERS) {
          const pool = (await client.readContract({ address: factory, abi: uniV3FactoryAbi, functionName: "getPool", args: [a.token, q.address, fee] })) as Address;
          if (!pool || pool.toLowerCase() === ZERO) continue;
          const [t0, slot0, liq, qDec] = await Promise.all([
            client.readContract({ address: pool, abi: uniV3PoolAbi, functionName: "token0" }),
            client.readContract({ address: pool, abi: uniV3PoolAbi, functionName: "slot0" }),
            client.readContract({ address: pool, abi: uniV3PoolAbi, functionName: "liquidity" }),
            client.readContract({ address: q.address, abi: erc20Abi, functionName: "decimals" }),
          ]);
          pools.push({ pool, quoteSymbol: q.symbol, usd: q.usd, fee,
            price: poolPriceOfToken(slot0[0], t0 as Address, a.token, decimals, qDec), liquidity: (liq as bigint).toString() });
        }
        row.pools = pools;
        const usdPools = pools.filter((p) => p.usd);
        const best = (usdPools.length ? usdPools : pools).sort((x, y) => (BigInt(x.liquidity) > BigInt(y.liquidity) ? -1 : 1))[0];
        if (best) {
          row.bestPool = best.pool; row.bestQuote = best.quoteSymbol; row.poolPrice = best.price;
          if (best.usd) row.poolUsd = best.price;
          else {
            // WETH-quoted: record implied ETH from this token's own feed for cross-check
            if (row.feedPrice && best.price > 0) { row.impliedEthUsd = row.feedPrice / best.price; impliedEth.push(row.impliedEthUsd); }
          }
        }
      }
    } catch (e) { row.error = (e as Error).message; }
    rows.push(row);
  }

  if (ethUsd == null) { const m = median(impliedEth); if (m) { ethUsd = m; ethUsdSource = "median of feed/WETH-pool cross-rates (circular — cross-check only)"; } }

  for (const r of rows) {
    if (r.poolUsd == null && r.poolPrice != null && r.bestQuote === "WETH" && ethUsd) r.poolUsd = r.poolPrice * ethUsd;
    if (r.poolUsd != null && r.feedPrice) r.premiumBps = Math.round((r.poolUsd / r.feedPrice - 1) * 10_000);
  }

  return { ts: new Date().toISOString(), chainId, block: block.toString(), tokenSource,
    factory, weth9: weth, ethUsd, ethUsdSource, rows };
}
