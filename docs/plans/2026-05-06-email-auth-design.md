---
title: "Email 验证码登录设计 — 绕过备案的主路径"
created_at: 2026-05-06
status: draft
owner: roxor
tags: [auth, email, design, resend, spam-control]
related:
  - docs/plans/2026-05-01-auth-system-design.md
  - docs/plans/2026-05-02-pr2-auth-backend-implementation.md
  - docs/plans/2026-05-02-pr3-auth-frontend-implementation.md
---

# Email 验证码登录设计 — 绕过备案的主路径

> 状态：draft（brainstorm 完毕，等用户审 spec → 进 writing-plans）
> 设计前置：[2026-05-01 账号系统设计](2026-05-01-auth-system-design.md)
> 触发动机：ICP 备案周期太长，SMS / 一键登录 / 微信 connect 全部依赖备案。Email 不依赖备案，国内外通吃，是「先把产品推向市场」的最低门槛登录通道。

---

## 1. 背景与边界

### 1.1 当前现状

- 账号系统主体已上线（PR1-PR4，2026-05-03）：
  - schema：`users` / `identities` / `sessions` / `sms_send_log` / `events`
  - 后端：腾讯云 SMS V3、4 层防刷、200/天 cap、Turnstile、session 30 天滑动续期
  - 前端：`LoginModal.tsx`（手机号 + Turnstile + 6 位码）+ `RequireAuth`
  - 主体策略：个人主体起步，schema 已预留 `provider='wechat' | 'email' | 'apple'`
- **关键限制**：`PHONE_REGEX = /^1[3-9]\d{9}$/` 只认大陆 11 位手机号 → 海外用户被拦死
- **合规风险**：腾讯云 SMS 商用 + 阿里云邮件推送 + 微信 OAuth + 一键登录全部依赖 ICP 备案，备案周期通常 20+ 工作日

### 1.2 为什么做（核心驱动）

**急着把产品推向市场，绕过备案周期。**

| 通道 | 备案要求 | 国内通用 | 海外通用 |
|---|---|---|---|
| 大陆 SMS | ✅ 必须 | ✅ | ❌ |
| 一键登录（电信/移动/联通号码认证） | ✅ 必须 + 企业主体 | ✅ | ❌ |
| 微信 Connect OAuth | ✅ 必须 + 企业主体 | ✅ | ❌ |
| Apple / Google OAuth | ❌ | ⚠️（Google 国内不通） | ✅ |
| **Email 验证码** | **❌** | **✅** | **✅** |

Email 是唯一不依赖备案、国内外通吃、个人主体可立即上线的通道。

### 1.3 与已上线 SMS 系统的关系

- **不删 SMS 代码**：保留全部 PR2/PR3 实现 + 腾讯云配置 + Turnstile widget
- **feature flag 隐藏 SMS**：`ENABLE_SMS_LOGIN=false`（worker env） + `VITE_AUTH_CHANNEL=email`（dashboard env）
- **备案完成后翻 flag**：恢复 SMS + email 双通道（届时另开设计文档讨论双 tab UI）

### 1.4 设计哲学

- 和 SMS 流程**完全同构**：6 位验证码 + Turnstile + 多维度限流 + 失败锁 + 全局 daily cap
- email 通道**独立计数**：自己的 `email_send_log` 表 + 自己的 KV cap key，避免风控耦合
- email 特有的两层补充：一次性邮箱黑名单 + MX 预校验
- YAGNI：magic link / 密码 / OAuth / 多语言邮件 / HTML 模板 / email-phone 用户合并 — 全部不做

---

## 2. 整体架构

### 2.1 端到端流程

