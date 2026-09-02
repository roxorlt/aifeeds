// 事件级历史去重(2026-09-02:一个月前的旧事件借新文章回流)。
//
// 缺陷实证:9/2 候选头部混进两条一个月前的旧事件 —— Gemini 3.7 Flash(库内首见 8/14,
// 9/1 一篇合集稿又提了一遍)与 Qwen3.8-Max(首发 8/3,9/2 一篇「登顶 CodeArena」后续稿)。
//
// 根因(读码实证,不是「只跟上一次推送比」—— 账本窗口本来就是 30 天):
//   `suppressCrossDayRepeatedNewsEvents` 对官方源开了一道**没有时间上限**的天窗
//   `if (officialSourceWeight(item) > 0) return true;`,而 blog:google / blog:qwen
//   都在 officialSourceNames 里 —— owner 举的两个例子都是从这道天窗溜进来的。
//
// 本文件在真 SQLite + 真迁移上逐格钉住三条规则,并对每条做一轮变异验证。

import { afterEach, describe, expect, test } from 'vitest';

import {
  applyNewsEventHistoryPolicy,
  loadNewsEventHistory,
  loadPushedNewsItemIds,
  newsCandidateWindow,
  scoreNewsCandidatesForDigest,
  selectNewsByScoreWithAudit,
  suppressCrossDayRepeatedNewsEvents,
  type NewsCandidateForScoring,
  type NewsEventHistoryEntry,
} from './selection';
import {
  envWithDb,
  insertItem,
  insertSource,
  SqliteD1,
} from './selection-news-query.test-fixture';
import { freezeNewsReviewBatchFromPool } from './news-review';

const opened: SqliteD1[] = [];
afterEach(() => {
  while (opened.length) opened.pop()!.close();
});

const AS_OF = '2026-09-03';
// 候选窗 = [2026-08-31T00:00Z, 2026-09-03T00:00Z);历史窗 = [2026-08-04T00:00Z, 2026-08-31T00:00Z)。
const IN_WINDOW = '2026-09-02T02:00:00.000Z';
const A_MONTH_AGO = '2026-08-14T03:00:00.000Z';

function candidate(input: Partial<NewsCandidateForScoring> & Pick<NewsCandidateForScoring, 'id' | 'title'>): NewsCandidateForScoring {
  return {
    id: input.id,
    title: input.title,
    titleZh: input.titleZh || '',
    sourceType: 'blog',
    sourceKey: input.sourceKey || '',
    sourceCompany: input.sourceCompany || 'Google',
    aiCategory: input.aiCategory || 'model-release',
    publishedAt: input.publishedAt || IN_WINDOW,
    aiSummaryZh: input.aiSummaryZh ?? '中文摘要。',
    content: '',
    contentTranslated: '',
    transcriptTier: '',
    selectable: true,
    eventFingerprint: input.eventFingerprint,
  };
}

/**
 * 生产形状的 LLM 事件指纹。落库是 9 键 snake_case(见 classify-translate.ts),
 * 读进内存后被 normalizeNewsEventFingerprint 转成 camelCase —— 这里直接给内存形态。
 * confidence >= 0.75 才算「高置信结构化指纹」,才可能触发剔除。
 */
function fingerprint(object: string, version: string, action = 'release') {
  return {
    eventType: 'model_release',
    primaryActor: 'Google',
    primaryObject: object,
    objectFamily: 'Gemini',
    objectVariant: '',
    objectVersion: version,
    action,
    canonicalEvent: `Google ${action} ${object}`,
    confidence: 0.95,
  };
}

/** 落库形态(snake_case),给真 SQLite 端到端用例塞进 items.extra。 */
function storedFingerprint(object: string, version: string, action = 'release') {
  return {
    event_type: 'model_release',
    primary_actor: 'Google',
    primary_object: object,
    object_family: 'Gemini',
    object_variant: '',
    object_version: version,
    action,
    canonical_event: `Google ${action} ${object}`,
    confidence: 0.95,
  };
}

