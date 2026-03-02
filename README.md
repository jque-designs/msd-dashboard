# Market Structure Dashboard

Web port of the Flux Charts Market Structure Dashboard TradingView Pine Script indicator.
Built with Python (Flask) + vanilla JS. Live Binance data — no API key required.

## What It Shows

**Multi-Timeframe Table** (1m → 1w) for BTCUSDT / ETHUSDT / SOLUSDT:
- Swing H/L position bar
- Market Structure labels (HH/HL/LH/LL sequence)
- Nearest Order Block (bull/bear, distance %)
- Nearest Fair Value Gap
- EMA trend direction + distance %

**Current Timeframe (15m):** Volume state, Swing position, Volatility
**Market Context:** Session (Asian/London/NY), ICT Killzone, Weighted Trend Bias
**HTF Levels:** PDH/L, PWH/L, PMH/L with % distance from current price

## Stack
- Backend: Python / Flask (port 5001)
- Frontend: Vanilla JS, JetBrains Mono, dark theme
- Data: Binance REST API (public, no auth)
- Auto-refresh: 15 seconds

## Setup
```bash
python -m venv .venv
source .venv/bin/activate
pip install flask requests pandas
python dashboard/msd/app_msd.py
```

## Files
- `CURSOR-PROMPT.md` — full build spec for Cursor
- `source.pine` — original Flux Charts Pine Script (Mozilla Public License 2.0)
