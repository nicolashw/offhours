# OffHours

**Read-only onchain intelligence for Robinhood Stock Tokens — for humans and for agents.**

Robinhood Chain (Arbitrum L2, chain id 4663) puts tokenized US equities onchain as standard ERC-20s. They trade 24/7 on Uniswap and via RFQ, while their Chainlink reference feeds run 24/5 and freeze on weekends and holidays. The gap between the reference price and the onchain clearing price is the only genuinely new information tokenized equities create — and nobody is capturing it. Attention on the chain is on memecoins; 420k+ wallets hold Stock Tokens with no analytics built for them.

OffHours is that missing layer. No custody, no execution, no issuance.

## What it does

- **Premium / discount** for every Stock Token: Uniswap pool price vs Chainlink total-return reference, in basis points, with feed age so you know whether the reference is live or frozen.
- **Weekend & holiday implied prices**: when feeds hold the last close, the AMM keeps clearing. We record the onchain price continuously and backtest it against the next session's open.
- **Liquidity & flow**: pool depth per token, holder distribution, large transfers, issuance/redemption activity as a proxy for retail demand.
- **Multiplier-correct balances**: Stock Tokens use ERC-8056 `uiMultiplier()` for splits and dividend reinvestment. Raw `balanceOf` is wrong after the first corporate action. We ship the reference implementation.
- **MCP server** exposing all of the above as tools, so any AI agent can query Stock Token state. Pay-per-call via x402 is the monetization path.

## Why this and not a DEX / launchpad / trading UI

Solo builder, three weeks, from a jurisdiction where anything touching execution or custody is a compliance problem. Read-only infrastructure survives the end of the gas subsidy (Sept 29, 2026), does not depend on the memecoin cycle, and sits on the asset class Robinhood has staked its strategy on.

## Status

Collection covers the full universe: 194 Stock Tokens, both Uniswap venues, hourly snapshots.

```bash
npm i
cp .env.example .env         # only RPC_URL; every address lives in config/chain.json

npm run registry             # token universe + Chainlink feeds -> config/registry.json
npm run discover             # pool discovery (V3 grid + V4 Initialize scan) -> config/pools.json
npm run verify               # premium / discount / staleness / multiplier table
npm run snapshot             # append one line to data/YYYY-MM-DD.ndjson
npm run holders -- --symbol USO   # true float, rebuilt from Transfer logs
npm run mcp                  # MCP server over stdio, for agents

python3 -m http.server 8765  # then open http://localhost:8765/web/
```

`verify` takes `--all` for the full universe, `--symbol AAPL,NVDA` for pool-level detail,
and `--json` for the raw snapshot. `discover` takes `--v3` / `--v4` / `--force` / `--symbol`
and is resumable — the V4 crawl writes after every token. It finishes with a state sweep that
marks which V4 pools actually hold liquidity; 2,486 of 6,612 do, and skipping the rest is what
keeps a full pass at ~25s instead of ~65s. Re-run it periodically, since new pools open
constantly.

### The dashboard

`web/` is a static page — no framework, no build step, no server of its own. It reads three files
the collector already commits: `data/latest.json` for the current state, `data/series/<day>.ndjson`
for history, and `data/index.json` as the manifest, since a static host cannot list a directory.
Serve the repo root and open `/web/`; the same files work unchanged on GitHub Pages.

The page leads with the thing the project is named for: where the US trading day currently is, how
long the Chainlink reference has been frozen, and every priced token as one mark on a premium axis
sized by the money actually in its pools. Tokens priced out of drained pools sit in their own lane
below the axis rather than at the top of the rankings.

### The agent-facing layer

`npm run mcp` starts an MCP server over stdio exposing the same collector — not a
reimplementation, because two code paths would eventually disagree about a price.

| tool | answers |
|---|---|
| `list_stock_tokens` | what exists, with address, decimals, ISIN, multiplier, whether a feed exists, how much depth |
| `get_premium_discount` | pool consensus vs Chainlink reference in bps, with reference age, depth, dispersion and market session |
| `get_implied_price` | what the chain thinks a token is worth while the US market is shut |
| `get_liquidity` | every V3 and V4 pool for a token, with the depth behind each price and which ones are outliers |
| `get_feed_status` | reference age against its own heartbeat — the oracle-risk view |
| `resolve_balance` | a wallet's real position: `balanceOf` x `uiMultiplier`, raw and adjusted side by side |
| `get_holders` | true float, split into pools, protocol contracts and actual wallets |

