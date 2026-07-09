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
import { selectTopForSource, selectNewsByScoreWithAudit, excludeAlreadyPushed, type NewsSelectionAudit } from './selection';
import { curateSource, type CurateCandidate } from './llm-curate';
import { slotKey, bjtDateStr } from './lib';
import { pushDailyToCodex } from './codex-push';
import { runDailyPagePhase } from './daily-page-monitor';
import { callDeepSeekJson, DEEPSEEK_FLASH } from '../hf-paper/llm';
import { buildDigestSubjectFallback, digestSubjectTitleFromRow } from './subject';

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

// 节点级标题摘要(flash,该节点所有用户共用)。失败 fallback。
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
      /* ignore */
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
  const titles = top
    .map((id) => digestSubjectTitleFromRow(byId.get(id)))
    .filter(Boolean);
  const fallback = buildDigestSubjectFallback(titles);
  if (!env.DEEPSEEK_API_KEY) return fallback;
  if (!titles.length) return fallback;
  // deepseek-v4 是 reasoning 模型:普通调用 content 空(内容在 reasoning_content),
  // 必须走 JSON Mode 让答案进 content;maxTokens 要留够 reasoning 占用。
  // 主题走 TLDR 风格:挑最重磅的 3-4 件,每件写成「主体+动作+具体对象」的短句(能看懂谁做了什么),
  // 而非干巴巴堆产品名/型号。字数放宽(每件 ~10-18 字,整体 ~50 字内)。
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
  const s = data?.subject;
  // 字数放宽(描述性短句比短名长):60 → 90,够 3-4 件「主体+动作+对象」短句
  return typeof s === 'string' && s.trim() ? s.trim().replace(/[。.]$/, '').slice(0, 90) : fallback;
}

export class DigestNodeRunWorkflow extends WorkflowEntrypoint<Env, NodeRunParams> {
  async run(event: WorkflowEvent<NodeRunParams>, step: WorkflowStep) {
    const { slotHourBjt } = event.payload;
    const sk = slotKey(slotHourBjt);

    // Phase 1:各源算 normal(纯分 top N)+ curated(LLM 挑 M)榜单
    for (const source of DIGEST_SOURCE_ORDER) {
      // 2026-06-21 ClawHub(龙虾技能)退出订阅日报:仍保留 homepage 频道 + 对外 daily-api 源,
      // 但不入 digest_pool(省 curated LLM 调用)、不进订阅邮件。仅此一处下架,daily-api 不受影响。
      if (source === 'clawhub') continue;
      const cfg = SOURCE_DIGEST_CONFIG[source as DigestSource];
      await step.do(`pool-${source}`, RETRY, async (): Promise<number> => {
        let newsAudit: NewsSelectionAudit | null = null;
        const candidateIds0 = source === 'news'
          ? await (async () => {
            const result = await selectNewsByScoreWithAudit(this.env, CURATED_CANDIDATE_POOL, {
              strictCrossDayEventDedup: true,
              editorialReview: true,
            });
            newsAudit = result.audit;
            return result.ids;
          })()
          : await selectTopForSource(
            this.env,
            source as DigestSource,
            CURATED_CANDIDATE_POOL,
            {},
          );
        // 跨天去重:剔除前几天已推过的同一条。若全被剔(极端冷门日,候选全是前几天推过的)
        // → 兜底回退原始榜,宁可重复也不让板块(尤其 news 强制头条)整块空掉。
        let candidateIds = await excludeAlreadyPushed(this.env, candidateIds0, source as DigestSource);
        if (!candidateIds.length && candidateIds0.length) candidateIds = candidateIds0;
        if (!candidateIds.length) {
          await upsertPool(this.env, sk, source, 'normal', [], null);
          await upsertPool(this.env, sk, source, 'curated', [], null);
          return 0;
        }
        const normalIds = candidateIds.slice(0, cfg.normal);
        const normalMeta: Record<string, unknown> | null = newsAudit
          ? Object.assign({}, newsAudit, {
            selected_ids: normalIds,
            candidate_ids_after_exact_dedup: candidateIds,
          })
          : null;
        await upsertPool(this.env, sk, source, 'normal', normalIds, normalMeta);
        // 行业新闻:规则分已在 selectNewsByScore 排好,curated 直接取分数 top M,不走 LLM curate
        let curatedIds: string[];
        if (source === 'news') {
          curatedIds = candidateIds.slice(0, cfg.curated);
        } else {
          const candidates = await fetchCandidates(this.env, source as DigestSource, candidateIds);
          curatedIds = await curateSource(this.env, source as DigestSource, candidates, cfg.curated);
        }
        await upsertPool(this.env, sk, source, 'curated', curatedIds, null);
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

    // Phase 3:仅早 8 点 + 总开关 DAILY_PUSH_ENABLED==='1' → 把当天日报内容(快照,normal,
    // ph/gh/hf-paper)并行推给 Codex 渲染机。放在 deliver spawn 之后(邮件已在投递路上,不拖慢);
    // pushDailyToCodex 非阻塞、永不抛错。开关默认关,手动 mode(daily-codex-push)不受此限。
    if (slotHourBjt === 8 && this.env.DAILY_PUSH_ENABLED === '1') {
      await step.do('push-codex-daily', RETRY, async () => {
        return await pushDailyToCodex(this.env, slotHourBjt);
      });
    }

    // Phase 4:仅早 8 点 + 开关 DAILY_PAGE_ENABLED==='1' → 生成当日 SEO 静态日报页。
    // 学 Phase 3 容错:独立 workflow step,任何异常绝不影响邮件/Codex。runDailyPagePhase 内部
    // try/catch 兜底(永不抛错)+ 告警:异常 → PushDeer「[SEO] 日报页生成失败」;skipped(选品空)
    // → 告警「[SEO] 日报页跳过(选品空)」;正常静默。手动 mode(daily-page)不受此开关限制。
    if (slotHourBjt === 8 && this.env.DAILY_PAGE_ENABLED === '1') {
      await step.do('generate-daily-page', RETRY, async () => {
        return await runDailyPagePhase(this.env, bjtDateStr());
      });
    }

    return { slotKey: sk, subs: subIds.length };
  }
}
