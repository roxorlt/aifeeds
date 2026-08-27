-- Append-only daily page/video release model.
-- Digest columns are relational data only: SQLite/D1 does not calculate cryptographic hashes.

CREATE TABLE publication_storage_budget (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  namespace TEXT NOT NULL UNIQUE CHECK (namespace = 'daily-publications-v1'),
  budget_bytes INTEGER NOT NULL CHECK (budget_bytes > 0),
  legacy_baseline_bytes INTEGER NOT NULL CHECK (legacy_baseline_bytes >= 0),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  version INTEGER NOT NULL CHECK (version >= 0),
  state TEXT NOT NULL CHECK (state IN ('uninitialized','active','frozen')),
  legacy_inventory_digest TEXT,
  legacy_inventory_object_count INTEGER,
  legacy_inventory_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (legacy_baseline_bytes + reserved_bytes <= budget_bytes),
  CHECK (
    (state='uninitialized'
      AND legacy_inventory_digest IS NULL
      AND legacy_inventory_object_count IS NULL
      AND legacy_inventory_at_ms IS NULL)
    OR
    (state IN ('active','frozen')
      AND legacy_inventory_digest IS NOT NULL
      AND length(legacy_inventory_digest)=64
      AND legacy_inventory_digest NOT GLOB '*[^0-9a-f]*'
      AND legacy_inventory_object_count IS NOT NULL
      AND legacy_inventory_object_count>=0
      AND legacy_inventory_at_ms IS NOT NULL
      AND legacy_inventory_at_ms>=0)
  )
);

INSERT INTO publication_storage_budget(
  singleton_id,namespace,budget_bytes,legacy_baseline_bytes,reserved_bytes,
  version,state,updated_at_ms
) VALUES(1,'daily-publications-v1',3298534883328,0,0,0,'uninitialized',0);

CREATE TABLE publication_budget_audit (
  audit_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('activate_inventory','increase_budget','freeze')),
  old_budget_bytes INTEGER NOT NULL,
  new_budget_bytes INTEGER NOT NULL,
  old_occupied_bytes INTEGER NOT NULL,
  new_occupied_bytes INTEGER NOT NULL,
  inventory_digest TEXT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  ticket_ref TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms>=0),
  CHECK (new_budget_bytes>=new_occupied_bytes),
  CHECK (action<>'increase_budget' OR new_budget_bytes>old_budget_bytes)
);

CREATE TABLE publication_reservations (
  reservation_token TEXT PRIMARY KEY,
  publication_date TEXT NOT NULL,
  publication_type TEXT NOT NULL CHECK (publication_type IN ('page','video')),
  slot_no INTEGER NOT NULL,
  business_revision_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL UNIQUE,
  manifest_digest TEXT NOT NULL,
  object_count INTEGER NOT NULL,
  vtt_present INTEGER NOT NULL CHECK (vtt_present IN (0,1)),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes>0),
  budget_version_before INTEGER NOT NULL CHECK (budget_version_before>=0),
  state TEXT NOT NULL CHECK (state IN (
    'reserved','put_pending','put_unknown','put_verified',
    'published','abandoned','integrity_failed'
  )),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms>=0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms>=0),
  CHECK (length(reservation_token)=64 AND reservation_token NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(business_revision_id)=64 AND business_revision_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(attempt_key)=64 AND attempt_key NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (
    (publication_type='page' AND slot_no BETWEEN 1 AND 16
      AND object_count=1 AND vtt_present=0 AND reserved_bytes<=2097152)
    OR
    (publication_type='video' AND slot_no BETWEEN 1 AND 4
      AND object_count=2+vtt_present AND reserved_bytes<=76546048)
  ),
  UNIQUE(publication_date,publication_type,business_revision_id),
  UNIQUE(publication_date,publication_type,slot_no)
);

CREATE INDEX publication_reservations_budget_idx
  ON publication_reservations(publication_date,publication_type,slot_no,state);

