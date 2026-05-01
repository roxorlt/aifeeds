# PR2 实施计划：用户表 + SMS 登录核心（auth backend）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Worker 端实现完整 auth 后端 — 用户表 / identities / sessions / sms_send_log 4 张表，5 个 endpoint（sms/send + login + logout + logout-all + me），4 层 SMS 防刷，PushDeer 告警，Turnstile 校验。前端 UI 在 PR3 做。

**Architecture:**
- 沿用 worker/src/index.ts 单文件路由模式（不引入框架），新增 `worker/src/auth/` 子目录拆 5 个职责文件
- D1 4 张新表通过 migration 落地（编号 006/007 接 PR1 的 005）
- KV namespace 一个新建，专门存每日 SMS 发送量计数器（hard cap = 200）
- 腾讯云 SMS V3 API（TC3-HMAC-SHA256 签名，2021-01-11 版本），Turnstile siteverify，PushDeer message/push — 全部用 Worker 原生 fetch + crypto.subtle，无 SDK 依赖

**Tech Stack:**
- Worker：TypeScript + Cloudflare Workers + D1 + KV + wrangler
- Aliyun SMS：dysmsapi V2 endpoint，自实现 HMAC-SHA1 签名
- Turnstile：CF managed 模式（PR3 集成 widget，本 PR 仅做 server-side verify）
- 已有：nanoid（PR1 引入），无需加新 npm 包

**Branch:** `feat/auth-backend`（已从 main `fa9f08c` 出，含 PR1 telemetry 完整实现）

**Worktree:** `/Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend`

**关联设计文档:** `/Users/roxor/brain/30-projects/xlist-scraper/docs/plans/2026-05-01-auth-system-design.md`

**测试策略**：与 PR1 一致，遵循 CLAUDE.md「验证分层」— wrangler dev + curl 矩阵，**不引入 vitest**。

---

## ⚠️ 外部依赖（用户操作）

PR2 的代码可以全写完，但 deploy 到生产需要这些**用户必须先做**的操作。Phase F（部署）会依赖这些就绪。

| 依赖 | 用户要做的事 | 阻塞哪个 phase |
|------|-----------|--------------|
| 腾讯云个人主体 SMS 服务 | 个人实名注册腾讯云 → 短信 → 应用管理创建应用拿 SmsSdkAppId（1400 开头 7 位）→ 申请签名（个人需要纸质资料 + 公章邮寄）→ 申请正文模板（一般 1-2 天）→ 控制台设额度上限 | F2 / F3 |
| CF Turnstile widget | CF Dashboard → Turnstile → **Add widget**（旧文案叫 "Create site"，本质相同）→ managed mode → 拿 site key + secret | F2 |
| CF KV namespace | `npx wrangler kv namespace create AUTH_KV`（命令本身在 A3 task 里跑） | A3 完成后写入 wrangler.toml |
| PushDeer admin keys | 已有（xueqiuFollow 项目里两个 admin key：iPhone + Mac） | F2 |

代码可以用 dummy secret 跑 wrangler dev 验证 typecheck + 路由通；真发短信 / 真校验 Turnstile 必须 secret 上线。

---

## File Structure

### 新建文件

**Worker 端**
- `worker/migrations/006-users-identities-sessions.sql` — users + identities + sessions 三张表
- `worker/migrations/007-sms-send-log.sql` — sms_send_log 表
- `worker/src/auth/types.ts` — 共享 TS 类型
- `worker/src/auth/turnstile.ts` — Turnstile siteverify
- `worker/src/auth/sms.ts` — 腾讯云 SMS V3 调用 + 三维度限流计数 + 每日 cap
- `worker/src/auth/session.ts` — session 创建/校验/撤销 + cookie 工具
- `worker/src/auth/handlers.ts` — 5 个 endpoint handler
- `worker/src/notifier.ts` — PushDeer 告警

### 修改文件

- `worker/src/index.ts` — Env 接口扩展 + 5 条新路由 + auth middleware
- `worker/schema.sql` — 追加 4 张新表定义
- `worker/wrangler.toml` — 加 KV namespace 绑定
- `docs/operations.md` — 加 endpoints / 表 / secrets / 防刷阈值清单

---

## 阶段总览

| Phase | 内容 | Tasks |
|-------|------|-------|
| A | Schema + 基础设施 | A1-A4 |
| B | 子模块（utility） | B1-B5 |
| C | Endpoint handlers | C1-C5 |
| D | 路由接入 + 端到端 curl 验证 | D1-D2 |
| E | 文档同步 | E1 |
| F | 生产部署（依赖外部资源就绪） | F1-F4 |

总 21 task。每 task 一个原子 commit。

---

## Phase A: Schema + 基础设施

### Task A1: users / identities / sessions 三张表

**Files:**
- Create: `worker/migrations/006-users-identities-sessions.sql`
- Modify: `worker/schema.sql`（追加表定义）

- [ ] **Step 1: 写迁移文件 `worker/migrations/006-users-identities-sessions.sql`**

```sql
-- PR2: 用户身份三张核心表
-- 设计参考：docs/plans/2026-05-01-auth-system-design.md § 3.1-3.3

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  avatar_url TEXT,
  created_at INTEGER NOT NULL,
  last_active_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  banned_reason TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at DESC);

CREATE TABLE IF NOT EXISTS identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  identity_value TEXT NOT NULL,
  verified_at INTEGER NOT NULL,
  unbound_at INTEGER,
  metadata TEXT,
  UNIQUE(provider, identity_value, unbound_at)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);
CREATE INDEX IF NOT EXISTS idx_identities_provider_value ON identities(provider, identity_value);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  device_id TEXT,
  ip TEXT,
  ua TEXT,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_user_active ON sessions(user_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
```

- [ ] **Step 2: 把同样定义追加到 `worker/schema.sql` 末尾**

复制 Step 1 的所有 SQL（含注释行），追加到 `worker/schema.sql` 文件末尾。

- [ ] **Step 3: 本地应用迁移**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx wrangler d1 execute xlist --file=migrations/006-users-identities-sessions.sql --local
```

期望：`✓ Done` 无报错。

- [ ] **Step 4: 验证表 + 索引**

```bash
npx wrangler d1 execute xlist --command="SELECT name FROM sqlite_master WHERE type IN ('table','index') AND (name LIKE 'users%' OR name LIKE 'identities%' OR name LIKE 'sessions%' OR name LIKE 'idx_users_%' OR name LIKE 'idx_identities_%' OR name LIKE 'idx_sessions_%') ORDER BY name;" --local
```

期望：3 张表 + 6 个索引（共 9 行）。

- [ ] **Step 5: Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/migrations/006-users-identities-sessions.sql worker/schema.sql
git commit -m "$(cat <<'EOF'
feat(worker): users / identities / sessions 三表 schema (PR2)

PR2 auth 后端的核心身份模型：
- users：永久主键 + status active/banned/self_deleted
- identities：phone/wechat 等登录凭证多对一关联 user
- sessions：cookie/bearer 双兼容 token，30 天滑动过期

详见 docs/plans/2026-05-01-auth-system-design.md § 3.1-3.3

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2: sms_send_log 表

**Files:**
- Create: `worker/migrations/007-sms-send-log.sql`
- Modify: `worker/schema.sql`（追加 sms_send_log 表）

- [ ] **Step 1: 写迁移文件 `worker/migrations/007-sms-send-log.sql`**

```sql
-- PR2: sms_send_log 表 — 短信发送日志 + 防刷计数 + 验证码 hash
-- 设计参考：docs/plans/2026-05-01-auth-system-design.md § 3.4

