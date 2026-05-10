# PR3 实施计划：前端登录 UI + 完整账号入口（auth frontend）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboard 完整登录入口 — 右上角刷新按钮替换为 UserMenu（未登录:登录按钮 / 已登录:头像下拉），LoginModal 三段式（手机号 + Turnstile + 验证码 + 倒计时），Settings 页含注销账号弹窗，401 拦截器自动弹登录 + 重试。配合 PR2 worker auth backend（含 SMS_PROVIDER=pushdeer dev tool）形成完整登录闭环。

**Architecture:**
- 客户端 store 用 `zustand`（轻量、无 boilerplate），3 个 slice：`user / loginModalOpen / triggerAction`
- Turnstile widget 用官方 JS SDK（`https://challenges.cloudflare.com/turnstile/v0/api.js`），LoginModal 打开时按需加载 script
- React Router 7（项目已用），加 `/settings` route + 主页 route 共存
- 401 拦截器在 `api.ts` apiFetch 层统一处理：401 → 弹 LoginModal + 保存触发 action → 登录成功后重试

**Tech Stack:**
- Dashboard：TypeScript + React 19 + Vite + zustand（新加）+ react-router 7 + Tailwind v4
- 已有：PR1 telemetry SDK + PR2 worker auth endpoints

**Branch:** `feat/auth-frontend`（已从 main `fc9063a` 出）

**Worktree:** `/Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend`

**关联文档:**
- 设计：`/Users/roxor/brain/30-projects/aifeeds/docs/plans/2026-05-01-auth-system-design.md`
- PR2 plan：`/Users/roxor/brain/30-projects/aifeeds/docs/plans/2026-05-02-pr2-auth-backend-implementation.md`

**测试策略**：与 PR1/PR2 一致，遵循 CLAUDE.md「验证分层」— `npm run build` + dashboard dev server 浏览器手动 smoke。**不引入 vitest**。

**部署前置**：PR2 已部署 + `SMS_PROVIDER=pushdeer` 已配 → PR3 完成后 deploy 即可端到端验证（验证码推到你 PushDeer 设备，无需腾讯云）。

---

## File Structure

### 新建文件

**Worker 端**（PR3 单一补丁，注销账号 endpoint）
- `worker/src/auth/handlers.ts` 末尾追加 `handleDelete`

**Dashboard 端**
- `dashboard/src/lib/auth.ts` — 客户端 SDK：`login / logout / logoutAll / deleteAccount / fetchMe`
- `dashboard/src/lib/authStore.ts` — zustand store
- `dashboard/src/lib/authGuard.ts` — `requireAuth(action)` 高阶函数（PR4 用，PR3 留好接口）
- `dashboard/src/components/AvatarPlaceholder.tsx` — 首字母圆形 placeholder
- `dashboard/src/components/LoginModal.tsx` — 登录弹窗
- `dashboard/src/components/UserMenu.tsx` — 右上角头像 + 下拉
- `dashboard/src/components/DeleteAccountConfirm.tsx` — 注销账号弹窗
- `dashboard/src/pages/Settings.tsx` — 设置页
- `dashboard/public/privacy.html` — 隐私政策
- `dashboard/public/terms.html` — 服务条款

### 修改文件

- `worker/src/index.ts` — 接 `/api/auth/delete` 路由 + handleDelete import
- `dashboard/package.json` — 加 zustand 依赖
- `dashboard/index.html` — Turnstile script（按需加载逻辑见 LoginModal.tsx）
- `dashboard/src/api.ts` — 401 拦截器 + import authStore
- `dashboard/src/App.tsx` — 替换右上角刷新按钮为 UserMenu，加 `<Routes>` 包 dashboard 主页 + `/settings`
- `dashboard/src/main.tsx` — store hydrate on boot

---

## 阶段总览

| Phase | 内容 | Tasks |
|-------|------|-------|
| 0 | Worker 补 /api/auth/delete | T0 |
| A | Dashboard 依赖 + SDK + store | A1-A4 |
| B | UI 组件 | B1-B5 |
| C | 集成（拦截器 + 路由 + Turnstile）| C1-C4 |
| D | hydrate + 本地 smoke | D1-D2 |
| E | 部署 | E1 |

总 13 task。

---

## Phase 0: Worker 补 /api/auth/delete

### Task T0: handleDelete handler + 路由

**Files:**
- Modify: `worker/src/auth/handlers.ts`（末尾追加 handleDelete + import 补一个）
- Modify: `worker/src/index.ts`（import + 路由）

PR2 设计文档 § 6.3 把注销账号搬到 PR3 backend，本 task 实施。逻辑：清空 PII（display_name/avatar_url）+ status='self_deleted' + identity_value 哈希 + revoke 全部 session。

- [ ] **Step 1: handlers.ts import 补加 hashCode（用于 identity_value 不可逆哈希）**

`worker/src/auth/handlers.ts` 顶部 import 区找到 `from './sms'` 那段，确保 `hashCode` 在 import 列表里（PR2 时已有，验证下）。如果有，跳过这步。

```bash
grep "hashCode" /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/worker/src/auth/handlers.ts | head -5
```

如缺失，把 sms import 改为含 hashCode：

```typescript
import {
  checkRateLimits,
  checkAndIncrDailyCap,
  checkDailyCapAlerts,
  generateCode,
  hashCode,
  sendSmsViaTencent,
} from './sms';
```

- [ ] **Step 2: handlers.ts 末尾追加 handleDelete**

```typescript
// ─── POST /api/auth/delete ───────────────────────────────

interface DeleteBody {
  phone_confirm: string;  // 二次确认：客户端要求用户输入完整手机号
}

const DELETE_HASH_SALT = 'xlist-deleted-v1';

export async function handleDelete(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') {
    return jsonErr('not authenticated', 401);
  }

  let body: DeleteBody;
  try {
    body = (await request.json()) as DeleteBody;
  } catch {
    return jsonErr('invalid json', 400);
  }

  // 二次确认：用户必须输入完整手机号匹配
  const ident = await env.DB.prepare(
    `SELECT id, identity_value FROM identities
     WHERE user_id = ? AND provider = 'phone' AND unbound_at IS NULL
     ORDER BY verified_at DESC LIMIT 1`,
  ).bind(auth.userId).first<{ id: number; identity_value: string }>();

  if (!ident) {
    return jsonErr('phone identity not found', 404);
  }

  if (typeof body.phone_confirm !== 'string' || body.phone_confirm !== ident.identity_value) {
    return jsonErr('phone confirm mismatch', 400);
  }

  const now = Date.now();
  const hashedPhone = await hashCode(ident.identity_value, DELETE_HASH_SALT);

  // 同步：PII 清空 + identity 哈希 + status 改 + revoke 所有 session
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE users SET display_name = NULL, avatar_url = NULL, status = 'self_deleted' WHERE id = ?`,
    ).bind(auth.userId),
    env.DB.prepare(
      `UPDATE identities SET identity_value = ?, unbound_at = ? WHERE id = ?`,
    ).bind(hashedPhone, now, ident.id),
    env.DB.prepare(
      `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
    ).bind(now, auth.userId),
  ]);

  return jsonOk(
    { ok: true },
    { 'Set-Cookie': buildClearCookie(isDevHost(request)) },
  );
}
```

- [ ] **Step 3: worker/src/index.ts import handleDelete + 加路由**

找到 `from './auth/handlers';` 那段 import：

```typescript
import {
  handleSmsSend,
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleMe,
} from './auth/handlers';
```

改为：

```typescript
import {
  handleSmsSend,
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleMe,
  handleDelete,
} from './auth/handlers';
```

在路由表，找到 `/api/auth/me` 那行之后追加：

```typescript
      if (path === '/api/auth/delete' && request.method === 'POST') {
        return withCors(await handleDelete(request, env, ctx), request, env);
      }
```

- [ ] **Step 4: typecheck + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/worker
npx tsc --noEmit

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add worker/src/auth/handlers.ts worker/src/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): /api/auth/delete handler (PR3)

