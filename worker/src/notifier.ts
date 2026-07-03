// PR2 PushDeer 告警接入
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 11
// 实现参考：/Users/roxor/brain/30-projects/xueqiuFollow/src/notifier.py
//
// 2026-05-25 告警分级 Phase A:
//   critical = pushDeerAlert(...)           → 立即推送
//   warning  = pushDeerWarning(env, ...)    → KV ring buffer 攒批,每日 UTC 23:00 推日报
//   info     = console.log + Workers Logs   → 不推 PushDeer
//
// 痛点:旧版所有 PushDeer 同优先级 → 半夜被 80% 用量警告吵 → user 学会忽略
// → 真出事(cookie 失效 / cron 全挂)反应慢。
//
// Phase A 落地基础设施 + 改造已知低优先级 call sites(80% 用量类)。
// Phase B(follow-up)再加业务级规则("scrape 0 new 持续 3 轮" /
// "翻译失败率 > 5%" / "metrics 覆盖率跌破 90%")。

import type { Env } from './index';

const PUSHDEER_ENDPOINT = 'https://api2.pushdeer.com/message/push';

// 攒批 warning 用的 KV key + buffer 上限
const WARNING_BUFFER_KEY = 'PUSHDEER_WARNING_BUFFER';
const WARNING_BUFFER_MAX = 200; // 防止 KV value 过大(单 value 25MB,200 条够撑日内任意流量)
const WEIBO_COOKIE_ALERT_KEY = 'WEIBO_COOKIE_INVALID_ALERTED';

export interface WarningEntry {
  title: string;
  body: string;
  at: string; // ISO timestamp
}

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
 * Warning 级别告警:不立即推送,写 KV ring buffer 攒批,
 * 每日 UTC 23:00 (BJT 07:00) cron 触发 sendDailyWarningDigest 推一次日报。
 *
 * 用于:配额 80% 警告 / 单批失败但不阻塞流程 / metrics 抖动 / 其他可延迟处理的提醒。
 * Critical 紧急情况(整 cron 挂 / cookie 失效 / 配额 95%)仍用 pushDeerAlert 立即推送。
 *
 * 设计:
 * - KV 单值存 JSON Array<{title, body, at}>,append-only 直到 digest flush
 * - 超过 WARNING_BUFFER_MAX 时 trim 最老的(LIFO)防 KV value 撑爆
 * - AUTH_KV 未配置时降级 → 直接 console.warn(本地 dev / 测试场景兼容)
 */
export async function pushDeerWarning(
  env: Env,
  title: string,
  body: string,
): Promise<void> {
  // 无 KV 时降级日志,保留可观测性
  if (!env.AUTH_KV) {
    console.warn(`[pushdeer-warning|no-kv] ${title}: ${body.slice(0, 200)}`);
    return;
  }
  const entry: WarningEntry = {
    title,
    body,
    at: new Date().toISOString(),
  };
  // 读老 buffer + append + 写回(KV 没有 atomic append,接受微小并发覆盖风险 —
  // worst case 高并发瞬间丢 1-2 条 warning,可接受;digest 还在第二天发)
  let buffer: WarningEntry[] = [];
  try {
    const raw = await env.AUTH_KV.get(WARNING_BUFFER_KEY);
    if (raw) buffer = JSON.parse(raw) as WarningEntry[];
  } catch {
    buffer = [];
  }
  buffer.push(entry);
  // Trim 防爆:保留最新 WARNING_BUFFER_MAX 条
  if (buffer.length > WARNING_BUFFER_MAX) {
    buffer = buffer.slice(-WARNING_BUFFER_MAX);
  }
  // 写回 + TTL 25h 兜底(若 daily cron 漏跑两天,KV 自然过期防积累)
  await env.AUTH_KV.put(WARNING_BUFFER_KEY, JSON.stringify(buffer), {
    expirationTtl: 25 * 3600,
  });
  console.log(`[pushdeer-warning|buffered] ${title} (buffer size: ${buffer.length})`);
}

