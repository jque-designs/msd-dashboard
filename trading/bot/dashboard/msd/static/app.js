/* ─── Market Structure Dashboard — Full Client-Side Engine ─── */
/* All Binance data fetching + calculations run in the browser. */

const REFRESH_MS = 15000;
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"];
const BINANCE_DIRECT = "https://api.binance.com/api/v3/klines";
const CGI_BIN = "cgi-bin";
const PROXY_URL = `${CGI_BIN}/proxy.py`;
const CANDLE_LIMIT = 200;
let useProxy = null; // auto-detect: null = unknown, true/false = decided
const PIVOT_LEFT = 5;
const PIVOT_RIGHT = 5;
const EMA_PERIOD = 21;

const TF_WEIGHTS = { "1m":1, "5m":2, "15m":3, "1h":5, "4h":8, "1d":13, "1w":21 };

let activeSymbol = "BTCUSDT";
let allData = {};
let refreshTimer = null;

/* ─── Init ─── */
document.addEventListener("DOMContentLoaded", () => {
  initTabs();
  fetchAll();
  refreshTimer = setInterval(fetchAll, REFRESH_MS);
});

/* ─── Connection Status ─── */
function showStatus(msg, isError = false) {
  const el = document.getElementById("last-update");
  el.textContent = msg;
  el.style.color = isError ? "#f85149" : "#8b949e";
}

/* ─── Tab Handling ─── */
function initTabs() {
  document.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
      btn.classList.add("active");
      activeSymbol = btn.dataset.symbol;
      if (allData[activeSymbol]) renderDashboard();
    });
  });
}

/* ─── Fetch All Data ─── */
async function fetchAll() {
  let anySuccess = false;
  try {
    const promises = SYMBOLS.map(s => analyzeSymbol(s).catch(e => null));
    const results = await Promise.all(promises);
    results.forEach((r, i) => {
      if (r && r.timeframes) {
        const hasData = TIMEFRAMES.some(tf => r.timeframes[tf] && !r.timeframes[tf].error && r.timeframes[tf].current_price);
        if (hasData) { allData[SYMBOLS[i]] = r; anySuccess = true; }
      }
    });
    if (anySuccess) {
      document.getElementById("skeleton").style.display = "none";
      document.getElementById("panels").style.display = "flex";
      renderDashboard();
      const now = new Date();
      showStatus(`${now.toLocaleTimeString()} \u00b7 15s`);
    } else {
      throw new Error("No data");
    }
  } catch (err) {
    console.error("Fetch error:", err);
    if (!anySuccess) {
      showStatus("Binance unreachable \u2014 showing demo", true);
      loadDemoData();
    }
  }
}

/* ─── Binance Klines Fetch ─── */
const _klineCache = {};
async function fetchKlines(symbol, interval, limit = CANDLE_LIMIT) {
  const key = `${symbol}_${interval}`;
  const now = Date.now();
  if (_klineCache[key] && now - _klineCache[key].ts < 10000) {
    return _klineCache[key].data;
  }

  let raw;
  // Try direct Binance first (works when user opens in their browser)
  // Fall back to CGI proxy (works in sandboxed environments)
  if (useProxy !== true) {
    try {
      const directUrl = `${BINANCE_DIRECT}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await fetch(directUrl);
      if (res.ok) {
        raw = await res.json();
        if (useProxy === null) useProxy = false;
      } else {
        throw new Error(`HTTP ${res.status}`);
      }
    } catch (e) {
      if (useProxy === null) useProxy = true;
    }
  }

  if (!raw && useProxy) {
    const proxyUrl = `${PROXY_URL}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    const res = await fetch(proxyUrl);
    if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
    raw = await res.json();
    if (raw.error) throw new Error(raw.error);
  }

  if (!raw) throw new Error("No data source available");
  const candles = raw.map(k => ({
    open_time: k[0],
    open: +k[1],
    high: +k[2],
    low: +k[3],
    close: +k[4],
    volume: +k[5],
    close_time: k[6],
  }));
  _klineCache[key] = { ts: now, data: candles };
  return candles;
}

/* ─── Pivot Detection (exact TradingView ta.pivothigh/ta.pivotlow match) ─── */
function detectPivots(candles, left = PIVOT_LEFT, right = PIVOT_RIGHT) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const n = candles.length;
  const pivotHighs = [];
  const pivotLows = [];

  for (let i = left; i < n - right; i++) {
    // Pivot High: high[i] >= all in left, high[i] > all in right
    let isPH = true;
    for (let j = i - left; j < i; j++) {
      if (highs[j] > highs[i]) { isPH = false; break; }
    }
    if (isPH) {
      for (let j = i + 1; j <= i + right; j++) {
        if (highs[j] >= highs[i]) { isPH = false; break; }
      }
    }
    if (isPH) pivotHighs.push({ index: i, price: highs[i], bar_time: candles[i].open_time });

    // Pivot Low: low[i] <= all in left, low[i] < all in right
    let isPL = true;
    for (let j = i - left; j < i; j++) {
      if (lows[j] < lows[i]) { isPL = false; break; }
    }
    if (isPL) {
      for (let j = i + 1; j <= i + right; j++) {
        if (lows[j] <= lows[i]) { isPL = false; break; }
      }
    }
    if (isPL) pivotLows.push({ index: i, price: lows[i], bar_time: candles[i].open_time });
  }

  return { pivotHighs, pivotLows };
}

