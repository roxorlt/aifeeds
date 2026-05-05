// GitHub trending AI scraper running entirely on CF Worker.
// Replaces the local MacBook launchd cron + scrapers/github/ Python pipeline.
//
// Two phases (separate scheduled invocations to stay under CF Free's
// 50-subrequest budget):
//   Phase 1 — runGithubFetchTrending: pull the trending HTML, parse, write
//   stub rows to items (is_relevant=NULL, extra.gh_pending=true). Cheap:
//   1 fetch + 1 D1 batch = 2 subrequests. Triggered at BJT 01:00 + 13:00
//   (UTC 17:00 + 05:00).
//
//   Phase 2 — runGithubEnrichPending: picks 1 pending row, calls GitHub
//   API (license/watchers/PRs/contributors) + raw README + DeepSeek LLM,
//   writes back. ~9 subrequests/invocation. Runs on any *5/min slot when
//   there's pending work. Recomputes daily_rank at the end if no more
//   pending today.

export interface GithubEnv {
  DB: D1Database;
  GITHUB_TOKEN?: string;
  DEEPSEEK_API_KEY?: string;
  // R2 bucket for migrated README assets (v2.3). Optional; missing binding
  // means R2 migration is skipped and original GitHub raw URLs stay in the
  // readme markdown.
  READMES?: R2Bucket;
}

const TRENDING_URL = "https://github.com/trending?since=daily";
const GITHUB_API = "https://api.github.com";
const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
const USER_AGENT = "ai-feeds-scraper/1.0 (+https://ai-feeds.com)";
const MAX_README_CHARS = 800_000;

// ─── Helpers ───────────────────────────────────────────────────