CREATE TABLE IF NOT EXISTS sms_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  ip TEXT NOT NULL,
  device_id TEXT,
  ua TEXT,
  sent_at INTEGER NOT NULL,
  result TEXT NOT NULL,
  code_hash TEXT,
  code_expires_at INTEGER,
  code_used_at INTEGER,
  code_attempts INTEGER DEFAULT 0,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS idx_sms_phone_time ON sms_send_log(phone, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_ip_time ON sms_send_log(ip, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_device_time ON sms_send_log(device_id, sent_at DESC);
CREATE INDEX IF NOT EXISTS idx_sms_sent_at ON sms_send_log(sent_at DESC);
```

- [ ] **Step 2: 追加到 `worker/schema.sql`**

复制 Step 1 的 SQL，追加到 `worker/schema.sql` 末尾。

- [ ] **Step 3: 本地应用**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx wrangler d1 execute xlist --file=migrations/007-sms-send-log.sql --local
npx wrangler d1 execute xlist --command="SELECT name FROM sqlite_master WHERE name LIKE 'sms_%' OR name LIKE 'idx_sms_%' ORDER BY name;" --local
```

期望：1 张表 + 4 个索引（共 5 行）。

- [ ] **Step 4: Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/migrations/007-sms-send-log.sql worker/schema.sql
git commit -m "$(cat <<'EOF'
feat(worker): sms_send_log 表 schema (PR2)

防刷计数 + 验证码 hash + 审计日志的统一表。
- code_hash: SHA256(code) 防 D1 泄漏看到明文
- code_attempts: 错码次数，>= 5 触发 30min 锁定
- result 枚举：success / rate_limited / turnstile_failed / sms_api_error / budget_capped
- 4 个索引覆盖 phone/ip/device 限流维度查询

详见 docs/plans/2026-05-01-auth-system-design.md § 3.4 + § 7

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A3: 创建 KV namespace + wrangler.toml 绑定

**Files:**
- Modify: `worker/wrangler.toml`

- [ ] **Step 1: 创建远端 KV namespace**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx wrangler kv namespace create AUTH_KV
```

期望输出：包含一行类似：

```
🌀 Creating namespace with title "xlist-api-AUTH_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
[[kv_namespaces]]
binding = "AUTH_KV"
id = "<some-uuid>"
```

记下 `id` 字段值。

- [ ] **Step 2: 创建本地 dev preview namespace（可选但推荐）**

```bash
npx wrangler kv namespace create AUTH_KV --preview
```

记下 `preview_id`。

- [ ] **Step 3: 修改 `worker/wrangler.toml`**

在现有 `[[d1_databases]]` 块之后追加：

```toml

[[kv_namespaces]]
binding = "AUTH_KV"
id = "<step1 输出的 id>"
preview_id = "<step2 输出的 preview_id>"
```

把尖括号占位换成实际 UUID。

- [ ] **Step 4: 验证配置**

```bash
npx wrangler dev --local --port 8788 &
sleep 3
kill %1 2>/dev/null
```

期望 `Your Worker has access to the following bindings` 输出包含 `env.AUTH_KV (...) KV Namespace`。

- [ ] **Step 5: Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/wrangler.toml
git commit -m "$(cat <<'EOF'
feat(worker): 加 AUTH_KV namespace 绑定

PR2 SMS 防刷的每日 hard cap (200 条/天) 计数器存在 KV 里。
key 格式 sms_count_YYYYMMDD，TTL 36h 自动过期。

KV 比 D1 快 + 没原子 INCR 但对 200 cap 可接受（极端并发可能漏 1-2 条记录，不影响阈值判断）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A4: Env 接口扩展

**Files:**
- Modify: `worker/src/index.ts`（Env interface）

- [ ] **Step 1: 修改 `worker/src/index.ts` Env interface**

找到现有的 `export interface Env { ... }` 定义（约 line 14），改为：

```typescript
export interface Env {
  DB: D1Database;
  AUTH_KV: KVNamespace;
  INGEST_TOKEN: string;
  DEEPSEEK_API_KEY?: string;
  // M4: refresh-metrics mode dispatch.
  //   'tiered'  → runRefreshTiered (uses tier/next_refresh_at/last_velocity)
  //   'legacy'  → runRefreshMetrics (round-robin, default — preserves pre-M4 behavior)
  //   'off'     → skip refresh entirely
  REFRESH_MODE?: string;
  REFRESH_TIER_MAX?: string;
  // PR2 auth secrets (上线前用 wrangler secret put 设置)
  TURNSTILE_SECRET_KEY?: string;
  TENCENT_SMS_SECRET_ID?: string;       // 腾讯云 API SecretId（类似 AccessKeyId）
  TENCENT_SMS_SECRET_KEY?: string;      // 腾讯云 API SecretKey
  TENCENT_SMS_SDK_APP_ID?: string;      // 短信应用 ID（控制台分配，1400 开头 7 位）
  TENCENT_SMS_SIGN_NAME?: string;       // 已审签名，例：xList
  TENCENT_SMS_TEMPLATE_ID?: string;     // 已审模板 ID，例：1234567
  TENCENT_SMS_REGION?: string;          // 默认 ap-guangzhou
  PUSHDEER_ADMIN_KEYS?: string;         // 逗号分隔多个 key
  // PR2 配置
  SMS_DAILY_CAP?: string;               // 默认 200，可临时降到 0 = kill switch
}
```

- [ ] **Step 2: typecheck**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit
```

期望：无 error。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): Env interface 扩展 PR2 auth 必需的 binding 和 secret

新增：
- AUTH_KV: KVNamespace (每日 SMS cap 计数器)
- TURNSTILE_SECRET_KEY: Turnstile siteverify
- TENCENT_SMS_*: 腾讯云 SMS API V3（5 个 secret + 1 region 可选）
- PUSHDEER_ADMIN_KEYS: 风控告警（逗号分隔多 key）
- SMS_DAILY_CAP: 默认 200，可作 kill switch

所有 secret 字段标 optional，dev 环境无 secret 时 typecheck 不破，
真发短信时 dev 模式 simulate（具体 fail 路径在 sms.ts 处理）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B: 子模块

### Task B1: auth/types.ts — 共享类型

**Files:**
- Create: `worker/src/auth/types.ts`

- [ ] **Step 1: 创建 `worker/src/auth/types.ts`**

```typescript
// PR2 auth 共享类型
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 3 + § 9

export interface UserRow {
  id: string;
  display_name: string | null;
  avatar_url: string | null;
  created_at: number;
  last_active_at: number;
  status: 'active' | 'banned' | 'self_deleted';
  banned_reason: string | null;
  metadata: string | null;
}

export interface IdentityRow {
  id: number;
  user_id: string;
  provider: 'phone' | 'wechat' | 'email';
  identity_value: string;
  verified_at: number;
  unbound_at: number | null;
  metadata: string | null;
}

export interface SessionRow {
  id: string;
  user_id: string;
  device_id: string | null;
  ip: string | null;
  ua: string | null;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export interface SmsLogRow {
  id: number;
  phone: string;
  ip: string;
  device_id: string | null;
  ua: string | null;
  sent_at: number;
  result: 'success' | 'rate_limited' | 'turnstile_failed' | 'sms_api_error' | 'budget_capped';
  code_hash: string | null;
  code_expires_at: number | null;
  code_used_at: number | null;
  code_attempts: number;
  metadata: string | null;
}

/** 鉴权中间件返回的 context */
export type AuthContext =
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; userId: string; sessionId: string };

/** 限流检查结果 */
export interface RateLimitResult {
  ok: boolean;
  reason?:
    | 'phone_60s_limit'
    | 'phone_5min_limit'
    | 'phone_24h_limit'
    | 'ip_1h_unique_phones_limit'
    | 'ip_24h_total_limit'
    | 'device_24h_unique_phones_limit'
    | 'phone_locked_30min';
}
```

- [ ] **Step 2: typecheck + Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit

cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/auth/types.ts
git commit -m "feat(worker): auth/types.ts — 共享 TS 类型

UserRow / IdentityRow / SessionRow / SmsLogRow 与 D1 列对齐。
AuthContext 鉴权中间件返回。RateLimitResult 限流原因 enum。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: notifier.ts — PushDeer 告警

**Files:**
- Create: `worker/src/notifier.ts`

- [ ] **Step 1: 创建 `worker/src/notifier.ts`**

```typescript
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
```

- [ ] **Step 2: typecheck + Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit

cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/notifier.ts
git commit -m "$(cat <<'EOF'
feat(worker): notifier.ts — PushDeer 告警 (PR2)

PUSHDEER_ADMIN_KEYS env (逗号分隔 key 列表) 并发推到所有 admin。
fail 仅 log，不抛 — 告警发不出不能阻塞主流程。
secret 缺时 console.warn 不抛。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B3: auth/turnstile.ts — siteverify 校验

**Files:**
- Create: `worker/src/auth/turnstile.ts`

- [ ] **Step 1: 创建 `worker/src/auth/turnstile.ts`**

```typescript
// PR2 Turnstile 校验
// CF 自家 captcha 服务，token 来自前端 widget，server 端 siteverify 拿 success
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 7.2

import type { Env } from '../index';

const SITEVERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface SiteverifyResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  'error-codes'?: string[];
  action?: string;
  cdata?: string;
}

/**
 * 校验前端传来的 Turnstile token。
 * 失败原因不暴露给客户端（避免给攻击者 hint），仅 console.warn。
 *
 * dev 环境 secret 缺失时返回 true（不挡 dev），生产环境 deploy 前必须 secret put。
 */
export async function verifyTurnstile(
  env: Env,
  token: string | null,
  remoteIp: string,
): Promise<boolean> {
  if (!env.TURNSTILE_SECRET_KEY) {
    console.warn('[turnstile] TURNSTILE_SECRET_KEY not set, bypass (dev only)');
    return true;
  }

  if (!token) return false;

  try {
    const r = await fetch(SITEVERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteIp,
      }),
    });
    if (!r.ok) {
      console.warn(`[turnstile] siteverify ${r.status}`);
      return false;
    }
    const data = (await r.json()) as SiteverifyResponse;
    if (!data.success) {
      console.warn('[turnstile] verify failed', data['error-codes']);
    }
    return data.success === true;
  } catch (e) {
    console.error('[turnstile] exception', e);
    return false;
  }
}
```

- [ ] **Step 2: typecheck + Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit

cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/auth/turnstile.ts
git commit -m "$(cat <<'EOF'
feat(worker): auth/turnstile.ts — siteverify 校验 (PR2)

POST 到 challenges.cloudflare.com/turnstile/v0/siteverify，
检查 success === true。失败原因不暴露给客户端（防 hint 攻击者），
仅 console.warn。

dev 环境 TURNSTILE_SECRET_KEY 缺失时直接 bypass return true，
生产 deploy 前必须 wrangler secret put。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B4: auth/sms.ts — 腾讯云 SMS API + 三维度限流 + 每日 cap

**Files:**
- Create: `worker/src/auth/sms.ts`

最复杂的子模块。包含：
1. 腾讯云 SMS V3 API 签名（TC3-HMAC-SHA256）和发送
2. 三维度限流（phone / ip / device）
3. 每日 cap（KV 计数器）
4. 30min 验证码失败锁定
5. 验证码生成 + hash

- [ ] **Step 1: 创建 `worker/src/auth/sms.ts`**

```typescript
// PR2 腾讯云 SMS V3 API + 多层防刷
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 7
// 腾讯云 V3 签名：https://cloud.tencent.com/document/api/382/52071

import type { Env } from '../index';
import type { RateLimitResult } from './types';
import { pushDeerAlert } from '../notifier';

const SMS_HOST = 'sms.tencentcloudapi.com';
const SMS_SERVICE = 'sms';
const SMS_ACTION = 'SendSms';
const SMS_VERSION = '2021-01-11';
const CODE_TTL_MS = 5 * 60 * 1000;       // 验证码 5 分钟
const LOCK_DURATION_MS = 30 * 60 * 1000; // 失败锁 30 分钟
const MAX_ATTEMPTS_BEFORE_LOCK = 5;
const DEFAULT_DAILY_CAP = 200;

// ─── 1. 三维度限流 ─────────────────────────────────────────

export async function checkRateLimits(
  env: Env,
  phone: string,
  ip: string,
  deviceId: string | null,
): Promise<RateLimitResult> {
  const now = Date.now();
  const ago = (ms: number) => now - ms;

  // phone 60s
  const r1 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE phone = ? AND result = 'success' AND sent_at > ?`,
  ).bind(phone, ago(60_000)).first<{ n: number }>();
  if ((r1?.n ?? 0) >= 1) return { ok: false, reason: 'phone_60s_limit' };

  // phone 5min
  const r2 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE phone = ? AND result = 'success' AND sent_at > ?`,
  ).bind(phone, ago(5 * 60_000)).first<{ n: number }>();
  if ((r2?.n ?? 0) >= 3) return { ok: false, reason: 'phone_5min_limit' };

  // phone 24h
  const r3 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE phone = ? AND result = 'success' AND sent_at > ?`,
  ).bind(phone, ago(24 * 3600_000)).first<{ n: number }>();
  if ((r3?.n ?? 0) >= 10) return { ok: false, reason: 'phone_24h_limit' };

  // ip 1h unique phones
  const r4 = await env.DB.prepare(
    `SELECT COUNT(DISTINCT phone) as n FROM sms_send_log WHERE ip = ? AND result = 'success' AND sent_at > ?`,
  ).bind(ip, ago(3600_000)).first<{ n: number }>();
  if ((r4?.n ?? 0) >= 10) return { ok: false, reason: 'ip_1h_unique_phones_limit' };

  // ip 24h total
  const r5 = await env.DB.prepare(
    `SELECT COUNT(*) as n FROM sms_send_log WHERE ip = ? AND result = 'success' AND sent_at > ?`,
  ).bind(ip, ago(24 * 3600_000)).first<{ n: number }>();
  if ((r5?.n ?? 0) >= 30) return { ok: false, reason: 'ip_24h_total_limit' };

  // device 24h unique phones
  if (deviceId) {
    const r6 = await env.DB.prepare(
      `SELECT COUNT(DISTINCT phone) as n FROM sms_send_log WHERE device_id = ? AND result = 'success' AND sent_at > ?`,
    ).bind(deviceId, ago(24 * 3600_000)).first<{ n: number }>();
    if ((r6?.n ?? 0) >= 5) return { ok: false, reason: 'device_24h_unique_phones_limit' };
  }

  // 验证码失败锁：phone 最近一条 success 记录的 attempts >= 5 + sent_at < 30min ago
  const r7 = await env.DB.prepare(
    `SELECT code_attempts, sent_at FROM sms_send_log
     WHERE phone = ? AND result = 'success'
     ORDER BY sent_at DESC LIMIT 1`,
  ).bind(phone).first<{ code_attempts: number; sent_at: number }>();
  if (r7 && r7.code_attempts >= MAX_ATTEMPTS_BEFORE_LOCK && r7.sent_at > ago(LOCK_DURATION_MS)) {
    return { ok: false, reason: 'phone_locked_30min' };
  }

  return { ok: true };
}