/* ─── Market Structure (HH/HL/LH/LL) ─── */
function detectMarketStructure(pivotHighs, pivotLows) {
  const highLabels = [];
  for (let i = 1; i < pivotHighs.length; i++) {
    const label = pivotHighs[i].price > pivotHighs[i-1].price ? "HH" : "LH";
    highLabels.push({ label, index: pivotHighs[i].index });
  }
  const lowLabels = [];
  for (let i = 1; i < pivotLows.length; i++) {
    const label = pivotLows[i].price > pivotLows[i-1].price ? "HL" : "LL";
    lowLabels.push({ label, index: pivotLows[i].index });
  }
  const all = [...highLabels, ...lowLabels].sort((a, b) => a.index - b.index);
  const recent = all.slice(-6);
  const labels = recent.map(x => x.label);
  const last4 = labels.slice(-4);
  const bull = last4.filter(l => l === "HH" || l === "HL").length;
  const bear = last4.filter(l => l === "LH" || l === "LL").length;
  const bias = bull > bear ? "bullish" : bear > bull ? "bearish" : "neutral";
  return { labels, bias };
}

/* ─── Order Block Detection ─── */
function detectOrderBlocks(candles, pivotHighs, pivotLows) {
  if (!candles.length) return { bull: null, bear: null };
  const price = candles[candles.length - 1].close;
  const n = candles.length;
  const bullOBs = [];
  const bearOBs = [];

  // Bullish OBs
  for (const ph of pivotHighs) {
    const pi = ph.index;
    for (let j = pi + PIVOT_RIGHT; j < n; j++) {
      if (candles[j].close > ph.price) {
        let minLow = Infinity, obIdx = 0;
        const start = Math.max(0, pi - PIVOT_LEFT);
        for (let k = start; k < j; k++) {
          if (candles[k].low < minLow) { minLow = candles[k].low; obIdx = k; }
        }
        let mitigated = false;
        for (let k = obIdx + 1; k < n; k++) {
          if (candles[k].close < candles[obIdx].low) { mitigated = true; break; }
        }
        if (!mitigated) {
          const dist = ((price - candles[obIdx].high) / price) * 100;
          bullOBs.push({ type: "bull", top: candles[obIdx].high, bottom: candles[obIdx].low, distance_pct: Math.round(dist * 100) / 100 });
        }
        break;
      }
    }
  }

  // Bearish OBs
  for (const pl of pivotLows) {
    const pi = pl.index;
    for (let j = pi + PIVOT_RIGHT; j < n; j++) {
      if (candles[j].close < pl.price) {
        let maxHigh = -Infinity, obIdx = 0;
        const start = Math.max(0, pi - PIVOT_LEFT);
        for (let k = start; k < j; k++) {
          if (candles[k].high > maxHigh) { maxHigh = candles[k].high; obIdx = k; }
        }
        let mitigated = false;
        for (let k = obIdx + 1; k < n; k++) {
          if (candles[k].close > candles[obIdx].high) { mitigated = true; break; }
        }
        if (!mitigated) {
          const dist = ((candles[obIdx].bottom - price) / price) * 100;
          bearOBs.push({ type: "bear", top: candles[obIdx].high, bottom: candles[obIdx].low, distance_pct: Math.round(dist * 100) / 100 });
        }
        break;
      }
    }
  }

  const nearest = (obs) => obs.length ? obs.reduce((a, b) => Math.abs(a.distance_pct) < Math.abs(b.distance_pct) ? a : b) : null;
  return { bull: nearest(bullOBs), bear: nearest(bearOBs) };
}

