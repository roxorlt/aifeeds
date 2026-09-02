// 「候选发现 / 授权」两阶段拆分的授权行为不回退矩阵(2026-09-02 D1 CPU 超限事故修复)。
//
// 拆分前:一条大查询同时做候选发现 + 授权。
// 拆分后:阶段一纯索引发现候选 id,阶段二把候选 id 喂给逐字未改的授权谓词。
//
// 本文件在**真 SQLite + 真迁移**上,对每一格「该放行 / 该拒绝」的信源形态,断言
//   ① 两阶段流水线(selectNewsByScoreWithAudit)的放行结论,
//   ② 与「拆分前那条单体大查询」在同一份数据上的结论逐条一致。
// ② 是关键:它让矩阵同时成为「拆分零语义漂移」的证明,而不只是重述当前实现的行为。

import { afterEach, describe, expect, test } from 'vitest';

import {
  buildFormalNewsRegistryJson,
  FORMAL_NEWS_REGISTRY_CTE,
  formalNewsScheduledSqlPredicate,
} from './news-source-policy';
import {
  authorizeNewsCandidateRows,
  discoverNewsCandidateIds,
  newsCandidateWindow,
  selectNewsByScoreWithAudit,
} from './selection';
import {
  envWithDb,
  insertItem,
  insertSource,
  scheduledItem,
  SqliteD1,
  type ItemInput,
} from './selection-news-query.test-fixture';

const opened: SqliteD1[] = [];
afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

const NOW = Date.parse('2026-09-02T07:50:00.000Z');
const IN_WINDOW = new Date(NOW - 6 * 3600_000).toISOString();

/**
 * 事故前(8/27 PR #220 ~ 9/2)那条单体大查询,逐字保留。矩阵用它做「拆分前结论」的基准。
 * 唯一改动:时间窗锚点由 datetime('now',...) 改成绑参,好让测试能锚定固定时刻 —— 窗口语义不变。
 */
function legacySingleQueryIds(db: SqliteD1, asOfSqlDate: string): string[] {
  const cat = `json_extract(i.extra,'$.ai_category')`;
  const tzh = `json_extract(i.extra,'$.title_zh')`;
  const sql = `
    WITH ${FORMAL_NEWS_REGISTRY_CTE}
    SELECT i.id
    FROM items i
    JOIN registry r ON r.id=json_extract(
      CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END,
      '$.feed_id')
    JOIN sources s ON s.id=r.id
    WHERE i.source_type IN ('blog','podcast')
      AND i.is_relevant = 1
      AND datetime(i.scraped_at) >= datetime(?, '-3 day')
      AND datetime(i.scraped_at) < datetime(?)
      AND ${formalNewsScheduledSqlPredicate('i', 'r', 's')}
      AND lower(COALESCE(title,'')) NOT LIKE '%not much happened%'
      AND lower(COALESCE(title,'')) NOT LIKE '%nothing happened%'
      AND lower(COALESCE(title,'')) NOT LIKE '%slow news%'
      AND COALESCE(${tzh},'') NOT LIKE '%没什么大事%'
      AND NOT (
        ${cat} = 'other' AND (
          (lower(COALESCE(title,'')) LIKE '% off %' AND (lower(COALESCE(title,'')) LIKE '%tix%' OR lower(COALESCE(title,'')) LIKE '%ticket%'))
          OR lower(COALESCE(title,'')) LIKE '%early bird%'
          OR lower(COALESCE(title,'')) LIKE '%promo code%'
          OR lower(COALESCE(title,'')) LIKE '%register now%'
          OR COALESCE(${tzh},'') LIKE '%门票%'
          OR COALESCE(${tzh},'') LIKE '%早鸟%'
          OR COALESCE(${tzh},'') LIKE '%报名%'
          OR COALESCE(${tzh},'') LIKE '%优惠码%'
        )
      )
    ORDER BY i.id`;
  return (db.sqlite.prepare(sql).all(
    buildFormalNewsRegistryJson(), asOfSqlDate, asOfSqlDate,
  ) as Array<{ id: string }>).map((row) => row.id);
}

// asOfDate='2026-09-03' → 窗口 [2026-08-31T00:00:00.000Z, 2026-09-03T00:00:00.000Z)
const AS_OF = '2026-09-03';