// ─── 2. 每日 cap (KV) ────────────────────────────────────────

function todayKey(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `sms_count_${yyyy}${mm}${dd}`;
}

export async function checkAndIncrDailyCap(
  env: Env,
): Promise<{ ok: boolean; sent: number; cap: number }> {
  const cap = parseInt(env.SMS_DAILY_CAP || String(DEFAULT_DAILY_CAP), 10);
  if (cap <= 0) return { ok: false, sent: 0, cap };  // kill switch
  const key = todayKey();
  const cur = await env.AUTH_KV.get(key);
  const sent = cur ? parseInt(cur, 10) : 0;
  if (sent >= cap) return { ok: false, sent, cap };
  // INCR (best-effort，CF KV 没原子 INCR；并发可能漏 1-2 但对 200 cap 影响小)
  await env.AUTH_KV.put(key, String(sent + 1), { expirationTtl: 36 * 3600 });
  return { ok: true, sent: sent + 1, cap };
}

export async function checkDailyCapAlerts(env: Env, sent: number, cap: number): Promise<void> {
  // 80% / 95% 阈值
  const pct = sent / cap;
  if (pct >= 0.95) {
    await pushDeerAlert(env, 'SMS 95% 紧急', `今日发送 ${sent}/${cap}，建议立即检查异常 IP/phone 并临时把 SMS_DAILY_CAP 调到 0 切流`);
  } else if (pct >= 0.80 && (sent === Math.floor(cap * 0.80) || sent === Math.floor(cap * 0.80) + 1)) {
    // 仅在跨过 80% 阈值的瞬间触发一次（避免每条都告警）
    await pushDeerAlert(env, 'SMS 80% 警告', `今日发送 ${sent}/${cap}，请关注 events 表 sms_send_attempt 分布`);
  }
}

// ─── 3. 验证码生成 + hash ────────────────────────────────────

/** 生成 6 位数字验证码 */
export function generateCode(): string {
  const buf = new Uint8Array(4);
  crypto.getRandomValues(buf);
  // 转 32-bit unsigned，模 1000000，padStart 6 位
  const n = ((buf[0] << 24) | (buf[1] << 16) | (buf[2] << 8) | buf[3]) >>> 0;
  return String(n % 1_000_000).padStart(6, '0');
}

/** SHA-256 hex 用于存到 D1 */
export async function hashCode(code: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(`${salt}|${code}`);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ─── 4. 腾讯云 SMS V3 API ──────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return bytesToHex(new Uint8Array(buf));
}

async function hmacSha256(key: ArrayBuffer | string, msg: string): Promise<Uint8Array> {
  const keyBuf = typeof key === 'string' ? new TextEncoder().encode(key) : key;
  const ck = await crypto.subtle.importKey(
    'raw',
    keyBuf,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(msg));
  return new Uint8Array(sig);
}

/**
 * 腾讯云 V3 签名 (TC3-HMAC-SHA256)
 * 文档：https://cloud.tencent.com/document/api/382/52071
 *
 * 关键点：
 * - SignedHeaders 最小集 'content-type;host'，content-type 在签名内必须小写
 * - 实际请求 header 大小写不敏感但官方示例 Content-Type
 * - timestamp 容忍 ±5 分钟
 * - date 部分用 UTC YYYY-MM-DD
 */
