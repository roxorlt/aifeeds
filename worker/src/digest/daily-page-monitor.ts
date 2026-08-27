// SEO 日报页告警监控(#4,2026-07-07):两道防线
//   1. runDailyPagePhase —— node-run 早 8 点 Phase 4 的可测封装:包 generateDailyPage,
//      异常 → PushDeer 告警「[SEO] 日报页生成失败」;skipped(选品空)→ 告警「[SEO] 日报页跳过(选品空)」;
//      正常 → 静默。永不抛错(承接 Phase 4「任何异常绝不影响邮件/Codex」的容错语义)。
//   2. checkDailyPageFreshness —— 缺页兜底检查:较晚 tick(UTC 01:00)查当前受保护 release
//      head 的 promoted_at 是否晚于今天 UTC 0 点(=今天自然跑真发布了);无 head / 陈旧 head → 告警
//      「[SEO] 今日日报页未生成」。KV 标记当天只告一次。
//
// 拆成独立模块(不 import 'cloudflare:workers')以便 vitest 单测;node-run.ts / index.ts 引用。

import type { Env } from '../index';
import { pushDeerAlert } from '../notifier';
import { generateDailyPage } from './daily-page-run';
import { bjtDateStr } from './lib';
import { loadCurrentDailyReleaseForBuild } from './publication-release';

export interface DailyPagePhaseResult {
  date: string;
  skipped?: boolean;
  itemCount?: number;
  error?: string;
}

// Phase 4 封装:调 generateDailyPage,按结果发告警。永不抛错(返回 { error } 而非 throw)。
export async function runDailyPagePhase(env: Env, date: string): Promise<DailyPagePhaseResult> {
  try {
    const result = await generateDailyPage(env, date);
    if (result.skipped) {
      await pushDeerAlert(
        env,
        '[SEO] 日报页跳过(选品空)',
        `${date}:五源选品为空,未生成静态日报页(reason=${result.reason || 'empty_pool'})。`,
      );
      return { date, skipped: true, itemCount: result.itemCount };
    }
    return { date, skipped: false, itemCount: result.itemCount };
  } catch (e) {
    const msg = String(e).slice(0, 300);
    console.error(`[daily-page] Phase 4 生成失败: ${msg}`);
    await pushDeerAlert(env, '[SEO] 日报页生成失败', `${date}: ${msg}`);
    return { date, error: msg };
  }
}

export interface DailyPageFreshnessResult {
  date: string;                    // 检查的 BJT 日期
  fresh: boolean;                  // 今天有行且 generated_at 晚于今天 UTC 0 点
  generatedAt: string | null;     // 当前已授权 release head 的 promoted_at(无有效 head 则 null)
  alerted: boolean;               // 本次是否发了告警
  reason: 'fresh' | 'missing' | 'stale' | 'already_alerted';
}

// 缺页兜底检查。晚于自然跑(UTC 0 点)的 tick 调用(建议 UTC 01:00)。
// 今天(BJT date)当前 release head 的 promoted_at >= 今天 UTC 0 点 → 视为今天自然跑真发布了 → 静默;
// 无有效 head(missing)/ promoted_at 早于今天 UTC 0 点(stale)→ 发告警,KV 标记当天只告一次。
export async function checkDailyPageFreshness(env: Env): Promise<DailyPageFreshnessResult> {
  const date = bjtDateStr();
  const now = new Date();
  // 今天 UTC 0 点(墙钟午夜)的 epoch ms。promoted_at_ms 来自受 final guard 保护的 release head。
  const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  let generatedAt: string | null = null;
  try {
    const release = await loadCurrentDailyReleaseForBuild(env, date);
    if (release) generatedAt = new Date(Number(release.head.promoted_at_ms)).toISOString();
  } catch (error) {
    // A stale authorization/batch/source/item snapshot is equivalent to no public release.
    console.error('[daily-page] freshness release guard denied:', error);
  }
  let fresh = false;
  if (generatedAt) {
    const t = new Date(generatedAt).getTime();
    fresh = Number.isFinite(t) && t >= utcMidnight;
  }
  if (fresh) {
    return { date, fresh: true, generatedAt, alerted: false, reason: 'fresh' };
  }

  const reason: 'missing' | 'stale' = generatedAt ? 'stale' : 'missing';

  // 去重:当天只告一次(KV 标记,TTL 25h 自然过期)。无 KV 时降级 → 照发(不阻塞告警)。
  const dedupKey = `DAILY_PAGE_MISSING_ALERTED_${date}`;
  if (env.AUTH_KV) {
    if (await env.AUTH_KV.get(dedupKey)) {
      return { date, fresh: false, generatedAt, alerted: false, reason: 'already_alerted' };
    }
    await env.AUTH_KV.put(dedupKey, new Date().toISOString(), { expirationTtl: 25 * 3600 });
  }

  await pushDeerAlert(
    env,
    '[SEO] 今日日报页未生成',
    [
      `**${date}** 的 SEO 静态日报页在今天 UTC 0 点自然跑后仍未生成。`,
      generatedAt
        ? `- 当前 release head promoted_at=\`${generatedAt}\`,早于今天 UTC 0 点(疑似陈旧发布)`
        : `- 无通过当前授权 guard 的 \`${date}\` release head(Phase 4 未成功发布或发布后已失效)`,
      '',
      '排查:node-run 早 8 点 Phase 4 是否抛错 / publication gates / 当前 formal-news guard / R2·D1 写入是否失败',
    ].join('\n'),
  );

  return { date, fresh: false, generatedAt, alerted: true, reason };
}
