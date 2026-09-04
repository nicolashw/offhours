/** OffHours — rebuild config/registry.json from the two upstreams. Usage: npm run registry */
import { loadCfg } from "./rpc.js";
import { refreshRegistry } from "./registry.js";

const reg = await refreshRegistry(loadCfg());
const withFeed = reg.assets.filter((a) => a.feed).length;
const pending = reg.assets.filter((a) => a.pendingMultiplier);
const adjusted = reg.assets.filter((a) => a.restMultiplier && Math.abs(a.restMultiplier - 1) > 1e-9);

console.log(`config/registry.json <- ${reg.assets.length} assets @ ${reg.fetchedAt}`);
console.log(`  with Chainlink feed : ${withFeed}  (${((withFeed / reg.assets.length) * 100).toFixed(1)}%)`);
console.log(`  no feed at all      : ${reg.assets.length - withFeed}  <- AMM is the only price for these`);
console.log(`  multiplier != 1.0   : ${adjusted.length}  ${adjusted.slice(0, 12).map((a) => `${a.symbol}=${a.restMultiplier!.toFixed(9)}`).join(" ")}`);
console.log(`  pending multiplier  : ${pending.length}  ${pending.map((a) => `${a.symbol}=${a.pendingMultiplier}`).join(" ") || "(none queued)"}`);
console.log(`  feeds with no token : ${reg.feedsUnmatched.length}  (crypto/stable feeds, plus any equity feed listed ahead of its token)`);