CREATE TABLE append_only_publications (
  publication_id TEXT PRIMARY KEY,
  reservation_token TEXT NOT NULL UNIQUE,
  publication_date TEXT NOT NULL,
  publication_type TEXT NOT NULL CHECK (publication_type IN ('page','video')),
  slot_no INTEGER NOT NULL,
  business_revision_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL UNIQUE,
  manifest_digest TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  formal_news_item_ids TEXT NOT NULL DEFAULT '[]',
  formal_guard_expected_json TEXT NOT NULL DEFAULT '[]',
  review_batch_json TEXT,
  video_mode TEXT CHECK (video_mode IS NULL OR video_mode IN ('none','reuse_current','joint_new')),
  bound_video_publication_id TEXT,
  bound_video_digest TEXT,
  base_release_generation INTEGER NOT NULL DEFAULT 0 CHECK (base_release_generation>=0),
  base_page_publication_id TEXT,
  base_video_publication_id TEXT,
  base_video_digest TEXT,
  state TEXT NOT NULL CHECK (state IN (
    'reserved','put_pending','put_unknown','put_verified',
    'published','abandoned','integrity_failed'
  )),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms>=0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms>=0),
  published_at_ms INTEGER,
  CHECK (length(publication_id)=64 AND publication_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(reservation_token)=64 AND reservation_token NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(business_revision_id)=64 AND business_revision_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(attempt_key)=64 AND attempt_key NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (json_valid(metadata_json)=1 AND json_type(metadata_json)='object'),
  CHECK (json_valid(formal_news_item_ids)=1 AND json_type(formal_news_item_ids)='array'),
  CHECK (json_valid(formal_guard_expected_json)=1 AND json_type(formal_guard_expected_json)='array'),
  CHECK (review_batch_json IS NULL OR
    (json_valid(review_batch_json)=1 AND json_type(review_batch_json)='object')),
  CHECK (bound_video_digest IS NULL OR
    (length(bound_video_digest)=64 AND bound_video_digest NOT GLOB '*[^0-9a-f]*')),
  CHECK (base_video_digest IS NULL OR
    (length(base_video_digest)=64 AND base_video_digest NOT GLOB '*[^0-9a-f]*')),
  UNIQUE(publication_date,publication_type,business_revision_id),
  UNIQUE(publication_date,publication_type,slot_no)
);

CREATE TABLE append_only_publication_objects (
  object_id TEXT PRIMARY KEY,
  reservation_token TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  publication_date TEXT NOT NULL,
  publication_type TEXT NOT NULL CHECK (publication_type IN ('page','video')),
  slot_no INTEGER NOT NULL,
  business_revision_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  object_role TEXT NOT NULL CHECK (object_role IN ('html','mp4','poster','vtt')),
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes>=0),
  mime TEXT NOT NULL,
  tuple_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN (
    'reserved','put_pending','put_unknown','put_verified',
    'publication_bound','abandoned','integrity_failed'
  )),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms>=0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms>=0),
  verified_at_ms INTEGER,
  CHECK (length(object_id)=64 AND object_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(reservation_token)=64 AND reservation_token NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(business_revision_id)=64 AND business_revision_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(attempt_key)=64 AND attempt_key NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(tuple_digest)=64 AND tuple_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (
    (publication_type='page' AND object_role='html'
      AND size_bytes<=2097152 AND mime='text/html; charset=utf-8')
    OR
    (publication_type='video' AND object_role='mp4'
      AND size_bytes<=67108864 AND mime='video/mp4')
    OR
    (publication_type='video' AND object_role='poster'
      AND size_bytes<=8388608 AND mime IN ('image/jpeg','image/png','image/webp'))
    OR
    (publication_type='video' AND object_role='vtt'
      AND size_bytes<=1048576 AND mime='text/vtt; charset=utf-8')
  ),
  UNIQUE(reservation_token,object_role),
  UNIQUE(publication_id,object_role),
  UNIQUE(r2_key,business_revision_id,attempt_key,object_role,sha256,size_bytes,mime)
);

CREATE INDEX append_only_publication_objects_publication_idx
  ON append_only_publication_objects(publication_id,state,object_role);

CREATE TABLE publication_manifest_commits (
  reservation_token TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL UNIQUE,
  manifest_digest TEXT NOT NULL,
  object_count INTEGER NOT NULL CHECK (object_count>0),
  total_size_bytes INTEGER NOT NULL CHECK (total_size_bytes>0),
  committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms>=0),
  CHECK (length(reservation_token)=64 AND reservation_token NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*')
);

