#!/usr/bin/env node
/**
 * OffHours MCP server — the same collector, exposed to agents.
 *
 * Deliberately the *same* collect() the dashboard and the snapshot series use,
 * not a parallel implementation: two code paths would eventually disagree about
 * a price, and the whole point of this project is that the number is defensible.
 *
 * A full pass is ~60s and ~14k contract reads, so snapshots are memoised for
 * SNAPSHOT_TTL_MS and every response states the block and timestamp it came
 * from. Everything here is read-only: no signing, no custody, no execution, and
 * no tool that would let an agent move an asset.
 *
 * Run: npm run mcp        (stdio transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { formatUnits, getAddress, type Address } from "viem";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { collect, type Snapshot, type Row } from "./collect.js";
import { loadCfg, makeClient, multicall, type Cfg } from "./rpc.js";
import { loadRegistry } from "./registry.js";
import { encodeFunctionData } from "viem";

const cfg: Cfg = loadCfg();
const TTL = Number(process.env.SNAPSHOT_TTL_MS ?? 120_000);

let cached: { at: number; snap: Snapshot } | null = null;
let inflight: Promise<Snapshot> | null = null;

/** One collection at a time, reused for TTL. Concurrent callers share the pass. */
async function snapshot(force = false): Promise<Snapshot> {
  if (!force && cached && Date.now() - cached.at < TTL) return cached.snap;
  if (inflight) return inflight;
  inflight = collect(cfg)
    .then((snap) => { cached = { at: Date.now(), snap }; return snap; })
    .finally(() => { inflight = null; });
  return inflight;
}

const asOf = (s: Snapshot) => ({
  ts: s.ts, block: s.block, chainId: s.chainId,
  marketPhase: s.market.phase, etTime: s.market.etTime, offHours: s.market.offHours,
});

const json = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });

function findRows(s: Snapshot, symbols?: string[]): Row[] {
  if (!symbols?.length) return s.rows;
  const want = new Set(symbols.map((x) => x.trim().toUpperCase()));
  return s.rows.filter((r) => want.has(r.symbol.toUpperCase()));
}

const server = new McpServer({ name: "offhours", version: "0.2.0" });

