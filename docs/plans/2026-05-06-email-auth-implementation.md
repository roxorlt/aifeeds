# Email 验证码登录实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worker 端实现 email 验证码登录通道（绕过 ICP 备案的主路径），dashboard 端 LoginModal 切到 email-only 模式，SMS 代码保留 + feature flag 隐藏。集成 Resend HTTPS API，加 disposable-email 黑名单 + MX DoH 预校验两层 email 特有风控，daily/monthly cap + PushDeer 80%/95%/100% 告警。

**Architecture:**
- 沿用 `worker/src/auth/` 子目录拆分模式，复用现有 SMS 风控 / session / Turnstile / PushDeer 基础设施
- 新增 `email_send_log` 表与 `sms_send_log` 完全对称（避免 migrate 现有表的风险）
- `identities` 表 `provider='email'` 早已预留，零 schema 改动
- 所有 email 特有逻辑（validation / disposable / MX / rate limit / cap / Resend client）拆 6 个 utility 文件，handler 只负责编排
- `/api/auth/login` 扩展 email 分支：用 `identifier` 字段同时接受 phone + email，根据格式自动路由
- Feature flag：`ENABLE_SMS_LOGIN`（worker env）+ `VITE_AUTH_CHANNEL`（dashboard env）
- 验证策略：与 PR2/PR3 一致，**不引入 vitest** — wrangler dev + curl 矩阵 + dev server browser smoke

**Tech Stack:**
- Worker：TypeScript + Cloudflare Workers + D1 + KV + wrangler
- npm 新依赖：`disposable-email-domains`（约 50KB，~3000 域名黑名单）
- Email send：Resend HTTPS API（无 SDK，原生 fetch）
- MX 校验：cloudflare-dns.com DoH（无 SDK，原生 fetch）
- 已有：nanoid / Turnstile / PushDeer / Tencent SMS（保留 + flag 关闭）

**Branch:** `feat/email-auth`（已从 main `44359c4` 出，含设计文档 commit `c968642`）

**关联设计文档:** `/Users/roxor/brain/30-projects/xlist-scraper/docs/plans/2026-05-06-email-auth-design.md`

---

## ⚠️ 外部依赖（用户操作）

代码可以全写完跑 staging，但 prod 上线需要这些**用户必须先做**的操作。Phase G 依赖这些就绪。

| 依赖 | 用户操作 | 阻塞 |
|---|---|---|
| Resend 后台旋转旧 key | 上次对话里贴出的 `re_CWpHnWcC_*` 已暴露，必须在 Resend Dashboard → API Keys → Revoke + Create new | G3 / G4 |
| Resend 后台添加 domain | Domains → Add Domain → `mail.ai-feeds.com` → 拿到 4 条 DNS 记录 | G2 |
| CF DNS 加 4 条 TXT/MX 记录 | CF Dashboard → ai-feeds.com → DNS → 加 SPF / DKIM / DMARC / return-path | G2 |
| Resend 后台点 Verify | DNS 生效后（< 5min）回 Resend → Domains → Verify | G3 |
| `wrangler secret put RESEND_API_KEY` | staging + prod 各 set 一次，新 key（不是已暴露的） | G3 / G4 |

代码可以用空 RESEND_API_KEY 跑 wrangler dev 验证 typecheck + 路由通；真发邮件必须 secret 上线。

---

## File Structure

### 新建文件

**Worker 端**
- `worker/migrations/010-email-send-log.sql` — `email_send_log` 表
- `worker/src/auth/email-validation.ts` — email regex + normalize + disposable + MX 检查
- `worker/src/auth/email-rate-limit.ts` — email 6 维度限流
- `worker/src/auth/email-cap.ts` — email daily/monthly cap + 告警
- `worker/src/auth/resend.ts` — Resend HTTPS API client（含 dev fallback）
- `worker/src/auth/email-handlers.ts` — `handleEmailSend` 编排

### 修改文件

- `worker/schema.sql` — 追加 `email_send_log` 表定义
- `worker/wrangler.toml` — 加 `ENABLE_SMS_LOGIN` env / `EMAIL_DAILY_CAP` / `EMAIL_MONTHLY_CAP` 默认值
- `worker/src/index.ts` — Env 接口扩展 + 加 `/api/auth/email/send` 路由
- `worker/src/auth/types.ts` — 加 `EmailLogRow` + `EmailRateLimitResult`
- `worker/src/auth/handlers.ts` — `handleLogin` 扩展 email 分支（`identifier` 字段）+ `ENABLE_SMS_LOGIN` flag
- `worker/package.json` — 加 `disposable-email-domains` 依赖
- `dashboard/src/lib/auth.ts` — 加 `sendEmailCode()`，`login()` 改 `(identifier, code)` 签名
- `dashboard/src/components/LoginModal.tsx` — email 模式 placeholder / 校验 / 错误文案
- `dashboard/.env.example` — 加 `VITE_AUTH_CHANNEL=email` 默认值
- `docs/operations.md` — 加 Resend 服务节 + email auth 防刷阈值

---

## 阶段总览

| Phase | 内容 | Tasks |
|---|---|---|
| A | Schema + Env / types 基础设施 | A1-A3 |
| B | Worker utility 子模块 | B1-B6 |
| C | Endpoint handlers | C1-C2 |
| D | 路由接入 + 端到端 curl 验证 | D1-D2 |
| E | 前端改造 | E1-E4 |
| F | 文档同步 | F1 |
| G | 生产部署（依赖外部资源） | G1-G5 |

总 23 task。每 task 一个原子 commit。

---

## Phase A: Schema + Env / types

### Task A1: D1 migration 010 — email_send_log 表

**Files:**
- Create: `worker/migrations/010-email-send-log.sql`
- Modify: `worker/schema.sql`（追加同样定义）

- [ ] **Step 1: 写 migration 文件 `worker/migrations/010-email-send-log.sql`**

```sql
-- 010: email_send_log（email 验证码风控审计日志）
-- 设计参考：docs/plans/2026-05-06-email-auth-design.md § 3.1
-- 与 sms_send_log 完全对称（identifier 字段名 phone → email），独立维度统计

CREATE TABLE IF NOT EXISTS email_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  device_id TEXT,
  ua TEXT,
  sent_at INTEGER NOT NULL,
  result TEXT NOT NULL,
    -- 'success'
    -- | 'turnstile_failed'
    -- | 'rate_limited'
    -- | 'disposable_blocked'
    -- | 'mx_failed'
    -- | 'budget_capped'
    -- | 'resend_api_error'
  code_hash TEXT,
  code_expires_at INTEGER,
  code_attempts INTEGER NOT NULL DEFAULT 0,
  code_used_at INTEGER,
  metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_email_send_log_email_sent ON email_send_log(email, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_send_log_ip_sent ON email_send_log(ip, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_email_send_log_device_sent ON email_send_log(device_id, sent_at DESC);
```

- [ ] **Step 2: schema.sql 追加同样定义**（保持 schema.sql 与 migration 一致，便于全量 init）

- [ ] **Step 3: 本地 dry-run 验证 SQL 语法**

Run: `cd worker && npx wrangler d1 execute xlist --local --command "$(cat migrations/010-email-send-log.sql)"`
Expected: 无错误，本地 DB 多了 `email_send_log` 表。

- [ ] **Step 4: Commit**

```bash
git add worker/migrations/010-email-send-log.sql worker/schema.sql
git commit -m "feat(auth): D1 010 email_send_log 表（与 sms_send_log 对称）"
```

---

### Task A2: Env 接口扩展 + wrangler.toml 默认值

**Files:**
- Modify: `worker/src/index.ts:53-100`（Env interface 加新字段）
- Modify: `worker/wrangler.toml`（加 `[vars]` 默认值）

- [ ] **Step 1: Env interface 加 email 相关字段**

在 `worker/src/index.ts` 的 `export interface Env { ... }` 块（约 53-100 行），紧接现有 SMS 字段后追加：

```typescript
  // PR-EmailAuth：Resend + email 风控配置
  RESEND_API_KEY?: string;              // wrangler secret put 设置（不入 git）
  EMAIL_DAILY_CAP?: string;             // 默认 100（Resend free 100/天）
  EMAIL_MONTHLY_CAP?: string;           // 默认 3000（Resend free 3000/月）
  EMAIL_FROM?: string;                  // 默认 'AI Feeds <noreply@mail.ai-feeds.com>'
  ENABLE_SMS_LOGIN?: string;            // 'true' = 开放 SMS 通道（备案后），缺省/'false' = 关闭
  ENABLE_EMAIL_LOGIN?: string;          // 默认开启；'false' = 紧急关闭 email 通道
```

- [ ] **Step 2: wrangler.toml 加默认值**

先确认现有结构：`grep -E "^\[(vars|env\.staging)" worker/wrangler.toml`。