注销账号：身份验证 → 二次确认 phone → PII 清空 + identity 哈希
+ status='self_deleted' + revoke 全部 session。返 Set-Cookie clear。

设计参考：docs/plans/2026-05-01-auth-system-design.md § 6.3

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase A: Dashboard 依赖 + SDK + Store

### Task A1: 加 zustand 依赖

**Files:**
- Modify: `dashboard/package.json` + `package-lock.json`

- [ ] **Step 1: 安装**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm install zustand
```

期望：成功，无 peer dep 警告。

- [ ] **Step 2: 验证 build**

```bash
npm run build
```

期望：成功，bundle size 增 ~3KB（zustand 极小）。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/package.json dashboard/package-lock.json
git commit -m "chore(dashboard): 加 zustand 依赖 (PR3)

PR3 auth store 用 zustand 管理 user / loginModalOpen / triggerAction
全局状态。轻量（~3KB），无 boilerplate，符合项目对依赖的简洁要求。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task A2: lib/auth.ts — 客户端 SDK fetch wrappers

**Files:**
- Create: `dashboard/src/lib/auth.ts`

- [ ] **Step 1: 创建文件**

```typescript
// PR3 auth client SDK
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 9.3

import { getDeviceId } from './device';

const API_BASE = (() => {
  if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_API_BASE) {
    return import.meta.env.VITE_API_BASE;
  }
  if (typeof window !== 'undefined') {
    const host = window.location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') {
      return 'http://localhost:8788';
    }
  }
  return 'https://api.ai-feeds.com';
})();

export interface User {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at?: number;
  phone_masked?: string | null;
}

export interface LoginResponse {
  user: User & { is_new: boolean };
  session: { id: string; expires_at: number };
}

interface ErrorResponse {
  error: string;
  reason?: string;
  attempts_remaining?: number;
  errCode?: string;
}

export class AuthError extends Error {
  status: number;
  reason?: string;
  attemptsRemaining?: number;
  errCode?: string;

  constructor(status: number, data: ErrorResponse) {
    super(data.error || `auth error ${status}`);
    this.status = status;
    this.reason = data.reason;
    this.attemptsRemaining = data.attempts_remaining;
    this.errCode = data.errCode;
  }
}

async function authFetch(
  path: string,
  init: RequestInit & { body?: unknown } = {},
): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set('X-Device-Id', getDeviceId());
  if (init.body !== undefined && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  return fetch(url, {
    ...init,
    headers,
    body:
      init.body !== undefined && typeof init.body !== 'string'
        ? JSON.stringify(init.body)
        : (init.body as BodyInit | undefined),
    credentials: 'include',
  });
}

async function parseOrThrow<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let data: ErrorResponse;
  try {
    data = (await res.json()) as ErrorResponse;
  } catch {
    data = { error: `HTTP ${res.status}` };
  }
  throw new AuthError(res.status, data);
}

export async function sendSmsCode(
  phone: string,
  turnstileToken: string,
): Promise<{ ok: true; ttl: number }> {
  const res = await authFetch('/api/auth/sms/send', {
    method: 'POST',
    body: { phone, turnstile_token: turnstileToken },
  });
  return parseOrThrow(res);
}

export async function login(phone: string, code: string): Promise<LoginResponse> {
  const res = await authFetch('/api/auth/login', {
    method: 'POST',
    body: { phone, code },
  });
  return parseOrThrow(res);
}

export async function fetchMe(): Promise<{ user: User }> {
  const res = await authFetch('/api/auth/me');
  return parseOrThrow(res);
}

export async function logout(): Promise<{ ok: true }> {
  const res = await authFetch('/api/auth/logout', { method: 'POST' });
  return parseOrThrow(res);
}

export async function logoutAll(): Promise<{ ok: true; revoked: number }> {
  const res = await authFetch('/api/auth/logout-all', { method: 'POST' });
  return parseOrThrow(res);
}

export async function deleteAccount(phoneConfirm: string): Promise<{ ok: true }> {
  const res = await authFetch('/api/auth/delete', {
    method: 'POST',
    body: { phone_confirm: phoneConfirm },
  });
  return parseOrThrow(res);
}
```

- [ ] **Step 2: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/src/lib/auth.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): lib/auth.ts — 客户端 auth SDK (PR3)

封装 6 个 endpoint：sendSmsCode / login / fetchMe / logout
/ logoutAll / deleteAccount。

- 共用 authFetch：自动注入 X-Device-Id + credentials:include cookie
- AuthError 统一异常类型，含 reason / attempts_remaining / errCode
- 路径常量 API_BASE 与现有 api.ts 一致

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3: lib/authStore.ts — zustand store

**Files:**
- Create: `dashboard/src/lib/authStore.ts`

- [ ] **Step 1: 创建文件**

```typescript
// PR3 auth zustand store
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 4

import { create } from 'zustand';
import * as authApi from './auth';
import type { User } from './auth';

export type LoginTrigger =
  | 'manual'
  | 'favorite'
  | 'subscribe'
  | 'api_401'
  | string;

interface AuthStore {
  // ─── state ───
  user: User | null;
  hydrated: boolean;             // hydrate 完成（启动时调 /api/auth/me 返回）
  loginModalOpen: boolean;
  loginTrigger: LoginTrigger;
  pendingRetry: (() => Promise<void> | void) | null;

  // ─── actions ───
  hydrate: () => Promise<void>;
  openLoginModal: (trigger?: LoginTrigger, retry?: () => Promise<void> | void) => void;
  closeLoginModal: () => void;
  onLoginSuccess: (user: User) => Promise<void>;
  logout: () => Promise<void>;
  logoutAll: () => Promise<void>;
  deleteAccount: (phoneConfirm: string) => Promise<void>;
  refreshUser: () => Promise<void>;
}

