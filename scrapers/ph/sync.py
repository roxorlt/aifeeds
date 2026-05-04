"""Push 抓好的 PH 产品 dict 到 D1 via worker /api/ingest。

PH 产品 dict 字段映射到 IngestPayload.ItemInput：
  source_type: 'product_hunt'
  source_id:   <slug>:<launch_date_pt>          ← 复合键，design § 2.1
  title:       name
  content:     tagline                          ← 短描述
  content_translated: tagline_translated
  author:      makers[0].name                   ← 第一 maker
  handle:      makers[0].handle
  url:         https://www.producthunt.com/products/<slug>
  media:       gallery (logo + screenshots + video URLs JSON)
  metrics:     {votes, comments, reviews_count, reviews_avg, followers}
  published_at: datePublished (ISO)
  scraped_at:  now
  is_relevant: is_ai (0/1)
  lang:        'en' (default — PH 内容 99% 英文)
  extra:       全部其他源特异字段（design § 2.2）
"""
from __future__ import annotations

import json
import logging
import os
import time
from typing import Any

import requests

from .._lib import config

log = logging.getLogger(__name__)

INGEST_URL_DEFAULT = os.environ.get(
    "AIFEEDS_INGEST_URL",
    "https://xlist-api.ltsms86.workers.dev/api/ingest",
)
# 多个 env 名兼容：XLIST_INGEST_TOKEN（X scraper 现存约定）/
# AIFEEDS_INGEST_TOKEN（更通用名）/ INGEST_TOKEN（裸名）。
def _read_token() -> str:
    for k in ("XLIST_INGEST_TOKEN", "AIFEEDS_INGEST_TOKEN", "INGEST_TOKEN"):
        v = os.environ.get(k, "")
        if v:
            return v
    return ""


def product_to_item(p: dict[str, Any]) -> dict[str, Any]:
    """PH product dict (parser+dom_extract+llm_judge+translate 输出) → ItemInput shape。"""
    slug = p.get("_slug", "")
    launch_date = p.get("_launch_date_pt", "")
    source_id = f"{slug}:{launch_date}"

    makers = p.get("makers") or []
    first_maker = makers[0] if makers else {}

    metrics_obj = p.get("metrics") or {}
    rating_value = p.get("rating_value")
    rating_count = p.get("rating_count")
    metrics_for_db = {
        "votes": metrics_obj.get("votes"),
        "comments": metrics_obj.get("comments_count"),
        "reviews_count": rating_count or metrics_obj.get("reviews_count"),
        "reviews_avg": float(rating_value) if rating_value is not None else None,
        "followers": metrics_obj.get("followers"),
    }

    media = []
    if p.get("image"):
        media.append({"type": "image", "url": p["image"], "role": "logo"})
    for s in (p.get("screenshots") or []):
        media.append({"type": "image", "url": s, "role": "gallery"})

    extra = {
        "daily_rank": p.get("_daily_rank"),
        "launch_date_pt": launch_date,
        "product_slug": slug,
        "ph_url": p.get("_url"),
        "website_url": None,  # PH 不直接给（要从 'Get it' 按钮抓，下一步）
        "description": p.get("tagline"),
        "pricing_type": metrics_obj.get("pricing_type"),
        "is_open_source": (p.get("applicationCategory") == "Open Source"),
        "categories": p.get("categories") or [],
        "makers": makers,
        "hunter": p.get("hunter"),
        "ai_summary": p.get("ai_summary"),
        "ai_category": p.get("ai_category"),
        "maker_post_text": p.get("maker_post_text"),
        "maker_post_translated": p.get("maker_post_translated"),
        "maker_post": p.get("maker_post"),
        "top_comments": p.get("top_comments") or [],
        "top_reviews": p.get("top_reviews") or [],
    }

    scraped_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    return {
        "source_type": "product_hunt",
        "source_id": source_id,
        "title": p.get("name"),
        "content": p.get("tagline"),
        "content_translated": p.get("tagline_translated"),
        "author": first_maker.get("name"),
        "handle": first_maker.get("handle"),
        "url": p.get("_url"),
        "media": media,
        "metrics": metrics_for_db,
        "published_at": p.get("datePublished"),
        "scraped_at": scraped_at,
        "is_relevant": p.get("is_ai"),
        "matched_by": "llm_judge_ph",
        "lang": "en",
        "extra": extra,
    }


def push_to_d1(products: list[dict[str, Any]],
               url: str = INGEST_URL_DEFAULT,
               token: str | None = None) -> dict[str, Any]:
    """批量 POST 到 /api/ingest。返回 worker 的 response。"""
    if token is None:
        token = _read_token()
    if not token:
        raise RuntimeError(
            "ingest token missing — set XLIST_INGEST_TOKEN / AIFEEDS_INGEST_TOKEN / INGEST_TOKEN in env or .env"
        )
    items = [product_to_item(p) for p in products if p.get("name")]
    payload = {
        "source": {"id": "product_hunt"},
        "items": items,
    }
    log.info("pushing %d items to %s", len(items), url)
    resp = requests.post(
        url,
        json=payload,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"ingest failed {resp.status_code}: {resp.text[:300]}")
    return resp.json()