- 如果 `[vars]` 节已存在 → 在该节内追加新行（不要覆盖现有 vars）
- 如果 `[env.staging.vars]` 节已存在（staging 已上线，应该有）→ 在该节内追加新行
- 如果某节不存在 → 新建该节

要追加的 vars（`[vars]` 和 `[env.staging.vars]` 各一份，同样内容）：

```toml
# email auth 默认值（RESEND_API_KEY secret 通过 wrangler secret put 配置，不入 vars）
EMAIL_DAILY_CAP = "100"
EMAIL_MONTHLY_CAP = "3000"
EMAIL_FROM = "AI Feeds <noreply@mail.ai-feeds.com>"
ENABLE_SMS_LOGIN = "false"       # 备案后翻 true
ENABLE_EMAIL_LOGIN = "true"
```

注意：staging worker 用同样的发件域名（共享 ai-feeds.com Resend 配置），如果担心污染 reputation 后续可单独申请 staging 子域。

- [ ] **Step 3: typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts worker/wrangler.toml
git commit -m "feat(auth): Env 加 RESEND_API_KEY + email cap/flag + wrangler vars"
```

---

### Task A3: types.ts 扩展 EmailLogRow + EmailRateLimitResult

**Files:**
- Modify: `worker/src/auth/types.ts`

- [ ] **Step 1: 追加 email 相关类型**

在 `worker/src/auth/types.ts` 末尾追加：

```typescript
export interface EmailLogRow {
  id: number;
  email: string;
  ip: string;
  device_id: string | null;
  ua: string | null;
  sent_at: number;
  result:
    | 'success'
    | 'turnstile_failed'
    | 'rate_limited'
    | 'disposable_blocked'
    | 'mx_failed'
    | 'budget_capped'
    | 'resend_api_error';
  code_hash: string | null;
  code_expires_at: number | null;
  code_used_at: number | null;
  code_attempts: number;
  metadata: string | null;
}

export interface EmailRateLimitResult {
  ok: boolean;
  reason?:
    | 'email_60s_limit'
    | 'email_5min_limit'
    | 'email_24h_limit'
    | 'ip_1h_unique_emails_limit'
    | 'ip_24h_total_limit'
    | 'device_24h_unique_emails_limit'
    | 'email_locked_30min';
}
```

- [ ] **Step 2: typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 3: Commit**

```bash
git add worker/src/auth/types.ts
git commit -m "feat(auth): types 加 EmailLogRow + EmailRateLimitResult"
```

---

## Phase B: Worker utility 子模块

### Task B1: email validation 工具（regex + normalize + disposable + MX 入口）

**Files:**
- Create: `worker/src/auth/email-validation.ts`
- Modify: `worker/package.json`（加 `disposable-email-domains` 依赖）

- [ ] **Step 1: 安装 disposable-email-domains 包**

Run:
```bash
cd worker
npm install disposable-email-domains
```

Expected: `package.json` 多一行 `"disposable-email-domains": "^x.y.z"`，`package-lock.json` 更新。

- [ ] **Step 2: 写 `worker/src/auth/email-validation.ts`**

```typescript
// PR-EmailAuth：email validation + disposable + MX 预校验
// 设计参考：docs/plans/2026-05-06-email-auth-design.md § 5.1 + § 5.2

import disposableDomains from 'disposable-email-domains';
import type { Env } from '../index';

// RFC 5322 简化版（不追求完美，过滤明显错误足够）
export const EMAIL_REGEX = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;

/** 归一化：trim + lowercase（数据库唯一键比较前必须做） */
export function normalizeEmail(input: string): string {
  return input.trim().toLowerCase();
}

/** 提取 domain 部分；输入必须已 normalize 过 */
export function emailDomain(email: string): string {
  const at = email.lastIndexOf('@');
  return at < 0 ? '' : email.slice(at + 1);
}

// 一次性邮箱黑名单（启动时构建 Set，O(1) 查询）
const DISPOSABLE_SET = new Set(disposableDomains.map((d: string) => d.toLowerCase()));

export function isDisposableDomain(domain: string): boolean {
  return DISPOSABLE_SET.has(domain.toLowerCase());
}

// MX 预校验 — 用 cloudflare-dns.com DoH，KV 缓存 24h
const MX_CACHE_TTL_SEC = 24 * 3600;

interface DoHAnswer {
  Status: number;
  Answer?: Array<{ name: string; type: number; data: string }>;
}

export async function checkMxRecord(env: Env, domain: string): Promise<boolean> {
  const cacheKey = `mx_cache_${domain}`;
  const cached = await env.AUTH_KV.get(cacheKey);
  if (cached === 'ok') return true;
  if (cached === 'fail') return false;

  // 没缓存 → 查 DoH
  let result: 'ok' | 'fail';
  try {
    const r = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(domain)}&type=MX`,
      { headers: { 'Accept': 'application/dns-json' } },
    );
    if (!r.ok) {
      // DoH 抖动 → 默认放行（不因 DNS 失败拦正常用户）
      return true;
    }
    const data = (await r.json()) as DoHAnswer;
    // type=15 是 MX 记录；Status=0 表示成功响应
    const hasMx = data.Status === 0 && (data.Answer?.some((a) => a.type === 15) ?? false);
    result = hasMx ? 'ok' : 'fail';
  } catch {
    // 网络错误 → 默认放行
    return true;
  }

  // 缓存 24h（含 fail，避免对同一假域名反复查）
  await env.AUTH_KV.put(cacheKey, result, { expirationTtl: MX_CACHE_TTL_SEC });
  return result === 'ok';
}
```

- [ ] **Step 3: typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add worker/src/auth/email-validation.ts worker/package.json worker/package-lock.json
git commit -m "feat(auth): email-validation（regex + normalize + disposable + MX DoH）"
```

---

### Task B2: email 6 维度限流

**Files:**
- Create: `worker/src/auth/email-rate-limit.ts`

- [ ] **Step 1: 写 `worker/src/auth/email-rate-limit.ts`**

```typescript
// PR-EmailAuth：email 6 维度限流
// 设计参考：docs/plans/2026-05-06-email-auth-design.md § 5.3
// 与 sms.ts checkRateLimits 同结构，identifier 字段从 phone 改为 email

import type { Env } from '../index';
import type { EmailRateLimitResult } from './types';

const LOCK_DURATION_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS_BEFORE_LOCK = 5;

export async function checkEmailRateLimits(
  env: Env,
  email: string,
  ip: string,
  deviceId: string | null,
): Promise<EmailRateLimitResult> {
  const now = Date.now();
  const ago = (ms: number) => now - ms;

  // email 60s
  const r1 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM email_send_log WHERE email = ? AND result = 'success' AND sent_at > ?`,
  ).bind(email, ago(60_000)).first<{ n: number }>();
  if ((r1?.n ?? 0) >= 1) return { ok: false, reason: 'email_60s_limit' };

  // email 5min
  const r2 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM email_send_log WHERE email = ? AND result = 'success' AND sent_at > ?`,
  ).bind(email, ago(5 * 60_000)).first<{ n: number }>();
  if ((r2?.n ?? 0) >= 3) return { ok: false, reason: 'email_5min_limit' };

  // email 24h
  const r3 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM email_send_log WHERE email = ? AND result = 'success' AND sent_at > ?`,
  ).bind(email, ago(24 * 3600_000)).first<{ n: number }>();
  if ((r3?.n ?? 0) >= 10) return { ok: false, reason: 'email_24h_limit' };

  // ip 1h unique emails
  const r4 = await env.DB.prepare(
    `SELECT COUNT(DISTINCT email) as n FROM email_send_log WHERE ip = ? AND result = 'success' AND sent_at > ?`,
  ).bind(ip, ago(3600_000)).first<{ n: number }>();
  if ((r4?.n ?? 0) >= 10) return { ok: false, reason: 'ip_1h_unique_emails_limit' };

  // ip 24h total
  const r5 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM email_send_log WHERE ip = ? AND result = 'success' AND sent_at > ?`,
  ).bind(ip, ago(24 * 3600_000)).first<{ n: number }>();
  if ((r5?.n ?? 0) >= 30) return { ok: false, reason: 'ip_24h_total_limit' };

  // device 24h unique emails
  if (deviceId) {
    const r6 = await env.DB.prepare(
      `SELECT COUNT(DISTINCT email) as n FROM email_send_log WHERE device_id = ? AND result = 'success' AND sent_at > ?`,
    ).bind(deviceId, ago(24 * 3600_000)).first<{ n: number }>();
    if ((r6?.n ?? 0) >= 5) return { ok: false, reason: 'device_24h_unique_emails_limit' };
  }

  // 验证码失败锁
  const r7 = await env.DB.prepare(
    `SELECT code_attempts, sent_at FROM email_send_log
     WHERE email = ? AND result = 'success'
     ORDER BY sent_at DESC LIMIT 1`,
  ).bind(email).first<{ code_attempts: number; sent_at: number }>();
  if (r7 && r7.code_attempts >= MAX_ATTEMPTS_BEFORE_LOCK && r7.sent_at > ago(LOCK_DURATION_MS)) {
    return { ok: false, reason: 'email_locked_30min' };
  }

  return { ok: true };
}
```

- [ ] **Step 2: typecheck + commit**

```bash
cd worker && npx tsc --noEmit
git add worker/src/auth/email-rate-limit.ts
git commit -m "feat(auth): email-rate-limit 6 维度（与 sms 同结构）"
```

---

### Task B3: email daily/monthly cap + 告警

**Files:**
- Create: `worker/src/auth/email-cap.ts`

- [ ] **Step 1: 写 `worker/src/auth/email-cap.ts`**

```typescript
// PR-EmailAuth：email daily + monthly cap + 80%/95% 告警
// 设计参考：docs/plans/2026-05-06-email-auth-design.md § 5.4

