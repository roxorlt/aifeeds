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
from . import leaderboard as leaderboard_mod
from .._lib import browser_utils as bu_utils

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


# ---------------------------------------------------------------------------
# PHSession — 单持久 Chrome session，跨多个 PH 页面共用
# ---------------------------------------------------------------------------
# 为什么不能 fresh-per-page：CF turnstile 按 IP 评 fresh-Chrome rate，30s 内
# 连续两次起新 session 第二次必触发挑战。同 session 内多次 navigate 共享
# fingerprint + cookie 历史，被识别为正常人浏览。dev-log.md PH 第 4 条。


class PHSession:
    """browser-use session 封装：一次开启 → loop 抓多个 page → 一次关闭。

    用法（context manager）：
        with PHSession() as s:
            s.goto("https://www.producthunt.com/products/zed")
            html_a = s.get_html()
            s.pace()
            s.goto("https://www.producthunt.com/products/postiz")
            html_b = s.get_html()
    """

    def __init__(self, render_wait_sec: int = 15, pace_sec: int = 5):
        self.render_wait_sec = render_wait_sec
        self.pace_sec = pace_sec
        self.prev_frontmost: str | None = None
        self.session_data_dir: str | None = None

    def __enter__(self) -> "PHSession":
        self.prev_frontmost = bu_utils.snapshot_frontmost()
        log.debug("[focus] prev frontmost: %s", self.prev_frontmost)
        # 兜底关掉任何残留 session
        _bu("close", timeout=10)
        # 用 PH home 暖身（建立 turnstile 信任 + 拿到 session_data_dir 路径）
        log.info("warming up session at %s", config.PH_BASE)
        _bu("--profile", config.CHROME_PROFILE, "--headed", "open",
            config.PH_BASE, timeout=60)
        bu_utils.push_chrome_to_back(self.prev_frontmost)
        self.session_data_dir = bu_utils.find_session_data_dir()
        log.debug("session data dir: %s", self.session_data_dir)
        # 等首页 turnstile 过一遍
        time.sleep(self.render_wait_sec)
        bu_utils.push_chrome_to_back(self.prev_frontmost)
        return self

    def __exit__(self, exc_type, exc, tb):
        try:
            _bu("close", timeout=15)
        finally:
            bu_utils.kill_chrome_by_data_dir(self.session_data_dir)
        log.info("session closed")

    def goto(self, url: str) -> None:
        log.info("goto %s", url)
        _bu("open", url, timeout=60)
        bu_utils.push_chrome_to_back(self.prev_frontmost)
        time.sleep(self.render_wait_sec)
        # navigate 后 Chrome 会 re-front，再 push 一次
        bu_utils.push_chrome_to_back(self.prev_frontmost)

    def get_html(self) -> str:
        raw = _bu("eval", "document.documentElement.outerHTML", timeout=30)
        return raw[len("result: "):] if raw.startswith("result: ") else raw

    def pace(self) -> None:
        """模拟人浏览节奏。CF turnstile 心跳期，避免 rate-limit 触发。"""
        log.debug("pacing %ds", self.pace_sec)
        time.sleep(self.pace_sec)


def fetch_html_via_browser_use(url: str) -> str:
    """单次抓单页 — 适用于 --slug 模式（开 session、抓一个、关 session）。

    多产品场景请用 PHSession 直接 loop 抓，不要循环调这个函数。
    """
    with PHSession() as s:
        s.goto(url)
        html = s.get_html()
    log.info("html size %d bytes", len(html))
    return html


def save_snapshot(slug: str, html: str) -> Path:
    """保存原始 HTML 到 data/ph/pages/<slug>-<ts>.html，便于复用解析 / debug。"""
    ts = int(time.time())
    path = config.SNAPSHOT_DIR / f"{slug}-{ts}.html"
    path.write_text(html, encoding="utf-8")
    log.info("snapshot → %s", path)
    return path