/** 阶段一 + 阶段二跑完后的「授权放行集合」(打分/折叠之前,正是授权边界本身)。 */
async function twoPhaseAuthorizedIds(db: SqliteD1): Promise<string[]> {
  const window = newsCandidateWindow(AS_OF);
  const ids = await discoverNewsCandidateIds(envWithDb(db), window);
  const rows = await authorizeNewsCandidateRows(envWithDb(db), ids, window);
  return rows.map((row) => row.id).sort();
}

/** 同一份数据上两条路径的结论必须逐条一致;返回放行集合供逐格断言。 */
async function bothPathsAgree(db: SqliteD1): Promise<string[]> {
  const twoPhase = await twoPhaseAuthorizedIds(db);
  const legacy = legacySingleQueryIds(db, AS_OF).sort();
  expect(twoPhase, 'two-phase vs legacy single-query verdicts must match').toEqual(legacy);
  return twoPhase;
}

interface MatrixCase {
  name: string;
  allowed: boolean;
  feedId: string;
  slug: string;
  setup?: (db: SqliteD1) => void;
  item?: Partial<ItemInput> & { extraPatch?: Record<string, unknown> };
  /** 该 case 需要额外落库的 sources 行(默认按 registry 真值落 feedId 那条)。 */
  sourceOverrides?: Record<string, unknown>;
  /** true = 干脆不落 sources 行。 */
  omitSource?: boolean;
}

const MATRIX: MatrixCase[] = [
  {
    name: '官方 blog(blog:openai):放行',
    allowed: true,
    feedId: 'blog:openai',
    slug: 'gpt-launch',
  },
  {
    name: '第三方媒体 blog(blog:techcrunch):放行',
    allowed: true,
    feedId: 'blog:techcrunch',
    slug: 'coverage',
  },
  {
    name: '音频播客(podcast:latent-space,source_type=podcast + show_key):放行',
    allowed: true,
    feedId: 'podcast:latent-space',
    slug: 'episode-1',
  },
  {
    name: '播客的文字形态(source_type=blog + feed_key,历史生产者形状):放行',
    allowed: true,
    feedId: 'podcast:latent-space',
    slug: 'post-1',
    item: {
      sourceType: 'blog',
      extraPatch: { show_key: undefined, feed_key: 'latent-space' },
    },
  },
  {
    name: '旧数据缺 editorial_type(item.extra 无该字段):有限兼容,放行',
    allowed: true,
    feedId: 'blog:openai',
    slug: 'legacy-no-editorial-type',
    item: { extraPatch: { editorial_type: undefined } },
  },
  {
    name: 'item.editorial_type 与 registry 不一致:拒绝',
    allowed: false,
    feedId: 'blog:openai',
    slug: 'editorial-type-drift',
    item: { extraPatch: { editorial_type: 'third-party-media' } },
  },
  {
    name: 'radar 信源(blog:weibo-hot-tech):拒绝',
    allowed: false,
    feedId: 'blog:weibo-hot-tech',
    slug: 'hot-rumor',
  },
  {
    name: '禁用信源(sources.config.enabled=false):拒绝',
    allowed: false,
    feedId: 'blog:mistral',
    slug: 'disabled-feed',
    sourceOverrides: { configPatch: { enabled: false } },
  },
  {
    name: 'sources 行缺失(冻结后信源被摘掉):拒绝',
    allowed: false,
    feedId: 'blog:cohere',
    slug: 'source-row-gone',
    omitSource: true,
  },
  {
    name: 'sources.config 被改成非法 JSON(冻结后配置损坏):拒绝',
    allowed: false,
    feedId: 'blog:together',
    slug: 'broken-config',
    sourceOverrides: { config: '{' },
  },
  {
    name: 'sources.config.key 与 registry 漂移(信源改名):拒绝',
    allowed: false,
    feedId: 'blog:stability',
    slug: 'key-drift',
    sourceOverrides: { configPatch: { key: 'stability-renamed' } },
  },
  {
    name: '人工补录已确认 item(source_ref=manual_lead):不走 scheduled 授权,拒绝',
    allowed: false,
    feedId: 'blog:openai',
    slug: 'manual-verified',
    item: {
      sourceRef: 'manual_lead',
      extraPatch: { manual_lead: { lead_id: 'lead-1', evidence_ids: ['e1'] } },
    },
  },
  {
    name: '人工补录未验证 item(manual: 命名空间):拒绝',
    allowed: false,
    feedId: 'blog:openai',
    slug: 'manual-unverified',
    item: {
      sourceRef: 'manual_lead',
      extraPatch: { feed_key: undefined, manual_lead: { lead_id: 'lead-2' } },
    },
  },
  {
    name: '已软删 item(deleted_at 非空):拒绝',
    allowed: false,
    feedId: 'blog:google',
    slug: 'soft-deleted',
    item: { deletedAt: 1_756_000_000 },
  },
  {
    // 注:真正的「extra 非法 JSON」在生产里插不进去 —— migration 022 的
    // idx_items_url_hash 是 json_extract 表达式索引,写入时就会 "malformed JSON" 报错。
    // 能落库的畸形形态是「合法 JSON 但不是 object」,授权谓词靠 json_type(extra)='object' 拦。
    name: 'extra 是合法 JSON 但不是 object:拒绝',
    allowed: false,
    feedId: 'blog:nvidia',
    slug: 'non-object-extra',
    item: { extra: '["blog:nvidia"]' },
  },
  {
    name: 'item.id 与 source_id 不自洽(伪造 id 前缀):拒绝',
    allowed: false,
    feedId: 'blog:anthropic',
    slug: 'forged-id',
    item: { id: 'blog:anthropic:forged-id-mismatch' },
  },
  {
    name: 'feed_id 指向不存在的 registry 条目:拒绝',
    allowed: false,
    feedId: 'blog:huggingface',
    slug: 'unknown-feed',
    item: { extraPatch: { feed_id: 'blog:not-in-registry' } },
  },
];