import type { Env } from '../index';
import { pushDeerAlert } from '../notifier';

const DEFAULT_DAILY_CAP = 100;
const DEFAULT_MONTHLY_CAP = 3000;

function todayKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `email_count_${yyyy}${mm}${dd}`;
}

function monthKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `email_count_${yyyy}${mm}`;
}

/** 日度 cap 检查 + 自增（best-effort，KV 无原子 INCR；并发可能漏 1-2，可接受） */
export async function checkAndIncrEmailDailyCap(
  env: Env,
): Promise<{ ok: boolean; sent: number; cap: number }> {
  const cap = parseInt(env.EMAIL_DAILY_CAP || String(DEFAULT_DAILY_CAP), 10);
  if (cap <= 0) return { ok: false, sent: 0, cap };  // kill switch
  const key = todayKey();
  const cur = await env.AUTH_KV.get(key);
  const sent = cur ? parseInt(cur, 10) : 0;
  if (sent >= cap) return { ok: false, sent, cap };
  await env.AUTH_KV.put(key, String(sent + 1), { expirationTtl: 36 * 3600 });
  return { ok: true, sent: sent + 1, cap };
}

/** 月度 cap 检查 + 自增 */
export async function checkAndIncrEmailMonthlyCap(
  env: Env,
): Promise<{ ok: boolean; sent: number; cap: number }> {
  const cap = parseInt(env.EMAIL_MONTHLY_CAP || String(DEFAULT_MONTHLY_CAP), 10);
  if (cap <= 0) return { ok: false, sent: 0, cap };
  const key = monthKey();
  const cur = await env.AUTH_KV.get(key);
  const sent = cur ? parseInt(cur, 10) : 0;
  if (sent >= cap) return { ok: false, sent, cap };
  await env.AUTH_KV.put(key, String(sent + 1), { expirationTtl: 35 * 24 * 3600 });
  return { ok: true, sent: sent + 1, cap };
}

/** 跨 80% / 95% 阈值告警（去重：同阈值同日只发一次） */
export async function checkEmailDailyCapAlerts(env: Env, sent: number, cap: number): Promise<void> {
  const pct = sent / cap;
  const dateStr = todayKey().slice(-8);  // YYYYMMDD
  if (pct >= 0.95) {
    const dedupKey = `email_alert_daily_95_${dateStr}`;
    if (!(await env.AUTH_KV.get(dedupKey))) {
      await env.AUTH_KV.put(dedupKey, '1', { expirationTtl: 36 * 3600 });
      await pushDeerAlert(env, 'Email 95% 紧急', `今日 email 已发 ${sent}/${cap}，建议升级 Resend 或临时把 EMAIL_DAILY_CAP 调到 0 切流`);
    }
  } else if (pct >= 0.80) {
    const dedupKey = `email_alert_daily_80_${dateStr}`;
    if (!(await env.AUTH_KV.get(dedupKey))) {
      await env.AUTH_KV.put(dedupKey, '1', { expirationTtl: 36 * 3600 });
      await pushDeerAlert(env, 'Email 80% 警告', `今日 email 已发 ${sent}/${cap}，关注异常 IP/email 分布`);
    }
  }
}

export async function checkEmailMonthlyCapAlerts(env: Env, sent: number, cap: number): Promise<void> {
  const pct = sent / cap;
  const monthStr = monthKey().slice(-6);  // YYYYMM
  if (pct >= 0.95) {
    const dedupKey = `email_alert_monthly_95_${monthStr}`;
    if (!(await env.AUTH_KV.get(dedupKey))) {
      await env.AUTH_KV.put(dedupKey, '1', { expirationTtl: 35 * 24 * 3600 });
      await pushDeerAlert(env, 'Email 月度 95% 紧急', `本月 email 已发 ${sent}/${cap}，需要立即升级 Resend 付费档`);
    }
  } else if (pct >= 0.80) {
    const dedupKey = `email_alert_monthly_80_${monthStr}`;
    if (!(await env.AUTH_KV.get(dedupKey))) {
      await env.AUTH_KV.put(dedupKey, '1', { expirationTtl: 35 * 24 * 3600 });
      await pushDeerAlert(env, 'Email 月度 80% 警告', `本月 email 已发 ${sent}/${cap}，预算关注`);
    }
  }
}
```

- [ ] **Step 2: typecheck + commit**

```bash
cd worker && npx tsc --noEmit
git add worker/src/auth/email-cap.ts
git commit -m "feat(auth): email-cap（daily + monthly + 去重告警）"
```

---

### Task B4: Resend HTTPS API client（含 dev fallback）

**Files:**
- Create: `worker/src/auth/resend.ts`

- [ ] **Step 1: 写 `worker/src/auth/resend.ts`**

```typescript
// PR-EmailAuth：Resend HTTPS API client
// 设计参考：docs/plans/2026-05-06-email-auth-design.md § 9.1
// dev fallback：缺 RESEND_API_KEY 时走 PushDeer 推到 admin（与 SMS PushDeer fallback 同模式）

import type { Env } from '../index';
import { pushDeerAlert } from '../notifier';

const RESEND_API = 'https://api.resend.com/emails';

interface SendEmailResult {
  ok: boolean;
  id?: string;
  errCode?: string;
  errMsg?: string;
}

function buildEmailText(code: string): string {
  return [
    '【AI Feeds】',
    '',
    `验证码：${code}`,
    '',
    '5 分钟内有效，请勿告诉他人。',
    '',
    '如果不是你本人操作，请忽略此邮件。',
    '',
    '---',
    'AI Feeds（https://ai-feeds.com）',
  ].join('\n');
}

/** dev / 冷启动期 fallback：RESEND_API_KEY 缺失时把验证码推到 admin PushDeer */
async function sendEmailViaPushDeer(env: Env, to: string, code: string): Promise<SendEmailResult> {
  if (!env.PUSHDEER_ADMIN_KEYS) {
    console.warn(`[email] dev simulate（无 RESEND_API_KEY 也无 PUSHDEER_ADMIN_KEYS）to=${to} code=${code}`);
    return { ok: true, id: `dev-simulated-${Date.now()}` };
  }
  await pushDeerAlert(
    env,
    'AI Feeds 验证码',
    `email：${to}\n\n**${code}**\n\n5 分钟有效。如非本人请求请忽略。`,
  );
  return { ok: true, id: `pushdeer-${Date.now()}` };
}

export async function sendEmailViaResend(
  env: Env,
  to: string,
  code: string,
): Promise<SendEmailResult> {
  if (!env.RESEND_API_KEY) {
    return sendEmailViaPushDeer(env, to, code);
  }

  const from = env.EMAIL_FROM || 'AI Feeds <noreply@mail.ai-feeds.com>';

  let r: Response;
  try {
    r = await fetch(RESEND_API, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to,
        subject: `你的登录验证码：${code}`,
        text: buildEmailText(code),
      }),
    });
  } catch (e) {
    return { ok: false, errCode: 'NETWORK', errMsg: String(e).slice(0, 200) };
  }

  if (!r.ok) {
    const errMsg = await r.text().catch(() => '');
    return { ok: false, errCode: String(r.status), errMsg: errMsg.slice(0, 200) };
  }

  const data = (await r.json()) as { id?: string };
  return { ok: true, id: data.id || 'no-id' };
}
```

- [ ] **Step 2: typecheck + commit**

```bash
cd worker && npx tsc --noEmit
git add worker/src/auth/resend.ts
git commit -m "feat(auth): Resend HTTPS API client（含 dev PushDeer fallback）"
```

---

### Task B5: handleEmailSend handler

**Files:**
- Create: `worker/src/auth/email-handlers.ts`

- [ ] **Step 1: 写 `worker/src/auth/email-handlers.ts`**

```typescript
// PR-EmailAuth：/api/auth/email/send handler
// 设计参考：docs/plans/2026-05-06-email-auth-design.md § 4.2

