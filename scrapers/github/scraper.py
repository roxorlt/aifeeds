"""GitHub trending AI scraper — main orchestration.

Pipeline:
  fetch trending HTML → parse → for each repo:
    - exists in DB? append metrics + update last_seen
    - new? GitHub API enrich + LLM judge → INSERT github_repos + first metrics
  → after all repos: recompute daily_rank for is_ai=1 AND sponsor=0 today

Run:
  ~/.browser-use-env/bin/python3 -m scrapers.github.scraper --dry-run
  ~/.browser-use-env/bin/python3 -m scrapers.github.scraper           # full pipeline
  ~/.browser-use-env/bin/python3 -m scrapers.github.scraper --skip-llm # PR-1 mode
  ~/.browser-use-env/bin/python3 -m scrapers.github.scraper --retry-null # fix NULL is_ai rows
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
from . import gh_api, llm_judge, parser

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
    """INSERT a freshly-discovered repo into github_repos."""
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
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, NULL, ?, ?, ?, ?, 1, NULL, ?, ?, ?, ?, NULL)
        """,
        (
            repo["owner_repo"], repo["url"], repo["owner"], repo["repo"],
            repo.get("description"), repo.get("language"),
            repo.get("license_spdx"), repo.get("default_branch"),
            repo.get("total_stars"), repo.get("today_stars"),
            repo.get("forks"), repo.get("watchers"),
            repo.get("is_ai"), repo.get("ai_category"), repo.get("ai_summary"),
            repo.get("llm_raw_response"), repo.get("llm_model"), repo.get("llm_called_at"),
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


def recompute_daily_rank(conn, today_str: str) -> int:
    """Re-rank today's AI-relevant non-sponsor repos by today_stars_first DESC.
    Returns count ranked.
    """
    rows = conn.execute(
        """
        SELECT owner_repo
          FROM github_repos
         WHERE trending_date_str = ?
           AND is_ai = 1
           AND sponsor = 0
           AND emitted = 1
        ORDER BY today_stars_first DESC, total_stars_first DESC
        """,
        (today_str,),
    ).fetchall()

    for rank, row in enumerate(rows, start=1):
        conn.execute(
            "UPDATE github_repos SET daily_rank = ? WHERE owner_repo = ?",
            (rank, row["owner_repo"]),
        )
    # Reset rank for non-AI / sponsor / hidden today rows so stale ranks don't linger
    conn.execute(
        """
        UPDATE github_repos
           SET daily_rank = NULL
         WHERE trending_date_str = ?
           AND (is_ai != 1 OR sponsor = 1 OR emitted = 0)
        """,
        (today_str,),
    )
    return len(rows)


def run(dry_run: bool = False, skip_llm: bool = False) -> dict[str, int]:
    """Single cron tick. Returns counts for logging."""
    db.init_db()

    log.info("fetching %s", config.GITHUB_TRENDING_URL)
    html = fetch_trending()
    parsed = parser.parse_trending_html(html)
    log.info("parsed %d repos", len(parsed))

    now_ts = int(time.time())
    today = bjt_date_str(now_ts)

    counts = {"parsed": len(parsed), "new": 0, "seen_again": 0,
              "llm_ok": 0, "llm_null": 0, "errors": 0}

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
                    if not skip_llm:
                        result = llm_judge.judge(repo)
                        repo.update(result)
                        if result["is_ai"] is None:
                            counts["llm_null"] += 1
                        else:
                            counts["llm_ok"] += 1
                    if not dry_run:
                        repo.setdefault("trending_date_str", today)
                        insert_new_repo(conn, repo, now_ts, today)
                        insert_metrics(conn, repo, now_ts, today)
                    counts["new"] += 1
                    log.info("new: %s (lang=%s, stars=%s, today=%s, sponsor=%s, "
                             "is_ai=%s, cat=%s, license=%s, watchers=%s, prs=%s)",
                             repo["owner_repo"], repo.get("language"),
                             repo.get("total_stars"), repo.get("today_stars"),
                             repo.get("sponsor"),
                             repo.get("is_ai"), repo.get("ai_category"),
                             repo.get("license_spdx"),
                             repo.get("watchers"), repo.get("open_prs"))
            except Exception as exc:  # noqa: BLE001
                counts["errors"] += 1
                log.exception("repo %s failed: %s", repo.get("owner_repo"), exc)

        # Re-rank today's AI-relevant non-sponsor rows
        if not dry_run:
            ranked = recompute_daily_rank(conn, today)
            log.info("daily_rank: %d AI repos ranked for %s", ranked, today)

    log.info("done | %s | dry_run=%s skip_llm=%s", counts, dry_run, skip_llm)
    return counts


def retry_null(limit: int = 10) -> dict[str, int]:
    """Re-run LLM on rows where is_ai IS NULL (previous failures)."""
    db.init_db()
    counts = {"picked": 0, "llm_ok": 0, "llm_null": 0}

    with db.connect() as conn:
        rows = conn.execute(
            """SELECT owner_repo, owner, repo, description, language,
                      total_stars_first AS total_stars,
                      today_stars_first AS today_stars,
                      readme_excerpt, trending_date_str
                 FROM github_repos
                WHERE is_ai IS NULL
                ORDER BY first_scraped_at DESC
                LIMIT ?""",
            (limit,),
        ).fetchall()
        counts["picked"] = len(rows)

        for r in rows:
            repo = dict(r)
            result = llm_judge.judge(repo)
            if result["is_ai"] is None:
                counts["llm_null"] += 1
            else:
                counts["llm_ok"] += 1
            conn.execute(
                """UPDATE github_repos
                      SET is_ai = ?, ai_category = ?, ai_summary = ?,
                          llm_raw_response = ?, llm_model = ?, llm_called_at = ?
                    WHERE owner_repo = ?""",
                (result["is_ai"], result["ai_category"], result["ai_summary"],
                 result["llm_raw_response"], result["llm_model"], result["llm_called_at"],
                 repo["owner_repo"]),
            )

        # Re-rank after retry
        if rows:
            today = rows[0]["trending_date_str"]
            recompute_daily_rank(conn, today)

    log.info("retry-null done | %s", counts)
    return counts


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="GitHub trending AI scraper")
    ap.add_argument("--dry-run", action="store_true",
                    help="parse + enrich but don't write DB")
    ap.add_argument("--skip-llm", action="store_true",
                    help="skip LLM judge (writes is_ai=NULL for new rows)")
    ap.add_argument("--retry-null", action="store_true",
                    help="re-run LLM on existing rows where is_ai IS NULL")
    ap.add_argument("--retry-limit", type=int, default=10,
                    help="max rows for --retry-null (default 10)")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    )

    if not config.GITHUB_TOKEN:
        log.warning("GITHUB_TOKEN not set — API calls will hit 60/hr limit")
    if not config.DEEPSEEK_API_KEY and not args.skip_llm and not args.dry_run:
        log.error("DEEPSEEK_API_KEY missing — pass --skip-llm or set the env")
        return 2

    if args.retry_null:
        counts = retry_null(limit=args.retry_limit)
        return 0
    counts = run(dry_run=args.dry_run, skip_llm=args.skip_llm)
    return 0 if counts["errors"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
