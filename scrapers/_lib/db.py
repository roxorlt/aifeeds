"""Local SQLite for ai-feeds scrapers.

Uses ai-feeds's own DB at data/aifeeds.db (NOT the X scraper's xlist.db).
Each source gets its own table; D1 unifies them via items table at sync time.
"""
from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from pathlib import Path

from . import config

GITHUB_REPOS_SCHEMA = """
CREATE TABLE IF NOT EXISTS github_repos (
  owner_repo TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,

  description TEXT,
  language TEXT,
  license_spdx TEXT,
  default_branch TEXT,

  total_stars_first INTEGER,
  today_stars_first INTEGER,
  forks_first INTEGER,
  watchers_first INTEGER,

  is_ai INTEGER,
  ai_category TEXT,
  ai_summary TEXT,
  llm_raw_response TEXT,
  llm_model TEXT,
  llm_called_at INTEGER,

  readme_excerpt TEXT,
  readme_lang TEXT,
  readme_translated TEXT,
  readme_fetched_at INTEGER,

  contributors_json TEXT,
  contributors_count INTEGER,

  sponsor INTEGER NOT NULL DEFAULT 0,
  emitted INTEGER NOT NULL DEFAULT 1,

  daily_rank INTEGER,
  trending_date_str TEXT,
  first_trending_at INTEGER,
  first_scraped_at INTEGER,
  last_seen_on_trending_at INTEGER,
  last_pushed_at INTEGER
);
"""

GITHUB_REPO_METRICS_SCHEMA = """
CREATE TABLE IF NOT EXISTS github_repo_metrics (
  owner_repo TEXT NOT NULL,
  measured_at INTEGER NOT NULL,
  trending_date_str TEXT,
  total_stars INTEGER,
  today_stars INTEGER,
  forks INTEGER,
  watchers INTEGER,
  open_issues INTEGER,
  open_prs INTEGER,
  PRIMARY KEY (owner_repo, measured_at)
);
"""

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_gr_trending_date ON github_repos(trending_date_str);",
    "CREATE INDEX IF NOT EXISTS idx_gr_is_ai_rank ON github_repos(is_ai, daily_rank);",
    "CREATE INDEX IF NOT EXISTS idx_gr_sponsor ON github_repos(sponsor);",
    "CREATE INDEX IF NOT EXISTS idx_grm_owner_at ON github_repo_metrics(owner_repo, measured_at);",
]


def init_db(db_path: Path | None = None) -> None:
    """Idempotent: create tables + indexes if missing."""
    path = db_path or config.DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(path) as conn:
        conn.executescript(GITHUB_REPOS_SCHEMA)
        conn.executescript(GITHUB_REPO_METRICS_SCHEMA)
        for stmt in INDEXES:
            conn.execute(stmt)
        conn.commit()


@contextmanager
def connect(db_path: Path | None = None):
    """Context manager yielding a sqlite3 connection with row_factory=Row."""
    path = db_path or config.DB_PATH
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def repo_exists(conn: sqlite3.Connection, owner_repo: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM github_repos WHERE owner_repo = ? LIMIT 1",
        (owner_repo,),
    ).fetchone()
    return row is not None