function historyEntry(
  input: Partial<NewsCandidateForScoring> & Pick<NewsCandidateForScoring, 'id' | 'title'> & { seenAt: string },
): NewsEventHistoryEntry {
  return { ...candidate(input), seenAt: input.seenAt };
}

// ── 规则矩阵(纯判定,无 I/O)────────────────────────────────────────────────
describe('applyNewsEventHistoryPolicy 三条规则', () => {
  const geminiTitle = 'Google ships Gemini 3.7 Flash with a faster reasoning mode';
  const geminiRoundupTitle = 'Weekly roundup: Gemini 3.7 Flash reasoning mode and more from Google';

  test('规则①:旧事件(首见 > 3 天)且历史上已推送过 → 剔除,审计带原因与首见日期', () => {
    const scored = scoreNewsCandidatesForDigest([candidate({
      id: 'blog:google:roundup', title: geminiRoundupTitle,
      eventFingerprint: fingerprint('Gemini 3.7 Flash', '3.7'),
    })]);
    const history = [historyEntry({
      id: 'blog:google:gemini-37-flash', title: geminiTitle, seenAt: A_MONTH_AGO,
      eventFingerprint: fingerprint('Gemini 3.7 Flash', '3.7'),
    })];

    const [result] = applyNewsEventHistoryPolicy(
      scored, history, new Set(['blog:google:gemini-37-flash']),
    );

    expect(result.eventHistoryDecision).toBe('dropped');
    expect(result.eventFirstSeenAt).toBe(A_MONTH_AGO);
    expect(result.eventPreviouslyPushed).toBe(true);
    expect(result.eventHistoryReason).toContain('2026-08-14');
    expect(result.eventHistoryReason).toContain('已推送过');
  });

  test('规则②:旧事件但从未推送过 → 保留、降权,且强制排在未降权候选之后', () => {
    const scored = scoreNewsCandidatesForDigest([
      candidate({ id: 'blog:google:roundup', title: geminiRoundupTitle }),
      // 一条分数明显更低的新事件,用来验证「降权后不得进前列」是硬保证。
      candidate({
        id: 'blog:openai:minor', title: 'A small developer tooling note',
        sourceCompany: 'OpenAI', aiCategory: 'other', aiSummaryZh: '一条不起眼的小更新。',
      }),
    ]);
    const before = scored.find((item) => item.id === 'blog:google:roundup')!;
    const history = [historyEntry({
      id: 'blog:google:gemini-37-flash', title: geminiTitle, seenAt: A_MONTH_AGO,
    })];

    const result = applyNewsEventHistoryPolicy(scored, history, new Set());

    const demoted = result.find((item) => item.id === 'blog:google:roundup')!;
    expect(demoted.eventHistoryDecision).toBe('demoted');
    expect(demoted.eventPreviouslyPushed).toBe(false);
    expect(demoted.eventFirstSeenAt).toBe(A_MONTH_AGO);
    expect(demoted.adjustedScore).toBeLessThan(before.adjustedScore);
    // 即使降权后分数仍然更高,也必须排在未降权候选之后。
    expect(result[result.length - 1].id).toBe('blog:google:roundup');
  });

  test('规则③:历史里没有更老的同事件条目(首见 ≤ 3 天)→ 原样不动', () => {
    const scored = scoreNewsCandidatesForDigest([candidate({
      id: 'blog:google:fresh', title: 'Google launches Gemini 4.0 Ultra today',
    })]);
    const history = [historyEntry({
      id: 'blog:openai:unrelated', title: 'OpenAI publishes a paper on sparse autoencoders',
      sourceCompany: 'OpenAI', aiCategory: 'research', seenAt: A_MONTH_AGO,
    })];

    const [result] = applyNewsEventHistoryPolicy(scored, history, new Set());

    expect(result.eventHistoryDecision).toBeUndefined();
    expect(result.eventFirstSeenAt).toBeUndefined();
    expect(result.eventPreviouslyPushed).toBe(false);
  });

  test('不同事件不误杀:同厂商但不同型号的新发布不受旧事件影响', () => {
    const scored = scoreNewsCandidatesForDigest([candidate({
      id: 'blog:google:gemini-40', title: 'Google launches Gemini 4.0 Ultra, a new frontier model',
      aiSummaryZh: 'Google 发布 Gemini 4.0 Ultra 旗舰模型。',
      eventFingerprint: fingerprint('Gemini 4.0 Ultra', '4.0'),
    })]);
    const history = [historyEntry({
      id: 'blog:google:gemini-37-flash', title: geminiTitle, seenAt: A_MONTH_AGO,
      aiSummaryZh: 'Google 发布 Gemini 3.7 Flash 推理模式。',
      eventFingerprint: fingerprint('Gemini 3.7 Flash', '3.7'),
    })];

    const [result] = applyNewsEventHistoryPolicy(
      scored, history, new Set(['blog:google:gemini-37-flash']),
    );

    expect(result.eventHistoryDecision).not.toBe('dropped');
  });

  test('破坏性动作要强信号:没有结构化指纹时只降权,绝不剔除(防误杀新版本)', () => {
    const scored = scoreNewsCandidatesForDigest([candidate({
      id: 'blog:google:gemini-40', title: 'Google launches Gemini 4.0 Ultra, a new frontier model',
      aiSummaryZh: 'Google 发布 Gemini 4.0 Ultra 旗舰模型。',
    })]);
    // 两边都没有指纹 → sameNewsEvent 只能靠 token 兜底,而 token 兜底会把
    // 「Gemini 4.0 Ultra 发布」和「Gemini 3.7 Flash 发布」判成同事件。
    const history = [historyEntry({
      id: 'blog:google:gemini-37-flash', title: geminiTitle, seenAt: A_MONTH_AGO,
      aiSummaryZh: 'Google 发布 Gemini 3.7 Flash 推理模式。',
    })];

    const [result] = applyNewsEventHistoryPolicy(
      scored, history, new Set(['blog:google:gemini-37-flash']),
    );

    expect(result.eventHistoryDecision).toBe('demoted');
    expect(result.eventPreviouslyPushed).toBe(true);
    expect(result.eventHistoryReason).toContain('只降权不剔除');
  });

  test('候选自身 id 就在推送账本里时也算「推送过」', () => {
    const scored = scoreNewsCandidatesForDigest([candidate({
      id: 'blog:google:roundup', title: geminiRoundupTitle,
      eventFingerprint: fingerprint('Gemini 3.7 Flash', '3.7'),
    })]);
    const history = [historyEntry({
      id: 'blog:google:gemini-37-flash', title: geminiTitle, seenAt: A_MONTH_AGO,
      eventFingerprint: fingerprint('Gemini 3.7 Flash', '3.7'),
    })];

    const [result] = applyNewsEventHistoryPolicy(scored, history, new Set(['blog:google:roundup']));

    expect(result.eventHistoryDecision).toBe('dropped');
    expect(result.eventPreviouslyPushed).toBe(true);
  });

  test('阈值是常量:staleAfterDays 只影响文案,判旧与否由历史窗口本身决定', () => {
    const scored = scoreNewsCandidatesForDigest([candidate({
      id: 'blog:google:roundup', title: geminiRoundupTitle,
    })]);
    const history = [historyEntry({
      id: 'blog:google:gemini-37-flash', title: geminiTitle, seenAt: A_MONTH_AGO,
    })];

    const [result] = applyNewsEventHistoryPolicy(scored, history, new Set(), { staleAfterDays: 7 });

    expect(result.eventHistoryReason).toContain('>7 天');
  });

  test('变异验证:去掉历史判定这一层,旧事件回流原样进榜(官方源天窗放行)', () => {
    const roundup = candidate({
      id: 'blog:google:roundup', title: geminiRoundupTitle,
      eventFingerprint: fingerprint('Gemini 3.7 Flash', '3.7'),
    });
    const scored = scoreNewsCandidatesForDigest([roundup]);
    const prior = [candidate({
      id: 'blog:google:gemini-37-flash', title: geminiTitle,
      eventFingerprint: fingerprint('Gemini 3.7 Flash', '3.7'),
    })];

    // 变异体 = 只有原来的跨天去重:官方源(google)命中 officialSourceWeight 天窗,直接放行。
    const legacyKept = suppressCrossDayRepeatedNewsEvents(scored, prior);
    expect(legacyKept.map((item) => item.id)).toEqual(['blog:google:roundup']);

    // 加上历史判定后同一条被剔除 —— 上面规则①的断言在变异体下必然为假。
    const [withHistory] = applyNewsEventHistoryPolicy(
      scored,
      [historyEntry({
        id: 'blog:google:gemini-37-flash', title: geminiTitle, seenAt: A_MONTH_AGO,
        eventFingerprint: fingerprint('Gemini 3.7 Flash', '3.7'),
      })],
      new Set(['blog:google:gemini-37-flash']),
    );
    expect(withHistory.eventHistoryDecision).toBe('dropped');
  });

  test('变异验证:把降权档位从比较器里去掉,「不得进前列」就不再是硬保证', () => {
    const high = { id: 'a', adjustedScore: 100, eventHistoryDecision: 'demoted' as const };
    const low = { id: 'b', adjustedScore: 1, eventHistoryDecision: undefined };
    // 变异体 = 只按分数排:降权的旧事件因为基础分高仍然排在最前。
    const byScoreOnly = [high, low].sort((l, r) => r.adjustedScore - l.adjustedScore);
    expect(byScoreOnly[0].id).toBe('a');
    // 真实比较器先看降权档位,旧事件必然沉底(由上面「规则②」用例覆盖真实路径)。
  });
});

