/**
 * 一步录入的后台那一半：把加工产物送进候选池。
 *
 * 提交那一步（`beginOwnerAssertedEntry`）只建行就返回了，加工在 workflow 上跑
 * （{@link runManualLeadContentEntryWorkflow}），跑完由这里接手：
 *
 * 1. 拿起草结果去 {@link assertManualNewsLeadCandidate} 签名入池；
 * 2. 入池成功后，把取材与生成的产物写进 `items.extra` 的几个非门禁键。
 *
 * **入池永不失败**是这个模块唯一的硬要求（规格第 8 节第一条）：加工那一轮拿不拿得到东西
 * 都要走到第 1 步，起草不出来就退回 owner 那句话当标题。
 */
import type { Env } from '../index';
import {
  clampEnrichmentText,
  type ManualEvidenceMaterialSource,
} from './manual-lead-enrichment';
import {
  emptyManualLeadContentResult,
  type ManualLeadContentResult,
  type ManualLeadContentStage,
} from './manual-lead-content';
import {
  assertManualNewsLeadCandidate,
  setManualLeadContentStage,
  touchManualLeadContentDeadline,
} from './manual-news-leads-store';

export interface ManualLeadContentEntryInput {
  id: string;
  review_date: string;
  input_url: string;
  input_text: string;
  note: string;
  submit_idempotency_key: string;
}

export interface ManualLeadContentPoolOutcome {
  pooled: boolean;
  stage: Extract<ManualLeadContentStage, 'done' | 'failed'>;
  detail: string;
}

/**
 * 兜底入池之后，多久才允许再兜底一次。
 *
 * 兜底挂在列表 GET 上，owner 盯着卡片时页面一直在轮询；一条怎么都入不了池的线索
 * （比如审核窗口已经过了）不该每次轮询都被重试一遍，所以每兜底一次就把期限往后推一段。
 */
export const MANUAL_LEAD_CONTENT_RECOVERY_RETRY_MS = 120_000;

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
 * 批次版本冲突的重试次数。同一批里几条线索前后脚入池时会互相插队，重试一次通常就过；
 * 给到 4 次是留出「四条同时提交」这种实际发生过的场景的余量，再多就说明不是并发问题。
 */
const POOL_REVISION_CONFLICT_RETRIES = 4;

/**
 * 把一条一步录入线索送进候选池。
 *
 * `expected_batch_revision` 刻意不传：提交那一刻面板读到的批次版本，等加工跑完早就可能
 * 被别的确认推走了，拿它做乐观并发校验会让这条候选卡在
 * `candidate_batch_revision_conflict` 而进不了池 —— 那正是这里最不能出的事。缺省时
 * {@link assertManualNewsLeadCandidate} 会读当前活跃批次的版本，这才是入池该用的口径。
 *
 * **被拒与出故障分开处理**：入池被拒（审核窗口过了、已经确认过）是一个决定，写进卡片就
 * 完了；写库真的出故障则往外抛，让 durable step 重试一次 —— 它是唯一一件必须做成的事。
 */
export async function poolManualLeadContentEntry(
  env: Env,
  lead: ManualLeadContentEntryInput,
  content: ManualLeadContentResult,
  now: number,
): Promise<ManualLeadContentPoolOutcome> {
  let pooled = false;
  let detail = content.detail;
  try {
    let result = await assertManualNewsLeadCandidate(env, {
      date: lead.review_date,
      text: lead.input_text,
      url: lead.input_url,
      note: lead.note,
      ...(content.drafted ? { drafted: content.drafted } : {}),
    }, lead.submit_idempotency_key, now);
    // 批次版本冲突是**抢锁没抢到**，不是一个决定：每一次入池都会新建一个批次修订，几条
    // 线索前后脚跑完时，后到的那条读版本与写入之间必然被人插队。2026-09-05 验收里四条
    // 同时提交，两条就是这么被判「没能加入候选池」的。所以这一种错误要重来，重来时
    // assertManualNewsLeadCandidate 会重新读当前活跃批次的版本。
    for (let attempt = 0; !result.ok
      && result.error === 'candidate_batch_revision_conflict'
      && attempt < POOL_REVISION_CONFLICT_RETRIES; attempt += 1) {
      console.warn(`[manual-lead-content] lead=${lead.id} batch revision conflict, retrying`);
      result = await assertManualNewsLeadCandidate(env, {
        date: lead.review_date,
        text: lead.input_text,
        url: lead.input_url,
        note: lead.note,
        ...(content.drafted ? { drafted: content.drafted } : {}),
      }, lead.submit_idempotency_key, Date.now());
    }
    pooled = result.ok;
    if (!result.ok) {
      detail = `没能加入候选池：${result.error}`;
      console.warn(`[manual-lead-content] lead=${lead.id} pooling refused: ${result.error}`);
    }
  } catch (error) {
    console.warn(`[manual-lead-content] lead=${lead.id} pooling failed:`,
      String((error as Error)?.message || error).slice(0, 200));
    await setManualLeadContentStage(env, lead.id, {
      stage: 'failed', detail: '没能加入候选池，正在重试',
    }, Date.now());
    throw error;
  }

  if (pooled) await writeManualLeadContentExtras(env, `blog:manual:${lead.id}`, content);

  const stage: ManualLeadContentPoolOutcome['stage'] = pooled ? 'done' : 'failed';
  await setManualLeadContentStage(env, lead.id, {
    stage,
    detail,
    // 取到素材才写档位。兜底那条路手上没有素材，不能拿它把 workflow 已经写下的档位抹成
    // 「什么都没取到」；建行时这一列本来就是 'none'。
    ...(content.materials.length ? { materialTier: content.materialTier } : {}),
  }, Date.now());
  return { pooled, stage, detail };
}

/**
 * 把「加工没了下文」的线索直接送进候选池。**永不抛异常。**
 *
 * **不再从头重跑整轮**（规格第 10.1 节）：那一轮本来就是被运行时回收掉的，重跑只会再被
 * 回收一次 —— 2026-09-05 生产上观测到的 `fetching_source → drafting → fetching_source`
 * 反复就是这么来的。加工现在跑在 workflow 上，自己会续跑；这条兜底只负责最后那件必须做成
 * 的事：用 owner 那句话把线索送进池子。
 */
export async function recoverManualLeadContentEntry(
  env: Env,
  lead: ManualLeadContentEntryInput,
  now: number,
): Promise<ManualLeadContentPoolOutcome> {
  // 先把期限往后推：这一轮兜底还没跑完，下一次轮询不该又来一遍。
  await touchManualLeadContentDeadline(
    env, lead.id, now + MANUAL_LEAD_CONTENT_RECOVERY_RETRY_MS, now,
  );
  try {
    return await poolManualLeadContentEntry(env, lead, emptyManualLeadContentResult(
      '后台加工没跑完，已按你写的那句话加入候选池',
    ), now);
  } catch (error) {
    console.warn(`[manual-lead-content] lead=${lead.id} recovery failed:`,
      String((error as Error)?.message || error).slice(0, 200));
    return { pooled: false, stage: 'failed', detail: '没能加入候选池，请重试一次' };
  }
}
