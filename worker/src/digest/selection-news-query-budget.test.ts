// D1 热点查询预算守护(2026-09-02 行业要闻 D1 CPU 超限事故的回归防线)。
//
// 事故复盘:8/27 PR #220 把「正式信源授权」JOIN 嵌进候选发现大查询后,
//   · registry 是 CTE(无索引)、连接键 json_extract(i.extra,'$.feed_id') 套 CASE(不可索引);
//   · 时间窗写成 datetime(i.scraped_at) >= ...,列被函数包住 → items 上所有 scraped_at 索引全部失效;
//   · 规划器只剩 idx_items_deleted 这种几乎无选择性的索引(96,370 行里 96,369 行 deleted_at IS NULL);
//   → 每天 07:50 的行业要闻批次都在做数百万行扫描 + 每行多次 JSON 解析,9/2 撞穿 D1 CPU 限额,
//     批次重建连败 3 次、08:00 回补再败 3 次。
//
// 单元测试查不出这种问题:小夹具上错的计划也只要几毫秒。所以本文件用**生产规模夹具**
// (10 万行 items + 40 个 sources + 真迁移的全部索引),同时断言两件事:
//   ① 计划:候选发现必须 SEARCH ... USING INDEX,不能 SCAN items;授权必须由候选 id 驱动;
//   ② 时间:整条两阶段流水线在该夹具上 < 2s。
// 阈值给得很松(防 CI 抖动),但对事故那种数百万行扫描足够红 —— 文件末尾的变异验证把旧的
// 单体大查询原样跑一遍,证明守护确实会红。

import { afterAll, beforeAll, expect, test } from 'vitest';

import {
  authorizeFormalNewsSet,
  buildFormalNewsRegistryJson,
  FORMAL_NEWS_REGISTRY_CTE,
  formalNewsScheduledSqlPredicate,
} from './news-source-policy';
import { FEED_REGISTRY } from '../feeds/registry';
import {
  authorizeNewsCandidateRows,
  discoverNewsCandidateIds,
  newsCandidateWindow,
  selectNewsByScoreWithAudit,
} from './selection';
import { envWithDb, SqliteD1 } from './selection-news-query.test-fixture';

// 生产 items 行数量级(事故当天 96,370),取整到 10 万。
// blog/podcast 自 2026-06-09 接入起累积约 4 千行,其余是 X list;照这个比例造。
const FIXTURE_X_ROWS = 96_000;
const FIXTURE_FEED_ROWS = 4_000;
const FIXTURE_ITEM_ROWS = FIXTURE_X_ROWS + FIXTURE_FEED_ROWS;
// 4,000 条 blog/podcast 摊在 90 天里 ≈ 44 条/天,3 天窗口内 ≈ 134 条 —— 与事故当天
// 「实际目标只有约 144 条」同量级。夹具必须复刻这个「大表 + 小目标」的形状,
// 否则测不出「规划器错选索引后要扫多少无关行」。
const FIXTURE_FEED_SPAN_DAYS = 90;
const FIXTURE_X_SPAN_DAYS = 70;
const AS_OF = '2026-09-03';
// 宽松阈值:本地实测整条两阶段流水线 ~30ms,给 CI 共享 runner 留 60x 冗余。
const TWO_PHASE_BUDGET_MS = 2_000;

let db: SqliteD1;

function elapsedMs(fn: () => unknown): number {
  const started = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

async function elapsedMsAsync(fn: () => Promise<unknown>): Promise<number> {
  const started = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - started) / 1e6;
}

