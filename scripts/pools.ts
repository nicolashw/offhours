/**
 * OffHours — the discovered-pool cache (config/pools.json).
 *
 * Types and the reader live here so the collector can load the cache without
 * pulling in discover.ts, whose top level is a CLI.
 */
import { readFileSync, existsSync } from "node:fs";
import type { Address, Hex } from "viem";

export const POOLS_PATH = "config/pools.json";

export type V3Pool = { symbol: string; token: Address; quote: string; fee: number; pool: Address };
export type V4Pool = {
  symbol: string; token: Address; quote: string; poolId: Hex;
  currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address; dynamicFee: boolean;
  /**
   * Whether this pool held liquidity at the last state sweep.
   *
   * 6,612 V4 pools exist across the universe, and reading all of them costs
   * ~13k extsloads — about a minute against the public RPC, which is too slow
   * for an hourly snapshot and far too slow for an agent's tool call. The vast
   * majority have never held anything. Undefined means "never swept": treated
   * as active so a fresh discovery is never silently narrowed.
   */
  active?: boolean;
};
export type Pools = {
  discoveredAt: string; block: string;
  /** When `active` flags were last refreshed. */
  stateSweptAt?: string;
  v3: V3Pool[]; v4: V4Pool[]; v4ScannedSymbols: string[];
};

/** Pools the collector should read. Set OFFHOURS_ALL_POOLS=1 to ignore the sweep. */
export function activeV4(pools: Pools): V4Pool[] {
  if (process.env.OFFHOURS_ALL_POOLS === "1") return pools.v4;
  return pools.v4.filter((p) => p.active !== false);
}

export function loadPools(path = POOLS_PATH): Pools {
  if (!existsSync(path)) return { discoveredAt: "never", block: "0", v3: [], v4: [], v4ScannedSymbols: [] };
  return JSON.parse(readFileSync(path, "utf8")) as Pools;
}