import type { Env } from '../index';
import { verifyTurnstile } from './turnstile';
import {
  EMAIL_REGEX,
  normalizeEmail,
  emailDomain,
  isDisposableDomain,
  checkMxRecord,
} from './email-validation';
import { checkEmailRateLimits } from './email-rate-limit';
import {
  checkAndIncrEmailDailyCap,
  checkAndIncrEmailMonthlyCap,
  checkEmailDailyCapAlerts,
  checkEmailMonthlyCapAlerts,
} from './email-cap';
import { sendEmailViaResend } from './resend';
import { generateCode, hashCode } from './sms';  // 复用 SMS 端的纯函数
import { pushDeerAlert } from '../notifier';

const CODE_HASH_SALT = 'xlist-email-v1';

function jsonOk(data: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function jsonErr(message: string, status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getClientIp(req: Request): string {
  return req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || '0.0.0.0';
}

interface EmailSendBody {
  email: string;
  turnstile_token: string;
}

const RL_SEVERE = ['email_24h_limit', 'email_locked_30min', 'ip_24h_total_limit'];

export async function handleEmailSend(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 0. 全局 flag
  if (env.ENABLE_EMAIL_LOGIN === 'false') {
    return jsonErr('email login disabled', 503);
  }

  // 1. device_id + email 字段校验
  const deviceId = request.headers.get('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
    return jsonErr('missing or invalid X-Device-Id', 400);
  }

  let body: EmailSendBody;
  try {
    body = (await request.json()) as EmailSendBody;
  } catch {
    return jsonErr('invalid json', 400);
  }

  if (typeof body.email !== 'string') return jsonErr('invalid email', 400);
  const email = normalizeEmail(body.email);
  if (!EMAIL_REGEX.test(email)) return jsonErr('invalid email', 400);

  const ip = getClientIp(request);
  const ua = request.headers.get('User-Agent') || '';
  const now = Date.now();

  // 2. Turnstile
  const tsOk = await verifyTurnstile(env, body.turnstile_token || null, ip);
  if (!tsOk) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result)
       VALUES (?, ?, ?, ?, ?, 'turnstile_failed')`,
    ).bind(email, ip, deviceId, ua, now).run();
    return jsonErr('captcha failed', 403);
  }

  // 3. disposable
  const domain = emailDomain(email);
  if (isDisposableDomain(domain)) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result)
       VALUES (?, ?, ?, ?, ?, 'disposable_blocked')`,
    ).bind(email, ip, deviceId, ua, now).run();
    return jsonErr('please use a real email', 400, { reason: 'disposable_blocked' });
  }

  // 4. MX 预校验
  const mxOk = await checkMxRecord(env, domain);
  if (!mxOk) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result)
       VALUES (?, ?, ?, ?, ?, 'mx_failed')`,
    ).bind(email, ip, deviceId, ua, now).run();
    return jsonErr('email domain has no mx record', 400, { reason: 'mx_failed' });
  }

  // 5. 6 维度限流
  const rl = await checkEmailRateLimits(env, email, ip, deviceId);
  if (!rl.ok) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'rate_limited', ?)`,
    ).bind(email, ip, deviceId, ua, now, JSON.stringify({ reason: rl.reason })).run();
    if (rl.reason && RL_SEVERE.includes(rl.reason)) {
      ctx.waitUntil(
        pushDeerAlert(env, '风控命中(email)', `email=${email} ip=${ip} reason=${rl.reason}`),
      );
    }
    return jsonErr('rate limited', 429, { reason: rl.reason });
  }

  // 6. 日度 cap（先做，阈值更紧）
  const dayCap = await checkAndIncrEmailDailyCap(env);
  if (!dayCap.ok) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'budget_capped', ?)`,
    ).bind(email, ip, deviceId, ua, now, JSON.stringify({ scope: 'daily', sent: dayCap.sent, cap: dayCap.cap })).run();
    ctx.waitUntil(
      pushDeerAlert(env, 'Email 当日额度耗尽', `今日发送 ${dayCap.sent}/${dayCap.cap}（cap=0 = kill switch）。后续请求 503 直到明日 0 点 UTC 重置。`),
    );
    return jsonErr('service unavailable', 503);
  }

  // 7. 月度 cap
  const monthCap = await checkAndIncrEmailMonthlyCap(env);
  if (!monthCap.ok) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'budget_capped', ?)`,
    ).bind(email, ip, deviceId, ua, now, JSON.stringify({ scope: 'monthly', sent: monthCap.sent, cap: monthCap.cap })).run();
    ctx.waitUntil(
      pushDeerAlert(env, 'Email 当月额度耗尽', `本月发送 ${monthCap.sent}/${monthCap.cap}。需立即升级 Resend 付费档或调整 cap。`),
    );
    return jsonErr('service unavailable', 503);
  }

  // 8. 跨阈值告警
  ctx.waitUntil(checkEmailDailyCapAlerts(env, dayCap.sent, dayCap.cap));
  ctx.waitUntil(checkEmailMonthlyCapAlerts(env, monthCap.sent, monthCap.cap));

  // 9. 生成 + hash + 发邮件
  const code = generateCode();
  const codeHash = await hashCode(code, CODE_HASH_SALT);
  const expiresAt = now + 5 * 60_000;

  const sendResult = await sendEmailViaResend(env, email, code);
  if (!sendResult.ok) {
    await env.DB.prepare(
      `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'resend_api_error', ?)`,
    ).bind(email, ip, deviceId, ua, now, JSON.stringify({ errCode: sendResult.errCode, errMsg: sendResult.errMsg })).run();
    return jsonErr('email send failed', 502, { errCode: sendResult.errCode });
  }

  // 10. 落 success row
  await env.DB.prepare(
    `INSERT INTO email_send_log (email, ip, device_id, ua, sent_at, result, code_hash, code_expires_at, metadata)
     VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`,
  ).bind(
    email, ip, deviceId, ua, now, codeHash, expiresAt,
    JSON.stringify({ resendId: sendResult.id }),
  ).run();

  return jsonOk({ ok: true, ttl: 300 });
}
```

- [ ] **Step 2: typecheck + commit**

```bash
cd worker && npx tsc --noEmit
git add worker/src/auth/email-handlers.ts
git commit -m "feat(auth): /api/auth/email/send handler 编排"
```

---

### Task B6: 在 sms.ts export `generateCode` 和 `hashCode`（如已 export 跳过）

**Files:**
- Modify: `worker/src/auth/sms.ts`（确认 export）

- [ ] **Step 1: 检查 `worker/src/auth/sms.ts` 中 `generateCode` 和 `hashCode` 是否已 `export`**

Run: `grep -n "^export function generateCode\|^export async function hashCode" worker/src/auth/sms.ts`
Expected: 两行都匹配（已是 export — Task B5 中我直接 import 它们能成立的前提）。如果不是 export，加上 `export` 关键字。

- [ ] **Step 2: 如果有改动 → typecheck + commit；否则跳过本 task**

如果改了：
```bash
cd worker && npx tsc --noEmit
git add worker/src/auth/sms.ts
git commit -m "refactor(auth): export sms.ts 中的 generateCode + hashCode 供 email 复用"
```

否则：本 task 删除（不形成 commit）。

---

## Phase C: Endpoint handlers

### Task C1: handleLogin 扩展 email 分支 + ENABLE_SMS_LOGIN flag

**Files:**
- Modify: `worker/src/auth/handlers.ts`（扩展 `handleLogin`）

- [ ] **Step 1: 修改 `handleLogin`**

替换 `worker/src/auth/handlers.ts` 中的 `handleLogin` 函数（约 172-311 行）为以下版本：

```typescript
// ─── POST /api/auth/login ────────────────────────────────

interface LoginBody {
  identifier?: string;  // 新字段：phone 或 email（推荐）
  phone?: string;       // 老字段 fallback：仅 phone（hedge dashboard 缓存场景）
  code: string;
}

const PHONE_REGEX_LOGIN = /^1[3-9]\d{9}$/;
const EMAIL_REGEX_LOGIN = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/;
const SMS_HASH_SALT = 'xlist-sms-v1';
const EMAIL_HASH_SALT = 'xlist-email-v1';

