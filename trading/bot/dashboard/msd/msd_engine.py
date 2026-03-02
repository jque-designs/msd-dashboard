import threading
import time
from datetime import datetime, timedelta, timezone
from functools import lru_cache

import pandas as pd
import requests

BINANCE_URL = "https://api.binance.com/api/v3/klines"

# Thread-level cache: {cache_key: (timestamp, df)}
_fetch_cache: dict = {}
_cache_lock = threading.Lock()
CACHE_TTL = 10  # seconds


def fetch_klines(symbol: str, interval: str, limit: int = 200) -> pd.DataFrame | None:
    """
    Fetch OHLCV from Binance with 10s cache. Returns DataFrame with columns:
    open_time, open, high, low, close, volume, close_time (all prices as float).
    Raises on HTTP error. Returns None if fetch fails (caller handles gracefully).
    """
    cache_key = f"{symbol}_{interval}_{limit}"
    with _cache_lock:
        if cache_key in _fetch_cache:
            ts, df = _fetch_cache[cache_key]
            if time.time() - ts < CACHE_TTL:
                return df

    try:
        resp = requests.get(
            BINANCE_URL,
            params={"symbol": symbol, "interval": interval, "limit": limit},
            timeout=10,
        )
        resp.raise_for_status()
        data = resp.json()
        df = pd.DataFrame(
            data,
            columns=[
                "open_time",
                "open",
                "high",
                "low",
                "close",
                "volume",
                "close_time",
                "quote_vol",
                "trades",
                "taker_base",
                "taker_quote",
                "ignore",
            ],
        )
        for col in ["open", "high", "low", "close", "volume"]:
            df[col] = df[col].astype(float)
        df["open_time"] = pd.to_datetime(df["open_time"], unit="ms")
        df["close_time"] = pd.to_datetime(df["close_time"], unit="ms")
        df = df.reset_index(drop=True)
        with _cache_lock:
            _fetch_cache[cache_key] = (time.time(), df)
        return df
    except Exception as e:  # noqa: BLE001
        print(f"[FETCH ERROR] {symbol} {interval}: {e}")
        return None


def _detect_pivots(df: pd.DataFrame, swing_length: int = 5):
    """
    Returns (pivot_highs, pivot_lows) as lists of (bar_index: int, price: float).
    Pivot high at i: high[i] >= all highs in [i-swing_length, i+swing_length].
    NOTE: last swing_length bars cannot be pivots (need future confirmation).
    """
    highs = df["high"].values
    lows = df["low"].values
    n = len(df)
    pivot_highs = []
    pivot_lows = []
    for i in range(swing_length, n - swing_length):
        window_h = highs[max(0, i - swing_length) : i + swing_length + 1]
        window_l = lows[max(0, i - swing_length) : i + swing_length + 1]
        if highs[i] == window_h.max():
            pivot_highs.append((i, highs[i]))
        if lows[i] == window_l.min():
            pivot_lows.append((i, lows[i]))
    return pivot_highs, pivot_lows


def calc_ema_trend(df: pd.DataFrame, ema_length: int = 9) -> dict:
    """dir (+1/-1), dist_pct: (price-ema)/price*100"""
    if df is None or len(df) < ema_length:
        return {"dir": 0, "dist_pct": 0.0}
    ema = df["close"].ewm(span=ema_length, adjust=False).mean()
    close = df["close"].iloc[-1]
    ema_val = ema.iloc[-1]
    dist = close - ema_val
    return {"dir": 1 if close > ema_val else -1, "dist_pct": (dist / close) * 100}


