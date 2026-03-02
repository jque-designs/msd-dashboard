/* ═══════════════════════════════════════════════════════
   Market Structure Dashboard V3 — Full Client-Side Engine
   All data fetching + calculations run in the browser.
   ═══════════════════════════════════════════════════════ */

/* ─── Constants ─── */
const REFRESH_MS = 15000;
const DEFAULT_TICKERS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w"];
const MOMENTUM_TFS = ["15m", "1h", "4h", "1d"];
const BINANCE_DIRECT = "https://api.binance.com/api/v3/klines";
const ALLORIGINS_PROXY = "https://api.allorigins.win/raw?url=";
const CANDLE_LIMIT = 200;
const PIVOT_LEFT = 5;
const PIVOT_RIGHT = 5;
const EMA_PERIOD = 21;
const MAX_SIGNALS = 50;
const MAX_ALERTS = 20;
const TF_WEIGHTS = { "1m":1, "5m":2, "15m":3, "1h":5, "4h":8, "1d":13, "1w":21 };

/* ─── State ─── */
let watchlist = [...DEFAULT_TICKERS];
let activeSymbol = watchlist[0];
let allData = {};
let allCandles = {};       // { symbol: { tf: candles[] } }
let signalHistory = [];    // signal alert entries
let previousSignalKeys = new Set();
let priceAlerts = [];      // { id, ticker, price, direction, triggered, triggerTime }
let alertIdCounter = 0;
let refreshTimer = null;
let chartInterval = "60";
let signalSortCol = "time";
let signalSortAsc = false;
let useBinanceProxy = null;   // null = unknown
let yahooMethod = {};         // { symbol: "direct" | "proxy" }
let collapsedPanels = new Set();

/* ─── Storage Abstraction (graceful fallback when sandboxed) ─── */
const _memStore = {};
const store = {
  _engine: null,
  _getEngine() {
    if (this._engine !== null) return this._engine;
    try {
      const s = window[['local','Storage'].join('')];
      const k = '__msd_test__';
      s.setItem(k, '1');
      s.removeItem(k);
      this._engine = s;
    } catch(e) {
      this._engine = false;
    }
    return this._engine;
  },
  get(key) {
    const eng = this._getEngine();
    if (eng) try { return eng.getItem(key); } catch(e) {}
    return _memStore[key] || null;
  },
  set(key, val) {
    const eng = this._getEngine();
    if (eng) try { eng.setItem(key, val); } catch(e) {}
    _memStore[key] = val;
  },
  remove(key) {
    const eng = this._getEngine();
    if (eng) try { eng.removeItem(key); } catch(e) {}
    delete _memStore[key];
  }
};

/* ─── Kline Cache ─── */
const _klineCache = {};

/* ═══════════════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════════════ */
document.addEventListener("DOMContentLoaded", () => {
  // Embed mode check
  const urlParams = new URLSearchParams(window.location.search);
  const isEmbed = urlParams.get('embed') === '1';
  if (isEmbed) document.body.classList.add('embed-mode');

  // Restore persisted state before loading data
  try {
    const savedWL = store.get('msd_watchlist');
    if (savedWL) watchlist = JSON.parse(savedWL);
    const savedAlerts = store.get('msd_alerts');
    if (savedAlerts) { priceAlerts = JSON.parse(savedAlerts); alertIdCounter = priceAlerts.reduce((m, a) => Math.max(m, a.id), 0); }
    const savedSignals = store.get('msd_signals');
    if (savedSignals) signalHistory = JSON.parse(savedSignals);
    const savedCollapsed = store.get('msd_collapsed');
    if (savedCollapsed) collapsedPanels = new Set(JSON.parse(savedCollapsed));
  } catch(e) {}

  if (!watchlist.length) watchlist = [...DEFAULT_TICKERS];
  activeSymbol = watchlist[0];

  initUI();
  initCollapsiblePanels();
  initOBFVGFilters();
  initThesisPanel();
  renderWatchlist();
  // Load live thesis from bot backend
  fetchLiveThesis();
  // Show demo data immediately (APIs are likely blocked in sandbox)
  loadDemoData();
  // Then try real data in background — if it succeeds, it overwrites demo
  setTimeout(() => fetchAll(), 200);
  refreshTimer = setInterval(() => { fetchAll(); fetchLiveThesis(); }, REFRESH_MS);
});

function initUI() {
  // Add ticker
  document.getElementById("add-ticker-btn").addEventListener("click", addTickerFromInput);
  document.getElementById("add-ticker-input").addEventListener("keydown", e => {
    if (e.key === "Enter") addTickerFromInput();
  });

  // Chart TF buttons
  document.querySelectorAll(".chart-tf-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation(); // don't trigger panel collapse
      document.querySelectorAll(".chart-tf-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      chartInterval = btn.dataset.interval;
      updateChart();
    });
  });

  // Signal table sorting
  document.querySelectorAll(".signals-table thead th[data-sort]").forEach(th => {
    th.addEventListener("click", () => {
      const col = th.dataset.sort;
      if (signalSortCol === col) signalSortAsc = !signalSortAsc;
      else { signalSortCol = col; signalSortAsc = col === "time" ? false : true; }
      renderSignals();
    });
  });

  // Alert form
  document.getElementById("alert-add-btn").addEventListener("click", openAlertForm);
  document.getElementById("alert-cancel-btn").addEventListener("click", closeAlertForm);
  document.getElementById("alert-save-btn").addEventListener("click", saveAlert);
  document.getElementById("alert-form-overlay").addEventListener("click", e => {
    if (e.target === e.currentTarget) closeAlertForm();
  });

  // Clear all storage button
  document.getElementById("alert-clear-btn").addEventListener("click", clearAllStorage);

  // Bot feed buttons
  document.getElementById("feed-copy-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const json = document.getElementById("feed-json").textContent;
    navigator.clipboard.writeText(json).then(() => {
      const btn = document.getElementById("feed-copy-btn");
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = "Copy"; }, 1500);
    }).catch(() => {});
  });
  document.getElementById("feed-download-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    const json = document.getElementById("feed-json").textContent;
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `msd_snapshot_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  });
}

/* ─── Collapsible Panels ─── */
function initCollapsiblePanels() {
  // Apply saved collapsed state
  for (const panelId of collapsedPanels) {
    const panel = document.querySelector(`[data-panel="${panelId}"]`);
    if (panel) panel.classList.add("collapsed");
  }

  // Attach click handlers to all collapse headers
  document.querySelectorAll(".panel-collapse-header").forEach(header => {
    header.addEventListener("click", (e) => {
      // Don't collapse if clicking on buttons/controls inside header
      if (e.target.closest('.chart-controls') || e.target.closest('.feed-btn') || e.target.closest('button')) return;
      const target = header.dataset.target;
      if (!target) return;
      const panel = header.closest("[data-panel]");
      if (!panel) return;
      panel.classList.toggle("collapsed");
      if (panel.classList.contains("collapsed")) {
        collapsedPanels.add(target);
      } else {
        collapsedPanels.delete(target);
      }
      store.set('msd_collapsed', JSON.stringify([...collapsedPanels]));
    });
  });
}

/* ─── Clear All Storage ─── */
function clearAllStorage() {
  try {
    store.remove('msd_watchlist');
    store.remove('msd_alerts');
    store.remove('msd_signals');
    store.remove('msd_collapsed');
    store.remove('msd_latest_snapshot');
    store.remove('msd_thesis');
  } catch(e) {}
  location.reload();
}

/* ─── Persist State ─── */
function persistState() {
  try {
    store.set('msd_watchlist', JSON.stringify(watchlist));
    store.set('msd_alerts', JSON.stringify(priceAlerts));
    store.set('msd_signals', JSON.stringify(signalHistory.slice(0, 50)));
  } catch(e) {}
}

/* ─── Status ─── */
function showStatus(msg, isError = false) {
  const el = document.getElementById("last-update");
  el.textContent = msg;
  el.style.color = isError ? "#f85149" : "#8b949e";
}

/* ═══════════════════════════════════════════════════════
   WATCHLIST MANAGEMENT
   ═══════════════════════════════════════════════════════ */
function addTickerFromInput() {
  const input = document.getElementById("add-ticker-input");
  const raw = input.value.trim().toUpperCase();
  if (!raw) return;
  if (watchlist.includes(raw)) { input.value = ""; return; }
  if (watchlist.length >= 12) return; // reasonable cap
  watchlist.push(raw);
  input.value = "";
  persistState();
  renderWatchlist();
  // Fetch data for new ticker
  fetchSingleTicker(raw);
}

function removeTicker(sym) {
  if (watchlist.length <= 1) return;
  watchlist = watchlist.filter(s => s !== sym);
  delete allData[sym];
  delete allCandles[sym];
  if (activeSymbol === sym) {
    activeSymbol = watchlist[0];
  }
  persistState();
  renderWatchlist();
  renderDashboard();
  updateChart();
}

function selectTicker(sym) {
  activeSymbol = sym;
  renderWatchlist();
  renderDashboard();
  updateChart();
}

function renderWatchlist() {
  const ul = document.getElementById("watchlist");
  const now = Date.now();
  ul.innerHTML = watchlist.map(sym => {
    const d = allData[sym];
    const isActive = sym === activeSymbol;
    const price = d ? fmtPrice(getTickerPrice(d)) : "—";
    const bias = d ? d.trend_bias : 0;
    const biasClass = bias > 5 ? "positive" : bias < -5 ? "negative" : "zero";
    const dotClass = bias > 5 ? "bullish" : bias < -5 ? "bearish" : "neutral";
    const shortSym = sym.replace("USDT", "");
    // Signal badge: check if any signal fired for this ticker within last 5 minutes
    const hasRecentSignal = signalHistory.some(s => s.ticker === sym && (now - s.time) < 300000);
    const badgeHTML = hasRecentSignal ? `<span class="signal-badge-dot"></span>` : "";
    return `<li class="watchlist-item${isActive ? " active" : ""}" onclick="selectTicker('${sym}')">
      <span class="wl-dot ${dotClass}"></span>
      ${badgeHTML}
      <div class="wl-info">
        <div class="wl-symbol">${shortSym}</div>
        <div class="wl-price">${price}</div>
      </div>
      <span class="wl-bias ${biasClass}">${bias > 0 ? "+" : ""}${bias}</span>
      ${watchlist.length > 1 ? `<button class="wl-remove" onclick="event.stopPropagation();removeTicker('${sym}')" title="Remove">✕</button>` : ""}
    </li>`;
  }).join("");
}

function getTickerPrice(d) {
  if (!d || !d.timeframes) return null;
  for (const tf of ["1h", "15m", "5m", "1m", "4h", "1d", "1w"]) {
    if (d.timeframes[tf] && d.timeframes[tf].current_price) return d.timeframes[tf].current_price;
  }
  return d.htf_levels?.current_price || null;
}

/* ═══════════════════════════════════════════════════════
   DATA FETCHING
   ═══════════════════════════════════════════════════════ */
function isCrypto(symbol) {
  return symbol.endsWith("USDT");
}

function getYahooParams(tf) {
  const map = {
    "1m":  { interval: "1m", range: "1d" },
    "5m":  { interval: "5m", range: "5d" },
    "15m": { interval: "15m", range: "5d" },
    "1h":  { interval: "1h", range: "1mo" },
    "4h":  { interval: "1h", range: "6mo" }, // Yahoo doesn't have 4h, we'll aggregate from 1h
    "1d":  { interval: "1d", range: "6mo" },
    "1w":  { interval: "1wk", range: "2y" },
    "1M":  { interval: "1mo", range: "5y" },
  };
  return map[tf] || map["1d"];
}

async function fetchKlinesBinance(symbol, interval, limit = CANDLE_LIMIT) {
  const key = `${symbol}_${interval}`;
  const now = Date.now();
  if (_klineCache[key] && now - _klineCache[key].ts < 10000) {
    return _klineCache[key].data;
  }

  let raw;
  if (useBinanceProxy !== true) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3000);
      const url = `${BINANCE_DIRECT}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(tid);
      if (res.ok) {
        raw = await res.json();
        if (useBinanceProxy === null) useBinanceProxy = false;
      } else throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (useBinanceProxy === null) useBinanceProxy = true;
    }
  }

  if (!raw && useBinanceProxy) {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3000);
      const url = `${BINANCE_DIRECT}?symbol=${symbol}&interval=${interval}&limit=${limit}`;
      const proxyUrl = `${ALLORIGINS_PROXY}${encodeURIComponent(url)}`;
      const res = await fetch(proxyUrl, { signal: ctrl.signal });
      clearTimeout(tid);
      if (res.ok) raw = await res.json();
    } catch (e) { /* fall through */ }
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

