/**
 * OffHours — the files the dashboard reads.
 *
 * The archive line in data/<date>.ndjson is ~1-2 MB: every pool of every token,
 * which is what makes it worth keeping for research and useless to serve to a
 * browser. So a snapshot also writes two derived views, both static files that
 * any web server (or GitHub Pages) can hand out unchanged:
 *
 *   data/latest.json          — the current snapshot, pools trimmed to live ones
 *   data/series/<date>.ndjson — one compact line per snapshot, for the charts
 *   data/index.json           — manifest, since a static host cannot list a directory
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import type { Snapshot } from "./collect.js";

export type SeriesPoint = {
  ts: string; block: string; phase: string; offHours: boolean;
  rows: Array<[symbol: string, premiumBps: number | null, poolUsd: number | null,
                feedUsd: number | null, feedAgeSec: number | null, tvlUsd: number, quality: string,
                netGapBps: number | null]>;
};

/**
 * Latest view: keep the pools a reader can act on, drop the dead ones.
 * The full counts travel alongside, so the page can say "12 of 388 shown"
 * rather than quietly presenting the trimmed list as the whole picture.
 */
export function trimForWeb(s: Snapshot): Snapshot {
  return {
    ...s,
    rows: s.rows.map((r) => ({
      ...r,
      poolsTotal: r.pools.length,
      pools: r.pools
        .filter((p) => (p.depthScore ?? 0) > 0)
        .sort((a, b) => (b.tvlUsd ?? 0) - (a.tvlUsd ?? 0))
        .slice(0, 12),
    })),
  };
}

export function toSeriesPoint(s: Snapshot): SeriesPoint {
  return {
    ts: s.ts, block: s.block, phase: s.market.phase, offHours: s.market.offHours,
    rows: s.rows
      .filter((r) => r.feed || r.poolUsd != null)
      .map((r) => [
        r.symbol, r.premiumBps, r.poolUsd == null ? null : Number(r.poolUsd.toFixed(6)),
        r.feed?.price ?? null, r.feed?.ageSec ?? null, Math.round(r.depthUsd), r.quality,
        r.cost?.netGapBps ?? null,
      ]),
  };
}

export function publish(s: Snapshot, dir = "data") {
  const day = s.ts.slice(0, 10);
  mkdirSync(`${dir}/series`, { recursive: true });
  writeFileSync(`${dir}/latest.json`, JSON.stringify(trimForWeb(s)) + "\n");
  appendFileSync(`${dir}/series/${day}.ndjson`, JSON.stringify(toSeriesPoint(s)) + "\n");
  writeIndex(dir);
}

export function writeIndex(dir = "data") {
  const days = existsSync(`${dir}/series`)
    ? readdirSync(`${dir}/series`).filter((f) => f.endsWith(".ndjson")).map((f) => f.replace(".ndjson", "")).sort()
    : [];
  const holders = existsSync(`${dir}/holders`)
    ? readdirSync(`${dir}/holders`).filter((f) => f.endsWith(".json")).map((f) => f.replace(".json", "")).sort()
    : [];
  const latest = existsSync(`${dir}/latest.json`)
    ? (JSON.parse(readFileSync(`${dir}/latest.json`, "utf8")) as Snapshot).ts : null;
  writeFileSync(`${dir}/index.json`, JSON.stringify({ generatedAt: new Date().toISOString(), latest, days, holders }, null, 2) + "\n");
}
