// 全局错误捕获：window.onerror + unhandledrejection
// stack 截前 10 行避免 payload 过大
// 不捕获 image 加载错误（在 utils.ts proxyImg 里单独处理）

import { track } from './index';
import { EVENTS } from './event-types';

const STACK_LINE_LIMIT = 10;
const MESSAGE_LIMIT = 500;

export function installErrorHandlers(): void {
  if (typeof window === 'undefined') return;

  window.addEventListener('error', (event) => {
    // 跳过 image / script 加载错误（事件 target 是 element 而不是 window）
    if (event.target && event.target !== window) return;

    track(EVENTS.JS_ERROR, {
      message: truncate(event.message, MESSAGE_LIMIT),
      stack: truncateStack(event.error?.stack),
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    track(EVENTS.UNHANDLED_PROMISE, {
      message: truncate(
        reason instanceof Error ? reason.message : String(reason),
        MESSAGE_LIMIT,
      ),
      stack: truncateStack(reason instanceof Error ? reason.stack : undefined),
    });
  });
}

function truncateStack(stack?: string): string | undefined {
  if (!stack) return undefined;
  return stack.split('\n').slice(0, STACK_LINE_LIMIT).join('\n');
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