```
游客点"登录"
  → LoginModal 打开（email-only 模式，VITE_AUTH_CHANNEL=email）
  → 用户输 email → Turnstile 校验 → POST /api/auth/email/send
  → 后端按序：Turnstile 验证 / 黑名单 / MX 预校验 / 6 维度限流 / 月日 cap
  → 通过 → 生成 6 位码 + hash → Resend HTTPS API 发邮件
  → 落 email_send_log（result='success' + code_hash + expires_at）
  → 返回 200，前端进入"等输码"态

用户收到邮件 → 输 6 位码 → POST /api/auth/login（identifier=email, code=xxx）
  → 后端按 email 走 verify path：找最新 success row → 校验 hash → 标记 used
  → 找/建 user + identity（provider='email'）
  → 关联 device_id → 历史 events 回填 user_id
  → 创建 session → Set-Cookie → 200

后续访问：cookie / Authorization 携带 session_id（与 SMS 路径完全一致）
```

### 2.2 数据流图

```
┌────────────┐     ┌──────────────────┐     ┌─────────┐
│ Dashboard  │────▶│ Worker handlers  │────▶│ Resend  │
│ LoginModal │     │ /auth/email/send │     │ API     │
└────────────┘     │ /auth/login      │     └─────────┘
       │           └──────────────────┘           │
       │                  │                       │
       │                  ▼                       ▼
       │           ┌──────────────┐         ┌──────────┐
       │           │ D1           │         │ 用户邮箱 │
       │           │ email_send_  │         │ (QQ/163/ │
       │           │ log          │         │  Gmail)  │
       │           │ users        │         └──────────┘
       │           │ identities   │
       │           │ sessions     │
       │           │ events       │
       │           └──────────────┘
       │                  │
       │                  ▼
       │           ┌──────────────┐
       │           │ KV (AUTH_KV) │
       │           │ email_count_ │
       │           │ YYYYMMDD     │
       │           │ email_count_ │
       │           │ YYYYMM       │
       │           │ mx_cache_*   │
       │           └──────────────┘
       │
       └─── X-Device-Id header / cookie
```

---

## 3. 数据模型

### 3.1 新建 `email_send_log` 表

与 `sms_send_log` 完全对称（避免 migrate `sms_send_log` 的风险），唯一差别是 `email` 字段替代 `phone`：

```sql
CREATE TABLE email_send_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  ip TEXT NOT NULL,
  device_id TEXT,
  ua TEXT,
  sent_at INTEGER NOT NULL,            -- Unix ms
  result TEXT NOT NULL,
    -- 'success'
    -- | 'turnstile_failed'
    -- | 'rate_limited'
    -- | 'disposable_blocked'
    -- | 'mx_failed'
    -- | 'budget_capped'
    -- | 'resend_api_error'
  code_hash TEXT,                       -- SHA256(code + salt) 仅 result='success' 行有
  code_expires_at INTEGER,              -- sent_at + 5min
  code_attempts INTEGER NOT NULL DEFAULT 0,  -- 错码次数，达 5 次锁
  code_used_at INTEGER,                 -- 验证通过后填，标记码已消费
  metadata TEXT                         -- JSON：reason / errCode / requestId 等
);

CREATE INDEX idx_email_send_log_email_sent ON email_send_log(email, sent_at DESC);
CREATE INDEX idx_email_send_log_ip_sent ON email_send_log(ip, sent_at DESC);
CREATE INDEX idx_email_send_log_device_sent ON email_send_log(device_id, sent_at DESC);
```

### 3.2 `identities` 表（无改动）

`provider='email'` schema 已支持，`identity_value` 存归一化后的 email（小写 + trim）。

### 3.3 `users` / `sessions`（无改动）

新 email 用户走与 SMS 用户完全相同的创建流程：`nanoid(14)` 生成 user_id + 自动建 identity + 创建 session。

### 3.4 KV namespace（复用 `AUTH_KV`）

新增 keys：
- `email_count_YYYYMMDD` — 当日发送计数（int），expirationTtl 36h
- `email_count_YYYYMM` — 当月发送计数（int），expirationTtl 35d
- `mx_cache_<domain>` — MX 预校验结果缓存（'ok' | 'fail'），expirationTtl 24h

---

## 4. 后端 handler

### 4.1 新增 endpoint

| Method | Path | 用途 |
|---|---|---|
| POST | `/api/auth/email/send` | 发验证码邮件 |
| POST | `/api/auth/login`（扩展） | 加 email verify 分支 |

