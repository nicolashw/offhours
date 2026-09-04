/**
 * OffHours — append one snapshot as NDJSON to data/YYYY-MM-DD.ndjson.
 * One line per run keeps the repo small and the series trivially parseable;
 * git sees an append rather than a rewrite. Run hourly by CI, or `npm run snapshot`.
 */
import { collect, loadCfg } from "./collect.js";
import { appendFileSync, mkdirSync } from "node:fs";
import { publish } from "./publish.js";

const snap = await collect(loadCfg());
mkdirSync("data", { recursive: true });
const file = `data/${snap.ts.slice(0, 10)}.ndjson`;
appendFileSync(file, JSON.stringify(snap) + "\n");
publish(snap);

const c = snap.counts;
console.log(
  `${file} <- ${snap.ts} block=${snap.block} phase=${snap.market.phase} ` +
  `assets=${c.assets} priced=${c.priced} withPool=${c.withPool} beyondHeartbeat=${c.beyondHeartbeat}`,
);