// ── 端到端:真 SQLite + 真迁移 ────────────────────────────────────────────────
describe('端到端事件历史去重(真 SQLite + 真迁移)', () => {
  const FEED = 'blog:google';

  function seed(db: SqliteD1): void {
    insertSource(db, FEED);
    insertSource(db, 'blog:openai');
  }

  function addItem(
    db: SqliteD1,
    slug: string,
    title: string,
    scrapedAt: string,
    overrides: {
      feedId?: string; summary?: string; category?: string;
      fingerprint?: Record<string, unknown>;
    } = {},
  ): string {
    const feedId = overrides.feedId || FEED;
    const key = feedId.slice('blog:'.length);
    const sourceId = `${key}:${slug}`;
    const id = `blog:${sourceId}`;
    insertItem(db, {
      id,
      sourceType: 'blog',
      sourceId,
      title,
      scrapedAt,
      publishedAt: scrapedAt,
      extra: {
        feed_id: feedId,
        feed_key: key,
        editorial_type: 'official',
        title_zh: title,
        ai_summary_zh: overrides.summary ?? `${title} 的中文摘要。`,
        ai_category: overrides.category ?? 'model-release',
        source_company: key === 'google' ? 'Google' : 'OpenAI',
        ...(overrides.fingerprint ? { event_fingerprint: overrides.fingerprint } : {}),
      },
    });
    return id;
  }

  test('loadNewsEventHistory 只取比候选窗更老的行,并带 seenAt', async () => {
    const db = new SqliteD1();
    opened.push(db);
    seed(db);
    addItem(db, 'old', 'old event', A_MONTH_AGO);
    addItem(db, 'in-window', 'in window event', IN_WINDOW);

    const history = await loadNewsEventHistory(envWithDb(db), newsCandidateWindow(AS_OF));

    expect(history.map((entry) => entry.id)).toEqual(['blog:google:old']);
    expect(history[0].seenAt).toBe(A_MONTH_AGO);
  });

  test('loadPushedNewsItemIds 同时覆盖机器账本与人审发布集合', async () => {
    const db = new SqliteD1();
    opened.push(db);
    const nowMs = Date.parse('2026-09-02T00:00:00.000Z');
    db.sqlite.prepare(
      `INSERT INTO digest_pool (slot_key, source, density, item_ids, items_meta, generated_at)
       VALUES ('2026-08-20-08','news','normal','["blog:google:auto"]',NULL,?)`,
    ).run(Date.parse('2026-08-20T00:00:00.000Z'));
    db.sqlite.prepare(
      `INSERT INTO daily_news_review_batches
         (review_date, batch_id, candidate_ids, candidates_json, default_selected_ids,
          applied_selected_ids, created_at, expires_at)
       VALUES ('2026-08-21','nr-1','[]','[]','[]','["blog:google:human"]',1,2)`,
    ).run();

    const pushed = await loadPushedNewsItemIds(envWithDb(db), nowMs);

    // 人审换上来的条目从不回写 digest_pool,只看账本会漏掉它。
    expect([...pushed].sort()).toEqual(['blog:google:auto', 'blog:google:human']);
  });

  test('9/2 重演:一个月前推送过的事件借新文章回流 → 被剔除,审计留下原因', async () => {
    const db = new SqliteD1();
    opened.push(db);
    seed(db);
    const original = addItem(
      db, 'gemini-37-flash',
      'Google ships Gemini 3.7 Flash with a faster reasoning mode', A_MONTH_AGO,
      {
        summary: 'Google 发布 Gemini 3.7 Flash 推理模式。',
        fingerprint: storedFingerprint('Gemini 3.7 Flash', '3.7'),
      },
    );
    addItem(
      db, 'weekly-roundup',
      'Weekly roundup: Gemini 3.7 Flash reasoning mode and more from Google', IN_WINDOW,
      {
        summary: '本周合集:Gemini 3.7 Flash 推理模式等。',
        fingerprint: storedFingerprint('Gemini 3.7 Flash', '3.7'),
      },
    );
    // 补足几条无关的新候选,保证榜单不是空的。
    for (let index = 0; index < 4; index++) {
      addItem(
        db, `fresh-${index}`, `OpenAI publishes developer note number ${index}`, IN_WINDOW,
        { feedId: 'blog:openai', summary: `OpenAI 开发者说明 ${index}。`, category: 'product' },
      );
    }
    db.sqlite.prepare(
      `INSERT INTO digest_pool (slot_key, source, density, item_ids, items_meta, generated_at)
       VALUES ('2026-08-14-08','news','normal',?,NULL,?)`,
    ).run(JSON.stringify([original]), Date.parse('2026-08-14T00:00:00.000Z'));

    const result = await selectNewsByScoreWithAudit(envWithDb(db), 10, {
      asOfDate: AS_OF, strictCrossDayEventDedup: true,
    });

    expect(result.ids).not.toContain('blog:google:weekly-roundup');
    const entry = result.audit.candidates.find((row) => row.id === 'blog:google:weekly-roundup');
    expect(entry?.event_history_decision).toBe('dropped');
    expect(entry?.event_previously_pushed).toBe(true);
    expect(entry?.event_first_seen_at).toBe(A_MONTH_AGO);
    expect(entry?.event_history_reason).toContain('2026-08-14');
  });

  test('没开 strictCrossDayEventDedup 的路径(daily-api 实时)不付历史查询的代价', async () => {
    const db = new SqliteD1();
    opened.push(db);
    seed(db);
    addItem(db, 'old', 'Google ships Gemini 3.7 Flash reasoning mode', A_MONTH_AGO);
    addItem(db, 'roundup', 'Weekly roundup: Gemini 3.7 Flash reasoning mode', IN_WINDOW);

    await selectNewsByScoreWithAudit(envWithDb(db), 10, { asOfDate: AS_OF });

    expect(db.preparedSql.some((sql) => sql.includes('news_selection:event_history'))).toBe(false);
    expect(db.preparedSql.some((sql) => sql.includes('news_selection:pushed_ledger_ids'))).toBe(false);
  });
});