export async function handleLogin(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const deviceId = request.headers.get('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
    return jsonErr('missing or invalid X-Device-Id', 400);
  }

  let body: LoginBody;
  try {
    body = (await request.json()) as LoginBody;
  } catch {
    return jsonErr('invalid json', 400);
  }

  // identifier 兼容：优先 identifier，fallback 老 phone 字段
  const rawId = (body.identifier ?? body.phone ?? '').trim();
  if (!rawId) return jsonErr('missing identifier', 400);

  let provider: 'phone' | 'email';
  let identifier: string;
  if (PHONE_REGEX_LOGIN.test(rawId)) {
    provider = 'phone';
    identifier = rawId;
  } else if (EMAIL_REGEX_LOGIN.test(rawId.toLowerCase())) {
    provider = 'email';
    identifier = rawId.toLowerCase();
  } else {
    return jsonErr('invalid identifier', 400);
  }

  // Feature flag：备案前 phone 通道关闭
  if (provider === 'phone' && env.ENABLE_SMS_LOGIN !== 'true') {
    return jsonErr('sms login disabled', 403, { reason: 'sms_disabled' });
  }
  if (provider === 'email' && env.ENABLE_EMAIL_LOGIN === 'false') {
    return jsonErr('email login disabled', 403, { reason: 'email_disabled' });
  }

  if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) {
    return jsonErr('invalid code format', 400);
  }

  const ip = getClientIp(request);
  const ua = request.headers.get('User-Agent') || '';
  const now = Date.now();

  // 表名 + 列名 + salt 按 provider 切换
  const logTable = provider === 'phone' ? 'sms_send_log' : 'email_send_log';
  const idCol = provider === 'phone' ? 'phone' : 'email';
  const hashSalt = provider === 'phone' ? SMS_HASH_SALT : EMAIL_HASH_SALT;

  // 1. 找最新一条未消费的 success row
  const row = await env.DB.prepare(
    `SELECT id, code_hash, code_expires_at, code_attempts, sent_at
     FROM ${logTable}
     WHERE ${idCol} = ? AND result = 'success' AND code_used_at IS NULL
     ORDER BY sent_at DESC LIMIT 1`,
  ).bind(identifier).first<{
    id: number;
    code_hash: string;
    code_expires_at: number;
    code_attempts: number;
    sent_at: number;
  }>();

  if (!row) return jsonErr('no pending code', 401);
  if (row.code_expires_at < now) return jsonErr('code expired', 401);
  if (row.code_attempts >= 5) return jsonErr('too many attempts, locked', 429);

  // 2. 校验 code
  const inputHash = await hashCode(body.code, hashSalt);
  if (inputHash !== row.code_hash) {
    await env.DB.prepare(
      `UPDATE ${logTable} SET code_attempts = code_attempts + 1 WHERE id = ?`,
    ).bind(row.id).run();
    const remaining = 5 - (row.code_attempts + 1);
    return jsonErr('invalid code', 401, { attempts_remaining: Math.max(remaining, 0) });
  }

  // 3. mark used
  await env.DB.prepare(
    `UPDATE ${logTable} SET code_used_at = ? WHERE id = ?`,
  ).bind(now, row.id).run();

  // 4. 找/建 user（按 provider 查 identities）
  const ident = await env.DB.prepare(
    `SELECT user_id FROM identities
     WHERE provider = ? AND identity_value = ? AND unbound_at IS NULL`,
  ).bind(provider, identifier).first<{ user_id: string }>();

  let userId: string;
  let isNewUser = false;
  if (ident) {
    userId = ident.user_id;
    await env.DB.prepare(`UPDATE users SET last_active_at = ? WHERE id = ?`).bind(now, userId).run();
  } else {
    userId = nanoid(14);
    isNewUser = true;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, created_at, last_active_at, status) VALUES (?, ?, ?, 'active')`,
      ).bind(userId, now, now),
      env.DB.prepare(
        `INSERT INTO identities (user_id, provider, identity_value, verified_at) VALUES (?, ?, ?, ?)`,
      ).bind(userId, provider, identifier, now),
    ]);
  }

  // 5. 关联 device → 历史 events 行的 user_id
  ctx.waitUntil(
    env.DB.prepare(
      `UPDATE events SET user_id = ?
       WHERE device_id = ? AND user_id IS NULL AND occurred_at > ?`,
    ).bind(userId, deviceId, now - 30 * 24 * 3600_000).run(),
  );

  // 6. PR5 landing 回流
  ctx.waitUntil(
    env.DB.prepare(
      `UPDATE share_relations SET to_uid = ?, registered_at = ?
       WHERE to_did = ? AND to_uid IS NULL`,
    ).bind(userId, now, deviceId).run(),
  );

  // 7. 创建 session
  const session = await createSession(env, userId, deviceId, ip, ua);
  const cookie = buildSessionCookie(session.id, isDevHost(request));

  return jsonOk(
    {
      user: {
        id: userId,
        display_name: null,
        avatar_url: null,
        is_new: isNewUser,
      },
      session: {
        id: session.id,
        expires_at: session.expiresAt,
      },
    },
    { 'Set-Cookie': cookie },
  );
}
```

注：`hashCode` 已经从 `./sms` import 在文件顶部（确认 import 行包含 `hashCode`，如不包含则添加）。

- [ ] **Step 2: 确认 hashCode import**

Run: `grep -n "hashCode" worker/src/auth/handlers.ts | head -3`
Expected: 至少两行 — 一行 import，一行使用。

- [ ] **Step 3: typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add worker/src/auth/handlers.ts
git commit -m "feat(auth): /api/auth/login 扩展 email + ENABLE_SMS_LOGIN flag"
```

---

### Task C2: handleMe / handleDelete 兼容多 provider

**Files:**
- Modify: `worker/src/auth/handlers.ts`（`handleMe` + `handleDelete`）

- [ ] **Step 1: 修改 `handleMe` 改为找当前主 identity（phone OR email），脱敏返回**

替换 `worker/src/auth/handlers.ts` 中 `handleMe` 末尾的 phone 查询块（约 359-376 行）：

```typescript
  // 找当前主 identity（脱敏；优先 email，fallback phone）
  const ident = await env.DB.prepare(
    `SELECT provider, identity_value FROM identities
     WHERE user_id = ? AND unbound_at IS NULL
     ORDER BY verified_at DESC LIMIT 1`,
  ).bind(auth.userId).first<{ provider: string; identity_value: string }>();

  let identityMasked: string | null = null;
  let identityProvider: string | null = null;
  if (ident) {
    identityProvider = ident.provider;
    if (ident.provider === 'phone') {
      identityMasked = `${ident.identity_value.slice(0, 3)}****${ident.identity_value.slice(-4)}`;
    } else if (ident.provider === 'email') {
      // 脱敏：abc@xx.com → a***@xx.com
      const [local, domain] = ident.identity_value.split('@');
      identityMasked = `${local[0]}***@${domain}`;
    }
  }

  return jsonOk({
    user: {
      id: user.id,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
      identity_masked: identityMasked,
      identity_provider: identityProvider,
      // 老字段保留兼容（dashboard 全量切到 identity_masked 后下线）
      phone_masked: ident?.provider === 'phone' ? identityMasked : null,
    },
  });
```

- [ ] **Step 2: 修改 `handleDelete` 用 generic identity 查询**

替换 `handleDelete` 中查 phone identity 的块（约 404-415 行）为：

```typescript
  // 找当前主 identity（任意 provider，按最近验证）
  const ident = await env.DB.prepare(
    `SELECT id, provider, identity_value FROM identities
     WHERE user_id = ? AND unbound_at IS NULL
     ORDER BY verified_at DESC LIMIT 1`,
  ).bind(auth.userId).first<{ id: number; provider: string; identity_value: string }>();

  if (!ident) {
    return jsonErr('no identity found', 404);
  }

  // body 字段历史叫 phone_confirm，扩展为通用 confirm（保留 phone_confirm fallback）
  const confirm = (body as DeleteBody & { confirm?: string }).confirm ?? body.phone_confirm;
  if (typeof confirm !== 'string' || confirm !== ident.identity_value) {
    return jsonErr('identity confirm mismatch', 400);
  }
```

注：DeleteBody 接口加 `confirm?: string` 字段，`phone_confirm` 改 optional：

```typescript
interface DeleteBody {
  phone_confirm?: string;
  confirm?: string;
}
```

- [ ] **Step 3: typecheck + commit**

```bash
cd worker && npx tsc --noEmit
git add worker/src/auth/handlers.ts
git commit -m "feat(auth): handleMe/handleDelete 支持多 provider identity"
```

---

## Phase D: 路由接入 + 端到端验证

### Task D1: 加 `/api/auth/email/send` 路由 + import

**Files:**
- Modify: `worker/src/index.ts`（约第 36 行 import + 196 行附近路由）

- [ ] **Step 1: import handleEmailSend**

修改 `worker/src/index.ts` 文件顶部 auth handlers import（约第 32-37 行），追加 `handleEmailSend`：

```typescript
import {
  handleSmsSend,
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleMe,
  handleDelete,
} from './auth/handlers';
import { handleEmailSend } from './auth/email-handlers';
```

- [ ] **Step 2: 加路由**

在 `worker/src/index.ts` 已有 `/api/auth/sms/send` 路由（约第 196-198 行）后追加：

```typescript
      if (path === '/api/auth/email/send' && request.method === 'POST') {
        return withCors(await handleEmailSend(request, env, ctx), request, env);
      }
