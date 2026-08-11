-- Crash-safe, nonce-fenced generation lineage. Runtime code uses only these
-- v2 tables. Legacy v1 rows are intentionally not imported because their
-- provider-call state cannot be proven exactly once.
CREATE TABLE IF NOT EXISTS manual_news_assessment_generation_cycles_v2 (
  cycle_id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL,
  processing_owner TEXT NOT NULL,
  base_version INTEGER NOT NULL CHECK (base_version > 0),
  call_state TEXT NOT NULL CHECK (call_state IN (
    'initial_started', 'regeneration_ready', 'regeneration_started',
    'validated', 'terminal', 'superseded'
  )),
  first_validation_code TEXT,
  first_validation_path TEXT,
  last_validation_code TEXT,
  last_validation_path TEXT,
  regeneration_consumed INTEGER NOT NULL DEFAULT 0
    CHECK (regeneration_consumed IN (0, 1)),
  validated_assessment_json TEXT,
  provider_failure_json TEXT,
  superseded_by_processing_owner TEXT,
  is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0, 1)),
  start_nonce TEXT NOT NULL UNIQUE,
  last_result_nonce TEXT UNIQUE,
  regeneration_nonce TEXT UNIQUE,
  supersede_nonce TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (lead_id, processing_owner, base_version),
  CHECK (
    (call_state = 'superseded' AND superseded_by_processing_owner IS NOT NULL AND is_current = 0)
    OR (call_state <> 'superseded' AND superseded_by_processing_owner IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS manual_news_assessment_generation_revisions_v2 (
  cycle_id TEXT NOT NULL,
  generation_revision INTEGER NOT NULL CHECK (generation_revision IN (1, 2)),
  call_kind TEXT NOT NULL CHECK (call_kind IN ('initial', 'regeneration')),
  call_state TEXT NOT NULL CHECK (call_state IN (
    'started', 'validated', 'validation_failed', 'provider_failed'
  )),
  validation_code TEXT,
  validation_path TEXT,
  validated_assessment_json TEXT,
  provider_failure_json TEXT,
  start_nonce TEXT NOT NULL UNIQUE,
  result_nonce TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (cycle_id, generation_revision),
  UNIQUE (cycle_id, call_kind),
  CHECK (
    (call_state = 'started' AND completed_at IS NULL AND result_nonce IS NULL)
    OR (call_state <> 'started' AND completed_at IS NOT NULL AND result_nonce IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_manual_news_generation_v2_cycles_lead
  ON manual_news_assessment_generation_cycles_v2(lead_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_manual_news_generation_v2_one_current_lead
  ON manual_news_assessment_generation_cycles_v2(lead_id) WHERE is_current = 1;

CREATE INDEX IF NOT EXISTS idx_manual_news_generation_v2_revisions_cycle
  ON manual_news_assessment_generation_revisions_v2(cycle_id, generation_revision);