def fmt_swing_bar(
    swing_h: float, swing_l: float, close: float, reclaim_low: bool, reclaim_high: bool
) -> tuple[str, str]:
    """
    Returns (bar_text, color_class) where color_class is 'bull', 'bear', or 'neutral'.
    Replicates Pine Script fmtSwingBar exactly.
    """
    BARS = 9
    swing_range = max(swing_h - swing_l, 1e-10)
    raw_pct = (close - swing_l) / swing_range * 100

    if raw_pct < 0:
        return ("↓ L " + "─" * BARS + " H ", "bear")
    elif raw_pct > 100:
        return (" L " + "─" * BARS + " H ↑", "bull")
    elif reclaim_low:
        pos = round(raw_pct / 100 * (BARS - 1))
        return ("⤴ L " + "─" * pos + "⬤" + "─" * (BARS - 1 - pos) + " H ", "bull")
    elif reclaim_high:
        pos = round(raw_pct / 100 * (BARS - 1))
        return (" L " + "─" * pos + "⬤" + "─" * (BARS - 1 - pos) + " H ⤵", "bear")
    else:
        pos = round(raw_pct / 100 * (BARS - 1))
        color = "bear" if raw_pct >= 50 else "bull"
        return (" L " + "─" * pos + "⬤" + "─" * (BARS - 1 - pos) + " H ", color)


def calc_swing_hl(df: pd.DataFrame, swing_length: int = 5) -> dict:
    """
    Returns: curr_h, curr_l, prev_h, prev_l, swing_pct, swing_bar (text),
             swing_color ('bull'/'bear'/'neutral'), reclaim_low, reclaim_high, swing_bias.
    swing_bias: +1 if most recent pivot was a HIGH, -1 if LOW, 0 if none.
    """
    if df is None or len(df) < swing_length * 3:
        return {
            "curr_h": 0,
            "curr_l": 0,
            "prev_h": 0,
            "prev_l": 0,
            "swing_pct": 50,
            "swing_bar": " L ─────⬤─── H ",
            "swing_color": "neutral",
            "reclaim_low": False,
            "reclaim_high": False,
            "swing_bias": 0,
        }

    pivot_highs, pivot_lows = _detect_pivots(df, swing_length)

    curr_h = pivot_highs[-1][1] if pivot_highs else df["high"].max()
    prev_h = pivot_highs[-2][1] if len(pivot_highs) >= 2 else curr_h
    curr_l = pivot_lows[-1][1] if pivot_lows else df["low"].min()
    prev_l = pivot_lows[-2][1] if len(pivot_lows) >= 2 else curr_l

    close = df["close"].iloc[-1]
    swing_range = max(curr_h - curr_l, 1e-10)
    swing_pct = (close - curr_l) / swing_range * 100

    # Reclaim: was swing broken in recent bars, then recovered?
    recent = df.tail(swing_length * 3)
    low_broken = (recent["low"] < curr_l).any()
    high_broken = (recent["high"] > curr_h).any()
    reclaim_low = bool(low_broken and close > curr_l)
    reclaim_high = bool(high_broken and close < curr_h)

    # swing_bias: which pivot type occurred most recently (by bar index)
    swing_bias = 0
    last_h_bar = pivot_highs[-1][0] if pivot_highs else -1
    last_l_bar = pivot_lows[-1][0] if pivot_lows else -1
    if last_h_bar > last_l_bar:
        swing_bias = 1
    elif last_l_bar > last_h_bar:
        swing_bias = -1

    bar_text, bar_color = fmt_swing_bar(curr_h, curr_l, close, reclaim_low, reclaim_high)

    return {
        "curr_h": curr_h,
        "curr_l": curr_l,
        "prev_h": prev_h,
        "prev_l": prev_l,
        "swing_pct": swing_pct,
        "swing_bar": bar_text,
        "swing_color": bar_color,
        "reclaim_low": reclaim_low,
        "reclaim_high": reclaim_high,
        "swing_bias": swing_bias,
    }