describe('两阶段拆分:授权行为不回退矩阵(真 SQLite + 真迁移)', () => {
  for (const matrixCase of MATRIX) {
    test(`${matrixCase.name}`, async () => {
      const db = new SqliteD1();
      opened.push(db);
      // 每格都放一条「一定放行」的对照 item,确保矩阵不是靠「整体选空」蒙混过关。
      insertSource(db, 'blog:qwen');
      insertItem(db, scheduledItem('blog:qwen', 'control', IN_WINDOW));

      if (!matrixCase.omitSource && matrixCase.feedId !== 'blog:qwen') {
        insertSource(db, matrixCase.feedId, matrixCase.sourceOverrides ?? {});
      }
      matrixCase.setup?.(db);
      insertItem(db, scheduledItem(matrixCase.feedId, matrixCase.slug, IN_WINDOW, matrixCase.item ?? {}));

      const allowed = await bothPathsAgree(db);
      expect(allowed, 'control item must always survive').toContain('blog:qwen:control');
      const subject = scheduledItem(matrixCase.feedId, matrixCase.slug, IN_WINDOW, matrixCase.item ?? {}).id;
      expect(allowed.includes(subject)).toBe(matrixCase.allowed);
    });
  }

  test('时间窗边界:窗外的合法官方文章不进候选,窗内的进', async () => {
    const db = new SqliteD1();
    opened.push(db);
    insertSource(db, 'blog:openai');
    // asOfDate='2026-09-03' → [2026-08-31T00:00:00.000Z, 2026-09-03T00:00:00.000Z)
    insertItem(db, scheduledItem('blog:openai', 'below-bound', '2026-08-30T23:59:59.999Z'));
    insertItem(db, scheduledItem('blog:openai', 'at-lower-bound', '2026-08-31T00:00:00.000Z'));
    insertItem(db, scheduledItem('blog:openai', 'inside', '2026-09-02T12:00:00.000Z'));
    insertItem(db, scheduledItem('blog:openai', 'at-upper-bound', '2026-09-03T00:00:00.000Z'));

    const allowed = await bothPathsAgree(db);
    expect(allowed).toEqual([
      'blog:openai:at-lower-bound',
      'blog:openai:inside',
    ]);
  });

  test('噪音过滤(slow-news / 门票广告)在拆分后仍然生效,且两条路径结论一致', async () => {
    const db = new SqliteD1();
    opened.push(db);
    insertSource(db, 'blog:openai');
    insertItem(db, scheduledItem('blog:openai', 'real-news', IN_WINDOW, { title: 'OpenAI ships a new model' }));
    insertItem(db, scheduledItem('blog:openai', 'slow-news', IN_WINDOW, {
      title: '[AINews] not much happened today',
    }));
    insertItem(db, scheduledItem('blog:openai', 'ticket-ad', IN_WINDOW, {
      title: '[Exclusive] $250 off AI Engineer tix',
      extraPatch: { ai_category: 'other' },
    }));
    insertItem(db, scheduledItem('blog:openai', 'zh-ticket-ad', IN_WINDOW, {
      title: 'conference',
      extraPatch: { ai_category: 'other', title_zh: '早鸟报名开启' },
    }));
    // 被正确分类的真新闻即使标题含 "register now" 也不该被误伤(噪音过滤②限定 ai_category='other')。
    insertItem(db, scheduledItem('blog:openai', 'classified-not-other', IN_WINDOW, {
      title: 'Register now for the new model preview',
      extraPatch: { ai_category: 'model-release' },
    }));

    const allowed = await bothPathsAgree(db);
    expect(allowed).toEqual([
      'blog:openai:classified-not-other',
      'blog:openai:real-news',
    ]);
  });

  test('is_relevant≠1 的行(未判定 / 判非 AI)两条路径都排除', async () => {
    const db = new SqliteD1();
    opened.push(db);
    insertSource(db, 'blog:openai');
    insertItem(db, scheduledItem('blog:openai', 'relevant', IN_WINDOW, { isRelevant: 1 }));
    insertItem(db, scheduledItem('blog:openai', 'not-relevant', IN_WINDOW, { isRelevant: 0 }));
    insertItem(db, scheduledItem('blog:openai', 'unjudged', IN_WINDOW, { isRelevant: null }));

    expect(await bothPathsAgree(db)).toEqual(['blog:openai:relevant']);
  });

  test('端到端:selectNewsByScoreWithAudit 在拆分后仍然只吐授权通过的 item', async () => {
    const db = new SqliteD1();
    opened.push(db);
    insertSource(db, 'blog:openai');
    insertSource(db, 'blog:weibo-hot-tech');
    insertItem(db, scheduledItem('blog:openai', 'anthropic-rival-model', IN_WINDOW, {
      title: 'OpenAI ships a rival reasoning model',
    }));
    insertItem(db, scheduledItem('blog:weibo-hot-tech', 'street-rumor', IN_WINDOW, {
      title: 'Unverified street rumor about a chip deal',
    }));

    const result = await selectNewsByScoreWithAudit(envWithDb(db), 10, { asOfDate: AS_OF });
    expect(result.ids).toEqual(['blog:openai:anthropic-rival-model']);
    expect(result.audit.selected_ids).toEqual(['blog:openai:anthropic-rival-model']);
  });

  test('变异验证:阶段二删掉授权谓词后,radar / 禁用信源会漏放行(矩阵必红)', async () => {
    const db = new SqliteD1();
    opened.push(db);
    insertSource(db, 'blog:weibo-hot-tech');
    insertSource(db, 'blog:mistral', { configPatch: { enabled: false } });
    insertItem(db, scheduledItem('blog:weibo-hot-tech', 'hot-rumor', IN_WINDOW));
    insertItem(db, scheduledItem('blog:mistral', 'disabled-feed', IN_WINDOW));

    // 真实流水线:两条都被拒。
    expect(await twoPhaseAuthorizedIds(db)).toEqual([]);

    // 变异体 = 阶段二只保留 JOIN、删掉 formalNewsScheduledSqlPredicate。
    const mutated = `
      WITH ${FORMAL_NEWS_REGISTRY_CTE}, requested AS (SELECT value AS id FROM json_each(?))
      SELECT i.id FROM requested q
        JOIN items i ON i.id=q.id
        JOIN registry r ON r.id=json_extract(
          CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END,
          '$.feed_id')
        JOIN sources s ON s.id=r.id
       WHERE i.source_type IN ('blog','podcast') AND i.is_relevant = 1
       ORDER BY i.id`;
    const leaked = (db.sqlite.prepare(mutated).all(
      buildFormalNewsRegistryJson(),
      JSON.stringify(['blog:weibo-hot-tech:hot-rumor', 'blog:mistral:disabled-feed']),
    ) as Array<{ id: string }>).map((row) => row.id);
    expect(leaked).toEqual(['blog:mistral:disabled-feed', 'blog:weibo-hot-tech:hot-rumor']);
  });
});
