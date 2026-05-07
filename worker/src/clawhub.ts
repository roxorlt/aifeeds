// ClawHub Skills Marketplace scraper — runs entirely on CF Worker.
// No local launchd / no browser-use / no cookie. Convex public API is open.
//
// Data source: https://wry-manatee-359.convex.site/api/v1/skills (REST V1)
//   + Convex direct query at /api/query for richer install data.
//
// Two phases (separate scheduled invocations):
//   Phase 1 — runClawhubFetchList: 8 list calls (top 1000 stars + top 500
//   updated, dedup). Triggered at BJT 04:00 + 16:00 (UTC 20:00 + 08:00).
//   Cheap: 8 fetch + 1 D1 batch ≈ 9 subrequests.
//
//   Phase 2 — runClawhubEnrichPending: picks 1-2 ch_pending rows, calls
//   getBySlug for license/version/install/capabilityTags, translates summary
//   via DeepSeek, writes back. ~5 subrequests/invocation. Runs on any
//   */5min slot when there's pending work.
//
// V0 scope: NO ZIP download, NO README extraction, NO SKILL.md, NO inline
// image R2 migration. Those land in v1 iteration. v0 fills feed cards +
// minimal drawer (header + stats + summary + capability_tags + install).
//
// Design: docs/plans/2026-05-06-clawhub-source-design.md

export interface ClawhubEnv {
  DB: D1Database;
  DEEPSEEK_API_KEY?: string;
  READMES?: R2Bucket;
}

const CONVEX_REST = "https://wry-manatee-359.convex.site/api/v1";
const CONVEX_QUERY = "https://wry-manatee-359.convex.cloud/api/query";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const USER_AGENT = "ai-feeds-scraper/1.0 (+https://ai-feeds.com)";

// Listing scope: top N by stars + top M by updated (dedup union).
const LIST_TOP_BY_STARS = 1000;
const LIST_TOP_BY_UPDATED = 500;
const LIST_PAGE_SIZE = 200; // Convex API max per page

// Phase 2 batch
const ENRICH_BATCH_DEFAULT = 2;
const ENRICH_BATCH_MAX = 10;

// ─── Category keyword derivation (mirrors ClawHub's own client-side logic) ──
const CATEGORY_KEYWORDS: Record<string, string[]> = {
  "mcp-tools": ["mcp", "tool", "server"],
  prompts: ["prompt", "template", "system"],
  workflows: ["workflow", "pipeline", "chain"],
  "dev-tools": ["dev", "debug", "lint", "test", "build"],
  data: ["data", "api", "database", "sql"],
  security: ["security", "audit", "vet", "safety"],
  automation: ["automate", "cron", "schedule", "trigger"],
};

function deriveCategory(displayName: string, summary: string): string {
  const text = (displayName + " " + (summary || "")).toLowerCase();
  for (const [cat, kw] of Object.entries(CATEGORY_KEYWORDS)) {
    if (kw.some((k) => text.includes(k))) return cat;
  }
  return "other";
}

// ─── Convex API clients ─────────────────────────────────────────────────────

// V4 listing (Convex direct query) shape: each entry has {skill, latestVersion, owner, ownerHandle}
// REST V1 ignores numItems (hardcoded 25/page); we use direct Convex for 200/page.
interface ListEntry {
  skill: {
    _id: string;
    slug: string;
    displayName: string;
    summary?: string;
    tags?: { latest?: string };
    stats: {
      comments?: number;
      downloads?: number;
      installsAllTime?: number;
      installsCurrent?: number;
      stars?: number;
      versions?: number;
    };
    createdAt: number;
    updatedAt: number;
    capabilityTags?: string[];
  };
  latestVersion?: {
    version?: string;
    createdAt?: number;
    changelog?: string;
  };
  owner?: {
    handle?: string;
    displayName?: string;
    image?: string;
  };
  ownerHandle?: string;
}

interface ListResponse {
  items: ListEntry[];
  nextCursor?: string | null;
  hasMore?: boolean;
}

async function fetchSkillList(
  sort: "stars" | "updated" | "newest" | "downloads" | "installs" | "name",
  numItems: number,
  cursor?: string,
): Promise<ListResponse> {
  const args: Record<string, unknown> = {
    sort,
    dir: "desc",
    nonSuspiciousOnly: true,
    numItems,
  };
  if (cursor) args.cursor = cursor;

  const res = await fetch(CONVEX_QUERY, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      path: "skills:listPublicPageV4",
      args,
      format: "json",
    }),
  });
  if (!res.ok) {
    throw new Error(`ClawHub list fetch ${sort}: HTTP ${res.status}`);
  }
  const j = (await res.json()) as { status: string; value?: any; errorMessage?: string };
  if (j.status !== "success" || !j.value) {
    throw new Error(`ClawHub list query error: ${j.errorMessage || "unknown"}`);
  }
  return {
    items: (j.value.page || []) as ListEntry[],
    nextCursor: j.value.nextCursor ?? null,
    hasMore: !!j.value.hasMore,
  };
}