### 4.2 `/api/auth/email/send` 流程

```typescript
// worker/src/auth/email-handlers.ts (新文件)
async function handleEmailSend(req, env, ctx) {
  // 1. 解析 + 字段校验
  const deviceId = req.headers.get('X-Device-Id');
  if (!validDeviceId(deviceId)) return jsonErr('missing X-Device-Id', 400);
  const body = await req.json();
  const email = body.email?.trim().toLowerCase();
  if (!EMAIL_REGEX.test(email)) return jsonErr('invalid email', 400);

  const ip = getClientIp(req);
  const ua = req.headers.get('User-Agent') || '';

  // 2. Turnstile 校验（复用 verifyTurnstile）
  if (!await verifyTurnstile(env, body.turnstile_token, ip)) {
    await logFailure(env, email, ip, deviceId, ua, 'turnstile_failed');
    return jsonErr('captcha failed', 403);
  }

  // 3. 一次性邮箱黑名单（disposable-email-domains 包，bundle 内）
  const domain = email.split('@')[1];
  if (isDisposableDomain(domain)) {
    await logFailure(env, email, ip, deviceId, ua, 'disposable_blocked');
    ctx.waitUntil(maybeAlertDisposableSpike(env));
    return jsonErr('please use a real email', 400, { reason: 'disposable_blocked' });
  }

  // 4. MX 预校验（CF DoH + KV 24h 缓存）
  const mxOk = await checkMxRecord(env, domain);
  if (!mxOk) {
    await logFailure(env, email, ip, deviceId, ua, 'mx_failed');
    return jsonErr('email domain has no mx record', 400, { reason: 'mx_failed' });
  }

  // 5. 6 维度限流（与 SMS 同结构，identifier=email）
  const rl = await checkEmailRateLimits(env, email, ip, deviceId);
  if (!rl.ok) {
    await logFailure(env, email, ip, deviceId, ua, 'rate_limited', { reason: rl.reason });
    if (RL_SEVERE.includes(rl.reason)) {
      ctx.waitUntil(pushDeerAlert(env, '风控命中(email)', ...));
    }
    return jsonErr('rate limited', 429, { reason: rl.reason });
  }

  // 6. 日度 cap（先做：阈值更紧，daily 失败时 monthly 不 incr，避免 KV 计数偏差）
  const dayCap = await checkAndIncrEmailDailyCap(env);
  if (!dayCap.ok) {
    await logFailure(env, email, ip, deviceId, ua, 'budget_capped',
      { scope: 'daily', sent: dayCap.sent, cap: dayCap.cap });
    ctx.waitUntil(pushDeerAlert(env, 'Email 当日额度耗尽', ...));
    return jsonErr('service unavailable', 503);
  }

  // 7. 月度 cap
  const monthCap = await checkAndIncrEmailMonthlyCap(env);
  if (!monthCap.ok) {
    await logFailure(env, email, ip, deviceId, ua, 'budget_capped',
      { scope: 'monthly', sent: monthCap.sent, cap: monthCap.cap });
    ctx.waitUntil(pushDeerAlert(env, 'Email 当月额度耗尽', ...));
    return jsonErr('service unavailable', 503);
    // 注：此时 daily count 已 +1，下日重置，可接受 best-effort 偏差
  }

  // 8. 跨 80% / 95% 告警
  ctx.waitUntil(checkEmailDailyCapAlerts(env, dayCap.sent, dayCap.cap));
  ctx.waitUntil(checkEmailMonthlyCapAlerts(env, monthCap.sent, monthCap.cap));

  // 9. 生成 + hash + 发邮件
  const code = generateCode();
  const codeHash = await hashCode(code, 'xlist-email-v1');
  const now = Date.now();
  const expiresAt = now + 5 * 60_000;

  const sendResult = await sendEmailViaResend(env, email, code);
  if (!sendResult.ok) {
    await logFailure(env, email, ip, deviceId, ua, 'resend_api_error',
      { errCode: sendResult.errCode, errMsg: sendResult.errMsg });
    return jsonErr('email send failed', 502);
  }

  // 10. 落 success row
  await env.DB.prepare(
    `INSERT INTO email_send_log
       (email, ip, device_id, ua, sent_at, result, code_hash, code_expires_at, metadata)
     VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`,
  ).bind(email, ip, deviceId, ua, now, codeHash, expiresAt,
         JSON.stringify({ resendId: sendResult.id })).run();

  return jsonOk({ ok: true, ttl: 300 });
}
```