async function tc3SignAuthHeader(
  service: string,
  host: string,
  payload: string,
  timestamp: number,
  secretId: string,
  secretKey: string,
): Promise<string> {
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10); // YYYY-MM-DD UTC
  // Step 1: canonical request
  const httpRequestMethod = 'POST';
  const canonicalUri = '/';
  const canonicalQueryString = '';
  const canonicalHeaders =
    `content-type:application/json; charset=utf-8\n` +
    `host:${host}\n`;
  const signedHeaders = 'content-type;host';
  const hashedRequestPayload = await sha256Hex(payload);
  const canonicalRequest =
    `${httpRequestMethod}\n${canonicalUri}\n${canonicalQueryString}\n` +
    `${canonicalHeaders}\n${signedHeaders}\n${hashedRequestPayload}`;

  // Step 2: string to sign
  const algorithm = 'TC3-HMAC-SHA256';
  const credentialScope = `${date}/${service}/tc3_request`;
  const hashedCanonicalRequest = await sha256Hex(canonicalRequest);
  const stringToSign = `${algorithm}\n${timestamp}\n${credentialScope}\n${hashedCanonicalRequest}`;

  // Step 3: derived key chain
  const secretDate = await hmacSha256(`TC3${secretKey}`, date);
  const secretService = await hmacSha256(secretDate.buffer as ArrayBuffer, service);
  const secretSigning = await hmacSha256(secretService.buffer as ArrayBuffer, 'tc3_request');

  // Step 4: signature
  const signatureBytes = await hmacSha256(secretSigning.buffer as ArrayBuffer, stringToSign);
  const signature = bytesToHex(signatureBytes);

  // Step 5: Authorization
  return `${algorithm} Credential=${secretId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}

interface SendSmsResult {
  ok: boolean;
  requestId?: string;
  errCode?: string;
  errMsg?: string;
}

/** 调腾讯云 SMS V3 API 发短信 */
export async function sendSmsViaTencent(
  env: Env,
  phone: string,
  code: string,
): Promise<SendSmsResult> {
  if (
    !env.TENCENT_SMS_SECRET_ID ||
    !env.TENCENT_SMS_SECRET_KEY ||
    !env.TENCENT_SMS_SDK_APP_ID ||
    !env.TENCENT_SMS_SIGN_NAME ||
    !env.TENCENT_SMS_TEMPLATE_ID
  ) {
    console.warn(`[sms] TENCENT_SMS_* not fully configured, dev simulate. phone=${phone} code=${code}`);
    return { ok: true, requestId: 'dev-simulated' };
  }

  const region = env.TENCENT_SMS_REGION || 'ap-guangzhou';
  const timestamp = Math.floor(Date.now() / 1000);

  // 业务 body
  const body = {
    PhoneNumberSet: [`+86${phone}`],
    SmsSdkAppId: env.TENCENT_SMS_SDK_APP_ID,
    SignName: env.TENCENT_SMS_SIGN_NAME,
    TemplateId: env.TENCENT_SMS_TEMPLATE_ID,
    TemplateParamSet: [code],
  };
  const payload = JSON.stringify(body);

  // V3 签名
  const authHeader = await tc3SignAuthHeader(
    SMS_SERVICE,
    SMS_HOST,
    payload,
    timestamp,
    env.TENCENT_SMS_SECRET_ID,
    env.TENCENT_SMS_SECRET_KEY,
  );

  // 发请求
  let r: Response;
  try {
    r = await fetch(`https://${SMS_HOST}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Host': SMS_HOST,
        'X-TC-Action': SMS_ACTION,
        'X-TC-Version': SMS_VERSION,
        'X-TC-Region': region,
        'X-TC-Timestamp': String(timestamp),
        'Authorization': authHeader,
      },
      body: payload,
    });
  } catch (e) {
    return { ok: false, errCode: 'NETWORK', errMsg: String(e) };
  }

  // 腾讯云返回包格式：{"Response":{"Error":{Code,Message}|absent, RequestId, SendStatusSet:[{Code,Message,SerialNo,PhoneNumber}]}}
  const data = (await r.json()) as {
    Response?: {
      Error?: { Code: string; Message: string };
      RequestId?: string;
      SendStatusSet?: Array<{ SerialNo: string; PhoneNumber: string; Code: string; Message: string }>;
    };
  };

  if (data.Response?.Error) {
    return { ok: false, errCode: data.Response.Error.Code, errMsg: data.Response.Error.Message };
  }
  // 单条 PhoneNumberSet 应返回 SendStatusSet 长度 1，Code='Ok' 表示成功
  const status = data.Response?.SendStatusSet?.[0];
  if (!status) {
    return { ok: false, errCode: 'NO_SEND_STATUS', errMsg: JSON.stringify(data) };
  }
  if (status.Code !== 'Ok') {
    return { ok: false, errCode: status.Code, errMsg: status.Message };
  }
  return { ok: true, requestId: data.Response?.RequestId };
}
```

- [ ] **Step 2: typecheck**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit
```

期望：无 error。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/auth/sms.ts
git commit -m "$(cat <<'EOF'
feat(worker): auth/sms.ts — SMS 完整防刷链路 (PR2)

模块职责：
- checkRateLimits: 三维度（phone/ip/device）滚动窗口限流 + 30min 锁
- checkAndIncrDailyCap: KV 每日 200 条 hard cap，SMS_DAILY_CAP=0 = kill switch
- checkDailyCapAlerts: 跨 80%/95% 阈值时 PushDeer 告警
- generateCode + hashCode: 6 位数字 + SHA-256(salt+code) hex
- sendSmsViaTencent: 腾讯云 V3 API TC3-HMAC-SHA256 签名 + JSON POST

V3 签名要点（避免坑）：
- SignedHeaders 最小集 'content-type;host'
- canonical headers 内 content-type 必须小写
- date 用 UTC YYYY-MM-DD
- HMAC 链式派生：TC3+secretKey → date → service → tc3_request

dev 时 TENCENT_SMS_* secret 缺失返回 simulated success +
console.log 明文 code 便于本地调试，生产部署前必须 wrangler
secret put 全部 5 个 (SECRET_ID/KEY/SDK_APP_ID/SIGN_NAME/TEMPLATE_ID)。

详见 docs/plans/2026-05-01-auth-system-design.md § 7

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B5: auth/session.ts — session 创建/校验/cookie

**Files:**
- Create: `worker/src/auth/session.ts`

- [ ] **Step 1: 创建 `worker/src/auth/session.ts`**

```typescript
// PR2 session 创建/校验/撤销 + cookie 工具
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 4

import { nanoid } from 'nanoid';
import type { Env } from '../index';
import type { AuthContext, SessionRow, UserRow } from './types';

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;  // 30 天
const COOKIE_NAME = 'xlist_sid';

export async function createSession(
  env: Env,
  userId: string,
  deviceId: string | null,
  ip: string,
  ua: string,
): Promise<{ id: string; expiresAt: number }> {
  const sid = nanoid(32);
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, device_id, ip, ua, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(sid, userId, deviceId, ip, ua, now, now, expiresAt).run();
  return { id: sid, expiresAt };
}

/** 查活跃 session（未过期 + 未撤销 + user.status='active'）+ 滑动续期 last_used_at */
export async function findActiveSession(env: Env, sid: string): Promise<SessionRow | null> {
  const row = await env.DB.prepare(
    `SELECT s.* FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.revoked_at IS NULL AND s.expires_at > ? AND u.status = 'active'`,
  ).bind(sid, Date.now()).first<SessionRow>();
  if (!row) return null;
  // 滑动续期（异步不阻塞响应；调用方用 ctx.waitUntil 包装）
  return row;
}

export async function touchSessionLastUsed(env: Env, sid: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET last_used_at = ? WHERE id = ?`,
  ).bind(Date.now(), sid).run();
}

export async function revokeSession(env: Env, sid: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
  ).bind(Date.now(), sid).run();
}

export async function revokeAllSessionsOfUser(env: Env, userId: string): Promise<number> {
  const r = await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL`,
  ).bind(Date.now(), userId).run();
  return r.meta.changes ?? 0;
}

/** 从请求拿 session_id（优先 Authorization Bearer，再 Cookie） */
export function getSidFromRequest(req: Request): string | null {
  const auth = req.headers.get('Authorization');
  if (auth?.startsWith('Bearer ')) return auth.slice(7).trim();
  const cookie = req.headers.get('Cookie') || '';
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  return m ? decodeURIComponent(m[1]) : null;
}

/** 生成 Set-Cookie header 值。生产用 .ai-feeds.com 顶域（共享子域），dev 用 host-only */
export function buildSessionCookie(sid: string, isDev: boolean): string {
  const maxAge = SESSION_TTL_MS / 1000;
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sid)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAge}`,
  ];
  if (!isDev) {
    parts.push('Secure', 'Domain=.ai-feeds.com');
  }
  return parts.join('; ');
}

