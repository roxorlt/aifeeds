// telemetry SDK 主入口 — 整合 device + queue + session + beacon
// 使用方式：
//   import { initTelemetry, track, EVENTS } from '@/lib/telemetry';
//   initTelemetry({ endpoint: 'https://api.ai-feeds.com/api/track' });
//   track(EVENTS.PAGE_VIEW, { path: '/' });

import { enqueue, initQueue, flush } from './queue';
import { initSession, getSessionTokenHash, touchSession } from './session';
import { installBeacon } from './beacon';
import { EVENTS } from './event-types';
import type { TelemetryEvent } from './types';

export { EVENTS };
export type { TelemetryEvent } from './types';

let initialized = false;

export interface TelemetryInitOptions {
  endpoint: string;
}

export function initTelemetry(opts: TelemetryInitOptions): void {
  if (initialized) return;
  initialized = true;

  initQueue({
    endpoint: opts.endpoint,
    sessionTokenHashGetter: getSessionTokenHash,
  });

  initSession({
    onStart: (s) => {
      enqueue({
        type: EVENTS.SESSION_START,
        occurred_at: s.started_at,
        page_path: getPagePath(),
      });
    },
    onEnd: (s, durationMs) => {
      enqueue({
        type: EVENTS.SESSION_END,
        occurred_at: s.last_activity_at,
        page_path: getPagePath(),
        payload: { duration_ms: durationMs },
      });
      // session_end 是关键事件，立即 flush 不等队列阈值
      void flush();
    },
  });

  installBeacon();
}

/**
 * 上报一个事件。
 * 应用代码用法：track(EVENTS.ITEM_CLICK, { item_id: 'x' })
 */
export function track(
  type: string,
  payload?: Record<string, unknown>,
  options: { occurredAt?: number; pagePath?: string } = {},
): void {
  if (!initialized) {
    // 静默 drop —— init 之前的事件不上报，避免循环依赖
    return;
  }

  touchSession();

  const event: TelemetryEvent = {
    type,
    occurred_at: options.occurredAt ?? Date.now(),
    page_path: options.pagePath ?? getPagePath(),
  };
  if (payload && Object.keys(payload).length > 0) {
    event.payload = payload;
  }

  enqueue(event);
}

function getPagePath(): string {
  if (typeof window === 'undefined') return '';
  return window.location.pathname + window.location.search;
}
