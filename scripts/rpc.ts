/**
 * OffHours — RPC plumbing shared by every script.
 *
 * The public Robinhood Chain RPC rate-limits aggressively and caps eth_getLogs
 * at 10k results per query, so everything here is built around three habits:
 * batch reads through Multicall3, retry with backoff on 429, and keep the
 * expensive discovery work in committed caches rather than in the hot path.
 */

import { createPublicClient, http, type Address, type Hex, type PublicClient } from "viem";
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
    // No JSON-RPC batching: the node returns a malformed body for large batch
    // payloads, which surfaces from viem as an unrelated undefined-read. One
    // Multicall3 call per HTTP request is already the batching that matters.
    transport: http(cfg.rpcUrl, { retryCount: 0, timeout: 60_000 }),
    batch: { multicall: false }, // we drive Multicall3 explicitly so failures stay per-call
  }) as PublicClient;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Flatten an error and everything it wraps into one searchable string.
 * viem buries the node's actual message under `details`/`cause`, and a 429 that
 * arrives with a non-JSON body surfaces as a generic parameter complaint — so
 * matching on `.message` alone misclassifies rate limiting as a real failure.
 */
export function errText(e: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let cur: any = e;
  while (cur && !seen.has(cur) && parts.length < 8) {
    seen.add(cur);
    for (const k of ["shortMessage", "details", "message"]) if (typeof cur[k] === "string") parts.push(cur[k]);
    cur = cur.cause;
  }
  return parts.join(" | ");
}

const RETRYABLE = /429|too many requests|rate limit|timed out|timeout|fetch failed|ECONN|socket|missing or invalid parameters|internal error/i;

/** Retry with exponential backoff. The public RPC answers 429 under any real load. */
export async function withRetry<T>(fn: () => Promise<T>, label: string, tries = 5): Promise<T> {
  let wait = 1_000;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = errText(e);
      if (i >= tries - 1 || !RETRYABLE.test(msg)) throw new Error(`${label}: ${msg.slice(0, 220)}`);
      await sleep(wait);
      wait = Math.min(wait * 2, 20_000);
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

/** Multicall chunks in flight at once. Tuned against the public RPC's rate limiter. */
const CONCURRENCY = Number(process.env.RPC_CONCURRENCY ?? 4);

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
  // A full pass is ~14k reads, i.e. ~100 sequential round-trips at public-RPC
  // latency — a minute of mostly waiting. A handful in flight at a time cuts
  // that to seconds and still stays under the rate limiter.
  const slices: Call[][] = [];
  for (let i = 0; i < calls.length; i += chunk) slices.push(calls.slice(i, i + chunk));
  const results: CallResult[][] = new Array(slices.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= slices.length) return;
      results[i] = await run(slices[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, slices.length) }, worker));
  return results.flat();
}

/**
 * eth_getLogs over a wide range, in windows, bisecting a window that fails.
 *
 * Purely reactive bisection is a trap here: the first attempt spans ~54M blocks
 * and always fails, and with retry-and-backoff at every level the split tree
 * costs minutes per branch before a single log comes back. So the range is
 * walked in fixed windows and only a window that the node refuses gets split.
 *
 * The node refuses two ways — `exceeds limit of 10000` and `log query timed
 * out` — and both mean the same thing: ask for less. Rate limiting is separate
 * and is handled by withRetry, not by splitting.
 */
export async function getLogsAdaptive(
  client: PublicClient,
  filter: { address: Address; topics: (Hex | Hex[] | null)[] },
  from: bigint, to: bigint,
  onProgress?: (from: bigint, to: bigint, n: number) => void,
  step = BigInt(process.env.LOG_WINDOW ?? 2_000_000),
): Promise<any[]> {
  const hex = (n: bigint) => `0x${n.toString(16)}` as Hex;

  const fetchRange = async (lo: bigint, hi: bigint, depth: number): Promise<any[]> => {
    try {
      const logs = (await withRetry(
        () => client.request({
          method: "eth_getLogs",
          params: [{ fromBlock: hex(lo), toBlock: hex(hi), address: filter.address, topics: filter.topics }],
        } as any),
        "getLogs", 4,
      )) as any[];
      onProgress?.(lo, hi, logs.length);
      return logs;
    } catch (e) {
      const msg = errText(e);
      const splittable = /exceeds limit|timed out|timeout|unknown RPC|response size|too large|missing or invalid/i.test(msg);
      if (!splittable || hi - lo < 2_000n || depth > 14) throw e;
      const mid = lo + (hi - lo) / 2n;
      return [...(await fetchRange(lo, mid, depth + 1)), ...(await fetchRange(mid + 1n, hi, depth + 1))];
    }
  };

  const out: any[] = [];
  for (let lo = from; lo <= to; lo += step) {
    const hi = lo + step - 1n > to ? to : lo + step - 1n;
    out.push(...(await fetchRange(lo, hi, 0)));
    await sleep(60);
  }
  return out;
}
