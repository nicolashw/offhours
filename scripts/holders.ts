/**
 * OffHours — true float, reconstructed from Transfer logs.
 *
 * There is no public block explorer API for Robinhood Chain, so the holder set
 * is rebuilt from the token's own Transfer events and the balances summed. That
 * turns out to be the better source anyway: an explorer's holder list flatters
 * the asset by counting AMM pools and protocol escrow as "holders".
 *
 * Classification needs no explorer either. Every address is one of:
 *   pool     — an address in config/pools.json, or the V4 PoolManager singleton
 *   contract — has code: escrow, treasury, distributor, router, vault
 *   wallet   — no code: an actual holder
 *
 * true float = supply - pools - contracts. Balances are reported both raw
 * (what balanceOf returns) and multiplier-adjusted (what the position actually
 * is under ERC-8056) — for a token like CRWD, mid-4:1-split, those differ by 4x.
 *
 * Usage: npm run holders -- --symbol USO [--top 30] [--json] [--save]
 */

import { getAddress, formatUnits, type Address, type Hex } from "viem";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { loadCfg, makeClient, withRetry, getLogsAdaptive, type Cfg } from "./rpc.js";
import { loadRegistry } from "./registry.js";
import { loadPools } from "./pools.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef" as Hex;
const ZERO = "0x0000000000000000000000000000000000000000";

type Category = "pool" | "escrow" | "protocol" | "router" | "contract" | "wallet";

type Labels = {
  addresses: Record<string, { label: string; category: Category }>;
  nameRules: Array<{ match: string; category: Category }>;
};

function loadLabels(path = "config/labels.json"): Labels {
  if (!existsSync(path)) return { addresses: {}, nameRules: [] };
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const addresses: Labels["addresses"] = {};
  for (const [k, v] of Object.entries(raw.addresses ?? {})) addresses[getAddress(k)] = v as any;
  return { addresses, nameRules: raw.nameRules ?? [] };
}

export type Holder = {
  address: Address; label: string | null; category: Category;
  raw: number; adjusted: number; pct: number;
  firstBlock: number; lastBlock: number; transfers: number;
};

export type HolderReport = {
  symbol: string; token: Address; ts: string; block: string;
  decimals: number; uiMultiplier: number | null;
  transfersScanned: number;
  supplyRaw: number; supplyAdjusted: number;
  byCategory: Record<Category, { count: number; raw: number; pct: number }>;
  trueFloatRaw: number; trueFloatPct: number;
  poolSharePct: number;
  topWalletsShareOfFloatPct: number;
  holders: Holder[];
};

const args = process.argv.slice(2);
const arg = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const symbol = (arg("--symbol") ?? "").toUpperCase();
const top = Number(arg("--top") ?? 30);
if (!symbol) throw new Error("usage: npm run holders -- --symbol USO [--top 30] [--json] [--save]");

const cfg: Cfg = loadCfg();
const client = makeClient(cfg);
const reg = loadRegistry();
const asset = reg.assets.find((a) => a.symbol.toUpperCase() === symbol);
if (!asset) throw new Error(`unknown symbol ${symbol} (registry has ${reg.assets.length} assets)`);

const pools = loadPools();
const poolAddrs = new Set<string>([
  ...pools.v3.map((p) => p.pool.toLowerCase()),
  cfg.v4PoolManager.toLowerCase(),
  ...cfg.extraPools.map((p) => p.address.toLowerCase()),
]);
const labels = loadLabels();

const block = await withRetry(() => client.getBlockNumber(), "blockNumber");
process.stderr.write(`scanning ${symbol} (${asset.token}) Transfer logs to block ${block}...\n`);

let scanned = 0;
const logs = await getLogsAdaptive(
  client, { address: asset.token, topics: [TRANSFER_TOPIC] }, 0n, block,
  (_f, _t, n) => { scanned += n; if (scanned % 5000 < n) process.stderr.write(`  ${scanned} transfers\n`); },
);

const bal = new Map<string, bigint>();
const first = new Map<string, number>();
const last = new Map<string, number>();
const count = new Map<string, number>();
const touch = (a: string, blk: number) => {
  if (!first.has(a)) first.set(a, blk);
  last.set(a, blk);
  count.set(a, (count.get(a) ?? 0) + 1);
};
for (const l of logs) {
  const from = `0x${l.topics[1].slice(26)}`.toLowerCase();
  const to = `0x${l.topics[2].slice(26)}`.toLowerCase();
  const value = BigInt(l.data);
  const blk = Number(BigInt(l.blockNumber));
  if (from !== ZERO) { bal.set(from, (bal.get(from) ?? 0n) - value); touch(from, blk); }
  if (to !== ZERO) { bal.set(to, (bal.get(to) ?? 0n) + value); touch(to, blk); }
}

