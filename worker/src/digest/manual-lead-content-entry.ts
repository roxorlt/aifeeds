/**
 * 一步录入的后台那一半：跑完内容加工，然后把线索送进候选池。
 *
 * 提交那一步（{@link beginOwnerAssertedEntry}）只建行就返回了，这里接着做三件事：
 *
 * 1. 跑 {@link runManualLeadContentPipeline}，一路把阶段回写进库供卡片显示；
 * 2. 拿起草结果去 {@link assertManualNewsLeadCandidate} 签名入池；
 * 3. 入池成功后，把取材与生成的产物写进 `items.extra` 的几个非门禁键。
 *
 * **入池永不失败**是这个模块唯一的硬要求（规格第 8 节第一条）：加工那一轮拿不拿得到东西
 * 都要走到第 2 步，起草不出来就退回 owner 那句话当标题。所以这里一个异常都不往外抛，
 * 第 1 步的失败绝不阻断第 2 步。
 */
import type { Env } from '../index';
import {
  clampEnrichmentText,
  type ManualEvidenceMaterialSource,
} from './manual-lead-enrichment';
import {
  runManualLeadContentPipeline,
  type ManualLeadContentAdapters,
  type ManualLeadContentResult,
  type ManualLeadContentStage,
  type ManualLeadContentStageBudget,
} from './manual-lead-content';
import {
  assertManualNewsLeadCandidate,
  setManualLeadContentStage,
} from './manual-news-leads-store';

export interface ManualLeadContentEntryInput {
  id: string;
  review_date: string;
  input_url: string;
  input_text: string;
  note: string;
  submit_idempotency_key: string;
}

export interface ManualLeadContentEntryOutcome {
  pooled: boolean;
  stage: ManualLeadContentStage;
  detail: string;
  content: ManualLeadContentResult;
}

/**
 * 把加工产物写进候选对应的 items 行。
 *
 * 只写四个非门禁键：`manual_evidence_text` / `manual_evidence_source` 供口播当背景素材，
 * `excerpt_zh` 供卡片图与小红书正文，`ai_category` 归类。被正式新闻门绑定的列与
 * `extra.event_fingerprint` 一个字都不碰 —— 它们跟签名投影逐字绑定。
 *
 * `manual_evidence_text` 用的是生成出来的正文中译，不是原始素材：口播要的是一段可直接
 * 念的中文背景，塞一整段可能还是英文的原文只会让下游再翻一次。
 */
export async function writeManualLeadContentExtras(
  env: Env,
  itemId: string,
  content: ManualLeadContentResult,
): Promise<'written' | 'empty' | 'failed'> {
  const evidenceText = clampEnrichmentText(content.excerptZh);
  const excerptZh = Array.from(content.excerptZh || '').slice(0, 2_000).join('');
  const sources: ManualEvidenceMaterialSource[] = content.materials.map((material) => ({
    url: material.url, publisher: material.publisher, kind: material.kind,
  }));
  if (!evidenceText && !excerptZh && !content.aiCategory) return 'empty';
  const primary = content.materials[0];
  const source = primary
    ? {
      url: primary.url,
      publisher: primary.publisher || '未知来源',
      fetched_at: new Date().toISOString(),
      kind: primary.kind,
      tier: primary.tier,
      ...(sources.length > 1 ? { sources } : {}),
    }
    : null;
  try {
    await env.DB.prepare(
      `/* manual_lead:content_extras */ UPDATE items
       SET extra = json_set(
         CASE WHEN extra IS NOT NULL AND json_valid(extra) = 1 THEN extra ELSE '{}' END,
         '$.manual_evidence_text', ?,
         '$.manual_evidence_source', json(?),
         '$.excerpt_zh', ?,
         '$.ai_category', ?)
       WHERE id = ?`,
    ).bind(
      evidenceText,
      JSON.stringify(source),
      excerptZh,
      content.aiCategory || 'other',
      itemId,
    ).run();
    return 'written';
  } catch (error) {
    // 入池已经完成了。少几个 extra 键只是口播素材薄一点，绝不能变成入池失败。
    console.warn('[manual-lead-content] extras write failed:',
      String((error as Error)?.message || error).slice(0, 200));
    return 'failed';
  }
}

/**
 * 跑完一条一步录入线索的后台加工并把它送进候选池。**永不抛异常。**
 *
 * `expected_batch_revision` 刻意不传：提交那一刻面板读到的批次版本，等加工跑完早就可能
 * 被别的确认推走了，拿它做乐观并发校验会让这条候选卡在
 * `candidate_batch_revision_conflict` 而进不了池 —— 那正是这里最不能出的事。缺省时
 * {@link assertManualNewsLeadCandidate} 会读当前活跃批次的版本，这才是入池该用的口径。
 */
export async function runManualLeadContentEntry(
  env: Env,
  lead: ManualLeadContentEntryInput,
  adapters: ManualLeadContentAdapters,
  opts: { now?: number; budgetMs?: number; stageBudgetMs?: ManualLeadContentStageBudget } = {},
): Promise<ManualLeadContentEntryOutcome> {
  const now = opts.now ?? Date.now();
  const content = await runManualLeadContentPipeline(
    { url: lead.input_url || null, text: lead.input_text || '', date: lead.review_date },
    adapters,
    {
      onStage: (stage) => setManualLeadContentStage(env, lead.id, { stage }, Date.now()),
    },
    {
      ...(opts.budgetMs === undefined ? {} : { budgetMs: opts.budgetMs }),
      ...(opts.stageBudgetMs === undefined ? {} : { stageBudgetMs: opts.stageBudgetMs }),
    },
  );

  let pooled = false;
  let detail = content.detail;
  try {
    const result = await assertManualNewsLeadCandidate(env, {
      date: lead.review_date,
      text: lead.input_text,
      url: lead.input_url,
      note: lead.note,
      ...(content.drafted ? { drafted: content.drafted } : {}),
    }, lead.submit_idempotency_key, now);
    pooled = result.ok;
    if (!result.ok) {
      detail = `没能加入候选池：${result.error}`;
      console.warn(`[manual-lead-content] lead=${lead.id} pooling refused: ${result.error}`);
    }
  } catch (error) {
    detail = '没能加入候选池，请重试一次';
    console.warn(`[manual-lead-content] lead=${lead.id} pooling failed:`,
      String((error as Error)?.message || error).slice(0, 200));
  }

  if (pooled) await writeManualLeadContentExtras(env, `blog:manual:${lead.id}`, content);

  const stage: ManualLeadContentStage = pooled ? 'done' : 'failed';
  await setManualLeadContentStage(env, lead.id, {
    stage,
    detail,
    materialTier: content.materialTier,
  }, Date.now());
  return { pooled, stage, detail, content };
}
