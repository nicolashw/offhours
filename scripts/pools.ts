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
};
export type Pools = { discoveredAt: string; block: string; v3: V3Pool[]; v4: V4Pool[]; v4ScannedSymbols: string[] };

export function loadPools(path = POOLS_PATH): Pools {
  if (!existsSync(path)) return { discoveredAt: "never", block: "0", v3: [], v4: [], v4ScannedSymbols: [] };
  return JSON.parse(readFileSync(path, "utf8")) as Pools;
}