CREATE TABLE daily_release_heads (
  date TEXT PRIMARY KEY,
  release_generation INTEGER NOT NULL CHECK (release_generation>=1),
  page_publication_id TEXT NOT NULL UNIQUE,
  video_publication_id TEXT,
  video_mode TEXT NOT NULL CHECK (video_mode IN ('none','reuse_current','joint_new')),
  page_manifest_digest TEXT NOT NULL,
  video_manifest_digest TEXT,
  promoted_at_ms INTEGER NOT NULL CHECK (promoted_at_ms>=0),
  CHECK (length(page_manifest_digest)=64 AND page_manifest_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (video_manifest_digest IS NULL OR
    (length(video_manifest_digest)=64 AND video_manifest_digest NOT GLOB '*[^0-9a-f]*')),
  CHECK (
    (video_mode='none' AND video_publication_id IS NULL AND video_manifest_digest IS NULL)
    OR
    (video_mode IN ('reuse_current','joint_new')
      AND video_publication_id IS NOT NULL AND video_manifest_digest IS NOT NULL)
  )
);

CREATE TRIGGER publication_reservation_budget_guard
BEFORE INSERT ON publication_reservations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM publication_storage_budget b
    WHERE b.singleton_id=1 AND b.namespace='daily-publications-v1'
      AND b.state='active' AND b.version=NEW.budget_version_before
      AND b.legacy_baseline_bytes+b.reserved_bytes+NEW.reserved_bytes<=b.budget_bytes
  ) THEN RAISE(ABORT,'PUBLICATION_BUDGET_OR_VERSION_REJECTED') END;
  UPDATE publication_storage_budget
     SET reserved_bytes=reserved_bytes+NEW.reserved_bytes,
         version=version+1,updated_at_ms=NEW.created_at_ms
   WHERE singleton_id=1 AND state='active' AND version=NEW.budget_version_before
     AND legacy_baseline_bytes+reserved_bytes+NEW.reserved_bytes<=budget_bytes;
  SELECT CASE WHEN changes()!=1
    THEN RAISE(ABORT,'PUBLICATION_BUDGET_CAS_FAILED') END;
END;

CREATE TRIGGER append_only_publication_reservation_guard
BEFORE INSERT ON append_only_publications
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM publication_reservations r
    WHERE r.reservation_token=NEW.reservation_token
      AND r.publication_date=NEW.publication_date
      AND r.publication_type=NEW.publication_type
      AND r.slot_no=NEW.slot_no
      AND r.business_revision_id=NEW.business_revision_id
      AND r.attempt_key=NEW.attempt_key
      AND r.manifest_digest=NEW.manifest_digest
  ) THEN RAISE(ABORT,'PUBLICATION_RESERVATION_MISMATCH') END;
END;

CREATE TRIGGER append_only_object_reservation_guard
BEFORE INSERT ON append_only_publication_objects
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM publication_reservations r
      JOIN append_only_publications p
        ON p.reservation_token=r.reservation_token
       AND p.publication_id=NEW.publication_id
    WHERE r.reservation_token=NEW.reservation_token
      AND r.publication_date=NEW.publication_date
      AND r.publication_type=NEW.publication_type
      AND r.slot_no=NEW.slot_no
      AND r.business_revision_id=NEW.business_revision_id
      AND r.attempt_key=NEW.attempt_key
      AND p.publication_date=NEW.publication_date
      AND p.publication_type=NEW.publication_type
      AND p.slot_no=NEW.slot_no
      AND p.business_revision_id=NEW.business_revision_id
      AND p.attempt_key=NEW.attempt_key
  ) THEN RAISE(ABORT,'PUBLICATION_OBJECT_RESERVATION_MISMATCH') END;
  SELECT CASE WHEN NOT (
    (NEW.object_role='html' AND NEW.r2_key='daily/versions/'||NEW.attempt_key||'/page.html')
    OR (NEW.object_role='mp4' AND NEW.r2_key='daily-video/candidates/'||NEW.attempt_key||'/video.mp4')
    OR (NEW.object_role='poster' AND NEW.r2_key IN (
      'daily-video/candidates/'||NEW.attempt_key||'/poster.jpg',
      'daily-video/candidates/'||NEW.attempt_key||'/poster.png',
      'daily-video/candidates/'||NEW.attempt_key||'/poster.webp'))
    OR (NEW.object_role='vtt' AND NEW.r2_key='daily-video/candidates/'||NEW.attempt_key||'/captions.vtt')
  ) THEN RAISE(ABORT,'PUBLICATION_OBJECT_KEY_MISMATCH') END;
END;

