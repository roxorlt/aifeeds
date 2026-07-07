// worker/src/feeds/blog-body-redecode.ts
//
// Task 1 数据回填（2026-07-06）：修复 RSSHub 源（jiqizhixin ~142 / weibo-hot-tech ~110）
// 存量正文里泄漏的字面结构标签（<p> / <img> / <strong> …）。
//
// 根因：这些源的 RSS description 是实体编码 HTML，旧 htmlToMarkdown 空转 + 末尾 decodeEntities
// 把 &lt;p&gt; 还原成字面 <p> 落进 body_markdown（详见 extract.ts 头注 + Task 1 调查报告）。
// extract.ts 已修转换管线（decodeEntityEncodedHtml），此模块把存量 body 重跑一次转换清干净。
//
// 存量 body_markdown 里现在是**真实**尖括号的 <p>/<img>（已被旧逻辑解码过），htmlToMarkdown
// 对真 HTML 天然能转（entity 检测不触发、走原路径），所以直接重跑即可，无需再解码。
// 游标字段 `body_redecoded_at` 单调（每条处理后置位，含无实际变更的），防重扫。dry 零写。

import type { Env } from "../index";
import { htmlToMarkdown, looksLikeStructuralHtml } from "./extract";

// 谓词：blog + 未打游标 + body_markdown 或 body_markdown_zh 含字面 <p / <img。
// （LIKE 用真实尖括号——存量泄漏是已解码的真实标签；investigation §4 亦用 body LIKE '%<p%'。）
const REDECODE_PREDICATE = `
  source_type = 'blog'
  AND json_extract(extra, '$.body_redecoded_at') IS NULL
  AND (
    json_extract(extra, '$.body_markdown') LIKE '%<p%'
    OR json_extract(extra, '$.body_markdown') LIKE '%<img%'
    OR json_extract(extra, '$.body_markdown_zh') LIKE '%<p%'
    OR json_extract(extra, '$.body_markdown_zh') LIKE '%<img%'
  )`;

interface RedecodeRow {
  id: string;
  url: string | null;
  extra: string | null;
}

/**
 * 分页扫存量 blog body 中泄漏结构标签的行，重跑 htmlToMarkdown 清洗写回。
 * 返回 {scanned,fixed,remaining}；fixed = 实际发生内容变更的条数（LIKE 命中但非结构标签的
 * 假阳性行内容不变、只推进游标）。dry=true 时零写、不推进游标（remaining 保持满值）。
 */
export async function runBlogBodyRedecode(
  env: Env,
  opts: { limit: number; dry: boolean },
): Promise<{ scanned: number; fixed: number; remaining: number }> {
  const nowIso = new Date().toISOString();

  const batch = await env.DB.prepare(
    `SELECT id, url, extra FROM items WHERE ${REDECODE_PREDICATE} LIMIT ?`,
  )
    .bind(opts.limit)
    .all<RedecodeRow>();

  let scanned = 0;
  let fixed = 0;

  for (const row of batch.results || []) {
    scanned++;
    let extra: Record<string, unknown> = {};
    try {
      extra = row.extra ? JSON.parse(row.extra) : {};
    } catch {
      extra = {};
    }
    // 相对 img URL 解析基址：canonical_url → url → 站点兜底。
    const baseUrl = String(
      extra.canonical_url || row.url || "https://ai-feeds.com",
    );

    const oldBody =
      typeof extra.body_markdown === "string" ? extra.body_markdown : "";
    const oldZh =
      typeof extra.body_markdown_zh === "string" ? extra.body_markdown_zh : "";

    // 仅对真含结构标签的字段重转（避免把干净 markdown 里巧合的 "<price>" 等非标签误剥）。
    const newBody = looksLikeStructuralHtml(oldBody)
      ? htmlToMarkdown(oldBody, baseUrl).markdown
      : oldBody;
    const newZh = looksLikeStructuralHtml(oldZh)
      ? htmlToMarkdown(oldZh, baseUrl).markdown
      : oldZh;

    const bodyChanged = newBody !== oldBody;
    const zhChanged = newZh !== oldZh;
    if (bodyChanged || zhChanged) fixed++;

    if (opts.dry) continue;

    // 始终推进游标；变更字段一并写回（path 均为固定字面量，value 走 bind，无注入）。
    const paths: string[] = [];
    const binds: unknown[] = [];
    if (bodyChanged) {
      paths.push("'$.body_markdown', ?");
      binds.push(newBody);
    }
    if (zhChanged) {
      paths.push("'$.body_markdown_zh', ?");
      binds.push(newZh);
    }
    paths.push("'$.body_redecoded_at', ?");
    binds.push(nowIso);
    binds.push(row.id);

    await env.DB.prepare(
      `UPDATE items SET extra = json_set(COALESCE(extra,'{}'), ${paths.join(", ")}) WHERE id = ?`,
    )
      .bind(...binds)
      .run();
  }

  const rem = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM items WHERE ${REDECODE_PREDICATE}`,
  ).first<{ c: number }>();

  return { scanned, fixed, remaining: rem?.c ?? 0 };
}
