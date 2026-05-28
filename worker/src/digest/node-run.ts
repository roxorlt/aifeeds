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
import { callDeepSeek, DEEPSEEK_FLASH } from '../hf-paper/llm';

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

async function fetchCandidates(env: Env, ids: string[]): Promise<CurateCandidate[]> {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  const r = await env.DB.prepare(
    `SELECT id, title, content, content_translated FROM items WHERE id IN (${ph})`,
  )
    .bind(...ids)
    .all<{ id: string; title: string | null; content: string | null; content_translated: string | null }>();
  const byId = new Map((r.results || []).map((row) => [row.id, row]));
  return ids.map((id) => {
    const row = byId.get(id);
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
  const prompt = `下面是今天 AI 圈热门内容的标题,用一句不超过 30 字的中文概括今日热点(给邮件标题用,不要用句号结尾):\n\n${titles.join('\n')}`;
  const { text } = await callDeepSeek(env.DEEPSEEK_API_KEY, DEEPSEEK_FLASH, prompt, {
    maxTokens: 100,
    temperature: 0.5,
  });
  return (text || '').trim().replace(/[。.]$/, '').slice(0, 40) || fallback;
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
        const candidates = await fetchCandidates(this.env, candidateIds);
        const { ids, hooks } = await curateSource(this.env, source as DigestSource, candidates, cfg.curated);
        await upsertPool(this.env, sk, source, 'curated', ids, hooks);
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