export const useAuthStore = create<AuthStore>((set, get) => ({
  user: null,
  hydrated: false,
  loginModalOpen: false,
  loginTrigger: 'manual',
  pendingRetry: null,

  async hydrate() {
    try {
      const { user } = await authApi.fetchMe();
      set({ user, hydrated: true });
    } catch {
      // 401 / 网络错都视为未登录
      set({ user: null, hydrated: true });
    }
  },

  openLoginModal(trigger = 'manual', retry) {
    set({
      loginModalOpen: true,
      loginTrigger: trigger,
      pendingRetry: retry ?? null,
    });
  },

  closeLoginModal() {
    set({ loginModalOpen: false, pendingRetry: null });
  },

  async onLoginSuccess(user) {
    const { pendingRetry } = get();
    set({ user, loginModalOpen: false, pendingRetry: null });
    if (pendingRetry) {
      try {
        await pendingRetry();
      } catch (e) {
        console.error('[auth] pendingRetry failed', e);
      }
    }
  },

  async logout() {
    try {
      await authApi.logout();
    } catch {
      // 忽略；本地状态强清
    }
    set({ user: null });
  },

  async logoutAll() {
    try {
      await authApi.logoutAll();
    } catch {}
    set({ user: null });
  },

  async deleteAccount(phoneConfirm) {
    await authApi.deleteAccount(phoneConfirm);
    set({ user: null });
  },

  async refreshUser() {
    try {
      const { user } = await authApi.fetchMe();
      set({ user });
    } catch {
      set({ user: null });
    }
  },
}));
```

- [ ] **Step 2: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/src/lib/authStore.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): lib/authStore.ts — zustand auth store (PR3)

state: user / hydrated / loginModalOpen / loginTrigger / pendingRetry
actions: hydrate / openLoginModal / closeLoginModal / onLoginSuccess
       / logout / logoutAll / deleteAccount / refreshUser

pendingRetry 模式支持 401 拦截器：弹登录前保存原 action，
登录成功后自动重试。详见 PR4 authGuard 集成点。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A4: lib/authGuard.ts — PR4 用，PR3 留好接口

**Files:**
- Create: `dashboard/src/lib/authGuard.ts`

- [ ] **Step 1: 创建文件**

```typescript
// PR3/PR4 auth guard 高阶函数
// PR3：仅留好接口 + 401 用例（在 api.ts 拦截器调用）
// PR4：收藏/订阅按钮挂 requireAuth(action) 实现「触发登录」UX

import { useAuthStore, type LoginTrigger } from './authStore';

/**
 * 检查登录态，未登录则弹 LoginModal 并把 action 保存为 pendingRetry。
 * 已登录直接执行 action。登录成功后 store.onLoginSuccess 自动重试。
 *
 * 用法：
 *   await requireAuth('favorite', () => addFavorite(itemId));
 */
export async function requireAuth(
  trigger: LoginTrigger,
  action: () => Promise<void> | void,
): Promise<void> {
  const store = useAuthStore.getState();
  if (store.user) {
    await action();
    return;
  }
  store.openLoginModal(trigger, action);
}
```

- [ ] **Step 2: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/src/lib/authGuard.ts
git commit -m "feat(dashboard): lib/authGuard.ts — requireAuth 高阶函数 (PR3)

PR4 收藏 / 订阅按钮挂 requireAuth(action) 触发登录拦截。
PR3 由 401 拦截器（api.ts）和 UserMenu 直接调用。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Phase B: UI 组件

### Task B1: AvatarPlaceholder

**Files:**
- Create: `dashboard/src/components/AvatarPlaceholder.tsx`

- [ ] **Step 1: 创建文件**

```typescript
// 首字母圆形头像 placeholder
// PR3 用：UserMenu / Settings / DeleteAccountConfirm
// 未来支持上传时（PR5+），传 src 优先用 src

interface Props {
  name?: string | null;             // 取首字母（中文取首字、英文取大写首字母）
  phoneMasked?: string | null;      // 兜底：name 缺失时取 phoneMasked 后 4 位
  src?: string | null;
  size?: number;                    // px
  className?: string;
}