/* ─── FVG Detection ─── */
function detectFVGs(candles) {
  if (candles.length < 3) return { bull: null, bear: null };
  const price = candles[candles.length - 1].close;
  const n = candles.length;
  const bullFVGs = [];
  const bearFVGs = [];

  for (let i = 1; i < n - 1; i++) {
    const prev = candles[i - 1];
    const nxt = candles[i + 1];

    // Bull FVG: gap between prev.high and nxt.low
    if (nxt.low > prev.high) {
      let mitigated = false;
      for (let k = i + 2; k < n; k++) {
        if (candles[k].low <= prev.high) { mitigated = true; break; }
      }
      if (!mitigated) {
        const mid = (nxt.low + prev.high) / 2;
        const dist = ((price - mid) / price) * 100;
        bullFVGs.push({ type: "bull", top: nxt.low, bottom: prev.high, distance_pct: Math.round(dist * 100) / 100 });
      }
    }

    // Bear FVG
    if (nxt.high < prev.low) {
      let mitigated = false;
      for (let k = i + 2; k < n; k++) {
        if (candles[k].high >= prev.low) { mitigated = true; break; }
      }
      if (!mitigated) {
        const mid = (prev.low + nxt.high) / 2;
        const dist = ((mid - price) / price) * 100;
        bearFVGs.push({ type: "bear", top: prev.low, bottom: nxt.high, distance_pct: Math.round(dist * 100) / 100 });
      }
    }
  }

  const nearest = (fvgs) => fvgs.length ? fvgs.reduce((a, b) => Math.abs(a.distance_pct) < Math.abs(b.distance_pct) ? a : b) : null;
  return { bull: nearest(bullFVGs), bear: nearest(bearFVGs) };
}

/* ─── EMA ─── */
function calcEMA(candles, period = EMA_PERIOD) {
  if (candles.length < period) return { direction: "—", distance_pct: 0, value: 0 };
  const closes = candles.map(c => c.close);
  const mult = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) {
    ema = (closes[i] - ema) * mult + ema;
  }
  const curr = closes[closes.length - 1];
  const dist = ((curr - ema) / ema) * 100;
  return {
    direction: curr > ema ? "above" : curr < ema ? "below" : "at",
    distance_pct: Math.round(dist * 100) / 100,
    value: Math.round(ema * 100) / 100
  };
}

/* ─── Swing Bar Text ─── */
function swingBarText(candles, pivotHighs, pivotLows) {
  if (!pivotHighs.length || !pivotLows.length || !candles.length)
    return { text: "L ─────────── H", position: 0.5, swing_high: 0, swing_low: 0 };
  const sh = pivotHighs[pivotHighs.length - 1].price;
  const sl = pivotLows[pivotLows.length - 1].price;
  const curr = candles[candles.length - 1].close;
  let pos = sh === sl ? 0.5 : Math.max(0, Math.min(1, (curr - sl) / (sh - sl)));
  const barLen = 11;
  const dotPos = Math.round(pos * (barLen - 1));
  let bar = "";
  for (let i = 0; i < barLen; i++) bar += i === dotPos ? "⬤" : "─";
  return { text: `L ${bar} H`, position: Math.round(pos * 1000) / 1000, swing_high: sh, swing_low: sl, current: curr };
}