export function buildClearCookie(isDev: boolean): string {
  const parts = [`${COOKIE_NAME}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (!isDev) {
    parts.push('Secure', 'Domain=.ai-feeds.com');
  }
  return parts.join('; ');
}

/** 鉴权中间件：拿 session_id → 查表 → 异步续期 */
export async function authenticate(
  req: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<AuthContext> {
  const sid = getSidFromRequest(req);
  if (!sid) return { kind: 'anonymous' };
  const session = await findActiveSession(env, sid);
  if (!session) return { kind: 'anonymous' };
  // 滑动续期（fire-and-forget）
  ctx.waitUntil(touchSessionLastUsed(env, sid));
  return { kind: 'authenticated', userId: session.user_id, sessionId: sid };
}

/** 取当前 user 行（含 status） */
export async function getUserById(env: Env, userId: string): Promise<UserRow | null> {
  return await env.DB.prepare(`SELECT * FROM users WHERE id = ?`).bind(userId).first<UserRow>();
}
```

- [ ] **Step 2: typecheck + Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit

cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/auth/session.ts
git commit -m "$(cat <<'EOF'
feat(worker): auth/session.ts — session 创建/校验/cookie (PR2)

- createSession: nanoid(32) + 30 天 TTL
- findActiveSession: 联表 users 检查 status=active
- touchSessionLastUsed: 滑动续期（调用方用 ctx.waitUntil 异步触发）
- revokeSession / revokeAllSessionsOfUser: 主动登出
- getSidFromRequest: Bearer 优先于 Cookie
- buildSessionCookie / buildClearCookie: dev 不带 Domain/Secure，
  生产带 .ai-feeds.com 顶域（与 Pages 子域 + custom domain 共享）

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C: Endpoint Handlers

### Task C1: POST /api/auth/sms/send

**Files:**
- Create: `worker/src/auth/handlers.ts`（首次创建，含 sms/send handler；后续 task 在同文件追加）

- [ ] **Step 1: 创建 `worker/src/auth/handlers.ts`**

```typescript
// PR2 auth endpoint handlers
// 设计参考：docs/plans/2026-05-01-auth-system-design.md § 9 + § 6

import type { Env } from '../index';
import { verifyTurnstile } from './turnstile';
import {
  checkRateLimits,
  checkAndIncrDailyCap,
  checkDailyCapAlerts,
  generateCode,
  hashCode,
  sendSmsViaTencent,
} from './sms';
import { pushDeerAlert } from '../notifier';

// ─── 工具 ─────────────────────────────────────────────────

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

const PHONE_REGEX = /^1[3-9]\d{9}$/;  // 大陆 11 位手机号

// ─── POST /api/auth/sms/send ──────────────────────────────

interface SmsSendBody {
  phone: string;
  turnstile_token: string;
}

const CODE_HASH_SALT = 'xlist-sms-v1';   // hash 加盐（不变更不需要 secret）

export async function handleSmsSend(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // 1. 解析 + 字段校验
  const deviceId = request.headers.get('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
    return jsonErr('missing or invalid X-Device-Id', 400);
  }

  let body: SmsSendBody;
  try {
    body = (await request.json()) as SmsSendBody;
  } catch {
    return jsonErr('invalid json', 400);
  }

  if (typeof body.phone !== 'string' || !PHONE_REGEX.test(body.phone)) {
    return jsonErr('invalid phone', 400);
  }

  const ip = getClientIp(request);
  const ua = request.headers.get('User-Agent') || '';

  // 2. Turnstile 校验（dev secret 缺失时 bypass）
  const tsOk = await verifyTurnstile(env, body.turnstile_token || null, ip);
  if (!tsOk) {
    await env.DB.prepare(
      `INSERT INTO sms_send_log (phone, ip, device_id, ua, sent_at, result)
       VALUES (?, ?, ?, ?, ?, 'turnstile_failed')`,
    ).bind(body.phone, ip, deviceId, ua, Date.now()).run();
    return jsonErr('captcha failed', 403);
  }

  // 3. 三维度限流
  const rl = await checkRateLimits(env, body.phone, ip, deviceId);
  if (!rl.ok) {
    await env.DB.prepare(
      `INSERT INTO sms_send_log (phone, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'rate_limited', ?)`,
    ).bind(body.phone, ip, deviceId, ua, Date.now(), JSON.stringify({ reason: rl.reason })).run();
    // 严重命中（24h / lock）触发告警
    if (rl.reason === 'phone_24h_limit' || rl.reason === 'phone_locked_30min' || rl.reason === 'ip_24h_total_limit') {
      ctx.waitUntil(
        pushDeerAlert(env, '风控命中', `phone=${body.phone.slice(0, 3)}***${body.phone.slice(-4)} ip=${ip} reason=${rl.reason}`),
      );
    }
    return jsonErr('rate limited', 429, { reason: rl.reason });
  }

  // 4. 每日 cap
  const cap = await checkAndIncrDailyCap(env);
  if (!cap.ok) {
    await env.DB.prepare(
      `INSERT INTO sms_send_log (phone, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'budget_capped', ?)`,
    ).bind(body.phone, ip, deviceId, ua, Date.now(), JSON.stringify({ sent: cap.sent, cap: cap.cap })).run();
    ctx.waitUntil(
      pushDeerAlert(env, 'SMS 当日额度耗尽', `今日发送 ${cap.sent}/${cap.cap}（cap=0 = kill switch）。后续请求 503 直到明日 0 点重置。`),
    );
    return jsonErr('service unavailable', 503);
  }

  // 5. 跨 80% / 95% 阈值告警
  ctx.waitUntil(checkDailyCapAlerts(env, cap.sent, cap.cap));

  // 6. 生成 + hash + 入库
  const code = generateCode();
  const codeHash = await hashCode(code, CODE_HASH_SALT);
  const now = Date.now();
  const expiresAt = now + 5 * 60_000;

  // 7. 调腾讯云发送
  const sendResult = await sendSmsViaTencent(env, body.phone, code);
  if (!sendResult.ok) {
    await env.DB.prepare(
      `INSERT INTO sms_send_log (phone, ip, device_id, ua, sent_at, result, metadata)
       VALUES (?, ?, ?, ?, ?, 'sms_api_error', ?)`,
    ).bind(body.phone, ip, deviceId, ua, now, JSON.stringify({ errCode: sendResult.errCode, errMsg: sendResult.errMsg })).run();
    return jsonErr('sms send failed', 502, { errCode: sendResult.errCode });
  }

  // 8. 落 success 行（含 hash + 过期时间）
  await env.DB.prepare(
    `INSERT INTO sms_send_log (phone, ip, device_id, ua, sent_at, result, code_hash, code_expires_at, metadata)
     VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`,
  ).bind(
    body.phone,
    ip,
    deviceId,
    ua,
    now,
    codeHash,
    expiresAt,
    JSON.stringify({ requestId: sendResult.requestId }),
  ).run();

  return jsonOk({ ok: true, ttl: 300 });
}
```

- [ ] **Step 2: typecheck + Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit

cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/auth/handlers.ts
git commit -m "$(cat <<'EOF'
feat(worker): /api/auth/sms/send handler (PR2)

完整发送链路：device_id 必填 → phone 正则 → Turnstile → 三维度限流
→ 每日 cap → 生成 code → hash 存 D1 → 调腾讯云 → 落 success 行。
失败路径都落 sms_send_log 不同 result 值，便于风控分析。
严重风控命中 + 当日 cap 耗尽自动 PushDeer 告警。

dev 模式（secret 缺失）下 Turnstile bypass + SMS simulate，
能在 wrangler dev 跑通完整流程不真发短信。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task C2: POST /api/auth/login

**Files:**
- Modify: `worker/src/auth/handlers.ts`（追加 handleLogin + import session 工具）

- [ ] **Step 1: 在 `worker/src/auth/handlers.ts` 顶部 import 区追加**

```typescript
import { nanoid } from 'nanoid';
import { createSession, buildSessionCookie } from './session';
import { hashCode as smsHashCode } from './sms';  // 已 import 过的话不要重复
```

注意：`hashCode` 已经在 sms.ts import 中，下面用别名 `smsHashCode` 避免覆盖。如果 C1 import 行已经有 `hashCode`，就直接用，**不要**再 import 别名。检查 line 顶部 `import { ... } from './sms'` 是否已包含 `hashCode`，如有则用原名即可。

实际推荐写法：在 sms 那行 import 加 `hashCode`（如未有）：

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

如果 C1 已经有这行，跳过；没有的话改成上面这样。

- [ ] **Step 2: 在 `handlers.ts` 末尾追加 handleLogin**

```typescript
// ─── POST /api/auth/login ────────────────────────────────

interface LoginBody {
  phone: string;
  code: string;
}

const SESSION_COOKIE_DEV_MARKER = 'localhost';  // 区分 dev/prod 环境

function isDevHost(req: Request): boolean {
  const h = req.headers.get('Host') || '';
  return h.includes(SESSION_COOKIE_DEV_MARKER) || h.includes('127.0.0.1');
}

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

  if (typeof body.phone !== 'string' || !PHONE_REGEX.test(body.phone)) {
    return jsonErr('invalid phone', 400);
  }
  if (typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) {
    return jsonErr('invalid code format', 400);
  }

  const ip = getClientIp(request);
  const ua = request.headers.get('User-Agent') || '';
  const now = Date.now();

  // 1. 找最新一条未消费的 success row
  const row = await env.DB.prepare(
    `SELECT id, code_hash, code_expires_at, code_attempts, sent_at
     FROM sms_send_log
     WHERE phone = ? AND result = 'success' AND code_used_at IS NULL
     ORDER BY sent_at DESC LIMIT 1`,
  ).bind(body.phone).first<{
    id: number;
    code_hash: string;
    code_expires_at: number;
    code_attempts: number;
    sent_at: number;
  }>();

  if (!row) {
    return jsonErr('no pending code', 401);
  }

  // 2. 过期检查
  if (row.code_expires_at < now) {
    return jsonErr('code expired', 401);
  }

  // 3. 锁定检查（错码 5 次）
  if (row.code_attempts >= 5) {
    return jsonErr('too many attempts, locked', 429);
  }

  // 4. 校验 code
  const inputHash = await hashCode(body.code, 'xlist-sms-v1');
  if (inputHash !== row.code_hash) {
    // 错码 → attempts++
    await env.DB.prepare(
      `UPDATE sms_send_log SET code_attempts = code_attempts + 1 WHERE id = ?`,
    ).bind(row.id).run();
    const remaining = 5 - (row.code_attempts + 1);
    return jsonErr('invalid code', 401, { attempts_remaining: Math.max(remaining, 0) });
  }

  // 5. 校验通过 → mark used
  await env.DB.prepare(
    `UPDATE sms_send_log SET code_used_at = ? WHERE id = ?`,
  ).bind(now, row.id).run();

  // 6. 找/建 user
  const ident = await env.DB.prepare(
    `SELECT user_id FROM identities
     WHERE provider = 'phone' AND identity_value = ? AND unbound_at IS NULL`,
  ).bind(body.phone).first<{ user_id: string }>();

  let userId: string;
  let isNewUser = false;
  if (ident) {
    userId = ident.user_id;
    // 更新 last_active_at
    await env.DB.prepare(
      `UPDATE users SET last_active_at = ? WHERE id = ?`,
    ).bind(now, userId).run();
  } else {
    // 自动注册：建 user + identity
    userId = nanoid(14);
    isNewUser = true;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (id, created_at, last_active_at, status)
         VALUES (?, ?, ?, 'active')`,
      ).bind(userId, now, now),
      env.DB.prepare(
        `INSERT INTO identities (user_id, provider, identity_value, verified_at)
         VALUES (?, 'phone', ?, ?)`,
      ).bind(userId, body.phone, now),
    ]);
  }

  // 7. 关联 device → 历史 events 行的 user_id
  ctx.waitUntil(
    env.DB.prepare(
      `UPDATE events SET user_id = ?
       WHERE device_id = ? AND user_id IS NULL AND occurred_at > ?`,
    ).bind(userId, deviceId, now - 30 * 24 * 3600_000).run(),  // 仅回填最近 30 天，防误关联
  );

  // 8. 创建 session
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

