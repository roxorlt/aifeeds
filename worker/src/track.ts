// PR1 telemetry 上报 handler
// 设计：docs/plans/2026-05-01-auth-system-design.md § 9.2 + § 3.5

import type { Env } from './index';
import { getClientIp } from './client-ip';

// 与 dashboard/src/lib/telemetry/event-types.ts 保持一致
// 任一端新增事件类型时两边都要改
export const PERFORMANCE_EVENT_TYPES = [
  'perf_lcp', 'perf_inp', 'perf_cls', 'perf_ttfb', 'perf_fcp', 'perf_nav', 'perf_img',
  'perf_api', 'feed_ready',
] as const;
const PERFORMANCE_EVENT_TYPE_SET = new Set<string>(PERFORMANCE_EVENT_TYPES);

const EVENT_TYPE_WHITELIST = new Set<string>([
  // 导航
  'app_open', 'page_view', 'session_start', 'session_end',
  // 内容
  'item_impression', 'item_click', 'item_open_drawer', 'item_close_drawer',
  'thread_expand', 'image_lightbox_open', 'external_link_click',
  // 筛选
  'source_filter_change', 'sort_change', 'new_content_banner_click',
  // 分享
  'share_click', 'share_landing',
  // 登录（PR2/3 才会真发，但白名单提前留好）
  'login_modal_open', 'sms_send_attempt', 'sms_send_success',
  'code_verify_attempt', 'login_success', 'logout', 'account_delete',
  // 互动（PR5 才会真发）
  'favorite_toggle', 'subscribe_toggle',
  // 视频起播（诊断 mobile/微信 autoplay 受限）
  'video_autoplay_attempt', 'video_autoplay_blocked', 'video_play_start',
  // 视频有效播放（连续播放 ≥3s，IAB/Twitter/Meta 短视频 view 标准）
  'video_effective_play',
  // 性能(web-vitals + navigation timing)。perf_fcp 之前漏了白名单被丢弃 ——
  // iOS 微信 WKWebView 不支持 LCP observer,FCP 是该设备唯一的 paint 信号,必须收。
  ...PERFORMANCE_EVENT_TYPES,
  // 错误
  'js_error', 'unhandled_promise', 'api_error', 'image_load_error',
  'feed_load_error',
  // C 端搜索（Task 6）：起始页打开 / 提交 / 联想点击 / 结果点击 / 空结果 / 错误 / 性能
  'search_open', 'search_submit', 'search_suggest_click', 'search_result_click',
  'search_empty', 'search_error', 'search_perf',
]);

const MAX_PAYLOAD_BYTES = 8 * 1024;     // 单条事件 payload ≤ 8KB
const MAX_BATCH_SIZE = 50;              // 单次请求最多 50 条事件
const MAX_BODY_BYTES = 256 * 1024;      // 请求 body 总大小 ≤ 256KB（防爆量）

interface EdgeCfProperties {
  country?: unknown;
  colo?: unknown;
}

export type PreparedEventPayload =
  | { ok: true; value: string | null }
  | { ok: false; error: 'payload too large' };

function trustedEdgeCode(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.toUpperCase();
  return pattern.test(normalized) ? normalized : undefined;
}

export function prepareEventPayload(
  eventType: string,
  clientPayload: Record<string, unknown> | undefined,
  cf: EdgeCfProperties | undefined,
  maxBytes: number = MAX_PAYLOAD_BYTES,
): PreparedEventPayload {
  let payload = clientPayload;
  if (PERFORMANCE_EVENT_TYPE_SET.has(eventType)) {
    // edge_* 只信 Worker request.cf。客户端同名值即使 cf 缺失也要删除，避免伪造 cohort。
    payload = { ...(clientPayload ?? {}) };
    delete payload.edge_country;
    delete payload.edge_colo;
    const country = trustedEdgeCode(cf?.country, /^[A-Z0-9]{2}$/);
    const colo = trustedEdgeCode(cf?.colo, /^[A-Z0-9]{3}$/);
    if (country) payload.edge_country = country;
    if (colo) payload.edge_colo = colo;
  }

  const value = payload ? JSON.stringify(payload) : null;
  if (value && new TextEncoder().encode(value).byteLength > maxBytes) {
    return { ok: false, error: 'payload too large' };
  }
  return { ok: true, value };
}

interface ClientEvent {
  type: string;
  payload?: Record<string, unknown>;
  occurred_at: number;          // 客户端时间 (ms)
  page_path?: string;
}

interface TrackRequest {
  events: ClientEvent[];
  session_token_hash?: string;  // 前端 SDK 生成的会话 hash
  _did?: string;                // pagehide sendBeacon 通道:无法带自定义 header,did 落 body(queue.ts:78)
}

export async function handleTrack(request: Request, env: Env): Promise<Response> {
  // 1. X-Device-Id(header 优先;sendBeacon 不能带自定义 header,fallback 读 body._did,
  //    否则 pagehide flush 一律 400 丢埋点 — 2026-06-11 staging 验收实测)
  const headerDid = request.headers.get('X-Device-Id');

  // 2. body 大小限制
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonError('payload too large', 413);
  }

  // 3. 解析 JSON
  let body: TrackRequest;
  try {
    body = await request.json() as TrackRequest;
  } catch {
    return jsonError('invalid json', 400);
  }

  const deviceId = headerDid || (typeof body._did === 'string' ? body._did : null);
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
    return jsonError('missing or invalid X-Device-Id', 400);
  }

  if (!body || !Array.isArray(body.events)) {
    return jsonError('events[] required', 400);
  }
  if (body.events.length === 0 || body.events.length > MAX_BATCH_SIZE) {
    return jsonError(`events length must be 1..${MAX_BATCH_SIZE}`, 400);
  }

  // 4. 抽出 IP / UA / Referer (从请求 headers)
  const ip = getClientIp(request, env);
  const ua = request.headers.get('User-Agent') || '';
  const referer = request.headers.get('Referer') || '';
  const ingestedAt = Date.now();
  const cf = (request as Request & { cf?: EdgeCfProperties }).cf;

  // 5. 校验 + 写入
  const stmts: D1PreparedStatement[] = [];
  const errors: string[] = [];

  for (let i = 0; i < body.events.length; i++) {
    const e = body.events[i];

    if (typeof e.type !== 'string' || !EVENT_TYPE_WHITELIST.has(e.type)) {
      errors.push(`events[${i}].type invalid: ${e.type}`);
      continue;
    }
    if (typeof e.occurred_at !== 'number' || e.occurred_at <= 0) {
      errors.push(`events[${i}].occurred_at invalid`);
      continue;
    }

    const preparedPayload = prepareEventPayload(e.type, e.payload, cf);
    if (!preparedPayload.ok) {
      errors.push(`events[${i}].payload too large`);
      continue;
    }
    const payloadStr = preparedPayload.value;

    stmts.push(
      env.DB.prepare(`
        INSERT INTO events
          (device_id, session_token_hash, event_type, event_payload,
           ip, ua, referer, page_path, occurred_at, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        deviceId,
        body.session_token_hash || null,
        e.type,
        payloadStr,
        ip,
        ua,
        referer,
        e.page_path || null,
        e.occurred_at,
        ingestedAt,
      ),
    );
  }

  if (stmts.length === 0) {
    return jsonError('no valid events', 400, { errors });
  }

  // 6. batch 写入
  await env.DB.batch(stmts);

  return jsonOk({ accepted: stmts.length, rejected: errors.length, errors: errors.length ? errors : undefined });
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message: string, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
