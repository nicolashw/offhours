/** OffHours — rebuild data/latest.json, data/series/ and data/index.json from the archive. */
import { readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { publish, writeIndex } from "./publish.js";
import type { Snapshot } from "./collect.js";

if (existsSync("data/series")) rmSync("data/series", { recursive: true });
const files = readdirSync("data").filter((f) => /^\d{4}-\d{2}-\d{2}\.ndjson$/.test(f)).sort();
let n = 0, skipped = 0;
for (const f of files) {
  for (const line of readFileSync(`data/${f}`, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const s = JSON.parse(line) as Snapshot;
    if (!s.market || !s.counts) { skipped++; continue; }  // pre-rewrite snapshot shape
    publish(s);
    n++;
  }
}
writeIndex();
console.log(`republished ${n} snapshots (${skipped} older-schema lines skipped)`);