- [ ] **Step 2: typecheck + Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit

cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/auth/handlers.ts
git commit -m "$(cat <<'EOF'
feat(worker): /api/auth/login handler (PR2)

完整登录链路：找最新未消费 code → 过期/锁定/hash 校验 → 错码计数
→ 校验通过 mark used → 找/建 user + identity → 异步关联 device 历史
→ 创建 session 返 cookie + body。

自动注册：phone 不存在 → nanoid(14) user_id + insert identity
（设计文档 § 6.2 边界场景）。dev host (localhost / 127.0.0.1) 不带
Secure/Domain，正常域名带 .ai-feeds.com 顶域。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task C3: POST /api/auth/logout + /api/auth/logout-all

**Files:**
- Modify: `worker/src/auth/handlers.ts`（追加两个 handler）

- [ ] **Step 1: 在 `handlers.ts` 顶部 import 追加**

```typescript
import { authenticate, revokeSession, revokeAllSessionsOfUser, buildClearCookie } from './session';
```

如果 C2 已经 import session 部分（`createSession, buildSessionCookie`），合并到一个 import line：

```typescript
import {
  createSession,
  buildSessionCookie,
  buildClearCookie,
  authenticate,
  revokeSession,
  revokeAllSessionsOfUser,
} from './session';
```

- [ ] **Step 2: 追加 logout 两个 handler**

```typescript
// ─── POST /api/auth/logout ───────────────────────────────

export async function handleLogout(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') {
    return jsonErr('not authenticated', 401);
  }
  await revokeSession(env, auth.sessionId);
  return jsonOk({ ok: true }, { 'Set-Cookie': buildClearCookie(isDevHost(request)) });
}

// ─── POST /api/auth/logout-all ───────────────────────────

export async function handleLogoutAll(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') {
    return jsonErr('not authenticated', 401);
  }
  const count = await revokeAllSessionsOfUser(env, auth.userId);
  return jsonOk({ ok: true, revoked: count }, { 'Set-Cookie': buildClearCookie(isDevHost(request)) });
}
```

- [ ] **Step 3: typecheck + Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit

cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/auth/handlers.ts
git commit -m "feat(worker): /api/auth/logout + logout-all handlers (PR2)

logout: 仅 revoke 当前 sid。
logout-all: revoke user 所有未撤销 session，返回 revoked count。
两者都返 Set-Cookie clear 让浏览器删 cookie。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task C4: GET /api/auth/me

**Files:**
- Modify: `worker/src/auth/handlers.ts`（追加 handleMe + import getUserById）

- [ ] **Step 1: 在 `handlers.ts` import session 那行追加 `getUserById`**

```typescript
import {
  createSession,
  buildSessionCookie,
  buildClearCookie,
  authenticate,
  revokeSession,
  revokeAllSessionsOfUser,
  getUserById,
} from './session';
```

- [ ] **Step 2: 追加 handleMe**

```typescript
// ─── GET /api/auth/me ────────────────────────────────────

export async function handleMe(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const auth = await authenticate(request, env, ctx);
  if (auth.kind !== 'authenticated') {
    return jsonErr('not authenticated', 401);
  }
  const user = await getUserById(env, auth.userId);
  if (!user) {
    return jsonErr('user not found', 404);
  }
  // 找当前主 phone identity（脱敏）
  const ident = await env.DB.prepare(
    `SELECT identity_value FROM identities
     WHERE user_id = ? AND provider = 'phone' AND unbound_at IS NULL
     ORDER BY verified_at DESC LIMIT 1`,
  ).bind(auth.userId).first<{ identity_value: string }>();
  const phoneMasked = ident
    ? `${ident.identity_value.slice(0, 3)}****${ident.identity_value.slice(-4)}`
    : null;
  return jsonOk({
    user: {
      id: user.id,
      display_name: user.display_name,
      avatar_url: user.avatar_url,
      created_at: user.created_at,
      phone_masked: phoneMasked,
    },
  });
}
```

- [ ] **Step 3: typecheck + Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit

cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/auth/handlers.ts
git commit -m "feat(worker): /api/auth/me handler (PR2)

返回当前 user + 主 phone（脱敏 138****1234）。
未登录 401，user.status=banned 因 authenticate 已挡掉自动 401。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task C5: 共享 export

**Files:**
- Modify: `worker/src/auth/handlers.ts`（确保所有 5 个 handler 都 export）

- [ ] **Step 1: 检查 handlers.ts 末尾，确认 5 个 handler 都标 `export`**

打开 `worker/src/auth/handlers.ts`，grep `^export`：

```bash
grep "^export async function\|^export function" worker/src/auth/handlers.ts
```

期望输出 5 行：
- handleSmsSend
- handleLogin
- handleLogout
- handleLogoutAll
- handleMe

如有缺失（function 名前面少了 `export`），加上。typecheck 应该已经报错抓到，但保险检查。

- [ ] **Step 2: typecheck**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit
```

期望：无 error。

- [ ] **Step 3: 不需要 commit（无改动则跳过；如有补 export 改动则 commit）**

如果 grep 验证已经全 export 不缺，跳过这个 task 的 commit（这是个纯检查 task）。如果发现并补加 export，则：

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/auth/handlers.ts
git commit -m "fix(worker): 补 handler export 漏掉的 (PR2)"
```

---

## Phase D: 路由接入 + 端到端 curl 验证

### Task D1: index.ts 接 5 条路由

**Files:**
- Modify: `worker/src/index.ts`

- [ ] **Step 1: 在 `worker/src/index.ts` 顶部 import 区追加**

找到现有 `import { handleTrack } from './track';` 那行，下面追加：

```typescript
import {
  handleSmsSend,
  handleLogin,
  handleLogout,
  handleLogoutAll,
  handleMe,
} from './auth/handlers';
```

- [ ] **Step 2: 在路由表追加 5 条 — `worker/src/index.ts` 中**

找到现有的 `if (path === '/api/track' && request.method === 'POST') { ... }` 块，在它**之后**追加：

```typescript
      if (path === '/api/auth/sms/send' && request.method === 'POST') {
        const resp = await handleSmsSend(request, env, ctx);
        return withCors(resp, request, env);
      }
      if (path === '/api/auth/login' && request.method === 'POST') {
        const resp = await handleLogin(request, env, ctx);
        return withCors(resp, request, env);
      }
      if (path === '/api/auth/logout' && request.method === 'POST') {
        const resp = await handleLogout(request, env, ctx);
        return withCors(resp, request, env);
      }
      if (path === '/api/auth/logout-all' && request.method === 'POST') {
        const resp = await handleLogoutAll(request, env, ctx);
        return withCors(resp, request, env);
      }
      if (path === '/api/auth/me' && request.method === 'GET') {
        const resp = await handleMe(request, env, ctx);
        return withCors(resp, request, env);
      }
```

注意：fetch handler 现有签名是 `async fetch(request: Request, env: Env)`，PR2 handler 需要 `ctx: ExecutionContext` 来 `ctx.waitUntil(...)`。需要把 fetch handler 签名改为 `async fetch(request: Request, env: Env, ctx: ExecutionContext)`，然后传 `ctx` 给 handler。