### 4.3 `/api/auth/login` 扩展

现有 handler `body.phone` 改为 `body.identifier`，根据格式自动判断 phone vs email：

```typescript
async function handleLogin(req, env, ctx) {
  const body = await req.json();
  const identifier = body.identifier?.trim().toLowerCase();
  const code = body.code;

  let provider: 'phone' | 'email';
  if (PHONE_REGEX.test(identifier)) provider = 'phone';
  else if (EMAIL_REGEX.test(identifier)) provider = 'email';
  else return jsonErr('invalid identifier', 400);

  // feature flag：备案前 phone 通道关闭
  if (provider === 'phone' && env.ENABLE_SMS_LOGIN !== 'true') {
    return jsonErr('sms login disabled', 403);
  }

  const logTable = provider === 'phone' ? 'sms_send_log' : 'email_send_log';
  const idCol = provider === 'phone' ? 'phone' : 'email';
  const hashSalt = provider === 'phone' ? 'xlist-sms-v1' : 'xlist-email-v1';

  // 找 success row → 校验过期 / attempts / hash → mark used
  // 找/建 user + identity（provider 字段）
  // 关联 device_id → events 回填 → share_relations 回填
  // 创建 session → Set-Cookie → 200
  // ...（其余逻辑与现有 phone 路径同构，只是表名 / provider 不同）
}
```

**字段兼容**：worker 和 dashboard 同 PR 同步部署，理论上不存在老 client。但保留 `body.phone` fallback 一周作为 hedge（应对 dashboard 缓存 / CF Pages cache 没刷新等边缘情况），下次 PR 时直接删。

### 4.4 共用工具抽象

把 SMS 和 email 共用的逻辑抽到 `worker/src/auth/verify-shared.ts`：

```typescript
// 通用验证码工具
export function generateCode(): string;
export function hashCode(code: string, salt: string): Promise<string>;

// 通用风控（参数化 identifier 字段）
export async function checkRateLimitsGeneric(
  env: Env,
  table: 'sms_send_log' | 'email_send_log',
  idCol: 'phone' | 'email',
  identifier: string,
  ip: string,
  deviceId: string | null,
  thresholds: RateLimitThresholds,
): Promise<RateLimitResult>;

// 通用 daily/monthly cap（参数化 KV key prefix + cap env var）
export async function checkAndIncrCap(
  env: Env,
  scope: 'daily' | 'monthly',
  channel: 'sms' | 'email',
  cap: number,
): Promise<CapResult>;
```

---

## 5. Spam 风控

### 5.1 一次性邮箱黑名单

- 用 npm 包 `disposable-email-domains`（约 3000 域名，~50KB），打包进 worker bundle
- worker 启动时 `import disposableDomains from 'disposable-email-domains'` 加载到 Set
- 命中 → result='disposable_blocked'，用户文案：「请使用真实邮箱」
- 包含主流一次性邮箱：`mailinator.com` / `10minutemail.com` / `guerrillamail.com` / `temp-mail.org` 等

**升级路径**：未来若发现遗漏，加自维护补丁集合 `data/disposable-email-extras.txt`，在 worker 启动时合并。

### 5.2 MX 预校验

- 用 CF DoH（DNS-over-HTTPS）：`https://cloudflare-dns.com/dns-query?name=<domain>&type=MX`
- KV 缓存 24h（`mx_cache_<domain>` → `'ok'` 或 `'fail'`），命中即返回
- 超时 / 网络错误 → 默认放行（不因 DNS 抖动拦正常用户）
- 命中无 MX → result='mx_failed'，文案：「邮箱地址无效」