```

- [ ] **Step 3: typecheck**

Run: `cd worker && npx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 4: Commit**

```bash
git add worker/src/index.ts
git commit -m "feat(auth): 路由 /api/auth/email/send 接入"
```

---

### Task D2: wrangler dev e2e curl 验证矩阵

**Files:** 无新文件，仅 dev 验证。

- [ ] **Step 1: 起 wrangler dev**

Run: `cd worker && npx wrangler dev --local`
Expected: dev server 起在 `http://localhost:8787`。

注：本地 dev 没有 RESEND_API_KEY → 走 PushDeer fallback；没有 PUSHDEER_ADMIN_KEYS → console.log 明文 code。dev 测试看 dev server 终端输出找 code。

- [ ] **Step 2: 跑 curl 矩阵（另开终端）**

```bash
DEV=http://localhost:8787

# 1. 正常 send（dev 跑会 console.log code，记下来）
curl -i -X POST $DEV/api/auth/email/send \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: testdev123456789" \
  -d '{"email":"test@gmail.com","turnstile_token":""}'
# 期望：200 ok（Turnstile dev 模式 bypass）

# 2. invalid email 格式
curl -i -X POST $DEV/api/auth/email/send \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: testdev123456789" \
  -d '{"email":"notanemail","turnstile_token":""}'
# 期望：400 invalid email

# 3. disposable email
curl -i -X POST $DEV/api/auth/email/send \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: testdev123456789" \
  -d '{"email":"foo@mailinator.com","turnstile_token":""}'
# 期望：400 disposable_blocked

# 4. mx fail
curl -i -X POST $DEV/api/auth/email/send \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: testdev123456789" \
  -d '{"email":"foo@thisdomaindefdoesnotexist123abc.tld","turnstile_token":""}'
# 期望：400 mx_failed（DoH 查询无 MX）

# 5. 60s 限流（连发两次同邮箱）
curl -X POST $DEV/api/auth/email/send -H "Content-Type: application/json" -H "X-Device-Id: testdev123456789" -d '{"email":"a@gmail.com","turnstile_token":""}'
curl -i -X POST $DEV/api/auth/email/send -H "Content-Type: application/json" -H "X-Device-Id: testdev123456789" -d '{"email":"a@gmail.com","turnstile_token":""}'
# 期望第二次：429 reason=email_60s_limit

# 6. login（用 step 1 拿到的 code）
curl -i -X POST $DEV/api/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: testdev123456789" \
  -d '{"identifier":"test@gmail.com","code":"<6位code>"}'
# 期望：200 + Set-Cookie，is_new=true

# 7. ENABLE_SMS_LOGIN=false 时 phone 走 login
curl -i -X POST $DEV/api/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: testdev123456789" \
  -d '{"identifier":"13800001234","code":"123456"}'
# 期望：403 sms login disabled
```

- [ ] **Step 3: 检查 D1 落库**

Run:
```bash
cd worker && npx wrangler d1 execute xlist --local \
  --command "SELECT email, result, datetime(sent_at/1000,'unixepoch') AS sent FROM email_send_log ORDER BY sent_at DESC LIMIT 10"
```
Expected: 表格 7 行左右，覆盖 success / disposable_blocked / mx_failed / rate_limited 等不同 result。

- [ ] **Step 4: 通过后 commit**

无代码改动，本 task 仅为验证。如发现 bug 需要修复，修完后 squash 到对应 task 的 commit 里。

---

## Phase E: 前端改造

### Task E1: dashboard/src/lib/auth.ts 扩展

**Files:**
- Modify: `dashboard/src/lib/auth.ts`

- [ ] **Step 1: 加 `sendEmailCode` 函数 + `login` 改 generic 签名**

替换 `dashboard/src/lib/auth.ts` 中 `sendSmsCode` 后的 `login` 函数为：

```typescript
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

export async function sendEmailCode(
  email: string,
  turnstileToken: string,
): Promise<{ ok: true; ttl: number }> {
  const res = await authFetch('/api/auth/email/send', {
    method: 'POST',
    body: { email, turnstile_token: turnstileToken },
  });
  return parseOrThrow(res);
}

/**
 * 登录入口：identifier 同时接受 phone 或 email
 * worker handler 按格式自动路由到对应 verify path
 */
export async function login(identifier: string, code: string): Promise<LoginResponse> {
  const res = await authFetch('/api/auth/login', {
    method: 'POST',
    body: { identifier, code },
  });
  return parseOrThrow(res);
}
```

- [ ] **Step 2: User type 加 `identity_masked` + `identity_provider` 字段**

修改 User interface 加新字段（保留 `phone_masked` 不删，下次 PR 删）：

```typescript
export interface User {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at?: number;
  // 新字段（推荐使用）
  identity_masked?: string | null;
  identity_provider?: string | null;
  // 老字段保留兼容
  phone_masked?: string | null;
}
```

- [ ] **Step 3: typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: 0 errors（如果有 caller 用 `login(phone, code)` 现在签名兼容，不会报错）。

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/lib/auth.ts
git commit -m "feat(auth): lib/auth.ts 加 sendEmailCode + login(identifier, code)"
```

---

### Task E2: LoginModal email 模式 + 错误文案

**Files:**
- Modify: `dashboard/src/components/LoginModal.tsx`

- [ ] **Step 1: 改输入框 / 校验 / 错误文案**

替换 `dashboard/src/components/LoginModal.tsx` 顶部常量与状态名（约第 8-11 行 + 56-66 行）：

把 `PHONE_REGEX` 改为 `EMAIL_REGEX`：

```typescript
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

把 `phone` state 改为 `email`，`setPhone` → `setEmail`，相关变量 `phoneError`/`setPhoneError` 保留语义（输入框旁的错误条），但显示文案对齐邮箱场景。

替换 `handleSendCode` 函数（约第 134-169 行）：

```typescript
async function handleSendCode() {
  setPhoneError('');
  setCodeError('');
  const trimmed = email.trim().toLowerCase();
  if (!EMAIL_REGEX.test(trimmed)) {
    setPhoneError('请输入正确的邮箱');
    return;
  }
  if (!turnstileToken) {
    setPhoneError('请先完成人机验证');
    return;
  }
  setLoading(true);
  track(EVENTS.SMS_SEND_ATTEMPT, { channel: 'email' });
  try {
    await authApi.sendEmailCode(trimmed, turnstileToken);
    track(EVENTS.SMS_SEND_SUCCESS, { channel: 'email' });
    setCodeSent(true);
    setCooldownSec(60);
  } catch (e) {
    const a = e as AuthError;
    let msg = a.message;
    if (a.status === 400 && a.reason === 'disposable_blocked') msg = '请使用真实邮箱（不支持临时邮箱）';
    else if (a.status === 400 && a.reason === 'mx_failed') msg = '邮箱地址无效';
    else if (a.status === 429 && a.reason === 'email_60s_limit') msg = '请稍候再试（60 秒内只能发 1 次）';
    else if (a.status === 429 && a.reason === 'email_5min_limit') msg = '请稍候再试';
    else if (a.status === 429 && a.reason === 'email_24h_limit') msg = '今日发送次数过多，请明天再试';
    else if (a.status === 429 && a.reason === 'email_locked_30min') msg = '账户已临时锁定，请 30 分钟后再试';
    else if (a.status === 503) msg = '服务暂不可用，请稍后再试';
    else if (a.status === 502) msg = '邮件服务暂时不可用，请稍后重试';
    else if (a.status === 403) msg = '人机验证失败，请重试';
    setPhoneError(msg);
    if (turnstileWidgetId && window.turnstile) {
      window.turnstile.reset(turnstileWidgetId);
      setTurnstileToken(null);
    }
  } finally {
    setLoading(false);
  }
}
```

替换 `handleLogin` 中 login 调用：

```typescript
async function handleLogin() {
  setCodeError('');
  if (!/^\d{6}$/.test(code)) {
    setCodeError('验证码必须是 6 位数字');
    return;
  }
  setLoading(true);
  track(EVENTS.CODE_VERIFY_ATTEMPT, { channel: 'email' });
  try {
    const data = await authApi.login(email.trim().toLowerCase(), code);
    track(EVENTS.LOGIN_SUCCESS, { is_new_user: data.user.is_new, login_method: 'email-code' });
    toast.success(data.user.is_new ? '注册成功' : '登录成功');
    await onLoginSuccess(data.user);
  } catch (e) {
    const a = e as AuthError;
    let msg = a.message;
    if (a.status === 401 && /code expired/i.test(msg)) msg = '验证码已过期，请重新获取';
    else if (a.status === 401 && /no pending code/i.test(msg)) msg = '请先点「获取验证码」';
    else if (a.status === 401 && a.attemptsRemaining !== undefined) {
      msg = `验证码错误，还可尝试 ${a.attemptsRemaining} 次`;
    } else if (a.status === 429) msg = '尝试次数过多，账户已临时锁定 30 分钟';
    setCodeError(msg);
  } finally {
    setLoading(false);
  }
}
```

