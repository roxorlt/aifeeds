"""GitHub trending AI scraper — main orchestration.

Pipeline (PR-1, no LLM yet):
  fetch trending HTML → parse → for each repo:
    - exists in DB? append metrics + update last_seen
    - new? GitHub API enrich (license, watchers, PRs, contributors, readme)
            → INSERT github_repos + first metrics row

LLM judge + daily_rank ranking land in PR-2.

Run:
  ~/.browser-use-env/bin/python3 -m scrapers.github.scraper --dry-run
  ~/.browser-use-env/bin/python3 -m scrapers.github.scraper           # write DB
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone, timedelta
from typing import Any

import requests

from .._lib import config, db
from . import gh_api, parser

log = logging.getLogger("github_scraper")

BJT = timezone(timedelta(hours=8))


def bjt_date_str(ts: int | None = None) -> str:
    """Unix ts → 'YYYY-MM-DD' in Beijing time."""
    if ts is None:
        ts = int(time.time())
    dt = datetime.fromtimestamp(ts, tz=BJT)
    return dt.strftime("%Y-%m-%d")


def fetch_trending() -> str:
    """GET github.com/trending?since=daily, return HTML."""
    r = requests.get(
        config.GITHUB_TRENDING_URL,
        headers={"User-Agent": config.USER_AGENT},
        timeout=20,
    )
    r.raise_for_status()
    return r.text


def enrich_repo(repo: dict[str, Any]) -> dict[str, Any]:
    """Augment a parsed repo dict with GitHub API data + README."""
    owner, name = repo["owner"], repo["repo"]

    meta = gh_api.fetch_repo_meta(owner, name) or {}
    license_obj = meta.get("license") or {}

    repo["license_spdx"] = license_obj.get("spdx_id") if license_obj else None
    repo["default_branch"] = meta.get("default_branch")
    repo["watchers"] = meta.get("subscribers_count")
    repo["open_issues"] = meta.get("open_issues_count")
    # API description as fallback (trending sometimes truncates)
    if not repo.get("description") and meta.get("description"):
        repo["description"] = meta["description"]

    repo["open_prs"] = gh_api.fetch_open_prs_count(owner, name)
    repo["contributors_count"] = gh_api.fetch_contributors_count(owner, name)

    readme, branch_used = gh_api.fetch_readme(owner, name, repo["default_branch"])
    repo["readme_excerpt"] = readme
    repo["readme_lang"] = gh_api.detect_readme_lang(readme)
    repo["readme_fetched_at"] = int(time.time()) if readme else None
    if branch_used and not repo.get("default_branch"):
        repo["default_branch"] = branch_used

    return repo


def insert_new_repo(conn, repo: dict[str, Any], now_ts: int, today_str: str) -> None:
    """INSERT a freshly-discovered repo into github_repos. is_ai/ai_summary
    stay NULL — PR-2 LLM judge fills them."""
    conn.execute(
        """
        INSERT INTO github_repos (
            owner_repo, url, owner, repo,
            description, language, license_spdx, default_branch,
            total_stars_first, today_stars_first, forks_first, watchers_first,
            is_ai, ai_category, ai_summary, llm_raw_response, llm_model, llm_called_at,
            readme_excerpt, readme_lang, readme_translated, readme_fetched_at,
            contributors_json, contributors_count,
            sponsor, emitted,
            daily_rank, trending_date_str,
            first_trending_at, first_scraped_at, last_seen_on_trending_at, last_pushed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL,
                  ?, ?, NULL, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, NULL)
        """,
        (
            repo["owner_repo"], repo["url"], repo["owner"], repo["repo"],
            repo.get("description"), repo.get("language"),
            repo.get("license_spdx"), repo.get("default_branch"),
            repo.get("total_stars"), repo.get("today_stars"),
            repo.get("forks"), repo.get("watchers"),
            repo.get("readme_excerpt"), repo.get("readme_lang"), repo.get("readme_fetched_at"),
            json.dumps(repo.get("contributors_inline", []), ensure_ascii=False),
            repo.get("contributors_count"),
            repo.get("sponsor", 0),
            today_str,
            now_ts, now_ts, now_ts,
        ),
    )


def update_seen(conn, owner_repo: str, now_ts: int) -> None:
    conn.execute(
        "UPDATE github_repos SET last_seen_on_trending_at = ? WHERE owner_repo = ?",
        (now_ts, owner_repo),
    )


def insert_metrics(conn, repo: dict[str, Any], now_ts: int, today_str: str) -> None:
    conn.execute(
        """
        INSERT OR IGNORE INTO github_repo_metrics (
            owner_repo, measured_at, trending_date_str,
            total_stars, today_stars, forks, watchers, open_issues, open_prs
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            repo["owner_repo"], now_ts, today_str,
            repo.get("total_stars"), repo.get("today_stars"), repo.get("forks"),
            repo.get("watchers"), repo.get("open_issues"), repo.get("open_prs"),
        ),
    )


def run(dry_run: bool = False) -> dict[str, int]:
    """Single cron tick. Returns counts for logging."""
    db.init_db()

    log.info("fetching %s", config.GITHUB_TRENDING_URL)
    html = fetch_trending()
    parsed = parser.parse_trending_html(html)
    log.info("parsed %d repos", len(parsed))

    now_ts = int(time.time())
    today = bjt_date_str(now_ts)

    counts = {"parsed": len(parsed), "new": 0, "seen_again": 0, "errors": 0}

    with db.connect() as conn:
        for repo in parsed:
            try:
                already = db.repo_exists(conn, repo["owner_repo"])
                if already:
                    if not dry_run:
                        update_seen(conn, repo["owner_repo"], now_ts)
                        insert_metrics(conn, repo, now_ts, today)
                    counts["seen_again"] += 1
                    log.info("seen-again: %s (today_stars=%s)",
                             repo["owner_repo"], repo.get("today_stars"))
                else:
                    enrich_repo(repo)
                    if not dry_run:
                        insert_new_repo(conn, repo, now_ts, today)
                        insert_metrics(conn, repo, now_ts, today)
                    counts["new"] += 1
                    log.info("new: %s (lang=%s, stars=%s, today=%s, sponsor=%s, "
                             "license=%s, watchers=%s, prs=%s, readme=%s chars/%s)",
                             repo["owner_repo"], repo.get("language"),
                             repo.get("total_stars"), repo.get("today_stars"),
                             repo.get("sponsor"), repo.get("license_spdx"),
                             repo.get("watchers"), repo.get("open_prs"),
                             len(repo.get("readme_excerpt") or ""), repo.get("readme_lang"))
            except Exception as exc:  # noqa: BLE001
                counts["errors"] += 1
                log.exception("repo %s failed: %s", repo.get("owner_repo"), exc)

    log.info("done | %s | dry_run=%s", counts, dry_run)
    return counts


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="GitHub trending AI scraper")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse + enrich but don't write DB")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    )

    if not config.GITHUB_TOKEN:
        log.warning("GITHUB_TOKEN not set — API calls will hit 60/hr limit")

    counts = run(dry_run=args.dry_run)
    return 0 if counts["errors"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
