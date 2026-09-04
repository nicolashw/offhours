/**
 * OffHours — pool discovery, cached to config/pools.json.
 *
 * Discovery is slow and mostly static; collection must be fast and hourly.
 * So the two are split: this script does the expensive crawl once (and again
 * when new pools open), the collector only reads state for what is cached here.
 *
 *   V3  — factory.getPool over the (token x quote x feeTier) grid, batched
 *         through Multicall3. Exact, ~2.3k calls, a few seconds.
 *   V4  — pools are storage entries, not contracts, so the only way in is the
 *         Initialize event. The public RPC caps eth_getLogs at 10k results, and
 *         a quote-token-wide filter blows past that (USDG alone has >10k V4
 *         pools, nearly all memecoins), so we filter per stock token instead:
 *         two indexed queries each, full range, resumable.
 *
 * Usage: npm run discover [-- --v3 | --v4] [-- --force] [-- --symbol AAPL]
 */

import { getAddress, encodeFunctionData, decodeAbiParameters, type Address, type Hex } from "viem";
import { writeFileSync } from "node:fs";
import { loadCfg, makeClient, multicall, withRetry, sleep, getLogsAdaptive, type Cfg } from "./rpc.js";
import { loadRegistry } from "./registry.js";
import { isDynamicFee } from "./v4.js";
import { loadPools, POOLS_PATH, type Pools, type V3Pool, type V4Pool } from "./pools.js";
const FEE_TIERS = [100, 500, 3000, 10000] as const;
const ZERO = "0x0000000000000000000000000000000000000000";
const INITIALIZE_TOPIC = "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438" as Hex;