替换 JSX 中输入框（约第 222-247 行）：

```tsx
        {/* 邮箱 + 获取验证码 */}
        <label className="mb-1 block text-sm text-neutral-700">邮箱</label>
        <div className="flex gap-2">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value.slice(0, 254))}
            placeholder="请输入邮箱"
            disabled={codeSent && cooldownSec > 0}
            className="flex-1 rounded-md border border-neutral-300 px-3 py-2 text-base placeholder:text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none disabled:bg-neutral-50 disabled:text-neutral-500"
            autoFocus
            autoComplete="email"
          />
          <button
            type="button"
            onClick={handleSendCode}
            disabled={sendDisabled}
            className="shrink-0 rounded-md border border-neutral-300 px-3 py-2 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {cooldownSec > 0
              ? `${cooldownSec}s`
              : loading && !codeSent
              ? '发送中…'
              : codeSent
              ? '重发'
              : '获取验证码'}
          </button>
        </div>
```

把组件内 `useState('')` 的 `phone` 改名为 `email`：

```typescript
const [email, setEmail] = useState('');
```

把 `sendDisabled` 中 `!phone` 改 `!email`：

```typescript
const sendDisabled = loading || !email || !turnstileToken || cooldownSec > 0;
```

把 reset state 那一段（约第 71-82 行）`setPhone('')` 改 `setEmail('')`。

- [ ] **Step 2: typecheck**

Run: `cd dashboard && npx tsc --noEmit`
Expected: 0 errors。

- [ ] **Step 3: dev server smoke**

Run: `cd dashboard && npm run dev`
Expected: 起在 `http://localhost:5173`。

打开浏览器访问 → 触发登录弹窗（点 dashboard 右上角"登录"按钮 / 触发 RequireAuth 拦截）。
检查项：
- 输入框显示「请输入邮箱」
- 输入正常邮箱（如 `test@gmail.com`）→ Turnstile 完成 → 点「获取验证码」
- worker 端（dev proxy 默认连 staging worker，需要 staging worker 也部署完）/ 或者用 `VITE_API_PROXY=http://localhost:8787` 连本地 worker

如果连本地 worker（推荐 dev 调试），dev server 启动加 env：
```bash
cd dashboard && VITE_API_PROXY=http://localhost:8787 npm run dev
```

- [ ] **Step 4: Commit**

```bash
git add dashboard/src/components/LoginModal.tsx
git commit -m "feat(auth): LoginModal email 模式 + 错误文案 i18n"
```

---

### Task E3: VITE_AUTH_CHANNEL feature flag

**Files:**
- Create: `dashboard/.env.example`（如果还没有）
- Modify: `dashboard/.env.example`（追加 VITE_AUTH_CHANNEL）

- [ ] **Step 1: 检查 dashboard/.env.example 是否存在**

Run: `ls dashboard/.env*`

- [ ] **Step 2: 加 VITE_AUTH_CHANNEL 默认值**

往 `dashboard/.env.example` 末尾追加（如不存在则创建）：

```env
# 登录通道选择（备案前 email-only，备案后切 sms+email）
VITE_AUTH_CHANNEL=email
```

注：当前阶段所有 channel 选择硬编码为 email（LoginModal 已按 Task E2 改造），flag 仅作为未来切换的占位。LoginModal 暂不读 flag，等备案后 PR 改 UI 时再读。

- [ ] **Step 3: Commit**

```bash
git add dashboard/.env.example
git commit -m "feat(auth): VITE_AUTH_CHANNEL feature flag 占位（备案后切 sms+email）"
```

---

### Task E4: dashboard build 完整通过 + 视觉规范对照

**Files:** 无新文件，仅验证。

- [ ] **Step 1: build**

Run: `cd dashboard && npm run build`
Expected: 0 errors，0 warnings（除非已有 warnings）。

- [ ] **Step 2: 对照 docs/frontend-ux-guidelines.md 检查 LoginModal 视觉**

打开 `docs/frontend-ux-guidelines.md`，检查：
- 颜色 token：`text-neutral-900` / `text-rose-600` / `border-neutral-300` 都在规范范围
- 字号：`text-base` (16px) / `text-sm` / `text-xs` 都在规范范围
- 间距：`gap-2` / `mt-3` / `mb-4` 都在规范范围
- 错误文案位置：紧挨输入框下方 `mt-1 text-xs text-rose-600`
- 模态结构：`fixed inset-0 z-50 ... bg-black/40 ... rounded-xl bg-white p-6 shadow-xl`

如有偏离，修正后重新 build → typecheck。

- [ ] **Step 3: 通过后无 commit**

本 task 是验证 task，无代码改动。

---

## Phase F: 文档同步

### Task F1: operations.md 加 Resend 服务节 + email auth 防刷阈值

**Files:**
- Modify: `docs/operations.md`

- [ ] **Step 1: 在 operations.md 的「Secrets / 凭据」节附近追加 Resend 服务节**

在 `docs/operations.md` 中找到 SMS 服务相关节（搜「腾讯云 SMS」），紧接其后追加：

```markdown
### Resend Email 服务（2026-05-06 上线）

**用途**：登录验证码发送，备案前 email 是主登录路径（绕过 ICP 备案）。

**API key**：通过 `wrangler secret put` 配置，名 `RESEND_API_KEY`，prod + staging 各一份。
- 旋转：Resend Dashboard → API Keys → Revoke 旧 key → Create new → `npx wrangler secret put RESEND_API_KEY`（staging 加 `--env staging`）
- 永远不要写到 git tracked 文件

**免费档限额**：100 封/天 + 3000 封/月（双重限制）

**告警阈值（PushDeer，已配置）**：
| 阈值 | 级别 | 触发动作 |
|---|---|---|
| 当日 ≥ 80 / 95 | warn / urgent | 「今日 email 已发 N/100」 |
| 当日 ≥ 100 | critical | 服务返 503 + 告警 |
| 当月 ≥ 2400 / 2850 | warn / urgent | 「本月 email 已发 N/3000」 |
| 当月 ≥ 3000 | critical | 服务返 503 + 告警 |

**发件域**：`mail.ai-feeds.com`（子域，独立 reputation）

**DNS 记录（CF DNS 已配 4 条 TXT/MX）**：
- `mail.ai-feeds.com` TXT — SPF
- `resend._domainkey.mail.ai-feeds.com` TXT — DKIM
- `_dmarc.mail.ai-feeds.com` TXT — DMARC
- `feedback.mail.ai-feeds.com` MX — return-path

**email auth 多维度防刷阈值**（与 SMS 同结构）：
- email 60s/5min/24h：1 / 3 / 10 次
- IP 1h unique emails / 24h total：10 / 30
- device 24h unique emails：5
- 验证码错 5 次 → 锁 30min
- 严重命中 (24h / locked / ip_24h_total) → PushDeer 告警

**email 特有两层补充**：
- 一次性邮箱黑名单：npm `disposable-email-domains` 包（约 3000 域名），打包进 worker bundle
- MX 预校验：CF DoH 查询，KV 缓存 24h，无 MX → reject

**Feature flag**：
- `ENABLE_SMS_LOGIN` (worker env)：备案前 = `false`（关闭 SMS 通道）
- `ENABLE_EMAIL_LOGIN` (worker env)：默认 `true`，紧急关闭设 `false`
- `VITE_AUTH_CHANNEL` (dashboard env)：备案前 = `email`，备案后改 `sms+email` → 触发新 LoginModal UI（届时另起 PR）
```

- [ ] **Step 2: 更新 operations.md 顶部「最后更新」日期**

把现有「最后更新：2026-05-06（CF Workers Paid 升级到 $5/月...）」前面再加一行：

```markdown
最后更新：2026-05-06（email 验证码登录上线：Resend HTTPS API + disposable + MX 预校验 + 100/天 cap，备案前主登录路径，详见 [Resend 服务节](#resend-email-服务2026-05-06-上线)）

历史：2026-05-06（CF Workers Paid 升级到 $5/月：subrequest 50→1000、CPU 10ms→30s...）
```

- [ ] **Step 3: Commit**

```bash
git add docs/operations.md
git commit -m "docs(ops): Resend email 服务节 + email auth 防刷阈值"
```

---

## Phase G: 生产部署（依赖外部资源）

### Task G1: 用户旋转 Resend key + 添加 domain

**This is a USER action.** Claude 提示用户操作 + 等用户确认完成。

