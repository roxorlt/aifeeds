import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';

import {
  MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL,
  MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL,
  manualVerificationSnapshotGuardBindings,
  manualVerificationSnapshotSetGuardBinding,
  type PersistedManualVerificationRow,
} from './manual-news-leads-verification';

// 集合版快照门禁必须与「旧的按条数 AND」逐字等价，唯一的差别是绑参个数。
// 语义一旦松一格就是原子写门禁被打开，所以这里逐字段做变异比对。

const databases: DatabaseSync[] = [];
afterEach(() => {
  while (databases.length) databases.pop()!.close();
});

function db(): DatabaseSync {
  const sqlite = new DatabaseSync(':memory:');
  databases.push(sqlite);
  sqlite.exec(`
    CREATE TABLE manual_news_assessment_verifications (
      verification_id TEXT PRIMARY KEY, lead_id TEXT NOT NULL, assessment_version INTEGER NOT NULL,
      policy_version TEXT NOT NULL, verification_key_id TEXT NOT NULL,
      canonical_digest TEXT NOT NULL, hmac_sha256 TEXT NOT NULL,
      verification_json TEXT NOT NULL, processing_owner TEXT NOT NULL,
      processing_attempt INTEGER NOT NULL, creation_nonce TEXT NOT NULL,
      status TEXT NOT NULL
    );
  `);
  return sqlite;
}

function row(index: number): PersistedManualVerificationRow {
  return {
    verification_id: `mav:lead-${index}:4:digest${index}`,
    lead_id: `ml-20260904-${String(index).padStart(12, '0')}`,
    assessment_version: 4_800_000 + index,
    policy_version: 'owner_asserted_v1',
    verification_key_id: 'verification-key-2026-08-11',
    canonical_digest: `canonical-${index}`,
    // 故意塞一段本身就是合法 JSON 的文本：json_extract 必须原样吐 TEXT，不能再解析一层。
    hmac_sha256: `hmac-${index}`,
    verification_json: JSON.stringify({ statement: `声明 ${index}`, quote: '"引号" \\ 反斜杠' }),
    processing_owner: `owner-${index}`,
    processing_attempt: index + 1,
    creation_nonce: `nonce-${index}`,
    status: 'active',
    reason: null,
    created_at: 1,
    invalidated_at: null,
  };
}

function snapshots(count: number): Array<{ lead_id: string; verification: PersistedManualVerificationRow }> {
  return Array.from({ length: count }, (_, index) => {
    const verification = row(index);
    return { lead_id: verification.lead_id, verification };
  });
}

function seed(sqlite: DatabaseSync, entries: ReturnType<typeof snapshots>): void {
  const insert = sqlite.prepare(`INSERT INTO manual_news_assessment_verifications (
    verification_id, lead_id, assessment_version, policy_version, verification_key_id,
    canonical_digest, hmac_sha256, verification_json, processing_owner, processing_attempt,
    creation_nonce, status
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`);
  for (const entry of entries) {
    const v = entry.verification;
    insert.run(
      v.verification_id, entry.lead_id, v.assessment_version, v.policy_version, v.verification_key_id,
      v.canonical_digest, v.hmac_sha256, v.verification_json, v.processing_owner, v.processing_attempt,
      v.creation_nonce,
    );
  }
}

function legacyGuard(sqlite: DatabaseSync, entries: ReturnType<typeof snapshots>): boolean {
  const sql = entries.length
    ? entries.map(() => MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL).join(' AND ')
    : '1 = 1';
  const bindings = entries.flatMap((entry) =>
    manualVerificationSnapshotGuardBindings(entry.lead_id, entry.verification)) as SQLInputValue[];
  const result = sqlite.prepare(`SELECT (${sql}) AS ok`).get(...bindings) as { ok: number };
  return Number(result.ok) === 1;
}

function setGuard(sqlite: DatabaseSync, entries: ReturnType<typeof snapshots>): boolean {
  const result = sqlite.prepare(`SELECT (${MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL}) AS ok`)
    .get(manualVerificationSnapshotSetGuardBinding(entries)) as { ok: number };
  return Number(result.ok) === 1;
}