function ghHeaders(env: GithubEnv): HeadersInit {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

function bjtDateStr(unixSec: number = Math.floor(Date.now() / 1000)): string {
  // BJT = UTC+8
  const dt = new Date((unixSec + 8 * 3600) * 1000);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const d = String(dt.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// ─── Trending HTML parsing ─────────────────────────────────────

export interface TrendingRepo {
  owner: string;
  repo: string;
  ownerRepo: string;
  url: string;
  description: string | null;
  language: string | null;
  totalStars: number | null;
  todayStars: number | null;
  forks: number | null;
  sponsor: 0 | 1;
  contributorsInline: { login: string; avatar_url: string }[];
}

function toIntOrNull(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s.replace(/,/g, ""), 10);
  return Number.isFinite(n) ? n : null;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function parseTrendingHtml(html: string): TrendingRepo[] {
  const out: TrendingRepo[] = [];
  // Each repo is an <article class="Box-row">...</article>. Regex split.
  const articleRe = /<article\b[^>]*class="[^"]*\bBox-row\b[^"]*"[^>]*>([\s\S]*?)<\/article>/g;
  let m: RegExpExecArray | null;
  while ((m = articleRe.exec(html)) !== null) {
    const block = m[1];

    // Title link: <h2 ...><a href="/owner/repo" ...>
    const titleHref = block.match(/<h2\b[\s\S]*?<a\s[^>]*href="\/([^"\/]+)\/([^"\/]+)"/);
    if (!titleHref) continue;
    const owner = decodeEntities(titleHref[1]);
    const repo = decodeEntities(titleHref[2]);

    // Description
    const descMatch = block.match(/<p\b[^>]*class="[^"]*\bcol-9\b[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    const description = descMatch ? decodeEntities(stripTags(descMatch[1])) : null;

    // Language
    const langMatch = block.match(/<span\b[^>]*itemprop="programmingLanguage"[^>]*>([\s\S]*?)<\/span>/);
    const language = langMatch ? decodeEntities(stripTags(langMatch[1])) : null;

    // Stars + forks come from <a class="Link--muted" href="/owner/repo/{stargazers,forks}">123,456</a>
    const linkMutedRe = /<a\s[^>]*class="[^"]*\bLink--muted\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let totalStars: number | null = null;
    let forks: number | null = null;
    let lm: RegExpExecArray | null;
    while ((lm = linkMutedRe.exec(block)) !== null) {
      const href = lm[1];
      const num = toIntOrNull(stripTags(lm[2]));
      if (href.includes("/stargazers")) totalStars = num;
      else if (href.includes("/forks")) forks = num;
    }

    // Today stars: <span class="float-sm-right">2,115 stars today</span>
    const todayMatch = block.match(/<span\b[^>]*class="[^"]*\bfloat-sm-right\b[^"]*"[^>]*>([\s\S]*?)<\/span>/);
    let todayStars: number | null = null;
    if (todayMatch) {
      const text = stripTags(todayMatch[1]);
      const numMatch = text.match(/([\d,]+)\s+stars?\s+today/i);
      if (numMatch) todayStars = toIntOrNull(numMatch[1]);
    }

    // Sponsor: presence of <a href="/sponsors/...">
    const sponsor = /href="\/sponsors\//.test(block) ? 1 : 0;

    // Contributors inline: img.avatar inside a[data-hovercard-type=user]
    const contribRe = /<a\s[^>]*data-hovercard-type="user"[\s\S]*?<img\s[^>]*alt="@([^"]+)"[^>]*src="([^"]+)"/g;
    const contributorsInline: { login: string; avatar_url: string }[] = [];
    let cm: RegExpExecArray | null;
    while ((cm = contribRe.exec(block)) !== null) {
      contributorsInline.push({
        login: decodeEntities(cm[1]),
        avatar_url: decodeEntities(cm[2]),
      });
    }

    out.push({
      owner,
      repo,
      ownerRepo: `${owner}/${repo}`,
      url: `https://github.com/${owner}/${repo}`,
      description,
      language,
      totalStars,
      todayStars,
      forks,
      sponsor: sponsor as 0 | 1,
      contributorsInline,
    });
  }
  return out;
}

// ─── Phase 1: fetch trending → write stubs ─────────────────────

export async function runGithubFetchTrending(env: GithubEnv): Promise<{
  parsed: number;
  inserted: number;
  updated_seen: number;
  errors: number;
}> {
  const counts = { parsed: 0, inserted: 0, updated_seen: 0, errors: 0 };

  let html: string;
  try {
    const r = await fetch(TRENDING_URL, { headers: { "User-Agent": USER_AGENT } });
    if (!r.ok) {
      console.error(`[github-fetch] trending HTTP ${r.status}`);
      counts.errors++;
      return counts;
    }
    html = await r.text();
  } catch (e) {
    console.error("[github-fetch] trending fetch error:", e);
    counts.errors++;
    return counts;
  }

  const repos = parseTrendingHtml(html);
  counts.parsed = repos.length;
  if (repos.length === 0) return counts;

  const nowIso = new Date().toISOString();
  const today = bjtDateStr();
  const stmts: D1PreparedStatement[] = [];

  for (const r of repos) {
    const id = `github:${r.ownerRepo}`;
    // extra.gh_pending=true means phase 2 still owes API + README + LLM
    const extra = {
      gh_pending: true,
      sponsor: r.sponsor,
      contributors_inline: r.contributorsInline,
      trending_date_str: today,
      first_trending_at: Math.floor(Date.now() / 1000),
      last_seen_on_trending_at: Math.floor(Date.now() / 1000),
    };
    const metrics = {
      stars: r.totalStars,
      today_stars: r.todayStars,
      forks: r.forks,
    };
    // INSERT-or-bump-last_seen pattern. Existing rows just update
    // extra.last_seen_on_trending_at; new rows get full stub.
    stmts.push(
      env.DB.prepare(
        `INSERT INTO items (id, source_type, source_id, title, content, author, url,
                            metrics, scraped_at, is_relevant, extra)
         VALUES (?, 'github', ?, ?, ?, ?, ?, ?, ?, NULL, ?)
         ON CONFLICT(id) DO UPDATE SET
           extra = json_set(items.extra, '$.last_seen_on_trending_at', ?)`,
      ).bind(
        id,
        r.ownerRepo,
        r.ownerRepo,
        r.description,
        r.owner,
        r.url,
        JSON.stringify(metrics),
        nowIso,
        JSON.stringify(extra),
        Math.floor(Date.now() / 1000),
      ),
    );
    // Append a metrics_snapshots_gh row for today's snapshot
    stmts.push(
      env.DB.prepare(
        `INSERT INTO metrics_snapshots_gh
           (item_id, captured_at, trending_date_str, total_stars, today_stars, forks)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        Math.floor(Date.now() / 1000),
        today,
        r.totalStars,
        r.todayStars,
        r.forks,
      ),
    );
  }

  try {
    const results = await env.DB.batch(stmts);
    for (const res of results) {
      if (res.meta?.changes && res.meta.changes > 0) counts.inserted++;
    }
  } catch (e) {
    console.error("[github-fetch] D1 batch error:", e);
    counts.errors++;
  }

  console.log(`[github-fetch] ${JSON.stringify(counts)}`);
  return counts;
}

// ─── Phase 2: enrich one pending item ──────────────────────────

const SYSTEM_PROMPT = `你是 AI 信息聚合看板的内容审核员。任务：判断 GitHub 项目是否"AI 相关"，并给中文用户写一段简短解读。

【判别标准】is_ai=1：
- LLM/agent 框架与应用（langchain, autogpt, crewai）
- ML/DL 模型权重、训练/推理实现（llama.cpp, sglang）
- AI 开发工具（cursor, aider, continue 类 IDE 插件 / CLI）
- AI 基础设施（向量库、RAG、推理引擎、eval 框架、模型部署）
- 终端用户 AI 应用（comfyui, openwebui, automatic1111）
- AI 教程 / awesome list / prompt 集合
- AI 论文实现 / 复现仓库

is_ai=0：
- 通用 web 框架、数据库、操作系统
- DevOps / 监控 / 容器编排（除非专为 ML 训练/推理）
- 区块链 / 加密货币
- 纯算法/数据结构库（除非专为 ML）
- 通用编辑器、设计工具
边界模糊时按"项目主要价值是否依赖 AI/ML"判：是→1，不是→0。

【分类】ai_category（is_ai=1 时必填，选一个最主要的）：
- agent: LLM agent 框架 / 构建好的 agent 产品
- model: 模型权重、训练/推理代码实现
- tool: 给开发者的 SDK / 库 / CLI（langchain, llamaindex, aider）
- infra: 部署/服务/基础设施（vllm, triton, ray serve, 向量库）
- app: 给终端用户的开箱即用产品（有完整 UI）
- tutorial: 教程、awesome list、课程、prompt 集合
- other: AI 相关但不属于上述

【解读】ai_summary（is_ai=1 时必填，80-150 中文字）：
- 第一句：项目做什么（不要抄 description 原话）。第一句必须以动词或名词短语直接开头，不要以"项目名 + 是一个 X"或"项目名 + 是 X"开头。
  反例：「TradingAgents 是一个多智能体金融交易框架...」（错）
  正例：「多智能体金融交易框架，把分析师/研究员/交易员拆成专门 agent 协作...」（对）
  正例：「通过 LangGraph 编排多个 LLM Agent 模拟交易团队协作的金融决策框架...」（对）
- 第二句：为什么值得看（亮点 / 跟同类的差异 / 当前热度的原因）
- 如果 README 有 disclaimer / license 限制 / "research-only" 等声明，必须在 summary 末尾保留一句（如"研究向，非投资/医疗建议"）
- 中国 AI 从业者口吻，专有名词保留英文
- 禁用营销腔（"必看"/"重磅"/"最强"）

【输出】严格 JSON：
{"is_ai": 0或1, "ai_category": "agent"|"model"|"tool"|"infra"|"app"|"tutorial"|"other"|null, "ai_summary": "..."}
is_ai=0 时 ai_category=null, ai_summary=""。`;

interface LlmResult {
  is_ai: 0 | 1 | null;
  ai_category: string | null;
  ai_summary: string;
  llm_raw_response: string | null;
}

async function callLlm(env: GithubEnv, repo: TrendingRepo & { readme: string }): Promise<LlmResult> {
  if (!env.DEEPSEEK_API_KEY) {
    return { is_ai: null, ai_category: null, ai_summary: "", llm_raw_response: null };
  }
  let readme = repo.readme || "";
  if (readme.length > MAX_README_CHARS) {
    readme = readme.slice(0, MAX_README_CHARS) + "\n\n[... README 已截断 ...]";
  }
  const userPrompt =
    `项目: ${repo.ownerRepo}\n` +
    `GitHub Description: ${repo.description || "无"}\n` +
    `主语言: ${repo.language || "未知"}\n` +
    `总 stars: ${repo.totalStars ?? "unknown"}（今日新增 ${repo.todayStars ?? "unknown"}）\n\n` +
    `README（截断到前 ${MAX_README_CHARS} 字符）:\n---\n${readme}\n---`;

  try {
    const r = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 600,
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) {
      console.error(`[github-llm] HTTP ${r.status}`);
      return { is_ai: null, ai_category: null, ai_summary: "", llm_raw_response: null };
    }
    const data = await r.json<{ choices?: { message?: { content?: string } }[] }>();
    const raw = data.choices?.[0]?.message?.content?.trim() ?? "";
    const parsed = JSON.parse(raw) as { is_ai?: 0 | 1; ai_category?: string | null; ai_summary?: string };
    if (parsed.is_ai !== 0 && parsed.is_ai !== 1) {
      console.warn(`[github-llm] invalid is_ai for ${repo.ownerRepo}:`, parsed.is_ai);
      return { is_ai: null, ai_category: null, ai_summary: "", llm_raw_response: raw };
    }
    return {
      is_ai: parsed.is_ai,
      ai_category: parsed.is_ai === 1 ? (parsed.ai_category ?? null) : null,
      ai_summary: parsed.is_ai === 1 ? (parsed.ai_summary ?? "") : "",
      llm_raw_response: raw,
    };
  } catch (e) {
    console.error(`[github-llm] error for ${repo.ownerRepo}:`, e);
    return { is_ai: null, ai_category: null, ai_summary: "", llm_raw_response: null };
  }
}

async function fetchRepoMeta(
  env: GithubEnv,
  owner: string,
  repo: string,
): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers: ghHeaders(env) });
    if (!r.ok) return null;
    return await r.json<Record<string, unknown>>();
  } catch {
    return null;
  }
}

async function fetchOpenPrs(env: GithubEnv, owner: string, repo: string): Promise<number | null> {
  try {
    const url =
      `${GITHUB_API}/search/issues?q=` +
      encodeURIComponent(`repo:${owner}/${repo} is:pr is:open`) +
      `&per_page=1`;
    const r = await fetch(url, { headers: ghHeaders(env) });
    if (!r.ok) return null;
    const data = await r.json<{ total_count?: number }>();
    return data.total_count ?? null;
  } catch {
    return null;
  }
}

async function fetchContributorsCount(env: GithubEnv, owner: string, repo: string): Promise<number | null> {
  try {
    const r = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/contributors?per_page=1&anon=true`,
      { headers: ghHeaders(env) },
    );
    if (!r.ok) return null;
    const link = r.headers.get("Link") || "";
    const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (m) return parseInt(m[1], 10);
    const body = await r.json<unknown[]>().catch(() => null);
    return Array.isArray(body) ? body.length : null;
  } catch {
    return null;
  }
}

async function fetchReadme(
  owner: string,
  repo: string,
  defaultBranch: string | null,
): Promise<{ content: string; branch: string | null }> {
  const branches = [defaultBranch, "main", "master"].filter(Boolean) as string[];
  // De-dupe while preserving order
  const seen = new Set<string>();
  const uniq = branches.filter((b) => (seen.has(b) ? false : (seen.add(b), true)));
  for (const branch of uniq) {
    for (const fname of ["README.md", "readme.md", "README", "Readme.md"]) {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${fname}`;
      try {
        const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
        if (r.ok) {
          const text = await r.text();
          if (text.trim()) return { content: text, branch };
        }
      } catch {
        // try next
      }
    }
  }
  return { content: "", branch: null };
}

function detectReadmeLang(readme: string): "zh" | "en" | "other" {
  if (!readme) return "other";
  const sample = readme.slice(0, 4000);
  let cjk = 0;
  let letters = 0;
  let ascii = 0;
  for (const ch of sample) {
    if (ch >= "一" && ch <= "鿿") cjk++;
    if (/[A-Za-z一-鿿]/.test(ch)) letters++;
    if (/[A-Za-z]/.test(ch)) ascii++;
  }
  if (letters < 50) return "other";
  if (cjk / Math.max(letters, 1) >= 0.3) return "zh";
  if (ascii / Math.max(letters, 1) >= 0.8) return "en";
  return "other";
}

export async function runGithubEnrichPending(
  env: GithubEnv,
  limit = 1,
): Promise<{ picked: number; ok: number; failed: number; ranked: number }> {
  const counts = { picked: 0, ok: 0, failed: 0, ranked: 0 };

  const rows = await env.DB.prepare(
    `SELECT id, source_id, title, content, author, url, metrics, extra
       FROM items
      WHERE source_type='github'
        AND COALESCE(json_extract(extra, '$.gh_pending'), 0) IN (1, 'true')
      ORDER BY scraped_at ASC
      LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      source_id: string;
      title: string | null;
      content: string | null;
      author: string | null;
      url: string | null;
      metrics: string | null;
      extra: string | null;
    }>();

  counts.picked = rows.results.length;
  if (counts.picked === 0) return counts;

  for (const row of rows.results) {
    const [owner, repoName] = (row.source_id || "").split("/");
    if (!owner || !repoName) {
      counts.failed++;
      continue;
    }
    const metrics = row.metrics ? JSON.parse(row.metrics) : {};
    const extra = row.extra ? JSON.parse(row.extra) : {};
    const trending: TrendingRepo & { readme: string } = {
      owner,
      repo: repoName,
      ownerRepo: row.source_id,
      url: row.url || `https://github.com/${row.source_id}`,
      description: row.content,
      language: extra.language ?? null,
      totalStars: metrics.stars ?? null,
      todayStars: metrics.today_stars ?? null,
      forks: metrics.forks ?? null,
      sponsor: extra.sponsor ?? 0,
      contributorsInline: extra.contributors_inline || [],
      readme: "",
    };

    try {
      // 1. /repos/:owner/:repo for license/watchers/default_branch/open_issues
      const meta = await fetchRepoMeta(env, owner, repoName);
      const license = (meta?.license as { spdx_id?: string } | null)?.spdx_id ?? null;
      const defaultBranch = (meta?.default_branch as string | undefined) ?? null;
      const watchers = (meta?.subscribers_count as number | undefined) ?? null;
      const openIssues = (meta?.open_issues_count as number | undefined) ?? null;

      // 2. open PRs (search API)
      const openPrs = await fetchOpenPrs(env, owner, repoName);

      // 3. contributors count via Link header
      const contributorsCount = await fetchContributorsCount(env, owner, repoName);

      // 4. README
      const { content: readme, branch: branchUsed } = await fetchReadme(owner, repoName, defaultBranch);
      trending.readme = readme;
      trending.language = trending.language ?? (meta?.language as string | undefined) ?? null;

      // 5. LLM judge
      const llm = await callLlm(env, trending);

      // Merge metrics + extra and write back
      const newMetrics = {
        ...metrics,
        watchers: metrics.watchers ?? watchers,
        open_issues: openIssues,
        open_prs: openPrs,
        license_spdx: license,
      };
      const newExtra = {
        ...extra,
        gh_pending: false,
        ai_category: llm.ai_category,
        ai_summary: llm.ai_summary,
        llm_model: DEEPSEEK_MODEL,
        llm_called_at: Math.floor(Date.now() / 1000),
        readme_excerpt: readme,
        readme_lang: detectReadmeLang(readme),
        default_branch: defaultBranch || branchUsed || extra.default_branch || "main",
        license_spdx: license,
        contributors_count: contributorsCount,
        language: trending.language,
      };

      await env.DB.prepare(
        `UPDATE items
            SET is_relevant = ?,
                metrics = ?,
                extra = ?,
                lang = ?
          WHERE id = ?`,
      )
        .bind(
          llm.is_ai,
          JSON.stringify(newMetrics),
          JSON.stringify(newExtra),
          newExtra.readme_lang,
          row.id,
        )
        .run();

      counts.ok++;
      console.log(
        `[github-enrich] ${row.source_id}: is_ai=${llm.is_ai} cat=${llm.ai_category} watchers=${watchers} prs=${openPrs}`,
      );
    } catch (e) {
      console.error(`[github-enrich] ${row.source_id}: error`, e);
      counts.failed++;
    }
  }

  // After enrichment, recompute today's daily_rank for AI non-sponsor items.
  const today = bjtDateStr();
  const rankRows = await env.DB.prepare(
    `SELECT id FROM items
      WHERE source_type='github'
        AND is_relevant=1
        AND COALESCE(CAST(json_extract(extra, '$.sponsor') AS INTEGER), 0) = 0
        AND deleted_at IS NULL
        AND json_extract(extra, '$.trending_date_str') = ?
      ORDER BY CAST(json_extract(metrics, '$.today_stars') AS INTEGER) DESC,
               CAST(json_extract(metrics, '$.stars') AS INTEGER) DESC`,
  )
    .bind(today)
    .all<{ id: string }>();

  // Update daily_rank for ranked items, clear for others on the same day.
  const updates: D1PreparedStatement[] = [];
  rankRows.results.forEach((r, idx) => {
    updates.push(
      env.DB.prepare(
        `UPDATE items SET extra = json_set(extra, '$.daily_rank', ?) WHERE id = ?`,
      ).bind(idx + 1, r.id),
    );
  });
  // Clear daily_rank for non-AI / sponsor / hidden today
  updates.push(
    env.DB.prepare(
      `UPDATE items
          SET extra = json_remove(extra, '$.daily_rank')
        WHERE source_type='github'
          AND json_extract(extra, '$.trending_date_str') = ?
          AND (is_relevant != 1 OR COALESCE(CAST(json_extract(extra, '$.sponsor') AS INTEGER), 0) = 1)`,
    ).bind(today),
  );

  if (updates.length > 0) {
    try {
      await env.DB.batch(updates);
      counts.ranked = rankRows.results.length;
    } catch (e) {
      console.error("[github-enrich] daily_rank update error:", e);
    }
  }

  console.log(`[github-enrich] ${JSON.stringify(counts)}`);
  return counts;
}

// ─── On-demand GH refresh（drawer 打开时调） ───────────────────
// PR6.6：与 X syndication 对应，drawer 触发后实时刷一次 GitHub REST API。
// 只补 stars/forks/watchers/open_issues/open_prs/contributors_count；
// today_stars 来自 trending HTML（API 不返），保留旧值；license_spdx 同理。
// 调用方（enrich.refreshSingleItem）已做 KV throttle，这里不重复。

export interface GhRefreshResult {
  ok: boolean;
  metrics: Record<string, number | string | null>;
  contributors_count: number | null;
}

export async function refreshGithubItem(
  env: GithubEnv,
  itemId: string,
  ownerRepo: string,
): Promise<GhRefreshResult | null> {
  const [owner, repo] = (ownerRepo || "").split("/");
  if (!owner || !repo) return null;

  const meta = await fetchRepoMeta(env, owner, repo);
  if (!meta) return null;

  const stars = (meta.stargazers_count as number | undefined) ?? null;
  const forks = (meta.forks_count as number | undefined) ?? null;
  const watchers = (meta.subscribers_count as number | undefined) ?? null;
  const openIssues = (meta.open_issues_count as number | undefined) ?? null;

  // 并行拉 PRs + contributors（独立请求）
  const [openPrs, contributorsCount] = await Promise.all([
    fetchOpenPrs(env, owner, repo),
    fetchContributorsCount(env, owner, repo),
  ]);

  // 读旧 metrics + extra，merge（保 today_stars / license_spdx 等 API 不返字段）
  const row = await env.DB.prepare(
    `SELECT metrics, extra FROM items WHERE id = ?`,
  ).bind(itemId).first<{ metrics: string | null; extra: string | null }>();

  let oldMetrics: Record<string, unknown> = {};
  let oldExtra: Record<string, unknown> = {};
  try { if (row?.metrics) oldMetrics = JSON.parse(row.metrics) || {}; } catch { /* ignore */ }
  try { if (row?.extra) oldExtra = JSON.parse(row.extra) || {}; } catch { /* ignore */ }

  const newMetrics: Record<string, number | string | null> = {
    ...(oldMetrics as Record<string, number | string | null>),
    stars,
    forks,
    watchers,
    open_issues: openIssues,
    open_prs: openPrs,
  };
  const newExtra = {
    ...oldExtra,
    contributors_count: contributorsCount,
  };

  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE items SET metrics = ?, extra = ? WHERE id = ?`,
    ).bind(JSON.stringify(newMetrics), JSON.stringify(newExtra), itemId),
    env.DB.prepare(
      `INSERT INTO metrics_snapshots_gh
         (item_id, captured_at, trending_date_str, total_stars, today_stars, forks, watchers, open_issues, open_prs)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      itemId,
      now,
      bjtDateStr(now),
      stars,
      (oldMetrics.today_stars as number | undefined) ?? null,
      forks,
      watchers,
      openIssues,
      openPrs,
    ),
  ]);

  return { ok: true, metrics: newMetrics, contributors_count: contributorsCount };
}

// Convenience: count remaining pending github items (used by scheduled() to
// decide whether to dispatch enrich vs the X cron rotation).
export async function countGithubPending(env: GithubEnv): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM items
      WHERE source_type='github'
        AND COALESCE(json_extract(extra, '$.gh_pending'), 0) IN (1, 'true')`,
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

// ─── README 中文翻译 (v2.2) ────────────────────────────────────

const README_TRANSLATE_PROMPT = `你是 markdown 翻译助手。把以下 README 文档翻译成中文。规则：

1. 保留**所有 markdown 结构**（# 标题 / - 列表 / [text](url) 链接 / ![alt](url) 图片 / > 引用 / 表格 | / --- 分隔线 等）
2. **代码块（\`\`\` 包围）和行内代码（\` 包围）**：内容**不翻译**，原样保留
3. **链接的 URL** 不翻译，只翻译显示文字（[显示文字](url) 中的 "显示文字"）
4. **HTML 标签**（<p> <img> <iframe> <video> <details> <summary> <a> <br> 等）保留原样，标签内的文字翻译
5. **专业术语保留英文原文**（如 Transformer / RAG / fine-tuning / agent / vector embedding / LLM / inference），需要时在英文后括号补简短中文释义，例如 "Transformer（自注意力架构）"
6. **代码注释** 不翻译
7. **品牌名 / 产品名 / 项目名 / GitHub 用户名**（@xxx）保留原文
8. 翻译后的文字风格：清晰、自然、技术性，避免营销腔

输出 ONLY 翻译后的 markdown 文档，不要任何前后缀解释、不要 \`\`\`markdown 代码块包装。`;

const README_MAX_INPUT_CHARS = 60_000; // ≈ 15-20k tokens, 留 8k output 余量
const TRANSLATE_MAX_TOKENS = 8000;

async function callTranslateLlm(env: GithubEnv, readme: string): Promise<string | null> {
  if (!env.DEEPSEEK_API_KEY) return null;

  let input = readme;
  let truncated = false;
  if (input.length > README_MAX_INPUT_CHARS) {
    input = input.slice(0, README_MAX_INPUT_CHARS) + "\n\n[... 原文已截断 ...]";
    truncated = true;
  }

  try {
    const r = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${env.DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [
          { role: "system", content: README_TRANSLATE_PROMPT },
          { role: "user", content: input },
        ],
        temperature: 0.1, // 翻译略放低 0，避免每次输出不一样
        max_tokens: TRANSLATE_MAX_TOKENS,
      }),
    });
    if (!r.ok) {
      console.error(`[github-readme-translate] HTTP ${r.status}`);
      return null;
    }
    const data = await r.json<{ choices?: { message?: { content?: string } }[] }>();
    let text = data.choices?.[0]?.message?.content?.trim() ?? null;
    if (!text) return null;
    // Strip stray ```markdown / ``` wrapping if model added it despite prompt
    text = text.replace(/^```(?:markdown)?\n?/, "").replace(/\n?```$/, "");
    if (truncated) text += "\n\n_[原 README 过长已截断]_";
    return text;
  } catch (e) {
    console.error("[github-readme-translate] error:", e);
    return null;
  }
}

