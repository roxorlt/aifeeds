"""Shared config for ai-feeds scrapers.

Reads env from .env at the project root (旧 chrome skill 路径已退役 2026-05-06
as a fallback so dev keys can be shared with the X scraper during early days).

Required:
  GITHUB_TOKEN          GitHub PAT, public_repo scope. Lifts API rate limit 60→5000/hr.
  DEEPSEEK_API_KEY      DeepSeek for LLM judge + summary.

Optional:
  PUSHDEER_KEYS         Comma-separated PushDeer keys for failure notifications.
                        e.g. "PDU394...iPhone,PDU394...Mac"
"""
from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent  # ai-feeds repo root

# Try project .env first, then fall back to skills xlist-scraper .env
_PROJECT_ENV = PROJECT_ROOT / ".env"
_FALLBACK_ENV = Path.home() / ".claude" / "skills" / "xlist-scraper" / "scripts" / ".env"

if _PROJECT_ENV.exists():
    load_dotenv(_PROJECT_ENV)
elif _FALLBACK_ENV.exists():
    load_dotenv(_FALLBACK_ENV)

# DB
DATA_DIR = PROJECT_ROOT / "data"
DB_PATH = DATA_DIR / "aifeeds.db"

# Secrets
GITHUB_TOKEN = os.environ.get("GITHUB_TOKEN", "")
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_BASE_URL = "https://api.deepseek.com/v1"
DEEPSEEK_MODEL = "deepseek-v4-flash"

PUSHDEER_KEYS_RAW = os.environ.get("PUSHDEER_KEYS", "")
PUSHDEER_KEYS = [k.strip() for k in PUSHDEER_KEYS_RAW.split(",") if k.strip()]
PUSHDEER_ENDPOINT = "https://api2.pushdeer.com/message/push"

# Cron-tuned hardcoded fallback PushDeer keys (admin's own devices) for early days
# before PUSHDEER_KEYS env is wired up. Move to env-only once verified.
_HARDCODED_PUSHDEER_KEYS = [
    "PDU39431TnkGWKTVjyTTSb1s2lcMVPuzKRPk2Fv0J",  # iPhone
    "PDU39432TXJ3Dn7LYZdpVKVn9yBMoExBvwAIdjGN4",  # Mac
]
if not PUSHDEER_KEYS:
    PUSHDEER_KEYS = _HARDCODED_PUSHDEER_KEYS

# GitHub
GITHUB_TRENDING_URL = "https://github.com/trending?since=daily"
GITHUB_API_BASE = "https://api.github.com"
USER_AGENT = "ai-feeds-scraper/0.1 (+https://github.com/roxorlt)"
