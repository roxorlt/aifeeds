// PR2 PushDeer 告警接入
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 11
// 实现参考：/Users/roxor/brain/30-projects/xueqiuFollow/src/notifier.py

import type { Env } from './index';

const PUSHDEER_ENDPOINT = 'https://api2.pushdeer.com/message/push';

export async function pushDeerAlert(
  env: Env,
  title: string,
  body: string,
): Promise<void> {
  const keysCsv = env.PUSHDEER_ADMIN_KEYS;
  if (!keysCsv) {
    console.warn('[notifier] PUSHDEER_ADMIN_KEYS not set, skip alert');
    return;
  }

  const keys = keysCsv.split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return;

  const fullTitle = `xList告警 | ${title}`;

  await Promise.allSettled(
    keys.map(async (key) => {
      try {
        const r = await fetch(PUSHDEER_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            pushkey: key,
            text: fullTitle,
            desp: body,
            type: 'markdown',
          }),
        });
        if (!r.ok) {
          console.error(`[pushdeer] ${r.status}`, await r.text());
          return;
        }
        const data = await r.json<{ code?: number; error?: string }>();
        if (data.code !== 0) {
          console.error('[pushdeer]', data);
        }
      } catch (e) {
        console.error('[pushdeer] exception', e);
      }
    }),
  );
}

/**
 * Cron 抓取轮次摘要推送。跟 pushDeerAlert 区别：
 * - 标题前缀 "aifeeds 抓取" 而非 "xList告警"（不是告警语义）
 * - result 对象自动格式化为 markdown bullet list
 * - 静默失败不抛错（cron 不该因推送失败而失败）
 *
 * 调用建议：cron handler 在 fetch 完成后用 ctx.waitUntil 异步推送，
 * 不阻塞 worker return：
 *   ctx.waitUntil(notifyCronSummary(env, 'PH daily fetch', result));
 */
export async function notifyCronSummary(
  env: Env,
  taskName: string,
  result: Record<string, unknown>,
): Promise<void> {
  const keysCsv = env.PUSHDEER_ADMIN_KEYS;
  if (!keysCsv) return; // 静默：没配置 key 直接跳过

  const keys = keysCsv.split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return;

  const title = `aifeeds 抓取 | ${taskName}`;

  // 字段名 i18n 映射（5 个 fetch handler 的 result 字段全覆盖）
  const FIELD_LABELS: Record<string, string> = {
    // 通用
    mode: '任务',
    error: '错误',
    errors: '错误数',
    skipped: '跳过原因',
    duration_ms: '耗时(毫秒)',
    success: '成功',
    // PH
    pt_date: 'PT 日期',
    list_size: '榜单大小',
    fetched: '抓取数',
    ingested: '入库结果',
    inserted: '新增',
    updated: '更新',
    // X list-poll
    tweets_seen: '推文总数',
    new_inserted: '新增入库',
    credits_used: 'SB 配额消耗',
    rate_limit_remaining: 'SB 配额余量',
    early_stop: '提前停止',
    // GH trending
    repos_seen: '仓库数',
    new_repos: '新增仓库',
    // ClawHub
    skills_seen: '技能数',
    new_skills: '新增技能',
    suspicious_count: '可疑数',
    // 活动行
    cities_done: '已完成城市',
    cities_pending: '待处理城市',
    events_seen: '活动数',
    new_events: '新增活动',
    enriched: '已丰富化',
  };
  const labelOf = (k: string): string => FIELD_LABELS[k] ?? k;

  // 把跳过原因也翻译
  const SKIP_REASON_CN: Record<string, string> = {
    sentinel: '已抓过（哨兵命中）',
    no_credentials: '凭证未配置',
    list_empty: '列表为空',
  };

  // 格式化 result 为 markdown bullet list。nested 对象（如 ingested）展开。
  const formatVal = (v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') {
      // nested object 展开为 子-key=value 形式
      const entries = Object.entries(v as Record<string, unknown>)
        .map(([sk, sv]) => `${labelOf(sk)}=${sv === null || sv === undefined ? '—' : sv}`)
        .join(' / ');
      return entries || '{}';
    }
    if (typeof v === 'string' && v in SKIP_REASON_CN) return SKIP_REASON_CN[v];
    return String(v);
  };

  const lines: string[] = [];
  for (const [k, v] of Object.entries(result)) {
    lines.push(`- **${labelOf(k)}**：${formatVal(v)}`);
  }
  // 加时间戳（北京时间）
  const bjt = new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  lines.push('');
  lines.push(`_北京时间：${bjt}_`);
  const body = lines.join('\n');

  await Promise.allSettled(
    keys.map(async (key, idx) => {
      const keyMask = key.length > 8 ? `${key.slice(0, 4)}...${key.slice(-4)}` : 'short';
      try {
        const r = await fetch(PUSHDEER_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            pushkey: key,
            text: title,
            desp: body,
            type: 'markdown',
          }),
        });
        const respText = await r.text();
        // 把 pushdeer 响应 always log（含成败），方便排查
        console.log(`[pushdeer-summary] key#${idx} (${keyMask}) HTTP ${r.status}: ${respText.slice(0, 300)}`);
      } catch (e) {
        console.error(`[pushdeer-summary] key#${idx} (${keyMask}) exception`, e);
      }
    }),
  );
}
