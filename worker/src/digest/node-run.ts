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
import { deliverCriticalAlert } from '../notifier';
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

export interface NodeRunResult {
  slotKey: string;
  subs: number;
  dailyStage?: string;
  skipped?: string;
  /** 本次运行里失败的 staged 阶段(阶段名:错误摘要),用于 workflow 输出可观测。 */
  stageFailures?: string[];
  /** finalize 因前置阶段缺失而挂起时的明确原因;不是「静默没推」。 */
  finalizeSuspended?: string;
}

const RETRY = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' as const },
  timeout: '5 minutes',
} as const;

function slotKeyFor(date: string, slotHourBjt: number): string {
  return `${date}-${String(slotHourBjt).padStart(2, '0')}`;
}

function errorSummary(error: unknown, max = 240): string {
  return String(error instanceof Error ? error.message || error : error).slice(0, max);
}

/**
 * staged 阶段步骤的统一包装:**失败第一时间就告警,不等整个 workflow 死掉**。
 *
 * 9/2 事故里六连败零告警,根因是告警只有一条、且只挂在最外层 catch 上:
 * 只有「retry 全部耗尽 + 失败还能以可捕获异常的形式回到用户代码」时才会发出。
 * 这里改成两级:
 * - 第一次失败(retry 还没开始)立刻发一条「首次失败,将自动重试」;
 * - retry 全败后再升级一条「今日 X 阶段最终失败」。
 *
 * `reportedFirstFailure` 是闭包变量,同一个 isolate 内的多次 retry 只会发一条首次告警。
 * 若 Workflows 把 retry 调度到新 isolate,最多多发几条 —— 宁可重复也不要静默。
 * 注意:告警自身的投递结果由 deliverCriticalAlert 检查并落日志,不再用裸 `.catch(() => {})`
 * 把「一条都没推出去」伪装成成功。
 */
async function runStagedStepWithAlerts<T>(
  env: Env,
  step: WorkflowStep,
  date: string,
  stage: string,
  stepName: string,
  body: () => Promise<T>,
): Promise<T> {
  let reportedFirstFailure = false;
  try {
    // step.do 的返回类型是 Serializable<T>;这里只是把原本各调用点的 step.do 原样包一层,
    // 结果形状不变(拆分前它们各自用具体类型调 step.do),故按 T 断言回去。
    return await (step.do(stepName, RETRY, (async () => {
      try {
        return await body();
      } catch (error) {
        if (!reportedFirstFailure) {
          reportedFirstFailure = true;
          await deliverCriticalAlert(
            env,
            `node-run:${stepName}`,
            '分批日报阶段首次失败(将自动重试)',
            `${date} ${stage} / ${stepName}: ${errorSummary(error)}`,
          );
        }
        throw error;
      }
    }) as () => Promise<never>) as Promise<T>);
  } catch (error) {
    await deliverCriticalAlert(
      env,
      `node-run:${stepName}`,
      `今日 ${stage} 阶段最终失败`,
      `${date} ${stage} / ${stepName} 重试全部失败: ${errorSummary(error, 300)}`,
    );
    throw error;
  }
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
  await runStagedStepWithAlerts(env, step, date, stage, `pool-stage-${stage}`, async () => {
    return rebuildDigestPoolStage(env, { date, stage });
  });
}

