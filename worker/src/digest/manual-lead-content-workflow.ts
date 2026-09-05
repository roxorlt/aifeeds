/**
 * 一步录入线索的后台加工：跑在 Workflow 上，每个阶段是一个 durable step。
 *
 * **为什么不是 `ctx.waitUntil`**（2026-09-05 生产验收，规格第 10.1 节）：整轮加工要一两
 * 分钟，Workers 的 isolate 不保证活那么久。首轮验收四条线索里只有走推文接口那条（约 3s）
 * 跑完，另外三条在 `drafting` 停了五分钟以上还没进候选池 —— 加工被运行时回收之后没有任何
 * 人接手，`content_stage` 就永远停在最后写下的那一格。列表轮询的过期兜底当时是**从头重跑
 * 整轮**，同样会再被回收，还观测到 `fetching_source → drafting → fetching_source` 的反复。
 *
 * 改成 durable step 之后：每一步的产物由 Workflow 自己存着，中途被回收就从上一个完成的
 * step 续跑，不从头重来。
 *
 * **入池永不失败仍然是硬约束**（规格第 8 节第一条）。这里靠三件事守住：
 *
 * 1. 取材那四步的失败全部被吃掉，最多是「这一步没拿到东西」；
 * 2. 就算某一步连重试都耗尽（真 workflow 会抛出来），入池那一步照样会跑；
 * 3. 万一整条 workflow 都没了，`content_deadline_at` 过期后由面板轮询那一侧直接兜底入池
 *    （{@link recoverManualLeadContentEntry}），那条路不再重跑加工。
 *
 * **复用取证那条 workflow 的绑定**（`MANUAL_NEWS_LEAD_WORKFLOW`）：两条路靠 payload 里的
 * `kind` 分流，实例 id 前缀也不同（`content-…` 对 `manual-news-…`），互不干扰。取证那条路
 * 要占 `processing_owner` 租约，这条路一个租约都不占 —— 它决定不了线索能不能入池。
 */
import type { Env } from '../index';
import {
  MANUAL_LEAD_CONTENT_STAGE_BUDGET_MS,
  emptyManualLeadContentResult,
  runManualLeadContentPipeline,
  runManualLeadContentStep,
  type ManualLeadContentAdapters,
  type ManualLeadContentResult,
  type ManualLeadContentStepDescriptor,
  type ManualLeadContentStepRunner,
} from './manual-lead-content';
import { createManualLeadContentAdapters } from './manual-lead-content-runtime';
import {
  poolManualLeadContentEntry,
  type ManualLeadContentEntryInput,
  type ManualLeadContentPoolOutcome,
} from './manual-lead-content-entry';
import { setManualLeadContentStage } from './manual-news-leads-store';

/** payload 上的分流标记：取证那条路的 payload 没有这个键。 */
export const MANUAL_LEAD_CONTENT_WORKFLOW_KIND = 'manual_lead_content_entry';

/**
 * 一步跑完之后，`content_deadline_at` 往后续多久。
 *
 * 这一列是「加工没了下文」的判据：workflow 每进一步就把它续到「这一步的时限 + 这段富余」
 * 之后，所以只要 workflow 还活着，面板轮询那一侧就不会抢着兜底入池；workflow 一旦真的没
 * 了，最迟这段富余之后就被捡回来。
 */
export const MANUAL_LEAD_CONTENT_STEP_LEASE_GRACE_MS = 60_000;

/** 入池那一步的时限：签名 + 确认 + 写 extra，几次 D1 往返，给足一分钟。 */
export const MANUAL_LEAD_CONTENT_POOL_BUDGET_MS = 60_000;

/**
 * 存进 durable step 的正文上限。
 *
 * 下游谁都用不到更多：分析那一步自己压到 8000 字，最终交给生成函数的素材正文截到 4000 字。
 * 存多了只是让每一步的产物白白变大。
 */
export const MANUAL_LEAD_CONTENT_STEP_TEXT_MAX_CHARS = 8_000;

export interface ManualLeadContentWorkflowParams extends ManualLeadContentEntryInput {
  kind: typeof MANUAL_LEAD_CONTENT_WORKFLOW_KIND;
  /** owner 按下提交那一刻。入池的审核窗口按它算，不按加工跑完那一刻算。 */
  submitted_at: number;
}

/** 实例 id：与取证那条路的租约名（`manual-news-…`）前缀不同，绝不撞车。 */
export function manualLeadContentWorkflowId(leadId: string): string {
  return `content-${leadId}`;
}

/** payload 是不是内容加工那一路。取证那条路只有 `lead_id`，读不出 `kind`。 */
export function isManualLeadContentWorkflowParams(
  value: unknown,
): value is ManualLeadContentWorkflowParams {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.kind === MANUAL_LEAD_CONTENT_WORKFLOW_KIND
    && typeof row.id === 'string' && !!row.id
    && typeof row.review_date === 'string' && !!row.review_date
    && typeof row.submit_idempotency_key === 'string' && !!row.submit_idempotency_key;
}

