#!/usr/bin/env python3
"""一次性脚本：补抓特定 slug 的 PH 产品（应对 leaderboard 整体 rescrape
中段被 PH 限速失败的少数产品）。

用法：
  python -m scripts.rescrape_ph_slugs --date 2026-05-02 --slugs wisprflow,replit,bolt-new,granola

每个 slug 走完整 pipeline（DOM extract → judge → translate → push to D1），
并在产品之间 sleep 8s 让 PH 重置 rate-limit 计数。
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time

from scrapers._lib import config as shared_config
from scrapers.ph import (
    config,
    dom_extract,
    leaderboard as leaderboard_mod,
    llm_judge,
    parser,
    sync as sync_mod,
    translate as translate_mod,
)
from scrapers.ph.scraper import PHSession, save_snapshot

log = logging.getLogger("ph_rescrape_slugs")


def process_one(s: PHSession, slug: str, daily_rank: int, launch_date: str,
                judge: bool = True) -> dict | None:
    s.goto(config.product_url(slug))
    html = s.get_html()
    save_snapshot(slug, html)
    p = parser.parse_product_page(html)
    if not p.get("name"):
        log.warning("%s: no name in JSON-LD (page may be blocked) — skip", slug)
        return None
    p["_slug"] = slug
    p["_daily_rank"] = daily_rank
    p["_launch_date_pt"] = launch_date
    p["_url"] = config.product_url(slug)

    try:
        raw_c = s.eval_js(dom_extract.EXTRACT_COMMENTS_JS, timeout=15)
        p["all_comments_raw"] = json.loads(raw_c) if raw_c.strip() else []
    except Exception as exc:
        log.warning("%s comments extract failed: %s", slug, exc)
        p["all_comments_raw"] = []
    try:
        raw_r = s.eval_js(dom_extract.EXTRACT_REVIEWS_JS, timeout=15)
        p["all_reviews_raw"] = json.loads(raw_r) if raw_r.strip() else []
    except Exception as exc:
        log.warning("%s reviews extract failed: %s", slug, exc)
        p["all_reviews_raw"] = []

    maker_handles = {m["handle"] for m in (p.get("makers") or []) if m.get("handle")}
    maker_post = next(
        (c for c in p["all_comments_raw"] if c.get("author_handle") in maker_handles),
        None,
    )
    p["maker_post"] = maker_post
    p["maker_post_text"] = (maker_post or {}).get("body", "") if maker_post else ""
    non_maker = [c for c in p["all_comments_raw"] if c.get("author_handle") not in maker_handles]
    p["top_comments"] = [
        {
            "author_name": c.get("author_name"),
            "author_handle": c.get("author_handle"),
            "avatar_url": c.get("avatar_url"),
            "text": c.get("body"),
            "upvotes": c.get("upvotes"),
            "posted_at": c.get("posted_at"),
            "is_reply": c.get("is_reply"),
        } for c in non_maker[:10]
    ]
    p["top_reviews"] = [
        {
            "author_name": r.get("author_name"),
            "author_handle": r.get("author_handle"),
            "avatar_url": r.get("avatar_url"),
            "rating": r.get("rating"),
            "body": r.get("body"),
        } for r in p.get("all_reviews_raw", [])[:5]
    ]
    if judge:
        try:
            verdict = llm_judge.judge_product(p)
            p.update(verdict)
        except Exception as exc:
            log.warning("%s judge failed: %s", slug, exc)
            p["is_ai"] = None
    if judge and p.get("is_ai") == 1:
        try:
            translate_mod.translate_product(p)
            p["translated"] = 1
        except Exception as exc:
            log.warning("%s translate failed: %s", slug, exc)
            p["translated"] = 0
    return p


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", required=True, help="launch date PT, e.g. 2026-05-02")
    ap.add_argument("--slugs", required=True, help="comma-separated slugs")
    ap.add_argument("--push", action="store_true", default=True)
    ap.add_argument("--log-level", default="INFO")
    ap.add_argument("--pace-sec", type=int, default=8,
                    help="seconds between products to avoid PH rate-limit")
    args = ap.parse_args()

    logging.basicConfig(level=args.log_level,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    slugs = [s.strip() for s in args.slugs.split(",") if s.strip()]
    log.info("rescraping %d slugs for %s: %s", len(slugs), args.date, slugs)

    results: list[dict] = []
    with PHSession() as s:
        for i, slug in enumerate(slugs, 1):
            log.info("[%d/%d] %s", i, len(slugs), slug)
            try:
                p = process_one(s, slug, daily_rank=0, launch_date=args.date)
                if p:
                    results.append(p)
            except Exception as exc:
                log.error("%s pipeline failed: %s", slug, exc)
            if i < len(slugs):
                time.sleep(args.pace_sec)

    log.info("scraped %d/%d successfully", len(results), len(slugs))

    if args.push and results:
        try:
            r = sync_mod.push_to_d1(results)
            log.info("ingest result: %s", r)
        except Exception as exc:
            log.error("push to D1 failed: %s", exc)
            return 1

    print(json.dumps({
        "date_pt": args.date,
        "scraped": len(results),
        "products": [{
            "slug": p["_slug"],
            "name": p.get("name"),
            "is_ai": p.get("is_ai"),
            "comments": len(p.get("top_comments", [])),
            "reviews": len(p.get("top_reviews", [])),
        } for p in results],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
