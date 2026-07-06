// 订阅 digest 选品:每源按各自真实排序取过去 24h top N 的 item id。
// 时间窗口用 scraped_at(入库时间)而非 published_at —— GitHub/HF 的 published_at 是内容
// 发布日(老),scraped_at 才是"最近系统收录"。scraped_at 格式跨源不一(x_list 空格 /
// 其余 ISO with T/Z),统一用 datetime(scraped_at) 归一化比较。
// 排序复用各源 feed handler 同款信号:
//   X(x_list) — HOT_EXPR(engagement / age decay by published_at),is_relevant=1
//   GH        — metrics.today_stars DESC(当日新增 star)
//   PH        — launch_date_pt DESC, daily_rank ASC(当日榜),is_relevant=1
//   HF        — metrics.upvotes DESC
//   ClawHub   — 24h star 增量(metrics_snapshots_clawhub delta,防累积 top 永远不变)
// 设计文档:roxor-main-design-20260528-090625.md

import type { Env } from '../index';
import { scoreFeedNewsItemForOrdering } from '../feeds/ranking';
import type { DigestSource } from './config';

// config 源 key → items.source_type(注意 X 历史命名为 x_list)
export const SOURCE_TYPE: Record<DigestSource, string> = {
  'news': 'blog', // 占位满足类型:news 是 blog+podcast 合并虚拟源,实际走 selectNewsByScore,不用此单值映射
  'ph': 'product_hunt',
  'gh': 'github',
  'hf-paper': 'hf_paper',
  'clawhub': 'clawhub',
  'x': 'x_list',
};

const HOT_EXPR = `((COALESCE(CAST(json_extract(metrics,'$.likes') AS INTEGER),0)
   + 2*COALESCE(CAST(json_extract(metrics,'$.retweets') AS INTEGER),0)
   + 3*COALESCE(CAST(json_extract(metrics,'$.replies') AS INTEGER),0))
  * 1.0 / POW((julianday('now')-julianday(published_at))*24+2, 1.5))`;

// 跨天去重(2026-06-24):排除「今天之前」已进过 digest_pool(= node-run 已推送过)的 item,
// 确保每天推送不含前几天推过的同一条(如 6/23 推过的「MiniMax 语音 2.8」6/24 不再重复)。
// 账本 = digest_pool(node-run 每档每源写入的榜单 item_ids,JSON 数组)。只需回看选品窗:
//   各源 scraped_at 窗最长 3 天(news/hf),故回看 DEDUP_LOOKBACK_DAYS=5 足够覆盖可被重选的范围。
// 严格 < 今日 BJT 0 点 → 只去「跨天」重复,不让同日 8/12/17 三档互相去重(各档用户不重叠)。
// 仅用于「同一受众反复收」的推送场景:订阅邮件 + Codex API(都读 node-run 建的 pool)。
// daily-api 不用本函数,改用下方 excludeStalePushes(宽松:容忍近期重复、只滤陈旧)。
const DEDUP_LOOKBACK_DAYS = 5;
export interface SelectTopOptions {
  // node-run / 邮件 / Codex 快照使用:过滤前几天已经推过的同事件媒体重复。
  // daily-api 实时模式不启用,它只做日内事件折叠 + 自己的宽松 stale 去重。
  strictCrossDayEventDedup?: boolean;
  // 历史回填日期锚点(YYYY-MM-DD)。缺省=不锚定,行为与改动前逐字节一致(8 点当日路径 + 邮件路径零影响);
  // 传入时把候选时间窗锚到该日(上界=该日次日 0 点,下界=上界回退该源 windowDays 天),
  // 避免回填历史日期时所有页都选出"当下"的 top N。仅日报静态页回填(daily-page-run)使用。
  asOfDate?: string;
}