server.registerTool(
  "list_stock_tokens",
  {
    title: "List Robinhood Stock Tokens",
    description:
      "Every Stock Token on Robinhood Chain with its contract address, decimals, ISIN, ERC-8056 multiplier, " +
      "whether a Chainlink reference feed exists for it, and how much AMM depth backs its price. " +
      "Note that most tokens have no Chainlink feed at all — for those the AMM is the only on-chain price.",
    inputSchema: {
      withFeedOnly: z.boolean().optional().describe("only tokens that have a Chainlink reference feed"),
      minDepthUsd: z.number().optional().describe("only tokens with at least this much consensus pool depth"),
      search: z.string().optional().describe("case-insensitive substring match on symbol or name"),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async ({ withFeedOnly, minDepthUsd, search, limit }) => {
    const s = await snapshot();
    let rows = s.rows;
    if (withFeedOnly) rows = rows.filter((r) => r.feed);
    if (minDepthUsd != null) rows = rows.filter((r) => r.depthUsd >= minDepthUsd);
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter((r) => r.symbol.toLowerCase().includes(q) || r.name.toLowerCase().includes(q));
    }
    return json({
      asOf: asOf(s),
      total: s.rows.length, matched: rows.length,
      tokens: rows.slice(0, limit ?? 200).map((r) => ({
        symbol: r.symbol, name: r.name, token: r.token, decimals: r.decimals, isin: r.isin,
        uiMultiplier: r.uiMultiplier, hasChainlinkFeed: !!r.feed,
        priceUsd: r.poolUsd, depthUsd: Math.round(r.depthUsd), quality: r.quality,
      })),
    });
  },
);

server.registerTool(
  "get_premium_discount",
  {
    title: "Premium / discount vs the Chainlink reference",
    description:
      "Pool consensus price against the Chainlink reference, in basis points, with everything needed to " +
      "judge it: the age of the reference and its heartbeat, the depth behind the pool price, the " +
      "dispersion across venues, and which US market session the reading was taken in. " +
      "During the regular session this is a basis; outside it the reference is frozen at the last " +
      "regular-session print, so the same number reads as the market's implied view of the next open.",
    inputSchema: {
      symbols: z.array(z.string()).optional().describe("omit for every token that has a reference feed"),
      minQuality: z.enum(["ok", "thin", "any"]).optional().describe("default ok — excludes drained pools"),
    },
  },
  async ({ symbols, minQuality }) => {
    const s = await snapshot();
    const rank = { ok: 3, thin: 2, empty: 1, none: 0 } as const;
    const floor = rank[(minQuality === "any" ? "empty" : minQuality ?? "ok") as keyof typeof rank];
    const rows = findRows(s, symbols)
      .filter((r) => r.premiumBps != null && rank[r.quality] >= floor)
      .sort((a, b) => b.premiumBps! - a.premiumBps!);
    return json({
      asOf: asOf(s),
      reading: s.market.offHours
        ? "off-hours: the reference is frozen, so premium reads as the implied move into the next open"
        : "regular session: the reference tracks the underlying, so premium is a live basis",
      results: rows.map((r) => ({
        symbol: r.symbol,
        premiumBps: r.premiumBps,
        impliedMoveBps: r.impliedMoveBps,
        poolUsd: r.poolUsd,
        referenceUsd: r.feed!.price,
        referenceAgeSec: r.feed!.ageSec,
        referenceHeartbeatSec: r.feed!.heartbeat,
        referenceState: r.feed!.state,
        depthUsd: Math.round(r.depthUsd),
        dispersionBps: r.dispersionBps,
        livePools: r.livePools,
        quality: r.quality,
      })),
    });
  },
);

server.registerTool(
  "get_implied_price",
  {
    title: "Off-hours implied price",
    description:
      "What the on-chain market thinks a token is worth right now, next to the last reference print. " +
      "Only meaningful outside the US regular session — during the session the reference is live and " +
      "this degenerates into the basis. Returns nothing implied when the market is open, and says so.",
    inputSchema: { symbols: z.array(z.string()).optional() },
  },
  async ({ symbols }) => {
    const s = await snapshot();
    const rows = findRows(s, symbols).filter((r) => r.feed && r.poolUsd != null && r.quality === "ok");
    return json({
      asOf: asOf(s),
      applicable: s.market.offHours,
      note: s.market.offHours
        ? "US market is closed. The Chainlink reference holds the last regular-session print; the pool price is live."
        : "US regular session is open — the reference is tracking the underlying, so there is no implied-price gap to report.",
      results: rows.map((r) => ({
        symbol: r.symbol,
        impliedPriceUsd: r.poolUsd,
        lastReferenceUsd: r.feed!.price,
        lastReferenceAt: r.feed!.updatedAt,
        impliedMoveBps: r.impliedMoveBps,
        depthUsd: Math.round(r.depthUsd),
        dispersionBps: r.dispersionBps,
      })),
    });
  },
);

server.registerTool(
  "get_liquidity",
  {
    title: "Pool-level liquidity for a token",
    description:
      "Every Uniswap pool for a token across V3 and V4, with the virtual quote depth backing each price. " +
      "V4 pools are storage entries in the singleton PoolManager, identified by poolId rather than an " +
      "address. Pools flagged `outlier` are more than 10% away from the depth-weighted median and do not " +
      "contribute to the consensus price — mostly never-traded pools opened at absurd fee tiers.",
    inputSchema: {
      symbol: z.string(),
      includeOutliers: z.boolean().optional().describe("default true"),
      limit: z.number().int().min(1).max(500).optional(),
    },
  },
  async ({ symbol, includeOutliers, limit }) => {
    const s = await snapshot();
    const r = findRows(s, [symbol])[0];
    if (!r) return json({ error: `unknown symbol ${symbol}`, known: s.rows.length });
    const pools = (includeOutliers === false ? r.pools.filter((p) => !p.outlier) : r.pools)
      .slice()
      .sort((a, b) => (b.quoteDepthUsd ?? 0) - (a.quoteDepthUsd ?? 0));
    return json({
      asOf: asOf(s),
      symbol: r.symbol, token: r.token,
      consensusPriceUsd: r.poolUsd, consensusDepthUsd: Math.round(r.depthUsd),
      dispersionBps: r.dispersionBps, poolsTotal: r.pools.length, poolsInConsensus: r.livePools,
      pools: pools.slice(0, limit ?? 100),
    });
  },
);

server.registerTool(
  "get_feed_status",
  {
    title: "Chainlink reference health",
    description:
      "Age of every Stock Token reference feed against its own heartbeat. These feeds are 24h-heartbeat / " +
      "0.5%-deviation and marked us_equities_24/5, so an old price is usually in spec rather than broken — " +
      "but for any protocol valuing these tokens as collateral, how old is the question that matters. " +
      "Robinhood Chain publishes no sequencer uptime feed, so observed age is the only available proxy for " +
      "sequencer health.",
    inputSchema: { minAgeSec: z.number().optional(), symbols: z.array(z.string()).optional() },
  },
  async ({ minAgeSec, symbols }) => {
    const s = await snapshot();
    const rows = findRows(s, symbols)
      .filter((r) => r.feed && r.feed.ageSec >= (minAgeSec ?? 0))
      .sort((a, b) => b.feed!.ageSec - a.feed!.ageSec);
    return json({
      asOf: asOf(s),
      tokensWithoutAnyFeed: s.counts.assets - s.counts.withFeed,
      sequencerUptimeFeed: null,
      results: rows.map((r) => ({
        symbol: r.symbol, feed: r.feed!.address, priceUsd: r.feed!.price,
        updatedAt: r.feed!.updatedAt, ageSec: r.feed!.ageSec,
        heartbeatSec: r.feed!.heartbeat, deviationThresholdPct: r.feed!.thresholdPct,
        state: r.feed!.state,
      })),
    });
  },
);

const erc20BalanceAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

server.registerTool(
  "resolve_balance",
  {
    title: "Multiplier-correct token balance",
    description:
      "What a wallet actually holds. Stock Tokens carry an ERC-8056 uiMultiplier() that absorbs splits and " +
      "distributions without changing balanceOf, so the raw balance is not the position: CRWD's multiplier " +
      "is currently 4.0, meaning balanceOf reports a quarter of the real holding. Returns raw and adjusted " +
      "side by side, plus the USD value at the consensus pool price. Read-only.",
    inputSchema: {
      address: z.string().describe("wallet address"),
      symbols: z.array(z.string()).optional().describe("omit to check every token the wallet holds"),
    },
  },
  async ({ address, symbols }) => {
    let owner: Address;
    try { owner = getAddress(address); } catch { return json({ error: `not a valid address: ${address}` }); }

    const reg = loadRegistry();
    const assets = symbols?.length
      ? reg.assets.filter((a) => new Set(symbols.map((x) => x.toUpperCase())).has(a.symbol.toUpperCase()))
      : reg.assets;
    if (!assets.length) return json({ error: "no matching symbols", known: reg.assets.length });

    const client = makeClient(cfg);
    const res = await multicall(client, cfg, assets.map((a) => ({
      target: a.token,
      callData: encodeFunctionData({ abi: erc20BalanceAbi, functionName: "balanceOf", args: [owner] }),
    })));

    const s = await snapshot();
    const priceBySymbol = new Map(s.rows.map((r) => [r.symbol, { usd: r.poolUsd, quality: r.quality }]));

    const holdings = assets.map((a, i) => {
      const ok = res[i]?.success && res[i].returnData !== "0x";
      const raw = ok ? Number(formatUnits(BigInt(res[i].returnData), a.decimals)) : 0;
      const m = a.restMultiplier ?? 1;
      const p = priceBySymbol.get(a.symbol);
      return {
        symbol: a.symbol, token: a.token,
        rawBalance: raw, uiMultiplier: m, adjustedBalance: raw * m,
        multiplierMatters: Math.abs(m - 1) > 1e-9,
        priceUsd: p?.usd ?? null, priceQuality: p?.quality ?? "none",
        valueUsd: p?.usd != null ? raw * m * p.usd : null,
      };
    }).filter((h) => h.rawBalance > 0);

    return json({
      asOf: asOf(s),
      address: owner,
      note: "adjustedBalance = balanceOf x uiMultiplier. Anything showing rawBalance alone is wrong after a split or distribution.",
      checked: assets.length, holding: holdings.length,
      totalValueUsd: holdings.reduce((t, h) => t + (h.valueUsd ?? 0), 0),
      holdings: holdings.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)),
    });
  },
);