**预期效果**：过滤 `asdf@asdf.com` / `test@notexist.xyz` 这类纯假邮箱，MX 配置正常的真实域名（QQ、163、Gmail 等）秒过。

### 5.3 多维度限流（与 SMS 同结构）

| 维度 | 阈值 | reason 字段 |
|---|---|---|
| email 60s 内 success ≥ 1 | 拒 | `email_60s_limit` |
| email 5min 内 success ≥ 3 | 拒 | `email_5min_limit` |
| email 24h 内 success ≥ 10 | 拒 | `email_24h_limit` |
| ip 1h 内 unique email ≥ 10 | 拒 | `ip_1h_unique_emails_limit` |
| ip 24h 内 success ≥ 30 | 拒 | `ip_24h_total_limit` |
| device 24h 内 unique email ≥ 5 | 拒 | `device_24h_unique_emails_limit` |
| 验证码错 5 次 + 30min 内 | 拒 | `email_locked_30min` |

**严重命中触发 PushDeer**：`email_24h_limit` / `email_locked_30min` / `ip_24h_total_limit`。

### 5.4 全局 cap + 告警

| 阈值 | 触发动作 |
|---|---|
| 当日 ≥ 80（80%） | PushDeer warn：「今日 email 已发 80/100」 |
| 当日 ≥ 95（95%） | PushDeer urgent：「当日额度即将耗尽」 |
| 当日 ≥ 100 | 503 + PushDeer critical |
| 当月 ≥ 2400（80%） | PushDeer warn |
| 当月 ≥ 2850（95%） | PushDeer urgent |
| 当月 ≥ 3000 | 503 + PushDeer critical |

**告警去重**：同阈值同日只发一次（KV 标记 `email_alert_<scope>_<level>_<date>`）。

### 5.5 行为风控（后续 PR，不阻塞本次上线）

- 单 user 1h 内 events 数 > X（具体阈值届时讨论）→ 自动 ban
- 触发条件 / 阈值 / ban 解除流程在后续 PR 中细化
- 本次上线先不做（不阻塞）

---

## 6. 邮件内容模板

### 6.1 极简纯文本（不用 HTML）

**Subject**：`你的登录验证码：123456`

**Body**：
```
【AI Feeds】

验证码：123456

5 分钟内有效，请勿告诉他人。

如果不是你本人操作，请忽略此邮件。

---
AI Feeds（https://ai-feeds.com）
```

### 6.2 设计依据

- 纯文本：HTML 邮件进垃圾箱概率显著高于纯文本
- Subject 含验证码：用户在邮箱列表页就能看到，无需打开（部分客户端会预览）
- 不带追踪像素 / 退订 link：transactional 邮件不需要，加了反而被反垃圾系统标
- 中文为主：受众主要中国用户，海外用户也能看懂"验证码"+ 6 位数字

---

## 7. 发件人与 DNS 配置

### 7.1 发件域名

`AI Feeds <noreply@mail.ai-feeds.com>`

**为什么用子域 `mail.ai-feeds.com`**：
- 跟主站 `ai-feeds.com` 隔离邮件信誉（marketing email 进垃圾箱不会拖累主站）
- Resend 推荐做法
- DNS 配置完全在 CF DNS 上做（ai-feeds.com 已托管在 CF）

### 7.2 必需 DNS 记录（CF DNS 加 4 条 TXT）

具体值在 Resend 后台 Domains 页面拿到，结构：

| 记录类型 | 名称 | 值（示例） |
|---|---|---|
| TXT | `mail.ai-feeds.com` | `v=spf1 include:amazonses.com ~all` |
| TXT | `resend._domainkey.mail.ai-feeds.com` | `v=DKIM1; k=rsa; p=...` |
| TXT | `_dmarc.mail.ai-feeds.com` | `v=DMARC1; p=none; rua=mailto:dmarc@ai-feeds.com` |
| MX | `feedback.mail.ai-feeds.com` | `feedback-smtp.us-east-1.amazonses.com`（return-path） |

