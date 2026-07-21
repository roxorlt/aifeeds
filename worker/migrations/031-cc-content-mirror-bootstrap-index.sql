-- 031: support live-page bootstrap cursor scans without a sort temp table.

CREATE INDEX IF NOT EXISTS idx_cc_pages_status_item
  ON cc_item_pages(status, item_id);
