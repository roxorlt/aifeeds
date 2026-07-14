// digest-node-run workflow:某推送节点到点,算 5 源榜单 + 节点标题摘要 + 给订阅起 deliver。
// 由 scheduled handler 在节点时间(UTC 0/4/9 = BJT 8/12/17,minute=0)create。
// 设计文档:roxor-main-design-20260528-090625.md

import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { Env } from '../index';
import { DIGEST_SOURCE_ORDER } from './config';
import { slotKey, bjtDateStr } from './lib';
import { pushDailyToCodex } from './codex-push';
import { runDailyPagePhase } from './daily-page-monitor';
import { rebuildDigestPoolSource, rebuildDigestPoolSubject } from './pool-rebuild';

interface NodeRunParams {
  slotHourBjt: number;
}

const RETRY = {
  retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' as const },
  timeout: '5 minutes',
} as const;

export class DigestNodeRunWorkflow extends WorkflowEntrypoint<Env, NodeRunParams> {
  async run(event: WorkflowEvent<NodeRunParams>, step: WorkflowStep) {
    const { slotHourBjt } = event.payload;
    const sk = slotKey(slotHourBjt);

    // Phase 1:各源算 normal(纯分 top N)+ curated(LLM 挑 M)榜单
    for (const source of DIGEST_SOURCE_ORDER) {
      // 2026-06-21 ClawHub(龙虾技能)退出订阅日报:仍保留 homepage 频道 + 对外 daily-api 源,
      // 但不入 digest_pool(省 curated LLM 调用)、不进订阅邮件。仅此一处下架,daily-api 不受影响。
      if (source === 'clawhub') continue;
      await step.do(`pool-${source}`, RETRY, async (): Promise<number> => {
        return (await rebuildDigestPoolSource(this.env, sk, source)).candidates;
      });
    }

    // Phase 1.5:节点级标题摘要
    await step.do('subject-digest', RETRY, async (): Promise<string> => {
      return rebuildDigestPoolSubject(this.env, sk);
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
