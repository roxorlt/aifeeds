// digest_pool 榜单重算核心。定时 Workflow 与手动“仅重评分”入口必须共用这里，
// 这样重跑今日选品不会触发订阅邮件，也不会出现两套筛选规则漂移。

import type { Env } from '../index';
import {
  DIGEST_SOURCE_ORDER,
  SOURCE_DIGEST_CONFIG,
  CURATED_CANDIDATE_POOL,
  type DigestSource,
} from './config';
import {
  selectTopForSource,
  selectNewsByScoreWithAudit,
  excludeAlreadyPushed,
  type NewsSelectionAudit,
} from './selection';
import { curateSource, type CurateCandidate } from './llm-curate';
import { slotKey, bjtDateStr } from './lib';
import { callDeepSeekJson, DEEPSEEK_FLASH } from '../hf-paper/llm';
import { buildDigestSubjectFallback, digestSubjectTitleFromRow } from './subject';

export type DigestPoolStage = 'foundation' | 'editorial' | 'papers';

export const DIGEST_POOL_STAGE_SOURCES: Record<DigestPoolStage, readonly DigestSource[]> = {
  foundation: ['ph', 'gh'],
  editorial: ['news', 'x'],
  papers: ['hf-paper'],
};

async function upsertPool(
  env: Env,
  sk: string,
  source: string,
  density: string,
  ids: string[],
  meta: Record<string, unknown> | null,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO digest_pool (slot_key, source, density, item_ids, items_meta, generated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(slot_key, source, density) DO UPDATE SET
       item_ids = excluded.item_ids, items_meta = excluded.items_meta, generated_at = excluded.generated_at`,
  )
    .bind(sk, source, density, JSON.stringify(ids), meta ? JSON.stringify(meta) : null, Date.now())
    .run();
}

interface CandRow {
  id: string;
  title: string | null;
  content: string | null;
  content_translated: string | null;
  author: string | null;
  handle: string | null;
  extra: string | null;
}

function buildXCandidate(id: string, row: CandRow | undefined): CurateCandidate {
  const parts: string[] = [];
  const main = row?.content_translated || row?.content || '';
  if (main) parts.push(main);
  try {
    const ex = JSON.parse(row?.extra || '{}') as Record<string, unknown>;
    const q = ex.quote_of as Record<string, unknown> | undefined;
    if (q && typeof q === 'object') {
      const qt = (q.content_translated as string) || (q.content as string) || '';
      const qa = (q.author as string) || (q.handle as string) || '';
      if (qt) parts.push(`[引用 @${qa}] ${qt}`);
    }
    const lc = ex.link_card as Record<string, unknown> | undefined;
    if (lc && typeof lc === 'object' && lc.title) {
      parts.push(`[链接] ${lc.title}${lc.description ? ': ' + (lc.description as string) : ''}`);
    }
  } catch {
    // extra 不是合法 JSON 时仍可用主文案参与精选。
  }
  const author = row?.author || row?.handle || '';
  return { id, title: author ? `@${author}` : id, summary: parts.join('\n') };
}

export async function fetchCandidates(env: Env, source: DigestSource, ids: string[]): Promise<CurateCandidate[]> {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT id, title, content, content_translated, author, handle, extra FROM items WHERE id IN (${ph})`,
  )
    .bind(...ids)
    .all<CandRow>();
  const byId = new Map((r.results || []).map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
    if (source === 'x') return buildXCandidate(id, row);
    const body = row?.content_translated || row?.content || '';
    return {
      id,
      title: String(row?.title || body.slice(0, 60)),
      summary: String(body.slice(0, 150)),
    };
  });
}

