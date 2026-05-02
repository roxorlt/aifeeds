"""Product Hunt scraper — Phase 2 skeleton.

目前实现：
  ✅ leaderboard URL builder（PT 日期）
  ✅ 单 product 页面 fetch（browser-use CLI subprocess）
  ✅ JSON-LD + 嵌入 state 解析
  ⬜ leaderboard list parse → product slugs（HTML 待加）
  ⬜ LLM judge / 翻译
  ⬜ Top 10 评论 / Top 5 reviews / maker post 抓取
  ⬜ R2 资源迁移 + sync 到 D1

Run:
  ~/.browser-use-env/bin/python3 -m scrapers.ph.scraper --slug=zed
  ~/.browser-use-env/bin/python3 -m scrapers.ph.scraper --leaderboard=2026-05-02

第一阶段目的：验证 browser-use CLI + 已登录 Chrome profile 能否过 PH turnstile。
预期：cookie 注入后 turnstile 自动放行（同 X scraper 同款）。
"""
from __future__ import annotations

import argparse
import json
import logging
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

from . import config
from . import parser

log = logging.getLogger("ph_scraper")

PT = timezone(timedelta(hours=-7))  # PDT；冬令时是 -8 (PST)


def yesterday_pt() -> tuple[int, int, int]:
    """昨日 PT 日期，用于 cron 日常拉数据（D+1 模式）。"""
    now = datetime.now(tz=PT)
    yesterday = now - timedelta(days=1)
    return yesterday.year, yesterday.month, yesterday.day


def fetch_html_via_browser_use(url: str, timeout_sec: int = config.PAGE_LOAD_TIMEOUT_SEC) -> str:
    """调用 browser-use CLI 打开 URL → 注入用户 Chrome cookie → 等渲染 → 返回 HTML。

    关键 flag：
      --user-data-dir <Chrome 默认 profile> 让 cookie 走真实账号
      --headless=False 因为 turnstile 对 headless 评分低
      --eval 'document.documentElement.outerHTML' 拿渲染后 HTML
    """
    log.info("fetching %s", url)
    # eval 拿 HTML（输出到 stdout 捕获）
    cmd = [
        config.BU_BIN, "open", url,
        "--wait", str(timeout_sec),
        "--eval", "document.documentElement.outerHTML",
    ]
    t0 = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout_sec + 30)
    elapsed = time.time() - t0
    if proc.returncode != 0:
        log.error("browser-use exit %d after %.1fs\nstderr: %s",
                  proc.returncode, elapsed, proc.stderr[-500:])
        raise RuntimeError(f"browser-use failed: {proc.returncode}")
    log.info("fetched in %.1fs, html size %d bytes", elapsed, len(proc.stdout))
    return proc.stdout


def save_snapshot(slug: str, html: str) -> Path:
    """保存原始 HTML 到 data/ph/pages/<slug>-<ts>.html，便于复用解析 / debug。"""
    ts = int(time.time())
    path = config.SNAPSHOT_DIR / f"{slug}-{ts}.html"
    path.write_text(html, encoding="utf-8")
    log.info("snapshot → %s", path)
    return path


# ---------------------------------------------------------------------------
# Single product flow（POC level，后续接 LLM + DB）
# ---------------------------------------------------------------------------

def scrape_product(slug: str, save: bool = True) -> dict:
    """fetch + parse 一个 product 页面，返回 canonical dict。"""
    url = config.product_url(slug)
    html = fetch_html_via_browser_use(url)
    if save:
        save_snapshot(slug, html)
    parsed = parser.parse_product_page(html)
    parsed["_url"] = url
    parsed["_slug"] = slug
    return parsed


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", help="单 product slug, 例如 zed")
    ap.add_argument("--leaderboard", help="拉某天 leaderboard, 例如 2026-05-02")
    ap.add_argument("--save/--no-save", dest="save", default=True)
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(
        level=args.log_level,
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    if args.slug:
        result = scrape_product(args.slug, save=args.save)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0

    if args.leaderboard:
        # TODO: parse leaderboard list HTML → product slugs → loop scrape_product
        y, m, d = map(int, args.leaderboard.split("-"))
        url = config.leaderboard_daily_url(y, m, d)
        print(f"would fetch {url} — leaderboard parse 还没实现", file=sys.stderr)
        return 1

    # 默认行为：拉昨天的 PT 榜单
    y, m, d = yesterday_pt()
    url = config.leaderboard_daily_url(y, m, d)
    print(f"would fetch {url} (yesterday PT) — 还没实现 leaderboard parse", file=sys.stderr)
    print("pass --slug=<slug> 单跑一个产品测 turnstile / 解析", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