def calc_structure(df: pd.DataFrame, swing_length: int = 5) -> dict:
    """
    Builds a chronological sequence of swing labels (HH/LH/HL/LL) interleaved by bar time.
    Returns last 3 labels, struct_bias, high_type, low_type.

    Pine Script logic: every new pivot high gets HH or LH; every new pivot low gets HL or LL.
    Labels are interleaved in the order the pivots formed (not grouped by type).
    """
    if df is None or len(df) < swing_length * 3:
        return {"struct_bias": 0, "high_type": 0, "low_type": 0, "struct_labels": ["--"]}

    pivot_highs, pivot_lows = _detect_pivots(df, swing_length)

    # Build interleaved chronological sequence
    events = []
    for i, (bar_idx, price) in enumerate(pivot_highs):
        prev_price = pivot_highs[i - 1][1] if i > 0 else price
        label = "HH" if price > prev_price else "LH"
        events.append((bar_idx, label))
    for i, (bar_idx, price) in enumerate(pivot_lows):
        prev_price = pivot_lows[i - 1][1] if i > 0 else price
        label = "HL" if price > prev_price else "LL"
        events.append((bar_idx, label))

    # Sort by bar index to get true chronological order
    events.sort(key=lambda x: x[0])
    all_labels = [e[1] for e in events]
    last3 = all_labels[-3:] if len(all_labels) >= 3 else all_labels if all_labels else ["--"]

    # Determine types from most recent pivot of each kind
    high_type = 0
    low_type = 0
    if len(pivot_highs) >= 2:
        high_type = 1 if pivot_highs[-1][1] > pivot_highs[-2][1] else -1
    if len(pivot_lows) >= 2:
        low_type = 1 if pivot_lows[-1][1] > pivot_lows[-2][1] else -1

    # Real-time override: if price broke prev pivot level, update label
    close = df["close"].iloc[-1]
    if len(pivot_highs) >= 2 and close > pivot_highs[-2][1]:
        high_type = 1
    if len(pivot_lows) >= 2 and close < pivot_lows[-2][1]:
        low_type = -1

    struct_bias = 0
    if high_type == 1 and low_type == 1:
        struct_bias = 1
    elif high_type == -1 and low_type == -1:
        struct_bias = -1

    return {
        "struct_bias": struct_bias,
        "high_type": high_type,
        "low_type": low_type,
        "struct_labels": last3,
    }


def calc_order_blocks(df: pd.DataFrame, swing_length: int = 5, max_obs: int = 6) -> dict:
    """
    OB detection: when price breaks a pivot high (bull OB) or pivot low (bear OB),
    the OB candle is the lowest-body candle in the lookback before that break.
    Mitigated = price later closed below ob_bottom (bull) or above ob_top (bear).
    """
    if df is None or len(df) < swing_length * 3:
        return {"nearest_dir": 0, "nearest_dist_pct": 0.0, "obs": []}

    close = df["close"].iloc[-1]
    highs = df["high"].values
    lows = df["low"].values
    closes = df["close"].values
    n = len(df)

    pivot_highs, pivot_lows = _detect_pivots(df, swing_length)

    obs = []

    # Bull OBs: pivot high break -> find lowest candle in lookback before pivot
    for i in range(1, len(pivot_highs)):
        prev_bar, prev_price = pivot_highs[i - 1]
        curr_bar, curr_price = pivot_highs[i]
        if curr_price > prev_price:
            # OB candle: lowest low in [prev_bar, curr_bar)
            search_slice = lows[prev_bar:curr_bar]
            if len(search_slice) == 0:
                continue
            local_idx = search_slice.argmin() + prev_bar
            ob_bottom = lows[local_idx]
            ob_top = highs[local_idx]
            ob_bar = local_idx
            # Mitigated if any close after ob_bar went below ob_bottom
            if ob_bar + 1 < n:
                future_closes = closes[ob_bar + 1 :]
                if (future_closes < ob_bottom).any():
                    continue  # mitigated - skip
            obs.append({"dir": 1, "top": float(ob_top), "bottom": float(ob_bottom)})

    # Bear OBs: pivot low break -> find highest candle in lookback before pivot
    for i in range(1, len(pivot_lows)):
        prev_bar, prev_price = pivot_lows[i - 1]
        curr_bar, curr_price = pivot_lows[i]
        if curr_price < prev_price:
            search_slice = highs[prev_bar:curr_bar]
            if len(search_slice) == 0:
                continue
            local_idx = search_slice.argmax() + prev_bar
            ob_top = highs[local_idx]
            ob_bottom = lows[local_idx]
            ob_bar = local_idx
            if ob_bar + 1 < n:
                future_closes = closes[ob_bar + 1 :]
                if (future_closes > ob_top).any():
                    continue  # mitigated
            obs.append({"dir": -1, "top": float(ob_top), "bottom": float(ob_bottom)})

    obs = obs[-max_obs:]

    # Find nearest unmitigated OB
    nearest_dir = 0
    nearest_dist_pct = 0.0
    min_dist = float("inf")
    for ob in obs:
        mid = (ob["top"] + ob["bottom"]) / 2
        dist = abs(mid - close)
        if dist < min_dist:
            min_dist = dist
            nearest_dir = ob["dir"]
            nearest_dist_pct = ((mid - close) / close) * 100

    return {"nearest_dir": nearest_dir, "nearest_dist_pct": nearest_dist_pct, "obs": obs}


