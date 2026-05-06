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
    """votes / comments / reviews / followers 抓取。

    votesCount 是 launch 维度（每次 launch 独立计数）；followersCount /
    reviewsCount 是 product 维度累计。

    旧逻辑取"第一个 votesCount" 在多 launch 老产品上错抓老 launch 的
    （Filect / Framer / Manus 等知名产品有过多次 PH 发布，第一个 launch
    的 votesCount 可能为 0 或老票数）。新策略：抓所有 votesCount 取
    **最后一个非零** —— PH RSC stream 通常按 launch 时间顺序，最后是
    当前 active launch；非零兜底个别 launch 字段缺失。
    """
    all_votes = [int(m.group(1)) for m in re.finditer(r'"votesCount":\s*(\d+)', html)]
    if all_votes:
        nonzero = [v for v in all_votes if v > 0]
        votes = nonzero[-1] if nonzero else all_votes[-1]
    else:
        votes = None
    return {
        "votes": votes,
        "comments_count": _to_int(extract_first(html, r'"commentsCount":\s*(\d+)')),
        "reviews_count": _to_int(extract_first(html, r'"reviewsCount":\s*(\d+)')),
        "followers": _to_int(extract_first(html, r'"followersCount":\s*(\d+)')),
        "pricing_type": extract_first(html, r'"pricingType":\s*"([^"]+)"'),
    }


def _to_int(v: str | None) -> int | None:
    return int(v) if v is not None else None


# ---------------------------------------------------------------------------
# Video — JSON-LD 不暴露视频，在 PH 页内 RSC stream 里塞 GraphQL 风格的
# Media block（每个 Media 有 __typename / metadata / mediaType / imageUuid 等）。
# 视频典型形态：
#   {"__typename":"Media",
#    "metadata":{"__typename":"MediaMetadata",
#                "url":"https://youtu.be/<videoId>" | "https://...mp4",
#                "platform":"youtube" | "vimeo" | null,
#                "videoId":"<id>" | null,
#                "thumbnailWidth":null,"thumbnailHeight":null,...},
#    "mediaType":"video",
#    "imageUuid":"<uuid>.jpeg",   # → poster: https://ph-files.imgix.net/<uuid>
#    "originalWidth":200,"originalHeight":113}
# 同 video 在页面里 mobile/desktop 双渲染会出现两次，按 (url, imageUuid) 去重。
# ---------------------------------------------------------------------------

# 抓 Media 块：__typename:Media + metadata + mediaType + imageUuid
# 用 lookahead 抓到 imageUuid 字段就够，metadata 内嵌的 } 不影响（regex 不
# 需要平衡括号，按字段名分别提）。
_MEDIA_BLOCK_RE = re.compile(
    r'"__typename":"Media","metadata":\{[^}]{0,400}\},"id":"\d+","imageUuid":"([^"]+)","mediaType":"(\w+)"'
)
_VIDEO_URL_RE = re.compile(r'"url":"([^"]+)","platform":"([^"]*)","videoId":"([^"]*)"')


def extract_videos(html: str) -> list[dict[str, Any]]:
    """从 RSC stream 抓 mediaType=video 的 Media 块。返回去重后的视频列表。

    每个视频 dict 字段：
      url:       原始 URL（YouTube / Vimeo embed link 或直链 mp4）
      platform:  "youtube" / "vimeo" / "" (空字符串表示直链 mp4)
      video_id:  YouTube/Vimeo videoId（platform=youtube/vimeo 时有值）
      poster_url: PH imgix CDN 的封面图（用 imageUuid 拼）
    """
    out: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for m in _MEDIA_BLOCK_RE.finditer(html):
        image_uuid = m.group(1)
        media_type = m.group(2)
        if media_type != "video":
            continue
        # 同 block 内拿 url / platform / videoId
        block = html[max(0, m.start() - 400):m.end()]
        url_match = _VIDEO_URL_RE.search(block)
        if not url_match:
            continue
        url = url_match.group(1)
        platform = url_match.group(2)
        video_id = url_match.group(3)
        if not url:
            continue
        key = (url, image_uuid)
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "url": url,
            "platform": platform,
            "video_id": video_id,
            "poster_url": f"https://ph-files.imgix.net/{image_uuid}?auto=format",
        })
    return out


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
    videos = extract_videos(html)
    return {
        "name": main.get("name"),
        "tagline": main.get("description"),
        "image": main.get("image"),
        "screenshots": main.get("screenshot", []),
        "videos": videos,
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
