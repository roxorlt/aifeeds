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


# /products/<slug> 是产品主页（多 launch 都聚合到这页）
# /posts/<slug>   是单次 launch 页（更精确，但也可能直接给 product）
# 取 /products/ 优先，fallback /posts/
PRODUCT_LINK_RE = re.compile(r'href="(/products/([a-z0-9][a-z0-9-]*))"')
POST_LINK_RE = re.compile(r'href="(/posts/([a-z0-9][a-z0-9-]*))"')


def parse_leaderboard(html: str) -> list[LeaderboardEntry]:
    """从 leaderboard HTML 提取按 rank 排序的 entry 列表，去重保留顺序。

    NOTE: PH 一个 launch 在 leaderboard 上可能链接到 /products/<slug> 或
    /posts/<slug>。我们优先抓 /products/<slug>（更稳定 + 我们 schema 用
    product_slug 做 source_id 一部分），但相同 slug 不重复入榜。
    """
    out: list[LeaderboardEntry] = []
    seen: set[str] = set()

    # 抓所有 /products/<slug> 链接，按页面顺序
    for m in PRODUCT_LINK_RE.finditer(html):
        slug = m.group(2)
        if slug in seen:
            continue
        # 过滤明显非产品的链接（PH 自身导航 / 类别等）
        if slug in {"new", "alternatives", "reviews"}:
            continue
        seen.add(slug)
        out.append(LeaderboardEntry(
            daily_rank=len(out) + 1,
            slug=slug,
            href=m.group(1),
        ))

    # 暂没 /products/ 链接时退回 /posts/ — 这种情况不应出现，但兜底
    if not out:
        for m in POST_LINK_RE.finditer(html):
            slug = m.group(2)
            if slug in seen:
                continue
            seen.add(slug)
            out.append(LeaderboardEntry(
                daily_rank=len(out) + 1,
                slug=slug,
                href=m.group(1),
            ))

    return out