interface DetailResponse {
  skill?: {
    slug: string;
    displayName: string;
    summary?: string;
    tags?: { latest?: string };
    stats: any;
    createdAt: number;
    updatedAt: number;
    capabilityTags?: string[];
  };
  latestVersion?: {
    version?: string;
    createdAt?: number;
    changelog?: string;
    license?: string;
  };
  owner?: {
    handle?: string;
    displayName?: string;
    image?: string;
    userId?: string;
  };
  metadata?: any;
  moderation?: any;
}

async function fetchSkillDetail(slug: string): Promise<DetailResponse> {
  const res = await fetch(`${CONVEX_REST}/skills/${encodeURIComponent(slug)}`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
    cf: { cacheTtl: 60 },
  });
  if (!res.ok) throw new Error(`ClawHub detail ${slug}: HTTP ${res.status}`);
  return (await res.json()) as DetailResponse;
}

// Convex direct query gives richer install command data (parsed.clawdis.install)
// + capabilityTags array + llmAnalysis findings — fields the V1 REST omits.
interface ConvexDetailResponse {
  status: string;
  value?: {
    skill?: any;
    latestVersion?: {
      _id?: string;
      version?: string;
      changelog?: string;
      capabilityTags?: string[];
      parsed?: {
        license?: string;
        clawdis?: {
          emoji?: string;
          install?: Array<{
            id?: string;
            kind?: string;
            formula?: string;
            label?: string;
            bins?: string[];
          }>;
        };
      };
      llmAnalysis?: {
        agenticRiskFindings?: Array<{
          categoryId?: string;
          categoryLabel?: string;
          severity?: string;
          confidence?: string;
          evidence?: { explanation?: string; path?: string; snippet?: string };
          recommendation?: string;
          riskBucket?: string;
        }>;
      };
    };
    owner?: any;
  };
  errorMessage?: string;
}

async function fetchSkillDetailRich(slug: string): Promise<ConvexDetailResponse> {
  const res = await fetch(CONVEX_QUERY, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      path: "skills:getBySlug",
      args: { slug },
      format: "json",
    }),
  });
  if (!res.ok) throw new Error(`ClawHub Convex detail ${slug}: HTTP ${res.status}`);
  return (await res.json()) as ConvexDetailResponse;
}

// ─── DeepSeek translation ───────────────────────────────────────────────────

const TRANSLATE_SHORT_PROMPT = `You are translating product copy for a Chinese AI feed product. Translate the input English text to Chinese (zh-CN).

Rules:
- Keep technical terms in English where they are stable industry terms: OAuth, API, MCP, skill, plugin, agent, hook, prompt, workflow, LLM, RAG, etc.
- Preserve product/code names verbatim (e.g., "ClawHub", "Self-Improving Agent", "Claude").
- Output Chinese only, no preamble. No quotes around output.`;

async function translateShort(env: ClawhubEnv, text: string): Promise<string | null> {
  if (!env.DEEPSEEK_API_KEY) return null;
  if (!text || text.trim().length === 0) return null;

  // Heuristic: if text already has > 50% CJK, skip (already Chinese).
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  if (cjk / text.length > 0.5) return text;

  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: TRANSLATE_SHORT_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0.2,
      max_tokens: 800,
    }),
  });
  if (!res.ok) {
    console.error(`[clawhub] DeepSeek translate failed: HTTP ${res.status}`);
    return null;
  }
  const j = (await res.json()) as any;
  const out = j?.choices?.[0]?.message?.content?.trim();
  return out || null;
}

