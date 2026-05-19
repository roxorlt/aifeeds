/**
 * HF Daily Papers — staging → prod 一次性搬运脚本(上线日跑一次)
 *
 * 用法(从 worker/ 目录):
 *   # 完整跑(D1 + R2)
 *   npx tsx scripts/migrate-hf-staging-to-prod.ts
 *
 *   # 只检查不写
 *   npx tsx scripts/migrate-hf-staging-to-prod.ts --dry-run
 *
 *   # 分阶段
 *   npx tsx scripts/migrate-hf-staging-to-prod.ts --d1-only
 *   npx tsx scripts/migrate-hf-staging-to-prod.ts --r2-only
 *
 * 前置:
 *   source /Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env
 *   (取 ADMIN_USER / ADMIN_PASS,用于 prod /api/admin/* Basic Auth)
 *
 * 设计:
 *   - D1:wrangler d1 execute SELECT staging → 生成 INSERT OR REPLACE → wrangler d1 execute prod
 *   - R2:从 D1 抽 R2 keys → POST prod admin endpoint(prod worker 内 fetch staging /r/<key> → put 本地 R2)
 *   - 不需要 R2 dual-binding 也不依赖 wrangler r2 object(没 bulk copy)
 *
 * 安全:
 *   - 默认 prod 已有 key 不覆盖(--force 显式覆盖)
 *   - D1 用 INSERT OR REPLACE(prod 已存在的 hf_paper item 会被 staging 数据覆盖,上线日不应有 prod 数据)
 */

import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PROD_ORIGIN = 'https://api.ai-feeds.com';
const STAGING_ORIGIN = 'https://staging-api.ai-feeds.com';
const STAGING_DB = 'xlist-staging';
const PROD_DB = 'xlist';
const R2_BATCH = 50;                                                                // /api/admin/hf-r2-migrate-from-staging hard cap 200,留余量

const args = new Set(process.argv.slice(2));
const dryRun = args.has('--dry-run');
const d1Only = args.has('--d1-only');
const r2Only = args.has('--r2-only');
const force = args.has('--force');

const adminUser = process.env.ADMIN_USER;
const adminPass = process.env.ADMIN_PASS;
if (!r2Only && !d1Only && (!adminUser || !adminPass)) {
  console.error('FATAL: 需要 source .secrets/aifeeds-prod.env(ADMIN_USER / ADMIN_PASS 用于 R2 batch)');
  process.exit(1);
}
const adminAuth = adminUser && adminPass ? `Basic ${Buffer.from(`${adminUser}:${adminPass}`).toString('base64')}` : '';

const TMP_DIR = join(tmpdir(), `hf-migrate-${Date.now()}`);
mkdirSync(TMP_DIR, { recursive: true });
console.log(`[migrate] tmp dir: ${TMP_DIR}`);
console.log(`[migrate] dry_run=${dryRun} d1_only=${d1Only} r2_only=${r2Only} force=${force}`);

/**
 * wrangler d1 输出含 ANSI color + meta,要剥出 JSON 块
 */
function wranglerJsonSelect(dbName: string, env: 'staging' | 'prod', sql: string): unknown[] {
  const envFlag = env === 'staging' ? '--env staging' : '';
  const cmd = `npx wrangler d1 execute ${dbName} ${envFlag} --remote --json --command ${JSON.stringify(sql)}`;
  const raw = execSync(cmd, { encoding: 'utf-8', maxBuffer: 100 * 1024 * 1024 });
  const start = raw.indexOf('[');
  const end = raw.lastIndexOf(']');
  if (start < 0 || end < 0) throw new Error(`wrangler 输出无 JSON: ${raw.slice(0, 200)}`);
  const json = JSON.parse(raw.slice(start, end + 1));
  return json[0]?.results || [];
}