beforeAll(() => {
  db = new SqliteD1();

  const feeds = FEED_REGISTRY;
  const insertSource = db.sqlite.prepare(
    'INSERT INTO sources (id, source_type, source_ref, name, config) VALUES (?, ?, ?, ?, ?)',
  );
  for (const feed of feeds) {
    insertSource.run(feed.id, feed.kind, feed.key, feed.name, JSON.stringify(feed));
  }

  // 批量构造:单事务 + 单条 prepared statement,10 万行本地 ~1s。
  const insertItem = db.sqlite.prepare(
    `INSERT INTO items (id, source_type, source_id, source_ref, title, content, content_translated,
       published_at, scraped_at, is_relevant, extra, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const anchorMs = Date.parse(`${AS_OF}T00:00:00.000Z`);
  const feedStepMs = (FIXTURE_FEED_SPAN_DAYS * 86400_000) / FIXTURE_FEED_ROWS;
  const xStepMs = (FIXTURE_X_SPAN_DAYS * 86400_000) / FIXTURE_X_ROWS;
  db.sqlite.exec('BEGIN');
  for (let index = 0; index < FIXTURE_FEED_ROWS; index++) {
    const feed = feeds[index % feeds.length];
    const scrapedAt = new Date(anchorMs - Math.round(index * feedStepMs)).toISOString();
    const sourceId = `${feed.key}:item-${index}`;
    insertItem.run(
      `${feed.kind}:${sourceId}`,
      feed.kind,
      sourceId,
      null,
      `${feed.source_company} ships update ${index}`,
      'body',
      null,
      scrapedAt,
      scrapedAt,
      1,
      JSON.stringify({
        feed_id: feed.id,
        [feed.kind === 'podcast' ? 'show_key' : 'feed_key']: feed.key,
        editorial_type: feed.editorial_type,
        ai_category: 'model-release',
        ai_summary_zh: `第 ${index} 条中文摘要。`,
        source_company: feed.source_company,
      }),
      null,
    );
  }
  for (let index = 0; index < FIXTURE_X_ROWS; index++) {
    // X list 占绝大多数;deleted_at 几乎全为 NULL —— 这正是 idx_items_deleted
    // 毫无选择性(96,370 行里 96,369 行满足)、把规划器带进沟里的原因,照抄事故当天的分布。
    const scrapedAt = new Date(anchorMs - Math.round(index * xStepMs)).toISOString();
    insertItem.run(
      `x_list:tweet-${index}`,
      'x_list',
      `tweet-${index}`,
      null,
      `tweet ${index}`,
      'body',
      null,
      scrapedAt,
      scrapedAt,
      index % 3 === 0 ? 1 : 0,
      JSON.stringify({ list_id: 'l1' }),
      index === 7 ? 1_756_000_000 : null,
    );
  }
  db.sqlite.exec('COMMIT');
  db.sqlite.exec('ANALYZE');
}, 120_000);

afterAll(() => db?.close());

test('夹具确实是生产形状:10 万行 items + 生产索引集合 + deleted_at 几乎无选择性', () => {
  const total = db.sqlite.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
  expect(total.n).toBe(FIXTURE_ITEM_ROWS);
  const live = db.sqlite.prepare('SELECT COUNT(*) AS n FROM items WHERE deleted_at IS NULL').get() as { n: number };
  expect(live.n).toBe(FIXTURE_ITEM_ROWS - 1);

  const indexes = db.itemIndexNames();
  // 事故里被规划器选中的那条 + 本次修复实际吃到的那条,都必须在夹具里存在,
  // 否则计划断言没有意义。
  expect(indexes).toContain('idx_items_deleted');
  expect(indexes).toContain('idx_items_source_scraped');
  expect(indexes).toContain('idx_items_feed_src');
  expect(indexes).toContain('idx_items_feed_src_pub');
});

test('阶段一候选发现:主表访问是 SEARCH USING INDEX,不是 SCAN items', async () => {
  const window = newsCandidateWindow(AS_OF);
  const plan = db.plan(
    `/* news_selection:candidate_discovery */
     SELECT i.id FROM items i
      WHERE i.source_type IN ('blog','podcast') AND i.is_relevant = 1
        AND i.scraped_at >= ? AND i.scraped_at < ?
      ORDER BY i.scraped_at DESC LIMIT 5000`,
    window.since,
    window.until,
  ).join('\n');

  expect(plan).toMatch(/SEARCH i USING (COVERING )?INDEX/);
  expect(plan).not.toMatch(/SCAN i\b/);
  // scraped_at 必须真的被当成范围条件用上(裸列比较的全部意义所在)。
  expect(plan).toMatch(/scraped_at>/);
  // 事故里被选中的那条索引不能再出现。
  expect(plan).not.toContain('idx_items_deleted');
});

test('阶段二授权:由候选 id 驱动按主键探 items,registry 不做外层扫描', async () => {
  const window = newsCandidateWindow(AS_OF);
  const ids = await discoverNewsCandidateIds(envWithDb(db), window);
  expect(ids.length).toBeGreaterThan(0);

  const authorizationSql = db.preparedSql.find((sql) => sql.includes('news_selection:candidate_authorization'))
    ?? (await (async () => {
      await authorizeNewsCandidateRows(envWithDb(db), ids.slice(0, 1), window);
      return db.preparedSql.find((sql) => sql.includes('news_selection:candidate_authorization'))!;
    })());

  const plan = db.plan(
    authorizationSql,
    buildFormalNewsRegistryJson(),
    JSON.stringify(ids.slice(0, 300)),
    window.since,
    window.until,
  );
  const joined = plan.join('\n');

  // items 必须走主键探测,而不是 source_type/deleted_at 之类的宽索引扫描。
  expect(joined).toMatch(/SEARCH i USING (COVERING )?INDEX sqlite_autoindex_items_1 \(id=\?\)/);
  // registry 被 MATERIALIZE 成临时表 + automatic index,不再对每条候选重新展开一次 json_each。
  expect(joined).toContain('MATERIALIZE registry');
  expect(joined).toMatch(/SEARCH r USING AUTOMATIC [A-Z ]*INDEX \(id=\?/);
  // items 与 sources 都不能出现全表/全索引扫描。
  expect(joined).not.toMatch(/SCAN i\b/);
  expect(joined).not.toMatch(/SCAN s\b/);
  // 唯一允许的 SCAN 是两个 json_each 虚表(registry 物化 + 候选 id 展开),
  // 即驱动集合恒等于「有上限的候选 id 列表」。
  const scans = plan.filter((line) => line.startsWith('SCAN'));
  expect(scans.every((line) => line.includes('json_each')), scans.join(' | ')).toBe(true);
});

test('生产规模夹具上,整条两阶段流水线在预算内跑完', async () => {
  const window = newsCandidateWindow(AS_OF);
  const ids = await discoverNewsCandidateIds(envWithDb(db), window);
  // 候选量级必须与生产同量级(~144 条)且远在安全阀之内;命中上限说明拆分没起到收敛作用。
  expect(ids.length).toBeGreaterThan(100);
  expect(ids.length).toBeLessThan(300);

  const ms = await elapsedMsAsync(() => selectNewsByScoreWithAudit(envWithDb(db), 30, { asOfDate: AS_OF }));
  expect(ms, `two-phase pipeline took ${ms.toFixed(1)}ms`).toBeLessThan(TWO_PHASE_BUDGET_MS);

  const result = await selectNewsByScoreWithAudit(envWithDb(db), 30, { asOfDate: AS_OF });
  expect(result.ids.length).toBeGreaterThan(0);
}, 60_000);

test('变异验证:把事故前的单体大查询放回去,同一份夹具上预算守护必红', () => {
  const window = newsCandidateWindow(AS_OF);
  const legacySql = `
    WITH ${FORMAL_NEWS_REGISTRY_CTE}, bounds AS (SELECT ? AS as_of)
    SELECT i.id, i.title, i.source_type, i.content, i.content_translated, i.extra, i.published_at
    FROM items i
    JOIN registry r ON r.id=json_extract(
      CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END,
      '$.feed_id')
    JOIN sources s ON s.id=r.id
    WHERE i.source_type IN ('blog','podcast')
      AND i.is_relevant = 1
      AND datetime(i.scraped_at) >= datetime((SELECT as_of FROM bounds), '-3 day')
      AND datetime(i.scraped_at) < datetime((SELECT as_of FROM bounds))
      AND ${formalNewsScheduledSqlPredicate('i', 'r', 's')}`;

  // 事故形态的计划:时间窗被 datetime() 包住 → scraped_at 索引全失效。
  const legacyPlan = db.plan(legacySql, buildFormalNewsRegistryJson(), AS_OF).join('\n');
  expect(legacyPlan).not.toMatch(/scraped_at>/);

  const legacyMs = elapsedMs(() =>
    db.sqlite.prepare(legacySql).all(buildFormalNewsRegistryJson(), AS_OF));
  const twoPhaseMs = elapsedMs(() => {
    const ids = (db.sqlite.prepare(
      `SELECT i.id FROM items i
        WHERE i.source_type IN ('blog','podcast') AND i.is_relevant = 1
          AND i.scraped_at >= ? AND i.scraped_at < ?
        ORDER BY i.scraped_at DESC LIMIT 5000`,
    ).all(window.since, window.until ?? '') as Array<{ id: string }>).map((row) => row.id);
    return ids.length;
  });

  // 旧形态比阶段一慢一个数量级以上 —— 这就是每天 07:50 烧掉 D1 CPU 预算的那部分。
  expect(legacyMs, `legacy=${legacyMs.toFixed(1)}ms two-phase-discovery=${twoPhaseMs.toFixed(1)}ms`)
    .toBeGreaterThan(twoPhaseMs * 10);
}, 120_000);

// ── 授权 JOIN 形态全仓审计 ─────────────────────────────────────────────────────
// FORMAL_NEWS_REGISTRY_CTE 的每一个消费点都必须「驱动集合有上限」。下面把仓里全部
// 消费点在生产规模夹具上跑 EXPLAIN QUERY PLAN,逐条钉死:items 不得出现 SCAN /
// 宽索引扫描,只能按主键(或 expected 快照给定的 id)探测。
test('审计:剩余的 registry/sources 授权 JOIN 消费点全部由有上限的 id 集合驱动', async () => {
  // ① selection.ts 的「已推账本」重校验(fetchNewsCandidatesByIds,每批 ≤80 个 id)。
  const ledgerSql = db.preparedSql.find((sql) => sql.includes('news_selection:pushed_ledger_authorization'))
    ?? await (async () => {
      db.sqlite.exec(
        `INSERT INTO digest_pool (source, slot_key, density, item_ids, generated_at)
         VALUES ('news','2026-09-01-08','normal','["blog:openai:item-0"]',${Date.now() - 2 * 86400_000})`,
      );
      await selectNewsByScoreWithAudit(envWithDb(db), 5, { strictCrossDayEventDedup: true });
      return db.preparedSql.find((sql) => sql.includes('news_selection:pushed_ledger_authorization'))!;
    })();
  const ledgerPlan = db.plan(
    ledgerSql, buildFormalNewsRegistryJson(), JSON.stringify(['blog:openai:item-0']),
  );
  expect(ledgerPlan.join('\n')).toMatch(/SEARCH i USING (COVERING )?INDEX sqlite_autoindex_items_1 \(id=\?\)/);
  expect(ledgerPlan.filter((line) => line.startsWith('SCAN')).every((line) => line.includes('json_each')))
    .toBe(true);

  // ② news-source-policy.ts 的 early scheduled join(loadScheduledAuthorizationRows):
  //    LEFT JOIN 已经把 requested 钉在最外层,items 按主键探。
  await authorizeFormalNewsSet(envWithDb(db), '2026-09-02', ['blog:openai:item-0'], 'plan-audit');
  const earlyJoinSql = db.preparedSql.find((sql) => sql.includes('formal_news:early_scheduled_join'))!;
  const earlyPlan = db.plan(
    earlyJoinSql, buildFormalNewsRegistryJson(), JSON.stringify(['blog:openai:item-0']),
  );
  expect(earlyPlan.join('\n')).toMatch(/SEARCH i USING (COVERING )?INDEX sqlite_autoindex_items_1 \(id=\?\)/);
  expect(earlyPlan.filter((line) => line.startsWith('SCAN')).every((line) => line.includes('json_each')))
    .toBe(true);

  // ③ formalNewsFinalGuardCtes 的最终守卫:驱动集合是 formal_expected(发布快照里的
  //    条目数,天然有上限),items 同样按 expected 里的 item_id 主键探。
  const finalGuardSql = db.preparedSql.find((sql) => sql.includes('formal_news:final_guard_single_snapshot'));
  if (finalGuardSql) {
    const guardPlan = db.plan(finalGuardSql, buildFormalNewsRegistryJson(), '[]', '2026-09-02');
    expect(guardPlan.join('\n')).not.toMatch(/SCAN i\b/);
  }
}, 120_000);