const GUARDED_FIELDS = [
  'verification_id', 'assessment_version', 'policy_version', 'verification_key_id',
  'canonical_digest', 'hmac_sha256', 'verification_json', 'processing_owner',
  'processing_attempt', 'creation_nonce',
] as const;

test('集合门禁在快照全部对得上时为真，与旧的按条数 AND 一致', () => {
  const sqlite = db();
  const entries = snapshots(12);
  seed(sqlite, entries);
  expect(legacyGuard(sqlite, entries)).toBe(true);
  expect(setGuard(sqlite, entries)).toBe(true);
});

test('快照集合为空时恒真（与旧写法的 1 = 1 一致）', () => {
  const sqlite = db();
  seed(sqlite, snapshots(3));
  expect(legacyGuard(sqlite, [])).toBe(true);
  expect(setGuard(sqlite, [])).toBe(true);
});

test('库里一条都没有、但快照非空时必须为假', () => {
  const sqlite = db();
  expect(legacyGuard(sqlite, snapshots(2))).toBe(false);
  expect(setGuard(sqlite, snapshots(2))).toBe(false);
});

test.each(GUARDED_FIELDS)('第 7 条快照的 %s 被改动后整体不成立', (field) => {
  const sqlite = db();
  const entries = snapshots(12);
  seed(sqlite, entries);
  const tampered = entries.map((entry, index) => {
    if (index !== 6) return entry;
    const value = entry.verification[field];
    return {
      lead_id: entry.lead_id,
      verification: {
        ...entry.verification,
        [field]: typeof value === 'number' ? value + 1 : `${value}-tampered`,
      },
    };
  });
  expect(legacyGuard(sqlite, tampered)).toBe(false);
  expect(setGuard(sqlite, tampered)).toBe(false);
});

test('lead_id 被改动后整体不成立', () => {
  const sqlite = db();
  const entries = snapshots(12);
  seed(sqlite, entries);
  const tampered = entries.map((entry, index) =>
    (index === 6 ? { ...entry, lead_id: `${entry.lead_id}-tampered` } : entry));
  expect(legacyGuard(sqlite, tampered)).toBe(false);
  expect(setGuard(sqlite, tampered)).toBe(false);
});

test('已确认快照被置为 invalidated 后整体不成立', () => {
  const sqlite = db();
  const entries = snapshots(12);
  seed(sqlite, entries);
  sqlite.prepare(`UPDATE manual_news_assessment_verifications SET status = 'invalidated'
    WHERE verification_id = ?`).run(entries[6].verification.verification_id);
  expect(legacyGuard(sqlite, entries)).toBe(false);
  expect(setGuard(sqlite, entries)).toBe(false);
});

test('assessment_version / processing_attempt 以数字比较，字符串形态不能蒙混过关', () => {
  const sqlite = db();
  const entries = snapshots(3);
  seed(sqlite, entries);
  const binding = JSON.parse(manualVerificationSnapshotSetGuardBinding(entries)) as Array<Record<string, unknown>>;
  expect(typeof binding[0].assessment_version).toBe('number');
  expect(typeof binding[0].processing_attempt).toBe('number');
});

test('绑参个数固定为 1，不随快照条数增长', () => {
  expect((MANUAL_VERIFICATION_SNAPSHOT_SET_GUARD_SQL.match(/\?/g) || []).length).toBe(1);
  for (const count of [0, 1, 12, 50]) {
    const bound = [manualVerificationSnapshotSetGuardBinding(snapshots(count))];
    expect(bound).toHaveLength(1);
    expect(typeof bound[0]).toBe('string');
  }
  // 旧写法在 12 条时就要 132 个绑参，D1 单语句上限只有 100。
  expect(snapshots(12).flatMap((entry) =>
    manualVerificationSnapshotGuardBindings(entry.lead_id, entry.verification))).toHaveLength(132);
});
