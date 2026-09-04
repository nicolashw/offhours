# Findings log

## 2026-09-04 — D1 verification (mainnet, block 53881242)

Run at 01:41 UTC = 21:41 ET Thu Sep 3, i.e. inside the post/overnight session.

### 1. Chainlink equity feeds are deviation-triggered, not continuous

| symbol | feedPrice | age at read | last update (ET) |
|---|---|---|---|
| GOOGL | 342.1150 | 699 min | ~10:02 — inside regular hours |
| USO | 141.9950 | 403 min | ~14:58 |
| AAPL | 328.8010 | 346 min | ~15:55 |
| SPCX | 150.0658 | 104 min | ~19:57 |

The docs describe 24/5 coverage including pre/post/overnight sessions. In practice updates
are threshold-driven with a long heartbeat: GOOGL's reference had not moved for 11.6 hours
and still reflected mid-morning.

**Consequence for the product.** A naive `pool/feed - 1` measures oracle staleness as much as
market disagreement. Premium must be reported alongside `feedAgeSec`, and staleness itself is
a first-class output: "which Stock Token references have been stale for more than N hours" is
a risk metric for any protocol using these feeds for collateral valuation or liquidation.

### 2. Pool pricing math validated by cross-consistency

Implied ETH/USD from each token's own feed divided by its WETH-quoted pool price:

| symbol | feed / poolWETH | implied ETH/USD |
|---|---|---|
| AAPL | 328.8010 / 0.1313 | 2504 |
| GOOGL | 342.1150 / 0.1371 | 2495 |
| SPCX | 150.0658 / 0.0601 | 2497 |

Three independent pools agree within 0.4%. Confirms the `sqrtPriceX96` decimal handling and
shows the pools are live and arbitraged rather than stale.

### 3. ERC-8056 `uiMultiplier()` — 1e18 scaling confirmed

AAPL returned 1.000566 (≈5.66 bps of accrued distribution); GOOGL, USO, SPCX at exactly
1.000000. Raw `balanceOf` will therefore drift from displayed holdings as distributions accrue,
and will break outright on the first split.

### 4. Open items

- `GET /rhj/assets` parsed but yielded no usable list under the shapes probed. Run
  `npm run verify -- --dump-rest` and inspect. Until fixed, the asset universe is the four
  seeds in `config/chain.json`.
- USO has no Uniswap V3 pool against WETH at any of the four fee tiers. Check USDG/USDe quotes,
  and check whether it trades RFQ-only.
- Quote tokens confirmed on chain 4663: USDG `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168`,
  USDe `0x5d3a1Ff2b6BAb83b63cd9AD0787074081a52ef34`. No officially attested USDC deployment found.