const factoryAbi = [
  { type: "function", name: "getPool", stateMutability: "view",
    inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;

async function discoverV3(cfg: Cfg, assets: { symbol: string; token: Address }[]): Promise<V3Pool[]> {
  const client = makeClient(cfg);
  const plan: Array<{ symbol: string; token: Address; quote: string; fee: number }> = [];
  for (const a of assets) for (const q of cfg.quoteTokens) for (const fee of FEE_TIERS) {
    if (a.token.toLowerCase() === q.address.toLowerCase()) continue;
    plan.push({ symbol: a.symbol, token: a.token, quote: q.symbol, fee });
  }
  const calls = plan.map((p) => ({
    target: cfg.v3Factory,
    callData: encodeFunctionData({
      abi: factoryAbi, functionName: "getPool",
      args: [p.token, getAddress(cfg.quoteTokens.find((q) => q.symbol === p.quote)!.address), p.fee],
    }),
  }));
  process.stderr.write(`v3: probing ${calls.length} (token,quote,fee) combinations...\n`);
  const res = await multicall(client, cfg, calls);
  const out: V3Pool[] = [];
  res.forEach((r, i) => {
    if (!r.success || r.returnData.length < 66) return;
    const [addr] = decodeAbiParameters([{ type: "address" }], r.returnData) as [Address];
    if (!addr || addr.toLowerCase() === ZERO) return;
    out.push({ ...plan[i], pool: getAddress(addr) });
  });
  return out;
}

/** Initialize logs for one token, as currency0 and as currency1, over the full chain. */
async function v4LogsFor(cfg: Cfg, token: Address, from: bigint, to: bigint): Promise<any[]> {
  const client = makeClient(cfg);
  const pad = (a: Address) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
  const f = { address: cfg.v4PoolManager };
  const asC0 = await getLogsAdaptive(client, { ...f, topics: [INITIALIZE_TOPIC, null, pad(token)] }, from, to);
  await sleep(200);
  const asC1 = await getLogsAdaptive(client, { ...f, topics: [INITIALIZE_TOPIC, null, null, pad(token)] }, from, to);
  return [...asC0, ...asC1];
}

async function discoverV4(
  cfg: Cfg, assets: { symbol: string; token: Address }[], prev: Pools, force: boolean,
  to: bigint, save: (v4: V4Pool[], scanned: string[]) => void,
): Promise<{ v4: V4Pool[]; scanned: string[] }> {
  const quoteByAddr = new Map(cfg.quoteTokens.map((q) => [q.address.toLowerCase(), q.symbol]));
  const done = new Set(force ? [] : prev.v4ScannedSymbols);
  const kept: V4Pool[] = force ? [] : prev.v4.filter((p) => done.has(p.symbol));
  const todo = assets.filter((a) => !done.has(a.symbol));
  process.stderr.write(`v4: ${todo.length} tokens to scan (${done.size} cached)\n`);

  for (const [i, a] of todo.entries()) {
    try {
      const logs = await v4LogsFor(cfg, a.token, 0n, to);
      let hits = 0;
      for (const l of logs) {
        const currency0 = getAddress(`0x${l.topics[2].slice(26)}`);
        const currency1 = getAddress(`0x${l.topics[3].slice(26)}`);
        const other = currency0.toLowerCase() === a.token.toLowerCase() ? currency1 : currency0;
        const quote = quoteByAddr.get(other.toLowerCase());
        if (!quote) continue; // pool against some other token (memecoin pairs) — not a reference price
        const [fee, tickSpacing, hooks] = decodeAbiParameters(
          [{ type: "uint24" }, { type: "int24" }, { type: "address" }], `0x${l.data.slice(2, 2 + 64 * 3)}` as Hex,
        ) as [number, number, Address];
        kept.push({
          symbol: a.symbol, token: a.token, quote, poolId: l.topics[1] as Hex,
          currency0, currency1, fee: Number(fee), tickSpacing: Number(tickSpacing),
          hooks: getAddress(hooks), dynamicFee: isDynamicFee(Number(fee)),
        });
        hits++;
      }
      done.add(a.symbol);
      save(kept, [...done]);   // a 194-token crawl will be interrupted; make every token count
      process.stderr.write(`  [${i + 1}/${todo.length}] ${a.symbol.padEnd(6)} logs=${String(logs.length).padStart(4)} quoted=${hits}\n`);
    } catch (e) {
      process.stderr.write(`  [${i + 1}/${todo.length}] ${a.symbol.padEnd(6)} FAILED ${(e as Error).message.slice(0, 80)}\n`);
    }
    await sleep(250);
  }
  return { v4: kept, scanned: [...done] };
}

const args = process.argv.slice(2);
const only = (f: string) => args.includes(f);
const symbolArg = args.includes("--symbol") ? args[args.indexOf("--symbol") + 1] : null;
const doV3 = only("--v3") || (!only("--v3") && !only("--v4"));
const doV4 = only("--v4") || (!only("--v3") && !only("--v4"));

const cfg = loadCfg();
const reg = loadRegistry();
const assets = reg.assets
  .filter((a) => (symbolArg ? a.symbol === symbolArg : true))
  .map((a) => ({ symbol: a.symbol, token: a.token }));
if (!assets.length) throw new Error(`no assets matched${symbolArg ? ` --symbol ${symbolArg}` : ""}`);

const prev = loadPools();
const client = makeClient(cfg);
const block = await withRetry(() => client.getBlockNumber(), "blockNumber");

const v3 = doV3 ? await discoverV3(cfg, assets) : prev.v3;
const write = (v4: V4Pool[], scanned: string[]) =>
  writeFileSync(POOLS_PATH, JSON.stringify(
    { discoveredAt: new Date().toISOString(), block: block.toString(), v3, v4, v4ScannedSymbols: [...scanned].sort() } satisfies Pools,
    null, 2) + "\n");

if (doV3 && !doV4) write(prev.v4, prev.v4ScannedSymbols);
const { v4, scanned } = doV4
  ? await discoverV4(cfg, assets, prev, only("--force"), block, write)
  : { v4: prev.v4, scanned: prev.v4ScannedSymbols };
write(v4, scanned);

const tokensWithV3 = new Set(v3.map((p) => p.symbol)).size;
const tokensWithV4 = new Set(v4.map((p) => p.symbol)).size;
const hooked = v4.filter((p) => p.hooks !== ZERO).length;
console.log(`${POOLS_PATH} <- block ${block}`);
console.log(`  v3 pools: ${v3.length} across ${tokensWithV3} tokens`);
console.log(`  v4 pools: ${v4.length} across ${tokensWithV4} tokens  (${hooked} carry a hook, ${v4.filter((p) => p.dynamicFee).length} dynamic-fee)`);
console.log(`  v4 scanned symbols: ${scanned.length}/${reg.assets.length}`);