/* ─── Volume Analysis ─── */
function analyzeVolume(candles, lookback = 50) {
  if (candles.length < lookback + 1) return { state: "NORMAL", ratio: 1, current_vol: 0, avg_vol: 0 };
  const recent = candles.slice(-(lookback + 1), -1).map(c => c.volume);
  const curr = candles[candles.length - 1].volume;
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length || 1;
  const ratio = curr / avg;
  let state;
  if (ratio >= 3) state = "EXTREME";
  else if (ratio >= 2) state = "HIGH";
  else if (ratio >= 0.8) state = "NORMAL";
  else if (ratio >= 0.4) state = "LOW";
  else state = "VERY LOW";
  return { state, ratio: Math.round(ratio * 100) / 100, current_vol: curr, avg_vol: avg };
}

/* ─── Volatility (ATR-based) ─── */
function analyzeVolatility(candles, lookback = 20) {
  if (candles.length < lookback + 1) return { state: "NORMAL", atr: 0, avg_atr: 0, ratio: 1 };
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i-1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  if (trs.length < lookback) return { state: "NORMAL", atr: 0, avg_atr: 0, ratio: 1 };
  const currentATR = trs.slice(-lookback).reduce((a, b) => a + b, 0) / lookback;
  const longer = Math.min(lookback * 3, trs.length);
  const avgATR = trs.slice(-longer).reduce((a, b) => a + b, 0) / longer;
  const ratio = avgATR ? currentATR / avgATR : 1;
  let state;
  if (ratio >= 1.8) state = "EXTREME";
  else if (ratio >= 1.3) state = "HIGH";
  else if (ratio >= 0.7) state = "NORMAL";
  else state = "LOW";
  return { state, atr: +currentATR.toFixed(6), avg_atr: +avgATR.toFixed(6), ratio: Math.round(ratio * 100) / 100 };
}

/* ─── Sessions & Killzones ─── */
function getSessionsAndKillzones() {
  const now = new Date();
  const h = now.getUTCHours();
  const m = now.getUTCMinutes();
  const t = h * 60 + m;
  const sessions = [];
  if (t < 540) sessions.push("Asian");
  if (t >= 420 && t < 960) sessions.push("London");
  if (t >= 780 && t < 1320) sessions.push("New York");
  if (!sessions.length) sessions.push("Off-Hours");

  let killzone = "None";
  if (t < 240) killzone = "Asian KZ";
  else if (t >= 360 && t < 540) killzone = "London KZ";
  else if (t >= 720 && t < 840) killzone = "NY AM KZ";
  else if (t >= 900 && t < 960) killzone = "NY Lunch";
  else if (t >= 1080 && t < 1200) killzone = "NY PM KZ";

  const pad = n => String(n).padStart(2, '0');
  return {
    sessions,
    killzone,
    utc_time: `${pad(h)}:${pad(m)} UTC`,
    est_time: `${pad((h + 19) % 24)}:${pad(m)} EST`
  };
}

/* ─── HTF Levels ─── */
async function getHTFLevels(symbol) {
  const results = {};
  let currentPrice = null;
  try {
    const d = await fetchKlines(symbol, "1d", 3);
    if (d && d.length >= 2) {
      currentPrice = d[d.length - 1].close;
      const prev = d[d.length - 2];
      results.prev_day = {
        high: prev.high, low: prev.low,
        high_dist: Math.round(((currentPrice - prev.high) / currentPrice) * 10000) / 100,
        low_dist: Math.round(((currentPrice - prev.low) / currentPrice) * 10000) / 100,
      };
    }
  } catch (e) {}
  try {
    const w = await fetchKlines(symbol, "1w", 3);
    if (w && w.length >= 2) {
      if (!currentPrice) currentPrice = w[w.length - 1].close;
      const prev = w[w.length - 2];
      results.prev_week = {
        high: prev.high, low: prev.low,
        high_dist: Math.round(((currentPrice - prev.high) / currentPrice) * 10000) / 100,
        low_dist: Math.round(((currentPrice - prev.low) / currentPrice) * 10000) / 100,
      };
    }
  } catch (e) {}
  try {
    const mo = await fetchKlines(symbol, "1M", 3);
    if (mo && mo.length >= 2) {
      if (!currentPrice) currentPrice = mo[mo.length - 1].close;
      const prev = mo[mo.length - 2];
      results.prev_month = {
        high: prev.high, low: prev.low,
        high_dist: Math.round(((currentPrice - prev.high) / currentPrice) * 10000) / 100,
        low_dist: Math.round(((currentPrice - prev.low) / currentPrice) * 10000) / 100,
      };
    }
  } catch (e) {}
  results.current_price = currentPrice;
  return results;
}

