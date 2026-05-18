// Step 0 helpers:refresh-paper-detail + fetch-arxiv-categories(per-paper 兜底)
//
// - refresh-paper-detail:防 fetch handler 抓到的 detail 在 INSERT 后过期 / 被删
//   重抓一次 GET /api/papers/<arxiv_id>,刷新 githubRepo / githubStars / projectPage 等
//
// - fetch-arxiv-categories:Phase 2 batch 调被 arxiv WAF 拦(IP ban),改 per-paper 单调
//   workflow fan-out 跨 CF 节点 + schedule jitter 自然降 RPS,触发 ban 风险大幅降低

import type { Env } from '../index';

const HF_API_BASE = 'https://huggingface.co/api';
const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';

// ────────────────────────────────────────────────────────────────────
// Step 0a: refresh-paper-detail
// ────────────────────────────────────────────────────────────────────

interface HfPaperDetail {
  id: string;
  upvotes?: number;
  discussionId?: string;
  projectPage?: string | null;
  githubRepo?: string;
  githubRepoAddedBy?: string;
  githubStars?: number;
  ai_summary?: string;
  ai_keywords?: string[];
  organization?: string;
}

export async function refreshPaperDetailForHf(
  env: Env,
  itemId: string,
  arxivId: string,
): Promise<{ refreshed: boolean; reason?: string }> {
  if (!env.HF_READ) {
    return { refreshed: false, reason: 'no_hf_token' };
  }
  try {
    const r = await fetch(`${HF_API_BASE}/papers/${arxivId}`, {
      headers: { Authorization: `Bearer ${env.HF_READ}` },
    });
    if (!r.ok) {
      console.warn(`[hf-paper:refresh-detail] ${arxivId} HTTP ${r.status}`);
      return { refreshed: false, reason: `http_${r.status}` };
    }
    const detail = (await r.json()) as HfPaperDetail;

    // 取要更新的字段,patch 进 items.extra 的现有 JSON(不覆盖其他字段)
    const ghRepoFull = detail.githubRepo
      ? (detail.githubRepo.startsWith('http') ? detail.githubRepo : `https://github.com/${detail.githubRepo}`)
      : null;

    // 用 SQLite json_patch 增量 patch(保留现有 extra 其他字段)
    const patch: Record<string, unknown> = {
      project_page: detail.projectPage ?? null,
      github_repo: ghRepoFull,
      github_stars: detail.githubStars ?? null,
      github_repo_added_by: detail.githubRepoAddedBy ?? null,
      ai_summary_en: detail.ai_summary ?? null,
      ai_keywords: detail.ai_keywords ?? [],
    };

    // metrics 也刷:upvotes 可能涨了
    await env.DB.prepare(
      `UPDATE items
        SET extra = json_patch(coalesce(extra, '{}'), ?),
            metrics = json_set(coalesce(metrics, '{}'), '$.upvotes', ?, '$.github_stars', ?)
        WHERE id = ?`,
    ).bind(
      JSON.stringify(patch),
      detail.upvotes ?? null,
      detail.githubStars ?? null,
      itemId,
    ).run();

    return { refreshed: true };
  } catch (e) {
    console.error(`[hf-paper:refresh-detail] ${arxivId} exception`, e);
    return { refreshed: false, reason: 'exception' };
  }
}

// ────────────────────────────────────────────────────────────────────
// Step 0b: fetch-arxiv-categories(per-paper 兜底,Phase 2 batch IP ban 后路径)
// ────────────────────────────────────────────────────────────────────

export async function fetchArxivCategoriesForHf(
  env: Env,
  itemId: string,
  arxivId: string,
): Promise<{ categories: string[]; fetched: boolean }> {
  // 检查现有 extra.arxiv_categories 是否已有(Phase 2 batch 成功的情况),有就跳过
  try {
    const row = await env.DB.prepare(
      `SELECT json_extract(extra, '$.arxiv_categories') AS cats FROM items WHERE id = ?`,
    ).bind(itemId).first<{ cats: string | null }>();
    if (row?.cats) {
      const parsed = JSON.parse(row.cats) as string[];
      if (Array.isArray(parsed) && parsed.length > 0) {
        return { categories: parsed, fetched: false };  // 已有,不再抓
      }
    }
  } catch {
    // 忽略 SELECT 失败,继续抓
  }

  // 单 paper 调 arxiv.org Atom API
  const url = `${ARXIV_API_BASE}?id_list=${arxivId}`;
  let xml: string | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await new Promise((res) => setTimeout(res, 3000)); // 3s backoff
    }
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; aifeeds-bot/1.0)' },
      });
      if (r.status === 429) {
        console.warn(`[hf-paper:arxiv] ${arxivId} HTTP 429 attempt ${attempt + 1}`);
        continue;
      }
      if (!r.ok) {
        console.error(`[hf-paper:arxiv] ${arxivId} HTTP ${r.status}`);
        return { categories: [], fetched: false };
      }
      xml = await r.text();
      break;
    } catch (e) {
      console.error(`[hf-paper:arxiv] ${arxivId} exception attempt ${attempt + 1}`, e);
    }
  }
  if (!xml) return { categories: [], fetched: false };

  const categories = parseArxivCategoriesXml(xml);
  if (categories.length === 0) {
    return { categories: [], fetched: false };
  }

  // 写回 extra
  try {
    await env.DB.prepare(
      `UPDATE items SET extra = json_set(coalesce(extra, '{}'), '$.arxiv_categories', json(?)) WHERE id = ?`,
    ).bind(JSON.stringify(categories), itemId).run();
  } catch (e) {
    console.error(`[hf-paper:arxiv] ${arxivId} write fail`, e);
  }
  return { categories, fetched: true };
}

function parseArxivCategoriesXml(xml: string): string[] {
  const primary = xml.match(/<arxiv:primary_category\s+term="([^"]+)"/);
  const all: string[] = [];
  if (primary) all.push(primary[1]);
  const catRe = /<category\s+term="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = catRe.exec(xml)) !== null) {
    if (!all.includes(m[1])) all.push(m[1]);
  }
  return all;
}
