"""Extract structured data from a PH /products/<slug> HTML.

PH 把数据塞在三个地方：
  1) JSON-LD blocks — schema.org Product / WebApplication / Review
  2) embedded GraphQL state（regex 抓 votesCount / categories / pricingType / etc.）
  3) Next.js RSC stream (self.__next_f.push) — 备用，可解析但格式复杂

Phase 2 第一版只抓 1+2，覆盖率已 80%+。3 留给后续优化。
"""
from __future__ import annotations

import json
import re
from typing import Any


# ---------------------------------------------------------------------------
# JSON-LD
# ---------------------------------------------------------------------------
LD_RE = re.compile(
    r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
    re.DOTALL,
)


def extract_ld_json_blocks(html: str) -> list[dict[str, Any]]:
    """All <script type="application/ld+json"> blocks parsed as dicts."""
    blocks: list[dict[str, Any]] = []
    for raw in LD_RE.findall(html):
        try:
            d = json.loads(raw.strip())
            if isinstance(d, dict):
                blocks.append(d)
        except json.JSONDecodeError:
            continue
    return blocks


def find_webapplication_block(blocks: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The block with `@type` containing "WebApplication" or "Product" — has main fields."""
    for b in blocks:
        t = b.get("@type")
        types = t if isinstance(t, list) else [t]
        if "WebApplication" in types or "Product" in types:
            # 有 name / description 的才算主块（避免 positiveNotes-only 子块）
            if b.get("name") and b.get("description"):
                return b
    return None


def find_review_block(blocks: list[dict[str, Any]]) -> dict[str, Any] | None:
    for b in blocks:
        t = b.get("@type")
        if t == "Product" and "review" in b:
            return b
    return None


# ---------------------------------------------------------------------------
# Embedded state regex (GraphQL-ish JSON inlined in NextJS bundle)
# ---------------------------------------------------------------------------

def extract_first(html: str, pattern: str) -> str | None:
    m = re.search(pattern, html)
    return m.group(1) if m else None


def extract_metrics(html: str) -> dict[str, Any]:
    """votes / comments / reviews / followers — 取第一次出现（页面顶部主产品）。

    注意：votesCount 可能是 launch 维度（每次 launch 独立计数），
    而 followersCount / reviewsCount 是 product 维度累计。
    """
    return {
        "votes": _to_int(extract_first(html, r'"votesCount":\s*(\d+)')),
        "comments_count": _to_int(extract_first(html, r'"commentsCount":\s*(\d+)')),
        "reviews_count": _to_int(extract_first(html, r'"reviewsCount":\s*(\d+)')),
        "followers": _to_int(extract_first(html, r'"followersCount":\s*(\d+)')),
        "pricing_type": extract_first(html, r'"pricingType":\s*"([^"]+)"'),
    }


def _to_int(v: str | None) -> int | None:
    return int(v) if v is not None else None


def extract_categories(html: str) -> list[dict[str, str]]:
    """主产品的 PH 原生 categories。

    **现状（Phase 2 v1 留空）**：PH 页面里有 ~10 个 `"categories":[...]` 数组：
    主产品 1 个 + 相关产品 9 个 + featuredCategories / trendingCategories。
    单凭正则识别哪个是主产品的不可靠，需要解析 NextJS RSC stream 找到带
    主产品 slug 的那一项。

    短期方案：返回空列表，让 LLM judge 输出的 `ai_category` 顶上（mockup
    上 chip 用 LLM 分类，UI 不依赖原生 categories）。

    见 docs/dev-log.md PH 第二条。
    """
    return []


# ---------------------------------------------------------------------------
# Convenience: end-to-end parse
# ---------------------------------------------------------------------------

def parse_product_page(html: str) -> dict[str, Any]:
    """所有可解析字段塞进一个 dict 返回。"""
    blocks = extract_ld_json_blocks(html)
    main = find_webapplication_block(blocks) or {}
    metrics = extract_metrics(html)
    cats = extract_categories(html)

    # makers / hunter (author[] in WebApplication block)
    authors = main.get("author", [])
    if isinstance(authors, dict):
        authors = [authors]
    makers = []
    for a in authors:
        if not isinstance(a, dict):
            continue
        url = a.get("url", "")
        handle = url.rsplit("/@", 1)[-1] if "/@" in url else ""
        makers.append({
            "name": a.get("name"),
            "handle": handle,
            "avatar_url": a.get("image"),
            "profile_url": url,
        })

    rating = main.get("aggregateRating") or {}
    return {
        "name": main.get("name"),
        "tagline": main.get("description"),
        "image": main.get("image"),
        "screenshots": main.get("screenshot", []),
        "datePublished": main.get("datePublished"),
        "dateModified": main.get("dateModified"),
        "applicationCategory": main.get("applicationCategory"),
        "operatingSystem": main.get("operatingSystem"),
        "rating_value": rating.get("ratingValue"),
        "rating_count": rating.get("ratingCount"),
        "makers": makers,
        "metrics": metrics,
        "categories": cats,
        "_ld_block_count": len(blocks),
    }
