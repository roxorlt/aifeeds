// worker/src/search/terms.ts
// 每小时全量重建 suggestion 词表：
//   - entity 词从 items 挖掘（各源提词规则见 collectEntityTerms）。
//   - hot_query 从 events(search_submit) 近 7 天聚合（Task 6 开始产生事件；现为空正常）。
// 语义：本轮 upsert 后删除 updated_at < 本轮时间戳 的旧行（全量刷新）。
// 物化到 search_terms（migration 026），/suggest 直接读。全程 try/catch 不抛出，挂整点 cron。
// 设计：docs/plans/2026-07-06-c-search-design.md §5。
import type { Env } from "../index";
import { tokenizeForSearch } from "./tokenize";

// collectEntityTerms 的输入行（items 的 6 列子集，全部 string|null）。
export type TermSourceRow = {
  source_type: string | null;
  title: string | null;
  author: string | null;
  handle: string | null;
  extra: string | null;
  metrics: string | null;
};

// 输出条目（Map value）：term=展示词，weight=排序权重，source_type=归属源。
type Entry = { term: string; weight: number; source_type: string };

const MIN_LEN = 2;
const MAX_LEN = 40;
// x_list / podcast 作者与 handle 出现次数达此阈值才成词（weight=次数）。
const FREQ_THRESHOLD = 3;

// term_norm 归一：NFKC + lowercase + trim（与 tokenize.ts 归一一致；整词不做 bigram 切分）。
function normTerm(s: string): string {
  return s.normalize("NFKC").toLowerCase().trim();
}

// extra / metrics JSON 容错解析（非法或非对象 → 空对象）。
function parseObj(s: string | null): Record<string, any> {
  if (!s) return {};
  try {
    const v = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, any>) : {};
  } catch {
    return {};
  }
}

/**
 * 遍历合规 items 行按源提词，返回 Map<term_norm, {term, weight, source_type}>。
 * 提词规则（brief §Step 3）：
 *   - github：title 全名 + repo 段 + extra.ai_category；weight = 1 + log10(max(1, stars))。
 *   - product_hunt / clawhub：title；weight 1。
 *   - hf_paper：extra.ai_keywords[]；weight 1。
 *   - blog：author（媒体名）；weight 1。
 *   - x_list / podcast：author 与 handle 计频，同一行内按归一去重，≥3 次成词，weight=次数。
 * 全部 trim；term_norm = NFKC lowercase；长度 2-40 过滤。
 */
export function collectEntityTerms(rows: TermSourceRow[]): Map<string, Entry> {
  const out = new Map<string, Entry>();
  // 频次源（x_list / podcast）单独累积：term_norm → { term, source_type, freq }。
  const freq = new Map<string, { term: string; source_type: string; count: number }>();

  // 直接成词（非频次）：按 term_norm 入 out，冲突取较大 weight，保留首见 term/source_type。
  const addDirect = (raw: string | null | undefined, sourceType: string, weight: number) => {
    if (raw == null) return;
    const term = String(raw).trim();
    if (!term) return;
    const norm = normTerm(term);
    if (norm.length < MIN_LEN || norm.length > MAX_LEN) return;
    const prev = out.get(norm);
    if (!prev) out.set(norm, { term, weight, source_type: sourceType });
    else if (weight > prev.weight) prev.weight = weight;
  };

  for (const row of rows) {
    const st = row.source_type ?? "";
    const extra = parseObj(row.extra);

    switch (st) {
      case "github": {
        // stars 权重：缺失 / 非法 → 1（log10(1)=0 → weight 1）。
        const metrics = parseObj(row.metrics);
        const rawStars = Number(metrics.stars);
        const stars = Number.isFinite(rawStars) && rawStars > 0 ? rawStars : 1;
        const weight = 1 + Math.log10(stars);
        const title = (row.title ?? "").trim();
        addDirect(title, st, weight); // 全名（owner/repo）
        if (title.includes("/")) {
          const repo = title.slice(title.lastIndexOf("/") + 1); // repo 段
          addDirect(repo, st, weight);
        }
        if (typeof extra.ai_category === "string") addDirect(extra.ai_category, st, weight);
        break;
      }
      case "product_hunt":
      case "clawhub":
        addDirect(row.title, st, 1);
        break;
      case "hf_paper": {
        const kws = extra.ai_keywords;
        if (Array.isArray(kws)) for (const k of kws) if (typeof k === "string") addDirect(k, st, 1);
        break;
      }
      case "blog":
        addDirect(row.author, st, 1); // 媒体名
        break;
      case "x_list":
      case "podcast": {
        // author 与 handle 计频：同一行按归一去重（同一个人显示名与 handle 归一相同不重复计数）。
        const seen = new Set<string>();
        for (const raw of [row.author, row.handle]) {
          if (raw == null) continue;
          const term = String(raw).trim();
          if (!term) continue;
          const norm = normTerm(term);
          if (norm.length < MIN_LEN || norm.length > MAX_LEN) continue;
          if (seen.has(norm)) continue;
          seen.add(norm);
          const cur = freq.get(norm);
          if (cur) cur.count += 1;
          else freq.set(norm, { term, source_type: st, count: 1 });
        }
        break;
      }
      default:
        break;
    }
  }

  // 频次成词：达阈值才入表，weight=次数。与直接成词冲突时取较大 weight。
  for (const [norm, v] of freq) {
    if (v.count < FREQ_THRESHOLD) continue;
    const prev = out.get(norm);
    if (!prev) out.set(norm, { term: v.term, weight: v.count, source_type: v.source_type });
    else if (v.count > prev.weight) prev.weight = v.count;
  }

  return out;
}

