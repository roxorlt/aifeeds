// worker/src/search/sync.ts
// C 端搜索索引同步：从 items 表抽取合规字段 → 预分词 → 写 items_fts 影子表。
//   - extractSearchFields：纯函数，实现入索引门槛（五条件）+ 各源字段映射。单测覆盖。
//   - syncSearchIndex：增量同步（含首次自动 backfill 推进），挂 */5 cron，幂等 upsert。
//   - reconcileSearchIndex：每日对账，清出事后不合规行 + 行数差告警。
//   - handleSearchReindex：admin 手动触发循环批次（~20s 时间预算），staging 验证用。
// 设计：docs/plans/2026-07-06-c-search-design.md §3.2 / §7。
import type { Env } from "../index";
import { checkAdminAuth, jsonRes } from "../admin";
import { tokenizeForSearch } from "./tokenize";

export type ItemRow = {
  id: string;
  source_type: string;
  title: string | null;
  content: string | null;
  content_translated: string | null;
  author: string | null;
  handle: string | null;
  published_at: string | null;
  extra: string | null;
  is_relevant: number;
  deleted_at: number | null;
};

// items 表读取列（extractSearchFields 需要的全部字段）。rowid 单独 AS rid 取。
const ITEM_COLS =
  "id, source_type, title, content, content_translated, author, handle, published_at, extra, is_relevant, deleted_at";

// 单轮扫描/处理上限（backfill 与增量共用）。见设计 §7「单轮上限 2000 行」。
const BATCH_LIMIT = 2000;
// D1 batch 每次事务打包的最大语句数（一个 upsert = DELETE + INSERT 两条）。
// db.batch() 整批只算一次 D1 subrequest，控制在 100 条以内避免单请求过大。
const STMT_CHUNK = 100;
// 增量水位 buffer：防时钟偏差 / 落库与 scraped_at 之间的微小时序差。
const SCRAPED_BUFFER_SEC = 600; // 600 秒
const TRANSLATED_BUFFER_SEC = 600; // 600 秒

/**
 * scraped_at 混合格式解析 → epoch 秒。库里 X 源是 "YYYY-MM-DD HH:MM:SS"（空格分隔、
 * 无时区后缀，按 UTC 处理），GitHub/blog 等是 ISO "...T...Z"。空格先归一成 'T'，
 * 无时区后缀（Z 或 ±hh:mm / ±hhmm）补 'Z' —— 裸 Date.parse 无后缀串会按本地时区解析，
 * 必须显式钉死 UTC。非法串返回 null。
 */
