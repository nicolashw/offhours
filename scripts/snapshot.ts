/**
 * OffHours — append one snapshot as NDJSON to data/YYYY-MM-DD.ndjson.
 * One line per run keeps the repo small and the series trivially parseable.
 * Run hourly by .github/workflows/snapshot.yml, or locally via `npm run snapshot`.
 */
import { collect, loadCfg } from "./collect.js";
import { appendFileSync, mkdirSync } from "node:fs";

const cfg = loadCfg();
const snap = await collect(cfg);
mkdirSync("data", { recursive: true });
const day = snap.ts.slice(0, 10);
const file = `data/${day}.ndjson`;
appendFileSync(file, JSON.stringify(snap) + "\n");

const priced = snap.rows.filter((r) => r.premiumBps != null).length;
const stale = snap.rows.filter((r) => r.stale).length;
console.log(`${file} <- ${snap.ts} block=${snap.block} rows=${snap.rows.length} priced=${priced} stale=${stale} ethUsd=${snap.ethUsd?.toFixed(2) ?? "n/a"}`);