/* ─── Trend Bias ─── */
function computeTrendBias(tfData) {
  let totalWeight = 0, weighted = 0;
  for (const tf of TIMEFRAMES) {
    const d = tfData[tf];
    if (!d) continue;
    const w = TF_WEIGHTS[tf] || 1;
    totalWeight += w * 4;

    if (d.structure_bias === "bullish") weighted += w;
    else if (d.structure_bias === "bearish") weighted -= w;

    const bo = d.nearest_bull_ob, beo = d.nearest_bear_ob;
    if (bo && beo) { weighted += Math.abs(bo.distance_pct) < Math.abs(beo.distance_pct) ? w : -w; }
    else if (bo) weighted += w;
    else if (beo) weighted -= w;

    const bf = d.nearest_bull_fvg, bef = d.nearest_bear_fvg;
    if (bf && bef) { weighted += Math.abs(bf.distance_pct) < Math.abs(bef.distance_pct) ? w : -w; }
    else if (bf) weighted += w;
    else if (bef) weighted -= w;

    const pos = d.swing_bar?.position ?? 0.5;
    if (pos > 0.6) weighted += w;
    else if (pos < 0.4) weighted -= w;
  }
  return totalWeight ? Math.round((weighted / totalWeight) * 100) : 0;
}

/* ─── Full Symbol Analysis ─── */
async function analyzeSymbol(symbol) {
  const result = { symbol, timeframes: {}, htf_levels: {}, trend_bias: 0 };

  // Fetch all TFs in parallel
  const tfPromises = TIMEFRAMES.map(async tf => {
    try {
      const candles = await fetchKlines(symbol, tf);
      if (!candles || candles.length < 20) return { tf, error: true };
      const { pivotHighs, pivotLows } = detectPivots(candles);
      const { labels, bias } = detectMarketStructure(pivotHighs, pivotLows);
      const obs = detectOrderBlocks(candles, pivotHighs, pivotLows);
      const fvgs = detectFVGs(candles);
      const ema = calcEMA(candles);
      const swing = swingBarText(candles, pivotHighs, pivotLows);

      const data = {
        current_price: candles[candles.length - 1].close,
        swing_bar: swing,
        structure_labels: labels,
        structure_bias: bias,
        nearest_bull_ob: obs.bull,
        nearest_bear_ob: obs.bear,
        nearest_bull_fvg: fvgs.bull,
        nearest_bear_fvg: fvgs.bear,
        ema,
      };
      if (tf === "15m") {
        data.volume = analyzeVolume(candles);
        data.volatility = analyzeVolatility(candles);
      }
      return { tf, data };
    } catch (e) {
      console.error(`Error ${symbol} ${tf}:`, e);
      return { tf, error: true };
    }
  });

  const tfResults = await Promise.all(tfPromises);
  for (const r of tfResults) {
    if (r.error) result.timeframes[r.tf] = { error: "Failed" };
    else result.timeframes[r.tf] = r.data;
  }

  result.htf_levels = await getHTFLevels(symbol);
  result.trend_bias = computeTrendBias(result.timeframes);
  return result;
}

/* ═══════════════════════════════════════════════════════
   RENDERING
   ═══════════════════════════════════════════════════════ */

function renderDashboard() {
  if (!allData[activeSymbol]) return;
  const sym = allData[activeSymbol];
  renderMTFTable(sym);
  renderCurrentTF(sym);
  renderContext(sym);
  renderHTFLevels(sym);
}