CREATE TRIGGER publication_manifest_guard
BEFORE INSERT ON publication_manifest_commits
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM publication_reservations r
      JOIN append_only_publications p
        ON p.reservation_token=r.reservation_token
       AND p.publication_id=NEW.publication_id
       AND p.manifest_digest=NEW.manifest_digest
    WHERE r.reservation_token=NEW.reservation_token
      AND r.manifest_digest=NEW.manifest_digest
      AND r.object_count=NEW.object_count
      AND r.reserved_bytes=NEW.total_size_bytes
      AND (SELECT COUNT(*) FROM append_only_publication_objects o
            WHERE o.reservation_token=r.reservation_token
              AND o.publication_id=p.publication_id)=r.object_count
      AND (SELECT COALESCE(SUM(o.size_bytes),0) FROM append_only_publication_objects o
            WHERE o.reservation_token=r.reservation_token
              AND o.publication_id=p.publication_id)=r.reserved_bytes
      AND (
        (r.publication_type='page'
          AND (SELECT group_concat(object_role,',') FROM (
            SELECT object_role FROM append_only_publication_objects
             WHERE reservation_token=r.reservation_token ORDER BY object_role))='html')
        OR
        (r.publication_type='video' AND r.vtt_present=0
          AND (SELECT group_concat(object_role,',') FROM (
            SELECT object_role FROM append_only_publication_objects
             WHERE reservation_token=r.reservation_token ORDER BY object_role))='mp4,poster')
        OR
        (r.publication_type='video' AND r.vtt_present=1
          AND (SELECT group_concat(object_role,',') FROM (
            SELECT object_role FROM append_only_publication_objects
             WHERE reservation_token=r.reservation_token ORDER BY object_role))='mp4,poster,vtt')
      )
  ) THEN RAISE(ABORT,'PUBLICATION_MANIFEST_MISMATCH') END;
END;

CREATE TRIGGER daily_release_head_insert_guard
BEFORE INSERT ON daily_release_heads
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM append_only_publications p
     WHERE p.publication_id=NEW.page_publication_id
       AND p.publication_date=NEW.date
       AND p.publication_type='page'
       AND p.manifest_digest=NEW.page_manifest_digest
       AND p.base_release_generation=NEW.release_generation-1
       AND p.state IN ('put_verified','published')
       AND p.video_mode=NEW.video_mode
       AND p.bound_video_publication_id IS NEW.video_publication_id
       AND p.bound_video_digest IS NEW.video_manifest_digest
       AND NOT EXISTS (
         SELECT 1 FROM append_only_publication_objects o
          WHERE o.publication_id=p.publication_id
            AND o.state NOT IN ('put_verified','publication_bound'))
       AND (
         (NEW.video_mode='none'
           AND NEW.video_publication_id IS NULL
           AND NEW.video_manifest_digest IS NULL)
         OR
         (NEW.video_mode='reuse_current'
           AND EXISTS (
             SELECT 1 FROM append_only_publications v
              WHERE v.publication_id=NEW.video_publication_id
                AND v.publication_date=NEW.date
                AND v.publication_type='video'
                AND v.manifest_digest=NEW.video_manifest_digest
                AND v.state='published'
                AND NOT EXISTS (
                  SELECT 1 FROM append_only_publication_objects vo
                   WHERE vo.publication_id=v.publication_id
                     AND vo.state<>'publication_bound')))
         OR
         (NEW.video_mode='joint_new'
           AND EXISTS (
             SELECT 1 FROM append_only_publications v
              WHERE v.publication_id=NEW.video_publication_id
                AND v.publication_date=NEW.date
                AND v.publication_type='video'
                AND v.manifest_digest=NEW.video_manifest_digest
                AND v.base_release_generation=NEW.release_generation-1
                AND v.state IN ('put_verified','published')
                AND NOT EXISTS (
                  SELECT 1 FROM append_only_publication_objects vo
                   WHERE vo.publication_id=v.publication_id
                     AND vo.state NOT IN ('put_verified','publication_bound'))))
       )
  ) THEN RAISE(ABORT,'RELEASE_HEAD_GRAPH_MISMATCH') END;
END;

