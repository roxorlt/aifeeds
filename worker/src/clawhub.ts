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
// V1 (2026-05-07)：phase 2 加 ZIP 流水线 — fetch /api/v1/download?slug=... → fflate
// unzip → 抠 README.md/SKILL.md/files manifest → strip frontmatter → DeepSeek
// translate README（保留代码块）→ 写 items.content + content_translated +
// extra.skill_md / files_manifest。inline 图 R2 迁移 v1.5 后置（多数 skill README 无图）。
//
// Design: docs/plans/2026-05-06-clawhub-source-design.md

// fflate dependency removed in v2 — switched from local ZIP unzip to ClawHub's own
// skills:getReadme convex action which returns whichever file (README.md or SKILL.md)
// ClawHub itself renders in the README tab.

export interface ClawhubEnv {
  DB: D1Database;
  DEEPSEEK_API_KEY?: string;
  READMES?: R2Bucket;
}

const CONVEX_REST = "https://wry-manatee-359.convex.site/api/v1";
const CONVEX_QUERY = "https://wry-manatee-359.convex.cloud/api/query";
// 走 CF AI Gateway（slug：aifeeds-deepseek），dashboard 看 token / cost / 缓存命中。
// 回滚直连：改回 "https://api.deepseek.com/v1/chat/completions"。
const DEEPSEEK_URL = "https://gateway.ai.cloudflare.com/v1/0d13b65d05d5d29fe06998141f3b0f9a/aifeeds-deepseek/deepseek/chat/completions";
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
    // 拉全部（含 suspicious），DB 里用 extra.is_suspicious 标记，feed 端按 query
    // param ?include_suspicious 控制是否过滤。默认 hide。
    nonSuspiciousOnly: false,
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
        verdict?: string;       // 'benign' | 'suspicious' | ...
        status?: string;        // 'clean' | 'flagged' | ...
        confidence?: string;
        summary?: string;
      };
      files?: Array<{ path?: string; size?: number }>; // skill ZIP 内文件清单
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

// 已是中文判定 — CJK 占比 > threshold 视为中文。
// - 短文本（summary、findings）默认 0.5，输入纯英文几乎一定不达标
// - 翻译过的 markdown 含代码块/链接/英文标识符，CJK 占比通常 20-30% — 复用判定用 0.2
function isLikelyChinese(text: string | null | undefined, threshold = 0.5): boolean {
  if (!text || text.length === 0) return false;
  const cjk = (text.match(/[一-鿿]/g) || []).length;
  return cjk / text.length > threshold;
}

async function translateShort(env: ClawhubEnv, text: string): Promise<string | null> {
  if (!env.DEEPSEEK_API_KEY) return null;
  if (!text || text.trim().length === 0) return null;

  // 输入已是中文（CJK > 50%）→ 原样返回，不调 DeepSeek
  if (isLikelyChinese(text)) return text;

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

// ─── 抓 ClawHub 渲染的 README tab 内容（v2，用 convex action）─────────────
// 跟 ClawHub 网页本身完全对齐 — 它的 SkillDetailPage 用 R.skills.getReadme({versionId})
// 拿 {path, text}，path 表明 ClawHub 选了哪个文件（README.md 或 SKILL.md），text 是
// 文件原文。我们用 text 当 source 翻译，path 存到 extra 供前端展示「依据 SKILL.md 渲染」
// 之类的说明。
//
// 不再走自己解 ZIP — 文件挑选逻辑（README.md vs SKILL.md）让 ClawHub 自己决定。

const CONVEX_ACTION = "https://wry-manatee-359.convex.cloud/api/action";

interface ExtractedSkill {
  readme: string;          // ClawHub 渲染的 README tab 内容（已 strip frontmatter）
  readmeFile: string;      // ClawHub 选择的文件名（'README.md' | 'SKILL.md'）
  files: Array<{ path: string; size: number }>; // 文件清单（来自 detail.latestVersion.files）
}

async function fetchClawhubReadme(versionId: string): Promise<{ path: string; text: string } | null> {
  const res = await fetch(CONVEX_ACTION, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: JSON.stringify({
      path: "skills:getReadme",
      args: { versionId },
      format: "json",
    }),
    cf: { cacheTtl: 300 },
  });
  if (!res.ok) {
    console.error(`[clawhub] getReadme HTTP ${res.status} for ${versionId}`);
    return null;
  }
  const j = (await res.json()) as any;
  if (j.status !== "success" || !j.value) return null;
  const path = j.value.path as string;
  const text = j.value.text as string;
  if (!path || !text) return null;
  return { path, text };
}

async function fetchAndExtractSkill(versionId: string, lvFiles: Array<any>): Promise<ExtractedSkill | null> {
  const r = await fetchClawhubReadme(versionId);
  if (!r) return null;
  const readme = stripFrontmatter(r.text);
  const files = (lvFiles || []).map((f) => ({
    path: f.path as string,
    size: (f.size as number) || 0,
  }));

  return { readme, readmeFile: r.path, files };
}