/* ─── Panel 1: MTF Table ─── */
function renderMTFTable(sym) {
  const tbody = document.getElementById("mtf-body");
  const tfs = sym.timeframes || {};
  let html = "";

  for (const tf of TIMEFRAMES) {
    const d = tfs[tf];
    if (!d || d.error) {
      html += `<tr><td class="tf-label">${tf}</td><td colspan="5" style="color:#484f58">No data</td></tr>`;
      continue;
    }

    const swing = d.swing_bar || {};
    const pos = swing.position || 0.5;
    const swingColor = pos > 0.6 ? "#3fb950" : pos < 0.4 ? "#f85149" : "#8b949e";

    const labels = d.structure_labels || [];
    const structHTML = labels.map(l => {
      const cls = l === "HH" ? "struct-hh" : l === "HL" ? "struct-hl" : l === "LH" ? "struct-lh" : "struct-ll";
      return `<span class="struct-tag ${cls}">${l}</span>`;
    }).join("");

    let obHTML = "";
    if (d.nearest_bull_ob) obHTML += `<span class="bull-tag">▲</span> <span class="dist-tag">${d.nearest_bull_ob.distance_pct}%</span>`;
    if (d.nearest_bear_ob) {
      if (obHTML) obHTML += "<br>";
      obHTML += `<span class="bear-tag">▼</span> <span class="dist-tag">${d.nearest_bear_ob.distance_pct}%</span>`;
    }
    if (!obHTML) obHTML = `<span class="dist-tag">—</span>`;

    let fvgHTML = "";
    if (d.nearest_bull_fvg) fvgHTML += `<span class="bull-tag">▲</span> <span class="dist-tag">${d.nearest_bull_fvg.distance_pct}%</span>`;
    if (d.nearest_bear_fvg) {
      if (fvgHTML) fvgHTML += "<br>";
      fvgHTML += `<span class="bear-tag">▼</span> <span class="dist-tag">${d.nearest_bear_fvg.distance_pct}%</span>`;
    }
    if (!fvgHTML) fvgHTML = `<span class="dist-tag">—</span>`;

    const ema = d.ema || {};
    const emaCls = ema.direction === "above" ? "ema-above" : ema.direction === "below" ? "ema-below" : "ema-at";
    const emaArr = ema.direction === "above" ? "▲" : ema.direction === "below" ? "▼" : "●";

    html += `<tr>
      <td class="tf-label">${tf}</td>
      <td class="swing-bar-cell" style="color:${swingColor}">${swing.text || "—"}</td>
      <td><div class="structure-labels">${structHTML}</div></td>
      <td class="ob-cell">${obHTML}</td>
      <td class="fvg-cell">${fvgHTML}</td>
      <td class="${emaCls}">${emaArr} ${ema.distance_pct || 0}%</td>
    </tr>`;
  }

  tbody.innerHTML = html;

  const d15 = tfs["15m"];
  const badge = document.getElementById("structure-badge");
  if (d15 && d15.structure_bias) {
    badge.textContent = d15.structure_bias;
    badge.className = `badge badge-${d15.structure_bias}`;
  }
}

/* ─── Panel 2: Current TF ─── */
function renderCurrentTF(sym) {
  const d = sym.timeframes?.["15m"];
  if (!d || d.error) return;

  const vol = d.volume || {};
  const state = vol.state || "NORMAL";
  const stateEl = document.getElementById("vol-state");
  stateEl.textContent = state;
  stateEl.className = `metric-value state-${state.toLowerCase().replace(/ /g, "-")}`;

  const bar = document.getElementById("vol-bar");
  const ratio = Math.min(vol.ratio || 1, 5);
  bar.style.width = Math.min((ratio / 5) * 100, 100) + "%";
  const colors = { "EXTREME": "#f0883e", "HIGH": "#d2a8ff", "NORMAL": "#8b949e", "LOW": "#484f58", "VERY LOW": "#30363d" };
  bar.style.background = colors[state] || "#8b949e";
  document.getElementById("vol-ratio").textContent =
    `${ratio.toFixed(1)}x avg · ${fmtNum(vol.current_vol)} / ${fmtNum(vol.avg_vol)}`;

  const swing = d.swing_bar || {};
  document.getElementById("swing-pos").textContent = swing.text || "—";
  document.getElementById("swing-detail").textContent =
    swing.swing_high ? `H: ${fmtPrice(swing.swing_high)} · L: ${fmtPrice(swing.swing_low)}` : "—";

  const v = d.volatility || {};
  const vs = v.state || "NORMAL";
  const vEl = document.getElementById("vol-state-atr");
  vEl.textContent = vs;
  vEl.className = `metric-value state-${vs.toLowerCase()}`;
  document.getElementById("vol-atr-detail").textContent =
    `ATR: ${v.atr || "—"} · ${(v.ratio || 1).toFixed(1)}x avg`;
}