function wranglerExecFile(dbName: string, env: 'staging' | 'prod', sqlFile: string): void {
  const envFlag = env === 'staging' ? '--env staging' : '';
  const cmd = `npx wrangler d1 execute ${dbName} ${envFlag} --remote --file=${sqlFile}`;
  console.log(`[migrate] exec: ${cmd}`);
  if (dryRun) { console.log('  [dry-run skip]'); return; }
  execSync(cmd, { stdio: 'inherit' });
}

/**
 * 生成 INSERT OR REPLACE SQL,column 名硬编码避免 schema 漂移
 */
function buildInsertSqlForItems(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = [
    'id', 'source_type', 'source_id', 'source_ref',
    'title', 'content', 'content_translated', 'author', 'handle',
    'url', 'media', 'metrics', 'published_at', 'scraped_at',
    'is_relevant', 'matched_by', 'lang', 'extra',
    'translation_quality', 'translation_attempts',
    'tier', 'next_refresh_at', 'last_velocity', 'deleted_at',
  ];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  const lines = rows.map(
    (r) => `INSERT OR REPLACE INTO items (${cols.join(',')}) VALUES (${cols.map((c) => escape(r[c])).join(',')});`,
  );
  return lines.join('\n') + '\n';
}

function buildInsertSqlForMetricsSnapshots(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return '';
  const cols = ['item_id', 'captured_at', 'upvotes', 'num_comments', 'github_stars'];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };
  // 不带 id(AUTOINCREMENT)
  const lines = rows.map(
    (r) => `INSERT INTO metrics_snapshots_hf_paper (${cols.join(',')}) VALUES (${cols.map((c) => escape(r[c])).join(',')});`,
  );
  return lines.join('\n') + '\n';
}

/**
 * 从 items rows 抽出全部 R2 key(去 /r/ 前缀)
 */
function extractR2Keys(rows: Record<string, unknown>[]): string[] {
  const keys = new Set<string>();
  const collect = (raw: unknown): void => {
    if (typeof raw !== 'string') return;
    const trimmed = raw.startsWith('/r/') ? raw.slice(3) : raw.startsWith('/') ? '' : '';
    if (trimmed) keys.add(trimmed);
  };
  for (const r of rows) {
    // media[].url
    try {
      const media = r.media ? JSON.parse(r.media as string) : [];
      if (Array.isArray(media)) {
        for (const m of media) collect(m?.url);
      }
    } catch { /* skip malformed */ }
    // extra.figure_image.r2_url + 其他 R2 路径
    try {
      const extra = r.extra ? JSON.parse(r.extra as string) : {};
      collect(extra?.figure_image?.r2_url);
      // discussion_comments[].author_avatar 走 /r/ 反代 — 看 backfillMediaForHfPaper 是否回填
      const comments = extra?.discussion_comments;
      if (Array.isArray(comments)) {
        for (const c of comments) collect(c?.author_avatar);
      }
      collect(extra?.submitter_avatar);
    } catch { /* skip */ }
  }
  return Array.from(keys);
}