/** 一步的 step 配置：超时永远大于这一步自己的时限，否则时限还没到就被 step 掐死。 */
function contentStepConfig(budgetMs: number): { retries: unknown; timeout: string } {
  return {
    // 这一步的回调自己不抛异常（超时与错误都收敛成 null），所以重试只在运行时真的出事时
    // 才发生。给一次就够，再多只是把整轮拖长。
    retries: { limit: 1, delay: '5 seconds', backoff: 'constant' },
    timeout: `${Math.ceil((budgetMs + MANUAL_LEAD_CONTENT_STEP_LEASE_GRACE_MS) / 1_000)} seconds`,
  };
}

/** 入池那一步值得多试两次：它是唯一一件必须做成的事。 */
function poolStepConfig(): { retries: unknown; timeout: string } {
  return {
    retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
    timeout: `${Math.ceil(MANUAL_LEAD_CONTENT_POOL_BUDGET_MS / 1_000)} seconds`,
  };
}

/** 产物要能存下来：`undefined` 存不了，正文也不该无上限地存。 */
export function clampDurableStepOutput<T>(value: T | null | undefined): T | null {
  if (!value || typeof value !== 'object') return value ?? null;
  const row = value as Record<string, unknown>;
  if (typeof row.text !== 'string') return value;
  const text = Array.from(row.text).slice(0, MANUAL_LEAD_CONTENT_STEP_TEXT_MAX_CHARS).join('');
  return (text === row.text ? value : { ...row, text }) as T;
}

/** 真 workflow 的 `step.do` 泛型带 `Rpc.Serializable` 约束，这里只用得上它的形状。 */
type DurableStepDo = <T>(
  name: string,
  config: unknown,
  callback: () => Promise<T>,
) => Promise<T>;

export interface ManualLeadContentWorkflowStep {
  do: DurableStepDo;
}

/**
 * 把一步包成 durable step：进这一步先把阶段与新的兜底期限写进库，再跑，产物存下来。
 *
 * 这一步彻底失败（重试耗尽，真 workflow 会抛）时只当作「这一步没拿到东西」——
 * 后面的步骤和入池照跑。
 */
function createDurableStepRunner(
  env: Env,
  leadId: string,
  step: ManualLeadContentWorkflowStep,
): ManualLeadContentStepRunner {
  return async <T>(
    descriptor: ManualLeadContentStepDescriptor,
    work: () => Promise<T | null>,
  ): Promise<T | null> => {
    const name = `manual-lead-content:${descriptor.name}`;
    try {
      return await step.do<T | null>(name, contentStepConfig(descriptor.budgetMs), async () => {
        const now = Date.now();
        await setManualLeadContentStage(env, leadId, {
          stage: descriptor.stage,
          deadlineAt: now + descriptor.budgetMs + MANUAL_LEAD_CONTENT_STEP_LEASE_GRACE_MS,
        }, now);
        return clampDurableStepOutput(
          await runManualLeadContentStep<T>(descriptor.name, work, descriptor.budgetMs),
        );
      });
    } catch (error) {
      console.warn(`[manual-lead-content] step ${name} exhausted:`,
        String((error as Error)?.message || error).slice(0, 200));
      return null;
    }
  };
}

/**
 * 跑完一条一步录入线索：取材、生成、入池。
 *
 * 步与步之间的计算必须是纯的 —— workflow 被回收之后会重放这个函数，已完成的 step 直接
 * 返回上次的产物，重放期间不能再产生副作用。
 */
export async function runManualLeadContentEntryWorkflow(
  env: Env,
  params: ManualLeadContentWorkflowParams,
  step: ManualLeadContentWorkflowStep,
  deps: { adapters?: ManualLeadContentAdapters } = {},
): Promise<ManualLeadContentPoolOutcome> {
  const lead: ManualLeadContentEntryInput = {
    id: params.id,
    review_date: params.review_date,
    input_url: params.input_url || '',
    input_text: params.input_text || '',
    note: params.note || '',
    submit_idempotency_key: params.submit_idempotency_key,
  };
  let content: ManualLeadContentResult = emptyManualLeadContentResult(
    '这一轮加工没跑起来，先按你写的那句话入池',
  );
  try {
    content = await runManualLeadContentPipeline(
      { url: lead.input_url || null, text: lead.input_text, date: lead.review_date },
      deps.adapters || createManualLeadContentAdapters(env),
      createDurableStepRunner(env, lead.id, step),
      {
        // 总预算交给每一步自己的超时。这段代码会在回收后重放，用一个墙上时钟去 race
        // 只会把一轮已经跑完的加工判成超时。
        budgetMs: null,
        stageBudgetMs: MANUAL_LEAD_CONTENT_STAGE_BUDGET_MS,
      },
    );
  } catch (error) {
    // 流水线本身不往外抛；真抛了也不能让入池跟着没了。
    console.warn(`[manual-lead-content] lead=${lead.id} pipeline failed:`,
      String((error as Error)?.message || error).slice(0, 200));
  }

  // 无论上面发生什么都要走到这里 —— 入池永不失败（规格第 8 节第一条）。
  return step.do<ManualLeadContentPoolOutcome>(
    'manual-lead-content:pool',
    poolStepConfig(),
    () => poolManualLeadContentEntry(env, lead, content, params.submitted_at),
  );
}