# ---------------------------------------------------------------------------
# Single product flow（单个抓 — 适用 --slug 调试场景）
# ---------------------------------------------------------------------------

def scrape_product(slug: str, save: bool = True) -> dict:
    """fetch + parse 一个 product 页面（独立 session），返回 canonical dict。"""
    url = config.product_url(slug)
    html = fetch_html_via_browser_use(url)
    if save:
        save_snapshot(slug, html)
    parsed = parser.parse_product_page(html)
    parsed["_url"] = url
    parsed["_slug"] = slug
    return parsed


# ---------------------------------------------------------------------------
# Leaderboard + multi-product flow — 单 session 跑完一天的所有产品
# ---------------------------------------------------------------------------

def scrape_leaderboard_day(yyyy: int, mm: int, dd: int, save_html: bool = True,
                           limit: int | None = None) -> list[dict]:
    """抓某天 PT leaderboard + 全榜每个产品。返回每个产品 parsed dict 列表。

    用单持久 PHSession（首次开启 → loop 各 product → 关闭），同 session 内
    多次 navigate 共享 fingerprint，CF turnstile rate-limit 不触发。

    `limit` 主要用于 dev/test，限制只抓前 N 个产品。生产 cron 不传 = 全抓。
    """
    lb_url = config.leaderboard_daily_url(yyyy, mm, dd)
    log.info("scraping leaderboard for %d-%02d-%02d (PT)", yyyy, mm, dd)

    with PHSession() as s:
        # 先拿 leaderboard 列表
        s.goto(lb_url)
        lb_html = s.get_html()
        if save_html:
            ts_str = f"{yyyy:04d}-{mm:02d}-{dd:02d}"
            (config.SNAPSHOT_DIR / f"leaderboard-{ts_str}.html").write_text(lb_html, encoding="utf-8")
        entries = leaderboard_mod.parse_leaderboard(lb_html)
        log.info("leaderboard %d entries: %s", len(entries),
                 ", ".join(e.slug for e in entries[:5]) + "...")
        if limit:
            entries = entries[:limit]

        # 同 session 跑每个产品
        results: list[dict] = []
        for entry in entries:
            try:
                s.pace()
                s.goto(config.product_url(entry.slug))
                html = s.get_html()
                if save_html:
                    save_snapshot(entry.slug, html)
                p = parser.parse_product_page(html)
                p["_slug"] = entry.slug
                p["_daily_rank"] = entry.daily_rank
                p["_launch_date_pt"] = f"{yyyy:04d}-{mm:02d}-{dd:02d}"
                p["_url"] = config.product_url(entry.slug)
                results.append(p)
                log.info("[%2d/%d] %s — %s (ld=%d)",
                         entry.daily_rank, len(entries), entry.slug,
                         (p.get("name") or "?"),
                         p.get("_ld_block_count", 0))
            except Exception as exc:
                log.warning("[%d] %s failed: %s", entry.daily_rank, entry.slug, exc)
                continue
    return results


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slug", help="单 product slug, 例如 zed")
    ap.add_argument("--leaderboard", help="拉某天 leaderboard, 例如 2026-05-02 (PT 日期)")
    ap.add_argument("--limit", type=int, default=None,
                    help="leaderboard 模式下限制只抓前 N 个产品（dev/test 用）")
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
        y, m, d = map(int, args.leaderboard.split("-"))
    else:
        # 默认：昨天 PT
        y, m, d = yesterday_pt()
        log.info("no --leaderboard, using yesterday PT: %d-%02d-%02d", y, m, d)

    results = scrape_leaderboard_day(y, m, d, save_html=args.save, limit=args.limit)
    print(json.dumps({
        "date_pt": f"{y:04d}-{m:02d}-{d:02d}",
        "count": len(results),
        "products": [{
            "rank": r.get("_daily_rank"),
            "slug": r.get("_slug"),
            "name": r.get("name"),
            "ld_blocks": r.get("_ld_block_count"),
            "votes": r.get("metrics", {}).get("votes"),
        } for r in results],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