async function postR2Batch(keys: string[]): Promise<{ migrated: number; skipped: number; failed: number; details?: unknown }> {
  const url = `${PROD_ORIGIN}/api/admin/hf-r2-migrate-from-staging?${dryRun ? 'dry_run=1' : ''}${force ? '&force=1' : ''}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: adminAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys, source_origin: STAGING_ORIGIN }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`prod admin endpoint HTTP ${r.status}: ${text}`);
  }
  const data = (await r.json()) as { migrated: number; skipped_existing: number; failed: unknown[] };
  return { migrated: data.migrated, skipped: data.skipped_existing, failed: data.failed.length, details: data.failed.length > 0 ? data.failed : undefined };
}

// ────────────────────────────────────────────────────────────────────
// 主流程
// ────────────────────────────────────────────────────────────────────

(async () => {
  // ─── Stage 0:staging count check ───
  const stagingItems = wranglerJsonSelect(STAGING_DB, 'staging', "SELECT * FROM items WHERE source_type='hf_paper';") as Record<string, unknown>[];
  console.log(`[migrate] staging items: ${stagingItems.length}`);
  if (stagingItems.length === 0) {
    console.log('[migrate] staging 无 hf_paper 数据,跳过');
    process.exit(0);
  }

  // prod 现状(防覆盖)
  if (!r2Only) {
    const prodCount = (wranglerJsonSelect(PROD_DB, 'prod', "SELECT COUNT(*) AS n FROM items WHERE source_type='hf_paper';") as Array<{ n: number }>)[0]?.n ?? 0;
    console.log(`[migrate] prod 当前 hf_paper items: ${prodCount}`);
    if (prodCount > 0 && !force) {
      console.error(`[migrate] FATAL: prod 已有 ${prodCount} 条 hf_paper,默认拒绝覆盖。--force 显式确认`);
      process.exit(1);
    }
  }

  // ─── Stage 1:D1 items 表 ───
  if (!r2Only) {
    const sql = buildInsertSqlForItems(stagingItems);
    const itemsSqlFile = join(TMP_DIR, 'items.sql');
    writeFileSync(itemsSqlFile, sql);
    console.log(`[migrate] items SQL: ${sql.length} chars → ${itemsSqlFile}`);
    wranglerExecFile(PROD_DB, 'prod', itemsSqlFile);
  }

  // ─── Stage 2:D1 metrics_snapshots_hf_paper 表 ───
  if (!r2Only) {
    const stagingMetrics = wranglerJsonSelect(STAGING_DB, 'staging', "SELECT * FROM metrics_snapshots_hf_paper;") as Record<string, unknown>[];
    console.log(`[migrate] staging metrics_snapshots_hf_paper rows: ${stagingMetrics.length}`);
    if (stagingMetrics.length > 0) {
      const sql = buildInsertSqlForMetricsSnapshots(stagingMetrics);
      const metricsSqlFile = join(TMP_DIR, 'metrics.sql');
      writeFileSync(metricsSqlFile, sql);
      wranglerExecFile(PROD_DB, 'prod', metricsSqlFile);
    }
  }

  // ─── Stage 3:R2 ───
  if (!d1Only) {
    const keys = extractR2Keys(stagingItems);
    console.log(`[migrate] R2 keys to migrate: ${keys.length}(去重后)`);
    let totalMigrated = 0;
    let totalSkipped = 0;
    let totalFailed = 0;
    const allFailedDetails: unknown[] = [];
    for (let i = 0; i < keys.length; i += R2_BATCH) {
      const batch = keys.slice(i, i + R2_BATCH);
      const result = await postR2Batch(batch);
      console.log(`  batch ${i / R2_BATCH + 1}/${Math.ceil(keys.length / R2_BATCH)}: migrated=${result.migrated} skipped=${result.skipped} failed=${result.failed}`);
      if (result.details) allFailedDetails.push(...(result.details as unknown[]));
      totalMigrated += result.migrated;
      totalSkipped += result.skipped;
      totalFailed += result.failed;
    }
    console.log(`[migrate] R2 总计:migrated=${totalMigrated} skipped_existing=${totalSkipped} failed=${totalFailed}`);
    if (totalFailed > 0) {
      console.error('[migrate] R2 failed details:', JSON.stringify(allFailedDetails.slice(0, 20), null, 2));
    }
  }

  // ─── Stage 4:verify ───
  if (!dryRun) {
    const prodFinalCount = (wranglerJsonSelect(PROD_DB, 'prod', "SELECT COUNT(*) AS n FROM items WHERE source_type='hf_paper';") as Array<{ n: number }>)[0]?.n ?? 0;
    console.log(`[migrate] verify: prod hf_paper count = ${prodFinalCount}(预期 ${stagingItems.length})`);
    if (prodFinalCount !== stagingItems.length) {
      console.error('[migrate] MISMATCH! prod count != staging count');
      process.exit(1);
    }
    console.log('[migrate] ✅ DONE');
  } else {
    console.log('[migrate] dry-run 结束,无写操作');
  }
})().catch((e) => {
  console.error('[migrate] FATAL', e);
  process.exit(1);
});
