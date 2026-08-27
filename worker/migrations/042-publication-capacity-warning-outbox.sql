-- Durable publication-capacity threshold crossings and an independent reliable outbox.
-- Migration 039 remains unchanged; this schema has its own event/payload/state authority.

CREATE TABLE publication_capacity_warning_control (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id=1),
  namespace TEXT NOT NULL UNIQUE CHECK (namespace='daily-publications-v1'),
  schema_version INTEGER NOT NULL CHECK (schema_version=1),
  epoch INTEGER NOT NULL CHECK (epoch>=0),
  budget_version_snapshot INTEGER NOT NULL CHECK (budget_version_snapshot>=0),
  budget_bytes_snapshot INTEGER NOT NULL CHECK (budget_bytes_snapshot>0),
  legacy_baseline_bytes_snapshot INTEGER NOT NULL CHECK (legacy_baseline_bytes_snapshot>=0),
  reserved_bytes_snapshot INTEGER NOT NULL CHECK (reserved_bytes_snapshot>=0),
  occupied_bytes_snapshot INTEGER NOT NULL CHECK (occupied_bytes_snapshot>=0),
  state TEXT NOT NULL CHECK (state IN ('uninitialized','active','frozen')),
  last_audit_id TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms>=0),
  CHECK (occupied_bytes_snapshot=legacy_baseline_bytes_snapshot+reserved_bytes_snapshot),
  CHECK (occupied_bytes_snapshot<=budget_bytes_snapshot),
  CHECK (
    (state='uninitialized' AND epoch=0 AND last_audit_id IS NULL)
    OR (state IN ('active','frozen') AND epoch>=1 AND last_audit_id IS NOT NULL)
  )
);

INSERT INTO publication_capacity_warning_control(
  singleton_id,namespace,schema_version,epoch,budget_version_snapshot,
  budget_bytes_snapshot,legacy_baseline_bytes_snapshot,reserved_bytes_snapshot,
  occupied_bytes_snapshot,state,last_audit_id,updated_at_ms
)
SELECT 1,'daily-publications-v1',1,0,version,budget_bytes,legacy_baseline_bytes,
       reserved_bytes,legacy_baseline_bytes+reserved_bytes,state,NULL,updated_at_ms
  FROM publication_storage_budget
 WHERE singleton_id=1 AND state='uninitialized';

CREATE TABLE publication_capacity_threshold_crossings (
  namespace TEXT NOT NULL CHECK (namespace='daily-publications-v1'),
  epoch INTEGER NOT NULL CHECK (epoch>=1),
  threshold_bps INTEGER NOT NULL CHECK (threshold_bps IN (7000,8500,9500)),
  schema_version INTEGER NOT NULL CHECK (schema_version=1),
  event_type TEXT NOT NULL CHECK (event_type='publication_capacity_threshold_crossed'),
  budget_version INTEGER NOT NULL CHECK (budget_version>=1),
  budget_bytes INTEGER NOT NULL CHECK (budget_bytes>0),
  legacy_baseline_bytes INTEGER NOT NULL CHECK (legacy_baseline_bytes>=0),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes>=0),
  occupied_bytes INTEGER NOT NULL CHECK (occupied_bytes>=0),
  crossed_at_ms INTEGER NOT NULL CHECK (crossed_at_ms>=0),
  materialization_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (materialization_state IN ('pending','materialized','quarantined')),
  materialized_event_id TEXT,
  materialized_at_ms INTEGER,
  last_error_code TEXT,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms>=0),
  PRIMARY KEY(namespace,epoch,threshold_bps),
  CHECK (occupied_bytes=legacy_baseline_bytes+reserved_bytes),
  CHECK (occupied_bytes<=budget_bytes),
  CHECK (occupied_bytes*10000>=budget_bytes*threshold_bps),
  CHECK (materialized_event_id IS NULL OR
    (length(materialized_event_id)=64 AND materialized_event_id NOT GLOB '*[^0-9a-f]*')),
  CHECK (
    (materialization_state='pending' AND materialized_event_id IS NULL
      AND materialized_at_ms IS NULL AND last_error_code IS NULL)
    OR (materialization_state='materialized' AND materialized_event_id IS NOT NULL
      AND materialized_at_ms IS NOT NULL AND materialized_at_ms>=0 AND last_error_code IS NULL)
    OR (materialization_state='quarantined' AND materialized_event_id IS NOT NULL
      AND materialized_at_ms IS NOT NULL AND materialized_at_ms>=0
      AND last_error_code IS NOT NULL AND last_error_code GLOB 'CAPACITY_PRODUCER_*')
  )
);

