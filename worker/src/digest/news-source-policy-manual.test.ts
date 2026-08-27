import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const { loadVerifiedManualAssessmentMock } = vi.hoisted(() => ({
  loadVerifiedManualAssessmentMock: vi.fn(),
}));

function verifiedAssessment(leadId: string, verificationId = `verification:${leadId}`) {
  return {
    record: {
      verification_id: verificationId,
      lead_id: leadId,
      creation_nonce: `nonce:${leadId}`,
      assessment_version: 1,
      policy_version: 'policy-v1',
      verification_key_id: 'verification-key-v1',
      canonical_digest: 'a'.repeat(64),
      hmac_sha256: 'b'.repeat(64),
      verification_json: '{}',
      processing_owner: 'owner-v1',
      processing_attempt: 1,
      status: 'active',
      reason: null,
      created_at: 1,
      invalidation_nonce: null,
      invalidated_at: null,
      assessment_json: '{}',
      review_date: '2026-08-27',
    },
    assessment: {},
    verification: {},
    evidence: [],
  };
}

vi.mock('./manual-news-leads-verification', () => ({
  loadVerifiedManualAssessment: loadVerifiedManualAssessmentMock,
}));

import type { Env } from '../index';
import { authorizeFormalNewsSet } from './news-source-policy';

class ManualD1 {
  readonly sqlite = new DatabaseSync(':memory:');
  beforeAll: ((sql: string) => void) | null = null;
  afterAll: ((sql: string) => void) | null = null;
  constructor() {
    this.sqlite.exec(`
      CREATE TABLE items (
        id TEXT PRIMARY KEY, source_type TEXT, source_id TEXT, source_ref TEXT,
        extra TEXT, deleted_at TEXT
      );
      CREATE TABLE sources (
        id TEXT PRIMARY KEY, source_type TEXT, source_ref TEXT, config TEXT
      );
      CREATE TABLE manual_news_leads (
        id TEXT PRIMARY KEY, review_date TEXT, status TEXT, confirmed_at INTEGER,
        version INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE manual_news_event_assessments (
        lead_id TEXT, assessment_version INTEGER, assessment_json TEXT,
        PRIMARY KEY (lead_id, assessment_version)
      );
      CREATE TABLE manual_news_assessment_verifications (
        verification_id TEXT PRIMARY KEY, lead_id TEXT, assessment_version INTEGER,
        policy_version TEXT, verification_key_id TEXT, canonical_digest TEXT,
        hmac_sha256 TEXT, verification_json TEXT, processing_owner TEXT,
        processing_attempt INTEGER, creation_nonce TEXT, invalidation_nonce TEXT,
        status TEXT, reason TEXT, created_at INTEGER, invalidated_at INTEGER
      );
    `);
  }
  prepare(sql: string) {
    let bindings: SQLInputValue[] = [];
    const statement = this.sqlite.prepare(sql);
    const prepared = {
      bind: (...values: unknown[]) => { bindings = values as SQLInputValue[]; return prepared; },
      first: async <T>() => (statement.get(...bindings) as T | undefined) ?? null,
      all: async <T>() => {
        this.beforeAll?.(sql);
        const results = statement.all(...bindings) as T[];
        this.afterAll?.(sql);
        return { results, success: true, meta: {} };
      },
      run: async () => {
        const result = statement.run(...bindings);
        return { success: true, meta: { changes: Number(result.changes) } };
      },
    };
    return prepared;
  }
  close(): void { this.sqlite.close(); }
}

const opened: ManualD1[] = [];
afterEach(() => { while (opened.length) opened.pop()!.close(); });
beforeEach(() => {
  loadVerifiedManualAssessmentMock.mockReset();
  loadVerifiedManualAssessmentMock.mockImplementation(async (_env: unknown, leadId: string) => (
    verifiedAssessment(leadId)
  ));
});