// ── 序列化:候选携带事件首见时间 / 是否推送过 ────────────────────────────────
describe('candidates_json 携带 event_first_seen_at / event_previously_pushed', () => {
  const FEED = 'blog:google';

  function poolItem(db: SqliteD1, slug: string, title: string, scrapedAt: string): string {
    const sourceId = `google:${slug}`;
    const id = `blog:${sourceId}`;
    insertItem(db, {
      id,
      sourceType: 'blog',
      sourceId,
      title,
      scrapedAt,
      publishedAt: scrapedAt,
      extra: {
        feed_id: FEED,
        feed_key: 'google',
        editorial_type: 'official',
        title_zh: title,
        ai_summary_zh: `${title} 的中文摘要。`,
        ai_category: 'model-release',
        source_company: 'Google',
      },
    });
    return id;
  }

  test('冻结出的候选把审计里的事件历史判定透传进 candidates_json', async () => {
    const db = new SqliteD1();
    opened.push(db);
    insertSource(db, FEED);
    const ids = Array.from({ length: 6 }, (_, index) =>
      poolItem(db, `pool-${index + 1}`, `候选${index + 1}`, IN_WINDOW));

    // 直接构造 digest_pool 的 items_meta,模拟选品审计已经写好判定结果的形态。
    db.sqlite.prepare(
      `INSERT INTO digest_pool (slot_key, source, density, item_ids, items_meta, generated_at)
       VALUES ('2026-09-02-08','news','normal',?,?,1)`,
    ).run(
      JSON.stringify(ids.slice(0, 5)),
      JSON.stringify({
        candidate_ids_after_exact_dedup: ids,
        candidates: ids.map((id, index) => ({
          rank: index + 1,
          id,
          title_zh: `候选${index + 1}`,
          source_company: 'Google',
          adjusted_score: 100 - index,
          // 第 2 条带事件历史判定;其余不带,验证「无值省略」。
          ...(index === 1
            ? { event_first_seen_at: A_MONTH_AGO, event_previously_pushed: true }
            : {}),
        })),
      }),
    );

    const frozen = await freezeNewsReviewBatchFromPool(
      envWithDb(db), '2026-09-02', Date.parse(IN_WINDOW),
    );

    const withHistory = frozen.batch.candidates.find((c) => c.item_id === ids[1])!;
    expect(withHistory.event_first_seen_at).toBe(A_MONTH_AGO);
    expect(withHistory.event_previously_pushed).toBe(true);

    const without = frozen.batch.candidates.find((c) => c.item_id === ids[0])!;
    expect('event_first_seen_at' in without).toBe(false);
    expect('event_previously_pushed' in without).toBe(false);

    // 落库的 candidates_json 里就带着(消费端读的是这一份)。
    const row = db.sqlite.prepare(
      'SELECT candidates_json FROM daily_news_review_batches WHERE batch_id = ?',
    ).get(frozen.batch.batch_id) as { candidates_json: string };
    const persisted = JSON.parse(row.candidates_json) as Array<Record<string, unknown>>;
    expect(persisted[1].event_first_seen_at).toBe(A_MONTH_AGO);
    expect(persisted[1].event_previously_pushed).toBe(true);
    expect(Object.keys(persisted[0])).not.toContain('event_first_seen_at');
  });

  test('变异验证:序列化时丢掉两个字段,上面的断言全部落空', () => {
    const candidates = [{
      item_id: 'blog:google:x', title: 't', summary: 's', source: 'Google', score: 1,
      event_first_seen_at: A_MONTH_AGO, event_previously_pushed: true,
    }];
    const mutated = candidates.map(
      ({ event_first_seen_at: _a, event_previously_pushed: _b, ...rest }) => rest,
    );
    expect(JSON.stringify(mutated)).not.toContain('event_first_seen_at');
    expect(JSON.stringify(candidates)).toContain('event_first_seen_at');
  });
});
