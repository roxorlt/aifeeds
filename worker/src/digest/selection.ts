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
): Promise<string[]> {
  if (source === 'clawhub') return selectClawhubByDelta(env, limit);
  if (source === 'news') return selectNewsByScore(env, limit);

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

  const sql = `SELECT id FROM items
    WHERE source_type = ?
      AND datetime(scraped_at) >= datetime('now','-${windowDays} day')
      AND deleted_at IS NULL ${extraWhere} ${wcGate}
    ORDER BY ${orderBy}
    LIMIT ?`;
  const rows = await env.DB.prepare(sql).bind(sourceType, limit).all<{ id: string }>();
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

// 行业新闻(blog+podcast 合并)按「规则综合分」排序(无 LLM)。权重(总分 100):
//   重要性 40(ai_category)+ 源权威 30(source_company 三档)+ 新鲜度 20(published_at 衰减)+ 深度 10(blog/播客文字稿档)
// 窗口 3 天,只取已 enrich(有 ai_summary_zh)的 AI 相关条目。
// 同源去重:同一 source_company 先只出最高分 1 条,top N 尽量分散到不同源(防头条全是同一家)。
async function selectNewsByScore(env: Env, limit: number): Promise<string[]> {
  const cat = `json_extract(extra,'$.ai_category')`;
  const co = `json_extract(extra,'$.source_company')`;
  const tier = `json_extract(extra,'$.transcript_tier')`;
  const tzh = `json_extract(extra,'$.title_zh')`;
  const score = `(
    CASE ${cat}
      WHEN 'model-release' THEN 40 WHEN 'research' THEN 34 WHEN 'safety' THEN 30
      WHEN 'product' THEN 24 WHEN 'engineering' THEN 20 WHEN 'company' THEN 14 ELSE 6 END
    + CASE
        WHEN ${co} IN ('OpenAI','Anthropic','Google','Microsoft Research','NVIDIA','Hugging Face','Latent Space','Lex Fridman') THEN 30
        WHEN ${co} IN ('Mistral AI','Qwen','面壁智能 / OpenBMB','Practical AI','No Priors','Machine Learning Street Talk','The Cognitive Revolution','OpenAI Podcast') THEN 22
        ELSE 14 END
    + CASE
        WHEN (julianday('now') - julianday(published_at)) < 1 THEN 20
        WHEN (julianday('now') - julianday(published_at)) < 2 THEN 15
        WHEN (julianday('now') - julianday(published_at)) < 3 THEN 10
        WHEN (julianday('now') - julianday(published_at)) < 4 THEN 6 ELSE 3 END
    + CASE
        WHEN source_type = 'blog' THEN 8
        WHEN ${tier} = 'A' THEN 10 WHEN ${tier} = 'B' THEN 5 ELSE 2 END
  )`;
  // 同源去重:每个 source_company 先出最高分 1 条(rn_co=1),top N 不够再补各源第 2、3 条。
  // ORDER BY rn_co ASC, score DESC = 先所有源「头名」按分排,再所有源「次名」…… LIMIT 截断 → 尽量分散到不同源。
  const sql = `
    WITH base AS (
      SELECT id, ${score} AS score, COALESCE(${co}, '') AS co, published_at
      FROM items
      WHERE source_type IN ('blog','podcast')
        AND is_relevant = 1
        AND json_extract(extra,'$.ai_summary_zh') IS NOT NULL
        AND json_extract(extra,'$.ai_summary_zh') != ''
        AND datetime(scraped_at) >= datetime('now','-3 day')
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
        )
    ),
    ranked AS (
      SELECT id, score,
        ROW_NUMBER() OVER (PARTITION BY co ORDER BY score DESC, datetime(published_at) DESC) AS rn_co
      FROM base
    )
    SELECT id FROM ranked
    ORDER BY rn_co ASC, score DESC
    LIMIT ?`;
  const rows = await env.DB.prepare(sql).bind(limit).all<{ id: string }>();
  return (rows.results || []).map((r) => r.id);
}