DNS 生效一般 < 5min（CF），生效后在 Resend 后台点 Verify。

---

## 8. 前端改动

### 8.1 `LoginModal.tsx` 修改点

- 输入框 placeholder：「请输入手机号」→「请输入邮箱」
- 输入 type：`tel` → `email`
- 校验正则：`PHONE_REGEX` → `EMAIL_REGEX`（`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`）
- 输入处理：去掉 `replace(/\D/g, '').slice(0, 11)`，改 `trim().toLowerCase()`
- 标题：「登录 / 注册」（不变）
- 标签：「手机号」→「邮箱」

### 8.2 错误文案 i18n

新增 case：

| `reason` | 文案 |
|---|---|
| `disposable_blocked` | 「请使用真实邮箱（不支持临时邮箱）」 |
| `mx_failed` | 「邮箱地址无效」 |
| `email_60s_limit` | 「请稍候再试（60 秒内只能发 1 次）」 |
| `email_5min_limit` | 「请稍候再试」 |
| `email_24h_limit` | 「今日发送次数过多，请明天再试」 |
| `email_locked_30min` | 「账户已临时锁定，请 30 分钟后再试」 |
| `resend_api_error` | 「邮件服务暂时不可用，请稍后重试」 |

### 8.3 `lib/auth.ts` 改动

- 新增 `sendEmailCode(email: string, turnstileToken: string)` 函数
- 现有 `login(phone, code)` 改 `login(identifier, code)`，调 `/api/auth/login` 时用 `identifier` 字段（兼容 phone + email）

### 8.4 Feature flag

- 新增 env：`VITE_AUTH_CHANNEL = 'email'`（备案前）
- 备案后翻 flag：`VITE_AUTH_CHANNEL = 'sms+email'` → 触发新 UI 设计（届时另起 spec）
- 当前阶段所有 channel 选择硬编码为 email，flag 只在 build time 影响行为

---

## 9. Resend 集成

### 9.1 Worker 端代码

```typescript
// worker/src/auth/resend.ts (新文件)
const RESEND_API = 'https://api.resend.com/emails';

export async function sendEmailViaResend(
  env: Env,
  to: string,
  code: string,
): Promise<{ ok: true; id: string } | { ok: false; errCode?: string; errMsg?: string }> {
  const r = await fetch(RESEND_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'AI Feeds <noreply@mail.ai-feeds.com>',
      to,
      subject: `你的登录验证码：${code}`,
      text: [
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
      ].join('\n'),
    }),
  });

  if (!r.ok) {
    const errMsg = await r.text().catch(() => '');
    return { ok: false, errCode: String(r.status), errMsg: errMsg.slice(0, 200) };
  }
  const data = await r.json() as { id: string };
  return { ok: true, id: data.id };
}
```

### 9.2 Secret 配置

```bash
# prod
cd worker && npx wrangler secret put RESEND_API_KEY
# staging
cd worker && npx wrangler secret put RESEND_API_KEY --env staging
```

**重要**：刚才在对话里贴出来的那个 key 已暴露，实施前必须在 Resend 后台旋转一次，新 key 直接通过 `wrangler secret put` 设置（不要再写到任何 git tracked 文件）。

---

## 10. 部署流程

### 10.1 实施顺序（依赖排序）

1. **【人工】** Resend 后台旋转旧 key（已在对话中暴露）
2. **【人工】** Resend 后台添加 domain `mail.ai-feeds.com`，复制 4 条 DNS 记录
3. **【人工 + Claude】** CF DNS 加 4 条 TXT/MX 记录
4. **【人工】** Resend 后台点 Verify，确认 DNS 生效
5. **【Claude】** 写代码（worker schema + handlers + 黑名单 + MX + Resend + 前端 LoginModal 改造 + feature flag）
6. **【Claude】** D1 migration（先 staging 后 prod）：`migrations/0NN_email_send_log.sql`
7. **【Claude】** `wrangler secret put RESEND_API_KEY`（staging + prod）
8. **【Claude】** worker 部署 staging → smoke test
9. **【Claude】** dashboard 部署 staging → smoke test（用真实邮箱 e2e 跑一遍）
10. **【Claude】** worker + dashboard 部署 prod
11. **【Claude】** 更新 `docs/operations.md`：加 Resend 服务节
12. **【人工】** prod e2e：QQ / 163 / Gmail 各试一次，确认能收到