CREATE INDEX publication_capacity_crossing_materialize_idx
  ON publication_capacity_threshold_crossings(
    materialization_state,crossed_at_ms,epoch,threshold_bps
  );

CREATE TABLE publication_capacity_warning_outbox (
  event_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK (schema_version=1),
  event_type TEXT NOT NULL CHECK (event_type='publication_capacity_threshold_crossed'),
  namespace TEXT NOT NULL CHECK (namespace='daily-publications-v1'),
  epoch INTEGER NOT NULL CHECK (epoch>=1),
  threshold_bps INTEGER NOT NULL CHECK (threshold_bps IN (7000,8500,9500)),
  crossed_at_ms INTEGER NOT NULL CHECK (crossed_at_ms>=0),
  record_kind TEXT NOT NULL CHECK (record_kind IN ('deliverable','quarantine')),
  payload_json TEXT,
  payload_sha256 TEXT,
  state TEXT NOT NULL CHECK (state IN ('pending','leased','delivered','failed')),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 0 AND 6),
  next_retry_at_ms INTEGER CHECK (next_retry_at_ms IS NULL OR next_retry_at_ms>=0),
  lease_owner TEXT,
  lease_until_ms INTEGER CHECK (lease_until_ms IS NULL OR lease_until_ms>=0),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms>=0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms>=0),
  delivered_at_ms INTEGER CHECK (delivered_at_ms IS NULL OR delivered_at_ms>=0),
  failed_at_ms INTEGER CHECK (failed_at_ms IS NULL OR failed_at_ms>=0),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms>=0),
  last_error_code TEXT,
  last_error_detail TEXT,
  UNIQUE(namespace,epoch,threshold_bps),
  CHECK (length(event_id)=64 AND event_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (payload_sha256 IS NULL OR
    (length(payload_sha256)=64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*')),
  CHECK (
    (state='leased' AND lease_owner IS NOT NULL AND lease_until_ms IS NOT NULL)
    OR (state<>'leased' AND lease_owner IS NULL AND lease_until_ms IS NULL)
  ),
  CHECK (
    (record_kind='deliverable' AND payload_json IS NOT NULL AND payload_sha256 IS NOT NULL)
    OR (record_kind='quarantine' AND payload_json IS NULL AND payload_sha256 IS NULL
      AND state='failed' AND attempts=0 AND next_retry_at_ms IS NULL
      AND lease_owner IS NULL AND lease_until_ms IS NULL AND delivered_at_ms IS NULL
      AND failed_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL
      AND expires_at_ms>failed_at_ms AND last_error_code IS NOT NULL
      AND last_error_code GLOB 'CAPACITY_PRODUCER_*')
  ),
  CHECK (state<>'delivered' OR
    (delivered_at_ms IS NOT NULL AND failed_at_ms IS NULL AND expires_at_ms IS NOT NULL)),
  CHECK (state<>'failed' OR (failed_at_ms IS NOT NULL AND expires_at_ms IS NOT NULL))
);

CREATE INDEX publication_capacity_outbox_due_idx
  ON publication_capacity_warning_outbox(
    record_kind,state,next_retry_at_ms,lease_until_ms,created_at_ms,event_id
  );
CREATE INDEX publication_capacity_outbox_retention_idx
  ON publication_capacity_warning_outbox(state,expires_at_ms,event_id);

CREATE TRIGGER publication_capacity_budget_transition_guard
BEFORE UPDATE ON publication_storage_budget
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM publication_capacity_warning_control c
     WHERE c.singleton_id=1 AND c.namespace='daily-publications-v1'
       AND c.schema_version=1 AND c.budget_version_snapshot=OLD.version
       AND c.budget_bytes_snapshot=OLD.budget_bytes
       AND c.legacy_baseline_bytes_snapshot=OLD.legacy_baseline_bytes
       AND c.reserved_bytes_snapshot=OLD.reserved_bytes
       AND c.occupied_bytes_snapshot=OLD.legacy_baseline_bytes+OLD.reserved_bytes
       AND c.state=OLD.state
  ) THEN RAISE(ABORT,'PUBLICATION_CAPACITY_CONTROL_STALE') END;

  SELECT CASE WHEN NOT (
    -- Normal 040 reservation budget CAS.
    (OLD.state='active' AND NEW.state='active'
      AND NEW.budget_bytes=OLD.budget_bytes
      AND NEW.legacy_baseline_bytes=OLD.legacy_baseline_bytes
      AND NEW.reserved_bytes>OLD.reserved_bytes
      AND NEW.version=OLD.version+1
      AND NEW.legacy_inventory_digest=OLD.legacy_inventory_digest
      AND NEW.legacy_inventory_object_count=OLD.legacy_inventory_object_count
      AND NEW.legacy_inventory_at_ms=OLD.legacy_inventory_at_ms)
    OR
    -- Audited offline inventory activation.
    (OLD.state='uninitialized' AND NEW.state='active'
      AND NEW.budget_bytes=OLD.budget_bytes AND NEW.reserved_bytes=OLD.reserved_bytes
      AND NEW.version=OLD.version+1 AND EXISTS (
        SELECT 1 FROM publication_budget_audit a
         WHERE a.action='activate_inventory' AND a.created_at_ms=NEW.updated_at_ms
           AND a.old_budget_bytes=OLD.budget_bytes AND a.new_budget_bytes=NEW.budget_bytes
           AND a.old_occupied_bytes=OLD.legacy_baseline_bytes+OLD.reserved_bytes
           AND a.new_occupied_bytes=NEW.legacy_baseline_bytes+NEW.reserved_bytes
           AND a.inventory_digest=NEW.legacy_inventory_digest))
    OR
    -- Audited budget expansion; bytes are cumulative and never released.
    (OLD.state='active' AND NEW.state='active'
      AND NEW.budget_bytes>OLD.budget_bytes
      AND NEW.legacy_baseline_bytes=OLD.legacy_baseline_bytes
      AND NEW.reserved_bytes=OLD.reserved_bytes AND NEW.version=OLD.version+1
      AND NEW.legacy_inventory_digest=OLD.legacy_inventory_digest
      AND NEW.legacy_inventory_object_count=OLD.legacy_inventory_object_count
      AND NEW.legacy_inventory_at_ms=OLD.legacy_inventory_at_ms
      AND EXISTS (
        SELECT 1 FROM publication_budget_audit a
         WHERE a.action='increase_budget' AND a.created_at_ms=NEW.updated_at_ms
           AND a.old_budget_bytes=OLD.budget_bytes AND a.new_budget_bytes=NEW.budget_bytes
           AND a.old_occupied_bytes=OLD.legacy_baseline_bytes+OLD.reserved_bytes
           AND a.new_occupied_bytes=NEW.legacy_baseline_bytes+NEW.reserved_bytes))
    OR
    -- Audited freeze; no new crossing or epoch.
    (OLD.state='active' AND NEW.state='frozen'
      AND NEW.budget_bytes=OLD.budget_bytes
      AND NEW.legacy_baseline_bytes=OLD.legacy_baseline_bytes
      AND NEW.reserved_bytes=OLD.reserved_bytes AND NEW.version=OLD.version+1
      AND EXISTS (
        SELECT 1 FROM publication_budget_audit a
         WHERE a.action='freeze' AND a.created_at_ms=NEW.updated_at_ms
           AND a.old_budget_bytes=OLD.budget_bytes AND a.new_budget_bytes=NEW.budget_bytes
           AND a.old_occupied_bytes=OLD.legacy_baseline_bytes+OLD.reserved_bytes
           AND a.new_occupied_bytes=NEW.legacy_baseline_bytes+NEW.reserved_bytes))
  ) THEN RAISE(ABORT,'PUBLICATION_CAPACITY_AUDIT_REQUIRED') END;
END;

CREATE TRIGGER publication_capacity_budget_transition_apply
AFTER UPDATE ON publication_storage_budget
BEGIN
  -- Activation materializes every threshold already crossed in the audited inventory epoch.
  INSERT INTO publication_capacity_threshold_crossings(
    namespace,epoch,threshold_bps,schema_version,event_type,budget_version,budget_bytes,
    legacy_baseline_bytes,reserved_bytes,occupied_bytes,crossed_at_ms,updated_at_ms
  )
  SELECT c.namespace,c.epoch+1,t.threshold_bps,1,'publication_capacity_threshold_crossed',
         NEW.version,NEW.budget_bytes,NEW.legacy_baseline_bytes,NEW.reserved_bytes,
         NEW.legacy_baseline_bytes+NEW.reserved_bytes,NEW.updated_at_ms,NEW.updated_at_ms
    FROM publication_capacity_warning_control c
    JOIN (SELECT 7000 threshold_bps UNION ALL SELECT 8500 UNION ALL SELECT 9500) t
   WHERE OLD.state='uninitialized' AND NEW.state='active'
     AND (NEW.legacy_baseline_bytes+NEW.reserved_bytes)*10000
           >= NEW.budget_bytes*t.threshold_bps;

  -- A successful 040 reservation records only true up-crossings in the current epoch.
  INSERT INTO publication_capacity_threshold_crossings(
    namespace,epoch,threshold_bps,schema_version,event_type,budget_version,budget_bytes,
    legacy_baseline_bytes,reserved_bytes,occupied_bytes,crossed_at_ms,updated_at_ms
  )
  SELECT c.namespace,c.epoch,t.threshold_bps,1,'publication_capacity_threshold_crossed',
         NEW.version,NEW.budget_bytes,NEW.legacy_baseline_bytes,NEW.reserved_bytes,
         NEW.legacy_baseline_bytes+NEW.reserved_bytes,NEW.updated_at_ms,NEW.updated_at_ms
    FROM publication_capacity_warning_control c
    JOIN (SELECT 7000 threshold_bps UNION ALL SELECT 8500 UNION ALL SELECT 9500) t
   WHERE OLD.state='active' AND NEW.state='active'
     AND NEW.budget_bytes=OLD.budget_bytes AND NEW.reserved_bytes>OLD.reserved_bytes
     AND (OLD.legacy_baseline_bytes+OLD.reserved_bytes)*10000
           < OLD.budget_bytes*t.threshold_bps
     AND (NEW.legacy_baseline_bytes+NEW.reserved_bytes)*10000
           >= NEW.budget_bytes*t.threshold_bps;

  UPDATE publication_capacity_warning_control
     SET epoch=epoch+CASE WHEN
           (OLD.state='uninitialized' AND NEW.state='active')
           OR (NEW.budget_bytes>OLD.budget_bytes) THEN 1 ELSE 0 END,
         budget_version_snapshot=NEW.version,
         budget_bytes_snapshot=NEW.budget_bytes,
         legacy_baseline_bytes_snapshot=NEW.legacy_baseline_bytes,
         reserved_bytes_snapshot=NEW.reserved_bytes,
         occupied_bytes_snapshot=NEW.legacy_baseline_bytes+NEW.reserved_bytes,
         state=NEW.state,
         last_audit_id=CASE WHEN
           (OLD.state='uninitialized' AND NEW.state='active')
           OR NEW.budget_bytes>OLD.budget_bytes OR NEW.state='frozen'
           THEN (SELECT a.audit_id FROM publication_budget_audit a
                  WHERE a.created_at_ms=NEW.updated_at_ms
                    AND a.old_budget_bytes=OLD.budget_bytes
                    AND a.new_budget_bytes=NEW.budget_bytes
                  ORDER BY a.audit_id LIMIT 1)
           ELSE last_audit_id END,
         updated_at_ms=NEW.updated_at_ms
   WHERE singleton_id=1;
END;

CREATE TRIGGER publication_capacity_crossings_no_delete
BEFORE DELETE ON publication_capacity_threshold_crossings
BEGIN
  SELECT RAISE(ABORT,'PUBLICATION_CAPACITY_CROSSING_DELETE_FORBIDDEN');
END;