export async function excludeAlreadyPushed(
  env: Env,
  ids: string[],
  source: DigestSource,
): Promise<string[]> {
  if (ids.length === 0) return ids;
  const now = Date.now();
  // 今日 BJT(UTC+8)0 点对应的 epoch ms
  const startOfTodayBjtMs =
    Math.floor((now + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  const lookbackFromMs = startOfTodayBjtMs - DEDUP_LOOKBACK_DAYS * 86400_000;
  const rows = await env.DB.prepare(
    `SELECT DISTINCT je.value AS id
       FROM digest_pool dp, json_each(COALESCE(dp.item_ids,'[]')) je
      WHERE dp.source = ?
        AND dp.generated_at >= ?
        AND dp.generated_at < ?`,
  )
    .bind(source, lookbackFromMs, startOfTodayBjtMs)
    .all<{ id: string }>();
  const pushed = new Set((rows.results || []).map((r) => r.id));
  if (pushed.size === 0) return ids;
  return ids.filter((id) => !pushed.has(id));
}

// daily-api 专用「宽松」跨周期去重(2026-06-24):允许与最近 KEEP_RECENT_SLOTS 次推送
// (8/12/17 各算一次)重复 —— 无状态拉取方可能要近期热点;但第 (N+1) 次及更早的旧内容滤掉,
// 避免陈旧重复。判定:一条 item 只有当它「最近一次被推的档次」早于「倒数第 N 档」时才剔除
// (= 只存在于更老的推送、不在最近 N 档里);只要它落在最近 N 档任意一档就保留(允许重复)。
// ⚠️ 推送档次必须用 slot_key 计数,不能用 generated_at:一次 node-run 给同源写 normal+curated
// 两行,generated_at 差几秒,会把一次推送数成两档。slot_key(=YYYY-MM-DD-HH,零填充可字典序排)
// 一次 run 所有行共享 → DISTINCT slot_key 才是真实推送档次。与 excludeAlreadyPushed(邮件/Codex
// 严格按「跨天」)分开;daily-api 自身不写账本。
const KEEP_RECENT_SLOTS = 3;
export async function excludeStalePushes(
  env: Env,
  ids: string[],
  source: DigestSource,
  keepRecentN: number = KEEP_RECENT_SLOTS,
): Promise<string[]> {
  if (ids.length === 0) return ids;
  const lookbackFromMs = Date.now() - 7 * 86400_000; // 选品窗最长 3 天,7 天足够覆盖最近若干推送档
  // 最近 keepRecentN 个「推送档次」= DISTINCT slot_key 字典序倒排(slot_key 零填充,字典序=时序)
  const slotRows = await env.DB.prepare(
    `SELECT DISTINCT slot_key FROM digest_pool
      WHERE source = ? AND generated_at >= ?
      ORDER BY slot_key DESC LIMIT ?`,
  )
    .bind(source, lookbackFromMs, keepRecentN)
    .all<{ slot_key: string }>();
  const slots = (slotRows.results || []).map((r) => r.slot_key);
  if (slots.length < keepRecentN) return ids; // 推送档次不足 N → 全算「近期」,不滤
  const minRecentSlot = slots[slots.length - 1]; // 倒数第 N 档的 slot_key(最近 N 档里最早的)
  // 「陈旧」item = 其最近一次被推的档次(MAX slot_key)< 倒数第 N 档 → 只在更老的推送里出现过;
  // 若它也落在最近 N 档(MAX slot_key >= minRecentSlot)则不算陈旧 → 保留(允许与近期重复)。
  const staleRows = await env.DB.prepare(
    `SELECT je.value AS id, MAX(dp.slot_key) AS latest_slot
       FROM digest_pool dp, json_each(COALESCE(dp.item_ids,'[]')) je
      WHERE dp.source = ? AND dp.generated_at >= ?
      GROUP BY je.value
     HAVING latest_slot < ?`,
  )
    .bind(source, lookbackFromMs, minRecentSlot)
    .all<{ id: string }>();
  const stale = new Set((staleRows.results || []).map((r) => r.id));
  if (stale.size === 0) return ids;
  return ids.filter((id) => !stale.has(id));
}

// 取某源过去 24h 的 top `limit` item id(按该源真实热度排序)。
// 同时供 normal 榜(limit=config.normal)与 curated 候选池(limit=30)使用。
export async function selectTopForSource(
  env: Env,
  source: DigestSource,
  limit: number,
  options: SelectTopOptions = {},
): Promise<string[]> {
  if (source === 'clawhub') return selectClawhubByDelta(env, limit);
  if (source === 'news') return selectNewsByScore(env, limit, options);

  const sourceType = SOURCE_TYPE[source];
  const wcGate =
    env.WORKFLOW_COMPLETED_FILTER === 'true'
      ? "AND json_extract(extra,'$.workflow_completed_at') IS NOT NULL"
      : '';

  let orderBy: string;
  let extraWhere = '';
  let windowDays = 1; // hf-paper 放宽到 3 天(避开与 digest 撞车),其余源 24h
  if (source === 'x') {
    orderBy = `${HOT_EXPR} DESC`;
    extraWhere = 'AND is_relevant = 1';
  } else if (source === 'gh') {
    orderBy = `CAST(json_extract(metrics,'$.today_stars') AS INTEGER) DESC`;
    // is_relevant=1 = classify-with-llm 成功且判定 AI 相关(隐含已生成 ai_summary)。
    // 漏掉这道过滤会让非 AI 项目(如 godot 游戏引擎)+ 未分类半成品(is_relevant NULL)
    // 因当日涨星高被选进 digest,渲染时 ai_summary 空 → 邮件里只有 repo 名没简介。对齐 x/ph。
    extraWhere = 'AND is_relevant = 1';
  } else if (source === 'ph') {
    orderBy = `json_extract(extra,'$.launch_date_pt') DESC, CAST(json_extract(extra,'$.daily_rank') AS INTEGER) ASC`;
    extraWhere = 'AND is_relevant = 1';
  } else {
    // hf-paper:放宽窗 3 天 + 只取已 enrich(有中文摘要),按出榜日倒序保证取"最近一期"。
    // 原因:hf 抓取(UTC0)与 digest 早 8 档(UTC0)同刻触发,选品瞬间当天 hf 还没入库/enrich
    // (入库 +1min、中文摘要 +4~5min),24h 窗又卡边界 → 早档常无 hf。3 天窗 + submitted_on_daily
    // DESC 稳定取最近一期已 ready 的;ai_summary_zh 非空过滤排除刚入库没加工完的半成品。
    orderBy = `json_extract(extra,'$.submitted_on_daily_at') DESC, CAST(json_extract(metrics,'$.upvotes') AS INTEGER) DESC`;
    extraWhere = `AND json_extract(extra,'$.ai_summary_zh') IS NOT NULL AND json_extract(extra,'$.ai_summary_zh') != ''`;
    windowDays = 3;
  }

  // 时间窗:默认锚到 now(逐字节保持原样);传 asOfDate 时锚到该日(上界该日次日 0 点,
  // 下界回退 windowDays 天),回填历史页时才不选出"当下"的热点。
  const asOf = options.asOfDate;
  const windowClause = asOf
    ? `datetime(scraped_at) >= datetime(?, '+1 day', '-${windowDays} day')
      AND datetime(scraped_at) < datetime(?, '+1 day')`
    : `datetime(scraped_at) >= datetime('now','-${windowDays} day')`;
  const sql = `SELECT id FROM items
    WHERE source_type = ?
      AND ${windowClause}
      AND deleted_at IS NULL ${extraWhere} ${wcGate}
    ORDER BY ${orderBy}
    LIMIT ?`;
  const rows = asOf
    ? await env.DB.prepare(sql).bind(sourceType, asOf, asOf, limit).all<{ id: string }>()
    : await env.DB.prepare(sql).bind(sourceType, limit).all<{ id: string }>();
  return (rows.results || []).map((r) => r.id);
}

// ClawHub 按 24h star 增量排序(累积 star/install 取 topN 会永远是头部老项目)。
// 用 metrics_snapshots_clawhub:最新快照 stars - 24h 前快照 stars。captured_at 为 unix 秒。
async function selectClawhubByDelta(env: Env, limit: number): Promise<string[]> {
  const sql = `
    WITH latest AS (
      SELECT item_id, stars AS cur FROM metrics_snapshots_clawhub m1
      WHERE captured_at = (
        SELECT MAX(captured_at) FROM metrics_snapshots_clawhub m2 WHERE m2.item_id = m1.item_id
      )
    ),
    prev AS (
      SELECT item_id, stars AS old FROM metrics_snapshots_clawhub m1
      WHERE captured_at = (
        SELECT MAX(captured_at) FROM metrics_snapshots_clawhub m2
        WHERE m2.item_id = m1.item_id AND m2.captured_at <= unixepoch() - 86400
      )
    )
    SELECT i.id FROM items i
    JOIN latest l ON l.item_id = i.id
    LEFT JOIN prev p ON p.item_id = i.id
    WHERE i.source_type = 'clawhub' AND i.deleted_at IS NULL
    ORDER BY (l.cur - COALESCE(p.old, l.cur)) DESC
    LIMIT ?`;
  const rows = await env.DB.prepare(sql).bind(limit).all<{ id: string }>();
  return (rows.results || []).map((r) => r.id);
}

// 行业新闻(blog+podcast 合并)按「事件级综合分」排序(无 LLM 默认路径)。
// 基础分复用 C 端新闻流 feed ranking:相关度 + 新鲜度 + 源质量 + 影响力 + 内容完整度 + 行业人名标题加权。
// 事件增强:同一事件若被多家独立信源报道,按独立 source_company 数加分(2 源 +8,3 源 +14,4+ 源 +18)。
// 设计动机:OpenAI 自研芯片这类「官方 + 多家媒体」共同报道的基础设施大事,不应被拆成单条 item 后
// 在同源分散排序里被埋掉。支持行允许 ai_summary_zh 为空(如第三方媒体刚入库未摘要),但最终可选主 item
// 仍必须有 ai_summary_zh,保证 digest 可渲染。
async function selectNewsByScore(env: Env, limit: number, options: SelectTopOptions = {}): Promise<string[]> {
  const cat = `json_extract(extra,'$.ai_category')`;
  const co = `json_extract(extra,'$.source_company')`;
  const tzh = `json_extract(extra,'$.title_zh')`;
  // 时间窗:默认锚 now(逐字节保持原样);传 asOfDate 时锚到该日(上界该日次日 0 点,下界回退 3 天)。
  const asOf = options.asOfDate;
  const windowClause = asOf
    ? `datetime(scraped_at) >= datetime(?, '+1 day', '-3 day')
      AND datetime(scraped_at) < datetime(?, '+1 day')`
    : `datetime(scraped_at) >= datetime('now','-3 day')`;
  const sql = `
    SELECT id, title, source_type, content, content_translated, extra, published_at
    FROM items
    WHERE source_type IN ('blog','podcast')
      AND is_relevant = 1
      AND ${windowClause}
      AND deleted_at IS NULL
      -- 噪音过滤①:slow-news / "没什么大事" 填充帖(如 smol.ai 的 "[AINews] not much
      -- happened today")。措辞很特定,按原标题英文匹配(对中文重写鲁棒),几乎不误伤真新闻。
      AND lower(COALESCE(title,'')) NOT LIKE '%not much happened%'
      AND lower(COALESCE(title,'')) NOT LIKE '%nothing happened%'
      AND lower(COALESCE(title,'')) NOT LIKE '%slow news%'
      AND COALESCE(${tzh},'') NOT LIKE '%没什么大事%'
      -- 噪音过滤②:纯活动门票/促销广告(如 "[Exclusive] $250 off AI Engineer tix")。
      -- 限定在 ai_category='other' 内匹配,保护被正确分类(model-release/product/...)的真新闻。
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
      )`;
  const rows = asOf
    ? await env.DB.prepare(sql).bind(asOf, asOf).all<NewsCandidateDbRow>()
    : await env.DB.prepare(sql).all<NewsCandidateDbRow>();
  const candidates = (rows.results || []).map(newsCandidateFromDbRow);
  const scored = scoreNewsCandidatesForDigest(candidates);
  const eventDeduped = options.strictCrossDayEventDedup
    ? suppressCrossDayRepeatedNewsEvents(scored, await fetchPreviousPushedNewsCandidates(env))
    : scored;
  return foldNewsEventsForDigest(eventDeduped).slice(0, limit).map((r) => r.id);
}

interface NewsCandidateDbRow {
  id: string;
  title: string | null;
  source_type: string;
  content: string | null;
  content_translated: string | null;
  extra: string | null;
  published_at: string | null;
}

export interface NewsCandidateForScoring {
  id: string;
  title: string;
  titleZh?: string;
  sourceType: string;
  sourceKey: string;
  sourceCompany: string;
  aiCategory: string;
  publishedAt: string;
  aiSummaryZh: string;
  content: string;
  contentTranslated: string;
  transcriptTier: string;
  selectable: boolean;
  eventFingerprint?: NewsEventFingerprint;
}

export interface ScoredNewsCandidate extends NewsCandidateForScoring {
  baseScore: number;
  adjustedScore: number;
  sourceRank: number;
  eventSourceCount: number;
  relatedSourceCompanies: string[];
}

export interface NewsEventFingerprint {
  eventType?: string;
  primaryActor?: string;
  primaryObject?: string;
  objectFamily?: string;
  objectVariant?: string;
  objectVersion?: string;
  action?: string;
  canonicalEvent?: string;
  confidence?: number;
}

function newsCandidateFromDbRow(row: NewsCandidateDbRow): NewsCandidateForScoring {
  const extra = parseExtra(row.extra);
  const aiSummaryZh = String(extra.ai_summary_zh || '');
  return {
    id: row.id,
    title: String(row.title || ''),
    titleZh: String(extra.title_zh || ''),
    sourceType: row.source_type,
    sourceKey: String(extra.feed_key || extra.show_key || extra.source_ref || extra.source_key || ''),
    sourceCompany: String(extra.source_company || ''),
    aiCategory: String(extra.ai_category || ''),
    publishedAt: String(row.published_at || ''),
    aiSummaryZh,
    content: String(row.content || ''),
    contentTranslated: String(row.content_translated || ''),
    transcriptTier: String(extra.transcript_tier || ''),
    selectable: Boolean(aiSummaryZh.trim()),
    eventFingerprint: normalizeNewsEventFingerprint(extra.event_fingerprint),
  };
}

function parseExtra(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeNewsEventFingerprint(value: unknown): NewsEventFingerprint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  const fp: NewsEventFingerprint = {};
  const setString = (key: keyof NewsEventFingerprint, raw: unknown) => {
    if (typeof raw !== 'string') return;
    const v = raw.trim();
    if (v) (fp[key] as string) = v;
  };
  setString('eventType', obj.event_type ?? obj.eventType);
  setString('primaryActor', obj.primary_actor ?? obj.primaryActor);
  setString('primaryObject', obj.primary_object ?? obj.primaryObject);
  setString('objectFamily', obj.object_family ?? obj.objectFamily);
  setString('objectVariant', obj.object_variant ?? obj.objectVariant);
  setString('objectVersion', obj.object_version ?? obj.objectVersion);
  setString('action', obj.action);
  setString('canonicalEvent', obj.canonical_event ?? obj.canonicalEvent);
  const confidence = Number(obj.confidence);
  if (Number.isFinite(confidence)) fp.confidence = Math.max(0, Math.min(1, confidence));
  return Object.keys(fp).length ? fp : undefined;
}

async function fetchPreviousPushedNewsCandidates(env: Env): Promise<NewsCandidateForScoring[]> {
  const now = Date.now();
  const startOfTodayBjtMs =
    Math.floor((now + 8 * 3600_000) / 86400_000) * 86400_000 - 8 * 3600_000;
  const lookbackFromMs = startOfTodayBjtMs - DEDUP_LOOKBACK_DAYS * 86400_000;
  const pushedRows = await env.DB.prepare(
    `SELECT DISTINCT je.value AS id
       FROM digest_pool dp, json_each(COALESCE(dp.item_ids,'[]')) je
      WHERE dp.source = 'news'
        AND dp.generated_at >= ?
        AND dp.generated_at < ?`,
  )
    .bind(lookbackFromMs, startOfTodayBjtMs)
    .all<{ id: string }>();
  const pushed = (pushedRows.results || []) as Array<{ id?: unknown }>;
  const ids: string[] = [
    ...new Set(pushed
      .map((r) => r.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0)),
  ];
  return fetchNewsCandidatesByIds(env, ids);
}

async function fetchNewsCandidatesByIds(env: Env, ids: string[]): Promise<NewsCandidateForScoring[]> {
  if (!ids.length) return [];
  const uniqueIds = [...new Set(ids)].slice(0, 300);
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT id, title, source_type, content, content_translated, extra, published_at
       FROM items
      WHERE id IN (${placeholders})
        AND source_type IN ('blog','podcast')
        AND deleted_at IS NULL`,
  ).bind(...uniqueIds).all<NewsCandidateDbRow>();
  return (rows.results || []).map(newsCandidateFromDbRow);
}

export function scoreNewsCandidatesForDigest(
  candidates: NewsCandidateForScoring[],
  nowMs: number = Date.now(),
): ScoredNewsCandidate[] {
  const withBase = candidates.map((item) => ({
    item,
    baseScore: newsBaseScore(item, nowMs),
    tokens: eventTokens(item),
  }));
  const sourceRanks = new Map<string, Map<string, number>>();
  const selectableBySource = new Map<string, Array<{ id: string; baseScore: number; publishedAt: string }>>();
  for (const entry of withBase) {
    if (!entry.item.selectable) continue;
    const source = entry.item.sourceCompany || '';
    const list = selectableBySource.get(source) || [];
    list.push({ id: entry.item.id, baseScore: entry.baseScore, publishedAt: entry.item.publishedAt });
    selectableBySource.set(source, list);
  }
  for (const [source, list] of selectableBySource) {
    const sorted = list.sort((a, b) => b.baseScore - a.baseScore || parseDateMs(b.publishedAt) - parseDateMs(a.publishedAt));
    const ranks = new Map<string, number>();
    sorted.forEach((item, index) => ranks.set(item.id, index + 1));
    sourceRanks.set(source, ranks);
  }

  const scored: ScoredNewsCandidate[] = [];
  for (const entry of withBase) {
    if (!entry.item.selectable) continue;
    const relatedSources = new Set<string>();
    for (const other of withBase) {
      if (!other.item.sourceCompany) continue;
      if (sameNewsEvent(entry.tokens, other.tokens)) relatedSources.add(other.item.sourceCompany);
    }
    const sourceRank = sourceRanks.get(entry.item.sourceCompany || '')?.get(entry.item.id) || 1;
    const eventSourceCount = relatedSources.size;
    const multisourceBonus = eventSourceCount >= 4 ? 18 : eventSourceCount === 3 ? 14 : eventSourceCount === 2 ? 8 : 0;
    const sourceRepeatPenalty = Math.max(0, sourceRank - 1) * 8;
    scored.push({
      ...entry.item,
      baseScore: entry.baseScore,
      adjustedScore: entry.baseScore + multisourceBonus - sourceRepeatPenalty,
      sourceRank,
      eventSourceCount,
      relatedSourceCompanies: [...relatedSources].sort(),
    });
  }
  return scored.sort((a, b) =>
    b.adjustedScore - a.adjustedScore
    || a.sourceRank - b.sourceRank
    || parseDateMs(b.publishedAt) - parseDateMs(a.publishedAt)
    || a.id.localeCompare(b.id),
  );
}

export function foldNewsEventsForDigest(scored: ScoredNewsCandidate[]): ScoredNewsCandidate[] {
  const groups: Array<{ representative: ScoredNewsCandidate; profiles: TokenProfile[] }> = [];
  for (const item of scored) {
    const profile = eventTokens(item);
    const group = groups.find((g) => g.profiles.some((p) => sameNewsEvent(profile, p)));
    if (!group) {
      groups.push({ representative: item, profiles: [profile] });
      continue;
    }
    group.profiles.push(profile);
    if (isBetterNewsEventRepresentative(item, group.representative)) {
      group.representative = item;
    }
  }
  return groups.map((g) => g.representative).sort(compareScoredNewsCandidate);
}

export function suppressCrossDayRepeatedNewsEvents<T extends NewsCandidateForScoring>(
  candidates: T[],
  previousPushed: NewsCandidateForScoring[],
): T[] {
  if (!candidates.length || !previousPushed.length) return candidates;
  const previousIds = new Set(previousPushed.map((item) => item.id));
  const previousProfiles = previousPushed.map((item) => eventTokens(item));
  return candidates.filter((item) => {
    if (previousIds.has(item.id)) return false;
    // 官方源是更权威的后续代表:昨天媒体报过、今天官方源入库时仍允许替换成官方口径。
    if (officialSourceWeight(item) > 0) return true;
    const profile = eventTokens(item);
    return !previousProfiles.some((previous) => sameNewsEvent(profile, previous));
  });
}

function compareScoredNewsCandidate(a: ScoredNewsCandidate, b: ScoredNewsCandidate): number {
  return b.adjustedScore - a.adjustedScore
    || a.sourceRank - b.sourceRank
    || parseDateMs(b.publishedAt) - parseDateMs(a.publishedAt)
    || a.id.localeCompare(b.id);
}

function isBetterNewsEventRepresentative(candidate: ScoredNewsCandidate, current: ScoredNewsCandidate): boolean {
  const officialDiff = officialSourceWeight(candidate) - officialSourceWeight(current);
  if (officialDiff !== 0) return officialDiff > 0;
  if (candidate.adjustedScore !== current.adjustedScore) return candidate.adjustedScore > current.adjustedScore;
  if (candidate.sourceRank !== current.sourceRank) return candidate.sourceRank < current.sourceRank;
  const candidatePublishedAt = parseDateMs(candidate.publishedAt);
  const currentPublishedAt = parseDateMs(current.publishedAt);
  if (candidatePublishedAt !== currentPublishedAt) return candidatePublishedAt > currentPublishedAt;
  return candidate.id.localeCompare(current.id) < 0;
}

function officialSourceWeight(item: NewsCandidateForScoring): number {
  const sourceCompany = normalizeSourceName(item.sourceCompany);
  const sourceKey = normalizeSourceName(item.sourceKey);
  if (officialSourceNames.has(sourceCompany) || officialSourceNames.has(sourceKey)) return 2;
  return 0;
}

function normalizeSourceName(value: string): string {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function newsBaseScore(item: NewsCandidateForScoring, nowMs: number): number {
  const ranked = scoreFeedNewsItemForOrdering({
    id: item.id,
    title: item.title,
    sourceType: item.sourceType,
    sourceKey: item.sourceKey,
    sourceCompany: item.sourceCompany,
    aiCategory: item.aiCategory,
    publishedAt: item.publishedAt,
    hasSummary: Boolean(item.aiSummaryZh.trim()),
    hasBody: Boolean(item.content.trim() || item.contentTranslated.trim() || item.transcriptTier),
  }, nowMs);
  return ranked.total + digestPolicyAccessBonus(item) - titlebaitPenalty(item.title);
}

function digestPolicyAccessBonus(item: NewsCandidateForScoring): number {
  const fp = item.eventFingerprint;
  const eventType = normalizeEventType(fp?.eventType || '');
  const text = normalizeEventText([
    item.title,
    item.titleZh || '',
    item.aiSummaryZh,
    item.aiCategory,
    fp?.eventType || '',
    fp?.primaryActor || '',
    fp?.primaryObject || '',
    fp?.objectFamily || '',
    fp?.objectVariant || '',
    fp?.objectVersion || '',
    fp?.action || '',
    fp?.canonicalEvent || '',
  ].join(' '));
  const isPolicyAccess =
    eventType === 'policy-access'
    || /\bexport\b|\bban\b|\bgreenlit\b|\bapproved\b|\brestriction|\bregulat|\bpolicy\b|出口管制|解禁|恢复访问|重新上线|批准|限制|禁令/.test(text);
  if (!isPolicyAccess) return 0;

  const isFrontierModelAccess =
    /\bfable\b|\bmythos\b|\bclaude\b|\bgpt[-\s]?\d|\bgemini\b|\bdeepseek\b|\bqwen\b|豆包|通义|千问/.test(text);
  const isRestoredAccess =
    /\bredeploy|\brestore|\brestored|\bgreenlit|\blift(?:ed|s)?\b|\bapprove(?:d|s)?\b|\bavailable\b|解除|恢复|解禁|重新上线|批准|可用/.test(text);

  let bonus = 0;
  if (isFrontierModelAccess) bonus += 12;
  if (isRestoredAccess) bonus += 16;
  return Math.min(28, bonus);
}

function titlebaitPenalty(title: string): number {
  const t = String(title || '').toLowerCase();
  let penalty = 0;
  if (/[?？]$/.test(t) || /^(what if|is .* dead|did .* just)/i.test(t)) penalty += 2;
  if (/重磅|震撼|炸裂|最强|超越.+[?？]|诞生了[?？]/.test(t)) penalty += 2;
  return Math.min(4, penalty);
}

function parseDateMs(value: string): number {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

interface TokenProfile {
  tokens: Set<string>;
  orgs: Set<string>;
  topics: Set<string>;
  distinctive: Set<string>;
  fingerprint: DerivedEventFingerprint;
}

function eventTokens(item: NewsCandidateForScoring): TokenProfile {
  const text = normalizeEventText([
    item.title,
    item.titleZh || '',
    item.aiSummaryZh,
    item.aiCategory,
  ].join(' '));
  const tokens = new Set<string>();
  for (const match of text.match(/[a-z0-9][a-z0-9-]{1,}/g) || []) {
    const token = normalizeEventToken(match);
    if (token && !eventStopWords.has(token)) tokens.add(token);
  }
  for (const [pattern, token] of cjkEventTerms) {
    if (pattern.test(text)) tokens.add(token);
  }
  const orgs = new Set([...tokens].filter((token) => orgEventTokens.has(token)));
  const topics = new Set([...tokens].filter((token) => topicEventTokens.has(token)));
  const distinctive = new Set([...tokens].filter((token) => !genericEventTokens.has(token) && !eventStopWords.has(token)));
  return { tokens, orgs, topics, distinctive, fingerprint: deriveEventFingerprint(item, text, tokens) };
}

function normalizeEventText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/gpt-([0-9])/g, 'gpt$1');
}

function normalizeEventToken(value: string): string {
  const token = value.replace(/^-+|-+$/g, '');
  if (!token) return '';
  if (['chips', 'chiplet', 'chiplets', 'processor', 'processors', 'asic', 'asics', 'silicon', 'semiconductor', 'semiconductors'].includes(token)) return 'chip';
  if (['jalapeno', 'jalapenos'].includes(token)) return 'jalapeno';
  if (['models', 'model', 'model-release'].includes(token)) return 'model';
  if (['agents', 'agentic'].includes(token)) return 'agent';
  if (['benchmarks', 'benchmark'].includes(token)) return 'benchmark';
  return token;
}

interface DerivedEventFingerprint {
  eventType: string;
  modelFamilies: Set<string>;
  objectTokens: Set<string>;
  actionTokens: Set<string>;
  policyAccess: boolean;
  structured?: StructuredEventFingerprint;
}

interface StructuredEventFingerprint {
  eventType: string;
  primaryObject: string;
  objectFamily: string;
  objectVariantTokens: Set<string>;
  objectVersion: string;
  action: string;
  policyStage: PolicyAccessStage;
  confidence: number;
}

type PolicyAccessStage = 'restored' | 'blocked' | 'restricted' | 'partial' | 'unknown';

function deriveEventFingerprint(
  item: NewsCandidateForScoring,
  normalizedText: string,
  baseTokens: Set<string>,
): DerivedEventFingerprint {
  const fp = item.eventFingerprint;
  const explicitText = normalizeEventText([
    fp?.eventType || '',
    fp?.primaryActor || '',
    fp?.primaryObject || '',
    fp?.objectFamily || '',
    fp?.objectVariant || '',
    fp?.objectVersion || '',
    fp?.action || '',
    fp?.canonicalEvent || '',
  ].join(' '));
  const text = `${normalizedText} ${explicitText}`;
  const objectTokens = new Set<string>();
  const modelFamilies = new Set<string>();
  const actionTokens = new Set<string>();

  const addIf = (pattern: RegExp, token: string, target: Set<string> = objectTokens) => {
    if (pattern.test(text)) target.add(token);
  };

  addIf(/\bclaude\b/, 'claude', modelFamilies);
  addIf(/\bgpt[-\s]?5\.?6\b|\bgpt56\b/, 'gpt56', modelFamilies);
  addIf(/\bgpt[-\s]?\d/, 'gpt', modelFamilies);
  addIf(/\bgemini\b/, 'gemini', modelFamilies);
  addIf(/\bqwen\b|通义|千问/, 'qwen', modelFamilies);
  addIf(/\bdeepseek\b/, 'deepseek', modelFamilies);
  addIf(/\bdoubao\b|豆包/, 'doubao', modelFamilies);

  addIf(/\bsonnet\b/, 'sonnet');
  addIf(/\bfable\b/, 'fable');
  addIf(/\bmythos\b/, 'mythos');
  addIf(/\bopus\b/, 'opus');
  addIf(/\bhaiku\b/, 'haiku');
  addIf(/\bclaude\s+science\b|claude science|科学家 ai 工作台|科研/, 'claude-science');
  addIf(/\bbionemo\b/, 'bionemo');
  addIf(/\bgb300\b/, 'gb300');
  addIf(/\bblackwell\b/, 'blackwell');
  addIf(/\bazure\b/, 'azure');
  addIf(/\bsol\b/, 'sol');
  addIf(/\bterra\b/, 'terra');
  addIf(/\bluna\b/, 'luna');

  addIf(/\blaunch(?:es|ed)?\b|\brelease(?:s|d)?\b|\bintroduc(?:e|es|ing|ed)\b|发布|推出|上线/, 'launch', actionTokens);
  addIf(/\bintegrat(?:e|es|ed|ion)\b|\brun(?:s|ning)? on\b|\bbrings\b|接入|集成|运行|可用/, 'integration', actionTokens);
  addIf(/\bprice|pricing|cheap|cheaper|cost\b|定价|低成本|便宜/, 'pricing', actionTokens);

  const policyAccess = /\bgovernment\b|\badmin\b|\bexport\b|\bban\b|\bgreenlit\b|\bapproved\b|\brestriction|\bregulat|\bpolicy\b|\bcongress\b|\bagencies\b|\btrump\b|政府|国会|监管|禁令|解禁|批准|限制|大限/.test(text);
  if (policyAccess) actionTokens.add('policy');

  const explicitType = normalizeEventType(fp?.eventType || '');
  let eventType = explicitType;
  if (!eventType) {
    if (policyAccess) eventType = 'policy-access';
    else if (
      item.aiCategory === 'model-release'
      || (actionTokens.has('launch') && (modelFamilies.size > 0 || objectTokens.size > 0))
    ) {
      eventType = 'model-release';
    } else if (
      objectTokens.has('gb300')
      || objectTokens.has('blackwell')
      || objectTokens.has('azure')
      || objectTokens.has('bionemo')
      || actionTokens.has('integration')
    ) {
      eventType = 'infrastructure-integration';
    } else if (item.aiCategory === 'product') {
      eventType = 'product';
    } else {
      eventType = item.aiCategory || '';
    }
  }

  // 兜底:把已规范化 token 里的强对象词也纳入,避免 LLM 指纹缺失时信息不足。
  for (const token of baseTokens) {
    if (strongObjectTokens.has(token)) objectTokens.add(token);
  }

  return {
    eventType,
    modelFamilies,
    objectTokens,
    actionTokens,
    policyAccess,
    structured: deriveStructuredEventFingerprint(fp, text, policyAccess),
  };
}

function shouldSeparateByEventFingerprint(left: DerivedEventFingerprint, right: DerivedEventFingerprint): boolean {
  if (
    left.structured
    && right.structured
    && left.policyAccess
    && right.policyAccess
    && policyStagesConflict(left.structured.policyStage, right.structured.policyStage)
  ) {
    return true;
  }

  // 同一监管/解禁/访问政策事件可同时覆盖 Mythos/Fable 等多个模型名,不能用型号差异硬拆。
  if (left.policyAccess && right.policyAccess) return false;

  const sharedFamilies = intersection(left.modelFamilies, right.modelFamilies);
  const leftSpecific = specificObjectTokens(left.objectTokens);
  const rightSpecific = specificObjectTokens(right.objectTokens);
  const sharedSpecific = intersection(leftSpecific, rightSpecific);

  // Claude 是产品族,不是事件。只共享 Anthropic/Claude/model/agent 不能说明同一事件;
  // Sonnet 发布、Claude Science 产品、NVIDIA GB300/Azure/BioNeMo 集成必须拆开。
  if (sharedFamilies.has('claude') && leftSpecific.size > 0 && rightSpecific.size > 0 && sharedSpecific.size === 0) {
    return true;
  }

  const mismatchedType =
    (left.eventType === 'model-release' && right.eventType && right.eventType !== 'model-release')
    || (right.eventType === 'model-release' && left.eventType && left.eventType !== 'model-release');
  if (mismatchedType && sharedFamilies.size > 0 && leftSpecific.size > 0 && rightSpecific.size > 0 && sharedSpecific.size === 0) {
    return true;
  }

  return false;
}

function deriveStructuredEventFingerprint(
  fp: NewsEventFingerprint | undefined,
  normalizedText: string,
  policyAccess: boolean,
): StructuredEventFingerprint | undefined {
  if (!fp) return undefined;
  const confidence = typeof fp.confidence === 'number' ? fp.confidence : 0;
  return {
    eventType: normalizeEventType(fp.eventType || ''),
    primaryObject: normalizeStructuredValue(fp.primaryObject || ''),
    objectFamily: normalizeStructuredValue(fp.objectFamily || ''),
    objectVariantTokens: structuredVariantTokens(fp.objectVariant || fp.primaryObject || ''),
    objectVersion: normalizeStructuredValue(fp.objectVersion || ''),
    action: normalizeStructuredValue(fp.action || ''),
    policyStage: policyAccess ? detectPolicyAccessStage(normalizedText) : 'unknown',
    confidence,
  };
}

function normalizeEventType(value: string): string {
  return normalizeEventToken(String(value || '').toLowerCase().replace(/_/g, '-'));
}

function normalizeStructuredValue(value: string): string {
  return normalizeEventText(value).replace(/[^a-z0-9]+/g, '');
}

function structuredVariantTokens(value: string): Set<string> {
  const text = normalizeEventText(value);
  const tokens = new Set<string>();
  for (const match of text.match(/[a-z0-9][a-z0-9-]{1,}/g) || []) {
    const token = normalizeEventToken(match);
    if (token && !eventStopWords.has(token) && !genericObjectTokens.has(token)) tokens.add(token);
  }
  return tokens;
}

function detectPolicyAccessStage(text: string): PolicyAccessStage {
  if (/仍.*(搁置|无期|未恢复|不可用)|尚未恢复|仍未恢复|\bstill\b.*\b(blocked|unavailable|sidelined|restricted)\b|\bremain(?:s|ed)?\b.*\b(blocked|unavailable|restricted)\b/.test(text)) {
    return 'blocked';
  }
  if (/\bpartial(?:ly)?\b|\blimited\b|\bselect\b|\bgray\b|\bgrey\b|灰度|部分|有限/.test(text)) {
    return 'partial';
  }
  if (/\bredeploy|\brestore|\brestored|\bgreenlit|\blift(?:ed|s)?\b|\bapprove(?:d|s)?\b|\bavailable\b|解除|恢复|解禁|重新上线|批准|可用/.test(text)) {
    return 'restored';
  }
  if (/\brestrict(?:ed|ion|s)?\b|\bban(?:ned)?\b|\bsuspend(?:ed)?\b|\bcontrol(?:s)?\b|限制|禁令|暂停|管制/.test(text)) {
    return 'restricted';
  }
  return 'unknown';
}

function policyStagesConflict(left: PolicyAccessStage, right: PolicyAccessStage): boolean {
  if (left === 'unknown' || right === 'unknown' || left === right) return false;
  const terminal = new Set<PolicyAccessStage>(['restored', 'blocked', 'restricted']);
  return terminal.has(left) && terminal.has(right);
}

function specificObjectTokens(tokens: Set<string>): Set<string> {
  return new Set([...tokens].filter((token) => !genericObjectTokens.has(token)));
}

function sameNewsEvent(left: TokenProfile, right: TokenProfile): boolean {
  const structuredSame = sameStructuredEventFingerprint(left.fingerprint, right.fingerprint);
  if (structuredSame !== undefined) return structuredSame;
  if (shouldSeparateByEventFingerprint(left.fingerprint, right.fingerprint)) return false;
  const shared = intersection(left.tokens, right.tokens);
  if (shared.size < 2) return false;
  const sharedOrgs = intersection(left.orgs, right.orgs);
  const sharedTopics = intersection(left.topics, right.topics);
  const sharedDistinctive = intersection(left.distinctive, right.distinctive);
  if (sharedDistinctive.has('jalapeno')) return true;
  if (sharedOrgs.size >= 2 && sharedTopics.size) return true;
  if (sharedOrgs.size && sharedTopics.size && [...sharedDistinctive].some((token) => modelNameEventTokens.has(token))) return true;
  if (sharedOrgs.size && sharedTopics.size && [...sharedDistinctive].some((token) => token.length >= 6 || /\d/.test(token))) return true;
  if (shared.size >= 3 && sharedDistinctive.size >= 2 && sharedTopics.size) return true;
  return false;
}

function sameStructuredEventFingerprint(left: DerivedEventFingerprint, right: DerivedEventFingerprint): boolean | undefined {
  const l = left.structured;
  const r = right.structured;
  if (!l || !r) return undefined;
  if (l.confidence < 0.75 || r.confidence < 0.75) return undefined;
  if (policyStagesConflict(l.policyStage, r.policyStage)) return false;
  if (l.eventType && r.eventType && l.eventType !== r.eventType) return undefined;

  const sameAction = !l.action || !r.action || l.action === r.action;
  if (!sameAction && !left.policyAccess && !right.policyAccess) return undefined;

  if (l.primaryObject && r.primaryObject && l.primaryObject === r.primaryObject && sameAction) return true;

  if (l.objectFamily && r.objectFamily && l.objectFamily === r.objectFamily && l.objectVersion && r.objectVersion && l.objectVersion === r.objectVersion) {
    if (!left.policyAccess && !right.policyAccess) return sameAction;
    const sharedVariants = intersection(l.objectVariantTokens, r.objectVariantTokens);
    return sharedVariants.size > 0 && !policyStagesConflict(l.policyStage, r.policyStage);
  }

  return undefined;
}

function intersection(left: Set<string>, right: Set<string>): Set<string> {
  const result = new Set<string>();
  for (const value of left) {
    if (right.has(value)) result.add(value);
  }
  return result;
}

const orgEventTokens = new Set([
  'openai', 'anthropic', 'google', 'microsoft', 'nvidia', 'huggingface', 'mistral',
  'qwen', 'meta', 'amazon', 'aws', 'broadcom', 'amd', 'intel', 'cerebras', 'groq',
  'ai21', 'minimax', 'deepseek', 'claude', 'gemini',
]);

const officialSourceNames = new Set([
  'openai', 'anthropic', 'google', 'googledeepmind', 'deepmind', 'microsoft',
  'nvidia', 'meta', 'amazon', 'aws', 'huggingface', 'mistral', 'cohere',
  'perplexity', 'deepseek', 'qwen', 'alibaba', 'baidu', 'tencent', 'bytedance',
  'doubao', 'zhipu', 'moonshot', 'minimax', 'xai', 'ai21', 'cerebras', 'groq',
  'broadcom', 'amd', 'intel', 'apple',
]);

const topicEventTokens = new Set([
  'chip', 'compute', 'inference', 'training', 'model', 'agent', 'safety', 'benchmark',
  'research', 'robot', 'robotics', 'voice', 'video', 'image', 'coding', 'codex',
  'slackbot', 'security', 'standard', 'standards', 'infrastructure',
]);

const modelNameEventTokens = new Set([
  'gpt4', 'gpt5', 'gpt56', 'claude', 'opus', 'sonnet', 'haiku', 'mythos',
  'fable', 'gemini', 'qwen', 'glm', 'ernie',
  'doubao', 'kling', 'sora', 'veo', 'imagen', 'sol', 'terra', 'luna',
]);

const strongObjectTokens = new Set([
  'sonnet', 'fable', 'mythos', 'opus', 'haiku',
  'claude-science', 'bionemo', 'gb300', 'blackwell', 'azure',
  'gpt56', 'sol', 'terra', 'luna',
]);

const genericObjectTokens = new Set([
  'claude', 'gpt', 'model', 'agent',
]);

const genericEventTokens = new Set([
  ...topicEventTokens,
  'openai', 'anthropic', 'google', 'microsoft', 'nvidia', 'meta', 'amazon', 'aws',
  'first', 'new', 'launch', 'launches', 'launched', 'release', 'releases', 'released',
  'introducing', 'introduces', 'unveil', 'unveils', 'reveals', 'built',
]);

const eventStopWords = new Set([
  'the', 'and', 'for', 'with', 'from', 'into', 'onto', 'that', 'this', 'its', 'their',
  'our', 'your', 'his', 'her', 'you', 'are', 'was', 'were', 'has', 'have', 'had',
  'how', 'why', 'what', 'when', 'where', 'who', 'will', 'can', 'could', 'would',
  'should', 'about', 'over', 'under', 'more', 'less', 'than', 'then', 'after',
  'before', 'today', 'yesterday', 'tomorrow', 'just', 'now', 'new',
]);

const cjkEventTerms: Array<[RegExp, string]> = [
  [/博通/g, 'broadcom'],
  [/自研|定制/g, 'custom'],
  [/芯片|处理器|半导体/g, 'chip'],
  [/推理/g, 'inference'],
  [/算力|计算基础设施/g, 'compute'],
  [/模型/g, 'model'],
  [/智能体|代理/g, 'agent'],
  [/安全|对齐/g, 'safety'],
  [/机器人/g, 'robotics'],
];
