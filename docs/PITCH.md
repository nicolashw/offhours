# Buildathon application text

## Long (~200 words)

OffHours — the onchain intelligence layer for Robinhood Stock Tokens.

Stock Tokens on Robinhood Chain trade 24/7 on Uniswap and via RFQ, while their Chainlink reference feeds run 24/5 and freeze on weekends and holidays. The spread between the reference price and the onchain clearing price is the only genuinely new information tokenized equities create: what the market thinks NVDA or SPY is worth when Wall Street is closed. Nobody is capturing it — attention on the chain is on memecoins, while 420k+ wallets hold Stock Tokens with no analytics built for them.

OffHours is read-only infrastructure, for humans and for agents:
- Live premium/discount for every Stock Token (Chainlink total-return reference vs Uniswap pool price), with weekend/holiday implied prices backtested against the next open
- Liquidity depth, holder distribution and large-transfer monitoring per token
- Correct balance display via ERC-8056 uiMultiplier() — most wallets will show wrong holdings after the first split or dividend; we ship the reference implementation
- An MCP server exposing the same data as tools, so any AI agent can query Stock Token state — aligned with Robinhood Chain's AI-native positioning, with x402 pay-per-call as the monetization path

No custody, no execution, no token issuance. Solo full-stack builder; MVP targeted for day one of the Buildathon.

## Short (~60 words)

OffHours: read-only analytics + MCP server for Robinhood Stock Tokens. Tracks premium/discount between Chainlink total-return feeds and 24/7 Uniswap prices to surface weekend/holiday implied prices for US equities; ERC-8056 multiplier-correct balances; agent-queryable via MCP with x402 monetization. No custody or execution.
