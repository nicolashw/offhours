/**
 * OffHours — RPC plumbing shared by every script.
 *
 * The public Robinhood Chain RPC rate-limits aggressively and caps eth_getLogs
 * at 10k results per query, so everything here is built around three habits:
 * batch reads through Multicall3, retry with backoff on 429, and keep the
 * expensive discovery work in committed caches rather than in the hot path.
 */

import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { readFileSync, existsSync } from "node:fs";

export type QuoteCfg = { symbol: string; address: Address; usd: boolean; feed?: Address };
export type Cfg = {
  chainId: number;
  rpcUrl: string;
  multicall3: Address;
  swapRouter02: Address;
  v3Factory: Address;
  v4PoolManager: Address;
  weth9: Address;
  sources: { assets: string; chainlinkFeeds: string };
  quoteTokens: QuoteCfg[];
  notedContracts: Record<string, Address>;
  extraPools: Array<{ address: Address; kind: string; note?: string }>;
};

export function loadEnv() {
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}

export function loadCfg(path = "config/chain.json"): Cfg {
  loadEnv();
  const c = JSON.parse(readFileSync(path, "utf8")) as Cfg;
  if (process.env.RPC_URL) c.rpcUrl = process.env.RPC_URL;
  return c;
}

export function makeClient(cfg: Cfg): PublicClient {
  return createPublicClient({
    transport: http(cfg.rpcUrl, { batch: { wait: 16, batchSize: 20 }, retryCount: 0, timeout: 60_000 }),
    batch: { multicall: false }, // we drive Multicall3 explicitly so failures stay per-call
  }) as PublicClient;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Retry with exponential backoff. The public RPC answers 429 under any real load. */
export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let wait = 800;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = (e as Error).message ?? "";
      const retryable = /429|Too Many Requests|timed out|timeout|fetch failed|ECONN|socket/i.test(msg);
      if (i >= tries - 1 || !retryable) throw new Error(`${label}: ${msg.slice(0, 200)}`);
      await sleep(wait);
      wait = Math.min(wait * 2, 15_000);
    }
  }
}

const multicall3Abi = [
  {
    type: "function",
    name: "aggregate3",
    stateMutability: "payable",
    inputs: [{ name: "calls", type: "tuple[]", components: [
      { name: "target", type: "address" },
      { name: "allowFailure", type: "bool" },
      { name: "callData", type: "bytes" }] }],
    outputs: [{ name: "returnData", type: "tuple[]", components: [
      { name: "success", type: "bool" },
      { name: "returnData", type: "bytes" }] }],
  },
] as const;

export type Call = { target: Address; callData: `0x${string}` };
export type CallResult = { success: boolean; returnData: `0x${string}` };

/**
 * aggregate3 with allowFailure, chunked and self-narrowing.
 *
 * allowFailure means one reverting call (a token with no uiMultiplier(), a pool
 * that was never created) comes back as success:false rather than poisoning the
 * batch. The chunk still has to fit the node's eth_call gas ceiling, which is
 * not advertised anywhere, so a rejected chunk is halved and retried rather
 * than tuned by hand.
 */
export async function multicall(
  client: PublicClient, cfg: Cfg, calls: Call[], chunk = 120,
): Promise<CallResult[]> {
  if (!calls.length) return [];
  const run = async (slice: Call[]): Promise<CallResult[]> => {
    const args = slice.map((c) => ({ target: c.target, allowFailure: true, callData: c.callData }));
    try {
      const res = await withRetry(
        () => client.readContract({ address: cfg.multicall3, abi: multicall3Abi, functionName: "aggregate3", args: [args] }),
        `multicall(${slice.length})`,
      );
      return res as CallResult[];
    } catch (e) {
      if (slice.length <= 8) throw e;
      const mid = Math.ceil(slice.length / 2);
      return [...(await run(slice.slice(0, mid))), ...(await run(slice.slice(mid)))];
    }
  };
  const out: CallResult[] = [];
  for (let i = 0; i < calls.length; i += chunk) out.push(...(await run(calls.slice(i, i + chunk))));
  return out;
}