// ─── LLM findings translation ───────────────────────────────────────────────
// llmAnalysis 来自 ClawHub 的 LLM 分析，每条 finding 含 categoryLabel / evidence /
// recommendation 都是英文。drawer 安全审查区段对中文用户更友好需要翻译。
// 用 Promise.all 并行翻译每个 finding 的 4 个文本字段，单 finding ~4-5 DeepSeek 调用，
// 多 finding 跨 finding 并行。translateShort 自带 CJK 检测幂等（已是中文则原样返回）。
async function translateLlmFindings(env: ClawhubEnv, findings: any[]): Promise<any[]> {
  if (!findings || findings.length === 0) return [];
  return Promise.all(findings.map(async (f) => {
    const [categoryLabel, evidenceExplanation, evidenceSnippet, recommendation] = await Promise.all([
      f.categoryLabel ? translateShort(env, f.categoryLabel) : Promise.resolve(f.categoryLabel),
      f.evidence?.explanation ? translateShort(env, f.evidence.explanation) : Promise.resolve(f.evidence?.explanation),
      // snippet 通常是 SKILL.md 引用，含代码可能更适合保留原文（防止翻坏）。先简单 translate；
      // 如果发现质量差，后续可改成保留原文 + 加 zh 字段两份
      f.evidence?.snippet ? translateShort(env, f.evidence.snippet) : Promise.resolve(f.evidence?.snippet),
      f.recommendation ? translateShort(env, f.recommendation) : Promise.resolve(f.recommendation),
    ]);
    return {
      ...f,
      categoryLabel: categoryLabel || f.categoryLabel,
      evidence: f.evidence ? {
        ...f.evidence,
        explanation: evidenceExplanation || f.evidence?.explanation,
        snippet: evidenceSnippet || f.evidence?.snippet,
      } : undefined,
      recommendation: recommendation || f.recommendation,
    };
  }));
}

// ─── Item builder ───────────────────────────────────────────────────────────

interface SkillRow {
  id: string;
  source_id: string;
  title: string;
  summary: string;
  author: string;
  handle: string;
  url: string;
  ownerImage?: string;
  metrics: {
    stars: number;
    downloads: number;
    installsCurrent: number;
    installsAllTime: number;
    comments: number;
    versions: number;
  };
  createdAt: number;
  updatedAt: number;
  latestVersion: string;
  category: string;
}

function rowFromListEntry(it: ListEntry): SkillRow {
  const s = it.skill;
  const o = it.owner || {};
  return {
    id: `clawhub:${s.slug}`,
    source_id: s.slug,
    title: s.displayName,
    summary: s.summary || "",
    author: o.displayName || o.handle || it.ownerHandle || "",
    handle: o.handle || it.ownerHandle || "",
    url: `https://clawhub.ai/skills/${s.slug}`,
    ownerImage: o.image,
    metrics: {
      stars: s.stats.stars || 0,
      downloads: s.stats.downloads || 0,
      installsCurrent: s.stats.installsCurrent || 0,
      installsAllTime: s.stats.installsAllTime || 0,
      comments: s.stats.comments || 0,
      versions: s.stats.versions || 0,
    },
    createdAt: Math.floor(s.createdAt / 1000),
    updatedAt: Math.floor(s.updatedAt / 1000),
    latestVersion: it.latestVersion?.version || "",
    category: deriveCategory(s.displayName, s.summary || ""),
  };
}

// ─── Phase 1: fetchList (8 calls, dedup, upsert) ────────────────────────────

