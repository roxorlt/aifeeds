-- Durable, cycle-scoped assessment generation state. A lead row points at the
-- only cycle whose diagnostics may be exposed by the API. Manual retry clears
-- or replaces that pointer so older attempts cannot be spliced into new state.
ALTER TABLE manual_news_leads ADD COLUMN assessment_generation_cycle_id TEXT;

CREATE TABLE IF NOT EXISTS manual_news_assessment_generation_cycles (
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
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (lead_id, processing_owner, base_version),
  CHECK (
    (call_state = 'superseded' AND superseded_by_processing_owner IS NOT NULL)
    OR (call_state <> 'superseded')
  )
);

CREATE TABLE IF NOT EXISTS manual_news_assessment_generation_revisions (
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
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  PRIMARY KEY (cycle_id, generation_revision),
  UNIQUE (cycle_id, call_kind),
  CHECK (
    (call_state = 'started' AND completed_at IS NULL)
    OR (call_state <> 'started' AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_manual_news_generation_cycles_lead
  ON manual_news_assessment_generation_cycles(lead_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_manual_news_generation_revisions_cycle
  ON manual_news_assessment_generation_revisions(cycle_id, generation_revision);
