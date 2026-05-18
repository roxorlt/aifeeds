// Step 3 helpers:
//   - analyzeDimensionForHfPaper  → 1 段 deep_analysis pro reasoning(8 段独立调用,fan-out 并行)
//   - translateTitleSummaryForHfPaper → flash 1 次出 title_zh + summary_zh + ai_summary_zh
//   - mergeDeepAnalysisForHfPaper → 合并 8 段返回写入 extra.deep_analysis
//
// 设计文档 §5.1 C 方案:每段独立 reasoning chain 保最佳质量。
// User 决策(2026-05-18):"按最佳质量来设计方案,成本不考虑"
//
// **Idempotency 设计(2026-05-18 fix)**:
//   每次 step 跑前算 input hash = sha256(title|summary|ai_summary_en|ar5iv_excerpt[:3000])
//   跟 D1 stored extra.deep_analysis_input_hash 对比:
//     - hash 相同 && dim 已存在 → skip pro/flash 调用,return cached data
//     - hash 不同(或 stored hash 缺失)→ input 有变化,跑新调用
//   merge step 写入 new hash。
//   场景:
//     - 首轮 trigger:必跑(无 stored hash)
//     - backfill 重跑(input 未变):skip 8 段 pro + flash translate,0 LLM 成本
//     - ar5iv mirror 出来后 input 加 3000 字 ar5iv_excerpt:hash 变 → 重跑刷新质量
//     - HF 修改 abstract:hash 变 → 重跑

import type { Env } from '../index';
import { callDeepSeekJson, DEEPSEEK_FLASH, DEEPSEEK_PRO, type DeepSeekUsage } from './llm';
import {
  buildDimensionPrompt,
  buildTitleSummaryPrompt,
  DIMENSIONS,
  type DimensionKey,
  type DeepAnalyzeContext,
} from './prompts';

// ────────────────────────────────────────────────────────────────────
// Idempotency: input hash + cache check
// ────────────────────────────────────────────────────────────────────