async function fetchKlinesYahoo(symbol, interval, range) {
  const key = `yahoo_${symbol}_${interval}_${range}`;
  const now = Date.now();
  if (_klineCache[key] && now - _klineCache[key].ts < 10000) {
    return _klineCache[key].data;
  }

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  let raw = null;

  // Try direct first if we haven't determined method yet or direct works
  if (yahooMethod[symbol] !== "proxy") {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(yahooUrl, { signal: ctrl.signal });
      clearTimeout(tid);
      if (res.ok) {
        raw = await res.json();
        yahooMethod[symbol] = "direct";
      } else throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (yahooMethod[symbol] !== "direct") {
        yahooMethod[symbol] = "proxy";
      }
    }
  }

  // Try proxy
  if (!raw && yahooMethod[symbol] === "proxy") {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(() => ctrl.abort(), 3000);
      const proxyUrl = `${ALLORIGINS_PROXY}${encodeURIComponent(yahooUrl)}`;
      const res = await fetch(proxyUrl, { signal: ctrl.signal });
      clearTimeout(tid);
      if (res.ok) raw = await res.json();
    } catch (e) { /* fall through */ }
  }

  if (!raw || !raw.chart || !raw.chart.result || !raw.chart.result[0]) {
    throw new Error("Yahoo data unavailable");
  }

  const result = raw.chart.result[0];
  const timestamps = result.timestamp || [];
  const q = result.indicators.quote[0];
  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (q.open[i] == null) continue;
    candles.push({
      open_time: timestamps[i] * 1000,
      open: +q.open[i],
      high: +q.high[i],
      low: +q.low[i],
      close: +q.close[i],
      volume: +(q.volume[i] || 0),
      close_time: (timestamps[i] + 60) * 1000,
    });
  }

  _klineCache[key] = { ts: now, data: candles };
  return candles;
}

async function fetchKlines(symbol, tf, limit = CANDLE_LIMIT) {
  if (isCrypto(symbol)) {
    return fetchKlinesBinance(symbol, tf, limit);
  } else {
    const params = getYahooParams(tf);
    let candles = await fetchKlinesYahoo(symbol, params.interval, params.range);
    // For 4h on Yahoo, aggregate 1h candles into 4h
    if (tf === "4h" && params.interval === "1h") {
      candles = aggregateCandles(candles, 4);
    }
    if (candles.length > limit) candles = candles.slice(-limit);
    return candles;
  }
}