- Uniswap V3 factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`, WETH9
  `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`, both derived onchain from SwapRouter02.
- Sequencer uptime feed not yet checked — required before trusting any price on an L2.

---

## 2026-09-04 — the token universe, and two corrections

Block ~53.90M. Collector rebuilt to cover every asset rather than four seeds.

### 5. `/rhj/assets` parsed: 194 tokens, not 4

The endpoint was fine all along; the parser was looking for the wrong keys. The shape is
`{ assets: [{ tokenSymbol, tokenName, tokenDecimals, isin, currentMultiplier, pendingMultiplier,
status, tradingCapabilities, deployments: [{ contractAddress, chainId, networkName }] }] }` —
`tokenSymbol` not `symbol`, `contractAddress` not `address`. Every asset has exactly one
deployment, all on chain 4663, all `ASSET_STATUS_ACTIVE`.

The payload carries no price-feed address, so feeds come from Chainlink's own reference-data
directory for this chain: `https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json`.

### 6. Only 35 of 194 Stock Tokens have a Chainlink reference price

57 feeds exist on Robinhood Chain. 22 are crypto/stable (ETH, BTC, USDG, USDe, LINK…), and
35 match a Stock Token. **The remaining 159 tokens — 82% of the universe — have no on-chain
reference price at all.**

This reframes the product. "Premium vs reference" is not a universal metric on this chain; it
is available for a minority of assets. For the other 82%, the AMM (and the settler's RFQ fill)
is the *only* price that exists on-chain, which makes the pool price infrastructure rather than
commentary. It also means no lending protocol can price those 159 tokens as collateral today.

### 7. Correction: feed staleness is the specification, not a defect

The D1 note treated an 11.6-hour-old GOOGL reference as surprising. The directory settles it —
every equity feed on this chain is:

| property | value |
|---|---|
| heartbeat | 86,400 s (24 h) |
| deviation threshold | 0.5% |
| market hours class | `us_equities_24/5` |

So a reference that has not moved for eleven hours is behaving exactly as specified: the
underlying has not moved 0.5% and the daily heartbeat has not expired. The metric worth
reporting is not "is it stale" but **age relative to its own heartbeat**, which is what the
collector now records (`fresh` < 1 h · `aging` < heartbeat · `beyond-heartbeat`). At the time of
writing, zero feeds were past heartbeat.

The product conclusion from D1 survives, with a sharper edge: during the US session the feed
tracks the underlying, so `pool/feed − 1` is a real basis. Outside it, the feed is frozen at the
last regular-session print and the same number becomes *the market's implied view of the next
open*. Snapshots therefore record `marketPhase` (`regular` / `pre` / `after` / `overnight` /
`weekend`) so the two readings are never conflated.

### 8. Correction: price without depth is a fossil

The first cut of the full-universe run produced spectacular headline numbers:

| symbol | premium vs reference | pool liquidity |
|---|---|---|
| RGTI | +19.07% | 0 |
| IONQ | +17.04% | 0 |
| RKLB | +16.22% | 0 |
| CLSK | +13.73% | 0 |
| NBIS | +10.64% | 0 |
| EWY | −7.77% | 0 |

All six are drained pools. A concentrated-liquidity pool keeps its last `sqrtPriceX96` in
storage forever, so a pool with `L = 0` still answers with a price — the price of whatever trade
emptied it, however long ago. Any dashboard ranking by premium alone leads with these.

Every pool now carries the virtual quote reserve backing its price at the current tick
(`y = L·√P`, or `x = L/√P` when the quote is token0), converted to USD. Selection picks the
deepest pool, not the first; the premium is tagged `ok` / `thin` / `empty`; and the ghosts are
reported in their own section rather than silently dropped, because "which listed tokens have no
live market" is itself a finding.

With the filter applied, the depth-backed premiums sit in a plausible ±50 bps band:

| symbol | depth | premium |
|---|---|---|
| GME | $36.0M | +51 bps |
| GOOGL | $15.7M | +44 bps |
| NVDA | $159.3M | +36 bps |
| QQQ | $138.1M | +34 bps |
| AAPL | $22.4M | −12 bps |
| TSM | $2.0M | −34 bps |
| ASML | $2.3M | −35 bps |

### 9. ERC-8056 in the wild: CRWD is mid-split at 4.0

Ten tokens have a multiplier other than 1.0, and one is dramatic:

| symbol | multiplier | reading |
|---|---|---|
| CRWD | **4.000000** | a 4:1 split, applied as a multiplier |
| CCL | 1.021486 | accrued distributions |
| SGOV | 1.005102 | monthly income accrual |
| ORCL | 1.002211 | |
| COST, AAPL, F, ASML, MU, DELL | 1.0001–1.0006 | |

On-chain `uiMultiplier()` and Robinhood's REST `currentMultiplier` agree exactly for all 194.
Anything reading `balanceOf` alone shows a CRWD holder **one quarter** of their real position,
and `totalSupply` understates the float by the same factor. The collector reports both the raw
and the multiplier-adjusted figure everywhere, and flags any disagreement between the two
sources.

`pendingMultiplier` is populated but empty for every asset right now. When it is non-empty it
names a queued distribution or split *before* it lands — a leading indicator worth polling, and
the reason the registry is refreshed and committed on every snapshot run: the git history of
`config/registry.json` becomes the multiplier-change audit trail.

### 10. Uniswap V4 is where the pools are, but V3 is where the depth is

V4 pools are not contracts — they are entries in the singleton PoolManager
(`0x8366a39CC670B4001A1121B8F6A443A643e40951`), addressed by `poolId` and read through
`extsload`. They cannot be enumerated by a factory call, only from `Initialize` events.

Scanning NVDA alone returns **10,041** `Initialize` events, of which 381 are against a quote
token we track; 330 of those carry a hook and 250 use the dynamic-fee flag (`0x800000`). The
rest of the ten thousand are pools against other tokens — Doppler/`V2MemeHook` launches using
the Stock Token as the quote asset.

But depth still sits in V3: for every liquid name checked, the deepest USD-priced pool is a V3
pool. So the earlier "V4 is the main venue" reading holds for *count and flow*, not for
inventory, and both venues have to be read.

### 11. Correction: `0x82ad56cb` is `aggregate3`

The transfer-log survey attributed method `0x82ad56cb` to a distributor contract. It is
Multicall3's `aggregate3(Call3[])` selector — the same one this repo now calls thousands of
times per snapshot. The batched micro-transfers are worth revisiting, but that particular
identification was wrong.

### 12. No sequencer uptime feed exists on this chain

Chainlink's own guidance is that an L2 consumer must check a sequencer uptime feed before
trusting a price. The reference-data directory for Robinhood Chain lists 57 feeds and **none of
them is a sequencer uptime feed**. There is therefore no on-chain way for a contract on this
chain to know whether the sequencer was down when a price was written.

For OffHours this closes the open item from D1 with a negative answer, and adds a second
argument for the staleness series: absent an uptime feed, observed feed age is the only
available proxy for sequencer health, and it has to be measured off-chain — which is exactly
what the hourly snapshot does.

### 13. Correction: `L·√P` is not a dollar amount

Section 8 introduced the virtual quote reserve as the depth behind a price, and it does separate
a live pool from a drained one — but it is not TVL, and reading it as USD produced a number that
cannot be true:

| | |
|---|---|
| SGOV, deepest pool, `L·√P` in USD | **$1,187,900,000** |
| SGOV total supply × price | **$1,549,000** |

`L·√P` is the virtual reserve of a *full-range* position holding that liquidity. Real positions
here are concentrated into very tight bands, so the figure overshoots by orders of magnitude —
and unevenly, which meant the depth-weighted consensus was partly weighted by how narrow each
LP's range was.

Pools now carry both numbers under honest names:

- `depthScore` — `L·√P`, kept for ranking and for the one thing it is reliable at: zero means
  drained.
- `tvlUsd` — actual money. `balanceOf` on both sides for V3, which custodies its own reserves.
  V4 pools do not exist as contracts and their reserves sit commingled inside the singleton
  PoolManager, so per-pool reserves cannot be read at all; the manager's balance of the token is
  apportioned across that token's V4 pools by `depthScore` and doubled for the quote side.
  `tvlBasis` records which of the two a reader is looking at.

Order of operations turned out to matter as much as the formula. Valuing reserves first and then
weighting by the result lets a pool sitting at an extreme tick value its own tokens absurdly and
capture the median it is meant to be judged against — AMZN briefly printed a consensus price of
3.4 × 10⁵⁰. The consensus is therefore formed on `depthScore`, and reserves are valued at that
consensus afterwards. Liveness likewise stays with liquidity rather than balances: tokens sent
to a pool address sit in `balanceOf` without making the pool a market.

After the fix, SGOV reads $1.3M of pool TVL against a $1.55M supply, and the liquid names land
where a reader would expect: NVDA $19.1M, QQQ $4.7M, MU $5.6M, DELL $853k.

### 14. Still open

- **Settler fills.** `RobinHoodSettler` (`0x39b38686A19836Ac10162c490E4558e120CbBE5f`) is a
  fourth price surface and the one retail actually receives. Decoding its fills and comparing
  them to the pool price at the same block is the execution-quality dataset, and the hardest
  thing here to copy.
- **Dividend → multiplier causality.** Tie distribution events to `uiMultiplier()` jumps.
  CRWD's 4.0 is the natural test case.
- **Hook economics.** 330 of NVDA's 381 quoted V4 pools carry a hook and most use dynamic fees.
  Whether hooks alter the effective price (rather than just taking a fee) has to be settled
  before any V4 pool price is quoted as a reference.
