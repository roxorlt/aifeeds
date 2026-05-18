// Step 3 helpers:
//   - analyzeDimensionForHfPaper  → 1 段 deep_analysis pro reasoning(8 段独立调用,fan-out 并行)
//   - translateTitleSummaryForHfPaper → flash 1 次出 title_zh + summary_zh + ai_summary_zh
//   - mergeDeepAnalysisForHfPaper → 合并 8 段返回写入 extra.deep_analysis
//
// 设计文档 §5.1 C 方案:每段独立 reasoning chain 保最佳质量。
// User 决策(2026-05-18):"按最佳质量来设计方案,成本不考虑"

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
): Promise<DimensionResult> {
  if (!env.DEEPSEEK_API_KEY) {
    return { dimension, data: null, failed: true, error: 'no_deepseek_key' };
  }
  const ctx = await loadAnalyzeContext(env, itemId, arxivId);
  if (!ctx) {
    return { dimension, data: null, failed: true, error: 'context_load_fail' };
  }
  const { prompt, maxTokens } = buildDimensionPrompt(dimension, ctx);

  const result = await callDeepSeekJson<Record<string, unknown>>(
    env.DEEPSEEK_API_KEY,
    DEEPSEEK_PRO,
    prompt,
    { maxTokens, timeoutMs: 300_000, retries: 1 },     // pro reasoning 可能 > 60s
  );
  if (!result.data) {
    // 失败时标 *_failed_at(merge step 之后会写入 extra)
    return {
      dimension,
      data: null,
      failed: true,
      usage: result.usage,
      error: result.error || 'no_data',
    };
  }
  return {
    dimension,
    data: result.data,
    failed: false,
    usage: result.usage,
  };
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
): Promise<{ data: TitleSummaryResult | null; failed: boolean; error?: string }> {
  if (!env.DEEPSEEK_API_KEY) {
    return { data: null, failed: true, error: 'no_deepseek_key' };
  }
  const row = await env.DB.prepare(
    `SELECT title, content, extra FROM items WHERE id = ?`,
  ).bind(itemId).first<ItemContextRow>();
  if (!row?.title || !row?.content) {
    return { data: null, failed: true, error: 'context_load_fail' };
  }
  const extra: HfExtra = row.extra ? JSON.parse(row.extra) : {};

  const prompt = buildTitleSummaryPrompt({
    title: row.title,
    summary: row.content,
    ai_summary_en: extra.ai_summary_en || undefined,
    ai_keywords: extra.ai_keywords || undefined,
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
  payload: MergePayload,
): Promise<{ written: boolean; failed_dimensions: DimensionKey[] }> {
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

  console.log(`[hf-paper:merge] ${itemId} written, ${failedDims.length}/${DIMENSION_LIST.length} failed dimensions`);
  return { written: true, failed_dimensions: failedDims };
}

const DIMENSION_LIST: DimensionKey[] = [
  'tldr', 'problem', 'key_insight', 'method', 'experiments',
  'industry_impact', 'code_status', 'limitations_and_novelty',
];

export const ALL_DIMENSIONS = DIMENSION_LIST;