async function genSubjectDigest(env: Env, sk: string): Promise<string> {
  const pools = await env.DB.prepare(
    `SELECT item_ids FROM digest_pool WHERE slot_key = ? AND density = 'curated'`,
  )
    .bind(sk)
    .all<{ item_ids: string }>();
  const ids: string[] = [];
  for (const p of pools.results || []) {
    try {
      ids.push(...(JSON.parse(p.item_ids) as string[]));
    } catch {
      // 忽略单条损坏的历史池数据。
    }
  }
  if (!ids.length) return '今日 AI 精选';
  const top = ids.slice(0, 8);
  const ph = top.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT id, title, content_translated, content, extra FROM items WHERE id IN (${ph})`,
  )
    .bind(...top)
    .all<{ id: string; title: string | null; content_translated: string | null; content: string | null; extra: string | null }>();
  const byId = new Map((r.results || []).map((row) => [row.id, row]));
  const titles = top.map((id) => digestSubjectTitleFromRow(byId.get(id))).filter(Boolean);
  const fallback = buildDigestSubjectFallback(titles);
  if (!env.DEEPSEEK_API_KEY || !titles.length) return fallback;
  const prompt = `下面是今天 AI 圈精选内容的标题。挑出最重磅的 3-4 件,每件改写成「主体 + 动作 + 具体对象」的短句,用「、」连接成邮件标题。

风格要求(像 TLDR 那样直接列事件):
- 让人一眼看懂「谁做了什么」,例:「MiniMax 发布新语音模型」「OpenAI 推出 Daybreak 工具集」「NVIDIA 推出暗物质搜索等多款软件」
- 不要只堆产品名 / 型号(反例:「MiniMax语音2.8」「NVIDIA AI软件」太干、看不出做了啥)
- 同一主体多个产品可合并成「等多款 / 等」
- 每件约 10-18 字,整体顺口;不要笼统总结句、不要营销修饰词

只返回 JSON:{"subject":"短句1、短句2、短句3"}\n\n${titles.join('\n')}`;
  const { data } = await callDeepSeekJson<{ subject: string }>(env.DEEPSEEK_API_KEY, DEEPSEEK_FLASH, prompt, {
    maxTokens: 1000,
    retries: 1,
  });
  const subject = data?.subject;
  return typeof subject === 'string' && subject.trim()
    ? subject.trim().replace(/[。.]$/, '').slice(0, 90)
    : fallback;
}

export interface DigestPoolSourceResult {
  source: DigestSource;
  candidates: number;
  normal: number;
  curated: number;
}

export async function rebuildDigestPoolSource(
  env: Env,
  sk: string,
  source: DigestSource,
): Promise<DigestPoolSourceResult> {
  const cfg = SOURCE_DIGEST_CONFIG[source];
  let newsAudit: NewsSelectionAudit | null = null;
  const candidateIds0 = source === 'news'
    ? await (async () => {
      const result = await selectNewsByScoreWithAudit(env, CURATED_CANDIDATE_POOL, {
        strictCrossDayEventDedup: true,
        editorialReview: true,
      });
      newsAudit = result.audit;
      return result.ids;
    })()
    : await selectTopForSource(env, source, CURATED_CANDIDATE_POOL, {});

  let candidateIds = await excludeAlreadyPushed(env, candidateIds0, source);
  if (!candidateIds.length && candidateIds0.length) candidateIds = candidateIds0;
  if (!candidateIds.length) {
    await upsertPool(env, sk, source, 'normal', [], null);
    await upsertPool(env, sk, source, 'curated', [], null);
    return { source, candidates: 0, normal: 0, curated: 0 };
  }

  const normalIds = candidateIds.slice(0, cfg.normal);
  const normalMeta: Record<string, unknown> | null = newsAudit
    ? Object.assign({}, newsAudit, {
      selected_ids: normalIds,
      candidate_ids_after_exact_dedup: candidateIds,
    })
    : null;
  await upsertPool(env, sk, source, 'normal', normalIds, normalMeta);

  let curatedIds: string[];
  if (source === 'news') {
    curatedIds = candidateIds.slice(0, cfg.curated);
  } else {
    const candidates = await fetchCandidates(env, source, candidateIds);
    curatedIds = await curateSource(env, source, candidates, cfg.curated);
  }
  await upsertPool(env, sk, source, 'curated', curatedIds, null);
  return { source, candidates: candidateIds.length, normal: normalIds.length, curated: curatedIds.length };
}

export async function rebuildDigestPoolSubject(env: Env, sk: string): Promise<string> {
  const subject = await genSubjectDigest(env, sk);
  await upsertPool(env, sk, '_subject', 'meta', [], { subject });
  return subject;
}

export interface DigestPoolRebuildResult {
  slotKey: string;
  date: string;
  slotHourBjt: number;
  sources: DigestPoolSourceResult[];
  subject: string;
}

export interface DigestPoolStageRebuildResult {
  slotKey: string;
  date: string;
  slotHourBjt: 8;
  stage: DigestPoolStage;
  sources: DigestPoolSourceResult[];
  subject: string | null;
}

export async function rebuildDigestPoolSources(
  env: Env,
  sk: string,
  sources: readonly DigestSource[],
): Promise<DigestPoolSourceResult[]> {
  const results: DigestPoolSourceResult[] = [];
  for (const source of sources) {
    if (source === 'clawhub') continue;
    results.push(await rebuildDigestPoolSource(env, sk, source));
  }
  return results;
}

// 分批日报固定写入当天 08:00 的同一个 digest_pool 槽。papers 是正式 08:00
// 节点，重建论文后才生成 subject；foundation/editorial 绝不碰其它批次。
export async function rebuildDigestPoolStage(
  env: Env,
  opts: { date?: string; stage: DigestPoolStage },
): Promise<DigestPoolStageRebuildResult> {
  const date = opts.date || bjtDateStr();
  const sk = `${date}-08`;
  const sources = await rebuildDigestPoolSources(env, sk, DIGEST_POOL_STAGE_SOURCES[opts.stage]);
  const subject = opts.stage === 'papers' ? await rebuildDigestPoolSubject(env, sk) : null;
  return { slotKey: sk, date, slotHourBjt: 8, stage: opts.stage, sources, subject };
}

// 只重建 digest_pool；明确不创建 deliver workflow、不发送邮件、不推送 HK。
export async function rebuildDigestPoolSnapshot(
  env: Env,
  opts: { slotHourBjt?: number; date?: string } = {},
): Promise<DigestPoolRebuildResult> {
  const slotHourBjt = opts.slotHourBjt ?? 8;
  const date = opts.date || bjtDateStr();
  const sk = opts.date
    ? `${date}-${String(slotHourBjt).padStart(2, '0')}`
    : slotKey(slotHourBjt);
  const sources = await rebuildDigestPoolSources(env, sk, DIGEST_SOURCE_ORDER);
  const subject = await rebuildDigestPoolSubject(env, sk);
  return { slotKey: sk, date, slotHourBjt, sources, subject };
}
