// 前端 session token（与登录 session 无关）
// 用于：会话维度埋点（PV/UV、平均会话时长）
// 30 分钟无活动自动续新 session
// session_start / session_end 事件由这里触发

import { nanoid } from 'nanoid';

const SESSION_KEY = 'xlist_telemetry_session';
const SESSION_IDLE_MS = 30 * 60 * 1000;  // 30 min

interface SessionState {
  token: string;
  started_at: number;
  last_activity_at: number;
}

let current: SessionState | null = null;
let onStartCallback: ((s: SessionState) => void) | null = null;
let onEndCallback: ((s: SessionState, durationMs: number) => void) | null = null;

export function initSession(opts: {
  onStart?: (s: SessionState) => void;
  onEnd?: (s: SessionState, durationMs: number) => void;
} = {}): void {
  onStartCallback = opts.onStart || null;
  onEndCallback = opts.onEnd || null;

  // 加载已有 session（同 tab 刷新场景）
  const stored = loadStored();
  const now = Date.now();

  if (stored && now - stored.last_activity_at < SESSION_IDLE_MS) {
    current = stored;
    current.last_activity_at = now;
    persistStored();
    return;
  }

  // 旧 session 已超时 → 先发 session_end
  if (stored && onEndCallback) {
    onEndCallback(stored, stored.last_activity_at - stored.started_at);
  }

  // 开新 session
  current = {
    token: nanoid(32),
    started_at: now,
    last_activity_at: now,
  };
  persistStored();
  if (onStartCallback) onStartCallback(current);
}

export function getSessionToken(): string | undefined {
  return current?.token;
}

/** 简单 hash 给后端做关联（不需要密码学强度，避免 token 明文写到 events 表） */
export function getSessionTokenHash(): string | undefined {
  if (!current) return undefined;
  return simpleHash(current.token);
}

/** 任何 telemetry track 调用都应触发，保活 session */
export function touchSession(): void {
  if (!current) return;
  const now = Date.now();
  if (now - current.last_activity_at >= SESSION_IDLE_MS) {
    // 已超时 → 切新 session
    if (onEndCallback) onEndCallback(current, current.last_activity_at - current.started_at);
    current = {
      token: nanoid(32),
      started_at: now,
      last_activity_at: now,
    };
    if (onStartCallback) onStartCallback(current);
  } else {
    current.last_activity_at = now;
  }
  persistStored();
}

function persistStored(): void {
  if (!current) return;
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(current));
  } catch {}
}

function loadStored(): SessionState | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as SessionState;
  } catch {
    return null;
  }
}

function simpleHash(s: string): string {
  // FNV-1a 32 位简单 hash，足够区分但不是密码学
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