async function computeAnalysisInputHash(ctx: DeepAnalyzeContext): Promise<string> {
  // 决定 deep_analysis 输出的关键 input:title + summary + ai_summary_en + ar5iv 前 3000 字
  // ai_keywords / arxiv_categories / github_* / project_page 不算 input(变了不重跑)
  const parts = [
    ctx.title,
    ctx.summary,
    ctx.ai_summary_en || '',
    (ctx.ar5iv_excerpt || '').slice(0, 3000),
  ];
  const text = parts.join('\n---\n');
  const buf = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

interface CachedAnalysis {
  storedHash: string | null;
  deep: Record<string, unknown> | null;
  titleSummary: { title_zh?: string; summary_zh?: string; ai_summary_zh?: string } | null;
}

async function loadCachedAnalysis(env: Env, itemId: string): Promise<CachedAnalysis> {
  const row = await env.DB.prepare(
    `SELECT
      json_extract(extra, '$.deep_analysis_input_hash') AS stored_hash,
      json_extract(extra, '$.deep_analysis') AS deep,
      json_extract(extra, '$.title_zh') AS title_zh,
      json_extract(extra, '$.summary_zh') AS summary_zh,
      json_extract(extra, '$.ai_summary_zh') AS ai_summary_zh
    FROM items WHERE id = ?`,
  ).bind(itemId).first<{
    stored_hash: string | null;
    deep: string | null;
    title_zh: string | null;
    summary_zh: string | null;
    ai_summary_zh: string | null;
  }>();
  if (!row) return { storedHash: null, deep: null, titleSummary: null };
  let deep: Record<string, unknown> | null = null;
  try {
    deep = row.deep ? JSON.parse(row.deep) : null;
  } catch {
    deep = null;
  }
  const titleSummary = (row.title_zh || row.summary_zh || row.ai_summary_zh)
    ? {
        title_zh: row.title_zh || undefined,
        summary_zh: row.summary_zh || undefined,
        ai_summary_zh: row.ai_summary_zh || undefined,
      }
    : null;
  return { storedHash: row.stored_hash, deep, titleSummary };
}

/**
 * Map dimension → 它在 deep_analysis JSON 里写哪些 key
 * limitations_and_novelty 写 limitations + novelty_rating 两个 key
 */
function dimensionOutputKeys(dim: DimensionKey): string[] {
  if (dim === 'limitations_and_novelty') return ['limitations', 'novelty_rating'];
  return [dim];
}

// ────────────────────────────────────────────────────────────────────
// Helpers: context loader
// ────────────────────────────────────────────────────────────────────

interface ItemContextRow {
  title: string | null;
  content: string | null;            // English abstract
  extra: string | null;
}

interface HfExtra {
  ai_summary_en?: string | null;
  ai_keywords?: string[];
  arxiv_categories?: string[];
  github_repo?: string | null;
  github_stars?: number | null;
  project_page?: string | null;
  ar5iv_paragraphs_count?: number;
  deep_analysis?: Record<string, unknown>;
  [k: string]: unknown;
}

async function loadAnalyzeContext(
  env: Env,
  itemId: string,
  arxivId: string,
): Promise<DeepAnalyzeContext | null> {
  const row = await env.DB.prepare(
    `SELECT title, content, extra FROM items WHERE id = ?`,
  ).bind(itemId).first<ItemContextRow>();
  if (!row?.title || !row?.content) return null;

  const extra: HfExtra = row.extra ? JSON.parse(row.extra) : {};

  // ar5iv 段落摘录(给 method/experiments 用,前 3000 字)
  let ar5ivExcerpt: string | null = null;
  if (env.READMES && (extra.ar5iv_paragraphs_count || 0) > 0) {
    try {
      const obj = await env.READMES.get(`hf-paper-ar5iv/${arxivId}.json`);
      if (obj) {
        const data = (await obj.json()) as {
          paragraphs?: Array<{ en?: string }>;
        };
        const englishText = (data.paragraphs || [])
          .map((p) => p.en || '')
          .join('\n\n');
        ar5ivExcerpt = englishText.slice(0, 3000);
      }
    } catch (e) {
      console.warn(`[hf-paper:analyze] ${arxivId} ar5iv R2 load fail`, e);
    }
  }

  return {
    title: row.title,
    summary: row.content,
    ai_summary_en: extra.ai_summary_en || undefined,
    ai_keywords: extra.ai_keywords || undefined,
    arxiv_categories: extra.arxiv_categories || undefined,
    github_url: extra.github_repo || null,
    github_stars: typeof extra.github_stars === 'number' ? extra.github_stars : null,
    project_page: extra.project_page || null,
    ar5iv_excerpt: ar5ivExcerpt,
  };
}

// ────────────────────────────────────────────────────────────────────
// 单段 deep_analysis 调用(pro reasoning JSON Mode)
//
// 返回结果存 in-memory(workflow step return),
// 最后 merge step 一次写入 extra.deep_analysis
// ────────────────────────────────────────────────────────────────────

export interface DimensionResult {
  dimension: DimensionKey;
  data: Record<string, unknown> | null;  // 单 dimension JSON 输出(本段返回的 key)
  failed: boolean;
  usage?: DeepSeekUsage;
  error?: string;
}

export async function analyzeDimensionForHfPaper(
  env: Env,
  itemId: string,
  arxivId: string,
  dimension: DimensionKey,
): Promise<DimensionResult & { cached?: boolean }> {
  if (!env.DEEPSEEK_API_KEY) {
    return { dimension, data: null, failed: true, error: 'no_deepseek_key' };
  }
  const ctx = await loadAnalyzeContext(env, itemId, arxivId);
  if (!ctx) {
    return { dimension, data: null, failed: true, error: 'context_load_fail' };
  }

  // Idempotency check:input hash 一致 + 该 dim 所有 key 已存在 → skip LLM
  const newHash = await computeAnalysisInputHash(ctx);
  const cached = await loadCachedAnalysis(env, itemId);
  if (cached.storedHash === newHash && cached.deep) {
    const requiredKeys = dimensionOutputKeys(dimension);
    const allPresent = requiredKeys.every((k) => k in cached.deep!);
    if (allPresent) {
      // 重建该 dim 的 data 部分(merge step 期望 data 含本 dim 输出 keys + version)
      const cachedData: Record<string, unknown> = { version: 'v1' };
      for (const k of requiredKeys) {
        cachedData[k] = cached.deep[k];
      }
      console.log(`[hf-paper:analyze] ${itemId}/${dimension} cached(hash match)`);
      return { dimension, data: cachedData, failed: false, cached: true };
    }
  }

  // input 有变化 OR 该 dim 缺失 → 跑 pro
  const { prompt, maxTokens } = buildDimensionPrompt(dimension, ctx);
  const result = await callDeepSeekJson<Record<string, unknown>>(
    env.DEEPSEEK_API_KEY,
    DEEPSEEK_PRO,
    prompt,
    { maxTokens, timeoutMs: 300_000, retries: 1 },     // pro reasoning 可能 > 60s
  );
  if (!result.data) {
    return {
      dimension, data: null, failed: true,
      usage: result.usage, error: result.error || 'no_data',
    };
  }
  return { dimension, data: result.data, failed: false, usage: result.usage };
}

// ────────────────────────────────────────────────────────────────────
// translate-title-summary(flash 单次,跟 8 段 pro 并行)
// ────────────────────────────────────────────────────────────────────

interface TitleSummaryResult {
  title_zh?: string;
  summary_zh?: string;
  ai_summary_zh?: string;
}

export async function translateTitleSummaryForHfPaper(
  env: Env,
  itemId: string,
  arxivId: string,
): Promise<{ data: TitleSummaryResult | null; failed: boolean; cached?: boolean; error?: string }> {
  if (!env.DEEPSEEK_API_KEY) {
    return { data: null, failed: true, error: 'no_deepseek_key' };
  }

  // 用 loadAnalyzeContext 跟 deep_analysis 共享 input hash 概念
  const ctx = await loadAnalyzeContext(env, itemId, arxivId);
  if (!ctx) {
    return { data: null, failed: true, error: 'context_load_fail' };
  }

  // Idempotency check
  const newHash = await computeAnalysisInputHash(ctx);
  const cached = await loadCachedAnalysis(env, itemId);
  if (cached.storedHash === newHash && cached.titleSummary?.title_zh) {
    console.log(`[hf-paper:translate-title-summary] ${itemId} cached`);
    return { data: cached.titleSummary, failed: false, cached: true };
  }

  const prompt = buildTitleSummaryPrompt({
    title: ctx.title,
    summary: ctx.summary,
    ai_summary_en: ctx.ai_summary_en || undefined,
    ai_keywords: ctx.ai_keywords || undefined,
  });

  const result = await callDeepSeekJson<TitleSummaryResult>(
    env.DEEPSEEK_API_KEY,
    DEEPSEEK_FLASH,
    prompt,
    { maxTokens: 2000, timeoutMs: 60_000, retries: 1 },
  );
  if (!result.data) {
    return { data: null, failed: true, error: result.error || 'no_data' };
  }
  return { data: result.data, failed: false };
}

// ────────────────────────────────────────────────────────────────────
// merge-deep-analysis: 合并 8 段返回 + title/summary 翻译 → extra
// ────────────────────────────────────────────────────────────────────

export interface MergePayload {
  dimensions: DimensionResult[];
  titleSummary: TitleSummaryResult | null;
}

export async function mergeDeepAnalysisForHfPaper(
  env: Env,
  itemId: string,
  arxivId: string,
  payload: MergePayload,
): Promise<{ written: boolean; failed_dimensions: DimensionKey[]; input_hash?: string }> {
  // 合并 8 段成 deep_analysis JSON(参考 §3.3 schema)
  const deep: Record<string, unknown> = { version: 'v1' };
  const failedDims: DimensionKey[] = [];
  for (const dim of payload.dimensions) {
    if (dim.failed || !dim.data) {
      failedDims.push(dim.dimension);
      continue;
    }
    // 每段返回的是 {version, <dimension key or keys>:value}
    // 直接 patch:对 limitations_and_novelty 拆成 limitations + novelty_rating
    for (const [k, v] of Object.entries(dim.data)) {
      if (k === 'version') continue;
      deep[k] = v;
    }
  }

  // 失败的 dimension 标 *_failed_at(让 FE 知道哪一段缺失)
  const nowIso = new Date().toISOString();
  for (const failedDim of failedDims) {
    // 跟 schema 对齐:limitations_and_novelty 拆成 limitations / novelty_rating
    if (failedDim === 'limitations_and_novelty') {
      deep.limitations_failed_at = nowIso;
      deep.novelty_rating_failed_at = nowIso;
    } else {
      deep[`${failedDim}_failed_at`] = nowIso;
    }
  }

  // 检查 dimension keys 是否都填了(给 UI 显占位)
  const requiredKeys = ['tldr', 'problem', 'key_insight', 'method', 'experiments', 'industry_impact', 'code_status', 'limitations', 'novelty_rating'];
  for (const k of requiredKeys) {
    if (!(k in deep) && !(`${k}_failed_at` in deep)) {
      // 没出现(LLM 返了但没 key)— 标 failed
      deep[`${k}_failed_at`] = nowIso;
    }
  }

  // 写入 extra
  const setExprs: string[] = [`'$.deep_analysis'`, `json(?)`];
  const bindings: unknown[] = [JSON.stringify(deep)];

  // deep_analysis_at + model
  setExprs.push(`'$.deep_analysis_at'`, `?`);
  bindings.push(nowIso);
  setExprs.push(`'$.deep_analysis_model'`, `?`);
  bindings.push(DEEPSEEK_PRO);

  // input hash:用于 backfill 重 trigger 时 idempotency check(skip 不变 input 的 LLM 调用)
  let inputHash: string | undefined;
  const ctx = await loadAnalyzeContext(env, itemId, arxivId);
  if (ctx) {
    inputHash = await computeAnalysisInputHash(ctx);
    setExprs.push(`'$.deep_analysis_input_hash'`, `?`);
    bindings.push(inputHash);
  }

  // title/summary 翻译写入顶层 extra
  if (payload.titleSummary) {
    if (payload.titleSummary.title_zh) {
      setExprs.push(`'$.title_zh'`, `?`);
      bindings.push(payload.titleSummary.title_zh);
    }
    if (payload.titleSummary.summary_zh) {
      setExprs.push(`'$.summary_zh'`, `?`);
      bindings.push(payload.titleSummary.summary_zh);
    }
    if (payload.titleSummary.ai_summary_zh) {
      setExprs.push(`'$.ai_summary_zh'`, `?`);
      bindings.push(payload.titleSummary.ai_summary_zh);
    }
  }

  // 拼 json_set 调用(SQLite json_set 接 key + value 交替)
  const sql = `UPDATE items SET extra = json_set(coalesce(extra, '{}'), ${setExprs.join(', ')}) WHERE id = ?`;
  bindings.push(itemId);
  try {
    await env.DB.prepare(sql).bind(...bindings).run();
  } catch (e) {
    console.error(`[hf-paper:merge] ${itemId} SQL fail`, e);
    return { written: false, failed_dimensions: failedDims };
  }

  console.log(`[hf-paper:merge] ${itemId} written, ${failedDims.length}/${DIMENSION_LIST.length} failed dimensions, hash=${inputHash?.slice(0, 8) || 'none'}`);
  return { written: true, failed_dimensions: failedDims, input_hash: inputHash };
}

const DIMENSION_LIST: DimensionKey[] = [
  'tldr', 'problem', 'key_insight', 'method', 'experiments',
  'industry_impact', 'code_status', 'limitations_and_novelty',
];

export const ALL_DIMENSIONS = DIMENSION_LIST;