CREATE TRIGGER daily_release_head_update_guard
BEFORE UPDATE ON daily_release_heads
BEGIN
  SELECT CASE WHEN NEW.release_generation<>OLD.release_generation+1
    THEN RAISE(ABORT,'RELEASE_HEAD_GENERATION_MISMATCH') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1
      FROM append_only_publications p
     WHERE p.publication_id=NEW.page_publication_id
       AND p.publication_date=NEW.date
       AND p.publication_type='page'
       AND p.manifest_digest=NEW.page_manifest_digest
       AND p.base_release_generation=OLD.release_generation
       AND p.base_page_publication_id IS OLD.page_publication_id
       AND p.base_video_publication_id IS OLD.video_publication_id
       AND p.base_video_digest IS OLD.video_manifest_digest
       AND p.state IN ('put_verified','published')
       AND p.video_mode=NEW.video_mode
       AND p.bound_video_publication_id IS NEW.video_publication_id
       AND p.bound_video_digest IS NEW.video_manifest_digest
       AND NOT EXISTS (
         SELECT 1 FROM append_only_publication_objects o
          WHERE o.publication_id=p.publication_id
            AND o.state NOT IN ('put_verified','publication_bound'))
       AND (
         (NEW.video_mode='none' AND OLD.video_publication_id IS NULL
           AND NEW.video_publication_id IS NULL AND NEW.video_manifest_digest IS NULL)
         OR
         (NEW.video_mode='reuse_current'
           AND NEW.video_publication_id IS OLD.video_publication_id
           AND NEW.video_manifest_digest IS OLD.video_manifest_digest
           AND EXISTS (
             SELECT 1 FROM append_only_publications v
              WHERE v.publication_id=OLD.video_publication_id
                AND v.publication_date=NEW.date AND v.publication_type='video'
                AND v.manifest_digest=OLD.video_manifest_digest AND v.state='published'
                AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects vo
                  WHERE vo.publication_id=v.publication_id AND vo.state<>'publication_bound')))
         OR
         (NEW.video_mode='joint_new'
           AND EXISTS (
             SELECT 1 FROM append_only_publications v
              WHERE v.publication_id=NEW.video_publication_id
                AND v.publication_date=NEW.date AND v.publication_type='video'
                AND v.manifest_digest=NEW.video_manifest_digest
                AND v.base_release_generation=OLD.release_generation
                AND v.state IN ('put_verified','published')
                AND NOT EXISTS (SELECT 1 FROM append_only_publication_objects vo
                  WHERE vo.publication_id=v.publication_id
                    AND vo.state NOT IN ('put_verified','publication_bound'))))
       )
  ) THEN RAISE(ABORT,'RELEASE_HEAD_GRAPH_MISMATCH') END;
END;

CREATE TRIGGER publication_reservation_identity_immutable
BEFORE UPDATE OF reservation_token,publication_date,publication_type,slot_no,business_revision_id,
  attempt_key,manifest_digest,object_count,vtt_present,reserved_bytes,budget_version_before
ON publication_reservations
BEGIN SELECT RAISE(ABORT,'PUBLICATION_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER publication_identity_immutable
BEFORE UPDATE OF publication_id,reservation_token,publication_date,publication_type,slot_no,
  business_revision_id,attempt_key,manifest_digest,metadata_json,formal_news_item_ids,
  formal_guard_expected_json,review_batch_json,video_mode,bound_video_publication_id,
  bound_video_digest,base_release_generation,base_page_publication_id,
  base_video_publication_id,base_video_digest
ON append_only_publications
BEGIN SELECT RAISE(ABORT,'PUBLICATION_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER publication_object_identity_immutable
BEFORE UPDATE OF object_id,reservation_token,publication_id,publication_date,publication_type,
  slot_no,business_revision_id,attempt_key,object_role,r2_key,sha256,size_bytes,mime,tuple_digest
ON append_only_publication_objects
BEGIN SELECT RAISE(ABORT,'PUBLICATION_IDENTITY_IMMUTABLE'); END;

CREATE TRIGGER publication_reservations_no_delete BEFORE DELETE ON publication_reservations
BEGIN SELECT RAISE(ABORT,'APPEND_ONLY_DELETE_FORBIDDEN'); END;
CREATE TRIGGER append_only_publications_no_delete BEFORE DELETE ON append_only_publications
BEGIN SELECT RAISE(ABORT,'APPEND_ONLY_DELETE_FORBIDDEN'); END;
CREATE TRIGGER append_only_publication_objects_no_delete BEFORE DELETE ON append_only_publication_objects
BEGIN SELECT RAISE(ABORT,'APPEND_ONLY_DELETE_FORBIDDEN'); END;
CREATE TRIGGER publication_manifest_commits_no_delete BEFORE DELETE ON publication_manifest_commits
BEGIN SELECT RAISE(ABORT,'APPEND_ONLY_DELETE_FORBIDDEN'); END;