Add it to a client — for Claude Code:

```bash
claude mcp add offhours -- npx -y tsx /absolute/path/to/offhours/scripts/mcp.ts
```

Snapshots are memoised for `SNAPSHOT_TTL_MS` (default 120s) and every response carries the
block and market session it came from. There is no tool that can move an asset.

### How it is put together

| file | role |
|---|---|
| `scripts/registry.ts` | merges `/rhj/assets` with Chainlink's reference-data directory |
| `scripts/discover.ts` | caches pool discovery — the slow part, kept out of the hourly path |
| `scripts/v4.ts` | Uniswap V4 reads: `poolId` -> storage slot -> `extsload` |
| `scripts/collect.ts` | one batched pass: feeds, multipliers, pool prices, premium |
| `scripts/holders.ts` | true float from Transfer logs, no explorer required |
| `scripts/rpc.ts` | Multicall3 batching, backoff, log-range bisection |
| `scripts/market.ts` | which US session a timestamp falls in |
| `scripts/mcp.ts` | the same collector, exposed to agents over MCP |
| `scripts/publish.ts` | trims each snapshot into the static files the dashboard reads |
| `web/` | the dashboard: three files, no build |

Discovery caches (`config/registry.json`, `config/pools.json`) are committed on purpose:
CI and the dashboard stay deterministic, both keep working when an upstream is down, and the
diff on `registry.json` is the audit trail for new listings and multiplier changes.

## What the data says so far

Established by running it, not by reading docs — the full log is in [docs/FINDINGS.md](docs/FINDINGS.md).

- **194 Stock Tokens exist; only 35 have a Chainlink feed.** For the other 82% the AMM is the
  only on-chain price there is.
- **The equity feeds are 24h-heartbeat / 0.5%-deviation.** A reference that has not moved for
  eleven hours is in spec, not broken — so age is reported against its own heartbeat, and
  premium is always tagged with the market session it was measured in.
- **CRWD's `uiMultiplier()` is 4.0.** Anything reading `balanceOf` alone shows a holder one
  quarter of their real position. Ten tokens are off 1.0 today.
- **A drained pool still quotes a price.** Six tokens showed 10–19% "premiums" out of pools with
  zero liquidity. Every price is now qualified by the depth backing it.
- **No sequencer uptime feed exists on this chain**, so there is no on-chain way to know whether
  the sequencer was down when a price was written. Observed feed age is the only proxy.

## Key facts established so far

- Every Stock Token with a feed uses standard `AggregatorV3Interface.latestRoundData()`.
- The feed price is **Total Return Value** = underlying market price × `uiMultiplier()`. Do not apply the multiplier again.
- Feeds are **24/5** with a 24h heartbeat and a 0.5% deviation threshold; on weekends and holidays they hold the last price.
- `/rhj/assets` returns `currentMultiplier` and `pendingMultiplier`; the latter names a queued split or distribution before it lands.
- Trading is RFQ (via `RobinHoodSettler`) plus Uniswap V3 and V4 pools. V4 carries the pool count, V3 carries the depth.

## Roadmap to Buildathon (Sept 14, 2026)

| Day | Deliverable |
|---|---|
| 1–2 | Verify signal; pin official token/feed/pool addresses; confirm Data API coverage |
| 3–5 | Premium/discount engine + continuous snapshot; Next.js dashboard |
| 6–7 | MCP server (`list_stock_tokens`, `get_premium_discount`, `get_implied_price`, `get_liquidity`, `get_holders`, `resolve_balance`); publish to npm; Claude Code demo |
| 8–9 | Writeup (EN/ZH); technical post on the ERC-8056 multiplier trap; submit |
| 10+ | Iterate inside the Buildathon |

## Disclaimer

Informational tooling only. Not investment, legal or tax advice. Stock Tokens are tokenised debt securities issued by Robinhood Assets (Jersey) Limited and are not available to US persons or in several other jurisdictions.

MIT License.