export async function notifyWeiboCookieInvalid(
  env: Env,
  reason: string,
): Promise<void> {
  if (env.AUTH_KV) {
    const existing = await env.AUTH_KV.get(WEIBO_COOKIE_ALERT_KEY);
    if (existing) {
      console.warn(`[weibo-cookie] suppress duplicate alert: ${reason.slice(0, 160)}`);
      return;
    }
    await env.AUTH_KV.put(
      WEIBO_COOKIE_ALERT_KEY,
      new Date().toISOString(),
      { expirationTtl: 25 * 3600 },
    );
  }

  await pushDeerAlert(
    env,
    '微博 Cookie 失效',
    [
      '微博科技热搜 RSSHub 路由返回 cookie 缺失或失效。',
      '',
      `- Secret 文件: \`/Users/roxor/brain/30-projects/aifeeds/.secrets/aifeeds-prod.env\``,
      '- 变量名: `WEIBO_COOKIES`',
      `- 错误: \`${reason.slice(0, 300)}\``,
    ].join('\n'),
  );
}

/**
 * Daily UTC 23:00 (BJT 07:00) cron 触发,flush warning buffer 推一次合并日报。
 * 推送完清空 KV buffer。
 *
 * 推送格式:
 *   标题:"📋 aifeeds 日报 | N 条 warning (YYYY-MM-DD)"
 *   正文:按 warning title 分组 + 每条带时间戳
 *
 * 没 warning 不推(避免无意义打扰)。
 */
export async function sendDailyWarningDigest(env: Env): Promise<{
  warnings: number;
  pushed: boolean;
  reason?: string;
}> {
  if (!env.AUTH_KV) return { warnings: 0, pushed: false, reason: 'no_kv' };
  if (!env.PUSHDEER_ADMIN_KEYS) return { warnings: 0, pushed: false, reason: 'no_keys' };

  let buffer: WarningEntry[] = [];
  try {
    const raw = await env.AUTH_KV.get(WARNING_BUFFER_KEY);
    if (raw) buffer = JSON.parse(raw) as WarningEntry[];
  } catch {
    buffer = [];
  }
  if (buffer.length === 0) {
    return { warnings: 0, pushed: false, reason: 'empty' };
  }

  // 按 title 分组,每组列时间戳
  const groups = new Map<string, WarningEntry[]>();
  for (const e of buffer) {
    const arr = groups.get(e.title) || [];
    arr.push(e);
    groups.set(e.title, arr);
  }
  const bjtDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const title = `📋 aifeeds 日报 | ${buffer.length} 条 warning (${bjtDate})`;
  const lines: string[] = [];
  for (const [groupTitle, entries] of groups) {
    lines.push(`### ${groupTitle} × ${entries.length}`);
    for (const e of entries) {
      const bjt = new Date(new Date(e.at).getTime() + 8 * 3600 * 1000)
        .toISOString().replace('T', ' ').slice(0, 19);
      lines.push(`- _${bjt}_ ${e.body}`);
    }
    lines.push('');
  }
  const body = lines.join('\n');

  // 推送 + 成功后清空 buffer
  const keys = env.PUSHDEER_ADMIN_KEYS.split(',').map((k) => k.trim()).filter(Boolean);
  await Promise.allSettled(
    keys.map((key) =>
      fetch(PUSHDEER_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ pushkey: key, text: title, desp: body, type: 'markdown' }),
      })
    ),
  );
  // 清 buffer(即使 PushDeer 部分失败也清 — 重试机制由 buffer 自然累计承担)
  await env.AUTH_KV.delete(WARNING_BUFFER_KEY);
  console.log(`[pushdeer-digest] flushed ${buffer.length} warnings`);
  return { warnings: buffer.length, pushed: true };
}

// ═══════════════════════════════════════════════════════════════════
// Phase B 业务级告警 (2026-05-27)
// ═══════════════════════════════════════════════════════════════════

// 从各 source cron summary result 提取 "新增" 数。返回 NaN 表示无字段(不计入 streak)。
// 字段优先级:
//   X list:    newly_inserted
//   HDX:       cards_inserted_or_updated
//   GH/CH:     inserted (顶层)
//   PH:        ingested.inserted (嵌套对象)
//   HF:        fetched_details / ingested.inserted (复合,fetched_details 是 paper 数)
function extractNewCount(result: Record<string, unknown>): number {
  if (typeof result.newly_inserted === 'number') return result.newly_inserted;
  if (typeof result.cards_inserted_or_updated === 'number') return result.cards_inserted_or_updated;
  if (typeof result.inserted === 'number') return result.inserted;
  const ingested = result.ingested as Record<string, unknown> | undefined;
  if (ingested && typeof ingested.inserted === 'number') return ingested.inserted;
  if (typeof result.fetched_details === 'number') return result.fetched_details;
  if (typeof result.fetched === 'number') return result.fetched;
  return NaN;
}

const ZERO_STREAK_THRESHOLD = 3;  // 连续 3 轮 = 0 触发 critical
const ZERO_STREAK_BUFFER_MAX = 6; // 保留最近 6 轮足以判断 3 轮 streak

