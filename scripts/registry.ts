/**
 * OffHours — the token universe.
 *
 * Two upstreams, merged and cached in config/registry.json:
 *   1. api.robinhood.com/rhj/assets      — every Robinhood Stock Token, its chain
 *                                          deployment, decimals, ISIN, and the
 *                                          current/pending ERC-8056 multipliers.
 *   2. Chainlink reference-data-directory — the feeds that actually exist on
 *                                          Robinhood Chain, with heartbeat and
 *                                          deviation threshold.
 *
 * The merge is where the first real finding lives: far more tokens exist than
 * have a Chainlink reference price. For a token with no feed, the AMM *is* the
 * only price, and "premium vs reference" is undefined rather than zero.
 *
 * The cache is committed so CI and the dashboard are deterministic and keep
 * working when either upstream is down; `npm run registry` refreshes it.
 */

import { getAddress, type Address } from "viem";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { Cfg } from "./rpc.js";

export type Asset = {
  symbol: string;
  name: string;
  token: Address;
  decimals: number;
  isin: string | null;
  /** ERC-8056 multiplier as reported off-chain; cross-checked against uiMultiplier() on-chain. */
  restMultiplier: number | null;
  /** Non-empty when a dividend/split is queued but not yet applied — a leading indicator. */
  pendingMultiplier: string | null;
  status: string;
  tradable: { market?: string; extended?: string; overnight?: string };
  feed: Address | null;
  feedSecondary: Address | null;
  feedHeartbeat: number | null;
  feedThresholdPct: number | null;
  feedMarketHours: string | null;
};

export type Registry = { fetchedAt: string; chainId: number; assets: Asset[]; feedsUnmatched: string[] };

const REGISTRY_PATH = "config/registry.json";

export function loadRegistry(path = REGISTRY_PATH): Registry {
  if (!existsSync(path)) throw new Error(`${path} missing — run \`npm run registry\` once to build it`);
  const r = JSON.parse(readFileSync(path, "utf8")) as Registry;
  r.assets = r.assets.map((a) => ({ ...a, token: getAddress(a.token), feed: a.feed ? getAddress(a.feed) : null }));
  return r;
}

/** "Robinhood GOOGL / USD" -> "GOOGL"; "BTC.B / USD" -> "BTC.B" */
function feedBase(name: string): string {
  return name.replace(/^Robinhood\s+/i, "").split(/\s*[/-]\s*/)[0].trim().toUpperCase();
}

export async function refreshRegistry(cfg: Cfg, path = REGISTRY_PATH): Promise<Registry> {
  const [assetsRaw, feedsRaw] = await Promise.all([
    fetch(cfg.sources.assets, { headers: { accept: "application/json" } }).then((r) => r.json()),
    fetch(cfg.sources.chainlinkFeeds, { headers: { accept: "application/json" } }).then((r) => r.json()),
  ]);

  const list: any[] = (assetsRaw as any).assets ?? [];
  if (!list.length) throw new Error(`no assets in ${cfg.sources.assets} (keys: ${Object.keys(assetsRaw as any).join("|")})`);

  const feedBySymbol = new Map<string, any>();
  for (const f of feedsRaw as any[]) if (f.proxyAddress) feedBySymbol.set(feedBase(f.name), f);

  const assets: Asset[] = [];
  const usedFeeds = new Set<string>();
  for (const a of list) {
    const dep = (a.deployments ?? []).find((d: any) => Number(d.chainId) === cfg.chainId) ?? (a.deployments ?? [])[0];
    if (!dep?.contractAddress) continue;
    const symbol: string = a.tokenSymbol;
    const f = feedBySymbol.get(symbol.toUpperCase());
    if (f) usedFeeds.add(symbol.toUpperCase());
    const mult = Number(a.currentMultiplier);
    assets.push({
      symbol,
      name: a.tokenName ?? symbol,
      token: getAddress(dep.contractAddress),
      decimals: Number(a.tokenDecimals ?? 18),
      isin: a.isin || null,
      restMultiplier: isFinite(mult) && mult > 0 ? mult : null,
      pendingMultiplier: a.pendingMultiplier || null,
      status: a.status ?? "",
      tradable: {
        market: a.tradingCapabilities?.market?.whole,
        extended: a.tradingCapabilities?.extended?.whole,
        overnight: a.tradingCapabilities?.overnight?.whole,
      },
      feed: f ? getAddress(f.proxyAddress) : null,
      feedSecondary: f?.secondaryProxyAddress ? getAddress(f.secondaryProxyAddress) : null,
      feedHeartbeat: f ? Number(f.heartbeat) : null,
      feedThresholdPct: f ? Number(f.threshold) : null,
      feedMarketHours: f?.docs?.marketHours ?? null,
    });
  }
  assets.sort((x, y) => x.symbol.localeCompare(y.symbol));

  const feedsUnmatched = (feedsRaw as any[])
    .filter((f) => f.proxyAddress && !usedFeeds.has(feedBase(f.name)))
    .map((f) => `${f.name} @ ${f.proxyAddress}`)
    .sort();

  const reg: Registry = { fetchedAt: new Date().toISOString(), chainId: cfg.chainId, assets, feedsUnmatched };
  writeFileSync(path, JSON.stringify(reg, null, 2) + "\n");
  return reg;
}
