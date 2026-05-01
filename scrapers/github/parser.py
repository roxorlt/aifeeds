"""Parse https://github.com/trending?since=daily HTML.

Returns a list of dicts, one per repo on the page. Sponsor repos are flagged
but not filtered — caller decides what to do with them.
"""
from __future__ import annotations

import re
from typing import Any

from bs4 import BeautifulSoup

# DOM selectors verified against live page on 2026-05-01.
# See docs/plans/2026-05-01-github-trending-source-design.md §2 for context.
ARTICLE_SEL = "article.Box-row"
TITLE_SEL = "h2.h3 a"
DESC_SEL = "p.col-9"
LANG_SEL = "span[itemprop=programmingLanguage]"
LANG_COLOR_SEL = "span.repo-language-color"
LINK_MUTED_SEL = "a.Link--muted"           # multiple: stars + forks links
TODAY_STARS_SEL = "span.float-sm-right"     # text like "535 stars today"
SPONSOR_SEL = 'a[href^="/sponsors/"]'       # sponsor button presence
CONTRIB_AVATAR_SEL = "a[data-hovercard-type=user] img.avatar"

_WS_RE = re.compile(r"\s+")
_TODAY_STARS_RE = re.compile(r"([\d,]+)\s+stars?\s+today", re.I)
_NUM_RE = re.compile(r"[\d,]+")


def _normalize(s: str) -> str:
    return _WS_RE.sub(" ", s).strip()


def _to_int(s: str | None) -> int | None:
    if not s:
        return None
    s = s.replace(",", "").strip()
    try:
        return int(s)
    except (ValueError, TypeError):
        return None


def parse_owner_repo(href: str) -> tuple[str, str] | None:
    """'/TauricResearch/TradingAgents' → ('TauricResearch', 'TradingAgents'). None on bad input."""
    if not href or not href.startswith("/"):
        return None
    parts = [p for p in href.strip("/").split("/") if p]
    if len(parts) < 2:
        return None
    return parts[0], parts[1]


def parse_trending_html(html: str) -> list[dict[str, Any]]:
    """Parse trending HTML into list of repo dicts.

    Each dict contains the fields directly observable from the trending page.
    Per-repo enrichment (license, watchers, open issues/PRs) needs the
    GitHub API and lives in gh_api.py.
    """
    soup = BeautifulSoup(html, "html.parser")
    out: list[dict[str, Any]] = []

    for art in soup.select(ARTICLE_SEL):
        title_a = art.select_one(TITLE_SEL)
        if not title_a:
            continue
        href = title_a.get("href", "")
        ow = parse_owner_repo(href)
        if not ow:
            continue
        owner, repo = ow

        desc = art.select_one(DESC_SEL)
        description = _normalize(desc.get_text()) if desc else None

        lang_el = art.select_one(LANG_SEL)
        language = _normalize(lang_el.get_text()) if lang_el else None

        # Stars + forks come from two <a class="Link--muted"> in order.
        # First link points to /stargazers, second to /forks. Be defensive about order.
        total_stars = forks = None
        for a in art.select(LINK_MUTED_SEL):
            link_href = a.get("href", "")
            num = _to_int(a.get_text(strip=True))
            if "/stargazers" in link_href:
                total_stars = num
            elif "/forks" in link_href:
                forks = num

        # Today stars: span.float-sm-right contains text like "2,115 stars today"
        today_stars = None
        today_el = art.select_one(TODAY_STARS_SEL)
        if today_el:
            m = _TODAY_STARS_RE.search(today_el.get_text(" ", strip=True))
            if m:
                today_stars = _to_int(m.group(1))

        sponsor_btn = art.select_one(SPONSOR_SEL)
        sponsor = 1 if sponsor_btn else 0

        contributors: list[dict[str, str]] = []
        for img in art.select(CONTRIB_AVATAR_SEL):
            login = (img.get("alt") or "").lstrip("@").strip()
            avatar_url = img.get("src", "")
            if login and avatar_url:
                contributors.append({"login": login, "avatar_url": avatar_url})

        out.append(
            {
                "owner": owner,
                "repo": repo,
                "owner_repo": f"{owner}/{repo}",
                "url": f"https://github.com{href}",
                "description": description,
                "language": language,
                "total_stars": total_stars,
                "today_stars": today_stars,
                "forks": forks,
                "sponsor": sponsor,
                "contributors_inline": contributors,  # max 5 from trending page
            }
        )

    return out
