#!/usr/bin/env python3
"""一次性脚本：从已 saved 的 PH product HTML 直接 parse + judge + translate +
push 到 D1，不再开浏览器抓。

应对场景：scrape session 被 turnstile 卡了，但本地有早先抓好的 snapshot。
本脚本只是为了快速验证 video 抓取链路，所以 top_comments / top_reviews
留空（DOM 抓取需要 live browser，HTML 里也有但 selector 已经在 dom_extract
JS 里写过，本脚本懒得复用）——video 字段从 HTML regex 直接抠。

用法：
  XLIST_INGEST_TOKEN=$STAGING_TOKEN \
    AIFEEDS_INGEST_URL=https://staging-api.ai-feeds.com/api/ingest \
    python -m scripts.push_ph_from_html --html data/ph/pages/screen-studio-1777919506.html \
      --slug screen-studio --date 2026-05-02 --rank 1 [--no-judge]
"""
from __future__ import annotations

import argparse
import json
import logging
import sys

from scrapers.ph import (
    config,
    llm_judge,
    parser as ph_parser,
    sync as sync_mod,
    translate as translate_mod,
)

log = logging.getLogger("ph_push_from_html")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--html", required=True, action="append",
                    help="HTML snapshot path (可多次指定)")
    ap.add_argument("--slug", required=True, action="append",
                    help="对应 slug (顺序与 --html 一致)")
    ap.add_argument("--date", required=True, help="launch_date_pt YYYY-MM-DD")
    ap.add_argument("--rank", type=int, action="append", default=None,
                    help="daily_rank (可多次指定，与 --html 顺序一致)")
    ap.add_argument("--no-judge", action="store_true")
    ap.add_argument("--log-level", default="INFO")
    args = ap.parse_args()

    logging.basicConfig(level=args.log_level,
                        format="%(asctime)s %(levelname)s %(name)s %(message)s")

    if len(args.html) != len(args.slug):
        log.error("--html 和 --slug 数量必须一致")
        return 1
    ranks = args.rank or [i + 1 for i in range(len(args.slug))]
    if len(ranks) != len(args.slug):
        log.error("--rank 数量必须和 --slug 一致")
        return 1

    results: list[dict] = []
    for html_path, slug, rank in zip(args.html, args.slug, ranks):
        log.info("parsing %s (slug=%s)", html_path, slug)
        with open(html_path, encoding="utf-8") as f:
            html = f.read()
        p = ph_parser.parse_product_page(html)
        if not p.get("name"):
            log.warning("%s: no name in JSON-LD, skip", slug)
            continue
        p["_slug"] = slug
        p["_daily_rank"] = rank
        p["_launch_date_pt"] = args.date
        p["_url"] = config.product_url(slug)
        # DOM-抓的字段无 live browser 时填空（focus 在 video 抓取链路）
        p["all_comments_raw"] = []
        p["top_comments"] = []
        p["top_reviews"] = []
        p["maker_post"] = None
        p["maker_post_text"] = ""

        if not args.no_judge:
            try:
                verdict = llm_judge.judge_product(p)
                p.update(verdict)
            except Exception as exc:
                log.warning("%s judge failed: %s", slug, exc)
                p["is_ai"] = None
            if p.get("is_ai") == 1:
                try:
                    translate_mod.translate_product(p)
                    p["translated"] = 1
                except Exception as exc:
                    log.warning("%s translate failed: %s", slug, exc)
        videos = p.get("videos") or []
        log.info("%s: name=%r videos=%d (platforms=%s)",
                 slug, p.get("name"), len(videos),
                 [v.get("platform") for v in videos])
        results.append(p)

    if not results:
        log.error("no products parsed; abort")
        return 1

    r = sync_mod.push_to_d1(results)
    log.info("ingest result: %s", r)
    print(json.dumps({
        "scraped": len(results),
        "products": [{
            "slug": p["_slug"],
            "name": p.get("name"),
            "is_ai": p.get("is_ai"),
            "videos": len(p.get("videos") or []),
        } for p in results],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
