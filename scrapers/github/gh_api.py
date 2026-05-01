"""GitHub REST API + raw README fetch.

Authenticated calls use config.GITHUB_TOKEN (lifts rate limit 60→5000/hr).
Unauthenticated calls work but are aggressively rate-limited.
"""
from __future__ import annotations

import logging
from typing import Any

import requests

from .._lib import config

log = logging.getLogger(__name__)

_TIMEOUT = 20


def _headers() -> dict[str, str]:
    h = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": config.USER_AGENT,
    }
    if config.GITHUB_TOKEN:
        h["Authorization"] = f"Bearer {config.GITHUB_TOKEN}"
    return h


def fetch_repo_meta(owner: str, repo: str) -> dict[str, Any] | None:
    """GET /repos/:owner/:repo. Returns the API JSON, or None on error.

    Only the fields we care about are read by callers; full payload returned
    for debugging.
    """
    url = f"{config.GITHUB_API_BASE}/repos/{owner}/{repo}"
    try:
        r = requests.get(url, headers=_headers(), timeout=_TIMEOUT)
        if r.status_code == 200:
            return r.json()
        log.warning("repo meta %s/%s: HTTP %s", owner, repo, r.status_code)
    except requests.RequestException as exc:
        log.warning("repo meta %s/%s: %s", owner, repo, exc)
    return None


def fetch_open_prs_count(owner: str, repo: str) -> int | None:
    """Open PRs count via search API (cheaper than paginating /pulls)."""
    url = f"{config.GITHUB_API_BASE}/search/issues"
    params = {"q": f"repo:{owner}/{repo} is:pr is:open", "per_page": 1}
    try:
        r = requests.get(url, headers=_headers(), params=params, timeout=_TIMEOUT)
        if r.status_code == 200:
            return r.json().get("total_count")
        log.warning("open PR count %s/%s: HTTP %s", owner, repo, r.status_code)
    except requests.RequestException as exc:
        log.warning("open PR count %s/%s: %s", owner, repo, exc)
    return None


def fetch_contributors_count(owner: str, repo: str) -> int | None:
    """Approximate contributors total via Link header pagination trick.

    GET /repos/:owner/:repo/contributors?per_page=1 → response Link header
    contains rel="last" with &page=N where N == contributor count. Cheap.
    """
    url = f"{config.GITHUB_API_BASE}/repos/{owner}/{repo}/contributors"
    try:
        r = requests.get(
            url, headers=_headers(), params={"per_page": 1, "anon": "true"}, timeout=_TIMEOUT
        )
        if r.status_code != 200:
            log.warning("contributors %s/%s: HTTP %s", owner, repo, r.status_code)
            return None
        link = r.headers.get("Link", "")
        # Look for rel="last" → &page=N
        import re
        m = re.search(r'page=(\d+)>;\s*rel="last"', link)
        if m:
            return int(m.group(1))
        # Single page → contributors count = body length
        body = r.json()
        return len(body) if isinstance(body, list) else None
    except requests.RequestException as exc:
        log.warning("contributors %s/%s: %s", owner, repo, exc)
        return None


def fetch_readme(owner: str, repo: str, default_branch: str | None = None) -> tuple[str, str | None]:
    """Fetch README.md raw content. Tries default_branch then 'main' then 'master'.

    Returns (content, branch_used). Empty string + None on total failure.
    """
    branches = []
    if default_branch:
        branches.append(default_branch)
    for b in ("main", "master"):
        if b not in branches:
            branches.append(b)

    for branch in branches:
        for filename in ("README.md", "readme.md", "README.MD", "Readme.md", "README"):
            url = f"https://raw.githubusercontent.com/{owner}/{repo}/{branch}/{filename}"
            try:
                r = requests.get(url, headers={"User-Agent": config.USER_AGENT}, timeout=_TIMEOUT)
                if r.status_code == 200 and r.text.strip():
                    return r.text, branch
            except requests.RequestException as exc:
                log.debug("readme %s/%s @ %s/%s: %s", owner, repo, branch, filename, exc)
    return "", None


def detect_readme_lang(readme: str, sample_chars: int = 4000) -> str:
    """Heuristic: 'zh' if CJK density ≥ 30% in first N chars, else 'en' / 'other'.

    Falls back to 'other' for empty / very short readmes.
    """
    if not readme:
        return "other"
    sample = readme[:sample_chars]
    cjk_count = sum(1 for c in sample if "一" <= c <= "鿿")
    letter_count = sum(1 for c in sample if c.isalpha())
    if letter_count < 50:
        return "other"
    if cjk_count / max(letter_count, 1) >= 0.30:
        return "zh"
    # crude: if mostly ASCII letters, call it 'en'
    ascii_letters = sum(1 for c in sample if c.isascii() and c.isalpha())
    if ascii_letters / max(letter_count, 1) >= 0.80:
        return "en"
    return "other"
