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

`D1` — verifying the core signal is computable. See `scripts/verify.ts`.

```bash
cp .env.example .env    # set RPC_URL, SWAP_ROUTER02, QUOTE_TOKENS
npm i
npm run verify          # table: feed price, feed age, uiMultiplier, pool price, premium bps
npm run snapshot        # JSON to data/ — start collecting from day one
```

## Key facts established so far (from official docs)

- Every Stock Token has a per-asset Chainlink feed using standard `AggregatorV3Interface.latestRoundData()`.
- The feed price is **Total Return Value** = underlying market price × `uiMultiplier()`. Do not apply the multiplier again.
- Feeds are **24/5** (regular, pre, post, overnight sessions). During weekends/holidays they hold the last price with no heartbeat.
- Robinhood's REST `/prices` returns raw underlying bid/ask (not multiplier-adjusted); `/assets` returns `currentMultiplier`. Mixing surfaces requires converting.
- Trading is RFQ at launch (0x RFQ, 1inch Fusion, LiFi) plus Uniswap AMM pools. AMM depth may be thin; RFQ quotes are a second price surface to add.
- On an L2, check the sequencer uptime feed before trusting a price.

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
