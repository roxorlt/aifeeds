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


def _bu(*args: str, timeout: int = 30) -> str:
    """browser-use CLI 子进程，stateful session — 第一次 `open` 起 session，
    后续 `eval` / `close` 共享 session。"""
    cmd = [config.BU_BIN] + list(args)
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        log.warning("bu %s failed (%d): %s", args[0], proc.returncode, proc.stderr[-300:])
    return proc.stdout


def fetch_html_via_browser_use(url: str, render_wait_sec: int = 8) -> str:
    """打开 PH 页面，等渲染后取完整 DOM。

    流程：
      1. `bu --profile "Profile 1" --headed open <url>` — 用已登录 Profile 1
         启动 headed Chrome，cookies 自动跟随，turnstile 看到合法 cookie 放行
      2. sleep render_wait_sec 等 NextJS RSC 流式 + turnstile 解
      3. `bu eval 'document.documentElement.outerHTML'` 拿渲染后 HTML
      4. `bu close` 收尾（finally 块兜底）

    NOTE: 暂未集成 focus push-back / kill-by-data-dir（X scraper 已有完整
    实现，下一步 commit 复用过来）。当前测试如果发现 Chrome 抢焦点严重，
    手动 close 后再讨论。
    """
    log.info("fetching %s", url)
    t0 = time.time()
    try:
        # 启动 session
        _bu("--profile", config.CHROME_PROFILE, "--headed", "open", url, timeout=60)
        # 等渲染（包含 turnstile 解 + RSC 流）
        time.sleep(render_wait_sec)
        # 取 HTML — bu eval 输出包含 'result: ' 前缀（参考 X scraper 同处理）
        raw = _bu("eval", "document.documentElement.outerHTML", timeout=20)
        html = raw[len("result: "):] if raw.startswith("result: ") else raw
    finally:
        _bu("close", timeout=15)
    elapsed = time.time() - t0
    log.info("fetched in %.1fs, html size %d bytes", elapsed, len(html))
    return html


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