/* ─── Panel 3: Context ─── */
function renderContext(sym) {
  const sess = getSessionsAndKillzones();
  document.getElementById("session-name").textContent = sess.sessions.join(" + ");
  document.getElementById("session-time").textContent = `${sess.utc_time} · ${sess.est_time}`;
  const kzEl = document.getElementById("killzone-name");
  kzEl.textContent = sess.killzone;
  kzEl.style.color = sess.killzone !== "None" ? "#d2a8ff" : "#484f58";

  const bias = sym.trend_bias ?? 0;
  const scoreEl = document.getElementById("bias-score");
  animateNumber(scoreEl, bias);

  const biasBar = document.getElementById("bias-bar");
  if (bias >= 0) {
    biasBar.style.left = "50%";
    biasBar.style.width = `${Math.min(Math.abs(bias), 100) / 2}%`;
    biasBar.style.background = "#3fb950";
  } else {
    const w = Math.min(Math.abs(bias), 100) / 2;
    biasBar.style.left = `${50 - w}%`;
    biasBar.style.width = `${w}%`;
    biasBar.style.background = "#f85149";
  }

  const label = document.getElementById("bias-label");
  if (bias > 25) { label.textContent = "Bullish"; label.style.color = "#3fb950"; }
  else if (bias > 5) { label.textContent = "Lean Bullish"; label.style.color = "#56d364"; }
  else if (bias < -25) { label.textContent = "Bearish"; label.style.color = "#f85149"; }
  else if (bias < -5) { label.textContent = "Lean Bearish"; label.style.color = "#f97583"; }
  else { label.textContent = "Neutral"; label.style.color = "#8b949e"; }
  scoreEl.style.color = bias > 5 ? "#3fb950" : bias < -5 ? "#f85149" : "#8b949e";
}

/* ─── Panel 4: HTF Levels ─── */
function renderHTFLevels(sym) {
  const htf = sym.htf_levels || {};
  document.getElementById("htf-price").textContent = htf.current_price ? `@ ${fmtPrice(htf.current_price)}` : "—";
  renderHTFRow("htf-day", htf.prev_day);
  renderHTFRow("htf-week", htf.prev_week);
  renderHTFRow("htf-month", htf.prev_month);
}
function renderHTFRow(id, data) {
  const el = document.getElementById(id);
  if (!el) return;
  const vals = el.querySelector(".htf-values");
  if (!data) { vals.innerHTML = `<span style="color:#484f58">No data</span>`; return; }
  vals.innerHTML = `
    <span class="htf-high">H: ${fmtPrice(data.high)} <span class="htf-dist">(${data.high_dist > 0 ? "+" : ""}${data.high_dist}%)</span></span>
    <span class="htf-low">L: ${fmtPrice(data.low)} <span class="htf-dist">(${data.low_dist > 0 ? "+" : ""}${data.low_dist}%)</span></span>`;
}

/* ─── Helpers ─── */
function fmtPrice(p) {
  if (p == null) return "—";
  const n = Number(p);
  if (n >= 1000) return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}
function fmtNum(n) {
  if (n == null) return "—";
  n = Number(n);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return n.toFixed(1);
}
function animateNumber(el, target) {
  const start = parseInt(el.textContent) || 0;
  const diff = target - start;
  if (diff === 0) { el.textContent = target; return; }
  let step = 0;
  const timer = setInterval(() => {
    step++;
    el.textContent = Math.round(start + (diff * step / 20));
    if (step >= 20) { el.textContent = target; clearInterval(timer); }
  }, 20);
}

/* ═══════════════════════════════════════════════════════
   DEMO DATA — used when Binance API is unreachable
   ═══════════════════════════════════════════════════════ */