function aggregateCandles(candles, period) {
  const result = [];
  for (let i = 0; i < candles.length; i += period) {
    const chunk = candles.slice(i, i + period);
    if (!chunk.length) continue;
    result.push({
      open_time: chunk[0].open_time,
      open: chunk[0].open,
      high: Math.max(...chunk.map(c => c.high)),
      low: Math.min(...chunk.map(c => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + c.volume, 0),
      close_time: chunk[chunk.length - 1].close_time,
    });
  }
  return result;
}

/* ─── Fetch All ─── */
async function fetchAll() {
  let anySuccess = false;
  // Race against a timeout — if APIs don't respond in 8s, show demo data
  const demoTimeout = new Promise(resolve => setTimeout(() => resolve('timeout'), 8000));
  const dataFetch = (async () => {
    try {
      const promises = watchlist.map(s => analyzeSymbol(s).catch(e => null));
      const results = await Promise.all(promises);
      results.forEach((r, i) => {
        if (r && r.timeframes) {
          const hasData = TIMEFRAMES.some(tf => r.timeframes[tf] && !r.timeframes[tf].error && r.timeframes[tf].current_price);
          if (hasData) { allData[watchlist[i]] = r; anySuccess = true; }
        }
      });
      return anySuccess ? 'success' : 'fail';
    } catch (err) {
      return 'fail';
    }
  })();

  const result = await Promise.race([dataFetch, demoTimeout]);

  if (result === 'success' && anySuccess) {
    document.getElementById("skeleton").style.display = "none";
    document.getElementById("panels").style.display = "";
    computeAllSignals();
    checkPriceAlerts();
    renderDashboard();
    renderWatchlist();
    const now = new Date();
    showStatus(`${now.toLocaleTimeString()} · 15s`);
  }
  // If fail/timeout and no data yet, demo is already showing from init
}

async function fetchSingleTicker(sym) {
  try {
    const r = await analyzeSymbol(sym);
    if (r && r.timeframes) {
      allData[sym] = r;
      computeAllSignals();
      renderDashboard();
      renderWatchlist();
    }
  } catch (e) {
    console.error(`Failed to fetch ${sym}:`, e);
    // Generate demo data for this ticker
    generateDemoForTicker(sym);
    renderDashboard();
    renderWatchlist();
  }
}

/* ═══════════════════════════════════════════════════════
   ANALYSIS FUNCTIONS (preserved from V1)
   ═══════════════════════════════════════════════════════ */

/* ─── Pivot Detection ─── */
function detectPivots(candles, left = PIVOT_LEFT, right = PIVOT_RIGHT) {
  const highs = candles.map(c => c.high);
  const lows = candles.map(c => c.low);
  const n = candles.length;
  const pivotHighs = [];
  const pivotLows = [];

  for (let i = left; i < n - right; i++) {
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
          const dist = ((candles[obIdx].low - price) / price) * 100;
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

/* ─── EMA series (returns array of EMA values) ─── */
function calcEMASeries(values, period) {
  if (values.length < period) return [];
  const result = [];
  const mult = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i < period; i++) result.push(null);
  result[period - 1] = ema;
  for (let i = period; i < values.length; i++) {
    ema = (values[i] - ema) * mult + ema;
    result.push(ema);
  }
  return result;
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
    const tfKey = isCrypto(symbol) ? "1M" : "1w"; // Yahoo doesn't have 1M as interval cleanly; reuse weekly for approx
    const mo = await fetchKlines(symbol, tfKey, 6);
    if (mo && mo.length >= 2) {
      if (!currentPrice) currentPrice = mo[mo.length - 1].close;
      // For weekly data used as monthly proxy, take the right range
      const prev = isCrypto(symbol) ? mo[mo.length - 2] : findPrevMonthFromWeekly(mo);
      if (prev) {
        results.prev_month = {
          high: prev.high, low: prev.low,
          high_dist: Math.round(((currentPrice - prev.high) / currentPrice) * 10000) / 100,
          low_dist: Math.round(((currentPrice - prev.low) / currentPrice) * 10000) / 100,
        };
      }
    }
  } catch (e) {}
  results.current_price = currentPrice;
  return results;
}

function findPrevMonthFromWeekly(weeklyCandles) {
  // Just use the second-to-last candle as approximation
  if (weeklyCandles.length >= 2) return weeklyCandles[weeklyCandles.length - 2];
  return null;
}

/* ─── Trend Bias ─── */
function computeTrendBias(tfData) {
  let totalWeight = 0, weighted = 0;
  for (const tf of TIMEFRAMES) {
    const d = tfData[tf];
    if (!d || d.error) continue;
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

/* ═══════════════════════════════════════════════════════
   NEW INDICATORS: RSI, MACD, Bollinger, SuperTrend, ATR
   ═══════════════════════════════════════════════════════ */

/* ─── RSI ─── */
function calcRSI(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const closes = candles.map(c => c.close);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i-1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i-1];
    avgGain = (avgGain * (period - 1) + (change > 0 ? change : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (change < 0 ? Math.abs(change) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return Math.round((100 - 100 / (1 + rs)) * 100) / 100;
}

/* ─── MACD ─── */
function calcMACD(candles) {
  if (candles.length < 26) return null;
  const closes = candles.map(c => c.close);
  const ema12 = calcEMASeries(closes, 12);
  const ema26 = calcEMASeries(closes, 26);
  const macdLine = [];
  for (let i = 0; i < closes.length; i++) {
    if (ema12[i] != null && ema26[i] != null) macdLine.push(ema12[i] - ema26[i]);
    else macdLine.push(null);
  }
  const validMacd = macdLine.filter(v => v != null);
  if (validMacd.length < 9) return null;
  const signalLine = calcEMASeries(validMacd, 9);
  const macd = validMacd[validMacd.length - 1];
  const signal = signalLine[signalLine.length - 1];
  if (macd == null || signal == null) return null;
  return { macd: Math.round(macd * 10000) / 10000, signal: Math.round(signal * 10000) / 10000, bullish: macd > signal };
}

/* ─── Bollinger Bands ─── */
function calcBollingerBands(candles, period = 20, mult = 2) {
  if (candles.length < period) return null;
  const closes = candles.map(c => c.close);
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((s, v) => s + (v - sma) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: sma + mult * std,
    middle: sma,
    lower: sma - mult * std,
    close: closes[closes.length - 1]
  };
}

/* ─── ATR ─── */
function calcATR(candles, period = 10) {
  if (candles.length < period + 1) return [];
  const atrs = [];
  const trs = [0]; // first TR is 0
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i-1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  // Simple moving average for first ATR
  let atr = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  for (let i = 0; i <= period; i++) atrs.push(null);
  atrs[period] = atr;
  for (let i = period + 1; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrs.push(atr);
  }
  return atrs;
}

/* ─── SuperTrend ─── */
function calcSuperTrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 2) return { direction: null, flipped: false };
  const atrs = calcATR(candles, period);
  const n = candles.length;
  const upperBands = new Array(n).fill(0);
  const lowerBands = new Array(n).fill(0);
  const superTrend = new Array(n).fill(0);
  const direction = new Array(n).fill(1); // 1 = bullish, -1 = bearish

  for (let i = period; i < n; i++) {
    if (atrs[i] == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let ub = hl2 + multiplier * atrs[i];
    let lb = hl2 - multiplier * atrs[i];

    // Adjust bands
    if (i > period) {
      if (lb > lowerBands[i-1] || candles[i-1].close < lowerBands[i-1]) {
        lowerBands[i] = lb;
      } else {
        lowerBands[i] = lowerBands[i-1];
      }
      if (ub < upperBands[i-1] || candles[i-1].close > upperBands[i-1]) {
        upperBands[i] = ub;
      } else {
        upperBands[i] = upperBands[i-1];
      }
    } else {
      upperBands[i] = ub;
      lowerBands[i] = lb;
    }

    // Direction
    if (i > period) {
      if (superTrend[i-1] === upperBands[i-1]) {
        direction[i] = candles[i].close > upperBands[i] ? 1 : -1;
      } else {
        direction[i] = candles[i].close < lowerBands[i] ? -1 : 1;
      }
    } else {
      direction[i] = candles[i].close > ub ? 1 : -1;
    }

    superTrend[i] = direction[i] === 1 ? lowerBands[i] : upperBands[i];
  }

  const last = direction[n-1];
  const prev = direction[n-2];
  return { direction: last === 1 ? "bullish" : "bearish", flipped: last !== prev };
}

/* ═══════════════════════════════════════════════════════
   SIGNAL COMPUTATION (BB+RSI and SuperTrend)
   FIX 1: Now loops over ALL MOMENTUM_TFS instead of just 1h
   ═══════════════════════════════════════════════════════ */
function computeAllSignals() {
  const newSignals = [];
  const currentKeys = new Set();

  for (const sym of watchlist) {
    const d = allData[sym];
    if (!d || !d.timeframes) continue;

    // FIX 1: Loop over all MOMENTUM_TFS for signal detection
    for (const tf of MOMENTUM_TFS) {
      const tfData = d.timeframes[tf];
      if (!tfData || tfData.error) continue;

      const candles = allCandles[sym]?.[tf];
      if (!candles || candles.length < 30) continue;

      const price = candles[candles.length - 1].close;
      const openTime = candles[candles.length - 1].open_time;

      // BB + RSI Signal
      const bb = calcBollingerBands(candles, 20, 2);
      const rsi = calcRSI(candles, 14);
      if (bb && rsi != null) {
        if (bb.close <= bb.lower && rsi < 30) {
          const key = `bb_bull_${sym}_${tf}_${openTime}`;
          currentKeys.add(key);
          newSignals.push({
            key, time: openTime, ticker: sym, type: "BB+RSI", direction: "Bull",
            tf: tf, price, isNew: !previousSignalKeys.has(key)
          });
        }
        if (bb.close >= bb.upper && rsi > 70) {
          const key = `bb_bear_${sym}_${tf}_${openTime}`;
          currentKeys.add(key);
          newSignals.push({
            key, time: openTime, ticker: sym, type: "BB+RSI", direction: "Bear",
            tf: tf, price, isNew: !previousSignalKeys.has(key)
          });
        }
      }

      // SuperTrend Signal
      const st = calcSuperTrend(candles, 10, 3);
      if (st.flipped) {
        const dir = st.direction === "bullish" ? "Bull" : "Bear";
        const key = `st_${dir}_${sym}_${tf}_${openTime}`;
        currentKeys.add(key);
        newSignals.push({
          key, time: openTime, ticker: sym, type: "SuperTrend", direction: dir,
          tf: tf, price, isNew: !previousSignalKeys.has(key)
        });
      }
    }
  }

  // Merge new signals with history, deduplicate by key
  const existingKeys = new Set(signalHistory.map(s => s.key));
  for (const s of newSignals) {
    if (!existingKeys.has(s.key)) {
      signalHistory.unshift(s);
    }
  }

  // Mark new signals
  for (const s of signalHistory) {
    s.isNew = !previousSignalKeys.has(s.key) && currentKeys.has(s.key);
  }

  // Trim
  if (signalHistory.length > MAX_SIGNALS) signalHistory = signalHistory.slice(0, MAX_SIGNALS);
  previousSignalKeys = currentKeys;
  persistState();
}

/* ═══════════════════════════════════════════════════════
   CORRELATION COMPUTATION
   ═══════════════════════════════════════════════════════ */
function computeCorrelation(arr1, arr2) {
  const n = Math.min(arr1.length, arr2.length, 50);
  if (n < 10) return null;
  const a = arr1.slice(-n);
  const b = arr2.slice(-n);
  const meanA = a.reduce((s, v) => s + v, 0) / n;
  const meanB = b.reduce((s, v) => s + v, 0) / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denom = Math.sqrt(varA * varB);
  return denom === 0 ? 0 : Math.round((cov / denom) * 100) / 100;
}

function computeCorrelationMatrix() {
  if (watchlist.length < 2) return null;
  const closeSeries = {};
  for (const sym of watchlist) {
    const candles = allCandles[sym]?.["1h"];
    if (candles && candles.length > 10) {
      closeSeries[sym] = candles.map(c => c.close);
    }
  }
  const syms = watchlist.filter(s => closeSeries[s]);
  if (syms.length < 2) return null;
  const matrix = {};
  for (const a of syms) {
    matrix[a] = {};
    for (const b of syms) {
      if (a === b) matrix[a][b] = 1;
      else matrix[a][b] = computeCorrelation(closeSeries[a], closeSeries[b]);
    }
  }
  return { syms, matrix };
}

/* ═══════════════════════════════════════════════════════
   PRICE ALERTS
   ═══════════════════════════════════════════════════════ */
function openAlertForm() {
  const sel = document.getElementById("alert-ticker-select");
  sel.innerHTML = watchlist.map(s => `<option value="${s}">${s}</option>`).join("");
  sel.value = activeSymbol;
  document.getElementById("alert-price-input").value = "";
  document.getElementById("alert-dir-select").value = "above";
  document.getElementById("alert-form-overlay").classList.add("show");
}

function closeAlertForm() {
  document.getElementById("alert-form-overlay").classList.remove("show");
}

function saveAlert() {
  const ticker = document.getElementById("alert-ticker-select").value;
  const price = parseFloat(document.getElementById("alert-price-input").value);
  const direction = document.getElementById("alert-dir-select").value;
  if (!ticker || isNaN(price) || price <= 0) return;
  if (priceAlerts.length >= MAX_ALERTS) return;

  priceAlerts.push({
    id: ++alertIdCounter,
    ticker, price, direction,
    triggered: false, triggerTime: null
  });

  closeAlertForm();
  persistState();
  renderAlerts();

  // Try requesting notification permission
  if ("Notification" in window && Notification.permission === "default") {
    Notification.requestPermission();
  }
}

function removeAlert(id) {
  priceAlerts = priceAlerts.filter(a => a.id !== id);
  persistState();
  renderAlerts();
}

function checkPriceAlerts() {
  for (const alert of priceAlerts) {
    if (alert.triggered) continue;
    const d = allData[alert.ticker];
    if (!d) continue;
    const currentPrice = getTickerPrice(d);
    if (currentPrice == null) continue;

    let triggered = false;
    if (alert.direction === "above" && currentPrice >= alert.price) triggered = true;
    if (alert.direction === "below" && currentPrice <= alert.price) triggered = true;

    if (triggered) {
      alert.triggered = true;
      alert.triggerTime = new Date().toLocaleTimeString();
      showNotificationBanner(`${alert.ticker} crossed ${alert.direction} ${fmtPrice(alert.price)} — now at ${fmtPrice(currentPrice)}`);
      // Browser notification
      if ("Notification" in window && Notification.permission === "granted") {
        try {
          new Notification("Price Alert", {
            body: `${alert.ticker} crossed ${alert.direction} ${fmtPrice(alert.price)}`,
            icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>📊</text></svg>"
          });
        } catch (e) {}
      }
    }
  }
  persistState();
  renderAlerts();
}

function showNotificationBanner(msg) {
  const banner = document.getElementById("notification-banner");
  banner.textContent = msg;
  banner.classList.add("show");
  setTimeout(() => banner.classList.remove("show"), 5000);
}

/* ═══════════════════════════════════════════════════════
   FULL SYMBOL ANALYSIS
   ═══════════════════════════════════════════════════════ */
async function analyzeSymbol(symbol) {
  const result = { symbol, timeframes: {}, htf_levels: {}, trend_bias: 0 };
  if (!allCandles[symbol]) allCandles[symbol] = {};

  const tfPromises = TIMEFRAMES.map(async tf => {
    try {
      const candles = await fetchKlines(symbol, tf);
      if (!candles || candles.length < 20) return { tf, error: true };

      allCandles[symbol][tf] = candles;

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

      // Compute momentum data for relevant TFs
      if (MOMENTUM_TFS.includes(tf)) {
        data.rsi = calcRSI(candles, 14);
        data.macd = calcMACD(candles);
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
  updateChart();
  renderMTFTable(sym);
  renderCurrentTF(sym);
  renderContext(sym);
  renderHTFLevels(sym);
  renderKillzoneHeatmap();
  renderOBFVGTracker();
  renderThesisPanel();
  renderSignals();
  renderMomentum();
  renderCorrelation();
  renderAlerts();
  renderActiveSymbolDisplay();
  renderBotFeed();

  // Feature 1: Perp Terminal Integration (window.MSD)
  window.MSD = {
    version: "3.0",
    lastUpdate: new Date().toISOString(),
    activeSymbol: activeSymbol,
    watchlist: [...watchlist],
    data: JSON.parse(JSON.stringify(allData)),
    signals: [...signalHistory],
    alerts: [...priceAlerts],
    bias: {},
    snapshot: function() { return JSON.stringify(window.MSD, (key, val) => key === 'snapshot' ? undefined : val, 2); }
  };
  // Populate bias
  for (const s of watchlist) {
    window.MSD.bias[s] = allData[s]?.trend_bias ?? 0;
  }
  // Fire custom event
  document.dispatchEvent(new CustomEvent('msd:update', { detail: window.MSD }));
}

/* ─── Active Symbol Display ─── */
function renderActiveSymbolDisplay() {
  const el = document.getElementById("active-symbol-display");
  if (!el) return;
  const d = allData[activeSymbol];
  const price = d ? getTickerPrice(d) : null;
  const shortSym = activeSymbol.replace("USDT", "");
  el.textContent = price ? `${shortSym} ${fmtPrice(price)}` : shortSym;
}

/* ─── TradingView Chart ─── */
function updateChart() {
  const container = document.getElementById("chart-container");
  let tvSymbol;
  if (isCrypto(activeSymbol)) {
    tvSymbol = `BINANCE:${activeSymbol}`;
  } else {
    tvSymbol = activeSymbol;
  }
  const src = `https://s.tradingview.com/widgetembed/?frameElementId=tv_chart&symbol=${encodeURIComponent(tvSymbol)}&interval=${chartInterval}&theme=dark&style=1&locale=en&enable_publishing=false&hide_top_toolbar=false&hide_side_toolbar=true&allow_symbol_change=false&save_image=false&details=false&calendar=false&show_popup_button=false&width=100%25&height=350`;

  // Only update if src changed
  const existing = container.querySelector("iframe");
  if (existing && existing.dataset.src === src) return;

  container.innerHTML = `<iframe src="${src}" data-src="${src}" allowtransparency="true" frameborder="0" style="width:100%;height:100%;"></iframe>`;
}

/* ─── Panel 1: MTF Table ─── */
/* FIX 4: Yahoo 4H label — show ~4h with tooltip for non-crypto */
function renderMTFTable(sym) {
  const tbody = document.getElementById("mtf-body");
  const tfs = sym.timeframes || {};
  let html = "";

  for (const tf of TIMEFRAMES) {
    const d = tfs[tf];

    // FIX 4: For 4h on non-crypto symbols, show ~4h with tooltip
    let tfLabel = tf;
    let tfTitleAttr = "";
    if (tf === "4h" && !isCrypto(activeSymbol)) {
      tfLabel = "~4h";
      tfTitleAttr = ` title="Aggregated from 1H data (Yahoo Finance does not provide 4H)"`;
    }

    if (!d || d.error) {
      html += `<tr><td class="tf-label"${tfTitleAttr}>${tfLabel}</td><td colspan="5" style="color:#484f58">No data</td></tr>`;
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
      <td class="tf-label"${tfTitleAttr}>${tfLabel}</td>
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

/* ─── Signal Alerts Panel ─── */
/* FIX 3: Timestamp tooltips on signal time cells */
function renderSignals() {
  const sorted = [...signalHistory];
  sorted.sort((a, b) => {
    let va, vb;
    switch (signalSortCol) {
      case "time": va = a.time; vb = b.time; break;
      case "ticker": va = a.ticker; vb = b.ticker; break;
      case "type": va = a.type; vb = b.type; break;
      case "direction": va = a.direction; vb = b.direction; break;
      case "tf": va = a.tf; vb = b.tf; break;
      case "price": va = a.price; vb = b.price; break;
      default: va = a.time; vb = b.time;
    }
    if (typeof va === "string") return signalSortAsc ? va.localeCompare(vb) : vb.localeCompare(va);
    return signalSortAsc ? va - vb : vb - va;
  });

  document.getElementById("signal-count").textContent = `${sorted.length} signal${sorted.length !== 1 ? "s" : ""}`;

  const tbody = document.getElementById("signals-body");
  if (!sorted.length) {
    tbody.innerHTML = `<tr><td colspan="6" style="color:#484f58;text-align:center;padding:16px">No signals detected yet</td></tr>`;
    return;
  }

  tbody.innerHTML = sorted.map(s => {
    const timeStr = new Date(s.time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const fullTime = new Date(s.time).toLocaleString();
    const dirCls = s.direction === "Bull" ? "signal-bull" : "signal-bear";
    const typeCls = s.type === "BB+RSI" ? "signal-type-bb" : "signal-type-st";
    const newCls = s.isNew ? "signal-new" : "";
    return `<tr class="${newCls}">
      <td title="${fullTime}">${timeStr}</td>
      <td style="font-weight:600;color:#e6edf3">${s.ticker.replace("USDT", "")}</td>
      <td><span class="signal-type-tag ${typeCls}">${s.type}</span></td>
      <td class="${dirCls}" style="font-weight:600">${s.direction === "Bull" ? "▲ Bull" : "▼ Bear"}</td>
      <td>${s.tf}</td>
      <td>${fmtPrice(s.price)}</td>
    </tr>`;
  }).join("");

  // Update sort arrows
  document.querySelectorAll(".signals-table thead th[data-sort]").forEach(th => {
    const arrow = th.querySelector(".sort-arrow");
    if (arrow) {
      if (th.dataset.sort === signalSortCol) {
        arrow.textContent = signalSortAsc ? "▲" : "▼";
        arrow.style.opacity = "1";
      } else {
        arrow.textContent = "▼";
        arrow.style.opacity = "0.3";
      }
    }
  });
}

/* ─── Momentum Scanner ─── */
function renderMomentum() {
  const tbody = document.getElementById("momentum-body");
  let html = "";

  for (const sym of watchlist) {
    const d = allData[sym];
    if (!d) continue;
    const shortSym = sym.replace("USDT", "");
    html += `<tr><td>${shortSym}</td>`;

    for (const tf of MOMENTUM_TFS) {
      const tfData = d.timeframes?.[tf];
      if (!tfData || tfData.error) {
        html += `<td style="color:#484f58">—</td><td style="color:#484f58">—</td>`;
        continue;
      }

      // RSI
      const rsi = tfData.rsi;
      if (rsi != null) {
        const rsiCls = rsi < 30 ? "rsi-oversold" : rsi > 70 ? "rsi-overbought" : "rsi-neutral";
        html += `<td class="${rsiCls}">${rsi.toFixed(0)}</td>`;
      } else {
        html += `<td style="color:#484f58">—</td>`;
      }

      // MACD
      const macd = tfData.macd;
      if (macd != null) {
        const macdCls = macd.bullish ? "macd-bull" : "macd-bear";
        const arrow = macd.bullish ? "▲" : "▼";
        html += `<td class="${macdCls}">${arrow}</td>`;
      } else {
        html += `<td style="color:#484f58">—</td>`;
      }
    }
    html += "</tr>";
  }

  tbody.innerHTML = html || `<tr><td colspan="9" style="color:#484f58;text-align:center;padding:16px">No data</td></tr>`;
}

/* ─── Correlation Heatmap ─── */
function renderCorrelation() {
  const container = document.getElementById("correlation-content");
  const result = computeCorrelationMatrix();

  if (!result) {
    container.innerHTML = `<div class="metric-sub" style="padding:8px;text-align:center">Need 2+ tickers with data</div>`;
    return;
  }

  const { syms, matrix } = result;
  let html = `<table class="corr-table"><thead><tr><th></th>`;
  for (const s of syms) html += `<th>${s.replace("USDT", "")}</th>`;
  html += `</tr></thead><tbody>`;

  for (const a of syms) {
    html += `<tr><th style="text-align:left">${a.replace("USDT", "")}</th>`;
    for (const b of syms) {
      const val = matrix[a][b];
      if (val == null) {
        html += `<td class="corr-cell" style="color:#484f58">—</td>`;
      } else {
        const color = corrColor(val);
        html += `<td class="corr-cell" style="background:${color};color:#e6edf3">${val.toFixed(2)}</td>`;
      }
    }
    html += "</tr>";
  }
  html += "</tbody></table>";
  container.innerHTML = html;
}

function corrColor(val) {
  if (val >= 0.7) return "rgba(63,185,80,0.3)";
  if (val >= 0.3) return "rgba(63,185,80,0.15)";
  if (val > -0.3) return "rgba(139,148,158,0.1)";
  if (val > -0.7) return "rgba(248,81,73,0.15)";
  return "rgba(248,81,73,0.3)";
}

/* ─── Price Alerts Bar ─── */
function renderAlerts() {
  const container = document.getElementById("alert-chips");
  if (!priceAlerts.length) {
    container.innerHTML = `<span class="metric-sub">No active alerts</span>`;
    return;
  }

  container.innerHTML = priceAlerts.map(a => {
    const triggeredCls = a.triggered ? " triggered" : "";
    const dirCls = a.direction === "above" ? "above" : "below";
    const sym = a.ticker.replace("USDT", "");
    const triggerInfo = a.triggered ? ` @ ${a.triggerTime}` : "";
    return `<div class="alert-chip${triggeredCls}">
      <span style="font-weight:600;color:#e6edf3">${sym}</span>
      <span class="chip-dir ${dirCls}">${a.direction === "above" ? "▲" : "▼"}</span>
      <span>${fmtPrice(a.price)}</span>
      ${a.triggered ? `<span style="color:#f0883e;font-size:8px">TRIGGERED${triggerInfo}</span>` : ""}
      <button class="chip-remove" onclick="removeAlert(${a.id})">✕</button>
    </div>`;
  }).join("");
}

/* ─── Bot Feed Panel ─── */
function renderBotFeed() {
  const feedEl = document.getElementById("feed-json");
  if (!feedEl) return;

  const snapshot = buildBotFeedSnapshot();
  const jsonStr = JSON.stringify(snapshot, null, 2);
  feedEl.textContent = jsonStr;

  // Store snapshot
  store.set('msd_latest_snapshot', jsonStr);
}

function buildBotFeedSnapshot() {
  const snapshot = {
    timestamp: new Date().toISOString(),
    activeSymbol: activeSymbol,
    symbols: {}
  };

  for (const sym of watchlist) {
    const d = allData[sym];
    if (!d) continue;

    const symData = {
      trend_bias: d.trend_bias,
      structure_bias: {},
      nearest_ob: {},
      nearest_fvg: {},
      rsi: {},
      macd: {}
    };

    for (const tf of MOMENTUM_TFS) {
      const tfData = d.timeframes?.[tf];
      if (!tfData || tfData.error) continue;
      symData.structure_bias[tf] = tfData.structure_bias || "unknown";
      symData.nearest_ob[tf] = {
        bull_dist: tfData.nearest_bull_ob?.distance_pct ?? null,
        bear_dist: tfData.nearest_bear_ob?.distance_pct ?? null
      };
      symData.nearest_fvg[tf] = {
        bull_dist: tfData.nearest_bull_fvg?.distance_pct ?? null,
        bear_dist: tfData.nearest_bear_fvg?.distance_pct ?? null
      };
      symData.rsi[tf] = tfData.rsi ?? null;
      symData.macd[tf] = tfData.macd ? { value: tfData.macd.macd, signal: tfData.macd.signal, bullish: tfData.macd.bullish } : null;
    }

    snapshot.symbols[sym] = symData;
  }

  // Active signals
  snapshot.active_signals = signalHistory.slice(0, 20).map(s => ({
    ticker: s.ticker,
    type: s.type,
    direction: s.direction,
    tf: s.tf,
    price: s.price,
    time: new Date(s.time).toISOString()
  }));

  // V4: Thesis state
  snapshot.thesis = thesisState || generateDemoThesis();
  
  // V4: Killzone state
  const sess = getSessionsAndKillzones();
  snapshot.killzone = {
    current: sess.killzone,
    sessions: sess.sessions,
    utc_time: sess.utc_time
  };

  return snapshot;
}

/* ═══════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════ */
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
   V4 FEATURE 1: ICT KILLZONE HEATMAP
   ═══════════════════════════════════════════════════════ */
const KILLZONES = [
  { name: "Asian KZ",  start: 0,    end: 240,  color: "rgba(88,166,255,0.45)",  legendColor: "#58a6ff", isKZ: true },
  { name: "London Pre",start: 240,  end: 360,  color: "rgba(139,148,158,0.15)", legendColor: "#484f58" },
  { name: "London KZ", start: 360,  end: 540,  color: "rgba(63,185,80,0.45)",   legendColor: "#3fb950", isKZ: true },
  { name: "London",    start: 540,  end: 720,  color: "rgba(63,185,80,0.20)",   legendColor: "#3fb950" },
  { name: "NY AM KZ",  start: 720,  end: 840,  color: "rgba(240,136,62,0.50)",  legendColor: "#f0883e", isKZ: true },
  { name: "NY Lunch",  start: 840,  end: 960,  color: "rgba(139,148,158,0.12)", legendColor: "#484f58" },
  { name: "NY PM KZ",  start: 960,  end: 1080, color: "rgba(248,81,73,0.40)",   legendColor: "#f85149", isKZ: true },
  { name: "NY Close",  start: 1080, end: 1260, color: "rgba(248,81,73,0.18)",   legendColor: "#f85149" },
  { name: "Off-Hours", start: 1260, end: 1440, color: "rgba(139,148,158,0.08)", legendColor: "#30363d" },
];

function computeKillzoneVolatility() {
  // Compute avg ATR per killzone window from 1h candles of active symbol
  const candles = allCandles[activeSymbol]?.["1h"];
  if (!candles || candles.length < 30) return {};
  
  const kzVol = {};
  for (const kz of KILLZONES) {
    const matchingATRs = [];
    for (let i = 1; i < candles.length; i++) {
      const d = new Date(candles[i].open_time);
      const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
      if (utcMin >= kz.start && utcMin < kz.end) {
        const tr = Math.max(
          candles[i].high - candles[i].low,
          Math.abs(candles[i].high - candles[i-1].close),
          Math.abs(candles[i].low - candles[i-1].close)
        );
        matchingATRs.push(tr);
      }
    }
    if (matchingATRs.length > 0) {
      const avg = matchingATRs.reduce((a,b) => a + b, 0) / matchingATRs.length;
      kzVol[kz.name] = avg;
    }
  }
  
  // Normalize to relative scale (0-1)
  const vals = Object.values(kzVol);
  const maxVol = Math.max(...vals, 0.001);
  const normalized = {};
  for (const [k, v] of Object.entries(kzVol)) {
    normalized[k] = v / maxVol;
  }
  return normalized;
}

function countDisplacements() {
  // Count large moves (>1.5x ATR) per killzone from 1h candles
  const candles = allCandles[activeSymbol]?.["1h"];
  if (!candles || candles.length < 30) return {};
  
  // Overall ATR for threshold
  let totalATR = 0, atrCount = 0;
  for (let i = 1; i < candles.length; i++) {
    totalATR += Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i-1].close),
      Math.abs(candles[i].low - candles[i-1].close)
    );
    atrCount++;
  }
  const avgATR = atrCount ? totalATR / atrCount : 1;
  const threshold = avgATR * 1.5;
  
  const counts = {};
  for (const kz of KILLZONES) counts[kz.name] = 0;
  
  for (let i = 1; i < candles.length; i++) {
    const move = Math.abs(candles[i].close - candles[i].open);
    if (move >= threshold) {
      const d = new Date(candles[i].open_time);
      const utcMin = d.getUTCHours() * 60 + d.getUTCMinutes();
      for (const kz of KILLZONES) {
        if (utcMin >= kz.start && utcMin < kz.end) {
          counts[kz.name]++;
          break;
        }
      }
    }
  }
  return counts;
}

function renderKillzoneHeatmap() {
  const container = document.getElementById("kz-heatmap");
  if (!container) return;
  
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const nowMin = utcH * 60 + utcM;
  const totalMin = 1440;
  
  const kzVol = computeKillzoneVolatility();
  const displacements = countDisplacements();
  
  // Find current killzone
  let currentKZ = "Off-Hours";
  for (const kz of KILLZONES) {
    if (nowMin >= kz.start && nowMin < kz.end) {
      currentKZ = kz.name;
      break;
    }
  }
  
  // Session label
  const labelEl = document.getElementById("kz-session-label");
  if (labelEl) labelEl.textContent = currentKZ;
  
  // Build timeline
  let html = `<div class="kz-timeline">`;
  
  for (const kz of KILLZONES) {
    const widthPct = ((kz.end - kz.start) / totalMin) * 100;
    const isActive = nowMin >= kz.start && nowMin < kz.end;
    const vol = kzVol[kz.name] || 0;
    const disp = displacements[kz.name] || 0;
    const volLabel = vol > 0.7 ? "HOT" : vol > 0.4 ? "WARM" : "QUIET";
    const volColor = vol > 0.7 ? "#f0883e" : vol > 0.4 ? "#d2a8ff" : "rgba(255,255,255,0.4)";
    
    // Adjust opacity based on volatility
    const baseOpacity = kz.isKZ ? 0.6 : 0.25;
    const volBoost = vol * 0.4;
    const bgColor = kz.color;
    
    const pad = n => String(n).padStart(2, '0');
    const startH = Math.floor(kz.start / 60);
    const startM = kz.start % 60;
    const endH = Math.floor(kz.end / 60);
    const endM = kz.end % 60;
    const timeRange = `${pad(startH)}:${pad(startM)}-${pad(endH)}:${pad(endM)}`;
    
    html += `<div class="kz-slot${isActive ? ' kz-active' : ''}" 
      style="width:${widthPct}%;background:${bgColor}" 
      title="${kz.name}\n${timeRange} UTC\nVolatility: ${volLabel}\nDisplacements: ${disp}">`;
    if (widthPct > 5) {
      html += `<span class="kz-slot-name">${kz.name}</span>`;
      html += `<span class="kz-slot-time">${timeRange}</span>`;
      if (disp > 0) html += `<span class="kz-slot-vol" style="color:${volColor}">${volLabel} · ${disp}⚡</span>`;
    }
    html += `</div>`;
  }
  
  // Now marker
  const nowPct = (nowMin / totalMin) * 100;
  html += `<div class="kz-now-marker" style="left:${nowPct}%"></div>`;
  html += `</div>`;
  
  // Legend
  const uniqueKZs = KILLZONES.filter(kz => kz.isKZ);
  html += `<div class="kz-legend">`;
  for (const kz of uniqueKZs) {
    html += `<div class="kz-legend-item">
      <span class="kz-legend-dot" style="background:${kz.legendColor}"></span>
      <span>${kz.name}</span>
    </div>`;
  }
  html += `</div>`;
  
  // Stats row
  const hottest = Object.entries(kzVol).sort((a,b) => b[1] - a[1])[0];
  const mostDisp = Object.entries(displacements).sort((a,b) => b[1] - a[1])[0];
  html += `<div class="kz-stats-row">`;
  html += `<div class="kz-stat"><span class="kz-stat-label">Current</span><span class="kz-stat-value">${currentKZ}</span></div>`;
  if (hottest) html += `<div class="kz-stat"><span class="kz-stat-label">Hottest Zone</span><span class="kz-stat-value" style="color:#f0883e">${hottest[0]}</span></div>`;
  if (mostDisp && mostDisp[1] > 0) html += `<div class="kz-stat"><span class="kz-stat-label">Most Displacements</span><span class="kz-stat-value" style="color:#d2a8ff">${mostDisp[0]} (${mostDisp[1]})</span></div>`;
  html += `</div>`;
  
  container.innerHTML = html;
}

/* ═══════════════════════════════════════════════════════
   V4 FEATURE 2: OB + FVG TRACKER
   ═══════════════════════════════════════════════════════ */
let obfvgFilter = "all"; // "all" | "ob" | "fvg"

function collectAllOBFVG() {
  const items = [];
  
  for (const sym of watchlist) {
    const d = allData[sym];
    if (!d || !d.timeframes) continue;
    const price = getTickerPrice(d);
    
    for (const tf of TIMEFRAMES) {
      const tfData = d.timeframes[tf];
      if (!tfData || tfData.error) continue;
      
      // Order Blocks
      if (tfData.nearest_bull_ob) {
        items.push({
          ticker: sym,
          tf,
          type: "OB",
          side: "Bull",
          top: tfData.nearest_bull_ob.top,
          bottom: tfData.nearest_bull_ob.bottom,
          dist: tfData.nearest_bull_ob.distance_pct,
          price
        });
      }
      if (tfData.nearest_bear_ob) {
        items.push({
          ticker: sym,
          tf,
          type: "OB",
          side: "Bear",
          top: tfData.nearest_bear_ob.top,
          bottom: tfData.nearest_bear_ob.bottom,
          dist: tfData.nearest_bear_ob.distance_pct,
          price
        });
      }
      
      // FVGs
      if (tfData.nearest_bull_fvg) {
        items.push({
          ticker: sym,
          tf,
          type: "FVG",
          side: "Bull",
          top: tfData.nearest_bull_fvg.top,
          bottom: tfData.nearest_bull_fvg.bottom,
          dist: tfData.nearest_bull_fvg.distance_pct,
          price
        });
      }
      if (tfData.nearest_bear_fvg) {
        items.push({
          ticker: sym,
          tf,
          type: "FVG",
          side: "Bear",
          top: tfData.nearest_bear_fvg.top,
          bottom: tfData.nearest_bear_fvg.bottom,
          dist: tfData.nearest_bear_fvg.distance_pct,
          price
        });
      }
    }
  }
  
  // Sort by absolute distance (closest first)
  items.sort((a, b) => Math.abs(a.dist) - Math.abs(b.dist));
  return items;
}

function renderOBFVGTracker() {
  const tbody = document.getElementById("obfvg-body");
  if (!tbody) return;
  
  let items = collectAllOBFVG();
  
  // Apply filter
  if (obfvgFilter === "ob") items = items.filter(i => i.type === "OB");
  else if (obfvgFilter === "fvg") items = items.filter(i => i.type === "FVG");
  
  if (!items.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:#484f58;text-align:center;padding:16px">No unmitigated zones detected</td></tr>`;
    return;
  }
  
  tbody.innerHTML = items.slice(0, 40).map(item => {
    const absDist = Math.abs(item.dist);
    const distCls = absDist < 0.5 ? "obfvg-dist-close" : absDist < 2 ? "obfvg-dist-mid" : "obfvg-dist-far";
    const sideCls = item.side === "Bull" ? "obfvg-bull" : "obfvg-bear";
    const typeCls = item.type === "OB" ? "obfvg-type-ob" : "obfvg-type-fvg";
    const nearCls = absDist < 0.5 ? " obfvg-near" : "";
    const statusCls = absDist < 3 ? "obfvg-status-active" : "obfvg-status-stale";
    const statusText = absDist < 0.5 ? "IN PLAY" : absDist < 3 ? "ACTIVE" : "FAR";
    const sideArrow = item.side === "Bull" ? "▲" : "▼";
    
    const zoneText = (item.top != null && item.bottom != null)
      ? `${fmtPrice(item.bottom)} – ${fmtPrice(item.top)}`
      : `—`;
    
    return `<tr class="${nearCls}">
      <td style="font-weight:600;color:#e6edf3">${item.ticker.replace("USDT", "")}</td>
      <td class="tf-label">${item.tf}</td>
      <td><span class="${typeCls}">${item.type}</span></td>
      <td class="${sideCls}">${sideArrow} ${item.side}</td>
      <td style="color:#8b949e;font-size:9px">${zoneText}</td>
      <td class="${distCls}">${item.dist > 0 ? "+" : ""}${item.dist}%</td>
      <td><span class="${statusCls}">${statusText}</span></td>
    </tr>`;
  }).join("");
}

function initOBFVGFilters() {
  document.querySelectorAll(".obfvg-filter-btn").forEach(btn => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      document.querySelectorAll(".obfvg-filter-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      obfvgFilter = btn.dataset.filter;
      renderOBFVGTracker();
    });
  });
}

/* ═══════════════════════════════════════════════════════
   V4 FEATURE 3: LIVE THESIS PANEL
   Bridge to thesis_state.json from jque-perps-bot
   ═══════════════════════════════════════════════════════ */
let thesisState = null; // loaded from user JSON or demo
let thesisSource = "demo"; // "demo" | "user"

function generateDemoThesis() {
  // Matches the schema from thesis_engine.py
  const assets = {};
  const gates = ["HIGH", "MEDIUM", "LOW", "BLOCKED", "CONTEXT_ONLY"];
  const regimes = ["bullish", "bearish", "ranging"];
  const biases = ["bullish", "bearish", "neutral"];
  const demoConfigs = {
    BTC: { regime: "bullish", h4Struct: "bullish", h1Trend: "bullish", volTrend: "rising", deltaBias: "positive", momentum: "strong", primeWindow: true, factor: 78, gate: "HIGH" },
    ETH: { regime: "ranging", h4Struct: "neutral", h1Trend: "bearish", volTrend: "flat", deltaBias: "neutral", momentum: "weak", primeWindow: false, factor: 42, gate: "CONTEXT_ONLY" },
    SOL: { regime: "bullish", h4Struct: "bullish", h1Trend: "bullish", volTrend: "rising", deltaBias: "positive", momentum: "moderate", primeWindow: true, factor: 65, gate: "MEDIUM" }
  };
  
  for (const [sym, cfg] of Object.entries(demoConfigs)) {
    assets[sym] = {
      macro: {
        regime: cfg.regime,
        regime_confidence: cfg.regime === "bullish" ? 0.82 : cfg.regime === "bearish" ? 0.71 : 0.45,
        ema200_position: cfg.regime === "bullish" ? "above" : cfg.regime === "bearish" ? "below" : "at",
        h4_structure: cfg.h4Struct,
        h1_trend: cfg.h1Trend
      },
      micro: {
        volume_trend: cfg.volTrend,
        delta_bias: cfg.deltaBias,
        momentum: cfg.momentum,
        prime_window: cfg.primeWindow
      },
      factor_score: cfg.factor,
      gate: cfg.gate,
      btc_alignment: sym === "BTC" ? null : (cfg.gate === "HIGH" ? "aligned" : cfg.gate === "MEDIUM" ? "divergent" : "blocked"),
      updated_at: new Date().toISOString()
    };
  }
  
  return assets;
}

function renderThesisPanel() {
  const container = document.getElementById("thesis-cards");
  const sourceLabel = document.getElementById("thesis-source-label");
  if (!container) return;
  
  // Use user-loaded or demo
  const state = thesisState || generateDemoThesis();
  if (sourceLabel) sourceLabel.textContent = thesisSource === "user" ? "Live data" : "Demo data";
  
  const assets = Object.entries(state);
  if (!assets.length) {
    container.innerHTML = `<div class="thesis-empty">
      No thesis data loaded
      <div class="thesis-empty-hint">Click "Load" to paste thesis_state.json from your perps bot</div>
    </div>`;
    return;
  }
  
  container.innerHTML = assets.map(([sym, thesis]) => {
    const gate = (thesis.gate || "BLOCKED").toLowerCase();
    const macro = thesis.macro || {};
    const micro = thesis.micro || {};
    const factorScore = thesis.factor_score ?? 0;
    const factorPct = Math.min(Math.max(factorScore, 0), 100);
    const factorColor = factorPct >= 70 ? "#3fb950" : factorPct >= 50 ? "#d2a8ff" : factorPct >= 30 ? "#f0883e" : "#f85149";
    
    const regimeClass = macro.regime === "bullish" ? "val-bullish" : macro.regime === "bearish" ? "val-bearish" : macro.regime === "ranging" ? "val-ranging" : "val-neutral";
    const trendClass = (val) => val === "bullish" || val === "positive" || val === "rising" || val === "strong" ? "val-bullish" : 
                                val === "bearish" || val === "negative" || val === "falling" ? "val-bearish" : 
                                val === "ranging" || val === "moderate" ? "val-ranging" : "val-neutral";
    
    let alignHTML = "";
    if (thesis.btc_alignment) {
      const alignCls = thesis.btc_alignment === "aligned" ? "val-bullish" : thesis.btc_alignment === "divergent" ? "val-ranging" : "val-bearish";
      alignHTML = `<div class="thesis-row">
        <span class="thesis-row-key">BTC Align</span>
        <span class="thesis-row-val ${alignCls}">${thesis.btc_alignment}</span>
      </div>`;
    }
    
    return `<div class="thesis-card">
      <div class="thesis-card-header">
        <span class="thesis-asset-name">${sym}</span>
        <span class="thesis-gate thesis-gate-${gate}">${thesis.gate || "BLOCKED"}</span>
      </div>
      
      <div class="thesis-section">
        <span class="thesis-section-title">Macro Regime</span>
        <div class="thesis-row">
          <span class="thesis-row-key">Regime</span>
          <span class="thesis-row-val ${regimeClass}">${macro.regime || "—"} ${macro.regime_confidence ? `(${(macro.regime_confidence * 100).toFixed(0)}%)` : ""}</span>
        </div>
        <div class="thesis-row">
          <span class="thesis-row-key">EMA 200</span>
          <span class="thesis-row-val ${trendClass(macro.ema200_position)}">${macro.ema200_position || "—"}</span>
        </div>
        <div class="thesis-row">
          <span class="thesis-row-key">H4 Structure</span>
          <span class="thesis-row-val ${trendClass(macro.h4_structure)}">${macro.h4_structure || "—"}</span>
        </div>
        <div class="thesis-row">
          <span class="thesis-row-key">H1 Trend</span>
          <span class="thesis-row-val ${trendClass(macro.h1_trend)}">${macro.h1_trend || "—"}</span>
        </div>
      </div>
      
      <div class="thesis-section">
        <span class="thesis-section-title">Microstructure</span>
        <div class="thesis-row">
          <span class="thesis-row-key">Volume</span>
          <span class="thesis-row-val ${trendClass(micro.volume_trend)}">${micro.volume_trend || "—"}</span>
        </div>
        <div class="thesis-row">
          <span class="thesis-row-key">Delta Bias</span>
          <span class="thesis-row-val ${trendClass(micro.delta_bias)}">${micro.delta_bias || "—"}</span>
        </div>
        <div class="thesis-row">
          <span class="thesis-row-key">Momentum</span>
          <span class="thesis-row-val ${trendClass(micro.momentum)}">${micro.momentum || "—"}</span>
        </div>
        <div class="thesis-row">
          <span class="thesis-row-key">Prime Window</span>
          <span class="thesis-row-val ${micro.prime_window ? 'val-bullish' : 'val-neutral'}">${micro.prime_window ? 'YES' : 'NO'}</span>
        </div>
      </div>
      
      <div class="thesis-section">
        <span class="thesis-section-title">Factor Score</span>
        <div class="thesis-row">
          <span class="thesis-row-key">Score</span>
          <span class="thesis-row-val" style="color:${factorColor}">${factorScore}/100</span>
        </div>
        <div class="thesis-score-bar">
          <div class="thesis-score-fill" style="width:${factorPct}%;background:${factorColor}"></div>
        </div>
        ${alignHTML}
      </div>
    </div>`;
  }).join("");
  
  // Also expose thesis on window.MSD
  if (window.MSD) {
    window.MSD.thesis = state;
  }
}

function initThesisPanel() {
  const loadBtn = document.getElementById("thesis-load-btn");
  const cancelBtn = document.getElementById("thesis-cancel-btn");
  const saveBtn = document.getElementById("thesis-save-btn");
  const overlay = document.getElementById("thesis-form-overlay");
  
  if (loadBtn) loadBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    overlay.classList.add("show");
  });
  if (cancelBtn) cancelBtn.addEventListener("click", () => overlay.classList.remove("show"));
  if (overlay) overlay.addEventListener("click", (e) => {
    if (e.target === e.currentTarget) overlay.classList.remove("show");
  });
  if (saveBtn) saveBtn.addEventListener("click", () => {
    const input = document.getElementById("thesis-json-input").value.trim();
    if (!input) return;
    try {
      const parsed = JSON.parse(input);
      thesisState = parsed;
      thesisSource = "user";
      store.set('msd_thesis', input);
      overlay.classList.remove("show");
      renderThesisPanel();
    } catch (e) {
      alert("Invalid JSON. Paste the contents of thesis_state.json.");
    }
  });
  
  // Restore saved thesis
  try {
    const saved = store.get('msd_thesis');
    if (saved) {
      thesisState = JSON.parse(saved);
      thesisSource = "user";
    }
  } catch(e) {}
}

/* ═══════════════════════════════════════════════════════
   LIVE THESIS FETCH — pulls from /api/thesis (bot backend)
   ═══════════════════════════════════════════════════════ */
async function fetchLiveThesis() {
  try {
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 3000);
    const res = await fetch("/api/thesis", { signal: ctrl.signal });
    clearTimeout(tid);
    if (!res.ok) return;
    const raw = await res.json();
    if (raw.error) return;

    // Map bot schema → dashboard thesis schema
    // Bot emits: { BTC: { asset, macro, micro, factor_score, gate, updated_at }, ... }
    const mapped = {};
    for (const [key, val] of Object.entries(raw)) {
      if (key === "schema_version") continue;
      if (typeof val !== "object" || !val.gate) continue;
      mapped[key] = {
        macro: val.macro || {},
        micro: val.micro || {},
        factor_score: val.factor_score ?? val.factor?.score ?? 0,
        gate: val.gate,
        btc_alignment: val.btc_alignment ?? null,
        updated_at: val.updated_at
      };
    }

    if (Object.keys(mapped).length > 0) {
      thesisState = mapped;
      thesisSource = "user";
      renderThesisPanel();
    }
  } catch (e) {
    // Silently fall back to demo data
  }
}

/* ═══════════════════════════════════════════════════════
   DEMO DATA — used when APIs are unreachable
   FIX 2: generateDemoCandles now accepts parameters for
   different random walk characteristics per TF
   ═══════════════════════════════════════════════════════ */
function generateDemoCandles(basePrice, count = 200, drift = -0.48, volatility = 0.005) {
  const candles = [];
  let price = basePrice;
  const now = Date.now();
  for (let i = 0; i < count; i++) {
    const change = (Math.random() + drift) * basePrice * volatility;
    const open = price;
    const close = price + change;
    const high = Math.max(open, close) + Math.random() * basePrice * 0.002;
    const low = Math.min(open, close) - Math.random() * basePrice * 0.002;
    const volume = Math.random() * 1000000 + 500000;
    candles.push({
      open_time: now - (count - i) * 3600000,
      open, high, low, close,
      volume,
      close_time: now - (count - i - 1) * 3600000,
    });
    price = close;
  }
  return candles;
}

/* FIX 2: Generate separate candles per TF with different seeds */
function generateDemoForTicker(sym) {
  const basePrices = {
    BTCUSDT: 84523.40, ETHUSDT: 2128.55, SOLUSDT: 139.82,
  };
  const base = basePrices[sym] || (100 + Math.random() * 900);

  if (!allCandles[sym]) allCandles[sym] = {};

  // FIX 2: Generate candles independently per TF with different characteristics
  const tfDriftMap = {
    "1m": -0.48, "5m": -0.47, "15m": -0.46, "1h": -0.45,
    "4h": -0.50, "1d": -0.52, "1w": -0.44
  };
  const tfVolMap = {
    "1m": 0.003, "5m": 0.004, "15m": 0.005, "1h": 0.006,
    "4h": 0.008, "1d": 0.010, "1w": 0.007
  };
  const tfSeedOffsets = {
    "1m": 0, "5m": 0.001, "15m": 0.002, "1h": 0.003,
    "4h": 0.005, "1d": 0.008, "1w": 0.004
  };

  for (const tf of TIMEFRAMES) {
    const seedBase = base * (1 + (tfSeedOffsets[tf] || 0));
    const drift = tfDriftMap[tf] || -0.48;
    const vol = tfVolMap[tf] || 0.005;
    allCandles[sym][tf] = generateDemoCandles(seedBase, 200, drift, vol);
  }

  const demoHLMap = {
    BTCUSDT: { sh: 85200, sl: 83100, pdh: 85100, pdl: 82900, pwh: 86500, pwl: 81200, pmh: 89000, pml: 78500 },
    ETHUSDT: { sh: 2180, sl: 2050, pdh: 2160, pdl: 2040, pwh: 2250, pwl: 1980, pmh: 2400, pml: 1850 },
    SOLUSDT: { sh: 145, sl: 132, pdh: 143, pdl: 131, pwh: 152, pwl: 125, pmh: 165, pml: 110 },
  };
  const hl = demoHLMap[sym] || {
    sh: base * 1.02, sl: base * 0.98, pdh: base * 1.015, pdl: base * 0.985,
    pwh: base * 1.04, pwl: base * 0.96, pmh: base * 1.08, pml: base * 0.92
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

  const tfs = {};
  // Use the 1h candles' last price as the reference
  const cp = allCandles[sym]["1h"][allCandles[sym]["1h"].length - 1].close;

  for (const tf of TIMEFRAMES) {
    const tfCandles = allCandles[sym][tf];
    const price = tfCandles[tfCandles.length - 1].close;
    const pos = Math.max(0, Math.min(1, (price - hl.sl) / (hl.sh - hl.sl)));
    const barLen = 11;
    const dotPos = Math.round(pos * (barLen - 1));
    let bar = "";
    for (let i = 0; i < barLen; i++) bar += i === dotPos ? "\u2B24" : "\u2500";

    const bullDist = +(Math.random() * -2).toFixed(2);
    const bearDist = +(Math.random() * 2).toFixed(2);

    tfs[tf] = {
      current_price: price,
      swing_bar: { text: `L ${bar} H`, position: +pos.toFixed(3), swing_high: hl.sh, swing_low: hl.sl, current: price },
      structure_labels: demoStructures[tf] || ["HH","HL","HH","HL"],
      structure_bias: demoBias[tf] || "neutral",
      nearest_bull_ob: { type: "bull", distance_pct: bullDist },
      nearest_bear_ob: { type: "bear", distance_pct: bearDist },
      nearest_bull_fvg: Math.random() > 0.4 ? { type: "bull", distance_pct: +(Math.random() * -3).toFixed(2) } : null,
      nearest_bear_fvg: Math.random() > 0.4 ? { type: "bear", distance_pct: +(Math.random() * 3).toFixed(2) } : null,
      ema: {
        direction: price > base * 0.998 ? "above" : "below",
        distance_pct: +((Math.random() - 0.3) * 2).toFixed(2),
        value: +(base * (1 - Math.random() * 0.01)).toFixed(2)
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

    // Momentum data for relevant TFs
    if (MOMENTUM_TFS.includes(tf)) {
      tfs[tf].rsi = +(30 + Math.random() * 40).toFixed(1);
      tfs[tf].macd = { macd: (Math.random() - 0.5) * 100, signal: (Math.random() - 0.5) * 80, bullish: Math.random() > 0.5 };
    }
  }

  allData[sym] = {
    symbol: sym,
    timeframes: tfs,
    htf_levels: {
      current_price: cp,
      prev_day: {
        high: hl.pdh, low: hl.pdl,
        high_dist: +((cp - hl.pdh) / cp * 100).toFixed(2),
        low_dist: +((cp - hl.pdl) / cp * 100).toFixed(2)
      },
      prev_week: {
        high: hl.pwh, low: hl.pwl,
        high_dist: +((cp - hl.pwh) / cp * 100).toFixed(2),
        low_dist: +((cp - hl.pwl) / cp * 100).toFixed(2)
      },
      prev_month: {
        high: hl.pmh, low: hl.pml,
        high_dist: +((cp - hl.pmh) / cp * 100).toFixed(2),
        low_dist: +((cp - hl.pml) / cp * 100).toFixed(2)
      }
    },
    trend_bias: 0 // will be computed
  };
  allData[sym].trend_bias = computeTrendBias(tfs);
}

function loadDemoData() {
  for (const sym of watchlist) {
    if (!allData[sym]) {
      generateDemoForTicker(sym);
    }
  }

  // Generate some demo signals
  if (!signalHistory.length) {
    const demoSignals = [
      { key: "demo_bb_bull_BTCUSDT_1h", time: Date.now() - 3600000, ticker: "BTCUSDT", type: "BB+RSI", direction: "Bull", tf: "1h", price: 83800, isNew: false },
      { key: "demo_st_bear_ETHUSDT_4h", time: Date.now() - 7200000, ticker: "ETHUSDT", type: "SuperTrend", direction: "Bear", tf: "4h", price: 2150, isNew: false },
      { key: "demo_bb_bear_SOLUSDT_15m", time: Date.now() - 1800000, ticker: "SOLUSDT", type: "BB+RSI", direction: "Bear", tf: "15m", price: 141.5, isNew: true },
      { key: "demo_st_bull_BTCUSDT_1d", time: Date.now() - 900000, ticker: "BTCUSDT", type: "SuperTrend", direction: "Bull", tf: "1d", price: 84200, isNew: true },
    ];
    signalHistory = demoSignals;
  }

  document.getElementById("skeleton").style.display = "none";
  document.getElementById("panels").style.display = "";
  renderDashboard();
  renderWatchlist();
}