### 10.2 PR 拆分

**单 PR**：`feat/email-auth`，估算 ~600 行代码，按功能模块切 commit：

1. `feat(auth): D1 email_send_log 表 + identities 已支持 email`
2. `feat(auth): worker 共用风控工具抽象（sms 和 email 共用）`
3. `feat(auth): /api/auth/email/send + Resend 集成`
4. `feat(auth): 一次性邮箱黑名单 + MX 预校验`
5. `feat(auth): /api/auth/login 扩展 email 分支 + feature flag`
6. `feat(auth): dashboard LoginModal email 模式 + 错误文案`
7. `feat(auth): VITE_AUTH_CHANNEL feature flag + ENABLE_SMS_LOGIN env`
8. `docs(ops): Resend 服务运维 + DNS 配置 + 告警阈值`

**单 PR 而非分多 PR 的理由**：前后端必须同步部署（不然 SMS 走不通 + email 还没接），分 PR 反而需要兼容代码。整个 PR ≤ 600 行可控。

### 10.3 Rollback 计划

- worker rollback：`wrangler rollback` 回到上一版（5 秒）
- dashboard rollback：CF Pages 后台点上一版「Rollback to this version」
- DB schema：`email_send_log` 表是新增，不影响现有数据；rollback 时保留即可（无须 drop）
- DNS 记录：保留即可，不影响其他服务

### 10.4 监控指标（Day 1 ~ Day 7 关注）

- Resend Dashboard：发送总量 / 投递率 / 退信率
- D1 query：`SELECT result, COUNT(*) FROM email_send_log GROUP BY result` 看比例分布
- PushDeer 告警频率：是否每日触发 / 风控命中比例
- 用户登录成功率（前端埋点 `LOGIN_SUCCESS` / `CODE_VERIFY_ATTEMPT`）

---

## 11. 测试策略

### 11.1 单元测试

新增模块的纯函数测试：
- `isDisposableDomain(domain)` — 命中黑名单 / 不命中
- `checkMxRecord(env, domain)` — mock fetch，覆盖 ok / fail / timeout
- `generateCode()` — 6 位数字
- `hashCode(code, salt)` — 确定性输出

### 11.2 集成测试（手动）

staging 环境用真实邮箱跑一遍：

| 场景 | 期望 |
|---|---|
| 正常 Gmail 邮箱 → 发码 → 输码 → 登录 | 成功 |
| QQ / 163 邮箱 | 成功，确认收到 |
| 一次性邮箱（mailinator.com）| 400 disposable_blocked |
| 假邮箱（asdf@asdf.com）| 400 mx_failed |
| 同邮箱 60s 内连发 2 次 | 第 2 次 429 email_60s_limit |
| 错码 5 次 | 第 5 次 429 email_locked_30min |
| 错码 + 等 30min | 解锁，可重新发码 |
| Turnstile token 不带 | 403 captcha failed |

### 11.3 性能 / 配额验证

- 单次 `/api/auth/email/send` 耗时 < 2s（含 Resend 调用 + MX DoH 查询）
- worker subrequest 用量：1（Turnstile） + 0/1（MX DoH） + 1（Resend）= 最多 3 次/请求，远低于 1000 的 Paid 配额
- D1 写入：1 次（落 success row）+ 0~1 次（落 failure row），都在 batch 之外

---

## 12. 不做的事（YAGNI）