server.registerTool(
  "get_holders",
  {
    title: "True float and holder breakdown",
    description:
      "Holder distribution for a token, split into AMM pools, protocol contracts and actual wallets, with " +
      "the true float left after removing market-making inventory and escrow. Served from the analysis " +
      "cache in data/holders/ because rebuilding it means replaying every Transfer log for the token; run " +
      "`npm run holders -- --symbol X --save` to add one.",
    inputSchema: { symbol: z.string() },
  },
  async ({ symbol }) => {
    const sym = symbol.toUpperCase();
    const path = `data/holders/${sym}.json`;
    if (!existsSync(path)) {
      const available = existsSync("data/holders")
        ? readdirSync("data/holders").filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", ""))
        : [];
      return json({
        error: `no holder analysis cached for ${sym}`,
        available,
        howToBuild: `npm run holders -- --symbol ${sym} --save`,
      });
    }
    const report = JSON.parse(readFileSync(path, "utf8"));
    return json({ ...report, holders: report.holders.slice(0, 50), holdersTruncatedTo: 50 });
  },
);

// Warm the cache while the client is still negotiating, so the first tool call
// does not pay for a cold pass. Failures here are irrelevant — the call retries.
void snapshot().catch(() => {});

await server.connect(new StdioServerTransport());
