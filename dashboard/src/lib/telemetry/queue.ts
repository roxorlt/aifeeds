// telemetry 批量上报队列
// 触发：≥ 10 条 或 ≥ 5s 间隔
// 失败重试：3 次指数退避（1s / 4s / 16s）
// 持久化：未发出的事件存 LocalStorage，下次启动时优先 flush

import type { TelemetryEvent, TrackRequestBody, TrackResponse } from './types';
import { getDeviceId } from '../device';

const STORAGE_KEY = 'xlist_telemetry_pending';
const BATCH_SIZE = 10;
const FLUSH_INTERVAL_MS = 5_000;
const MAX_PENDING = 200;             // 持久化上限，防 LocalStorage 爆掉
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];

let queue: TelemetryEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let endpoint = '';                   // init 时设置
let sessionTokenHashGetter: () => string | undefined = () => undefined;

export function initQueue(opts: {
  endpoint: string;
  sessionTokenHashGetter?: () => string | undefined;
}): void {
  endpoint = opts.endpoint;
  if (opts.sessionTokenHashGetter) sessionTokenHashGetter = opts.sessionTokenHashGetter;

  // 启动时 load 持久化的待发事件
  const pending = loadPending();
  if (pending.length) {
    queue.push(...pending);
    clearPending();
    scheduleFlush(0);   // 立刻 flush
  }
}

export function enqueue(event: TelemetryEvent): void {
  queue.push(event);
  if (queue.length >= BATCH_SIZE) {
    void flush();
  } else {
    scheduleFlush(FLUSH_INTERVAL_MS);
  }
}

function scheduleFlush(delayMs: number): void {
  if (flushTimer) return;             // 已有 timer 不重复
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delayMs);
}

export async function flush(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (queue.length === 0) return;

  const batch = queue.splice(0, queue.length);
  await sendWithRetry(batch);
}

/**
 * 同步 flush — 用于 pagehide 事件（sendBeacon 兜底见 beacon.ts）。
 * 不等响应，直接 fire-and-forget。
 */
export function flushSync(useBeacon: boolean = true): void {
  if (queue.length === 0) return;
  const batch = queue.splice(0, queue.length);
  const body: TrackRequestBody = {
    events: batch,
    session_token_hash: sessionTokenHashGetter(),
  };
  const json = JSON.stringify(body);

  if (useBeacon && typeof navigator !== 'undefined' && navigator.sendBeacon) {
    // sendBeacon 不能传 X-Device-Id header，把 did 塞进 body
    const blob = new Blob([JSON.stringify({ ...body, _did: getDeviceId() })], {
      type: 'application/json',
    });
    const ok = navigator.sendBeacon(endpoint, blob);
    if (!ok) {
      // beacon 失败，存 localStorage 等下次
      persistPending(batch);
    }
    return;
  }

  // 兜底：同步 fetch（关闭 tab 时可能丢，但已经是 best effort）
  try {
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': getDeviceId(),
      },
      body: json,
      keepalive: true,
    }).catch(() => persistPending(batch));
  } catch {
    persistPending(batch);
  }
}

async function sendWithRetry(events: TelemetryEvent[], attempt = 0): Promise<void> {
  const body: TrackRequestBody = {
    events,
    session_token_hash: sessionTokenHashGetter(),
  };

  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Device-Id': getDeviceId(),
      },
      body: JSON.stringify(body),
      keepalive: true,
    });
    if (resp.ok) {
      const data = (await resp.json()) as TrackResponse;
      if (data.rejected > 0) {
        // 部分被拒（白名单不命中等），不再重试，仅 console.warn
        console.warn('[telemetry] rejected events:', data.errors);
      }
      return;
    }
    // 4xx 不重试（典型为客户端 bug）
    if (resp.status >= 400 && resp.status < 500) {
      console.warn(`[telemetry] ${resp.status} response, dropping batch`);
      return;
    }
    throw new Error(`HTTP ${resp.status}`);
  } catch (e) {
    if (attempt >= RETRY_DELAYS_MS.length) {
      // 重试用尽，存 LocalStorage 等下次启动
      persistPending(events);
      console.warn('[telemetry] retries exhausted, persisted', e);
      return;
    }
    setTimeout(() => void sendWithRetry(events, attempt + 1), RETRY_DELAYS_MS[attempt]);
  }
}

function persistPending(events: TelemetryEvent[]): void {
  try {
    const existing = loadPending();
    const merged = [...existing, ...events].slice(-MAX_PENDING); // 保留最近 N 条
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    // LocalStorage 不可用就放弃
  }
}

function loadPending(): TelemetryEvent[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function clearPending(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

// 仅测试用
export function _resetForTest(): void {
  queue = [];
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  clearPending();
}