export async function runGithubReadmeTranslate(
  env: GithubEnv,
  limit = 1,
): Promise<{ picked: number; ok: number; failed: number }> {
  const counts = { picked: 0, ok: 0, failed: 0 };

  // Pick rows with non-zh README and no translation yet, prioritize newest items.
  const rows = await env.DB.prepare(
    `SELECT id, json_extract(extra, '$.readme_excerpt') AS readme,
            json_extract(extra, '$.readme_lang')   AS lang
       FROM items
      WHERE source_type='github'
        AND is_relevant = 1
        AND json_extract(extra, '$.readme_excerpt') IS NOT NULL
        AND json_extract(extra, '$.readme_translated') IS NULL
        AND COALESCE(json_extract(extra, '$.readme_lang'), 'other') != 'zh'
      ORDER BY scraped_at DESC
      LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; readme: string | null; lang: string | null }>();

  counts.picked = rows.results.length;
  if (counts.picked === 0) return counts;

  for (const row of rows.results) {
    if (!row.readme) {
      counts.failed++;
      continue;
    }
    const translated = await callTranslateLlm(env, row.readme);
    if (!translated) {
      counts.failed++;
      console.error(`[github-readme-translate] ${row.id}: empty translation`);
      continue;
    }
    try {
      await env.DB.prepare(
        `UPDATE items
            SET extra = json_set(extra,
                                 '$.readme_translated', ?,
                                 '$.readme_translated_at', ?)
          WHERE id = ?`,
      )
        .bind(translated, Math.floor(Date.now() / 1000), row.id)
        .run();
      counts.ok++;
      console.log(`[github-readme-translate] ${row.id}: ok (${translated.length} chars)`);
    } catch (e) {
      counts.failed++;
      console.error(`[github-readme-translate] ${row.id}: D1 update error`, e);
    }
  }

  console.log(`[github-readme-translate] ${JSON.stringify(counts)}`);
  return counts;
}

// Count rows that need translation (used by scheduled() to decide preempt).
export async function countGithubReadmeTranslatePending(env: GithubEnv): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM items
      WHERE source_type='github'
        AND is_relevant = 1
        AND json_extract(extra, '$.readme_excerpt') IS NOT NULL
        AND json_extract(extra, '$.readme_translated') IS NULL
        AND COALESCE(json_extract(extra, '$.readme_lang'), 'other') != 'zh'`,
  ).first<{ n: number }>();
  return r?.n ?? 0;
}