async function pushStageStep(
  env: Env,
  step: WorkflowStep,
  date: string,
  stage: DailyCodexInputStage | 'finalize',
): Promise<void> {
  await runStagedStepWithAlerts(env, step, date, stage, `push-codex-${stage}`, async () => {
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
  const frozen = await runStagedStepWithAlerts(
    env, step, date, 'editorial', 'freeze-news-review-batch',
    async () => freezeNewsReviewBatchFromPool(env, date),
  );
  try {
    await step.do('notify-news-review-batch', RETRY, async () => {
      return notifyNewsReviewBatch(env, frozen.batch);
    });
  } catch (error) {
    // 审核通知失败不能阻断默认 Top5 的海报/音频/视频生产。批次仍保留
    // notified_at=NULL，08:00 恢复步骤和人工运维可继续补发。
    await deliverCriticalAlert(
      env,
      'node-run:notify-news-review-batch',
      '行业要闻审核通知失败',
      `${date}: ${errorSummary(error)}`,
    );
  }
}

/** 每个前批阶段独立记账;某一阶段失败**不再**阻断后续阶段与 papers/邮件/SEO。 */
type StageOutcome = Record<'foundation' | 'editorial', { ok: boolean; error?: string }>;

function emptyStageOutcome(): StageOutcome {
  return { foundation: { ok: true }, editorial: { ok: true } };
}

async function ensurePriorStageSnapshots(
  env: Env,
  step: WorkflowStep,
  date: string,
  failures: string[],
): Promise<StageOutcome> {
  const outcome = emptyStageOutcome();
  for (const stage of ['foundation', 'editorial'] as const) {
    try {
      const state = await step.do(`check-codex-${stage}`, RETRY, async () => {
        return getDailyStageState(env, date, stage);
      });
      if (!state) await rebuildStageStep(env, step, date, stage);
    } catch (error) {
      // 9/2 连坐点①:这里一抛,papers 重建 + 列订阅 + 发邮件 + SEO 静态页全部跟着停。
      // 改成记账继续,阶段错误在本次运行末尾统一抛出,workflow 仍然保持失败可重试。
      const summary = `${stage}-snapshot: ${errorSummary(error)}`;
      outcome[stage] = { ok: false, error: summary };
      failures.push(summary);
      console.error(`[node-run] ${date} prior stage snapshot failed:`, summary);
    }
  }
  return outcome;
}

async function recoverPriorStagePushes(
  env: Env,
  step: WorkflowStep,
  date: string,
  failures: string[],
): Promise<StageOutcome> {
  const outcome = emptyStageOutcome();
  for (const stage of ['foundation', 'editorial'] as const) {
    try {
      const state = await step.do(`check-codex-push-${stage}`, RETRY, async () => {
        return getDailyStageState(env, date, stage);
      });
      if (!state?.pushed_at) await pushStageStep(env, step, date, stage);
    } catch (error) {
      // 9/2 连坐点②:这里一抛,papers 与 finalize 的推送全部跳过。
      const summary = `${stage}-push: ${errorSummary(error)}`;
      outcome[stage] = { ok: false, error: summary };
      failures.push(summary);
      console.error(`[node-run] ${date} prior stage push failed:`, summary);
    }
  }
  return outcome;
}

async function runDigestNodeWorkflowCore(
  env: Env,
  params: NodeRunParams,
  step: WorkflowStep,
): Promise<NodeRunResult> {
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
  const stageFailures: string[] = [];
  let firstStageError: unknown = null;
  const recordStageError = (label: string, error: unknown) => {
    stageFailures.push(`${label}: ${errorSummary(error)}`);
    if (!firstStageError) firstStageError = error;
  };
  let snapshotOutcome = emptyStageOutcome();
  if (stagedEight) {
    // 邮件也消费同一个 -08 池，因此缺失早批要先补快照；这里不做外部 push，
    // 保证 HK 故障不会让邮件缺栏目或阻断投递。
    // 2026-09-02 起每个前批阶段独立记账:editorial 回补失败不再把后面全部带停。
    snapshotOutcome = await ensurePriorStageSnapshots(env, step, date, stageFailures);
    if (!snapshotOutcome.foundation.ok && !firstStageError) {
      firstStageError = new Error(snapshotOutcome.foundation.error);
    }
    if (!snapshotOutcome.editorial.ok && !firstStageError) {
      firstStageError = new Error(snapshotOutcome.editorial.error);
    }
    // 07:50 若因临时故障漏建批次或 PushDeer 未成功，08:00 以同一快照幂等补建/补发。
    // 人审批次依赖 editorial 快照;editorial 缺失时它注定失败,失败也只记账不阻断 papers。
    try {
      await prepareNewsReviewStep(env, step, date);
    } catch (error) {
      recordStageError('news-review-freeze', error);
    }
    // ⚠️ papers 的重建与 editorial 内容无关(digest_pool stage sources:
    // papers=['hf-paper'] / editorial=['news','x']),必须独立执行 ——
    // 9/2 就是 editorial 回补失败把论文重建一起带停的。
    try {
      await rebuildStageStep(env, step, date, 'papers');
    } catch (error) {
      recordStageError('papers-rebuild', error);
    }
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

  let finalizeSuspended: string | null = null;
  if (slotHourBjt === 8 && env.DAILY_PUSH_ENABLED === '1') {
    if (stagedEight) {
      // 正常路径只读前两批状态。只有状态不存在或没有成功 push 标记时才补建/补推，
      // 不在 08:00 无条件重跑 PH/GH/news/X 共享池选择器；视频推送会在其
      // 专用 payload 层从 editorial 共享池中只选择 news。
      const pushOutcome = await recoverPriorStagePushes(env, step, date, stageFailures);
      if (!pushOutcome.foundation.ok && !firstStageError) {
        firstStageError = new Error(pushOutcome.foundation.error);
      }
      if (!pushOutcome.editorial.ok && !firstStageError) {
        firstStageError = new Error(pushOutcome.editorial.error);
      }
      // ⚠️ papers 的推送同样不依赖 editorial 内容,前批推送失败不得跳过它。
      let papersPushed = true;
      try {
        await pushStageStep(env, step, date, 'papers');
      } catch (error) {
        papersPushed = false;
        recordStageError('papers-push', error);
      }
      // finalize 的 manifest 引用三个阶段各自的 revision,任一前置阶段缺失时它推不出去
      // 是合理的 —— 但必须留下**明确的挂起状态 + 告警**,而不是静默不推。
      const blocking = [
        ...(snapshotOutcome.foundation.ok ? [] : ['foundation-snapshot']),
        ...(snapshotOutcome.editorial.ok ? [] : ['editorial-snapshot']),
        ...(pushOutcome.foundation.ok ? [] : ['foundation-push']),
        ...(pushOutcome.editorial.ok ? [] : ['editorial-push']),
        ...(papersPushed ? [] : ['papers-push']),
      ];
      if (blocking.length) {
        finalizeSuspended = blocking.join(',');
        console.error(`[node-run] ${date} finalize suspended, missing: ${finalizeSuspended}`);
        await deliverCriticalAlert(
          env,
          'node-run:finalize-suspended',
          '分批日报 finalize 挂起',
          `${date}: finalize 未推送,因为前置阶段缺失 [${finalizeSuspended}]。`
          + '前置阶段补齐(或人工重跑 08:00 workflow)后 finalize 才会发出。',
        );
      } else {
        try {
          await pushStageStep(env, step, date, 'finalize');
        } catch (error) {
          recordStageError('finalize-push', error);
        }
      }
    } else {
      await step.do('push-codex-daily', RETRY, async () => {
        return pushDailyToCodex(env, slotHourBjt, date);
      });
    }
  }

  let dailyPageError: unknown = null;
  if (slotHourBjt === 8 && env.DAILY_PAGE_ENABLED === '1') {
    try {
      await step.do('generate-daily-page', RETRY, async () => {
        const result = await runDailyPagePhase(env, date);
        if (result.error !== undefined) throw new Error(result.error);
        return result;
      });
    } catch (error) {
      dailyPageError = error;
    }
  }

  // 阶段错误在邮件与 SEO 都跑完之后统一抛出:workflow 仍然保持失败可重试,
  // 但不再让某一个阶段的失败连坐掉其余互不依赖的产出。
  if (firstStageError) throw firstStageError;
  if (dailyPageError) throw dailyPageError;

  return {
    slotKey: sk,
    subs: subIds.length,
    ...(stagedEight ? { dailyStage: 'papers' } : {}),
    ...(stageFailures.length ? { stageFailures } : {}),
    ...(finalizeSuspended ? { finalizeSuspended } : {}),
  };
}

export async function runDigestNodeWorkflow(
  env: Env,
  params: NodeRunParams,
  step: WorkflowStep,
): Promise<NodeRunResult> {
  try {
    return await runDigestNodeWorkflowCore(env, params, step);
  } catch (error) {
    const isStagedRun = !!params.dailyStage || (
      env.DAILY_STAGED_PUSH_ENABLED === '1' && params.slotHourBjt === 8
    );
    if (isStagedRun) {
      const date = params.date || bjtDateStr();
      const stage = params.dailyStage || 'papers';
      // 兜底告警(阶段级告警已经在 runStagedStepWithAlerts 里发过了);投递结果同样要检查。
      await deliverCriticalAlert(
        env,
        'node-run:workflow',
        '分批日报 Workflow 失败',
        `${date} ${stage}: ${String(error).slice(0, 300)}`,
      );
    }
    throw error;
  }
}

export class DigestNodeRunWorkflow extends WorkflowEntrypoint<Env, NodeRunParams> {
  async run(event: WorkflowEvent<NodeRunParams>, step: WorkflowStep) {
    return runDigestNodeWorkflow(this.env, event.payload, step);
  }
}
