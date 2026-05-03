"""PH leaderboard 抓取 + 解析。

URL 形如 /leaderboard/daily/<Y>/<M>/<D>（PT 时区）。返回当日 30+ 个 launch
的 slug 列表 + daily rank。

实现思路：
  1. 用 PHSession.goto 拉 leaderboard HTML
  2. 正则提取 product/launch links（`/products/<slug>` 或 `/posts/<slug>`）
  3. 配 daily rank 序号
"""
from __future__ import annotations

import logging
import re
from dataclasses import dataclass

log = logging.getLogger(__name__)


@dataclass
class LeaderboardEntry:
    daily_rank: int
    slug: str
    href: str


# PH 偶尔会对 bot UA 返回 LLM-friendly 的 plain text 格式（"# Best of
# Product Hunt: ..."），用 markdown 列表 + 完整 URL；正常情况返回 HTML
# 用 href="/products/...". 双格式兼容：
#   1) href="/products/<slug>"          (HTML)
#   2) https://www.producthunt.com/products/<slug>  (text)
#   3) /posts/<slug>                     (旧格式 fallback)
PRODUCT_LINK_RE = re.compile(
    r'(?:href="/products/|https?://(?:www\.)?producthunt\.com/products/)([a-z0-9][a-z0-9-]*)'
)
POST_LINK_RE = re.compile(
    r'(?:href="/posts/|https?://(?:www\.)?producthunt\.com/posts/)([a-z0-9][a-z0-9-]*)'
)


def parse_leaderboard(html: str) -> list[LeaderboardEntry]:
    """从 leaderboard HTML 提取按 rank 排序的 entry 列表，去重保留顺序。

    NOTE: PH 一个 launch 在 leaderboard 上可能链接到 /products/<slug> 或
    /posts/<slug>。我们优先抓 /products/<slug>（更稳定 + 我们 schema 用
    product_slug 做 source_id 一部分），但相同 slug 不重复入榜。
    """
    out: list[LeaderboardEntry] = []
    seen: set[str] = set()

    # 抓所有 /products/<slug>，按页面顺序
    for m in PRODUCT_LINK_RE.finditer(html):
        slug = m.group(1)
        if slug in seen:
            continue
        # 过滤明显非产品的链接（PH 自身导航 / 类别等）
        if slug in {"new", "alternatives", "reviews"}:
            continue
        seen.add(slug)
        out.append(LeaderboardEntry(
            daily_rank=len(out) + 1,
            slug=slug,
            href=f"/products/{slug}",
        ))

    # 暂没 /products/ 链接时退回 /posts/ — 这种情况不应出现，但兜底
    if not out:
        for m in POST_LINK_RE.finditer(html):
            slug = m.group(1)
            if slug in seen:
                continue
            seen.add(slug)
            out.append(LeaderboardEntry(
                daily_rank=len(out) + 1,
                slug=slug,
                href=f"/posts/{slug}",
            ))

    return out