function stripFrontmatter(md: string): string {
  // YAML frontmatter: ^---\n...\n---\n
  return md.replace(/^---\n[\s\S]*?\n---\n+/, "");
}

// ─── README 翻译（保留代码块）─────────────────────────────────────────────
const TRANSLATE_MARKDOWN_PROMPT = `你是 markdown 翻译助手。把以下 ClawHub skill 的 README 文档翻译成中文。

【质量门槛】中文译文必须满足：
- 16 岁聪明青少年第一次读就能理解（不用术语堆砌，复杂概念用平实话讲清）。
- 中文母语者认可的中文用语习惯 — 句子节奏、词序、连接词都要符合中文语感，**不要逐字直译保留英文句式**。需要时整句重组。
- 避免翻译腔：能用动词的地方少用"对于 X 来说"/"X 的 Y"/"进行+动词"/"做出+名词"。段首不要无故堆"在……方面"/"关于……"。
- 用动词主导、短句自然的中文节奏（例："运行这个命令" 不写 "执行该命令的运行"）。

【markdown 结构规则】
1. 保留**所有 markdown 结构**（# 标题 / - 列表 / 1. 编号 / [text](url) 链接 / ![alt](url) 图片 / > 引用 / | 表格 | / --- 分隔线 / **粗体** / *斜体* / ~~删除线~~）。
2. **代码块（\`\`\` 包围）和行内代码（\` 包围）**：内容**完全不翻译**，原样保留 — 代码、注释、shell 命令、路径参数都保留英文。
3. **链接 URL** 不翻译，只翻译显示文字（[显示文字](url) 中的 "显示文字"）。
4. **HTML 标签**（<p> <img> <iframe> <video> <details> <summary> <a> <br> 等）保留原样，标签内的文字才翻译。
5. **YAML frontmatter**（开头 \`---\` ... \`---\` 之间）原样保留，不翻译。
6. **表格单元格**：翻译文字，保留代码 / 链接 / 结构。

【术语规则】
7. **技术术语保留英文原文**（OAuth / API / MCP / agent / plugin / hook / prompt / workflow / LLM / RAG / Transformer / fine-tuning / embedding / claw / npm / brew / bash / yaml / json / JSON / README / SKILL.md），需要的时候在英文后用括号补简短中文释义，例如 "Transformer（自注意力架构）"、"RAG（检索增强生成）"。**短语已经常用化的（如 OAuth、API）不补释义**。
8. **品牌名 / 产品名 / 项目名 / GitHub 用户名 @xxx / 文件路径 / URL** 一律保留原文。
9. **代码注释** 不翻译。

【常用译法对照】
- agent → 智能体（不译"代理"）
- token / tokens → token / Token（不译"令牌"，那是 OAuth 用法）
- fine-tune / fine-tuning → 微调
- prompt → 提示词 / prompt（看上下文选）
- fork（动词）→ fork
- PR → PR
- repo → repo / 代码仓库

【输出】
仅输出翻译后的 markdown，不要任何前后缀解释，不要 \`\`\`markdown 代码块包装。`;

