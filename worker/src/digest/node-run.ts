// digest-node-run workflow:订阅节点继续负责邮件/SEO；日报视频在启用 v2 后额外按
// BJT 06:30 foundation、07:50 editorial、08:00 papers+finalize 分批固化和推送。

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import { DIGEST_SOURCE_ORDER } from './config';
import { bjtDateStr } from './lib';
import {
  getDailyStageState,
  pushDailyStageToCodex,
  pushDailyToCodex,
  type DailyCodexInputStage,
} from './codex-push';
import { runDailyPagePhase } from './daily-page-monitor';
import {
  rebuildDigestPoolSource,
  rebuildDigestPoolStage,
  rebuildDigestPoolSubject,
} from './pool-rebuild';
import { pushDeerAlert } from '../notifier';
import { freezeNewsReviewBatchFromPool, notifyNewsReviewBatch } from './news-review';

export interface NodeRunParams {
  slotHourBjt: number;
  date?: string;
  dailyStage?: DailyCodexInputStage;
}

export interface DigestCronWorkflowAction {
  id: string;
  params: NodeRunParams;
}

const RETRY = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' as const },
  timeout: '5 minutes',
} as const;

function slotKeyFor(date: string, slotHourBjt: number): string {
  return `${date}-${String(slotHourBjt).padStart(2, '0')}`;
}

// 复用现有 */5 cron，不增加 wrangler trigger。scheduledTime 是 UTC；日期必须按
// BJT 计算，否则 06:30/07:50 会被错误写到前一日。
export function routeDigestCronWorkflows(
  scheduledTime: number,
  stagedEnabled: boolean,
): DigestCronWorkflowAction[] {
  const utc = new Date(scheduledTime);
  const hour = utc.getUTCHours();
  const minute = utc.getUTCMinutes();
  const date = bjtDateStr(scheduledTime);

  if (stagedEnabled && hour === 22 && minute === 30) {
    return [{
      id: `digest-node-${date}-08-foundation`,
      params: { slotHourBjt: 8, date, dailyStage: 'foundation' },
    }];
  }
  if (stagedEnabled && hour === 23 && minute === 50) {
    return [{
      id: `digest-node-${date}-08-editorial`,
      params: { slotHourBjt: 8, date, dailyStage: 'editorial' },
    }];
  }

  const slotHourBjt = minute === 0
    ? ({ 0: 8, 4: 12, 9: 17 } as Record<number, number>)[hour]
    : undefined;
  if (slotHourBjt === undefined) return [];
  const dailyStage = stagedEnabled && slotHourBjt === 8 ? 'papers' as const : undefined;
  return [{
    id: `digest-node-${date}-${String(slotHourBjt).padStart(2, '0')}${dailyStage ? `-${dailyStage}` : ''}`,
    params: { slotHourBjt, date, ...(dailyStage ? { dailyStage } : {}) },
  }];
}

function assertStagePushOk(stage: string, result: { ok: boolean; skipped?: string; error?: string }): void {
  if (result.ok) return;
  throw new Error(`daily_stage_push_failed:${stage}:${result.error || result.skipped || 'unknown'}`);
}

async function rebuildStageStep(
  env: Env,
  step: WorkflowStep,
  date: string,
  stage: DailyCodexInputStage,
): Promise<void> {
  await step.do(`pool-stage-${stage}`, RETRY, async () => {
    return rebuildDigestPoolStage(env, { date, stage });
  });
}

async function pushStageStep(
  env: Env,
  step: WorkflowStep,
  date: string,
  stage: DailyCodexInputStage | 'finalize',
): Promise<void> {
  await step.do(`push-codex-${stage}`, RETRY, async () => {
    const result = await pushDailyStageToCodex(env, stage, date);
    assertStagePushOk(stage, result);
    return result;
  });
}

async function prepareNewsReviewStep(
  env: Env,
  step: WorkflowStep,
  date: string,
): Promise<void> {
  if (env.DAILY_NEWS_REVIEW_ENABLED !== '1') return;
  const frozen = await step.do('freeze-news-review-batch', RETRY, async () => {
    return freezeNewsReviewBatchFromPool(env, date);
  });
  try {
    await step.do('notify-news-review-batch', RETRY, async () => {
      return notifyNewsReviewBatch(env, frozen.batch);
    });
  } catch (error) {
    // 审核通知失败不能阻断默认 Top5 的海报/音频/视频生产。批次仍保留
    // notified_at=NULL，08:00 恢复步骤和人工运维可继续补发。
    await pushDeerAlert(
      env,
      '行业要闻审核通知失败',
      `${date}: ${String(error).slice(0, 240)}`,
    ).catch(() => {});
  }
}

async function ensurePriorStageSnapshots(env: Env, step: WorkflowStep, date: string): Promise<void> {
  for (const stage of ['foundation', 'editorial'] as const) {
    const state = await step.do(`check-codex-${stage}`, RETRY, async () => {
      return getDailyStageState(env, date, stage);
    });
    if (!state) await rebuildStageStep(env, step, date, stage);
  }
}

async function recoverPriorStagePushes(env: Env, step: WorkflowStep, date: string): Promise<void> {
  for (const stage of ['foundation', 'editorial'] as const) {
    const state = await step.do(`check-codex-push-${stage}`, RETRY, async () => {
      return getDailyStageState(env, date, stage);
    });
    if (!state?.pushed_at) await pushStageStep(env, step, date, stage);
  }
}