// ─── README 资源落 CF R2 (v2.3) ────────────────────────────────
// Pipeline: scan readme_excerpt (and readme_translated when present) for
// remote image / video URLs, download (size-capped), upload to R2 under
// gh/<owner>/<repo>/<sha256>.<ext>, then rewrite the original URLs to a
// proxy-served `/r/<key>` form. Marks extra.r2_migrated_at on completion.

const R2_MAX_BYTES = 5 * 1024 * 1024;        // 5 MB hard cap per asset
const R2_MAX_ASSETS_PER_REPO = 20;           // per repo per migrate run — covers most READMEs (8 was too low, missed body images)
const R2_KEY_PREFIX = "gh";                  // bucket-internal layout: gh/<owner>/<repo>/...

const ALLOWED_IMG_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

const EXT_FROM_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/avif": "avif",
  "image/x-icon": "ico",
  "image/vnd.microsoft.icon": "ico",
};

function resolveAssetUrl(src: string, owner: string, repo: string, branch: string): string | null {
  if (!src) return null;
  // Skip data: / mailto: / blob: / anchor — not migratable
  if (/^(data:|mailto:|blob:|#)/i.test(src)) return null;
  // Already-migrated R2 path (from a previous run): skip — don't re-extract
  // and don't try to re-fetch from GitHub raw (that path doesn't exist there).
  if (src.startsWith("/r/")) return null;
  // Already absolute
  if (/^https?:\/\//i.test(src)) return src;
  // Relative — resolve to GitHub raw
  const b = branch || "main";
  if (src.startsWith("/")) return `https://raw.githubusercontent.com/${owner}/${repo}/${b}${src}`;
  return `https://raw.githubusercontent.com/${owner}/${repo}/${b}/${src.replace(/^\.\//, "")}`;
}

interface AssetHit {
  matchedSrc: string;       // exact text in the markdown that we'll replace
  resolvedUrl: string;      // absolute fetchable URL
}

function extractAssetUrls(
  markdown: string,
  owner: string,
  repo: string,
  branch: string,
): AssetHit[] {
  const hits: AssetHit[] = [];
  const seen = new Set<string>();
  // Markdown image: ![alt](url "optional title")
  const mdImgRe = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = mdImgRe.exec(markdown)) !== null) {
    const src = m[1];
    if (seen.has(src)) continue;
    seen.add(src);
    const resolved = resolveAssetUrl(src, owner, repo, branch);
    if (resolved) hits.push({ matchedSrc: src, resolvedUrl: resolved });
  }
  // HTML img: <img src="url" .../>
  const htmlImgRe = /<img\b[^>]*\bsrc=["']([^"']+)["']/gi;
  while ((m = htmlImgRe.exec(markdown)) !== null) {
    const src = m[1];
    if (seen.has(src)) continue;
    seen.add(src);
    const resolved = resolveAssetUrl(src, owner, repo, branch);
    if (resolved) hits.push({ matchedSrc: src, resolvedUrl: resolved });
  }
  return hits;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function extFromUrl(url: string, contentType: string | null): string {
  if (contentType && EXT_FROM_TYPE[contentType.toLowerCase().split(";")[0].trim()]) {
    return EXT_FROM_TYPE[contentType.toLowerCase().split(";")[0].trim()];
  }
  // Fall back to URL extension
  const m = url.match(/\.([a-zA-Z0-9]{2,5})(?:\?|$)/);
  return m ? m[1].toLowerCase() : "bin";
}

async function migrateOneAsset(
  env: GithubEnv,
  owner: string,
  repo: string,
  url: string,
): Promise<string | null> {
  if (!env.READMES) return null;
  try {
    // GET (use streaming to avoid loading full body when too big — but we
    // still need the body to compute sha256 and PUT to R2, so just GET full
    // and check size after)
    const r = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!r.ok) return null;
    const ct = r.headers.get("content-type") || "";
    const lenStr = r.headers.get("content-length");
    const len = lenStr ? parseInt(lenStr, 10) : -1;
    if (len > 0 && len > R2_MAX_BYTES) return null;
    if (ct && !ALLOWED_IMG_TYPES.has(ct.toLowerCase().split(";")[0].trim())) {
      // Not a known image type — skip (videos / arbitrary binaries can be
      // added later; for now we only mirror images)
      return null;
    }
    const buf = await r.arrayBuffer();
    if (buf.byteLength > R2_MAX_BYTES) return null;
    const hash = await sha256Hex(buf);
    const ext = extFromUrl(url, ct);
    const key = `${R2_KEY_PREFIX}/${owner}/${repo}/${hash}.${ext}`;

    // PUT (idempotent — same hash key means same content; OK to overwrite)
    await env.READMES.put(key, buf, {
      httpMetadata: { contentType: ct || "application/octet-stream" },
      customMetadata: { "src-url": url, "owner-repo": `${owner}/${repo}` },
    });

    return `/r/${key}`;
  } catch (e) {
    console.error(`[github-r2-migrate] asset error ${url}:`, e);
    return null;
  }
}

function rewriteUrls(markdown: string, mapping: Map<string, string>): string {
  let out = markdown;
  for (const [src, target] of mapping) {
    // Replace all occurrences. We do raw substring replace since the matched
    // src came from regex extraction earlier (so it's already a literal URL).
    // Escape regex metacharacters before turning into a global RegExp.
    const escaped = src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), target);
  }
  return out;
}

