// 分批日报阶段看门狗(2026-09-02 事故的第二道防线)。
//
// 为什么必须有一个「跑在失败 isolate 之外」的观察者:
// node-run 里的全部告警(阶段首次失败 / 阶段最终失败 / workflow 兜底)都活在
// **发生故障的那次 workflow 调用自己的 isolate 里**。只要故障不是以「可捕获的 Promise
// rejection」形式回到用户代码 —— CPU 时间超限、isolate 被回收、OOM —— 那些 catch 一行都不会跑,
// 告警自然一条都发不出来。9/2 六连败零告警就是这个形状。
//
// 本模块由 */5 cron 每 tick 调一次(纯计算先判窗口,窗口外零 I/O 直接返回),
// 到点检查「今天这个 staged 阶段该有的快照/推送标记在不在」,缺了就告警。
// 它不依赖任何失败路径能跑到,因此是唯一一条 9/2 那种事故也能报出来的通道。
//
// 与 daily-page-monitor 的 checkDailyPageFreshness 是同一套思路,只是后者只盯 SEO 静态页,
// 盯不到 foundation / editorial / papers / finalize 四个阶段本身。

import type { Env } from '../index';
import { deliverCriticalAlert } from '../notifier';
import { getDailyStageState, type DailyCodexStage } from './codex-push';
import { bjtDateStr } from './lib';

const BJT_OFFSET_MS = 8 * 3600_000;
/** 过了 due + grace 之后还继续检查多久;超过就不再告警(避免全天反复查同一天)。 */
const MONITOR_TAIL_MINUTES = 240;

export interface StagedStageDeadline {
  stage: DailyCodexStage;
  /** 该阶段的 BJT 计划时刻(自 00:00 起的分钟数)。 */
  dueMinuteBjt: number;
  /** 宽限期:重建 + 重试 + 推送跑完所需的余量。 */
  graceMinutes: number;
  /** 该阶段是否需要有 pushed_at(仅在 DAILY_PUSH_ENABLED='1' 时校验)。 */
  requiresPush: boolean;
  /** finalize 没有自己的 digest_pool 快照,只看推送标记。 */
  snapshotOnly?: false;
}

// 计划时刻见 routeDigestCronWorkflows:BJT 06:30 foundation / 07:50 editorial / 08:00 papers+finalize。
export const STAGED_STAGE_DEADLINES: readonly StagedStageDeadline[] = [
  { stage: 'foundation', dueMinuteBjt: 6 * 60 + 30, graceMinutes: 15, requiresPush: true },
  { stage: 'editorial', dueMinuteBjt: 7 * 60 + 50, graceMinutes: 10, requiresPush: true },
  { stage: 'papers', dueMinuteBjt: 8 * 60, graceMinutes: 20, requiresPush: true },
  { stage: 'finalize', dueMinuteBjt: 8 * 60, graceMinutes: 25, requiresPush: true },
];

export interface StagedStageCheck {
  stage: DailyCodexStage;
  healthy: boolean;
  reason: 'ok' | 'missing_snapshot' | 'missing_push' | 'read_failed' | 'already_alerted';
  alerted: boolean;
  detail?: string;
}

export interface StagedStageMonitorResult {
  date: string;
  skipped?: 'staged_disabled' | 'outside_window';
  checks: StagedStageCheck[];
  alerted: number;
}