function insertManual(
  db: ManualD1,
  leadId: string,
  overrides: { status?: string; confirmedAt?: number | null; reviewDate?: string; extra?: unknown } = {},
): string {
  const itemId = `blog:manual:${leadId}`;
  db.sqlite.prepare(
    'INSERT INTO manual_news_leads (id, review_date, status, confirmed_at) VALUES (?, ?, ?, ?)',
  ).run(
    leadId,
    overrides.reviewDate ?? '2026-08-27',
    overrides.status ?? 'recommended',
    overrides.confirmedAt === undefined ? 1 : overrides.confirmedAt,
  );
  db.sqlite.prepare(
    `INSERT INTO items (id, source_type, source_id, source_ref, extra, deleted_at)
     VALUES (?, 'blog', ?, 'manual_lead', ?, NULL)`,
  ).run(
    itemId,
    `manual:${leadId}`,
    JSON.stringify(overrides.extra ?? {
      manual_lead: { lead_id: leadId, evidence_ids: [] },
      editorial_type: 'official',
    }),
  );
  db.sqlite.prepare(
    `INSERT INTO manual_news_event_assessments (lead_id, assessment_version, assessment_json)
     VALUES (?, 1, '{}')`,
  ).run(leadId);
  db.sqlite.prepare(
    `INSERT INTO manual_news_assessment_verifications (
       verification_id,lead_id,assessment_version,policy_version,verification_key_id,
       canonical_digest,hmac_sha256,verification_json,processing_owner,processing_attempt,
       creation_nonce,invalidation_nonce,status,reason,created_at,invalidated_at
     ) VALUES (?,?,1,'policy-v1','verification-key-v1',?,?,'{}','owner-v1',1,?,NULL,'active',NULL,1,NULL)`,
  ).run(
    `verification:${leadId}`, leadId, 'a'.repeat(64), 'b'.repeat(64), `nonce:${leadId}`,
  );
  return itemId;
}

test('manual authorization requires exact durable status/date/confirmation and canonical item identity', async () => {
  const db = new ManualD1(); opened.push(db);
  const valid = insertManual(db, 'valid');
  const wrongStatus = insertManual(db, 'wrong-status', { status: 'confirmed' });
  const noConfirmation = insertManual(db, 'no-confirmation', { confirmedAt: null });
  const wrongDate = insertManual(db, 'wrong-date', { reviewDate: '2026-08-26' });
  const malformedIdentity = insertManual(db, 'bad-identity', {
    extra: { manual_lead: 'bad-identity', editorial_type: 'official' },
  });

  const result = await authorizeFormalNewsSet(
    { DB: db as unknown as D1Database } as Env,
    '2026-08-27',
    [valid, wrongStatus, noConfirmation, wrongDate, malformedIdentity],
    'manual-test',
  );

  expect(result.allowed_ids).toEqual([valid]);
  expect(result.decisions.map((entry) => entry.code)).toEqual([
    'ALLOW_VERIFIED_MANUAL',
    'DENY_UNVERIFIED_MANUAL',
    'DENY_UNVERIFIED_MANUAL',
    'DENY_UNVERIFIED_MANUAL',
    'DENY_MANUAL_IDENTITY_MISMATCH',
  ]);
  expect(result.decisions[0]).toMatchObject({
    lead_id: 'valid', verification_id: 'verification:valid',
  });
});

test('manual proof never overrides explicit item radar', async () => {
  const db = new ManualD1(); opened.push(db);
  const radar = insertManual(db, 'radar', {
    extra: {
      manual_lead: { lead_id: 'radar', evidence_ids: [] },
      editorial_type: 'radar',
    },
  });

  const result = await authorizeFormalNewsSet(
    { DB: db as unknown as D1Database } as Env,
    '2026-08-27',
    [radar],
    'manual-test',
  );
  expect(result.decisions[0]?.code).toBe('DENY_EXPLICIT_ITEM_RADAR');
});

test('final guard rejects durable manual lead mutation after early authorization', async () => {
  const db = new ManualD1(); opened.push(db);
  const itemId = insertManual(db, 'lead-race');
  let mutated = false;
  db.beforeAll = (sql) => {
    if (mutated || !sql.includes('formal_news:final_guard')) return;
    mutated = true;
    db.sqlite.prepare(`UPDATE manual_news_leads SET status='rejected' WHERE id='lead-race'`).run();
  };

  const result = await authorizeFormalNewsSet(
    { DB: db as unknown as D1Database } as Env,
    '2026-08-27',
    [itemId],
    'manual-race',
  );
  expect(mutated).toBe(true);
  expect(result.allowed_ids).toEqual([]);
  expect(result.decisions[0]?.code).toBe('DENY_AUTHORIZATION_STALE');
});