def calc_fvg(df: pd.DataFrame, max_fvgs: int = 6) -> dict:
    """
    Pine Script pattern (bars indexed from current=0, so [1]=1 bar ago, [3]=3 bars ago):
      Bull FVG: low[1] > high[3]  -> 3-bar gap up  (bars: oldest=[3], middle=[2], newest=[1])
    In DataFrame terms at position i (where i is the MIDDLE bar, i.e. bar[2]):
      low[i+1] > high[i-1]  -> bull FVG  (i+1=newest, i-1=oldest)
    Mitigated: any LOW after FVG formation goes below fvg_bottom (bull) or
               any HIGH after goes above fvg_top (bear).
    """
    if df is None or len(df) < 10:
        return {"nearest_dir": 0, "nearest_dist_pct": 0.0, "fvgs": []}

    close = df["close"].iloc[-1]
    highs = df["high"].values
    lows = df["low"].values
    n = len(df)
    fvgs = []

    for i in range(1, n - 2):
        # i is the "middle" candle of the 3-bar FVG pattern
        oldest = i - 1  # bar[3] in Pine (oldest)
        newest = i + 1  # bar[1] in Pine (newest)

        # Bull FVG: newest low > oldest high
        if lows[newest] > highs[oldest]:
            fvg_top = lows[newest]
            fvg_bottom = highs[oldest]
            # Mitigated check: any low after 'newest' bar below fvg_bottom?
            future_lows = lows[newest + 1 :] if newest + 1 < n else []
            if len(future_lows) == 0 or min(future_lows) > fvg_bottom:
                fvgs.append({"dir": 1, "top": float(fvg_top), "bottom": float(fvg_bottom)})

        # Bear FVG: newest high < oldest low
        elif highs[newest] < lows[oldest]:
            fvg_top = lows[oldest]
            fvg_bottom = highs[newest]
            future_highs = highs[newest + 1 :] if newest + 1 < n else []
            if len(future_highs) == 0 or max(future_highs) < fvg_top:
                fvgs.append({"dir": -1, "top": float(fvg_top), "bottom": float(fvg_bottom)})

    fvgs = fvgs[-max_fvgs:]

    nearest_dir = 0
    nearest_dist_pct = 0.0
    min_dist = float("inf")
    for fvg in fvgs:
        mid = (fvg["top"] + fvg["bottom"]) / 2
        dist = abs(mid - close)
        if dist < min_dist:
            min_dist = dist
            nearest_dir = fvg["dir"]
            nearest_dist_pct = ((mid - close) / close) * 100

    return {"nearest_dir": nearest_dir, "nearest_dist_pct": nearest_dist_pct, "fvgs": fvgs}


def calc_volume(df: pd.DataFrame, vol_length: int = 20) -> dict:
    if df is None or len(df) < 2:
        return {"pct": 100, "state": "NORMAL", "bar_str": "███░░"}
    avg_vol = df["volume"].iloc[-vol_length - 1 : -1].mean()
    curr_vol = df["volume"].iloc[-1]
    pct = (curr_vol / avg_vol * 100) if avg_vol > 0 else 100
    state = (
        "EXTREME"
        if pct > 200
        else "HIGH"
        if pct > 120
        else "NORMAL"
        if pct > 80
        else "LOW"
        if pct > 50
        else "VERY LOW"
    )
    bars = 5 if pct > 200 else 4 if pct > 120 else 3 if pct > 80 else 2 if pct > 50 else 1
    bar_str = "█" * bars + "░" * (5 - bars)
    return {"pct": round(pct, 1), "state": state, "bar_str": bar_str}