修改 `worker/src/index.ts` 的 default export：

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // ... 原有 routing 逻辑
  },
  async scheduled(event, env, ctx) { ... }  // 已有，不动
}
```

`/api/track` 那条路由也要改成传 ctx（虽然现有没用 ctx，但保持签名一致）。看现有代码：

现有 `/api/track`：

```typescript
if (path === '/api/track' && request.method === 'POST') {
  const resp = await handleTrack(request, env);
  // 给响应加 CORS headers...
  ...
}
```

`handleTrack` 不需要 ctx，所以不用改它的调用。但 fetch 函数签名需要加 ctx 参数。

- [ ] **Step 3: 抽出 `withCors` 工具函数（DRY）**

5 个路由都有"resp + 加 CORS headers"的逻辑，重复。在 `worker/src/index.ts` 现有 `corsHeaders` / `jsonResponse` 函数附近加：

```typescript
function withCors(resp: Response, request: Request, env: Env): Response {
  const newHeaders = new Headers(resp.headers);
  for (const [k, v] of Object.entries(corsHeaders(request, env))) {
    newHeaders.set(k, v);
  }
  return new Response(resp.body, { status: resp.status, headers: newHeaders });
}
```

然后改 `/api/track` 那段，从内联逻辑变成 `return withCors(await handleTrack(...), request, env)` 风格保持一致。

最终 index.ts 的 fetch 区域大约这样（节选）：

```typescript
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    try {
      if (path === '/api/ingest' && request.method === 'POST') {
        return handleIngest(request, env);
      }
      // ... 其他原有路由 ...
      if (path === '/api/track' && request.method === 'POST') {
        return withCors(await handleTrack(request, env), request, env);
      }
      if (path === '/api/auth/sms/send' && request.method === 'POST') {
        return withCors(await handleSmsSend(request, env, ctx), request, env);
      }
      if (path === '/api/auth/login' && request.method === 'POST') {
        return withCors(await handleLogin(request, env, ctx), request, env);
      }
      if (path === '/api/auth/logout' && request.method === 'POST') {
        return withCors(await handleLogout(request, env, ctx), request, env);
      }
      if (path === '/api/auth/logout-all' && request.method === 'POST') {
        return withCors(await handleLogoutAll(request, env, ctx), request, env);
      }
      if (path === '/api/auth/me' && request.method === 'GET') {
        return withCors(await handleMe(request, env, ctx), request, env);
      }
      // ... /img 等保持原样 ...
      return jsonResponse({ error: 'Not found' }, 404, request, env);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Internal error';
      return jsonResponse({ error: msg }, 500, request, env);
    }
  },
  async scheduled(...) { ... },  // 已有 不动
};
```

- [ ] **Step 4: typecheck**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx tsc --noEmit
```

期望：无 error。

- [ ] **Step 5: Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add worker/src/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): wire 5 个 auth 路由 + withCors DRY (PR2)

POST /api/auth/sms/send / /login / /logout / /logout-all
GET /api/auth/me

fetch handler 签名加 ExecutionContext，handler 用 ctx.waitUntil
做异步 PushDeer 告警 / events 表回填。withCors 抽出 DRY 重复逻辑。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D2: 端到端 curl 矩阵

**Files:** 无源码改动（仅运行 + 检查）

> 这是 PR2 最重要的验证 task。完整跑一遍登录/防刷/会话流程，确认每个分支都按预期行为。

- [ ] **Step 1: 启动 wrangler dev (background)**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx wrangler dev --local --port 8788 &
sleep 8
```

确认 `Ready on http://localhost:8788` 出现。

- [ ] **Step 2: dev 模式无 secret 完整流程**

```bash
DID="dev-test-$(date +%s)"
PHONE="13800001234"
TOKEN_HEADER="X-Device-Id: $DID"

echo "=== 1. send 应 200（dev 无 TENCENT secret 走 simulate）==="
curl -s -i -X POST http://localhost:8788/api/auth/sms/send \
  -H "Content-Type: application/json" \
  -H "$TOKEN_HEADER" \
  -d "{\"phone\":\"$PHONE\",\"turnstile_token\":\"dev-bypass\"}"

echo ""
echo "=== 2. wrangler dev 终端找 code ==="
# B4 task 已经在 sendSmsViaTencent 的 dev simulate 分支里 console.log
# 了明文 code（[sms] TENCENT_SMS_* not fully configured ... code=XXXXXX）。
# 看 wrangler dev 那个终端的最近一行 [sms] 输出，把 6 位 code 抄下来。
```

- [ ] **Step 3: 重启 wrangler dev（如有改动）+ 拿 code 跑后续矩阵**

```bash
# kill 之前的 wrangler dev（如有）
pkill -f "wrangler dev" 2>/dev/null || true
sleep 2

cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx wrangler dev --local --port 8788 &
sleep 8
```

- [ ] **Step 5: 完整 curl 矩阵**

```bash
DID="dev-test-$(date +%s)"
PHONE="13800001234"
H_DID="X-Device-Id: $DID"

echo "=== 1. SEND — 应 200 + body { ok: true, ttl: 300 } ==="
curl -s -X POST http://localhost:8788/api/auth/sms/send \
  -H "Content-Type: application/json" \
  -H "$H_DID" \
  -d "{\"phone\":\"$PHONE\",\"turnstile_token\":\"dev-bypass\"}"
echo ""
echo "→ 看 wrangler dev terminal 输出找 [sms] dev simulate. phone=... code=XXXXXX"
echo "→ 把 code 填到下面 CODE 环境变量"
read -p "Enter code: " CODE

echo ""
echo "=== 2. SEND 60s 内重复 — 应 429 reason=phone_60s_limit ==="
curl -s -X POST http://localhost:8788/api/auth/sms/send \
  -H "Content-Type: application/json" \
  -H "$H_DID" \
  -d "{\"phone\":\"$PHONE\",\"turnstile_token\":\"dev-bypass\"}"

echo ""
echo "=== 3. LOGIN 错码 — 应 401 attempts_remaining=4 ==="
curl -s -X POST http://localhost:8788/api/auth/login \
  -H "Content-Type: application/json" \
  -H "$H_DID" \
  -d "{\"phone\":\"$PHONE\",\"code\":\"000000\"}"

echo ""
echo "=== 4. LOGIN 正确码 — 应 200 + Set-Cookie + body 含 user/session ==="
SID=$(curl -s -i -X POST http://localhost:8788/api/auth/login \
  -H "Content-Type: application/json" \
  -H "$H_DID" \
  -d "{\"phone\":\"$PHONE\",\"code\":\"$CODE\"}" \
  | tee /tmp/login_resp.txt \
  | grep -oE 'Set-Cookie: xlist_sid=[^;]+' | sed 's/Set-Cookie: xlist_sid=//')
echo "session_id: $SID"
cat /tmp/login_resp.txt | tail -10

echo ""
echo "=== 5. ME — Bearer 应 200 ==="
curl -s -X GET http://localhost:8788/api/auth/me \
  -H "Authorization: Bearer $SID" \
  -H "$H_DID"

echo ""
echo "=== 6. LOGOUT — 应 200 + Set-Cookie clear ==="
curl -s -i -X POST http://localhost:8788/api/auth/logout \
  -H "Authorization: Bearer $SID" \
  -H "$H_DID"

echo ""
echo "=== 7. ME 之后 — 应 401（session 已 revoke）==="
curl -s -X GET http://localhost:8788/api/auth/me \
  -H "Authorization: Bearer $SID" \
  -H "$H_DID"
```

- [ ] **Step 6: 验证 D1 落库**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker

echo "=== sms_send_log（应有 success / rate_limited 各 1 条）==="
npx wrangler d1 execute xlist --command="SELECT result, code_attempts FROM sms_send_log ORDER BY id DESC LIMIT 5;" --local

echo ""
echo "=== users（应有 1 条 active）==="
npx wrangler d1 execute xlist --command="SELECT id, status, created_at FROM users ORDER BY created_at DESC LIMIT 3;" --local

echo ""
echo "=== identities（应有 1 条 phone=13800001234）==="
npx wrangler d1 execute xlist --command="SELECT user_id, provider, identity_value, verified_at FROM identities ORDER BY id DESC LIMIT 3;" --local

echo ""
echo "=== sessions（应有 1 条 revoked_at IS NOT NULL）==="
npx wrangler d1 execute xlist --command="SELECT id, user_id, revoked_at IS NOT NULL as revoked FROM sessions ORDER BY id DESC LIMIT 3;" --local
```

期望 4 个 SQL 都返回符合预期的行（详见每段 echo 注释）。

- [ ] **Step 7: 杀 wrangler dev**

```bash
pkill -f "wrangler dev"
```

- [ ] **Step 8: 不需要 commit**（D2 是验证 task，无源码改动）

---

## Phase E: 文档同步

### Task E1: docs/operations.md 更新

**Files:**
- Modify: `docs/operations.md`

- [ ] **Step 1: 在 `docs/operations.md` 端点清单加 5 行 auth endpoints**

找到端点表格，在 `/api/track` 之后追加：

```markdown
| `/api/auth/sms/send` | POST | 发送短信验证码（必带 `X-Device-Id` + Turnstile token） | 无 + 4 层防刷 |
| `/api/auth/login` | POST | 提交 phone+code 登录或自动注册（必带 `X-Device-Id`） | 无 |
| `/api/auth/logout` | POST | 撤销当前 session | session token |
| `/api/auth/logout-all` | POST | 撤销该 user 全部 session | session token |
| `/api/auth/me` | GET | 返回当前 user（含脱敏 phone） | session token |
```

- [ ] **Step 2: 在 D1 表清单从 7 → 11**

找到「7 个表」那行，改为「11 个表」，在 events 表后追加：

```markdown
  - `users`（2026-05-02 PR2 新增）— 永久身份主键。`status` 枚举 active/banned/self_deleted；nanoid 14 字符 id。详见 `docs/plans/2026-05-01-auth-system-design.md` § 3.1
  - `identities`（2026-05-02 PR2 新增）— 登录凭证多对一关联 user。`provider` 枚举 phone/wechat/email；UNIQUE(provider, identity_value, unbound_at) 保证同一凭证同时只能绑定一个 user。详见 § 3.2
  - `sessions`（2026-05-02 PR2 新增）— cookie/bearer 双兼容 token，nanoid 32 字符 id，30 天滑动过期。详见 § 3.3
  - `sms_send_log`（2026-05-02 PR2 新增）— 短信发送日志 + 防刷计数 + 验证码 hash。`result` 枚举 success/rate_limited/turnstile_failed/sms_api_error/budget_capped。30 天 retention cron 待加。详见 § 3.4