test('final guard rejects replacement of the verified manual proof snapshot', async () => {
  const db = new ManualD1(); opened.push(db);
  const itemId = insertManual(db, 'proof-race');
  loadVerifiedManualAssessmentMock
    .mockResolvedValueOnce(verifiedAssessment('proof-race', 'verification:proof-race:v1'))
    .mockResolvedValueOnce(verifiedAssessment('proof-race', 'verification:proof-race:v2'));

  const result = await authorizeFormalNewsSet(
    { DB: db as unknown as D1Database } as Env,
    '2026-08-27',
    [itemId],
    'manual-proof-race',
  );
  expect(loadVerifiedManualAssessmentMock).toHaveBeenCalledTimes(2);
  expect(result.allowed_ids).toEqual([]);
  expect(result.decisions[0]?.code).toBe('DENY_AUTHORIZATION_STALE');
});

test('single final guard rejects item radar mutation after the preflight item read', async () => {
  const db = new ManualD1(); opened.push(db);
  const itemId = insertManual(db, 'item-internal-race');
  let mutated = false;
  db.afterAll = (sql) => {
    if (mutated || !sql.includes('formal_news:early_authorization')) return;
    mutated = true;
    db.sqlite.prepare(
      `UPDATE items SET extra=json_set(extra, '$.editorial_type', 'radar') WHERE id=?`,
    ).run(itemId);
  };

  const result = await authorizeFormalNewsSet(
    { DB: db as unknown as D1Database } as Env,
    '2026-08-27',
    [itemId],
    'manual-item-internal-race',
  );

  expect(mutated).toBe(true);
  expect(result.allowed_ids).toEqual([]);
  expect(result.decisions[0]?.code).toBe('DENY_AUTHORIZATION_STALE');
});

test('single final guard rejects lead status mutation after stale lead pre-read', async () => {
  const db = new ManualD1(); opened.push(db);
  const itemId = insertManual(db, 'rejected-lead-probe');
  let verificationLoads = 0;
  loadVerifiedManualAssessmentMock.mockImplementation(async () => {
    verificationLoads += 1;
    if (verificationLoads === 2) {
      db.sqlite.prepare(
        `UPDATE manual_news_leads SET status='rejected', version=version+1 WHERE id=?`,
      ).run('rejected-lead-probe');
    }
    return verifiedAssessment('rejected-lead-probe');
  });

  const result = await authorizeFormalNewsSet(
    { DB: db as unknown as D1Database } as Env,
    '2026-08-27',
    [itemId],
    'manual-rejected-lead-probe',
  );

  expect(verificationLoads).toBe(2);
  expect(result.allowed_ids).toEqual([]);
  expect(result.decisions[0]?.code).toBe('DENY_AUTHORIZATION_STALE');
});

test('single final guard rejects proof invalidation after the final cryptographic loader', async () => {
  const db = new ManualD1(); opened.push(db);
  const itemId = insertManual(db, 'proof-internal-race');
  let verificationLoads = 0;
  loadVerifiedManualAssessmentMock.mockImplementation(async () => {
    verificationLoads += 1;
    if (verificationLoads === 2) {
      db.sqlite.prepare(
        `UPDATE manual_news_assessment_verifications
            SET status='invalidated', invalidation_nonce='race', invalidated_at=1
          WHERE lead_id=?`,
      ).run('proof-internal-race');
    }
    return verifiedAssessment('proof-internal-race');
  });

  const result = await authorizeFormalNewsSet(
    { DB: db as unknown as D1Database } as Env,
    '2026-08-27',
    [itemId],
    'manual-proof-internal-race',
  );

  expect(verificationLoads).toBe(2);
  expect(result.allowed_ids).toEqual([]);
  expect(result.decisions[0]?.code).toBe('DENY_AUTHORIZATION_STALE');
});