const live = [...bal.entries()].filter(([, v]) => v > 0n);
process.stderr.write(`${logs.length} transfers -> ${live.length} addresses with a positive balance\n`);

// contract vs wallet: the one distinction that decides everything downstream
const codeFlags = new Map<string, boolean>();
for (let i = 0; i < live.length; i += 50) {
  const slice = live.slice(i, i + 50);
  const codes = await Promise.all(slice.map(([a]) =>
    withRetry(() => client.getCode({ address: getAddress(a) }), `getCode ${a}`).catch(() => undefined)));
  slice.forEach(([a], j) => codeFlags.set(a, !!codes[j] && codes[j] !== "0x"));
}

function classify(a: string): { label: string | null; category: Category } {
  const checksum = getAddress(a);
  const explicit = labels.addresses[checksum];
  if (explicit) return { label: explicit.label, category: explicit.category };
  if (poolAddrs.has(a)) return { label: "Uniswap pool", category: "pool" };
  return { label: null, category: codeFlags.get(a) ? "contract" : "wallet" };
}

const dec = asset.decimals;
const mult = asset.restMultiplier ?? 1;
const supplyRawUnits = live.reduce((s, [, v]) => s + v, 0n);
const supplyRaw = Number(formatUnits(supplyRawUnits, dec));

const holders: Holder[] = live.map(([a, v]) => {
  const { label, category } = classify(a);
  const raw = Number(formatUnits(v, dec));
  return {
    address: getAddress(a), label, category,
    raw, adjusted: raw * mult, pct: (raw / supplyRaw) * 100,
    firstBlock: first.get(a)!, lastBlock: last.get(a)!, transfers: count.get(a)!,
  };
}).sort((x, y) => y.raw - x.raw);

const cats: Category[] = ["pool", "escrow", "protocol", "router", "contract", "wallet"];
const byCategory = Object.fromEntries(cats.map((c) => {
  const hs = holders.filter((h) => h.category === c);
  const raw = hs.reduce((s, h) => s + h.raw, 0);
  return [c, { count: hs.length, raw, pct: (raw / supplyRaw) * 100 }];
})) as HolderReport["byCategory"];

const nonFloat = cats.filter((c) => c !== "wallet").reduce((s, c) => s + byCategory[c].raw, 0);
const trueFloatRaw = supplyRaw - nonFloat;
const wallets = holders.filter((h) => h.category === "wallet");
const top10Wallets = wallets.slice(0, 10).reduce((s, h) => s + h.raw, 0);

const report: HolderReport = {
  symbol, token: asset.token, ts: new Date().toISOString(), block: block.toString(),
  decimals: dec, uiMultiplier: asset.restMultiplier,
  transfersScanned: logs.length,
  supplyRaw, supplyAdjusted: supplyRaw * mult,
  byCategory,
  trueFloatRaw, trueFloatPct: (trueFloatRaw / supplyRaw) * 100,
  poolSharePct: byCategory.pool.pct,
  topWalletsShareOfFloatPct: trueFloatRaw > 0 ? (top10Wallets / trueFloatRaw) * 100 : 0,
  holders,
};

if (args.includes("--save")) {
  mkdirSync("data/holders", { recursive: true });
  writeFileSync(`data/holders/${symbol}.json`, JSON.stringify(report, null, 2) + "\n");
  process.stderr.write(`data/holders/${symbol}.json written\n`);
}

if (args.includes("--json")) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const n = (x: number) => x.toLocaleString("en-US", { maximumFractionDigits: 4 });
  console.log(`\n${symbol}  ${asset.name}`);
  console.log(`token ${asset.token} · block ${block} · ${logs.length} transfers · ${holders.length} addresses hold a balance`);
  console.log(`supply ${n(supplyRaw)} raw -> ${n(supplyRaw * mult)} multiplier-adjusted (x${mult})\n`);
  console.table(cats.map((c) => ({
    category: c, addresses: byCategory[c].count,
    balance: n(byCategory[c].raw), share: `${byCategory[c].pct.toFixed(2)}%`,
  })));
  console.log(`\ntrue float (supply minus pools, escrow and protocol contracts): ${n(trueFloatRaw)}  = ${report.trueFloatPct.toFixed(2)}% of supply`);
  console.log(`AMM pools hold ${report.poolSharePct.toFixed(2)}% of supply${report.poolSharePct > 20 ? "  <- market-making inventory dominates; the price surface depends on a few LPs" : ""}`);
  console.log(`top 10 wallets hold ${report.topWalletsShareOfFloatPct.toFixed(2)}% of the true float\n`);
  console.table(holders.slice(0, top).map((h) => ({
    address: `${h.address.slice(0, 10)}…${h.address.slice(-6)}`,
    label: h.label ?? "", category: h.category,
    balance: n(h.raw), share: `${h.pct.toFixed(2)}%`, transfers: h.transfers,
  })));
}