function loadDemoData() {
  const demoSymbols = {
    BTCUSDT: { price: 84523.40, sh: 85200, sl: 83100, pdh: 85100, pdl: 82900, pwh: 86500, pwl: 81200, pmh: 89000, pml: 78500 },
    ETHUSDT: { price: 2128.55, sh: 2180, sl: 2050, pdh: 2160, pdl: 2040, pwh: 2250, pwl: 1980, pmh: 2400, pml: 1850 },
    SOLUSDT: { price: 139.82, sh: 145, sl: 132, pdh: 143, pdl: 131, pwh: 152, pwl: 125, pmh: 165, pml: 110 },
  };

  const demoStructures = {
    "1m": ["HL","HH","HL","LH","LL","HL"], "5m": ["HH","HL","HH","HL","LH","HL"],
    "15m": ["HH","HL","HH","HL","HH","HL"], "1h": ["LH","HL","HH","HL","HH","HL"],
    "4h": ["HH","HL","LH","LL","HL","HH"], "1d": ["LH","LL","LH","LL","HL","HH"],
    "1w": ["HH","HL","HH","HL","HH","HL"]
  };
  const demoBias = {
    "1m": "neutral", "5m": "bullish", "15m": "bullish", "1h": "bullish",
    "4h": "neutral", "1d": "bearish", "1w": "bullish"
  };

  for (const [sym, s] of Object.entries(demoSymbols)) {
    const tfs = {};
    for (const tf of TIMEFRAMES) {
      const jitter = (Math.random() - 0.5) * 0.02 * s.price;
      const cp = +(s.price + jitter).toFixed(2);
      const pos = Math.max(0, Math.min(1, (cp - s.sl) / (s.sh - s.sl)));
      const barLen = 11;
      const dotPos = Math.round(pos * (barLen - 1));
      let bar = "";
      for (let i = 0; i < barLen; i++) bar += i === dotPos ? "\u2B24" : "\u2500";

      const bullDist = +(Math.random() * -2).toFixed(2);
      const bearDist = +(Math.random() * 2).toFixed(2);

      tfs[tf] = {
        current_price: cp,
        swing_bar: { text: `L ${bar} H`, position: +pos.toFixed(3), swing_high: s.sh, swing_low: s.sl, current: cp },
        structure_labels: demoStructures[tf],
        structure_bias: demoBias[tf],
        nearest_bull_ob: { type: "bull", distance_pct: bullDist },
        nearest_bear_ob: { type: "bear", distance_pct: bearDist },
        nearest_bull_fvg: Math.random() > 0.4 ? { type: "bull", distance_pct: +(Math.random() * -3).toFixed(2) } : null,
        nearest_bear_fvg: Math.random() > 0.4 ? { type: "bear", distance_pct: +(Math.random() * 3).toFixed(2) } : null,
        ema: {
          direction: cp > s.price * 0.998 ? "above" : "below",
          distance_pct: +((Math.random() - 0.3) * 2).toFixed(2),
          value: +(s.price * (1 - Math.random() * 0.01)).toFixed(2)
        }
      };

      if (tf === "15m") {
        const vr = +(0.5 + Math.random() * 2.5).toFixed(2);
        let vs;
        if (vr >= 3) vs = "EXTREME"; else if (vr >= 2) vs = "HIGH"; else if (vr >= 0.8) vs = "NORMAL";
        else if (vr >= 0.4) vs = "LOW"; else vs = "VERY LOW";
        tfs[tf].volume = { state: vs, ratio: vr, current_vol: 1250000, avg_vol: 800000 };
        tfs[tf].volatility = { state: "NORMAL", atr: 85.2, avg_atr: 78.4, ratio: 1.09 };
      }
    }

    const cp = s.price;
    allData[sym] = {
      symbol: sym,
      timeframes: tfs,
      htf_levels: {
        current_price: cp,
        prev_day: {
          high: s.pdh, low: s.pdl,
          high_dist: +((cp - s.pdh) / cp * 100).toFixed(2),
          low_dist: +((cp - s.pdl) / cp * 100).toFixed(2)
        },
        prev_week: {
          high: s.pwh, low: s.pwl,
          high_dist: +((cp - s.pwh) / cp * 100).toFixed(2),
          low_dist: +((cp - s.pwl) / cp * 100).toFixed(2)
        },
        prev_month: {
          high: s.pmh, low: s.pml,
          high_dist: +((cp - s.pmh) / cp * 100).toFixed(2),
          low_dist: +((cp - s.pml) / cp * 100).toFixed(2)
        }
      },
      trend_bias: computeTrendBias(tfs)
    };
  }

  document.getElementById("skeleton").style.display = "none";
  document.getElementById("panels").style.display = "flex";
  renderDashboard();
}