// 检查 source 的 "scrape 0 new" streak。每次 cron summary 调用一次。
// streak >= 3 时立即推送 critical(去重:同一天同一 source 只推一次)。
export async function checkZeroStreak(
  env: Env,
  sourceKey: string,      // 短 key (ph / hf / x / hdx / gh / clawhub) - KV 命名用
  taskName: string,       // 中文展示名 ("PH 每日抓取" 等) - alert body 用
  result: Record<string, unknown>,
): Promise<void> {
  if (!env.AUTH_KV) return; // 无 KV 静默跳过
  const count = extractNewCount(result);
  if (Number.isNaN(count)) return; // 无 "新增" 字段(可能是错误 result),不计 streak

  const bufKey = `ZERO_STREAK_${sourceKey}`;
  let buffer: Array<{ at: string; count: number }> = [];
  try {
    const raw = await env.AUTH_KV.get(bufKey);
    if (raw) buffer = JSON.parse(raw);
  } catch { /* ignore */ }
  buffer.push({ at: new Date().toISOString(), count });
  if (buffer.length > ZERO_STREAK_BUFFER_MAX) {
    buffer = buffer.slice(-ZERO_STREAK_BUFFER_MAX);
  }
  // KV TTL 比 buffer 长一点防边界:任一 source 7 天没跑 cron 自然清(也算告警)
  await env.AUTH_KV.put(bufKey, JSON.stringify(buffer), { expirationTtl: 7 * 24 * 3600 });

  // 检查连续 3 轮 0
  if (buffer.length < ZERO_STREAK_THRESHOLD) return;
  const lastN = buffer.slice(-ZERO_STREAK_THRESHOLD);
  const allZero = lastN.every((e) => e.count === 0);
  if (!allZero) return;

  // 去重:同一 source 同一 UTC date 只推一次 critical(避免每轮反复推)
  const utcDate = new Date().toISOString().slice(0, 10);
  const dedupKey = `ZERO_STREAK_ALERTED_${sourceKey}_${utcDate}`;
  if (await env.AUTH_KV.get(dedupKey)) return;
  await env.AUTH_KV.put(dedupKey, '1', { expirationTtl: 25 * 3600 });

  const span = lastN.map((e) => {
    const bjt = new Date(new Date(e.at).getTime() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    return `_${bjt}_ count=${e.count}`;
  }).join('\n- ');
  await pushDeerAlert(
    env,
    `⚠️ ${taskName} 连续 ${ZERO_STREAK_THRESHOLD} 轮 0 新增`,
    `**${taskName}** 最近 ${ZERO_STREAK_THRESHOLD} 轮抓取都 0 新增,可能源 API / scraper 异常:\n- ${span}\n\n建议排查:\n- 数据源 API 是否限流 / 改协议\n- 抓取代码是否解析失败\n- 翻译 / classify 流程是否堵塞`,
  );
}

// 每日健康检查:翻译失败率 (critical >5%) + X metrics 覆盖率 (warning <90%)
export async function runDailyHealthChecks(env: Env): Promise<{
  checks_run: number;
  alerts_critical: number;
  alerts_warning: number;
  details: Record<string, unknown>;
}> {
  if (!env.DB) {
    return { checks_run: 0, alerts_critical: 0, alerts_warning: 0, details: { skipped: 'no_db' } };
  }
  let criticals = 0;
  let warnings = 0;
  const details: Record<string, unknown> = {};

  // ─── Check 1: 翻译失败率 by source(7d 滚动窗) ────────────────
  // 标准:translation_failed_at IS NOT NULL OR x_article.translate_failed_at 存在
  // 分母:7d 内 workflow_completed_at 写过的 item
  // 5% 阈值仅对样本 >= 50 的 source 触发(避免小样本噪声)
  try {
    const failedRows = await env.DB.prepare(
      `SELECT source_type,
              COUNT(*) as total,
              SUM(CASE WHEN json_extract(extra, '$.translation_failed_at') IS NOT NULL THEN 1 ELSE 0 END) as failed
         FROM items
        WHERE deleted_at IS NULL
          AND CAST(strftime('%s', scraped_at) AS INTEGER) >= strftime('%s', 'now', '-7 days')
          AND json_extract(extra, '$.workflow_completed_at') IS NOT NULL
        GROUP BY source_type`,
    ).all<{ source_type: string; total: number; failed: number }>();
    const failRates: Array<{ source: string; total: number; failed: number; pct: string }> = [];
    for (const r of failedRows.results) {
      const pct = r.total > 0 ? (r.failed * 100) / r.total : 0;
      failRates.push({ source: r.source_type, total: r.total, failed: r.failed, pct: pct.toFixed(2) + '%' });
      if (r.total >= 50 && pct > 5) {
        criticals++;
        await pushDeerAlert(
          env,
          `⚠️ ${r.source_type} 翻译失败率 ${pct.toFixed(1)}%`,
          `**${r.source_type}** 7 天滚动窗:\n- 完成 workflow: ${r.total} 条\n- 翻译失败: ${r.failed} 条 (${pct.toFixed(2)}%)\n- 阈值 5% 已触发\n\n排查 DeepSeek 余额 / 翻译 prompt 是否退化 / network 抖动`,
        );
      }
    }
    details.translation_fail_rates = failRates;
  } catch (e) {
    console.warn('[health-check] translation fail rate query failed:', e);
    details.translation_fail_rates_error = String(e).slice(0, 200);
  }

  // ─── Check 2: X metrics 覆盖率(warning,数据质量) ─────────────
  // metrics 字段 retweets / views / replies 在 X 推文里应该都 >= 0(用 ScrapeBadger
  // batch refresh 拉)。如果非 null 比例 < 90% 说明 refresh 跑不到。
  // 只查最近 30 天 x_list item,避免老数据 noise。
  try {
    const xMetrics = await env.DB.prepare(
      `SELECT
         COUNT(*) as total,
         SUM(CASE WHEN json_extract(metrics, '$.retweets') IS NOT NULL THEN 1 ELSE 0 END) as has_retweets,
         SUM(CASE WHEN json_extract(metrics, '$.views') IS NOT NULL THEN 1 ELSE 0 END) as has_views,
         SUM(CASE WHEN json_extract(metrics, '$.replies') IS NOT NULL THEN 1 ELSE 0 END) as has_replies
       FROM items
       WHERE source_type='x_list' AND deleted_at IS NULL
         AND CAST(strftime('%s', scraped_at) AS INTEGER) >= strftime('%s', 'now', '-30 days')`,
    ).first<{ total: number; has_retweets: number; has_views: number; has_replies: number }>();
    if (xMetrics && xMetrics.total >= 50) {
      const coverage = {
        retweets: (xMetrics.has_retweets * 100) / xMetrics.total,
        views: (xMetrics.has_views * 100) / xMetrics.total,
        replies: (xMetrics.has_replies * 100) / xMetrics.total,
      };
      const below: string[] = [];
      for (const [field, pct] of Object.entries(coverage)) {
        if (pct < 90) below.push(`${field}: ${pct.toFixed(1)}%`);
      }
      details.x_metrics_coverage = {
        sample_size: xMetrics.total,
        retweets_pct: coverage.retweets.toFixed(1),
        views_pct: coverage.views.toFixed(1),
        replies_pct: coverage.replies.toFixed(1),
        below_90: below,
      };
      if (below.length > 0) {
        warnings++;
        await pushDeerWarning(
          env,
          'X metrics 覆盖率跌破 90%',
          `**X 推文 metrics 字段覆盖率(30 天滚动窗,样本 ${xMetrics.total}):\n- 跌破 90% 的字段: ${below.join(' / ')}\n\n排查 ScrapeBadger refresh-tiered cron 是否跑 / 字段映射是否漂移`,
        );
      }
    }
  } catch (e) {
    console.warn('[health-check] x metrics coverage query failed:', e);
    details.x_metrics_coverage_error = String(e).slice(0, 200);
  }

  // ─── Check 3: digest 投递成功率(7d 滚动,warning) ─────────────
  // 分母:7d 内 sent + failed_resend;成功率 < 95% 且样本 >= 20 触发
  try {
    const send = await env.DB.prepare(
      `SELECT COUNT(*) as total,
              SUM(CASE WHEN status='sent' THEN 1 ELSE 0 END) as sent
         FROM digest_send_log
        WHERE status IN ('sent','failed_resend')
          AND sent_at >= (unixepoch()*1000 - 7*86400000)`,
    ).first<{ total: number; sent: number }>();
    if (send && send.total >= 20) {
      const pct = (send.sent * 100) / send.total;
      details.digest_send_success = { total: send.total, sent: send.sent, pct: pct.toFixed(1) + '%' };
      if (pct < 95) {
        warnings++;
        await pushDeerWarning(
          env,
          'digest 投递成功率跌破 95%',
          `digest 邮件投递(7 天滚动,样本 ${send.total}):\n- 成功 ${send.sent} / ${send.total} = ${pct.toFixed(1)}%\n- 阈值 95% 已触发\n\n排查 Resend 配额 / API 故障 / 域名信誉`,
        );
      }
    }
  } catch (e) {
    console.warn('[health-check] digest send rate query failed:', e);
    details.digest_send_rate_error = String(e).slice(0, 200);
  }

  return { checks_run: 3, alerts_critical: criticals, alerts_warning: warnings, details };
}

/**
 * Cron 抓取轮次摘要推送。跟 pushDeerAlert 区别：
 * - 标题前缀 "aifeeds 抓取" 而非 "xList告警"（不是告警语义）
 * - result 对象自动格式化为 markdown bullet list
 * - 静默失败不抛错（cron 不该因推送失败而失败）
 *
 * 2026-05-27 加 Phase B 业务规则:内部调 checkZeroStreak 监控 "连续 N 轮 0 新增"。
 * sourceKey 用 PH/HF/X/HDX/GH/CH 等短 key,作 KV 命名 + dedup。
 *
 * 调用建议：cron handler 在 fetch 完成后用 ctx.waitUntil 异步推送，
 * 不阻塞 worker return：
 *   ctx.waitUntil(notifyCronSummary(env, 'ph', 'PH 每日抓取', result));
 */
// taskName → sourceKey 映射(KV 命名 + dedup 用)。新 taskName 加进来即可。
// 多个 taskName 可以映射到同一 sourceKey(例如 hdx start/continue 都算 hdx)。
function inferSourceKey(taskName: string): string | null {
  if (taskName.startsWith('PH ')) return 'ph';
  if (taskName.startsWith('HF ')) return 'hf';
  if (taskName.startsWith('X List')) return 'x';
  if (taskName.startsWith('活动行')) return 'hdx';  // start + continue 都映射到 hdx
  if (taskName.startsWith('GitHub')) return 'gh';
  if (taskName.startsWith('ClawHub')) return 'clawhub';
  return null;
}

export async function notifyCronSummary(
  env: Env,
  taskName: string,
  result: Record<string, unknown>,
): Promise<void> {
  // Phase B 业务规则:连续 N 轮 0 新增触发 critical。不阻塞通知主流程
  // (Promise.allSettled 等价 — 任一异常都不影响 cron 摘要推送)。
  const sourceKey = inferSourceKey(taskName);
  if (sourceKey) {
    try {
      await checkZeroStreak(env, sourceKey, taskName, result);
    } catch (e) {
      console.warn(`[zero-streak] check failed for ${sourceKey}:`, e);
    }
  }

  const keysCsv = env.PUSHDEER_ADMIN_KEYS;
  if (!keysCsv) return; // 静默：没配置 key 直接跳过

  const keys = keysCsv.split(',').map((k) => k.trim()).filter(Boolean);
  if (keys.length === 0) return;

  // 2026-05-21 加 ⚠️ alert prefix:HF prod 跑 3 天 skipped='no_token'(HF_READ secret 漏 push)
  // 静默退出,用户察觉不到。alarming reason 让 title 自带警告标识 + 通知凸显。
  const CONCERNING_SKIP_REASONS = new Set([
    'no_token',         // HF — env.HF_READ 缺失
    'no_credentials',   // PH — env.PH_CLIENT_ID/SECRET 缺失
    'fetch_failed',     // 任意源网络失败
    'list_empty',       // 通常 transient,但若持续多天可能是 API 端 break
  ]);
  const skipReason = typeof result.skipped === 'string' ? result.skipped : null;
  const isConcerning = skipReason !== null && CONCERNING_SKIP_REASONS.has(skipReason);
  const title = `${isConcerning ? '⚠️ ' : ''}aifeeds 抓取 | ${taskName}`;

  // 字段名 i18n 映射。对照 5 个 fetch handler 的真实 return 字段（一一核对过）：
  // - PH:      worker/src/scrapers/ph.ts runPhDailyFetch
  // - X:       worker/src/enrich.ts runListPollIngest（ListPollIngestResult）
  // - GH:      worker/src/github.ts runGithubFetchTrending
  // - ClawHub: worker/src/clawhub.ts runClawhubFetchList
  // - 活动行:  worker/src/scrapers/huodongxing.ts runHuodongxingFetchList
  const FIELD_LABELS: Record<string, string> = {
    // 通用
    mode: '任务',
    error: '错误',
    duration_ms: '耗时(毫秒)',

    // PH（runPhDailyFetch）
    pt_date: 'PT 日期',
    list_size: '榜单大小',
    fetched: '抓取数',
    ingested: '入库结果',
    inserted: '新增',
    updated: '更新',

    // X list-poll（runListPollIngest，ScrapeBadger API）
    // 注意 credits_used / rate_limit_remaining 的语义（容易被误读）：
    //   - credits_used 是本次调用的成本（≈抓回条数），不是账户总配额消耗
    //   - rate_limit_remaining 是短时限流窗口剩余请求数（如 60/min），
    //     不是账户总余额（账户余额要另外查 ScrapeBadger 后台）
    list_id: 'List ID',
    pages: '翻页数',
    tweets_seen: '本轮抓到推文数',
    inserted_or_updated: '新增或覆盖数',
    newly_inserted: '新增入库数',
    credits_used: '本轮消耗 credits',
    rate_limit_remaining: '短时限流余量',
    early_stop: '提前停止',

    // GH trending（runGithubFetchTrending）
    parsed: '解析仓库数',
    updated_seen: '已存在覆盖数',
    // inserted / errors 复用上方

    // ClawHub（runClawhubFetchList）
    total_unique: '去重后总数',
    // inserted / updated / skipped / errors 视语义动态翻译（见下）

    // 活动行（runHuodongxingFetchList）
    cities_processed: '本轮处理城市数',
    cities_remaining: '剩余待处理城市数',
    pages_fetched: '抓取页数',
    cards_inserted_or_updated: '入库或更新活动数',
    budget_consumed: '本轮 CF 子请求数', // CF Workers subrequest 计数（默认 40/tick）
    finished: '是否全部完成',

    // HF Daily Papers(runHfDailyFetch + backfill-hf-paper-workflow)
    date: '日期',
    fetched_details: 'paper 详情抓取数',
    fetched_categories: 'arxiv 分类抓取数',
    triggered: '触发 workflow 数',
    workflow_completed_24h: '24 小时内 workflow 完成数',
    workflow_pending_24h: '24 小时内 workflow 待完成数',
    sampled_completed_paper: '已完成采样 paper 数',
    found: '待回填条数',
    elapsed_ms: '耗时(毫秒)',
    estimated_workflow_completion_min: '预估 workflow 完成时间(分钟)',
  };

  // skipped / errors 在不同源里语义不一样：
  //   PH: skipped 是 string（"sentinel" / "no_credentials" / "list_empty"），errors 是 number
  //   ClawHub: skipped 是 number（被跳过条数），errors 是 string[]（错误信息列表）
  //   GH: errors 是 number
  //   活动行: errors 是 string[]（错误信息列表）
  // 这里按 value 类型动态翻译 key，避免歧义。
  const labelOf = (k: string, v: unknown): string => {
    if (k === 'skipped') {
      return typeof v === 'string' ? '跳过原因' : '跳过条数';
    }
    if (k === 'errors') {
      return Array.isArray(v) ? '错误明细' : '错误数';
    }
    return FIELD_LABELS[k] ?? k;
  };

  // skip reason 字符串翻译（PH / HF / 通用）
  const SKIP_REASON_CN: Record<string, string> = {
    sentinel: '已抓过（哨兵命中）',
    no_credentials: '⚠️ 凭证未配置(PH_CLIENT_ID / SECRET 缺失)',
    no_token: '⚠️ Token 未配置(HF_READ secret 缺失)',
    list_empty: '⚠️ 列表为空(可能源 API 异常)',
    fetch_failed: '⚠️ 抓取失败(网络 / 远端 500)',
  };

  // 格式化 value：nested 对象展开为 "子key=value / 子key=value"；数组用分号连接
  const formatVal = (k: string, v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (Array.isArray(v)) {
      if (v.length === 0) return '无';
      return v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join('；');
    }
    if (typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>)
        .map(([sk, sv]) => `${labelOf(sk, sv)}=${sv === null || sv === undefined ? '—' : sv}`)
        .join(' / ');
      return entries || '{}';
    }
    if (k === 'skipped' && typeof v === 'string' && v in SKIP_REASON_CN) {
      return SKIP_REASON_CN[v];
    }
    if (typeof v === 'boolean') return v ? '是' : '否';
    return String(v);
  };

  const lines: string[] = [];
  for (const [k, v] of Object.entries(result)) {
    lines.push(`- **${labelOf(k, v)}**：${formatVal(k, v)}`);
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
