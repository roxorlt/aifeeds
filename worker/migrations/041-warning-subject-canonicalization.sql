-- Durable raw alias -> NFC canonical warning subject mapping and bounded scan cursors.

CREATE TABLE warning_canonical_subjects (
  source_type TEXT NOT NULL CHECK (source_type IN ('blog','podcast')),
  canonical_subject_id TEXT NOT NULL,
  canonical_version INTEGER NOT NULL CHECK (canonical_version=1),
  canonical_row_id TEXT NOT NULL UNIQUE,
  first_item_rowid INTEGER NOT NULL CHECK (first_item_rowid>0),
  sort_attempts INTEGER NOT NULL CHECK (sort_attempts>=0),
  sort_scraped_at TEXT NOT NULL,
  sort_raw_subject_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state='mapped'),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms>=0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms>=0),
  PRIMARY KEY(source_type,canonical_subject_id),
  CHECK (length(canonical_row_id)=64 AND canonical_row_id NOT GLOB '*[^0-9a-f]*')
);

CREATE INDEX warning_canonical_subject_order_idx
  ON warning_canonical_subjects(
    source_type,sort_attempts,sort_scraped_at,sort_raw_subject_id,canonical_subject_id
  );

CREATE TABLE warning_subject_aliases (
  source_type TEXT NOT NULL CHECK (source_type IN ('blog','podcast')),
  raw_subject_id TEXT NOT NULL,
  canonical_subject_id TEXT NOT NULL,
  canonical_version INTEGER NOT NULL CHECK (canonical_version=1),
  canonical_row_id TEXT NOT NULL,
  item_rowid INTEGER NOT NULL CHECK (item_rowid>0),
  state TEXT NOT NULL CHECK (state IN ('mapped','quarantined')),
  last_error_code TEXT,
  mapped_at_ms INTEGER NOT NULL CHECK (mapped_at_ms>=0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms>=0),
  PRIMARY KEY(source_type,raw_subject_id),
  CHECK (length(canonical_row_id)=64 AND canonical_row_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (
    (state='mapped' AND last_error_code IS NULL)
    OR
    (state='quarantined' AND last_error_code IS NOT NULL
      AND last_error_code GLOB 'CANONICAL_*')
  )
);

CREATE INDEX warning_subject_alias_canonical_idx
  ON warning_subject_aliases(
    source_type,canonical_version,canonical_subject_id,canonical_row_id,raw_subject_id
  );
CREATE INDEX warning_subject_alias_rowid_idx
  ON warning_subject_aliases(source_type,item_rowid);

CREATE TABLE warning_subject_scan_cursors (
  source_type TEXT PRIMARY KEY CHECK (source_type IN ('blog','podcast')),
  after_item_rowid INTEGER NOT NULL DEFAULT 0 CHECK (after_item_rowid>=0),
  cycle_high_water_rowid INTEGER NOT NULL DEFAULT 0 CHECK (cycle_high_water_rowid>=0),
  cycle_no INTEGER NOT NULL DEFAULT 0 CHECK (cycle_no>=0),
  initial_backfill_complete INTEGER NOT NULL DEFAULT 0 CHECK (initial_backfill_complete IN (0,1)),
  future_hook_contract_version INTEGER NOT NULL DEFAULT 0 CHECK (future_hook_contract_version IN (0,1)),
  ready INTEGER NOT NULL DEFAULT 0 CHECK (ready IN (0,1)),
  error_code TEXT,
  lease_owner TEXT,
  lease_until_ms INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms>=0),
  CHECK (
    (lease_owner IS NULL AND lease_until_ms IS NULL)
    OR
    (lease_owner IS NOT NULL AND lease_until_ms IS NOT NULL AND lease_until_ms>=0)
  ),
  CHECK (ready=0 OR (
    initial_backfill_complete=1 AND future_hook_contract_version=1 AND error_code IS NULL
  ))
);

INSERT INTO warning_subject_scan_cursors(source_type,updated_at_ms)
VALUES('blog',0),('podcast',0);