export function AvatarPlaceholder({ name, phoneMasked, src, size = 36, className }: Props) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        className={`rounded-full object-cover ${className ?? ''}`}
      />
    );
  }
  let letter = '?';
  if (name && name.length > 0) {
    letter = name.trim().charAt(0).toUpperCase();
  } else if (phoneMasked && phoneMasked.length >= 4) {
    letter = phoneMasked.slice(-2, -1);  // 倒数第二位数字（138****1234 → '3'）
  }
  // 用首字母做 deterministic 颜色
  const code = letter.charCodeAt(0);
  const palette = [
    'bg-rose-500', 'bg-pink-500', 'bg-fuchsia-500', 'bg-purple-500',
    'bg-violet-500', 'bg-indigo-500', 'bg-blue-500', 'bg-sky-500',
    'bg-cyan-500', 'bg-teal-500', 'bg-emerald-500', 'bg-green-500',
    'bg-lime-600', 'bg-amber-600', 'bg-orange-500', 'bg-red-500',
  ];
  const bg = palette[code % palette.length];
  return (
    <div
      className={`flex items-center justify-center rounded-full text-white font-semibold ${bg} ${className ?? ''}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42) }}
    >
      {letter}
    </div>
  );
}
```

- [ ] **Step 2: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/src/components/AvatarPlaceholder.tsx
git commit -m "feat(dashboard): AvatarPlaceholder 首字母圆形头像 (PR3)

src 优先，否则首字母 + deterministic 颜色（16 色 palette）。
首字母取 name 首字 / phoneMasked 倒二位（138****1234 → '3'）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: LoginModal — 登录弹窗（PR3 最复杂的 UI）

**Files:**
- Create: `dashboard/src/components/LoginModal.tsx`

包含：
1. 手机号输入 + 格式校验
2. Turnstile widget 按需加载 + render + token 回调
3. 「获取验证码」按钮 + 60s 倒计时
4. 验证码输入 + 6 位校验
5. 错误状态分支（限流、过期、错码、锁定）
6. login 成功调 store.onLoginSuccess 自动 close + 重试 pendingRetry

- [ ] **Step 1: 创建文件**

```typescript
import { useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../lib/authStore';
import * as authApi from '../lib/auth';
import { AuthError } from '../lib/auth';
import { track, EVENTS } from '../lib/telemetry';

const TURNSTILE_SITE_KEY = '0x4AAAAAADHQ15rM-NnOZ2zL';
const TURNSTILE_SCRIPT_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
const PHONE_REGEX = /^1[3-9]\d{9}$/;

declare global {
  interface Window {
    turnstile?: {
      render: (
        container: HTMLElement | string,
        opts: {
          sitekey: string;
          callback?: (token: string) => void;
          'error-callback'?: () => void;
          'expired-callback'?: () => void;
          theme?: 'auto' | 'light' | 'dark';
        },
      ) => string;
      reset: (widgetId?: string) => void;
      remove: (widgetId?: string) => void;
    };
  }
}

let scriptLoaded = false;
async function loadTurnstileScript(): Promise<void> {
  if (scriptLoaded || window.turnstile) {
    scriptLoaded = true;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT_URL;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      scriptLoaded = true;
      resolve();
    };
    script.onerror = () => reject(new Error('turnstile script load failed'));
    document.head.appendChild(script);
  });
}

type Phase = 'phone' | 'code';

export function LoginModal() {
  const open = useAuthStore((s) => s.loginModalOpen);
  const trigger = useAuthStore((s) => s.loginTrigger);
  const closeModal = useAuthStore((s) => s.closeLoginModal);
  const onLoginSuccess = useAuthStore((s) => s.onLoginSuccess);

  const [phase, setPhase] = useState<Phase>('phone');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const [turnstileWidgetId, setTurnstileWidgetId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');
  const [cooldownSec, setCooldownSec] = useState(0);

  const turnstileContainerRef = useRef<HTMLDivElement | null>(null);

  // open 改 true：上报埋点 + reset 状态
  useEffect(() => {
    if (!open) return;
    track(EVENTS.LOGIN_MODAL_OPEN, { trigger_action: trigger });
    setPhase('phone');
    setPhone('');
    setCode('');
    setTurnstileToken(null);
    setLoading(false);
    setErrorMsg('');
    setCooldownSec(0);
  }, [open, trigger]);

  // open 阶段 phone：加载 + render Turnstile
  useEffect(() => {
    if (!open || phase !== 'phone') return;
    let cancelled = false;
    (async () => {
      try {
        await loadTurnstileScript();
        if (cancelled || !turnstileContainerRef.current || !window.turnstile) return;
        // 已有 widgetId 不重复 render
        if (turnstileWidgetId) {
          window.turnstile.reset(turnstileWidgetId);
          setTurnstileToken(null);
          return;
        }
        const id = window.turnstile.render(turnstileContainerRef.current, {
          sitekey: TURNSTILE_SITE_KEY,
          theme: 'auto',
          callback: (token: string) => setTurnstileToken(token),
          'error-callback': () => setTurnstileToken(null),
          'expired-callback': () => setTurnstileToken(null),
        });
        setTurnstileWidgetId(id);
      } catch (e) {
        setErrorMsg(`captcha 加载失败：${e instanceof Error ? e.message : String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, phase]);

  // 倒计时
  useEffect(() => {
    if (cooldownSec <= 0) return;
    const t = setTimeout(() => setCooldownSec((s) => s - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldownSec]);

  // phone 提交：调 sms/send，成功进 code 阶段 + 启动 60s 倒计时
  async function handleSendCode() {
    setErrorMsg('');
    if (!PHONE_REGEX.test(phone)) {
      setErrorMsg('手机号格式不对');
      return;
    }
    if (!turnstileToken) {
      setErrorMsg('请先完成人机验证');
      return;
    }
    setLoading(true);
    track(EVENTS.SMS_SEND_ATTEMPT, {});
    try {
      await authApi.sendSmsCode(phone, turnstileToken);
      track(EVENTS.SMS_SEND_SUCCESS, {});
      setPhase('code');
      setCooldownSec(60);
    } catch (e) {
      const a = e as AuthError;
      let msg = a.message;
      if (a.status === 429 && a.reason === 'phone_60s_limit') msg = '请稍候再试（60 秒内只能发 1 次）';
      else if (a.status === 429 && a.reason === 'phone_24h_limit') msg = '今日发送次数过多，请明天再试';
      else if (a.status === 429 && a.reason === 'phone_locked_30min') msg = '账户已临时锁定，请 30 分钟后再试';
      else if (a.status === 503) msg = '服务暂不可用，请稍后再试';
      else if (a.status === 403) msg = '人机验证失败，请重试';
      setErrorMsg(msg);
      // Turnstile token 已被消费，reset
      if (turnstileWidgetId && window.turnstile) {
        window.turnstile.reset(turnstileWidgetId);
        setTurnstileToken(null);
      }
    } finally {
      setLoading(false);
    }
  }

  // code 提交：调 login，成功 onLoginSuccess
  async function handleLogin() {
    setErrorMsg('');
    if (!/^\d{6}$/.test(code)) {
      setErrorMsg('验证码必须是 6 位数字');
      return;
    }
    setLoading(true);
    track(EVENTS.CODE_VERIFY_ATTEMPT, {});
    try {
      const data = await authApi.login(phone, code);
      track(EVENTS.LOGIN_SUCCESS, { is_new_user: data.user.is_new, login_method: 'phone-sms' });
      await onLoginSuccess(data.user);
    } catch (e) {
      const a = e as AuthError;
      let msg = a.message;
      if (a.status === 401 && /code expired/i.test(msg)) msg = '验证码已过期，请重新获取';
      else if (a.status === 401 && /no pending code/i.test(msg)) msg = '请先点「获取验证码」';
      else if (a.status === 401 && a.attemptsRemaining !== undefined) {
        msg = `验证码错误，还可尝试 ${a.attemptsRemaining} 次`;
      } else if (a.status === 429) msg = '尝试次数过多，账户已临时锁定 30 分钟';
      setErrorMsg(msg);
    } finally {
      setLoading(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-900">登录 / 注册</h2>
          <button
            type="button"
            onClick={closeModal}
            className="-mr-2 rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100"
            aria-label="关闭"
          >
            ✕
          </button>
        </header>

        {phase === 'phone' && (
          <>
            <label className="mb-1 block text-sm text-neutral-700">📱 手机号</label>
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, '').slice(0, 11))}
              placeholder="13800001234"
              className="mb-3 w-full rounded-md border border-neutral-300 px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <div ref={turnstileContainerRef} className="mb-3 flex justify-center" />
            <button
              type="button"
              onClick={handleSendCode}
              disabled={loading || !phone || !turnstileToken}
              className="mb-2 w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              {loading ? '发送中…' : '获取验证码'}
            </button>
          </>
        )}

        {phase === 'code' && (
          <>
            <p className="mb-3 text-sm text-neutral-600">
              已发送验证码到 <span className="font-mono">{phone}</span>
            </p>
            <label className="mb-1 block text-sm text-neutral-700">📝 6 位验证码</label>
            <input
              type="tel"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="382751"
              className="mb-3 w-full rounded-md border border-neutral-300 px-3 py-2 text-center text-2xl tracking-[.4em] focus:border-blue-500 focus:outline-none"
              autoFocus
            />
            <button
              type="button"
              onClick={handleLogin}
              disabled={loading || code.length !== 6}
              className="mb-2 w-full rounded-md bg-blue-600 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-neutral-300"
            >
              {loading ? '登录中…' : '登录 / 注册'}
            </button>
            <button
              type="button"
              onClick={() => {
                if (cooldownSec > 0) return;
                setPhase('phone');
                setErrorMsg('');
              }}
              disabled={cooldownSec > 0}
              className="w-full text-xs text-neutral-500 hover:text-neutral-700 disabled:cursor-not-allowed"
            >
              {cooldownSec > 0 ? `${cooldownSec}s 后可重新获取` : '重新获取验证码'}
            </button>
          </>
        )}

        {errorMsg && (
          <p className="mt-2 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{errorMsg}</p>
        )}

        <p className="mt-4 text-center text-[11px] text-neutral-500">
          登录即同意{' '}
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer" className="underline hover:text-neutral-700">
            隐私政策
          </a>{' '}
          《{' '}
          <a href="/terms.html" target="_blank" rel="noopener noreferrer" className="underline hover:text-neutral-700">
            服务条款
          </a>
          》
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/src/components/LoginModal.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): LoginModal 登录弹窗 (PR3)

两阶段：phone 输入 + Turnstile widget → code 输入 + 60s 倒计时。
- Turnstile JS SDK 按需加载（modal 打开才插入 script）
- 错误状态精细化：429 reason / 401 attempts_remaining / 503 / 403
  分别对应中文友好提示
- Telemetry 埋点：login_modal_open / sms_send_attempt / sms_send_success
  / code_verify_attempt / login_success
- onLoginSuccess 由 store 触发，自动 close + 重试 pendingRetry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B3: UserMenu — 右上角头像 + 下拉菜单

**Files:**
- Create: `dashboard/src/components/UserMenu.tsx`

替换现有 App.tsx 右上角刷新按钮的位置。

- [ ] **Step 1: 创建文件**

```typescript
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '../lib/authStore';
import { AvatarPlaceholder } from './AvatarPlaceholder';
import { track, EVENTS } from '../lib/telemetry';

export function UserMenu() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const openLogin = useAuthStore((s) => s.openLoginModal);
  const logoutAction = useAuthStore((s) => s.logout);
  const logoutAllAction = useAuthStore((s) => s.logoutAll);
  const navigate = useNavigate();

  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  // 点 outside 关闭下拉
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // 还没 hydrate 完，按空 placeholder 占位（avoid flash）
  if (!hydrated) {
    return <div className="h-8 w-8" aria-hidden />;
  }

  if (!user) {
    return (
      <button
        type="button"
        onClick={() => openLogin('manual')}
        className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700"
      >
        登录
      </button>
    );
  }

  const handleLogout = async () => {
    setOpen(false);
    track(EVENTS.LOGOUT, { logout_all: false });
    await logoutAction();
  };
  const handleLogoutAll = async () => {
    setOpen(false);
    track(EVENTS.LOGOUT, { logout_all: true });
    await logoutAllAction();
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1 rounded-full hover:opacity-80"
        aria-label="账号菜单"
      >
        <AvatarPlaceholder name={user.display_name} phoneMasked={user.phone_masked ?? undefined} size={32} />
      </button>
      {open && (
        <div className="absolute right-0 z-30 mt-2 w-56 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
          <div className="border-b border-neutral-100 px-3 py-2">
            <div className="text-sm font-medium text-neutral-900 truncate">
              {user.display_name || '未命名用户'}
            </div>
            <div className="font-mono text-xs text-neutral-500">{user.phone_masked || '—'}</div>
          </div>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              navigate('/settings');
            }}
            className="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50"
          >
            ⚙ 设置
          </button>
          <button
            type="button"
            onClick={handleLogout}
            className="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50"
          >
            ↩ 退出登录
          </button>
          <button
            type="button"
            onClick={handleLogoutAll}
            className="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50"
          >
            ↩ 退出全部设备
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/src/components/UserMenu.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): UserMenu 右上角账号入口 (PR3)

未 hydrate 完：空 placeholder 占位防 flash。
未登录：「登录」按钮 → 弹 LoginModal trigger='manual'。
已登录：头像 + 下拉（用户名 / 手机号脱敏 / 设置 / 退出 / 退出全部）。
注销账号入口在设置页，避免误触。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B4: DeleteAccountConfirm — 注销账号弹窗

**Files:**
- Create: `dashboard/src/components/DeleteAccountConfirm.tsx`

- [ ] **Step 1: 创建文件**

```typescript
import { useState } from 'react';
import { useAuthStore } from '../lib/authStore';
import { AuthError } from '../lib/auth';
import { track, EVENTS } from '../lib/telemetry';

interface Props {
  open: boolean;
  onClose: () => void;
  onSuccess?: () => void;
}

export function DeleteAccountConfirm({ open, onClose, onSuccess }: Props) {
  const user = useAuthStore((s) => s.user);
  const deleteAct = useAuthStore((s) => s.deleteAccount);

  const [phoneInput, setPhoneInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  if (!open || !user) return null;

  const handleConfirm = async () => {
    setErrorMsg('');
    if (!/^\d{11}$/.test(phoneInput)) {
      setErrorMsg('请输入完整 11 位手机号');
      return;
    }
    setLoading(true);
    try {
      await deleteAct(phoneInput);
      track(EVENTS.ACCOUNT_DELETE, {});
      onSuccess?.();
      onClose();
    } catch (e) {
      const a = e as AuthError;
      if (a.status === 400 && /phone confirm mismatch/i.test(a.message)) {
        setErrorMsg('手机号不匹配');
      } else if (a.status === 401) {
        setErrorMsg('登录已过期，请重新登录');
      } else {
        setErrorMsg(a.message || '注销失败');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-lg font-semibold text-rose-700">⚠️ 确认注销账号？</h2>
        <p className="mb-3 text-sm text-neutral-700">注销后将永久失去：</p>
        <ul className="mb-3 ml-4 list-disc text-sm text-neutral-700">
          <li>收藏的所有内容</li>
          <li>订阅的 author / 关键词</li>
          <li>阅读历史</li>
        </ul>
        <p className="mb-3 text-sm font-medium text-rose-700">操作不可逆。</p>
        <label className="mb-1 block text-sm text-neutral-700">
          请输入完整手机号（{user.phone_masked || '****'}）确认：
        </label>
        <input
          type="tel"
          value={phoneInput}
          onChange={(e) => setPhoneInput(e.target.value.replace(/\D/g, '').slice(0, 11))}
          placeholder="13800001234"
          className="mb-3 w-full rounded-md border border-neutral-300 px-3 py-2 text-base focus:border-rose-500 focus:outline-none"
          autoFocus
        />
        {errorMsg && <p className="mb-3 rounded-md bg-rose-50 px-3 py-2 text-sm text-rose-700">{errorMsg}</p>}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={onClose}
            disabled={loading}
            className="flex-1 rounded-md border border-neutral-300 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading}
            className="flex-1 rounded-md bg-rose-600 py-2 text-sm font-medium text-white hover:bg-rose-700 disabled:bg-rose-300"
          >
            {loading ? '注销中…' : '确认注销'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/src/components/DeleteAccountConfirm.tsx
git commit -m "feat(dashboard): DeleteAccountConfirm 注销账号弹窗 (PR3)

二次确认：用户必须输入完整手机号匹配后端 identity_value。
失败错误中文化（手机号不匹配 / 登录过期 / 通用）。
成功后调 onSuccess 回调（设置页用来跳首页）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B5: Settings 页

**Files:**
- Create: `dashboard/src/pages/Settings.tsx`

- [ ] **Step 1: 创建目录 + 文件**

```bash
mkdir -p /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard/src/pages
```

```typescript
// dashboard/src/pages/Settings.tsx
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useAuthStore } from '../lib/authStore';
import { AvatarPlaceholder } from '../components/AvatarPlaceholder';
import { DeleteAccountConfirm } from '../components/DeleteAccountConfirm';
import { resetDeviceId } from '../lib/device';

export function Settings() {
  const user = useAuthStore((s) => s.user);
  const hydrated = useAuthStore((s) => s.hydrated);
  const logoutAction = useAuthStore((s) => s.logout);
  const logoutAllAction = useAuthStore((s) => s.logoutAll);
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (!hydrated) {
    return <div className="p-8 text-center text-neutral-500">加载中…</div>;
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-md p-8 text-center">
        <p className="mb-4 text-neutral-700">请先登录</p>
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700"
        >
          返回首页
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl px-4 py-6">
      <header className="mb-6 flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/')}
          className="rounded-md px-2 py-1 text-neutral-600 hover:bg-neutral-100"
          aria-label="返回"
        >
          ←
        </button>
        <h1 className="text-xl font-semibold">设置</h1>
      </header>

      <section className="mb-8">
        <div className="mb-3 flex items-center gap-3">
          <AvatarPlaceholder name={user.display_name} phoneMasked={user.phone_masked ?? undefined} size={48} />
          <div>
            <div className="font-medium">{user.display_name || '未命名用户'}</div>
            <div className="font-mono text-sm text-neutral-500">{user.phone_masked || '—'}</div>
          </div>
        </div>
      </section>

      <section className="mb-8">
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-neutral-500">数据</h2>
        <div className="rounded-lg border border-neutral-200">
          <button
            type="button"
            onClick={() => {
              resetDeviceId();
              alert('本地浏览器标识已清除，刷新页面后将重新生成。');
            }}
            className="flex w-full items-center justify-between px-4 py-3 text-left text-sm hover:bg-neutral-50"
          >
            <span>清除本地浏览器标识</span>
            <span className="text-xs text-neutral-400">device_id</span>
          </button>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-sm font-medium uppercase tracking-wider text-rose-600">危险区</h2>
        <div className="space-y-2 rounded-lg border border-rose-200 bg-rose-50/50 p-4">
          <button
            type="button"
            onClick={async () => {
              await logoutAction();
              navigate('/');
            }}
            className="block w-full rounded-md border border-neutral-300 bg-white py-2 text-sm font-medium hover:bg-neutral-50"
          >
            退出登录
          </button>
          <button
            type="button"
            onClick={async () => {
              await logoutAllAction();
              navigate('/');
            }}
            className="block w-full rounded-md border border-neutral-300 bg-white py-2 text-sm font-medium hover:bg-neutral-50"
          >
            退出全部设备
          </button>
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            className="block w-full rounded-md bg-rose-600 py-2 text-sm font-medium text-white hover:bg-rose-700"
          >
            注销账号
          </button>
        </div>
      </section>

      <DeleteAccountConfirm
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        onSuccess={() => navigate('/')}
      />
    </div>
  );
}
```

- [ ] **Step 2: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/src/pages/Settings.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): Settings 设置页 (PR3)

三段式：账号信息 + 数据（清除 device_id）+ 危险区（退出 / 退出全部
/ 注销账号）。
未登录访问 → 提示 + 返回首页。
注销成功 → onSuccess 自动跳首页。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C: 集成

### Task C1: api.ts 401 拦截器

**Files:**
- Modify: `dashboard/src/api.ts`

- [ ] **Step 1: 修改 api.ts apiFetch 函数加 401 拦截**

打开 `dashboard/src/api.ts`，找到 `async function apiFetch` 函数。在它顶部加 import：

```typescript
import { useAuthStore } from "./lib/authStore";
```

把 apiFetch 整个函数体替换为：

```typescript
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set('X-Device-Id', getDeviceId());

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers, credentials: 'include' });
  } catch (e) {
    track(EVENTS.API_ERROR, {
      endpoint: path,
      status: 0,
      error_msg: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  if (res.status === 401) {
    // 仅对个人态 endpoint 弹登录（防止 /api/items 等公开 endpoint 错弹登录）
    const protectedPaths = ['/api/auth/me', '/api/favorites', '/api/subscriptions'];
    const isProtected = protectedPaths.some((p) => path.startsWith(p));
    if (isProtected) {
      const store = useAuthStore.getState();
      // 如已登录态本地认为是 logged in 但 server 返 401（被踢），先清本地 + 弹登录
      if (store.user) {
        store.logout();
      }
      store.openLoginModal('api_401');
    }
  }

  if (!res.ok && res.status >= 400) {
    track(EVENTS.API_ERROR, {
      endpoint: path,
      status: res.status,
    });
  }
  return res;
}
```

注意 `credentials: 'include'` 让浏览器带 cookie。

- [ ] **Step 2: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/src/api.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): api.ts 401 拦截器 + cookie credentials (PR3)

apiFetch 加 credentials:'include' 让浏览器带 session cookie。
401 响应：白名单 protected endpoint（/api/auth/me, /api/favorites,
/api/subscriptions）触发弹登录 + 本地清登录态。/api/items 等公开
endpoint 不会误弹（仅记 api_error 埋点）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task C2: index.html Turnstile script

**说明**：LoginModal 已用 dynamic loading（B2 task 内部），index.html 不需要预加载 script。**本 task 跳过**，无 commit。

如未来想优化首屏体验（pre-warm Turnstile），再考虑预加载。当前 lazy load 性能更好。

---

### Task C3: App.tsx wire UserMenu + Settings 路由

**Files:**
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: 顶部 import 追加**

打开 `dashboard/src/App.tsx`，在现有 import 区末尾追加：

```typescript
import { Routes, Route } from "react-router";
import { UserMenu } from "./components/UserMenu";
import { LoginModal } from "./components/LoginModal";
import { Settings } from "./pages/Settings";
import { useAuthStore } from "./lib/authStore";
```

- [ ] **Step 2: 找到右上角刷新按钮替换为 UserMenu**

App.tsx 现有右上角有这一段（找 `<button` `title="刷新"` 或 `⟳`）：

```typescript
          <button
            type="button"
            onClick={() => setRefreshTick((t) => t + 1)}
            className="shrink-0 rounded-md border border-neutral-200 px-3 py-1 text-xs text-neutral-600 hover:bg-neutral-100"
            title="刷新"
          >
            ⟳
          </button>
```

替换为：

```typescript
          <UserMenu />
```

`refreshTick` state 已被「新内容」提示条接管（Feed.tsx），现在不再需要外部触发。但要保留 `refreshTick` state 防止其他引用断（不删该 state，仅删按钮）。

- [ ] **Step 3: 把现有 dashboard 渲染抽到独立 component + 加 Routes**

App.tsx 现有 return 整段（从 `<DrawerProvider>` 到末尾）抽到内部 component `DashboardHome`：

把现有 `function App() { ... return ( <DrawerProvider> ... </DrawerProvider> ); }`

改造成：

```typescript
function DashboardHome() {
  // 把现有 App() 函数体的所有 useState / useEffect / 等等保留在这里
  // 把现有 return ( <DrawerProvider> ... </DrawerProvider> ) 也保留在这里
}

function App() {
  const hydrate = useAuthStore((s) => s.hydrate);
  const hydrated = useAuthStore((s) => s.hydrated);

  // 启动时调 /api/auth/me hydrate
  useEffect(() => {
    if (!hydrated) {
      hydrate();
    }
  }, [hydrate, hydrated]);

  return (
    <>
      <Routes>
        <Route path="/" element={<DashboardHome />} />
        <Route path="/t/:id" element={<DashboardHome />} />
        <Route path="/g/:owner/:repo" element={<DashboardHome />} />
        <Route path="/settings" element={<Settings />} />
      </Routes>
      <LoginModal />
    </>
  );
}
```

`<LoginModal />` 放在 Routes 外，全局 mount 一次（避免 route 切换时 modal state 丢）。

`/t/:id` 和 `/g/:owner/:repo` 这两个 route 是 PR1 dashboard URL routing 加的，之前的 drawer 通过 useLocation 自己读 URL 决定渲染，所以同一个 `<DashboardHome />` 元素就够（drawer 自适应 URL）。

- [ ] **Step 4: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): App.tsx wire UserMenu + Settings 路由 (PR3)

- 右上角刷新按钮替换为 <UserMenu />（功能由"新内容"提示条接管）
- 现有 dashboard 主页抽到 DashboardHome 内部 component
- App 顶层加 Routes（/ /t/:id /g/:owner/:repo → DashboardHome；
  /settings → Settings）
- <LoginModal /> 全局 mount 一次（路由切换不丢 state）
- 启动时调 useAuthStore.hydrate() 拉 /api/auth/me

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task C4: 隐私政策 + 服务条款 HTML

**Files:**
- Create: `dashboard/public/privacy.html`
- Create: `dashboard/public/terms.html`

- [ ] **Step 1: 创建 privacy.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>隐私政策 — AI-Feeds</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; max-width: 720px; margin: 2em auto; padding: 1em; line-height: 1.7; color: #1a1a1a; }
    h1 { border-bottom: 1px solid #ddd; padding-bottom: .3em; }
    h2 { margin-top: 1.6em; }
    a { color: #2563eb; }
    .meta { color: #666; font-size: .9em; }
  </style>
</head>
<body>
  <h1>隐私政策</h1>
  <p class="meta">最后更新：2026-05-02</p>

  <h2>我们是谁</h2>
  <p>AI-Feeds（ai-feeds.com）是一个独立开发者项目，由个人维护，提供一站式 AI 信息聚合看板。</p>

  <h2>我们收集哪些信息</h2>
  <ul>
    <li><b>device_id（匿名访客标识）</b>：首次访问时本地生成的随机字符串，存在你浏览器的 LocalStorage 里。<b>不读取设备硬件信息，不形成"设备指纹"</b>。</li>
    <li><b>IP 地址 / 浏览器 User-Agent / Referer</b>：每次请求自动记录，用于防刷、地域统计、安全审计。</li>
    <li><b>手机号</b>（仅注册/登录后）：用于唯一身份验证，仅在登录流程中使用，存储为不可逆方式或脱敏显示。</li>
    <li><b>验证码（hash 后）</b>：登录流程，仅校验用，明文不入库。</li>
    <li><b>行为事件</b>（浏览、点击、停留时长、性能指标、错误日志）：通过 events 表统一收集，不包含手机号或敏感个人信息。</li>
  </ul>

  <h2>我们使用哪些第三方服务</h2>
  <ul>
    <li><b>Cloudflare Turnstile</b>：人机验证（防刷），不收集敏感信息。</li>
    <li><b>腾讯云 / PushDeer</b>：发送短信验证码（依实际后台配置）。</li>
    <li><b>Cloudflare Workers / D1 / Pages / R2</b>：数据存储和服务托管。</li>
  </ul>

  <h2>用户控制权</h2>
  <ul>
    <li>清除浏览器缓存即可重置 device_id（你浏览器主导）。</li>
    <li>设置页可主动「退出登录」「退出全部设备」「注销账号」。</li>
    <li>注销账号会立即清空 PII 字段，identity 哈希后保留以避免引用丢失。</li>
  </ul>

  <h2>政策变更</h2>
  <p>政策变更时，我们将在本页面更新「最后更新」日期。重大变更会在登录后的 dashboard 顶部提示。</p>

  <h2>联系我们</h2>
  <p>邮箱：<a href="mailto:ltsms86@gmail.com">ltsms86@gmail.com</a></p>
</body>
</html>
```

- [ ] **Step 2: 创建 terms.html**

```html
<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>服务条款 — AI-Feeds</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif; max-width: 720px; margin: 2em auto; padding: 1em; line-height: 1.7; color: #1a1a1a; }
    h1 { border-bottom: 1px solid #ddd; padding-bottom: .3em; }
    h2 { margin-top: 1.6em; }
    a { color: #2563eb; }
    .meta { color: #666; font-size: .9em; }
  </style>
</head>
<body>
  <h1>服务条款</h1>
  <p class="meta">最后更新：2026-05-02</p>

  <h2>使用范围</h2>
  <p>AI-Feeds 提供 AI 行业信息聚合服务（X / GitHub / 等）。本站显示内容均为公开来源，所有权归原作者。本站仅做聚合 + 翻译 + 元数据展示，不二次创作。</p>

  <h2>用户行为</h2>
  <ul>
    <li>本站不接受用户发布 UGC 内容（评论、发帖、留言等）。</li>
    <li>不得通过自动化脚本批量爬取本站数据。</li>
    <li>不得尝试绕过登录、防刷、Turnstile 等安全措施。</li>
  </ul>

  <h2>账号</h2>
  <ul>
    <li>注册账号即同意本服务条款 + 隐私政策。</li>
    <li>账号仅用于本站个人态功能（收藏、订阅）。</li>
    <li>本站可在用户违反条款时暂停或注销账号。</li>
  </ul>

  <h2>责任限制</h2>
  <p>本站尽力保障服务可用性但不做 100% 保证。本站不对原始来源内容的准确性 / 时效性 / 第三方链接负责。</p>

  <h2>条款变更</h2>
  <p>条款变更时，「最后更新」日期会同步更新，重大变更会在 dashboard 顶部提示。</p>

  <h2>联系我们</h2>
  <p>邮箱：<a href="mailto:ltsms86@gmail.com">ltsms86@gmail.com</a></p>
</body>
</html>
```

- [ ] **Step 3: build + Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build  # 验证 public/ 文件被打入 dist/

cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git add dashboard/public/privacy.html dashboard/public/terms.html
git commit -m "$(cat <<'EOF'
docs(dashboard): 隐私政策 + 服务条款 (PR3)

PR3 上线前的合规文档。隐私政策按 design doc § 12.1-12.2 列收集
项 + 第三方服务 + 用户控制权。LoginModal 和 Settings 都引用。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase D: 验证

### Task D1: 本地端到端 dev smoke

**Files:** 无（仅运行 + 检查）

- [ ] **Step 1: 启动本地 stack（dev 模式）**

```bash
# 终端 1: worker
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/worker
npx wrangler dev --local --port 8788
```

```bash
# 终端 2: dashboard
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run dev
```

> 注意：dev 没有真 Turnstile secret + SMS_PROVIDER，sms.ts 走 simulate（console.log 明文 code）+ verifyTurnstile bypass。

- [ ] **Step 2: 浏览器手动 smoke**

打开 http://localhost:5173（或 5174）：

1. 应看到右上角是「登录」按钮（不是 ⟳）
2. 点登录 → LoginModal 弹窗
3. 输入手机号 `13800001234`
4. **dev 模式 Turnstile widget 不会渲染真挑战**（因为 secret bypass），但 widget 容器位置应该出现 — 或者不出现（如果 Turnstile 自己 detect 到无效 sitekey 就不渲染）。本地 dev 由于 sitekey 是真的（公钥），Turnstile 服务器应能正常返回 token。
5. 点「获取验证码」
6. 切换到 wrangler dev 终端，找 `[sms] TENCENT_SMS_* not fully configured, dev simulate. phone=13800001234 code=XXXXXX`
7. 把 6 位 code 输到 LoginModal
8. 点登录 → 弹窗关闭，UserMenu 切换为头像
9. 点头像 → 下拉菜单显示用户信息 + 设置 + 退出 + 退出全部
10. 点「设置」→ /settings 页面打开
11. 点「退出登录」→ 跳回首页，UserMenu 重新变「登录」按钮
12. 重新登录 → 设置页 → 注销账号 → 输入完整 phone `13800001234` → 确认 → 跳首页
13. 验证 D1 user 表那行 status='self_deleted' + display_name=NULL

- [ ] **Step 3: D1 验证**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/worker
npx wrangler d1 execute xlist --command="SELECT id, status, display_name FROM users ORDER BY created_at DESC LIMIT 3;" --local
```

期望：注销后的 user 行 status='self_deleted'。

- [ ] **Step 4: 杀进程，无 commit（验证 task 无源码改动）**

```bash
pkill -f "wrangler dev"
pkill -f "vite"
```

---

### Task D2: build prod 一遍

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build
```

期望：成功，bundle size 应增 ~30KB（zustand + auth UI 组件）。

- [ ] **Step 1: 看 build 输出**

观察 `dist/assets/index-*.js` size — 应在 600-700KB 之间（main 已 626KB，加 PR3 ~30-50KB）。

- [ ] **Step 2: 不需要 commit**（D2 是验证 task，无源码改动）

---

## Phase E: 部署

### Task E1: deploy worker（含 PR3 的 /api/auth/delete）+ deploy dashboard

⚠️ **部署前必做**：rebase 到 main 最新 HEAD。PR1/PR2 教训复现 3 次，部署期间 main 易前进。

- [ ] **Step 1: rebase 到 main 最新**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend
git fetch origin 2>/dev/null || true
# 看 main 是否前进
cd /Users/roxor/brain/30-projects/aifeeds
NEW_MAIN=$(git rev-parse main)
echo "main HEAD: $NEW_MAIN"
cd .worktrees/feat-auth-frontend
git rebase main 2>&1 | tail -10
```

如果有冲突，按 PR1/PR2 经验解决（worker/src/index.ts import 区合并通常是冲突点）。解完 `git add` + `git rebase --continue`。

- [ ] **Step 2: 远端 D1 没有新表，跳过 schema migration**（PR3 worker 只加 endpoint，没有新表）

- [ ] **Step 3: deploy worker**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/worker
npm run deploy
```

- [ ] **Step 4: deploy dashboard**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-auth-frontend/dashboard
npm run build
npx wrangler pages deploy dist --project-name=xlist-dashboard --commit-message="PR3 auth frontend" --branch=main
```

- [ ] **Step 5: 远端冒烟**

```bash
echo "=== /api/auth/delete 无 cookie 应 401 ==="
curl -s -w "\nHTTP %{http_code}\n" -X POST https://api.ai-feeds.com/api/auth/delete \
  -H "Content-Type: application/json" \
  -d '{"phone_confirm":"13800001234"}'
```

期望：HTTP 401 not authenticated（验证 endpoint 路由 + auth middleware）。

- [ ] **Step 6: 浏览器手动 smoke 真流程**

1. 打开 https://ai-feeds.com，确认右上角是「登录」按钮
2. 点登录，输入**你自己的真手机号**
3. **生产 Turnstile** 真校验生效，应渲染 widget
4. 完成 widget → 点「获取验证码」→ **PushDeer 推送到你 iPhone + Mac**
5. 输入 code → 登录成功，UserMenu 切头像
6. 设置页可访问 /settings，注销流程可走完
7. 重新登录确认存在历史 user_id

- [ ] **Step 7: merge feat → main**

```bash
cd /Users/roxor/brain/30-projects/aifeeds
git checkout main
git merge --ff-only feat/auth-frontend
git worktree remove .worktrees/feat-auth-frontend
git branch -d feat/auth-frontend
```

- [ ] **Step 8: 不需要 commit**（部署 + merge 不产生新 commit）

---

## 完成验收

- [ ] Worker 加 /api/auth/delete + 路由 ✓
- [ ] Dashboard 13 个 task commit + 部署
- [ ] 端到端浏览器流程：登录、UserMenu 切换、Settings、退出全部、注销账号都通
- [ ] 真手机号 + 真 PushDeer 推送链路验证（部署后）
- [ ] feat/auth-frontend ff merge 到 main

## 后续步骤（不在本 PR）

- PR4：强制登录拦截（authGuard 在收藏/订阅按钮挂上）— 需要 PR5 收藏/订阅 endpoint 才有意义
- PR5：收藏 / 订阅功能（启用 favorites + subscriptions schema）
- PR6：上线后加固（Rate Limit 阈值校准、隐私政策修订）

## TODO（不在本 PR）

- 用户头像上传（PR5+）
- 昵称编辑入口（设置页）
- 多端原生 app（session 已 Bearer 兼容）
- Email digest / PushDeer 订阅设置（PR5+）
- 30 天 retention cron 清旧 sessions（PR2 后置 TODO）