// 五条件合规过滤（抄 sync.ts ELIGIBLE_SQL，items 别名 i）：
//   workflow_completed_at 非空 / dedup_of 空 / cn_sensitive NOT IN (1,'1') / is_relevant=1 / deleted_at 空。
const ELIGIBLE_SQL =
  "i.deleted_at IS NULL AND i.is_relevant = 1 " +
  "AND json_extract(i.extra,'$.workflow_completed_at') IS NOT NULL " +
  "AND json_extract(i.extra,'$.dedup_of') IS NULL " +
  "AND COALESCE(json_extract(i.extra,'$.cn_sensitive'),0) NOT IN (1,'1')";

// INSERT OR REPLACE 每批行数上限：每行 6 个绑定参数，16 行 = 96 参数 < D1 单语句 100 参数上限。
const INSERT_CHUNK = 16;

// 分批 INSERT OR REPLACE 一组词条。返回实际写入行数。
async function insertTerms(
  env: Env,
  rows: { term: string; term_norm: string; term_type: string; source_type: string | null; weight: number }[],
  ts: number,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const slice = rows.slice(i, i + INSERT_CHUNK);
    const placeholders = slice.map(() => "(?,?,?,?,?,?)").join(",");
    const binds: (string | number | null)[] = [];
    for (const r of slice) binds.push(r.term, r.term_norm, r.term_type, r.source_type, r.weight, ts);
    await env.DB.prepare(
      `INSERT OR REPLACE INTO search_terms (term, term_norm, term_type, source_type, weight, updated_at) VALUES ${placeholders}`,
    )
      .bind(...binds)
      .run();
    written += slice.length;
  }
  return written;
}

/**
 * 每小时全量重建 suggestion 词表。步骤：
 *   1. 读合规 items 6 列 → collectEntityTerms → entity 词。
 *   2. 分批 INSERT OR REPLACE（term_type='entity'）。
 *   3. events(search_submit) 近 7 天聚合 hot_query（q 校验 1-50 字符 + tokenize 非空；
 *      weight = c×10 保证热搜排前）→ 分批 INSERT OR REPLACE（term_type='hot_query'）。
 *   4. DELETE updated_at < 本轮 ts（全量刷新，本轮写入行 updated_at = ts 不受影响）。
 * 全程 try/catch 不抛出（挂 scheduled() 不能挂主 cron）。
 * 注：occurred_at 存 epoch 毫秒（见 track.ts），比较界用 (strftime('%s','now')-7*86400)*1000。
 */
export async function rebuildSearchTerms(env: Env): Promise<{ entities: number; hotQueries: number }> {
  try {
    const ts = Date.now(); // 本轮时间戳（ms）：全轮 upsert 的 updated_at + 删除界，务必只取一次。

    // ── 1) entity 词 ──
    const rs = await env.DB.prepare(
      `SELECT source_type, title, author, handle, extra, metrics FROM items i WHERE ${ELIGIBLE_SQL}`,
    ).all<TermSourceRow>();
    const entityMap = collectEntityTerms(rs.results ?? []);
    const entityRows = [...entityMap.entries()].map(([norm, e]) => ({
      term: e.term,
      term_norm: norm,
      term_type: "entity",
      source_type: e.source_type,
      weight: e.weight,
    }));
    const entities = await insertTerms(env, entityRows, ts);

    // ── 3) hot_query 词（events 近 7 天）──
    // occurred_at 是 epoch 毫秒；用 (秒 - 7天)*1000 作下界（勿用 datetime() 文本比较，会恒 false）。
    const hq = await env.DB.prepare(
      `SELECT json_extract(event_payload,'$.q') AS q, COUNT(*) AS c
         FROM events
        WHERE event_type='search_submit'
          AND occurred_at >= (strftime('%s','now') - 7 * 86400) * 1000
        GROUP BY q HAVING c >= 3 ORDER BY c DESC LIMIT 100`,
    ).all<{ q: string | null; c: number }>();

    // q 校验：1-50 字符 + tokenize 后非空；按归一去重（不同原串归一相同取较大 c）。
    const hotMap = new Map<string, { term: string; weight: number }>();
    for (const r of hq.results ?? []) {
      const term = (r.q ?? "").trim();
      if (term.length < 1 || term.length > 50) continue;
      if (tokenizeForSearch(term).length === 0) continue;
      const norm = normTerm(term);
      if (!norm) continue;
      const weight = Number(r.c) * 10; // ×10 保证热搜排在 entity 前
      const prev = hotMap.get(norm);
      if (!prev || weight > prev.weight) hotMap.set(norm, { term, weight });
    }
    const hotRows = [...hotMap.entries()].map(([norm, v]) => ({
      term: v.term,
      term_norm: norm,
      term_type: "hot_query",
      source_type: null,
      weight: v.weight,
    }));
    const hotQueries = await insertTerms(env, hotRows, ts);

    // ── 4) 全量刷新：删除本轮之前写入的旧行（updated_at = ts 的本轮行不受影响）──
    await env.DB.prepare(`DELETE FROM search_terms WHERE updated_at < ?`).bind(ts).run();

    return { entities, hotQueries };
  } catch (e) {
    // 重建失败只记 log，下轮整点自动重来；绝不影响主 cron / feed。
    console.error("[search] rebuildSearchTerms failed:", e);
    return { entities: 0, hotQueries: 0 };
  }
}