export async function runClawhubFetchList(env: ClawhubEnv): Promise<{
  total_unique: number;
  inserted: number;
  updated: number;
  skipped: number;
  errors: string[];
}> {
  const counts = { total_unique: 0, inserted: 0, updated: 0, skipped: 0, errors: [] as string[] };

  // Fetch top 1000 by stars (5 pages × 200) + top 500 by updated (3 pages × 200)
  const allBySort = new Map<string, ListEntry>();

  async function fetchPaged(sort: "stars" | "updated", target: number) {
    let cursor: string | undefined;
    let got = 0;
    while (got < target) {
      const want = Math.min(LIST_PAGE_SIZE, target - got);
      let resp: ListResponse;
      try {
        resp = await fetchSkillList(sort, want, cursor);
      } catch (e: any) {
        counts.errors.push(`list ${sort}: ${e?.message || e}`);
        break;
      }
      for (const it of resp.items || []) {
        if (!allBySort.has(it.skill.slug)) allBySort.set(it.skill.slug, it);
        got++;
      }
      if (!resp.nextCursor || !resp.hasMore) break;
      cursor = resp.nextCursor;
    }
  }

  await fetchPaged("stars", LIST_TOP_BY_STARS);
  await fetchPaged("updated", LIST_TOP_BY_UPDATED);

  counts.total_unique = allBySort.size;

  // Build batch upsert + metrics_snapshot append.
  const nowIso = new Date().toISOString();
  const nowSec = Math.floor(Date.now() / 1000);
  const stmts: D1PreparedStatement[] = [];

  for (const it of allBySort.values()) {
    const row = rowFromListEntry(it);
    const extra = {
      ch_pending: true, // phase 2 will enrich license/install/capability
      slug: row.source_id,
      latest_version: row.latestVersion,
      versions_count: row.metrics.versions,
      updated_at: it.skill.updatedAt,
      category: row.category,
      owner_image: row.ownerImage,
      owner_github_url: row.handle ? `https://github.com/${row.handle}` : undefined,
    };

    // published_at = skill.updatedAt（ISO）：让 /api/items 的 7-day window
     // 过滤起作用，最近更新的 skill 才进 feed；同时也用于默认 ORDER BY
     // published_at DESC（dashboard 默认时间排序时显示最新更新）。
     const publishedAtIso = it.skill.updatedAt
       ? new Date(it.skill.updatedAt).toISOString()
       : nowIso;
    stmts.push(
      env.DB.prepare(
        `INSERT INTO items (id, source_type, source_id, title, content, author, handle, url,
                            metrics, published_at, scraped_at, is_relevant, lang, extra)
         VALUES (?, 'clawhub', ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'en', ?)
         ON CONFLICT(id) DO UPDATE SET
           title = excluded.title,
           content = CASE WHEN excluded.content IS NOT NULL AND length(excluded.content) > 0
                          THEN excluded.content ELSE items.content END,
           author = CASE WHEN excluded.author IS NOT NULL AND length(excluded.author) > 0
                          THEN excluded.author ELSE items.author END,
           handle = CASE WHEN excluded.handle IS NOT NULL AND length(excluded.handle) > 0
                          THEN excluded.handle ELSE items.handle END,
           url = CASE WHEN excluded.url IS NOT NULL AND length(excluded.url) > 0
                          THEN excluded.url ELSE items.url END,
           metrics = excluded.metrics,
           published_at = excluded.published_at,
           scraped_at = excluded.scraped_at,
           extra = json_patch(items.extra, excluded.extra)`,
      ).bind(
        row.id,
        row.source_id,
        row.title,
        row.summary,
        row.author,
        row.handle,
        row.url,
        JSON.stringify(row.metrics),
        publishedAtIso,
        nowIso,
        JSON.stringify(extra),
      ),
    );

    stmts.push(
      env.DB.prepare(
        `INSERT INTO metrics_snapshots_clawhub
           (item_id, captured_at, stars, downloads, installs_current, installs_all_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        row.id,
        nowSec,
        row.metrics.stars,
        row.metrics.downloads,
        row.metrics.installsCurrent,
        row.metrics.installsAllTime,
      ),
    );
  }

  // D1 batch limit ~50 stmts per call. Chunk if needed.
  const CHUNK = 50;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    const slice = stmts.slice(i, i + CHUNK);
    try {
      const results = await env.DB.batch(slice);
      for (const r of results) {
        if (r.meta?.changes && r.meta.changes > 0) counts.inserted++;
      }
    } catch (e: any) {
      counts.errors.push(`batch ${i / CHUNK}: ${e?.message || e}`);
    }
  }

  return counts;
}

// ─── Phase 2: enrichPending (1-2 per cron tick) ─────────────────────────────

export async function runClawhubEnrichPending(
  env: ClawhubEnv,
  limit = ENRICH_BATCH_DEFAULT,
): Promise<{ processed: number; failed: number; errors: string[] }> {
  const counts = { processed: 0, failed: 0, errors: [] as string[] };
  const cap = Math.min(Math.max(1, limit), ENRICH_BATCH_MAX);

  // 按 stars desc 优先 enrich — 热门 skill 先进入 feed，避免初次接入 staging
  // 验收时看到的都是 long tail 还没翻译的条目。
  const pending = await env.DB.prepare(
    `SELECT id, source_id, title, content, lang, extra
       FROM items
      WHERE source_type='clawhub'
        AND deleted_at IS NULL
        AND json_extract(extra, '$.ch_pending') = 1
      ORDER BY CAST(json_extract(metrics, '$.stars') AS INTEGER) DESC
      LIMIT ?`,
  ).bind(cap).all();

  if (!pending.results || pending.results.length === 0) {
    return counts;
  }

  // 并行处理 batch（fetch detail + translate 都是独立 API 调用）
  // 顺序版每条 3-6s × 10 = 30-60s/round；并行后 ~5-6s/round（瓶颈是单条最长）
  await Promise.all((pending.results as any[]).map(async (row) => {
    const slug = row.source_id as string;
    try {
      const richResp = await fetchSkillDetailRich(slug);
      const rich = richResp.value;
      if (!rich || !rich.skill) {
        await env.DB.prepare(
          `UPDATE items SET extra = json_set(extra, '$.ch_pending', json('false'))
            WHERE id = ?`,
        ).bind(row.id).run();
        counts.failed++;
        return;
      }

      const lv = rich.latestVersion || {};
      const license = lv.parsed?.license || "";
      const installList = lv.parsed?.clawdis?.install || [];
      const capabilityTags = lv.capabilityTags || rich.skill.capabilityTags || [];
      const llmFindings = lv.llmAnalysis?.agenticRiskFindings || [];

      const existingExtra = JSON.parse(row.extra || "{}");
      const summaryText = (row.content || "") as string;
      // summary + LLM finding 翻译并行启动
      const [summaryT, translatedFindings] = await Promise.all([
        existingExtra.summary_translated || !summaryText
          ? Promise.resolve(existingExtra.summary_translated)
          : translateShort(env, summaryText),
        translateLlmFindings(env, llmFindings),
      ]);
      const summaryTranslated = summaryT;

      const newExtra = {
        ...existingExtra,
        ch_pending: false,
        license,
        install: installList,
        capability_tags: capabilityTags,
        llm_analysis: translatedFindings.length > 0 ? { findings: translatedFindings, lang: 'zh' } : undefined,
        summary_translated: summaryTranslated || existingExtra.summary_translated,
        enriched_at: Math.floor(Date.now() / 1000),
      };

      await env.DB.prepare(
        `UPDATE items
            SET content_translated = COALESCE(?, content_translated),
                lang = ?,
                extra = ?,
                translation_attempts = COALESCE(translation_attempts, 0) + 1
          WHERE id = ?`,
      ).bind(
        summaryTranslated || null,
        existingExtra.lang === "zh" ? "zh" : "en",
        JSON.stringify(newExtra),
        row.id,
      ).run();

      counts.processed++;
    } catch (e: any) {
      counts.errors.push(`${slug}: ${e?.message || e}`);
      counts.failed++;
    }
  }));

  return counts;
}

// ─── Lazy refresh on drawer open (POST /api/items/:id/refresh) ──────────────

export async function refreshClawhubItem(
  env: ClawhubEnv,
  item: { id: string; source_id: string; extra?: string | null },
): Promise<{ refreshed: boolean; reason: string; metrics?: any }> {
  const slug = item.source_id;
  let s: any;
  let r: DetailResponse;

  try {
    r = await fetchSkillDetail(slug);
    if (!r.skill) return { refreshed: false, reason: "not_found" };
    s = r.skill;
  } catch (e: any) {
    return { refreshed: false, reason: `fetch_error: ${e?.message || e}` };
  }

  const newMetrics = {
    stars: s.stats?.stars || 0,
    downloads: s.stats?.downloads || 0,
    installsCurrent: s.stats?.installsCurrent || 0,
    installsAllTime: s.stats?.installsAllTime || 0,
    comments: s.stats?.comments || 0,
    versions: s.stats?.versions || 0,
  };

  // Update items.metrics + extra.versions_count + extra.updated_at
  const existingExtra = JSON.parse(item.extra || "{}");
  const newExtra = {
    ...existingExtra,
    versions_count: newMetrics.versions,
    updated_at: s.updatedAt,
    latest_version: s.tags?.latest || existingExtra.latest_version,
  };

  await env.DB.prepare(
    `UPDATE items SET metrics = ?, extra = ? WHERE id = ?`,
  ).bind(JSON.stringify(newMetrics), JSON.stringify(newExtra), item.id).run();

  // Append metrics snapshot
  await env.DB.prepare(
    `INSERT INTO metrics_snapshots_clawhub
       (item_id, captured_at, stars, downloads, installs_current, installs_all_time)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(
    item.id,
    Math.floor(Date.now() / 1000),
    newMetrics.stars,
    newMetrics.downloads,
    newMetrics.installsCurrent,
    newMetrics.installsAllTime,
  ).run();

  return { refreshed: true, reason: "metrics_refreshed", metrics: newMetrics };
}

// ─── Counters ───────────────────────────────────────────────────────────────

export async function countClawhubPending(env: ClawhubEnv): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT count(*) as n FROM items
      WHERE source_type='clawhub'
        AND deleted_at IS NULL
        AND json_extract(extra, '$.ch_pending') = 1`,
  ).first<{ n: number }>();
  return r?.n || 0;
}
