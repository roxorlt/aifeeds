"""Product Hunt scraper config — URLs, paths, browser settings.

PH 站走 Cloudflare turnstile，必须用 Chrome 渲染 + cookie 注入。
跟 X scraper 同款方式：browser-use CLI (subprocess) + 用户已登录的
Chrome profile，turnstile 看到合法 cookie 自动放行。
"""
from __future__ import annotations

from pathlib import Path

# ---------------------------------------------------------------------------
# URLs
# ---------------------------------------------------------------------------
PH_BASE = "https://www.producthunt.com"


def leaderboard_daily_url(yyyy: int, mm: int, dd: int) -> str:
    """例: leaderboard/daily/2026/5/2 (PT 时区)"""
    return f"{PH_BASE}/leaderboard/daily/{yyyy}/{mm}/{dd}"


def product_url(slug: str) -> str:
    """例: /products/zed"""
    return f"{PH_BASE}/products/{slug}"


# ---------------------------------------------------------------------------
# Browser-use CLI
# ---------------------------------------------------------------------------
BU_BIN = str(Path.home() / ".browser-use-env" / "bin" / "browser-use")

# Use the user's existing Chrome profile (Profile 1) — already logged in to
# PH, cookies pass turnstile. Same convention as X scraper.
CHROME_PROFILE = "Profile 1"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36"
)

# 单页等 turnstile + 渲染的最大时长
PAGE_LOAD_TIMEOUT_SEC = 30

# 跑后保留 HTML 快照便于调试 / 二次解析
SNAPSHOT_DIR = Path(__file__).resolve().parent.parent.parent / "data" / "ph" / "pages"
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
