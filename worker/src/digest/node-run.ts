// digest-node-run workflow:某推送节点到点,算 5 源榜单 + 节点标题摘要 + 给订阅起 deliver。
// 由 scheduled handler 在节点时间(UTC 0/4/9 = BJT 8/12/17,minute=0)create。
// 设计文档:roxor-main-design-20260528-090625.md

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import {
  DIGEST_SOURCE_ORDER,
  SOURCE_DIGEST_CONFIG,
  CURATED_CANDIDATE_POOL,
  type DigestSource,
} from './config';
import { selectTopForSource } from './selection';
import { curateSource, type CurateCandidate } from './llm-curate';
import { slotKey } from './lib';
import { callDeepSeekJson, DEEPSEEK_FLASH } from '../hf-paper/llm';

interface NodeRunParams {
  slotHourBjt: number;
}

const RETRY = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' as const },
  timeout: '5 minutes',
} as const;

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

// X 候选:完整文案(不截断)+ 引用推文全文(extra.quote_of)+ 链接卡,给 pro 充分上下文。
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
    /* ignore */
  }
  const author = row?.author || row?.handle || '';
  return { id, title: author ? `@${author}` : id, summary: parts.join('\n') };
}

async function fetchCandidates(env: Env, source: DigestSource, ids: string[]): Promise<CurateCandidate[]> {
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

// 节点级标题摘要(flash,该节点所有用户共用)。失败 fallback。
async function genSubjectDigest(env: Env, sk: string): Promise<string> {
  const fallback = '今日 AI 精选';
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
      /* ignore */
    }
  }
  if (!ids.length || !env.DEEPSEEK_API_KEY) return fallback;
  const top = ids.slice(0, 8);
  const ph = top.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT title, content_translated, content FROM items WHERE id IN (${ph})`,
  )
    .bind(...top)
    .all<{ title: string | null; content_translated: string | null; content: string | null }>();
  const titles = (r.results || [])
    .map((row) => row.title || (row.content_translated || row.content || '').slice(0, 40))
    .filter(Boolean);
  if (!titles.length) return fallback;
  // deepseek-v4 是 reasoning 模型:普通调用 content 空(内容在 reasoning_content),
  // 必须走 JSON Mode 让答案进 content;maxTokens 要留够 reasoning 占用。
  // 主题走 TLDR 风格:挑最重磅的 3 个精简成短名列举,而非总结句。
  const prompt = `下面是今天 AI 圈精选内容的标题。挑出最重磅的 3 个,每个精简成不超过 12 字的短名(产品名/事件名/技术名),用「、」连接成邮件标题。像 TLDR 那样直接列举,不要总结句、不要修饰词。只返回 JSON:{"subject":"短名1、短名2、短名3"}\n\n${titles.join('\n')}`;
  const { data } = await callDeepSeekJson<{ subject: string }>(env.DEEPSEEK_API_KEY, DEEPSEEK_FLASH, prompt, {
    maxTokens: 1000,
    retries: 1,
  });
  const s = data?.subject;
  return typeof s === 'string' && s.trim() ? s.trim().replace(/[。.]$/, '').slice(0, 60) : fallback;
}

export class DigestNodeRunWorkflow extends WorkflowEntrypoint<Env, NodeRunParams> {
  async run(event: WorkflowEvent<NodeRunParams>, step: WorkflowStep) {
    const { slotHourBjt } = event.payload;
    const sk = slotKey(slotHourBjt);

    // Phase 1:各源算 normal(纯分 top N)+ curated(LLM 挑 M)榜单
    for (const source of DIGEST_SOURCE_ORDER) {
      const cfg = SOURCE_DIGEST_CONFIG[source as DigestSource];
      await step.do(`pool-${source}`, RETRY, async (): Promise<number> => {
        const candidateIds = await selectTopForSource(this.env, source as DigestSource, CURATED_CANDIDATE_POOL);
        if (!candidateIds.length) {
          await upsertPool(this.env, sk, source, 'normal', [], null);
          await upsertPool(this.env, sk, source, 'curated', [], null);
          return 0;
        }
        const normalIds = candidateIds.slice(0, cfg.normal);
        await upsertPool(this.env, sk, source, 'normal', normalIds, null);
        const candidates = await fetchCandidates(this.env, source as DigestSource, candidateIds);
        const ids = await curateSource(this.env, source as DigestSource, candidates, cfg.curated);
        await upsertPool(this.env, sk, source, 'curated', ids, null);
        return candidateIds.length;
      });
    }

    // Phase 1.5:节点级标题摘要
    await step.do('subject-digest', RETRY, async (): Promise<string> => {
      const subject = await genSubjectDigest(this.env, sk);
      await upsertPool(this.env, sk, '_subject', 'meta', [], { subject });
      return subject;
    });

    // Phase 2:给选了这个节点的 active 订阅起 deliver(workflow id 唯一 = 幂等防重复 create)
    const subIds = await step.do('list-subs', RETRY, async (): Promise<number[]> => {
      const r = await this.env.DB.prepare(
        `SELECT id FROM subscriptions WHERE status = 'active' AND send_slot = ?`,
      )
        .bind(slotHourBjt)
        .all<{ id: number }>();
      return (r.results || []).map((s) => s.id);
    });

    for (const subId of subIds) {
      await step.do(`spawn-deliver-${subId}`, RETRY, async (): Promise<number> => {
        await this.env.DIGEST_DELIVER_WORKFLOW.create({
          id: `digest-${sk}-${subId}`,
          params: { subId, slotKey: sk },
        });
        return subId;
      });
    }

    return { slotKey: sk, subs: subIds.length };
  }
}