def calc_volatility(df: pd.DataFrame, atr_period: int = 3, avg_period: int = 20) -> dict:
    if df is None or len(df) < avg_period + atr_period:
        return {"state": "NORMAL", "pct": 100}
    tr = pd.concat(
        [
            df["high"] - df["low"],
            (df["high"] - df["close"].shift()).abs(),
            (df["low"] - df["close"].shift()).abs(),
        ],
        axis=1,
    ).max(axis=1)
    atr = tr.ewm(span=atr_period, adjust=False).mean()
    curr_atr = atr.iloc[-1]
    avg_atr = atr.iloc[-avg_period - 1 : -1].mean()
    pct = (curr_atr / avg_atr * 100) if avg_atr > 0 else 100
    state = "HIGH" if pct > 130 else "LOW" if pct < 70 else "NORMAL"
    return {"state": state, "pct": round(pct, 1)}


def get_session(dt_utc: datetime) -> dict:
    """Pine Script uses NY time (EST = UTC-5). Match exactly."""
    ny = dt_utc - timedelta(hours=5)
    hr = ny.hour
    if hr >= 19 or hr < 3:
        return {"name": "ASIAN", "color": "#3b82f6"}
    elif 3 <= hr < 8:
        return {"name": "LONDON", "color": "#22c55e"}
    elif 8 <= hr < 17:
        return {"name": "NEW YORK", "color": "#f97316"}
    return {"name": "OFF HOURS", "color": "#787b86"}


def get_killzone(dt_utc: datetime) -> dict:
    """ICT Killzones in NY time."""
    ny = dt_utc - timedelta(hours=5)
    total_mins = ny.hour * 60 + ny.minute
    if total_mins >= 20 * 60:  # 20:00+
        return {"name": "ASIAN KZ", "color": "#3b82f6"}
    elif 2 * 60 <= total_mins < 5 * 60:
        return {"name": "LONDON KZ", "color": "#22c55e"}
    elif 9 * 60 + 30 <= total_mins < 11 * 60:
        return {"name": "NY AM KZ", "color": "#f97316"}
    elif 12 * 60 <= total_mins < 13 * 60:
        return {"name": "NY LUNCH", "color": "#6b7280"}
    elif 13 * 60 + 30 <= total_mins < 16 * 60:
        return {"name": "NY PM KZ", "color": "#a855f7"}
    return {"name": "NO KILLZONE", "color": "#b8b8b8"}


def calc_htf_levels(symbol: str, curr_price: float) -> dict:
    """
    Fetch previous day/week/month high and low.
    Use iloc[-2] = the PREVIOUS completed candle (not the current open one).
    Include reclaim detection: did price sweep below PDL and recover?
    Binance intervals: "1d", "1w", "1M" (capital M for monthly).
    """
    result = {}
    for key, interval, limit in [("pd", "1d", 5), ("pw", "1w", 5), ("pm", "1M", 5)]:
        df = fetch_klines(symbol, interval, limit)
        time.sleep(0.1)
        if df is None or len(df) < 2 or curr_price == 0:
            result[f"{key}h"] = None
            result[f"{key}l"] = None
            result[f"{key}h_pct"] = None
            result[f"{key}l_pct"] = None
            continue
        prev_h = float(df["high"].iloc[-2])
        prev_l = float(df["low"].iloc[-2])
        # Distance from current price as %
        h_pct = (prev_h - curr_price) / curr_price * 100
        l_pct = (prev_l - curr_price) / curr_price * 100
        result[f"{key}h"] = prev_h
        result[f"{key}l"] = prev_l
        result[f"{key}h_pct"] = round(h_pct, 2)
        result[f"{key}l_pct"] = round(l_pct, 2)
    return result