| 不做的事 | 理由 |
|---|---|
| Magic link 登录 | 跨设备 / webview 兼容差，实现成本翻倍 |
| 邮箱密码登录 | 增加忘记密码流程 + 安全风险（hash 存储等），第一版不必 |
| OAuth（Apple / Google） | 不依赖备案但增加 redirect 处理 + 多 provider 适配，第一版不必 |
| HTML 邮件模板 | 进垃圾箱概率高，纯文本足够 |
| 邮件多语言 | 中文为主受众，英文用户也能看懂 6 位数字 |
| 邮件队列 / 重试机制 | Resend 失败直接 502，前端引导用户重试即可 |
| email + phone 用户合并 | identities schema 已支持，等用户投诉再做 |
| 邮箱改 / 重新绑定 UI | 第一版 email 用户都是新建，不存在改邮箱场景 |
| 注销账号的邮箱处理 | 现有 `/api/auth/delete` 流程已 generic 化，扩展即可 |
| 行为风控（user 1h events 上限） | 后续 PR 单独做，不阻塞本次上线 |

---

## 13. 工作量预估

| 模块 | 工时 |
|---|---|
| D1 migration + email_send_log 索引 | 0.5h |
| worker handler（email/send + login email 分支扩展） | 3-4h |
| 共用风控工具抽象（sms/email shared） | 1.5h |
| 一次性邮箱黑名单 + MX 预校验 | 2h |
| Resend 集成 + 月日 cap + 告警 | 1.5h |
| dashboard LoginModal 改造 + feature flag | 2-3h |
| 错误文案 i18n + 状态机调整 | 1h |
| DNS 配置 + Resend 后台 + secret 设置（多数等待 DNS 生效）| 1h |
| staging 测试 + prod 部署 | 1h |
| 运维手册更新 | 0.5h |
| **合计** | **14-17h（约 2 工作日）** |

---

## 14. 与已上线 SMS 系统的兼容性 checklist

- [x] `users` 表无改动 — 同样兼容 phone / email 用户
- [x] `identities` 表无改动 — `provider='email'` 已预留
- [x] `sessions` 表无改动 — session 与 channel 无关
- [x] `events` 表无改动 — user_id 关联逻辑通用
- [x] `share_relations.to_uid` 回填逻辑通用 — login handler 内已 channel-agnostic
- [x] `RequireAuth` 拦截逻辑通用 — 不关心通过哪个 channel 登录的
- [x] Turnstile widget 共用一个 sitekey — 已有 `0x4AAAAAADJyUx6JD4IMD_1i`
- [x] PushDeer 告警通道共用 `notifier.ts` — 加新告警类型即可
- [x] `INGEST_TOKEN` 等其他 secret 不受影响

---

## 15. 后续路线图（备案完成后）

备案完成后按这个顺序加回 SMS / 一键登录 / 微信：

1. **SMS 重启**：翻 `ENABLE_SMS_LOGIN` flag + 翻 `VITE_AUTH_CHANNEL` 到 `sms+email` → 重新设计 LoginModal tab UI
2. **一键登录**（中国电信号码认证 / 中移动 / 联通）：企业主体接入号码认证 SDK，新增 `provider='operator'` identities 行
3. **微信 Connect OAuth**：企业主体 + 微信开放平台审核，identities 表 `provider='wechat'` 已就绪
4. **Apple Sign In**：iOS app 同步开发时再做，identities 表 `provider='apple'` 已就绪
5. **email + phone 合并 UI**：用户在「设置 - 绑定登录方式」可绑定多个 identity，user_id 不变

每一步都不需要改 schema，只新增 handler + 前端 UI。

---

## 16. 设计审核记录

- 2026-05-06：brainstorm 完成，5 个关键决策点（Q1-Q5）已确认
  - Q1（驱动）：绕过备案，email 当主路径上线
  - spam 风控：复用 SMS 结构 + email 特有两层（黑名单 + MX）
  - Q2（SMS 处置）：B = 保留代码 + feature flag 隐藏
  - Q3（验证形式）：A = 6 位验证码（同 SMS）
  - Q4（邮件服务）：Resend free tier
  - Q5（UI 形态）：A = email-only（备案前）