export function parseScrapedAt(s: string | null | undefined): number | null {
  if (!s) return null;
  let t = s.trim().replace(" ", "T");
  if (!/[zZ]$|[+-]\d{2}:?\d{2}$/.test(t)) t += "Z";
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

// 截断辅助：非空则截前 n 字符，否则空串。
const cut = (s: string | null | undefined, n: number): string =>
  s ? String(s).slice(0, n) : "";

// 空格拼接：过滤 falsy 段，trim。用于把多字段并成一个 token 源。
const j = (...parts: (string | null | undefined)[]): string =>
  parts.map((p) => (p == null ? "" : String(p))).filter((p) => p.trim()).join(" ").trim();

// 从「数组 of string | {name} | {title}」里提取名字/标题并空格拼接（各源 makers/guests/keywords/timeline）。
const namesOf = (v: unknown, keys: string[] = ["name", "title"]): string => {
  if (!Array.isArray(v)) return "";
  const out: string[] = [];
  for (const el of v) {
    if (el == null) continue;
    if (typeof el === "string") { if (el.trim()) out.push(el); continue; }
    if (typeof el === "object") {
      for (const k of keys) {
        const val = (el as Record<string, unknown>)[k];
        if (typeof val === "string" && val.trim()) { out.push(val); break; }
      }
    }
  }
  return out.join(" ");
};

/**
 * 抽取一条 item 的搜索索引字段（title/body/author 三个 token 源）。
 * 返回 null = 不满足入索引门槛（合规过滤五条件）：
 *   workflow_completed_at 非空 / dedup_of 空 / cn_sensitive != 1 / is_relevant = 1 / deleted_at 空。
 * 字段映射见设计 §3.2；所有 extra 读取都 try/parse 容错。
 */
export function extractSearchFields(
  row: ItemRow,
): { title: string; body: string; author: string } | null {
  // 列级条件（is_relevant / deleted_at 是 items 真实列）。
  if (row.deleted_at != null || row.is_relevant !== 1) return null;
  let extra: Record<string, unknown> = {};
  try {
    extra = row.extra ? (JSON.parse(row.extra) as Record<string, unknown>) : {};
  } catch {
    extra = {};
  }
  // extra JSON 级条件（与 handleItems 同一套合规过滤，双保险）。
  if (!extra.workflow_completed_at || extra.dedup_of || Number(extra.cn_sensitive) === 1)
    return null;

  const e = extra as Record<string, any>;
  const title0 = row.title ?? "";

  switch (row.source_type) {
    case "x_list":
      // 推文无标题；正文 = 原文 + 译文；作者 = 显示名 + handle。
      return {
        title: "",
        body: j(row.content, row.content_translated),
        author: j(row.author, row.handle),
      };
    case "github": {
      // title = owner/repo；owner 段单独进 author（提升作者维度召回）。
      const owner = title0.includes("/") ? title0.split("/")[0] : "";
      return {
        title: title0,
        body: j(e.ai_summary, cut(e.readme_translated, 500), e.ai_category),
        author: j(owner, row.author),
      };
    }
    case "product_hunt":
      return {
        title: title0,
        body: j(row.content, e.ai_summary, cut(e.maker_post_text_translated, 500)),
        author: namesOf(e.makers),
      };
    case "clawhub":
      return {
        title: title0,
        body: j(e.summary_translated, e.category),
        author: j(row.author),
      };
    case "hf_paper":
      return {
        title: j(title0, e.title_zh),
        body: j(e.deep_analysis?.tldr, namesOf(e.ai_keywords)),
        author: j(row.author),
      };
    case "blog":
      return {
        title: j(title0, e.title_zh),
        body: j(e.excerpt_zh, e.ai_summary_zh),
        author: j(row.author),
      };
    case "podcast":
      // shownotes 截 1000 字；章节名来自 timeline；显式不索引 transcript 全文。
      return {
        title: j(title0, e.title_zh),
        body: j(cut(e.shownotes_zh, 1000), namesOf(e.timeline)),
        author: j(row.author, namesOf(e.guests)),
      };
    case "huodongxing":
      return {
        title: title0,
        body: j(row.content, e.city, e.organizer),
        author: j(row.author),
      };
    default:
      // 其余源：正文优先取译文，截 1000 字。
      return {
        title: title0,
        body: cut(row.content_translated ?? row.content, 1000),
        author: j(row.author, row.handle),
      };
  }
}

// ─── search_sync_state 读写辅助 ───────────────────────────────────────────

// 注：fts_wm_scraped_epoch 存 epoch 秒（不是 ISO 串）——库里 scraped_at 是混合格式
// （X 源空格分隔 / 其他源 ISO），字典序比较会漏行，统一走 epoch 数值比较。
// 旧 key fts_wm_scraped（ISO 串）已废弃，不再读写。
const STATE_KEYS = [
  "fts_wm_scraped_epoch",
  "fts_wm_translated",
  "fts_backfill_rowid",
  "fts_backfill_done",
] as const;

async function readState(env: Env): Promise<Record<string, string>> {
  const placeholders = STATE_KEYS.map(() => "?").join(",");
  const rs = await env.DB.prepare(
    `SELECT k, v FROM search_sync_state WHERE k IN (${placeholders})`,
  )
    .bind(...STATE_KEYS)
    .all<{ k: string; v: string }>();
  const out: Record<string, string> = {};
  for (const r of rs.results ?? []) out[r.k] = r.v;
  return out;
}

// upsert 一条水位（返回 prepared statement，可进 batch）。
function stateSet(env: Env, k: string, v: string) {
  return env.DB.prepare(
    `INSERT INTO search_sync_state (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  ).bind(k, v);
}

// token 源 → 空格分隔预分词流（items_fts 列内容）。
const tok = (s: string): string => tokenizeForSearch(s).join(" ");

// 把 rowid+fields 转成 items_fts 的 DELETE+INSERT 两条语句（幂等 upsert）。
function upsertStmts(env: Env, rid: number, row: ItemRow, f: { title: string; body: string; author: string }) {
  return [
    env.DB.prepare("DELETE FROM items_fts WHERE rowid = ?").bind(rid),
    env.DB.prepare(
      `INSERT INTO items_fts (rowid, title_tok, body_tok, author_tok, item_id, source_type, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(rid, tok(f.title), tok(f.body), tok(f.author), row.id, row.source_type, row.published_at),
  ];
}

type ScanRow = ItemRow & { rid: number };

// 处理一批扫描行：按 extractSearchFields 结果生成 upsert / delete 语句并落盘。
// 按 STMT_CHUNK 分块 batch（每块一个 D1 事务，整批只算一次 subrequest）。
// 关键：一行的 DELETE+INSERT 对必须落在同一事务里，故按「行」累积、不跨行切分。
// 返回本批 upsert 条数（非 null）。
async function applyRows(env: Env, rows: ScanRow[]): Promise<number> {
  let upserted = 0;
  let buf: D1PreparedStatement[] = [];
  const flush = async () => {
    if (buf.length) { await env.DB.batch(buf); buf = []; }
  };
  for (const row of rows) {
    const f = extractSearchFields(row);
    // 不满足门槛（含事后失格）：确保 FTS 里没有残留。
    const rowStmts = f == null
      ? [env.DB.prepare("DELETE FROM items_fts WHERE rowid = ?").bind(row.rid)]
      : upsertStmts(env, row.rid, row, f);
    if (f != null) upserted++;
    // 先 flush 再 push，保证同一行的语句对不被 chunk 边界拆散（rowStmts ≤ 2 < STMT_CHUNK）。
    if (buf.length + rowStmts.length > STMT_CHUNK) await flush();
    buf.push(...rowStmts);
  }
  await flush();
  return upserted;
}

/**
 * 增量同步（挂每 5 分钟 cron）。首次自动 backfill：fts_backfill_done 为空时按 rowid 分批追平；
 * 追平后走时间水位增量。单轮上限 2000 行，幂等 upsert，全程 try/catch 不抛出。
 * 返回 { scanned, upserted, errored }：scanned = 本轮扫描行数（< 2000 表示已追平/无新增）；
 * errored = 本轮异常兜底（此时 scanned=0 不代表追平，调用方勿据此 break 追平判定）。
 */
export async function syncSearchIndex(
  env: Env,
): Promise<{ scanned: number; upserted: number; errored: boolean }> {
  try {
    const state = await readState(env);
    const seedStmts: D1PreparedStatement[] = [];

    // 首次调用：播种增量水位为「当前时刻」——即 backfill 起点。backfill 按 rowid 覆盖
    // 全表历史，增量水位守住 backfill 期间发生变更的行（scraped_at / translated_at 均晚于起点）。
    if (state.fts_wm_scraped_epoch == null) {
      state.fts_wm_scraped_epoch = String(Math.floor(Date.now() / 1000));
      seedStmts.push(stateSet(env, "fts_wm_scraped_epoch", state.fts_wm_scraped_epoch));
    }
    if (state.fts_wm_translated == null) {
      state.fts_wm_translated = String(Math.floor(Date.now() / 1000));
      seedStmts.push(stateSet(env, "fts_wm_translated", state.fts_wm_translated));
    }
    if (seedStmts.length) await env.DB.batch(seedStmts);

    // ── backfill 未完成：按 rowid 升序分批 ──
    if (state.fts_backfill_done !== "1") {
      const lastRowid = Number(state.fts_backfill_rowid || "0") || 0;
      const rs = await env.DB.prepare(
        `SELECT rowid AS rid, ${ITEM_COLS} FROM items WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      )
        .bind(lastRowid, BATCH_LIMIT)
        .all<ScanRow>();
      const rows = rs.results ?? [];
      const upserted = await applyRows(env, rows);

      const writes: D1PreparedStatement[] = [];
      if (rows.length > 0) {
        const maxRid = rows[rows.length - 1].rid; // rowid 升序 → 末行即最大
        writes.push(stateSet(env, "fts_backfill_rowid", String(maxRid)));
      }
      if (rows.length < BATCH_LIMIT) {
        // 追平：标记 backfill 完成，后续走增量。
        writes.push(stateSet(env, "fts_backfill_done", "1"));
      }
      if (writes.length) await env.DB.batch(writes);
      return { scanned: rows.length, upserted, errored: false };
    }

    // ── backfill 完成：时间水位增量 ──
    // scraped_at 是混合格式（X 源 "YYYY-MM-DD HH:MM:SS" / 其他源 ISO "...T...Z"），
    // 纯字典序比较会漏行（空格 0x20 < 'T' 0x54）。两段式：
    //   1) scraped_at >= dayFloor（"YYYY-MM-DD" 日期前缀，两种格式的同日行都 > 前缀，
    //      字典序对两种格式均成立，可吃 idx_items_scraped 做范围收窄，避免全表 strftime）
    //   2) CAST(strftime('%s', scraped_at) AS INTEGER) > epochFloor 精确 epoch 比较
    //      （SQLite strftime 对空格 / T 分隔均可解析；CAST 必需——TEXT 与数值直接比较
    //      走 SQLite 存储类排序恒为 TEXT > number）。
    const wmScrapedEpoch = Number(state.fts_wm_scraped_epoch || "0") || 0;
    const wmTranslatedSec = Number(state.fts_wm_translated || "0") || 0;
    const scrapedEpochFloor = Math.max(0, wmScrapedEpoch - SCRAPED_BUFFER_SEC);
    const dayFloor = new Date(scrapedEpochFloor * 1000).toISOString().slice(0, 10);
    const translatedFloor = Math.max(0, wmTranslatedSec - TRANSLATED_BUFFER_SEC);

    // scraped_at / translated_at 额外取出用于推进水位（不在 ITEM_COLS 里）。
    const rs = await env.DB.prepare(
      `SELECT rowid AS rid, ${ITEM_COLS}, scraped_at, translated_at FROM items
       WHERE (scraped_at >= ? AND CAST(strftime('%s', scraped_at) AS INTEGER) > ?)
          OR COALESCE(translated_at, 0) > ?
       ORDER BY scraped_at ASC LIMIT ?`,
    )
      .bind(dayFloor, scrapedEpochFloor, translatedFloor, BATCH_LIMIT)
      .all<ScanRow & { scraped_at: string | null; translated_at: number | null }>();
    const rows = rs.results ?? [];
    const upserted = await applyRows(env, rows);

    // 推进水位到本轮实际见到的最大值（scraped_at 经 parseScrapedAt 归一为 epoch 秒；
    // translated_at 本身是 epoch 秒）。
    let maxScrapedEpoch = wmScrapedEpoch;
    let maxTranslated = wmTranslatedSec;
    for (const r of rows) {
      const se = parseScrapedAt(r.scraped_at);
      if (se != null && se > maxScrapedEpoch) maxScrapedEpoch = se;
      const ta = Number(r.translated_at || 0);
      if (Number.isFinite(ta) && ta > maxTranslated) maxTranslated = ta;
    }
    const writes: D1PreparedStatement[] = [];
    if (maxScrapedEpoch !== wmScrapedEpoch)
      writes.push(stateSet(env, "fts_wm_scraped_epoch", String(maxScrapedEpoch)));
    if (maxTranslated !== wmTranslatedSec)
      writes.push(stateSet(env, "fts_wm_translated", String(maxTranslated)));
    if (writes.length) await env.DB.batch(writes);

    return { scanned: rows.length, upserted, errored: false };
  } catch (e) {
    // 同步失败只记 log，下轮自动补齐；绝不影响主 cron / feed。
    console.error("[search] syncSearchIndex failed:", e);
    return { scanned: 0, upserted: 0, errored: true };
  }
}

// reconcile 合规过滤，两个互补 SQL 表达式（与 extractSearchFields 门槛一致）：
// ELIGIBLE_SQL 用于 COUNT（WHERE 里 NULL 自然当 false，is_relevant=1 已排除 NULL）；
// INELIGIBLE_SQL 用于 purge 的子查询（用 IS NOT NULL / != 的显式否定 + COALESCE 兜住
// is_relevant NULL，避免 NOT(AND) 遇 NULL 时漏删）。
// cn_sensitive 用 IN (1,'1') 同时吃数值与字符串写法，与 JS 侧 Number(...)===1 口径对齐
// （json_extract 对 "cn_sensitive":"1" 返回 TEXT '1'，= 1 数值比较会漏）。
const ELIGIBLE_SQL =
  "i.deleted_at IS NULL AND i.is_relevant = 1 " +
  "AND json_extract(i.extra,'$.workflow_completed_at') IS NOT NULL " +
  "AND json_extract(i.extra,'$.dedup_of') IS NULL " +
  "AND COALESCE(json_extract(i.extra,'$.cn_sensitive'),0) NOT IN (1,'1')";
const INELIGIBLE_SQL =
  "i.deleted_at IS NOT NULL " +
  "OR COALESCE(i.is_relevant,0) != 1 " +
  "OR json_extract(i.extra,'$.workflow_completed_at') IS NULL " +
  "OR json_extract(i.extra,'$.dedup_of') IS NOT NULL " +
  "OR COALESCE(json_extract(i.extra,'$.cn_sensitive'),0) IN (1,'1')";

/**
 * 每日对账（挂 cleanup 档 03:35 UTC）：
 *   1) 清出事后不合规行（软删 / is_relevant 翻转 / dedup / cn_sensitive 追标）。
 *   2) 统计 itemsEligible（items 满足五条件）与 ftsRows（items_fts 行数）。
 *   3) 行数差 abs > 500 触发 notifier 告警；结果写 search_sync_state.last_reconcile。
 */
export async function reconcileSearchIndex(
  env: Env,
): Promise<{ itemsEligible: number; ftsRows: number; purged: number }> {
  try {
    // 1) 清出不合规行（在 items 里已失格但 FTS 仍存留的 rowid）。
    const del = await env.DB.prepare(
      `DELETE FROM items_fts WHERE rowid IN (
         SELECT i.rowid FROM items i WHERE ${INELIGIBLE_SQL}
       )`,
    ).run();
    const purged = del.meta?.changes ?? 0;

    // 2) 统计。
    const eligRes = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM items i WHERE ${ELIGIBLE_SQL}`,
    ).first<{ c: number }>();
    const ftsRes = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM items_fts`,
    ).first<{ c: number }>();
    const itemsEligible = eligRes?.c ?? 0;
    const ftsRows = ftsRes?.c ?? 0;
    const drift = itemsEligible - ftsRows;

    // 3) 写对账结果 + 差值告警。
    const payload = {
      itemsEligible,
      ftsRows,
      purged,
      drift,
      at: new Date().toISOString(),
    };
    await stateSet(env, "last_reconcile", JSON.stringify(payload)).run();

    if (Math.abs(drift) > 500) {
      try {
        const { pushDeerWarning } = await import("../notifier");
        await pushDeerWarning(
          env,
          "搜索索引滞后",
          `items 合规行 ${itemsEligible} 与 items_fts ${ftsRows} 差 ${drift}（purged ${purged}）。`,
        );
      } catch (e) {
        console.error("[search] reconcile drift alert failed:", drift, e);
      }
    }

    return { itemsEligible, ftsRows, purged };
  } catch (e) {
    console.error("[search] reconcileSearchIndex failed:", e);
    return { itemsEligible: 0, ftsRows: 0, purged: 0 };
  }
}

/**
 * POST /api/admin/search/reindex（admin auth）。
 * 循环调 syncSearchIndex 直到追平（scanned < 2000）或 ~20s 时间预算耗尽。
 * ?reset=1：重置 backfill 进度 + 播种增量水位为当前时刻，从头全量重建。
 */
export async function handleSearchReindex(request: Request, env: Env): Promise<Response> {
  if (!(await checkAdminAuth(request, env))) return jsonRes({ error: "unauthorized" }, 401);

  const url = new URL(request.url);
  if (url.searchParams.get("reset") === "1") {
    const nowSec = String(Math.floor(Date.now() / 1000));
    await env.DB.batch([
      stateSet(env, "fts_backfill_done", ""),
      stateSet(env, "fts_backfill_rowid", "0"),
      stateSet(env, "fts_wm_scraped_epoch", nowSec),
      stateSet(env, "fts_wm_translated", nowSec),
    ]);
  }

  const t0 = Date.now();
  let rounds = 0;
  let lastScanned = 0;
  let totalUpserted = 0;
  let lastErrored = false;
  const BUDGET_MS = 20000;
  while (Date.now() - t0 < BUDGET_MS) {
    const r = await syncSearchIndex(env);
    rounds++;
    lastScanned = r.scanned;
    totalUpserted += r.upserted;
    lastErrored = r.errored;
    // errored 轮的 scanned=0 不是追平信号：直接 break 避免 20s 内空转重试，
    // errored 透传给 admin 观察；正常轮 scanned < 2000 = 追平/无新增。
    if (r.errored || r.scanned < BATCH_LIMIT) break;
  }

  const state = await readState(env);
  return jsonRes({
    rounds,
    lastScanned,
    totalUpserted,
    errored: lastErrored,
    backfillDone: state.fts_backfill_done === "1",
    backfillRowid: Number(state.fts_backfill_rowid || "0") || 0,
    elapsed_ms: Date.now() - t0,
  });
}