function bjtMinuteOfDay(nowMs: number): number {
  const shifted = new Date(nowMs + BJT_OFFSET_MS);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

function dueDeadlines(nowMs: number): StagedStageDeadline[] {
  const minute = bjtMinuteOfDay(nowMs);
  return STAGED_STAGE_DEADLINES.filter((deadline) => {
    const from = deadline.dueMinuteBjt + deadline.graceMinutes;
    return minute >= from && minute <= from + MONITOR_TAIL_MINUTES;
  });
}

/**
 * 检查今天各 staged 阶段是否在计划时刻 + 宽限期内落地。缺失即 PushDeer 告警。
 * 每个 (date, stage) 每天只告一次(KV 去重,TTL 25h);无 KV 时降级成照发。
 * **永不抛错** —— 看门狗自己挂掉不能反过来影响 cron 主链路。
 */
export async function checkStagedDailyStages(
  env: Env,
  nowMs: number = Date.now(),
): Promise<StagedStageMonitorResult> {
  const date = bjtDateStr(nowMs);
  if (env.DAILY_STAGED_PUSH_ENABLED !== '1') {
    return { date, skipped: 'staged_disabled', checks: [], alerted: 0 };
  }
  const deadlines = dueDeadlines(nowMs);
  if (!deadlines.length) return { date, skipped: 'outside_window', checks: [], alerted: 0 };

  const pushRequired = env.DAILY_PUSH_ENABLED === '1';
  const checks: StagedStageCheck[] = [];
  let alerted = 0;

  for (const deadline of deadlines) {
    const check = await inspectStage(env, date, deadline, pushRequired);
    checks.push(check);
    if (check.alerted) alerted++;
  }
  return { date, checks, alerted };
}

async function inspectStage(
  env: Env,
  date: string,
  deadline: StagedStageDeadline,
  pushRequired: boolean,
): Promise<StagedStageCheck> {
  const { stage } = deadline;
  let state: Awaited<ReturnType<typeof getDailyStageState>> = null;
  try {
    state = await getDailyStageState(env, date, stage);
  } catch (error) {
    // 读不到状态本身也是异常信号,但不能据此断言阶段失败(可能只是 D1 抖动)。
    console.error(`[staged-monitor] ${date} ${stage} state read failed:`, error);
    return { stage, healthy: false, reason: 'read_failed', alerted: false, detail: String(error).slice(0, 200) };
  }

  // finalize 没有独立的 pool 快照,只有推送标记;其余阶段先看快照,再看推送。
  if (stage !== 'finalize' && !state) {
    return alertStage(env, date, deadline, 'missing_snapshot', '阶段快照未生成(重建失败或根本没跑)');
  }
  if (pushRequired && deadline.requiresPush && !state?.pushed_at) {
    return alertStage(env, date, deadline, 'missing_push', '阶段快照未成功推送(pushed_at 为空)');
  }
  return { stage, healthy: true, reason: 'ok', alerted: false };
}

async function alertStage(
  env: Env,
  date: string,
  deadline: StagedStageDeadline,
  reason: 'missing_snapshot' | 'missing_push',
  detail: string,
): Promise<StagedStageCheck> {
  const { stage } = deadline;
  const dedupKey = `STAGED_STAGE_MISSING_ALERTED_${date}_${stage}`;
  if (env.AUTH_KV) {
    try {
      if (await env.AUTH_KV.get(dedupKey)) {
        return { stage, healthy: false, reason: 'already_alerted', alerted: false, detail };
      }
      await env.AUTH_KV.put(dedupKey, new Date().toISOString(), { expirationTtl: 25 * 3600 });
    } catch (error) {
      // KV 故障只影响去重,不能吞掉告警本身。
      console.error(`[staged-monitor] ${date} ${stage} dedup key failed:`, error);
    }
  }
  const dueHhmm = `${String(Math.floor(deadline.dueMinuteBjt / 60)).padStart(2, '0')}`
    + `:${String(deadline.dueMinuteBjt % 60).padStart(2, '0')}`;
  await deliverCriticalAlert(
    env,
    `staged-monitor:${stage}`,
    `今日 ${stage} 阶段未按时完成`,
    [
      `**${date}** 的分批日报 \`${stage}\` 阶段在计划时刻 BJT ${dueHhmm}`
      + `(+${deadline.graceMinutes} 分钟宽限)之后仍未完成。`,
      `- 原因:${detail}`,
      '',
      '这条来自**独立于 workflow 的看门狗**:即使那次 workflow 的 isolate 被直接掐死'
      + '(CPU 超限 / OOM),workflow 内部的告警一条都发不出来,这里仍然能报。',
      '排查:CF Dashboard → Workers → Workflows → digest-node-run 看该实例的 step 失败原因。',
    ].join('\n'),
  );
  return { stage, healthy: false, reason, alerted: true, detail };
}