- [ ] **Step 1: 用户登 Resend Dashboard**

提示用户：
1. 打开 https://resend.com → API Keys
2. **Revoke** 旧 key（`re_CWpHnWcC_*` 已暴露在对话历史）
3. **Create new** → 命名 `xlist-prod` → 拷贝新 key 到密码管理器
4. （staging 可共用同一 key 或单独建 `xlist-staging`）

- [ ] **Step 2: 用户添加 domain**

提示用户：
1. Resend Dashboard → Domains → Add Domain
2. Domain 填 `mail.ai-feeds.com`（子域）
3. Region 选 `us-east-1`（默认）
4. 拷贝出来的 4 条 DNS 记录（SPF / DKIM / DMARC / return-path MX），等下 G2 用

**等待用户确认完成两步，再继续 G2。**

---

### Task G2: CF DNS 配 4 条记录 + Resend 后台 verify

**This is a USER + Claude collaborative action.**

- [ ] **Step 1: 用户在 CF Dashboard 配 DNS**

提示用户：
1. CF Dashboard → ai-feeds.com → DNS → Records
2. 按 Resend 后台给的 4 条记录（来自 G1 Step 2）逐条添加：
   - 3 条 TXT 记录（SPF / DKIM / DMARC）
   - 1 条 MX 记录（return-path）
3. Proxy status 全部设 **DNS only**（灰云，不是橙云）
4. TTL 用 Auto

- [ ] **Step 2: 等 DNS 生效**

CF DNS 一般 < 5min 全球生效。可以用：
```bash
dig +short MX mail.ai-feeds.com
dig +short TXT _dmarc.mail.ai-feeds.com
```
确认查到对应记录。

- [ ] **Step 3: 用户在 Resend 后台点 Verify**

提示用户：Resend Dashboard → Domains → mail.ai-feeds.com → Verify。状态变为 ✅ Verified。

**等用户确认 verified，再继续 G3。**

---

### Task G3: D1 migration staging + secret put + worker deploy + smoke

**This is a Claude action（部分操作要 user 配合）.**

- [ ] **Step 1: D1 migration 跑 staging 远端**

Run:
```bash
cd worker && npx wrangler d1 execute xlist-staging --env staging --remote --file=migrations/010-email-send-log.sql
```
Expected: 「✅ ... 1 commands executed」。

确认表存在：
```bash
npx wrangler d1 execute xlist-staging --env staging --remote --command "SELECT name FROM sqlite_master WHERE type='table' AND name='email_send_log'"
```
Expected: 返回 1 行。

- [ ] **Step 2: 用户跑 wrangler secret put（staging）**

Claude 提示 user 跑：
```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/worker
npx wrangler secret put RESEND_API_KEY --env staging
# 提示输入 → 粘贴 G1 拿到的 staging key
```
**等用户确认 secret 已设置。**

- [ ] **Step 3: 部署 staging worker**

Run:
```bash
cd worker && npx wrangler deploy --env staging
```
Expected: 「Published xlist-api-staging ... https://staging-api.ai-feeds.com」。

- [ ] **Step 4: staging worker e2e smoke**

```bash
STAGE=https://staging-api.ai-feeds.com

# 用真实邮箱（用户自己的）测一遍
curl -i -X POST $STAGE/api/auth/email/send \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: roxortest123456" \
  -d '{"email":"<your-real-email@gmail.com>","turnstile_token":"<dev mode skip OK>"}'
# 期望：200 ok，邮箱秒级收到验证码邮件
```

确认邮件收到（看主题「你的登录验证码：xxxxxx」+ 来自 `noreply@mail.ai-feeds.com`），点验证码完成 login：

```bash
curl -i -X POST $STAGE/api/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: roxortest123456" \
  -d '{"identifier":"<your-real-email@gmail.com>","code":"<6位code>"}'
# 期望：200 + Set-Cookie，is_new=true
```

- [ ] **Step 5: 部署 staging dashboard**

Run:
```bash
cd dashboard && npm run build && npx wrangler pages deploy dist --project-name=xlist-dashboard --branch=staging
```
Expected: deploy 完成，访问 `https://staging.ai-feeds.com` 触发登录弹窗 → 用真实邮箱 e2e 跑通。

**确认 staging 全链路 OK 再 G4。**

---

### Task G4: D1 migration prod + secret put + worker + dashboard deploy prod

**This is a Claude action（部分操作要 user 配合）.**

- [ ] **Step 1: prod D1 备份**

Run:
```bash
cd worker && npx wrangler d1 export xlist --remote --output=/tmp/xlist-prod-pre-email-auth-$(date +%Y%m%d-%H%M%S).sql
```
Expected: 备份文件落到 /tmp。

- [ ] **Step 2: D1 migration 跑 prod 远端**

Run:
```bash
cd worker && npx wrangler d1 execute xlist --remote --file=migrations/010-email-send-log.sql
```
Expected: 「✅ ... 1 commands executed」。

- [ ] **Step 3: 用户跑 wrangler secret put（prod）**

Claude 提示 user 跑：
```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/worker
npx wrangler secret put RESEND_API_KEY
# 提示输入 → 粘贴 G1 拿到的 prod key（可与 staging 同 key 或独立）
```
**等用户确认 secret 已设置。**

- [ ] **Step 4: 部署 prod worker**

Run:
```bash
cd worker && npx wrangler deploy
```
Expected: 「Published xlist-api ... https://api.ai-feeds.com」。

- [ ] **Step 5: 部署 prod dashboard**

Run:
```bash
cd dashboard && npm run build && npx wrangler pages deploy dist --project-name=xlist-dashboard
```
Expected: deploy 完成。

---

### Task G5: prod e2e 验证（多邮箱）

**This is a USER action**（Claude 引导 + 监控 D1 / PushDeer）。

- [ ] **Step 1: 用户在 https://ai-feeds.com 登录**

提示用户：
1. 打开 https://ai-feeds.com（或退出登录）
2. 触发 RequireAuth 弹窗
3. 用 Gmail 邮箱试一遍 → 收到验证码 → 输入 → 登录成功
4. 退出 → 用 QQ 邮箱试一遍
5. 退出 → 用 163 邮箱试一遍
6. 退出 → 用 Outlook 邮箱试一遍
7. 验证「请使用真实邮箱」（输 `mailinator.com` 邮箱）和「邮箱地址无效」（输 `asdf@asdfasdfdne.tld`）

- [ ] **Step 2: Claude 监控**

并行查 D1：
```bash
cd worker && npx wrangler d1 execute xlist --remote --command \
  "SELECT email, result, datetime(sent_at/1000,'unixepoch','+8 hours') AS bjt FROM email_send_log ORDER BY sent_at DESC LIMIT 20"
```
确认每个测试邮箱都有 success 行；disposable / mx_failed 也分别有对应行。

- [ ] **Step 3: 监控 Resend Dashboard**

打开 Resend Dashboard → 看到投递成功率（应该 100%），无 bounce / complaint。

- [ ] **Step 4: 上线公告**

PR merge 到 main：
```bash
git checkout main && git merge --no-ff feat/email-auth -m "Merge feat/email-auth: email 验证码登录上线（绕过备案的主路径）"
```

Push 之前：**确认所有外部资源（Resend / DNS / wrangler secrets）都已就绪 + prod e2e 全部通过**。

---

## 完成验收清单

- [ ] D1 `email_send_log` 表存在（staging + prod）
- [ ] worker `/api/auth/email/send` endpoint 200 通
- [ ] worker `/api/auth/login` 接受 `identifier` 字段且能处理 phone + email 两种输入
- [ ] disposable email 域名被拒（mailinator.com 等）
- [ ] 假邮箱（无 MX）被拒
- [ ] 60s / 5min / 24h 限流在不同维度都生效
- [ ] 错码 5 次锁 30min 生效
- [ ] daily / monthly cap 80% / 95% 告警 PushDeer 推送（可临时调 cap=test 阈值验证）
- [ ] Gmail / QQ / 163 / Outlook 邮箱都能收到验证码 < 30s
- [ ] LoginModal 输入框文案「邮箱」+ 校验 + 错误文案 i18n 全部对
- [ ] dashboard 构建无 error / warn
- [ ] operations.md Resend 服务节已添加
- [ ] feat/email-auth 分支已 merge 到 main
- [ ] PR2/PR3 SMS 代码完整保留 + ENABLE_SMS_LOGIN=false flag 隐藏

---

## 后续清理（不在本 PR）

下次清理 PR（备案完成后翻 SMS flag 时）：
- handlers.ts `LoginBody.phone` fallback 字段下线
- handlers.ts `DeleteBody.phone_confirm` fallback 字段下线
- User type `phone_masked` 字段下线
- LoginModal 改双 channel UI（手机号 / 邮箱 tab）
