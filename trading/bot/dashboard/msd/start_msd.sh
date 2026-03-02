#!/bin/bash
# Correct venv path: trading/.venv (NOT trading/bot/.venv — that doesn't exist)
cd "$(dirname "$0")"
source /home/ubuntu/clawd-biz/trading/.venv/bin/activate 2>/dev/null || true
python app_msd.py
