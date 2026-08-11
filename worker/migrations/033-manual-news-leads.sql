ALTER TABLE daily_news_review_batches ADD COLUMN batch_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE daily_news_review_batches ADD COLUMN supersedes_batch_id TEXT;
ALTER TABLE daily_news_review_batches ADD COLUMN revision_origin TEXT NOT NULL DEFAULT 'scheduled_freeze';
ALTER TABLE daily_news_review_batches ADD COLUMN lineage_id TEXT NOT NULL DEFAULT '';
ALTER TABLE daily_news_review_batches ADD COLUMN is_current INTEGER NOT NULL DEFAULT 0;

UPDATE daily_news_review_batches SET lineage_id = review_date WHERE lineage_id = '';
UPDATE daily_news_review_batches SET is_current = 1
WHERE rowid IN (
  SELECT MAX(rowid) FROM daily_news_review_batches
  WHERE superseded_by IS NULL GROUP BY review_date
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_news_review_one_current
  ON daily_news_review_batches(review_date, lineage_id) WHERE is_current = 1;

CREATE TABLE IF NOT EXISTS manual_news_leads (
  id TEXT PRIMARY KEY,
  review_date TEXT NOT NULL,
  input_type TEXT NOT NULL,
  input_text TEXT NOT NULL DEFAULT '',
  input_url TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  error_code TEXT,
  error_message TEXT,
  submit_idempotency_key TEXT NOT NULL,
  last_mutation_kind TEXT,
  last_mutation_idempotency_key TEXT,
  confirmed_batch_id TEXT,
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(review_date, submit_idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_manual_news_leads_date
  ON manual_news_leads(review_date, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_news_leads_status
  ON manual_news_leads(status, updated_at);

CREATE TABLE IF NOT EXISTS manual_news_evidence (
  lead_id TEXT NOT NULL,
  evidence_id TEXT NOT NULL,
  url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  publisher TEXT NOT NULL,
  published_at TEXT,
  retrieved_at INTEGER NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  claims_supported_json TEXT NOT NULL,
  fetch_audit_json TEXT NOT NULL DEFAULT 'null',
  reliable INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (lead_id, evidence_id)
);

CREATE INDEX IF NOT EXISTS idx_manual_news_evidence_lead
  ON manual_news_evidence(lead_id, retrieved_at);

CREATE TABLE IF NOT EXISTS manual_news_event_assessments (
  lead_id TEXT NOT NULL,
  assessment_version INTEGER NOT NULL,
  event_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  material_update INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL,
  recommendation TEXT NOT NULL,
  assessment_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (lead_id, assessment_version)
);

CREATE INDEX IF NOT EXISTS idx_manual_news_assessments_event
  ON manual_news_event_assessments(event_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_items_event_fingerprint
  ON items(json_extract(extra, '$.event_fingerprint'))
  WHERE json_extract(extra, '$.event_fingerprint') IS NOT NULL;

CREATE TABLE IF NOT EXISTS manual_news_lead_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id TEXT NOT NULL,
  action TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  idempotency_key TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_manual_news_lead_audit
  ON manual_news_lead_audit(lead_id, created_at DESC);
