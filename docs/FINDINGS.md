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