def calc_bias(tf_results: list) -> dict:
    """
    Active factors (Pine default): Structure, OB, FVG, Swing (EMA off by default).
    4 factors x weight per TF.
    """
    total_score = 0
    max_score = 0
    for r in tf_results:
        w = r["weight"]
        if w == 0:
            continue
        score = (
            (1 if r["struct_bias"] > 0 else -1 if r["struct_bias"] < 0 else 0)
            + (1 if r["ob_dir"] > 0 else -1 if r["ob_dir"] < 0 else 0)
            + (1 if r["fvg_dir"] > 0 else -1 if r["fvg_dir"] < 0 else 0)
            + (1 if r["swing_bias"] > 0 else -1 if r["swing_bias"] < 0 else 0)
        ) * w
        total_score += score
        max_score += 4 * w

    pct = (total_score / max_score * 100) if max_score > 0 else 0
    label = (
        "BULLISH ↑"
        if pct > 50
        else "LEAN BULL ↑"
        if pct > 20
        else "BEARISH ↓"
        if pct < -50
        else "LEAN BEAR ↓"
        if pct < -20
        else "NEUTRAL →"
    )
    score_str = (f"+{total_score}" if total_score >= 0 else str(total_score)) + f"/{max_score}"
    color = "#089981" if pct > 20 else "#f23645" if pct < -20 else "#b8b8b8"
    return {"label": label, "score": score_str, "pct": round(pct, 1), "color": color}


def calc_all(symbol: str) -> dict:
    """
    Full dashboard data for one symbol.
    Stagger Binance calls with 0.1s sleep to avoid rate limits.
    TF weights match Pine defaults: 1m(1), 5m(1), 15m(2), 1h(2), 4h(2), 1d(3), 1w(4)
    """
    tf_config = [
        ("1m", "1m", 1, 100),
        ("5m", "5m", 1, 100),
        ("15m", "15m", 2, 200),
        ("1h", "1h", 2, 200),
        ("4h", "4h", 2, 200),
        ("1d", "1d", 3, 200),
        ("1w", "1w", 4, 52),
    ]

    tf_results = []
    for label, interval, weight, limit in tf_config:
        df = fetch_klines(symbol, interval, limit)
        time.sleep(0.1)  # rate limit guard
        if df is None:
            tf_results.append(
                {
                    "tf": label,
                    "weight": weight,
                    "error": True,
                    "struct_bias": 0,
                    "ob_dir": 0,
                    "fvg_dir": 0,
                    "swing_bias": 0,
                    "swing_bar": "--",
                    "swing_color": "neutral",
                    "struct_labels": ["--"],
                    "ema": {"dir": 0, "dist_pct": 0},
                    "ob": {"nearest_dir": 0, "nearest_dist_pct": 0},
                    "fvg": {"nearest_dir": 0, "nearest_dist_pct": 0},
                }
            )
            continue

        ema = calc_ema_trend(df)
        swing = calc_swing_hl(df)
        struct = calc_structure(df)
        ob = calc_order_blocks(df)
        fvg = calc_fvg(df)

        tf_results.append(
            {
                "tf": label,
                "weight": weight,
                "ema": ema,
                "swing_bar": swing["swing_bar"],
                "swing_color": swing["swing_color"],
                "swing": swing,
                "struct_labels": struct["struct_labels"],
                "struct_bias": struct["struct_bias"],
                "ob": ob,
                "fvg": fvg,
                "ob_dir": ob["nearest_dir"],
                "fvg_dir": fvg["nearest_dir"],
                "swing_bias": swing["swing_bias"],
            }
        )

    # Current TF data (15m) for bottom panels
    curr_df_idx = next((i for i, r in enumerate(tf_results) if r["tf"] == "15m"), 2)
    curr_tf = tf_results[curr_df_idx]
    curr_df = fetch_klines(symbol, "15m", 100)
    time.sleep(0.1)
    volume = calc_volume(curr_df)
    volatility = calc_volatility(curr_df)

    # Current price (use 1m last close)
    price_df = fetch_klines(symbol, "1m", 2)
    time.sleep(0.1)
    curr_price = float(price_df["close"].iloc[-1]) if price_df is not None else 0.0

    # HTF Levels
    htf = calc_htf_levels(symbol, curr_price)

    # Session & Killzone
    now = datetime.now(timezone.utc)
    session = get_session(now)
    killzone = get_killzone(now)

    # Bias (all TFs)
    bias = calc_bias(tf_results)

    return {
        "symbol": symbol,
        "price": curr_price,
        "timestamp": now.isoformat(),
        "tf_rows": tf_results,
        "volume": volume,
        "volatility": volatility,
        "curr_swing_bar": curr_tf.get("swing_bar", "--"),
        "curr_swing_color": curr_tf.get("swing_color", "neutral"),
        "session": session,
        "killzone": killzone,
        "bias": bias,
        "htf": htf,
    }
