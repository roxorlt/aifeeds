"""Push local github_repos rows → D1 items table via /api/ingest.

Picks unsynced or stale rows (last_pushed_at < last_seen_on_trending_at)
and posts them in batches. Worker handles items UPSERT + metrics_snapshots_gh
INSERT in one round-trip.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from datetime import datetime, timezone
from typing import Any

import requests

from .._lib import config, db

log = logging.getLogger("github_sync")

# Default to the deployed worker; override with env or --base-url
DEFAULT_WORKER_BASE = "https://xlist-worker.roxorlt.workers.dev"


def row_to_payload_item(row: dict[str, Any]) -> dict[str, Any]:
    """Map local github_repos row → /api/ingest ItemInput."""
    contributors_inline = []
    if row.get("contributors_json"):
        try:
            contributors_inline = json.loads(row["contributors_json"])
        except Exception:
            contributors_inline = []

    metrics = {
        "stars": row.get("total_stars_first"),
        "today_stars": row.get("today_stars_first"),
        "forks": row.get("forks_first"),
        "watchers": row.get("watchers_first"),
        # open_issues / open_prs aren't on row directly; pull from latest metrics history
        # if needed by D1 sparkline. items.metrics holds initial snapshot only.
    }

    extra = {
        "ai_category": row.get("ai_category"),
        "ai_summary": row.get("ai_summary"),
        "llm_model": row.get("llm_model"),
        "llm_called_at": row.get("llm_called_at"),
        "readme_excerpt": row.get("readme_excerpt"),
        "readme_translated": row.get("readme_translated"),
        "contributors_inline": contributors_inline,
        "contributors_count": row.get("contributors_count"),
        "sponsor": int(row.get("sponsor") or 0),
        "daily_rank": row.get("daily_rank"),
        "trending_date_str": row.get("trending_date_str"),
        "first_trending_at": row.get("first_trending_at"),
        "last_seen_on_trending_at": row.get("last_seen_on_trending_at"),
        "default_branch": row.get("default_branch"),
        "license_spdx": row.get("license_spdx"),
    }

    # ISO 8601 strings for items.scraped_at / published_at
    first_ts = row.get("first_trending_at")
    last_ts = row.get("last_seen_on_trending_at") or first_ts or int(time.time())
    published_iso = datetime.fromtimestamp(first_ts, tz=timezone.utc).isoformat() if first_ts else None
    scraped_iso = datetime.fromtimestamp(last_ts, tz=timezone.utc).isoformat()

    return {
        "source_type": "github",
        "source_id": row["owner_repo"],
        "title": row["owner_repo"],
        "content": row.get("description"),
        "author": row.get("owner"),
        "url": row["url"],
        "media": [],  # README images落 CF R2 留 v2
        "metrics": metrics,
        "published_at": published_iso,
        "scraped_at": scraped_iso,
        "is_relevant": row.get("is_ai"),
        "lang": row.get("readme_lang"),
        "extra": extra,
    }


def pick_unsynced(conn, limit: int) -> list[dict[str, Any]]:
    """Rows where last_pushed_at is NULL or older than last_seen_on_trending_at."""
    rows = conn.execute(
        """SELECT * FROM github_repos
            WHERE is_ai IS NOT NULL
              AND emitted = 1
              AND (last_pushed_at IS NULL
                   OR last_pushed_at < last_seen_on_trending_at)
         ORDER BY first_scraped_at DESC
            LIMIT ?""",
        (limit,),
    ).fetchall()
    return [dict(r) for r in rows]


def mark_pushed(conn, owner_repos: list[str], now_ts: int) -> None:
    if not owner_repos:
        return
    placeholders = ",".join("?" * len(owner_repos))
    conn.execute(
        f"UPDATE github_repos SET last_pushed_at = ? WHERE owner_repo IN ({placeholders})",
        (now_ts, *owner_repos),
    )


def push_batch(base_url: str, ingest_token: str, items: list[dict[str, Any]]) -> dict:
    url = f"{base_url.rstrip('/')}/api/ingest"
    r = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {ingest_token}",
            "Content-Type": "application/json",
        },
        json={"items": items},
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def run(base_url: str, ingest_token: str, batch_size: int = 100, dry_run: bool = False) -> dict[str, int]:
    db.init_db()
    counts = {"picked": 0, "pushed": 0, "errors": 0}

    with db.connect() as conn:
        rows = pick_unsynced(conn, limit=batch_size)
        counts["picked"] = len(rows)
        if not rows:
            log.info("nothing to sync")
            return counts

        items = [row_to_payload_item(r) for r in rows]
        log.info("picked %d rows for sync", len(items))

        if dry_run:
            print(json.dumps({"items": items[:2], "_truncated_total": len(items)},
                             ensure_ascii=False, indent=2))
            return counts

        try:
            resp = push_batch(base_url, ingest_token, items)
            log.info("worker response: %s", resp)
            counts["pushed"] = resp.get("inserted", 0)
            mark_pushed(conn, [r["owner_repo"] for r in rows], int(time.time()))
        except Exception as exc:  # noqa: BLE001
            counts["errors"] += 1
            log.exception("push failed: %s", exc)

    return counts


def main(argv: list[str] | None = None) -> int:
    import os

    ap = argparse.ArgumentParser(description="Sync local github_repos → D1 items")
    ap.add_argument("--base-url", default=(
        os.environ.get("AIFEEDS_WORKER_URL")
        or os.environ.get("XLIST_WORKER_URL")
        or DEFAULT_WORKER_BASE
    ))
    ap.add_argument("--token", default=(
        os.environ.get("INGEST_TOKEN")
        or os.environ.get("XLIST_INGEST_TOKEN", "")
    ),
                    help="Worker INGEST_TOKEN (env INGEST_TOKEN or XLIST_INGEST_TOKEN)")
    ap.add_argument("--batch-size", type=int, default=100)
    ap.add_argument("--dry-run", action="store_true",
                    help="print payload preview, don't POST")
    ap.add_argument("--verbose", "-v", action="store_true")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s | %(message)s",
    )

    if not args.dry_run and not args.token:
        log.error("INGEST_TOKEN missing — set env or --token")
        return 2

    counts = run(args.base_url, args.token, args.batch_size, dry_run=args.dry_run)
    log.info("done | %s", counts)
    return 0 if counts["errors"] == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