```

- [ ] **Step 3: 加 secrets 清单章节**

在「自定义域名与 DNS」之前的位置加新章节：

```markdown
### 5. Secrets（PR2 上线必备）

```bash
cd worker

# Turnstile（CF Dashboard - Turnstile 创建 site 后给）
npx wrangler secret put TURNSTILE_SECRET_KEY

# 腾讯云 SMS（API V3 凭证 + 应用/签名/模板 ID）
npx wrangler secret put TENCENT_SMS_SECRET_ID         # 类似 AccessKeyId，AKID 开头 36 字符
npx wrangler secret put TENCENT_SMS_SECRET_KEY        # 32 字符
npx wrangler secret put TENCENT_SMS_SDK_APP_ID        # 短信应用 ID，1400 开头 7 位数字
npx wrangler secret put TENCENT_SMS_SIGN_NAME         # 已审签名，例：xList
npx wrangler secret put TENCENT_SMS_TEMPLATE_ID       # 已审模板 ID，例：1234567
# 可选：TENCENT_SMS_REGION（默认 ap-guangzhou，国内一般不动）

# PushDeer 风控告警（xueqiuFollow admin 组：iPhone + Mac）
npx wrangler secret put PUSHDEER_ADMIN_KEYS  # 输入：PDU394...,PDU394...
```

**Kill switch**：`SMS_DAILY_CAP=0` 立刻停发短信（不动代码）。
**回滚 secret**：`wrangler secret put X` 输入新值即覆盖；删除用 `wrangler secret delete X`。
```

- [ ] **Step 4: 加 4 层防刷阈值参考表**

在 secrets 章节之后追加：

```markdown
### 6. SMS 防刷阈值（PR2 设计参考）

| Layer | 维度 | 阈值 | 修改位置 |
|-------|------|------|---------|
| L1 | CF Turnstile | managed 模式 | CF dashboard |
| L1 | CF Rate Limiting (per IP) | `/api/auth/sms/send` 5/min/IP | CF dashboard rules |
| L2 | phone 60s | ≥ 1 拒 | `worker/src/auth/sms.ts` |
| L2 | phone 5min | ≥ 3 拒 | 同上 |
| L2 | phone 24h | ≥ 10 拒 | 同上 |
| L2 | ip 1h unique phones | ≥ 10 拒 | 同上 |
| L2 | ip 24h total | ≥ 30 拒 | 同上 |
| L2 | device 24h unique phones | ≥ 5 拒 | 同上 |
| L3 | 全局每日 cap | 200 条 | `SMS_DAILY_CAP` env |
| L4 | 验证码错码锁 | 5 次错 → 30 min 锁 | `worker/src/auth/sms.ts` MAX_ATTEMPTS_BEFORE_LOCK / LOCK_DURATION_MS |
```

- [ ] **Step 5: 更新顶部「最后更新」日期**

把 `最后更新：2026-04-29` 改为 `最后更新：2026-05-02`，括号里追加 `PR2 auth backend：4 张表 + 5 个 endpoint + 4 层 SMS 防刷 + Turnstile + PushDeer 告警`。

- [ ] **Step 6: Commit**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend
git add docs/operations.md
git commit -m "$(cat <<'EOF'
docs(ops): operations.md 加 PR2 auth backend 完整运维信息

- 端点清单加 5 条 /api/auth/* (sms/send + login + logout + logout-all + me)
- D1 表数 7 → 11，新增 users / identities / sessions / sms_send_log 条目
- 加 secrets 清单章节（5 个 secret 的 wrangler put 命令 + kill switch）
- 加 SMS 4 层防刷阈值参考表（含每个阈值的修改位置）
- 更新顶部"最后更新"日期到 2026-05-02

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase F: 生产部署（外部依赖就绪后再做）

> ⚠️ 本 phase 必须在用户完成「外部依赖」清单（腾讯云 SMS / Turnstile）后才能跑。如果 secret 没就绪，跳过 F2-F4 但仍可跑 F1（远端 schema migration 不依赖 secret）。

### Task F1: 远端 D1 应用迁移

- [ ] **Step 1: 应用 006 + 007 到远端**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx wrangler d1 execute xlist --file=migrations/006-users-identities-sessions.sql --remote
npx wrangler d1 execute xlist --file=migrations/007-sms-send-log.sql --remote
```

- [ ] **Step 2: 验证远端表已创建**

```bash
npx wrangler d1 execute xlist --command="SELECT name FROM sqlite_master WHERE type='table' AND (name='users' OR name='identities' OR name='sessions' OR name='sms_send_log');" --remote
```

期望：4 行。

### Task F2: 上传 5 个 secret（用户操作前置）

- [ ] **Step 1: 用户已搞定腾讯云 SMS / Turnstile / PushDeer 后**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npx wrangler secret put TURNSTILE_SECRET_KEY
npx wrangler secret put TENCENT_SMS_SECRET_ID
npx wrangler secret put TENCENT_SMS_SECRET_KEY
npx wrangler secret put TENCENT_SMS_SDK_APP_ID
npx wrangler secret put TENCENT_SMS_SIGN_NAME
npx wrangler secret put TENCENT_SMS_TEMPLATE_ID
npx wrangler secret put PUSHDEER_ADMIN_KEYS
```

按提示交互输入每个 secret 的值。

- [ ] **Step 2: 验证 secret 已加**

```bash
npx wrangler secret list
```

应看到 8 个 secret（之前的 INGEST_TOKEN + DEEPSEEK_API_KEY + 7 个新加）。

### Task F3: 部署 Worker

- [ ] **Step 1: 部署**

```bash
cd /Users/roxor/brain/30-projects/xlist-scraper/.worktrees/feat-auth-backend/worker
npm run deploy
```

期望成功 + 给 version id。

### Task F4: 远端 curl 烟雾

- [ ] **Step 1: 远端 5 个 endpoint 都不 500**

```bash
echo "=== sms/send（用临时假 phone，预期被 Turnstile 拒 403）==="
curl -s -i -X POST https://api.ai-feeds.com/api/auth/sms/send \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: deploy-smoke-$(date +%s)" \
  -d '{"phone":"19900001111","turnstile_token":"intentionally-bad"}' | head -5

echo ""
echo "=== login（无 code，预期 401 no pending code）==="
curl -s -i -X POST https://api.ai-feeds.com/api/auth/login \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: deploy-smoke-$(date +%s)" \
  -d '{"phone":"19900001111","code":"123456"}' | head -5

echo ""
echo "=== me（无 cookie，预期 401）==="
curl -s -i -X GET https://api.ai-feeds.com/api/auth/me | head -5
```

预期 3 个全部不 500。

> ⚠️ 不在生产用真实 phone 测端到端登录（避免占用真实 SMS 配额）。等 PR3 前端登录 UI 上线后用自己手机号过一次完整流程即可。

---

## 完成验收

- [ ] 21 task 全部 commit
- [ ] 本地 wrangler dev + curl 矩阵全部按预期行为（D2）
- [ ] `worker/src/auth/` 5 个文件 + `worker/src/notifier.ts` 都存在 + typecheck 通过
- [ ] D1 远端有 users/identities/sessions/sms_send_log 4 张表
- [ ] operations.md 同步更新
- [ ] 不存在任何 hardcoded secret 在生产代码（grep `SMS_xx` / `PDU394` / `TURN_*` 应只在文档）

## 后续步骤

- 走 superpowers:finishing-a-development-branch 决定合 main 时机
- PR3（前端登录 UI）从 main 出新 worktree
- 预留 TODO：30 天 retention cron 清旧 sms_send_log + sessions（在 worker scheduled 里加分支）

## TODO（不在本 PR）

- 注销账号 endpoint `/api/auth/delete`（PR3 UI 上线后做）
- 30 天 retention cron 清 sms_send_log / sessions / events
- CF Rate Limiting 规则（dashboard 配置，不动代码）
- 微信 OAuth（等切企业主体）
- events 表自动埋点（auth 流程的 sms_send_attempt / login_success 等事件）— PR3 前端 SDK 调用时填，不在 worker 端
