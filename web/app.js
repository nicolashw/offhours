/**
 * OffHours dashboard — static, no build step, no server.
 *
 * Everything comes from files the collector already commits: data/index.json as
 * the manifest (a static host cannot list a directory), data/latest.json for the
 * current state, and data/series/<day>.ndjson for the history behind each
 * sparkline. Open web/index.html from any static server and it works.
 */

const DATA = "../data";
const $ = (s, r = document) => r.querySelector(s);

const fmtUsd = (n) =>
  n == null ? "–"
  : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B`
  : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M`
  : n >= 1e3 ? `$${(n / 1e3).toFixed(0)}k`
  : `$${n.toFixed(0)}`;

const fmtPrice = (n) => (n == null ? "–" : n >= 1000 ? n.toFixed(2) : n >= 1 ? n.toFixed(3) : n.toPrecision(4));
const fmtBps = (b) => (b == null ? "–" : `${b > 0 ? "+" : ""}${b}`);

function fmtAge(sec) {
  if (sec == null) return "–";
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${(sec / 3600).toFixed(1)}h`;
}

/** "12h 4m" — used in the one sentence that carries the whole thesis. */
function fmtSpan(sec) {
  const h = Math.floor(sec / 3600), m = Math.round((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

const SESSIONS = [
  { name: "Pre-market", from: 4 * 60, to: 9 * 60 + 30, key: "pre" },
  { name: "Regular session", from: 9 * 60 + 30, to: 16 * 60, key: "regular" },
  { name: "After hours", from: 16 * 60, to: 20 * 60, key: "after" },
  { name: "Overnight", from: 20 * 60, to: 28 * 60, key: "overnight" },
];

/** Minutes since 04:00 ET, the natural origin of a trading day. */
function etMinutes(date) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(date);
  const g = (t) => Number(p.find((x) => x.type === t).value);
  const m = (g("hour") % 24) * 60 + g("minute");
  return m < 4 * 60 ? m + 24 * 60 : m;
}

// ---------------------------------------------------------------- day bar

function drawDayBar(snap) {
  const svg = $("#daybar");
  const W = svg.clientWidth || 1120, H = 66;
  const x = (min) => ((min - 240) / (28 * 60 - 240)) * W;
  const y = 20, h = 12;
  const now = etMinutes(new Date(snap.ts));
  const weekend = snap.market.phase === "weekend";

  // Fill says whether the reference is awake; the marker says where we are.
  // Keeping those on separate visual channels stops the bar from reading as
  // two competing scales.
  const parts = SESSIONS.map((s) => {
    const awake = !weekend && s.key === "regular";
    const here = !weekend && snap.market.phase === s.key;
    return `<rect x="${x(s.from)}" y="${y}" width="${x(s.to) - x(s.from) - 2}" height="${h}"
              fill="${awake ? "var(--ref)" : "var(--rule)"}"/>
            ${here ? `<rect x="${x(s.from)}" y="${y + h + 2}" width="${x(s.to) - x(s.from) - 2}" height="2" fill="var(--market)"/>` : ""}
            <text class="seg-label" x="${x(s.from)}" y="${y + h + 19}"
              fill="${here ? "var(--market)" : "var(--dimmer)"}">${s.name}</text>`;
  }).join("");

  const hours = [4, 9.5, 16, 20, 28].map((hh, i, arr) => {
    const label = `${String(Math.floor(hh % 24)).padStart(2, "0")}:${hh % 1 ? "30" : "00"}`;
    const last = i === arr.length - 1;
    return `<text x="${x(hh * 60)}" y="${y - 7}" text-anchor="${last ? "end" : "start"}">${label}</text>`;
  }).join("");

  const marker = weekend ? "" : `
    <rect x="${x(now) - 1}" y="${y - 5}" width="2" height="${h + 10}" fill="var(--text)"/>
    <text class="now-label" x="${Math.min(Math.max(x(now) - 22, 0), W - 60)}" y="${y - 12}">${snap.market.etTime.split(" ").slice(0, 2).join(" ")}</text>`;

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMinYMid meet");
  svg.innerHTML = hours + parts + marker;
}

// ---------------------------------------------------------------- hero copy

function drawChainline(snap) {
  $("#chainline").innerHTML =
    `Robinhood Chain <b>${snap.chainId}</b> · block <b>${Number(snap.block).toLocaleString("en-US")}</b> · `
    + `read <b>${new Date(snap.ts).toISOString().slice(11, 16)}Z</b>`;
}

// ---------------------------------------------------------------- premium band

function drawBand(snap, onPick) {
  const all = snap.rows.filter((r) => r.premiumBps != null);
  const solid = all.filter((r) => r.quality === "ok");
  const thin = all.filter((r) => r.quality !== "ok");
  const svg = $("#band");
  const W = svg.clientWidth || 1120, H = 208;
  const pad = 44, mid = 80, axisY = 134, lane = 180;

  // The scale belongs to the tokens with depth behind them: letting a drained
  // pool's 19% "premium" set it would squash everything real into a dot.
  //
  // Even among those the distribution is heavy-tailed — most names sit inside
  // ±40 bps while one illiquid ETF sits at −314 — so the axis is asinh, which
  // is near-linear through the crowded middle and compresses the tails. Ticks
  // are labelled in bps so the compression is visible rather than implied.
  const max = Math.max(60, ...solid.map((r) => Math.abs(r.premiumBps))) * 1.15;
  const K = 18;
  const warp = (b) => Math.asinh(b / K);
  const span = warp(max);
  const clamp = (b) => Math.max(-max, Math.min(max, b));
  const x = (b) => pad + ((warp(clamp(b)) + span) / (2 * span)) * (W - 2 * pad);
  const maxTvl = Math.max(1, ...solid.map((r) => r.depthUsd));
  const rad = (t) => 4 + 12 * Math.sqrt(Math.max(t, 0) / maxTvl);

  const ticks = [-1000, -300, -100, -30, 0, 30, 100, 300, 1000].filter((b) => Math.abs(b) <= max);
  const grid = ticks.map((b) => `
    <line class="${b === 0 ? "zero" : "axis"}" x1="${x(b)}" y1="26" x2="${x(b)}" y2="${axisY}"/>
    <text x="${x(b)}" y="${axisY + 16}" text-anchor="middle">${b === 0 ? "0" : fmtBps(b)}</text>`).join("");

  // Beeswarm: most tokens sit within a few tens of bps of the reference, so on a
  // single line they would pile into one blob. Nudge each mark up or down until
  // it clears its neighbours; vertical position carries no meaning.
  const placedDots = [];
  const swarm = [...solid].sort((a, b) => b.depthUsd - a.depthUsd).map((r) => {
    const cx = x(r.premiumBps), r0 = rad(r.depthUsd);
    let cy = mid;
    for (let step = 0; step < 40; step++) {
      cy = mid + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 8;
      if (!placedDots.some((p) => Math.hypot(p.cx - cx, p.cy - cy) < p.r + r0 + 1.5)) break;
    }
    placedDots.push({ cx, cy, r: r0, sym: r.symbol });
    return { r, cx, cy, r0 };
  });

  const dot = (r, cx, cy, r0, muted) => {
    const c = r.premiumBps >= 0 ? "var(--market)" : "var(--ref)";
    return `<circle tabindex="0" role="button" data-sym="${r.symbol}"
        cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r0}"
        fill="${muted ? "none" : c}" fill-opacity="${muted ? 0 : 0.3}"
        stroke="${muted ? "var(--dimmer)" : c}" stroke-width="1.4"
        stroke-dasharray="${muted ? "2 2" : "none"}">
        <title>${r.symbol} ${fmtBps(r.premiumBps)} bps · ${fmtUsd(r.depthUsd)} pool TVL · ${r.quality}</title>
      </circle>`;
  };

  // Label the deepest few. Two labels at similar x collide however far apart
  // their marks are vertically, so separation is judged on x alone.
  const labelled = [];
  for (const d of [...swarm].sort((a, b) => b.r.depthUsd - a.r.depthUsd)) {
    if (labelled.length >= 6) break;
    if (!labelled.some((p) => Math.abs(p.cx - d.cx) < 54)) labelled.push(d);
  }
  const labels = labelled.map((d) =>
    `<text class="tick-label" x="${d.cx.toFixed(1)}" y="${(d.cy - d.r0 - 7).toFixed(1)}" text-anchor="middle">${d.r.symbol}</text>`).join("");

  const laneRow = thin.length ? `
    ${thin.map((r) => dot(r, x(r.premiumBps), lane, 4.5, true)).join("")}
    <text class="tick-label" x="${pad}" y="${lane + 20}">Drained pools — the price is whatever trade emptied them</text>` : "";

  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("preserveAspectRatio", "xMinYMid meet");
  svg.innerHTML = grid + swarm.map((d) => dot(d.r, d.cx, d.cy, d.r0, false)).join("") + labels + laneRow;
  svg.querySelectorAll("circle").forEach((c) => {
    c.addEventListener("click", () => onPick(c.dataset.sym));
    c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onPick(c.dataset.sym); } });
  });

  $("#band-note").textContent =
    `Each token is one mark, sized by the money in its pools and coloured by side — cyan trades above the reference, amber below. `
    + `Vertical position only keeps the marks apart.`
    + (thin.length ? ` The ${thin.length} below the axis are excluded from the scale: their pools hold nothing, and a dashboard ranking on premium alone would lead with them.` : "");
}

// ---------------------------------------------------------------- tables

function sortable(table, cols, rows, render, initial) {
  let key = initial.key, dir = initial.dir;
  const head = table.tHead, body = table.tBodies[0];
  head.innerHTML = `<tr>${cols.map((c) => `<th tabindex="0" data-k="${c.k}" class="${c.num ? "num" : ""}">${c.t}</th>`).join("")}</tr>`;
  const paint = () => {
    const sorted = [...rows].sort((a, b) => {
      const va = key(a), vb = key(b);
      if (va == null) return 1;
      if (vb == null) return -1;
      return (va > vb ? 1 : va < vb ? -1 : 0) * dir;
    });
    body.innerHTML = sorted.map(render).join("");
    head.querySelectorAll("th").forEach((th) => th.removeAttribute("data-dir"));
    const active = head.querySelector(`th[data-k="${initial.name}"]`);
    if (active) active.setAttribute("data-dir", dir > 0 ? "↑" : "↓");
    body.dispatchEvent(new CustomEvent("painted", { bubbles: true }));
  };
  head.querySelectorAll("th").forEach((th) => {
    const col = cols.find((c) => c.k === th.dataset.k);
    const go = () => {
      if (initial.name === col.k) dir = -dir; else { initial.name = col.k; key = col.key; dir = col.desc ? -1 : 1; }
      paint();
    };
    th.addEventListener("click", go);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  });
  paint();
  return paint;
}

function ageCell(feed) {
  if (!feed) return `<td colspan="2" class="muted">no reference</td>`;
  const frac = Math.min(1, feed.ageSec / (feed.heartbeat || 86400));
  const past = feed.state === "beyond-heartbeat";
  return `<td class="num">${fmtAge(feed.ageSec)}</td>
          <td><span class="agebar ${past ? "past" : ""}"><i style="width:${(frac * 100).toFixed(0)}%"></i></span></td>`;
}

function pricedTable(snap, onPick) {
  const rows = snap.rows.filter((r) => r.feed);
  const cols = [
    { k: "symbol", t: "Token", key: (r) => r.symbol },
    { k: "prem", t: "Premium bps", key: (r) => r.premiumBps, num: true, desc: true },
    { k: "pool", t: "On chain", key: (r) => r.poolUsd, num: true, desc: true },
    { k: "ref", t: "Reference", key: (r) => r.feed?.price, num: true, desc: true },
    { k: "age", t: "Reference age", key: (r) => r.feed?.ageSec, num: true, desc: true },
    { k: "hb", t: "", key: (r) => r.feed?.ageSec, desc: true },
    { k: "tvl", t: "Pool TVL", key: (r) => r.depthUsd, num: true, desc: true },
    { k: "disp", t: "Venue spread", key: (r) => r.dispersionBps, num: true, desc: true },
    { k: "q", t: "", key: (r) => r.quality },
  ];
  const render = (r) => `
    <tr data-sym="${r.symbol}" tabindex="0" class="${r.quality === "ok" ? "" : "thin"}">
      <td class="sym">${r.symbol}</td>
      <td class="num ${r.premiumBps > 0 ? "pos" : r.premiumBps < 0 ? "neg" : ""}">${fmtBps(r.premiumBps)}</td>
      <td class="num">${fmtPrice(r.poolUsd)}</td>
      <td class="num muted">${fmtPrice(r.feed.price)}</td>
      ${ageCell(r.feed)}
      <td class="num">${fmtUsd(r.depthUsd)}</td>
      <td class="num muted">${r.dispersionBps == null ? "–" : r.dispersionBps}</td>
      <td>${r.quality === "ok" ? "" : `<span class="flag warn">${r.quality}</span>`}</td>
    </tr>`;
  const table = $("#t-priced");
  const paint = sortable(table, cols, rows, render, { key: (r) => r.premiumBps, dir: -1, name: "prem" });
  const bind = () => table.tBodies[0].querySelectorAll("tr").forEach((tr) => {
    const go = () => onPick(tr.dataset.sym);
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  });
  table.addEventListener("painted", bind);
  bind();
  return paint;
}

function multiplierTable(snap) {
  const rows = snap.rows.filter((r) => r.uiMultiplier != null && Math.abs(r.uiMultiplier - 1) > 1e-9);
  const cols = [
    { k: "symbol", t: "Token", key: (r) => r.symbol },
    { k: "name", t: "", key: (r) => r.name },
    { k: "m", t: "uiMultiplier", key: (r) => r.uiMultiplier, num: true, desc: true },
    { k: "raw", t: "Supply as balanceOf reports it", key: (r) => r.rawTotalSupply, num: true, desc: true },
    { k: "adj", t: "Supply in real shares", key: (r) => r.adjTotalSupply, num: true, desc: true },
    { k: "err", t: "Shortfall", key: (r) => r.uiMultiplier, num: true, desc: true },
  ];
  const render = (r) => {
    const off = (r.uiMultiplier - 1) * 100;
    return `<tr>
      <td class="sym">${r.symbol}</td>
      <td class="name">${r.name.replace(" • Robinhood Token", "")}</td>
      <td class="num">${r.uiMultiplier.toFixed(6)}</td>
      <td class="num muted">${r.rawTotalSupply?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "–"}</td>
      <td class="num">${r.adjTotalSupply?.toLocaleString("en-US", { maximumFractionDigits: 0 }) ?? "–"}</td>
      <td class="num">${off > 50 ? `<span class="flag big">${off.toFixed(0)}%</span>` : `${off.toFixed(2)}%`}</td>
    </tr>`;
  };
  sortable($("#t-mult"), cols, rows, render, { key: (r) => r.uiMultiplier, dir: -1, name: "m" });
}

function coverage(snap) {
  const c = snap.counts;
  const noFeed = c.assets - c.withFeed;
  $("#coverage").innerHTML = [
    { n: c.assets, s: "Stock Tokens deployed on Robinhood Chain" },
    { n: c.withFeed, s: "have a Chainlink reference price" },
    { n: noFeed, s: "have none — the AMM is the only price", cls: "no-feed" },
    { n: c.trustworthy ?? c.priced, s: "priced on pools with real depth behind them" },
  ].map((k) => `<div class="cov ${k.cls ?? ""}"><b>${k.n}</b><span>${k.s}</span></div>`).join("");
}


// ---------------------------------------------------------------- wallet checker
//
// The one thing on this page a reader can ask about themselves, and the reason
// the page leads with it: every wallet on this chain reports balanceOf, and for
// ten of these tokens balanceOf is not the position. Read-only — a batched
// eth_call to the public RPC, no wallet connection and nothing signed.

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const BALANCE_OF = "0x70a08231";
const AGGREGATE3 = "0x82ad56cb";

const w = (n) => BigInt(n).toString(16).padStart(64, "0");

/**
 * ABI-encode Multicall3.aggregate3((address,bool,bytes)[]).
 *
 * Hand-rolled rather than pulled from a library because the page ships as three
 * files with no build step — and one eth_call is the only request shape this
 * RPC serves reliably to a browser. Batched JSON-RPC arrays come back with a
 * duplicated Access-Control-Allow-Origin header from one of its proxies, which
 * the browser refuses, so 194 balances have to travel as one call.
 */
function encodeAggregate3(calls) {
  const tuples = calls.map((c) => {
    const d = c.data.replace(/^0x/, "");
    const bytes = d.padEnd(Math.ceil(d.length / 64) * 64, "0");
    return w(c.target) + w(1) + w(96) + w(d.length / 2) + bytes;
  });
  let acc = calls.length * 32;
  const offsets = tuples.map((t) => { const o = acc; acc += t.length / 2; return w(o); });
  return AGGREGATE3 + w(32) + w(calls.length) + offsets.join("") + tuples.join("");
}

function decodeAggregate3(hex) {
  const h = hex.replace(/^0x/, "");
  const word = (i) => h.slice(i * 64, i * 64 + 64);
  const at = (i) => Number(BigInt("0x" + word(i))) / 32;
  const base = at(0) + 1;
  const len = Number(BigInt("0x" + word(base - 1)));
  const out = [];
  for (let i = 0; i < len; i++) {
    const t = base + at(base + i);
    const bStart = t + at(t + 1);
    const bLen = Number(BigInt("0x" + word(bStart)));
    out.push({
      success: BigInt("0x" + word(t)) === 1n,
      data: "0x" + h.slice((bStart + 1) * 64, (bStart + 1) * 64 + bLen * 2),
    });
  }
  return out;
}

async function ethCall(to, data) {
  const r = await fetch(RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  }).then((x) => x.json());
  if (r.error) throw new Error(r.error.message);
  return r.result;
}

async function balancesOf(address, tokens) {
  const owner = w(address);
  const out = new Map();
  for (let i = 0; i < tokens.length; i += 100) {
    const slice = tokens.slice(i, i + 100);
    const res = decodeAggregate3(await ethCall(
      MULTICALL3, encodeAggregate3(slice.map((t) => ({ target: t.token, data: BALANCE_OF + owner }))),
    ));
    res.forEach((r, j) => {
      if (!r.success || r.data === "0x") return;
      const raw = BigInt(r.data);
      if (raw > 0n) out.set(slice[j].symbol, raw);
    });
  }
  return out;
}

/** 18-decimal fixed point to a JS number, without going through BigInt division. */
const units = (raw, decimals) => Number(raw) / 10 ** decimals;

async function runCheck(snap, address) {
  const out = $("#check-out");
  out.innerHTML = `<p class="checking">Reading ${snap.rows.length} token contracts…</p>`;
  let held;
  try {
    held = await balancesOf(address, snap.rows);
  } catch {
    out.innerHTML = `<p class="checking">Could not reach the chain just now. Try again in a moment.</p>`;
    return;
  }

  const rows = snap.rows
    .filter((r) => held.has(r.symbol))
    .map((r) => {
      const raw = units(held.get(r.symbol), r.decimals);
      const m = r.uiMultiplier ?? 1;
      return { r, raw, real: raw * m, m, usd: r.poolUsd == null ? null : raw * m * r.poolUsd };
    })
    .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));

  if (!rows.length) {
    out.innerHTML = `<p class="checking">That address holds none of the ${snap.rows.length} Stock Tokens on this chain.</p>`;
    return;
  }

  const total = rows.reduce((t, x) => t + (x.usd ?? 0), 0);
  // Ordered by how wrong the raw number is, not by position size: a 4x split is
  // the point being made, and a 6 bp distribution accrual is not.
  const wrong = rows.filter((x) => Math.abs(x.m - 1) > 1e-9).sort((a, b) => Math.abs(b.m - 1) - Math.abs(a.m - 1));
  const missing = wrong.reduce((t, x) => t + (x.real - x.raw) * (x.r.poolUsd ?? 0), 0);

  const table = (list, cls = "") => `
    <div class="scroll"><table class="result-table ${cls}"><thead><tr>
      <th>Token</th>
      <th class="num">Your wallet shows</th>
      <th class="num">You actually hold</th>
      <th class="num">Price</th>
      <th class="num">Value</th>
    </tr></thead><tbody>
    ${list.map((x) => `
      <tr class="${Math.abs(x.m - 1) > 1e-9 ? "corrected" : ""}">
        <td class="sym">${x.r.symbol}</td>
        <td class="num muted">${x.raw.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
        <td class="num">${x.real.toLocaleString("en-US", { maximumFractionDigits: 4 })}</td>
        <td class="num muted">${x.r.poolUsd == null ? "no price" : fmtPrice(x.r.poolUsd)}</td>
        <td class="num">${x.usd == null ? "–" : fmtUsd(x.usd)}</td>
      </tr>`).join("")}
    </tbody></table></div>`;

  out.innerHTML = `
    <div class="result">
      <div class="result-top">
        <div><b>${fmtUsd(total)}</b><span>across ${rows.length} Stock Token${rows.length === 1 ? "" : "s"}</span></div>
        ${wrong.length
          ? `<div class="miss"><b>+${fmtUsd(missing)}</b><span>held but not shown, on ${wrong.length} token${wrong.length === 1 ? "" : "s"}</span></div>`
          : ""}
      </div>

      ${wrong.length ? `
        <h3 class="result-head">What a raw balance gets wrong here</h3>
        ${table(wrong, "lead")}
        <p class="note">These carry an ERC-8056 multiplier — a split or a distribution that changed what the
          balance means without changing the balance. Anything reading <code>balanceOf</code> alone shows the
          middle column.</p>
      ` : `<p class="note">Nothing in this wallet carries a multiplier right now, so a raw balance happens to be right.
        That changes the next time one of these tokens splits or pays out.</p>`}

      ${rows.length > wrong.length ? `
        <details class="all-holdings">
          <summary>All ${rows.length} holdings</summary>
          ${table(rows)}
        </details>` : ""}

      <p class="note">Valued at the on-chain consensus price, which is what the pools quote — not what a sale
        would fill at, and not available at all for the ${snap.rows.length - snap.counts.withFeed} tokens with no
        reference feed.</p>
    </div>`;
}

/**
 * A real wallet that holds every one of the multiplier-adjusted tokens, so a
 * first visit lands on the case the page is about rather than an empty result.
 */
const DEMO_ADDRESS = "0x92d435C96E63c43E12d6D0AB28f6b0B04072F765";

// ---------------------------------------------------------------- tiles

function drawTiles(snap) {
  const priced = snap.rows.filter((r) => r.quality === "ok");
  const arbs = snap.rows.filter((r) => r.venueArb && r.venueArb.netBps > 0)
    .sort((a, b) => b.venueArb.netBps - a.venueArb.netBps);
  const top = arbs[0];
  const tvl = snap.rows.reduce((t, r) => t + r.depthUsd, 0);
  const ages = snap.rows.filter((r) => r.feed).map((r) => r.feed.ageSec).sort((a, b) => a - b);
  const median = ages.length ? ages[Math.floor(ages.length / 2)] : 0;

  const tiles = [
    top ? {
      big: `${top.venueArb.netBps} bps`,
      label: `widest gap between two live pools, after both fees — ${top.symbol}`,
      sub: `worth ${fmtUsd(top.venueArb.sizeUsd * top.venueArb.netBps / 10000)} on the ${fmtUsd(top.venueArb.sizeUsd)} it can absorb`,
      tone: "market",
    } : {
      big: "none", label: "gaps between pools that survive both fees", sub: "the venues are arbitraged to inside their own toll", tone: "",
    },
    { big: fmtUsd(tvl), label: "sitting in Stock Token pools", sub: `across ${priced.length} tokens with depth behind their price`, tone: "" },
    { big: fmtSpan(median), label: "since the reference last moved", sub: snap.market.offHours
        ? `US market is ${snap.market.phase === "weekend" ? "closed for the weekend" : "shut"} — the pools are the only live price`
        : "the regular session is open, so the reference is tracking", tone: "ref" },
  ];

  $("#tiles").innerHTML = tiles.map((t) => `
    <div class="tile">
      <b class="${t.tone}">${t.big}</b>
      <span class="tile-label">${t.label}</span>
      <span class="tile-sub">${t.sub}</span>
    </div>`).join("");
}

// ---------------------------------------------------------------- why

function drawSteps(snap) {
  $("#why-note").textContent =
    "Two prices exist for the same token and they are kept by different machinery. "
    + "Chainlink publishes a reference that follows the US market on a 24-hour heartbeat and a 0.5% deviation trigger. "
    + "Uniswap keeps trading whether or not the market is open. The gap between them is the only genuinely new "
    + "information a tokenized equity produces.";

  $("#steps").innerHTML = [
    "Robinhood issues each US stock as an ERC-20 on its own chain. 194 of them exist today.",
    "35 of those have a Chainlink reference price. It only moves when the underlying moves half a percent, or once a day, whichever comes first.",
    "All 194 trade on Uniswap around the clock, including while the US market is shut.",
    "So out of hours the reference is a frozen photograph and the pool is the live price. The difference is the market's guess at the next open.",
  ].map((t) => `<li>${t}</li>`).join("");
}

// ---------------------------------------------------------------- the last mile

function arbTable(snap, onPick) {
  const rows = snap.rows.filter((r) => r.venueArb).sort((a, b) => b.venueArb.netBps - a.venueArb.netBps);
  const live = rows.filter((r) => r.venueArb.netBps > 0);
  const gas = snap.gas?.swapUsd ?? null;

  $("#arb-note").textContent =
    "A premium is measured against a Chainlink feed, and nobody trades at a Chainlink feed — collecting one means "
    + "betting the pool converges. The spread between two live pools of the same token is different: both legs are "
    + "on chain, in the same block, and it needs no view on where the stock is going. This is that spread, after "
    + "both pools' fees.";

  const cols = [
    { k: "symbol", t: "Token", key: (r) => r.symbol },
    { k: "net", t: "Net of both fees", key: (r) => r.venueArb.netBps, num: true, desc: true },
    { k: "gross", t: "Gross spread", key: (r) => r.venueArb.grossBps, num: true, desc: true },
    { k: "size", t: "Size it absorbs", key: (r) => r.venueArb.sizeUsd, num: true, desc: true },
    { k: "profit", t: "Which is worth", key: (r) => r.venueArb.sizeUsd * r.venueArb.netBps, num: true, desc: true },
    { k: "buy", t: "Buy", key: (r) => r.venueArb.buy.priceUsd },
    { k: "sell", t: "Sell", key: (r) => r.venueArb.sell.priceUsd },
  ];
  const render = (r) => {
    const a = r.venueArb;
    const profit = (a.sizeUsd * a.netBps) / 10000;
    const worth = gas != null && profit <= gas * 2;
    return `<tr data-sym="${r.symbol}" tabindex="0" class="${a.netBps > 0 ? "" : "thin"}">
      <td class="sym">${r.symbol}</td>
      <td class="num ${a.netBps > 0 ? "pos" : "muted"}">${fmtBps(a.netBps)}</td>
      <td class="num muted">${fmtBps(a.grossBps)}</td>
      <td class="num">${fmtUsd(a.sizeUsd)}</td>
      <td class="num ${worth ? "muted" : ""}">${profit < 0 ? "–" : "$" + profit.toFixed(2)}${worth ? ` <span class="flag">under gas</span>` : ""}</td>
      <td class="muted">${a.buy.venue} · ${a.buy.feeBps}bps</td>
      <td class="muted">${a.sell.venue} · ${a.sell.feeBps}bps</td>
    </tr>`;
  };
  const table = $("#t-arb");
  sortable(table, cols, rows.slice(0, 14), render, { key: (r) => r.venueArb.netBps, dir: -1, name: "net" });
  const bind = () => table.tBodies[0].querySelectorAll("tr").forEach((tr) => {
    const go = () => onPick(tr.dataset.sym);
    tr.addEventListener("click", go);
    tr.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  });
  table.addEventListener("painted", bind);
  bind();

  const best = live[0];
  const bestProfit = best ? (best.venueArb.sizeUsd * best.venueArb.netBps) / 10000 : 0;
  $("#arb-foot").innerHTML =
    `${live.length} of ${rows.length} pairs survive their own fees right now. `
    + (best
      ? `The widest, ${best.symbol}, clears ${best.venueArb.netBps} bps — but only across ${fmtUsd(best.venueArb.sizeUsd)}
         of size, which is <b>${"$" + bestProfit.toFixed(2)}</b> before ${gas == null ? "gas" : `the ${"$" + gas.toFixed(2)} of gas a swap costs`}
         and before either pool moves. That is the honest reason these are still open.`
      : `Nothing is worth crossing, which is what an arbitraged market looks like.`)
    + ` Size is what the pools can absorb before the two prices meet, capped at their actual reserves.`;
}

// ---------------------------------------------------------------- true float


const CAT = [
  { k: "pool",     label: "AMM pools",          fill: "var(--market)", op: 0.75 },
  { k: "escrow",   label: "Escrow",             fill: "var(--ref)",    op: 0.8 },
  { k: "protocol", label: "Protocol contracts", fill: "var(--ref)",    op: 0.45 },
  { k: "router",   label: "Routers",            fill: "var(--dimmer)", op: 0.9 },
  { k: "contract", label: "Other contracts",    fill: "var(--dimmer)", op: 0.55 },
  { k: "wallet",   label: "Wallets",            fill: "var(--text)",   op: 0.9 },
];

async function drawFloat(symbols) {
  if (!symbols.length) return;
  const reports = [];
  for (const sym of symbols) {
    try { reports.push(await (await fetch(`${DATA}/holders/${sym}.json`, { cache: "no-store" })).json()); }
    catch { /* skip a report that has not been generated */ }
  }
  if (!reports.length) return;
  $("#float-section").hidden = false;

  $("#float").innerHTML = reports.map((h) => {
    const segs = CAT.map((c) => ({ ...c, pct: h.byCategory[c.k]?.pct ?? 0 })).filter((c) => c.pct > 0.01);
    let acc = 0;
    const bar = segs.map((c) => {
      const left = acc; acc += c.pct;
      return `<span class="seg" style="left:${left}%;width:${c.pct}%;background:${c.fill};opacity:${c.op}"
                title="${c.label} ${c.pct.toFixed(2)}%"></span>`;
    }).join("");
    const legend = segs.map((c) =>
      `<li><i style="background:${c.fill};opacity:${c.op}"></i>${c.label} <b>${c.pct.toFixed(1)}%</b></li>`).join("");
    return `
      <div class="float-card">
        <div class="float-head">
          <h3>${h.symbol}</h3>
          <p class="meta">${h.transfersScanned.toLocaleString("en-US")} transfers ·
            ${h.holders.length.toLocaleString("en-US")} addresses hold a balance ·
            block ${Number(h.block).toLocaleString("en-US")}</p>
        </div>
        <div class="stack">${bar}</div>
        <ul class="legend">${legend}</ul>
        <p class="float-verdict">
          True float <b>${h.trueFloatPct.toFixed(1)}%</b> of supply.
          ${h.poolSharePct > 20
            ? `AMM pools hold ${h.poolSharePct.toFixed(1)}% — the price surface rests on a handful of LPs.`
            : `AMM pools hold ${h.poolSharePct.toFixed(1)}%.`}
          Top 10 wallets hold ${h.topWalletsShareOfFloatPct.toFixed(1)}% of that float.
        </p>
      </div>`;
  }).join("");
}

// ---------------------------------------------------------------- detail

function drawDetail(snap, series, sym) {
  const r = snap.rows.find((x) => x.symbol === sym);
  if (!r) return;
  document.querySelectorAll("#t-priced tbody tr").forEach((tr) =>
    tr.classList.toggle("selected", tr.dataset.sym === sym));

  const pools = r.pools.slice(0, 8).map((p) => `
    <tr>
      <td>${p.venue}</td>
      <td class="muted">${p.quote}</td>
      <td class="num muted">${p.dynamicFee ? "dynamic" : (p.fee / 10000).toFixed(2) + "%"}</td>
      <td class="num">${fmtPrice(p.priceUsd)}</td>
      <td class="num">${fmtUsd(p.tvlUsd)}</td>
      <td class="muted">${p.tvlBasis ?? ""}</td>
      <td>${p.outlier ? `<span class="flag">outlier</span>` : ""}</td>
      <td class="muted">${p.id.slice(0, 10)}…</td>
    </tr>`).join("");

  $("#detail").innerHTML = `
    <h3>${r.symbol} — ${r.name.replace(" • Robinhood Token", "")}</h3>
    <p class="meta">${r.token} · ISIN ${r.isin ?? "–"} ·
      ${r.livePools} of ${r.poolsTotal ?? r.pools.length} pools set the consensus price ·
      venue spread ${r.dispersionBps ?? "–"} bps</p>
    <svg id="spark" role="img" aria-label="Premium history for ${r.symbol}"></svg>
    <div class="scroll"><table><thead><tr>
      <th>Venue</th><th>Quote</th><th class="num">Fee</th><th class="num">Price</th>
      <th class="num">TVL</th><th>TVL read as</th><th></th><th>Pool</th>
    </tr></thead><tbody>${pools}</tbody></table></div>
    <p class="note">${Math.min(8, r.pools.length)} deepest pools of ${r.poolsTotal ?? r.pools.length}.
      V3 reserves are read directly; V4 pools keep their money commingled in the singleton PoolManager,
      so their share is apportioned rather than read.</p>`;

  drawSpark(series, sym);
}

function drawSpark(series, sym) {
  const svg = $("#spark");
  if (!svg) return;
  const pts = series
    .map((p) => ({ ts: p.ts, v: (p.rows.find((row) => row[0] === sym) ?? [])[1] }))
    .filter((p) => p.v != null);
  if (pts.length < 2) {
    svg.outerHTML = `<p class="note" id="spark-empty">Premium history starts filling in once a few hourly snapshots have landed — ${pts.length} so far.</p>`;
    return;
  }
  const W = svg.clientWidth || 620, H = 92, pad = 18;
  const vs = pts.map((p) => p.v);
  const lo = Math.min(0, ...vs), hi = Math.max(0, ...vs);
  const x = (i) => pad + (i / (pts.length - 1)) * (W - 2 * pad);
  const y = (v) => H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  const d = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(" ");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.innerHTML = `
    <line class="zero" x1="${pad}" y1="${y(0)}" x2="${W - pad}" y2="${y(0)}"/>
    <path d="${d}"/>
    <text x="${pad}" y="12">${fmtBps(Math.round(hi))} bps</text>
    <text x="${pad}" y="${H - 4}">${fmtBps(Math.round(lo))} bps</text>
    <text x="${W - pad}" y="${H - 4}" text-anchor="end">${pts.length} readings</text>`;
}

// ---------------------------------------------------------------- boot

async function main() {
  let index, snap;
  try {
    index = await (await fetch(`${DATA}/index.json`, { cache: "no-store" })).json();
    snap = await (await fetch(`${DATA}/latest.json`, { cache: "no-store" })).json();
  } catch (e) {
    $("#loading").textContent =
      "No snapshot found. Run `npm run snapshot` in the repo, then reload — the dashboard reads the files it writes into data/.";
    return;
  }

  let series = [];
  for (const day of (index.days ?? []).slice(-3)) {
    const text = await (await fetch(`${DATA}/series/${day}.ndjson`, { cache: "no-store" })).text();
    series.push(...text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  series.sort((a, b) => a.ts.localeCompare(b.ts));

  $("#main").innerHTML = "";
  $("#main").append($("#tpl-body").content.cloneNode(true));

  drawTiles(snap);
  drawSteps(snap);
  drawDayBar(snap);
  drawChainline(snap);
  const onPick = (sym) => {
    drawDetail(snap, series, sym);
    $("#detail").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "center" });
  };
  arbTable(snap, onPick);
  drawBand(snap, onPick);
  pricedTable(snap, onPick);
  multiplierTable(snap);
  coverage(snap);
  drawFloat(index.holders ?? []);

  $("#addr-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const v = $("#addr").value.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) {
      $("#check-out").innerHTML = `<p class="checking">That is not an address. It should be 0x followed by 40 hex characters.</p>`;
      return;
    }
    runCheck(snap, v);
  });
  $("#demo").addEventListener("click", () => {
    $("#addr").value = DEMO_ADDRESS;
    runCheck(snap, DEMO_ADDRESS);
  });

  let t;
  addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => { drawDayBar(snap); drawBand(snap, onPick); }, 150);
  });
}

main();