async function translateMarkdown(env: ClawhubEnv, md: string): Promise<string | null> {
  if (!env.DEEPSEEK_API_KEY) return null;
  if (!md || md.trim().length === 0) return null;

  // 输入已是中文 → 原样返回，不调 DeepSeek
  if (isLikelyChinese(md)) return md;

  // 长文档单次调用上限：5k chars（v4.2 进一步收紧 — 8k 仍 ~5 items/min ETA 9h）。
  // 抽屉 5k 中文已是 4-5 屏可读内容，超长部分加截断说明。
  const text = md.length > 5000 ? md.slice(0, 5000) + "\n\n... (内容过长，已截断；完整 README 见 https://clawhub.ai)" : md;

  const res = await fetch(DEEPSEEK_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages: [
        { role: "system", content: TRANSLATE_MARKDOWN_PROMPT },
        { role: "user", content: text },
      ],
      temperature: 0.2,
      max_tokens: 8000,
    }),
  });
  if (!res.ok) {
    console.error(`[clawhub] DeepSeek markdown translate failed: HTTP ${res.status}`);
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
      ch_pending: true, // phase 2 will enrich license/install/capability + ZIP/README
      slug: row.source_id,
      latest_version: row.latestVersion,
      versions_count: row.metrics.versions,
      updated_at: it.skill.updatedAt,
      category: row.category,
      owner_image: row.ownerImage,
      owner_github_url: row.handle ? `https://github.com/${row.handle}` : undefined,
      // summary 单独存 — phase 2 ZIP 抓到 README 后会把 items.content 改成 README，
      // 所以 summary 必须独立保留供 feed 卡片正文用（短文，不会过长）
      summary_en: row.summary,
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
           -- content 长度比较：phase 1 传 summary（~200 字符），phase 2 enrich 写 README（~5k 字符）
           -- 用 max-length 策略避免 phase 1 cron 第二轮以 summary 覆盖已抓到的 README
           content = CASE WHEN excluded.content IS NOT NULL
                          AND length(excluded.content) > length(COALESCE(items.content, ''))
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
    `SELECT id, source_id, title, content, content_translated, lang, extra
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
      // ClawHub 自家 LLM 安全审查结论：verdict='benign' + status='clean' 视为安全；
      // 其它（malicious/suspicious/needs_review/flagged 等）当 suspicious 处理。
      const verdict = lv.llmAnalysis?.verdict;
      const status = lv.llmAnalysis?.status;
      const isSuspicious = !!(verdict && verdict !== "benign") || !!(status && status !== "clean");

      const existingExtra = JSON.parse(row.extra || "{}");
      // 现在 row.content 在 v1 写入策略下是 README 原文（如果之前 v0 fill 过的话是 summary，
      // 兼容到位）。summary 单独读 extra.summary_en 优先，回退 row.content（v0 旧数据）
      const summaryEnglish = (existingExtra.summary_en as string) || (row.content || "") as string;

      // 已译态判定：cost-saving — 已是中文的不再调 DeepSeek。
      // 想用新提示词强制重译：先在 SQL 把对应字段清掉再 enrich。
      const existingSummaryZh = existingExtra.summary_translated as string | undefined;
      const summaryAlreadyZh = isLikelyChinese(existingSummaryZh);
      const existingContentZh = (row.content_translated as string | null) || "";
      const existingFindingsZh =
        existingExtra.llm_analysis?.lang === "zh" &&
        Array.isArray(existingExtra.llm_analysis?.findings) &&
        existingExtra.llm_analysis.findings.length > 0;

      // 三件并行：summary 翻译 + LLM finding 翻译 + ClawHub 渲染的 README 抓取
      const versionId = lv._id as string;
      const [summaryT, translatedFindings, extracted] = await Promise.all([
        summaryAlreadyZh || !summaryEnglish
          ? Promise.resolve(existingSummaryZh)
          : translateShort(env, summaryEnglish),
        existingFindingsZh
          ? Promise.resolve(existingExtra.llm_analysis.findings as any[])
          : translateLlmFindings(env, llmFindings),
        versionId ? fetchAndExtractSkill(versionId, lv.files || []) : Promise.resolve(null),
      ]);
      const summaryTranslated = summaryT;

      // README 翻译 — extracted.readme 是 ClawHub 自己挑出来的内容（README.md or SKILL.md）
      let readmeOriginal = "";
      let readmeTranslated: string | null = null;
      let readmeFile = "";
      let filesManifest: Array<{ path: string; size: number }> = [];
      if (extracted) {
        readmeOriginal = extracted.readme;
        readmeFile = extracted.readmeFile;
        filesManifest = extracted.files;
        if (readmeOriginal) {
          // 已有合格中文译文（CJK > 20% + 长度 ≥ 500 排除短 summary 占位）→ 复用，跳过 DeepSeek。
          // 500 阈值参考：summary 中文译文一般 100-200 字，新真 README/SKILL.md 译文一般 1k+。
          // 0.2 阈值参考：含代码块的中文 README 译文 CJK 占比通常 20-30%，0.5 太严会误判。
          const reuseExistingTranslation =
            existingContentZh.length >= 500 && isLikelyChinese(existingContentZh, 0.2);
          if (reuseExistingTranslation) {
            readmeTranslated = existingContentZh;
          } else {
            readmeTranslated = await translateMarkdown(env, readmeOriginal);
          }
        }
      }

      const newExtra = {
        ...existingExtra,
        ch_pending: false,
        license,
        install: installList,
        capability_tags: capabilityTags,
        is_suspicious: isSuspicious,
        llm_verdict: verdict || undefined,
        llm_status: status || undefined,
        llm_analysis: translatedFindings.length > 0 ? { findings: translatedFindings, lang: 'zh' } : undefined,
        // summary 单独存 — feed 卡片正文用（短）；drawer body 用 content_translated（ClawHub 渲染的 README/SKILL.md 译文）
        summary_en: summaryEnglish || existingExtra.summary_en,
        summary_translated: summaryTranslated || existingExtra.summary_translated,
        // ClawHub README tab 产出（可能是 README.md 或 SKILL.md，由 ClawHub 自己挑）
        readme_file: readmeFile || existingExtra.readme_file || "",
        files_manifest: filesManifest.length > 0 ? filesManifest : existingExtra.files_manifest,
        enriched_at: Math.floor(Date.now() / 1000),
      };
      // skill_md 字段已废弃（ZIP 流程已退役），清掉避免占空间
      delete (newExtra as any).skill_md;

      // items.content / content_translated 写入策略：
      // - 抓到 README → content = README 原文，content_translated = README 中文译文
      // - 抓不到 ZIP / 没 README → 回退 summary（v0 行为）
      const finalContent = readmeOriginal || summaryEnglish;
      const finalContentTranslated = readmeTranslated || summaryTranslated;

      await env.DB.prepare(
        `UPDATE items
            SET content = COALESCE(?, content),
                content_translated = COALESCE(?, content_translated),
                lang = ?,
                extra = ?,
                translation_attempts = COALESCE(translation_attempts, 0) + 1
          WHERE id = ?`,
      ).bind(
        finalContent || null,
        finalContentTranslated || null,
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