async function runDigestNodeWorkflowCore(
  env: Env,
  params: NodeRunParams,
  step: WorkflowStep,
): Promise<{ slotKey: string; subs: number; dailyStage?: string; skipped?: string }> {
  const { slotHourBjt } = params;
  const date = params.date || bjtDateStr();
  const sk = slotKeyFor(date, slotHourBjt);
  const stagedEnabled = env.DAILY_STAGED_PUSH_ENABLED === '1';
  const earlyStage = params.dailyStage === 'foundation' || params.dailyStage === 'editorial'
    ? params.dailyStage
    : null;

  // 06:30/07:50 是纯预生产批次：不列订阅、不发邮件、不生成 SEO。
  // 若 workflow 已入队后开关被关闭，必须 no-op，不能误降级成 08:00 v1 全量任务。
  if (earlyStage && !stagedEnabled) {
    return { slotKey: `${date}-08`, subs: 0, dailyStage: earlyStage, skipped: 'staged_disabled' };
  }
  if (stagedEnabled && earlyStage) {
    await rebuildStageStep(env, step, date, earlyStage);
    if (earlyStage === 'editorial') await prepareNewsReviewStep(env, step, date);
    if (env.DAILY_PUSH_ENABLED === '1') {
      await pushStageStep(env, step, date, earlyStage);
    }
    return { slotKey: `${date}-08`, subs: 0, dailyStage: earlyStage };
  }

  const stagedEight = stagedEnabled && slotHourBjt === 8;
  if (stagedEight) {
    // 邮件也消费同一个 -08 池，因此缺失早批要先补快照；这里不做外部 push，
    // 保证 HK 故障不会让邮件缺栏目或阻断投递。
    await ensurePriorStageSnapshots(env, step, date);
    // 07:50 若因临时故障漏建批次或 PushDeer 未成功，08:00 以同一快照幂等补建/补发。
    await prepareNewsReviewStep(env, step, date);
    await rebuildStageStep(env, step, date, 'papers');
  } else {
    // v1 回滚路径及 12/17 邮件节点保持原有全源重建行为。
    for (const source of DIGEST_SOURCE_ORDER) {
      if (source === 'clawhub') continue;
      await step.do(`pool-${source}`, RETRY, async (): Promise<number> => {
        return (await rebuildDigestPoolSource(env, sk, source)).candidates;
      });
    }
    await step.do('subject-digest', RETRY, async (): Promise<string> => {
      return rebuildDigestPoolSubject(env, sk);
    });
  }

  const subIds = await step.do('list-subs', RETRY, async (): Promise<number[]> => {
    const result = await env.DB.prepare(
      `SELECT id FROM subscriptions WHERE status = 'active' AND send_slot = ?`,
    )
      .bind(slotHourBjt)
      .all<{ id: number }>();
    return (result.results || []).map((subscription) => subscription.id);
  });

  for (const subId of subIds) {
    await step.do(`spawn-deliver-${subId}`, RETRY, async (): Promise<number> => {
      await env.DIGEST_DELIVER_WORKFLOW.create({
        id: `digest-${sk}-${subId}`,
        params: { subId, slotKey: sk },
      });
      return subId;
    });
  }

  let stagedPushError: unknown = null;
  if (slotHourBjt === 8 && env.DAILY_PUSH_ENABLED === '1') {
    if (stagedEight) {
      try {
        // 正常路径只读前两批状态。只有状态不存在或没有成功 push 标记时才补建/补推，
        // 不在 08:00 无条件重跑 PH/GH/news/X 共享池选择器；视频推送会在其
        // 专用 payload 层从 editorial 共享池中只选择 news。
        await recoverPriorStagePushes(env, step, date);
        await pushStageStep(env, step, date, 'papers');
        await pushStageStep(env, step, date, 'finalize');
      } catch (error) {
        // 先让独立的邮件与 SEO 阶段完成，再抛出使 Workflow 保持失败并可重试。
        stagedPushError = error;
      }
    } else {
      await step.do('push-codex-daily', RETRY, async () => {
        return pushDailyToCodex(env, slotHourBjt, date);
      });
    }
  }

  if (slotHourBjt === 8 && env.DAILY_PAGE_ENABLED === '1') {
    await step.do('generate-daily-page', RETRY, async () => {
      const result = await runDailyPagePhase(env, date);
      if (result.error !== undefined) throw new Error(result.error);
      return result;
    });
  }

  if (stagedPushError) throw stagedPushError;

  return { slotKey: sk, subs: subIds.length, ...(stagedEight ? { dailyStage: 'papers' } : {}) };
}

export async function runDigestNodeWorkflow(
  env: Env,
  params: NodeRunParams,
  step: WorkflowStep,
): Promise<{ slotKey: string; subs: number; dailyStage?: string; skipped?: string }> {
  try {
    return await runDigestNodeWorkflowCore(env, params, step);
  } catch (error) {
    const isStagedRun = !!params.dailyStage || (
      env.DAILY_STAGED_PUSH_ENABLED === '1' && params.slotHourBjt === 8
    );
    if (isStagedRun) {
      const date = params.date || bjtDateStr();
      const stage = params.dailyStage || 'papers';
      await pushDeerAlert(
        env,
        '分批日报 Workflow 失败',
        `${date} ${stage}: ${String(error).slice(0, 300)}`,
      ).catch(() => {});
    }
    throw error;
  }
}

export class DigestNodeRunWorkflow extends WorkflowEntrypoint<Env, NodeRunParams> {
  async run(event: WorkflowEvent<NodeRunParams>, step: WorkflowStep) {
    return runDigestNodeWorkflow(this.env, event.payload, step);
  }
}
