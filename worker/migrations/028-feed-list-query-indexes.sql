-- 028: evidence-backed default feed indexes
--
-- Production-equivalent evidence (2026-07-10) showed ClawHub scanning about
-- 16k candidates and building a temporary ORDER BY tree. The other default
-- feeds either had small candidate pools or require a separate correctness
-- design, so this migration intentionally changes ClawHub only.
--
-- Apply staging first and capture EXPLAIN + D1 P75 before production approval.
-- Rollback (run explicitly; these lines remain comments in the migration):
-- DROP INDEX IF EXISTS idx_items_clawhub_feed_stars;
-- DROP INDEX IF EXISTS idx_items_clawhub_category_stars;

-- Default `category=all&sort=stars`, excluding suspicious skills.
CREATE INDEX IF NOT EXISTS idx_items_clawhub_feed_stars
ON items (
  source_type ASC,
  is_relevant ASC,
  CAST(json_extract(metrics, '$.stars') AS INTEGER) DESC,
  id ASC
)
WHERE source_type = 'clawhub'
  AND is_relevant = 1
  AND deleted_at IS NULL
  AND json_extract(extra, '$.workflow_completed_at') IS NOT NULL
  AND COALESCE(json_extract(extra, '$.is_suspicious'), 0) = 0;

-- Default stars order under a concrete category filter. Category comes first
-- so SQLite can equality-constrain it and then stream stars/id in index order.
CREATE INDEX IF NOT EXISTS idx_items_clawhub_category_stars
ON items (
  source_type ASC,
  is_relevant ASC,
  json_extract(extra, '$.category') ASC,
  CAST(json_extract(metrics, '$.stars') AS INTEGER) DESC,
  id ASC
)
WHERE source_type = 'clawhub'
  AND is_relevant = 1
  AND deleted_at IS NULL
  AND json_extract(extra, '$.workflow_completed_at') IS NOT NULL
  AND COALESCE(json_extract(extra, '$.is_suspicious'), 0) = 0;