export async function runGithubR2Migrate(
  env: GithubEnv,
  limit = 1,
): Promise<{ picked: number; ok: number; assets_migrated: number; assets_failed: number; failed: number }> {
  const counts = { picked: 0, ok: 0, assets_migrated: 0, assets_failed: 0, failed: 0 };

  if (!env.READMES) {
    console.warn("[github-r2-migrate] R2 binding READMES not configured — skipping");
    return counts;
  }

  const rows = await env.DB.prepare(
    `SELECT id, source_id,
            json_extract(extra, '$.readme_excerpt')   AS readme,
            json_extract(extra, '$.readme_translated') AS translated,
            json_extract(extra, '$.default_branch')   AS branch
       FROM items
      WHERE source_type='github'
        AND is_relevant = 1
        AND json_extract(extra, '$.readme_excerpt') IS NOT NULL
        AND json_extract(extra, '$.r2_migrated_at') IS NULL
      ORDER BY scraped_at DESC
      LIMIT ?`,
  )
    .bind(limit)
    .all<{
      id: string;
      source_id: string;
      readme: string | null;
      translated: string | null;
      branch: string | null;
    }>();

  counts.picked = rows.results.length;
  if (counts.picked === 0) return counts;

  for (const row of rows.results) {
    if (!row.readme) {
      counts.failed++;
      continue;
    }
    const [owner, repo] = (row.source_id || "").split("/");
    const branch = row.branch || "main";
    const hits = extractAssetUrls(row.readme, owner, repo, branch);
    const mapping = new Map<string, string>(); // matchedSrc → R2 path

    for (let i = 0; i < Math.min(hits.length, R2_MAX_ASSETS_PER_REPO); i++) {
      const r2Path = await migrateOneAsset(env, owner, repo, hits[i].resolvedUrl);
      if (r2Path) {
        mapping.set(hits[i].matchedSrc, r2Path);
        counts.assets_migrated++;
      } else {
        counts.assets_failed++;
      }
    }

    // Rewrite URLs in readme_excerpt (and readme_translated if present).
    const newReadme = mapping.size > 0 ? rewriteUrls(row.readme, mapping) : row.readme;
    const newTranslated = row.translated && mapping.size > 0
      ? rewriteUrls(row.translated, mapping)
      : row.translated;

    try {
      await env.DB.prepare(
        `UPDATE items
            SET extra = json_set(extra,
                                 '$.readme_excerpt', ?,
                                 '$.readme_translated', ?,
                                 '$.r2_migrated_at', ?,
                                 '$.r2_assets_count', ?)
          WHERE id = ?`,
      )
        .bind(
          newReadme,
          newTranslated,
          Math.floor(Date.now() / 1000),
          mapping.size,
          row.id,
        )
        .run();
      counts.ok++;
      console.log(`[github-r2-migrate] ${row.id}: ${mapping.size}/${hits.length} assets migrated`);
    } catch (e) {
      counts.failed++;
      console.error(`[github-r2-migrate] ${row.id}: D1 update error`, e);
    }
  }

  console.log(`[github-r2-migrate] ${JSON.stringify(counts)}`);
  return counts;
}

export async function countGithubR2Pending(env: GithubEnv): Promise<number> {
  const r = await env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM items
      WHERE source_type='github'
        AND is_relevant = 1
        AND json_extract(extra, '$.readme_excerpt') IS NOT NULL
        AND json_extract(extra, '$.r2_migrated_at') IS NULL`,
  ).first<{ n: number }>();
  return r?.n ?? 0;
}
