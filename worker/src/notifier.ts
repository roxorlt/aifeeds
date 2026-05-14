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

  // skip reason 字符串翻译（PH 用）
  const SKIP_REASON_CN: Record<string, string> = {
    sentinel: '已抓过（哨兵命中）',
    no_credentials: '凭证未配置',
    list_empty: '列表为空',
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
