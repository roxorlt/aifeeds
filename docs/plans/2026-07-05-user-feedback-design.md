# 用户反馈功能实施计划（User Feedback）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development。本计划按 Task A/B/C 分派，每个 Task 由独立 implementer subagent（Opus 4.8）实施，交付后由独立 review subagent（Opus 4.8）按测试用例验收。
>
> 日期：2026-07-05 · 分支：`feat/user-feedback`（从 main `97ce3a3` 开）· 状态：待实施

**Goal:** C 端登录用户可提交图文反馈（每天 3 条限频），后台看板可查看/按账号检索/图文回复，用户在 C 端接收并查看回复。

**Architecture:** 复用 `dub_wishlist` 垂直切片模式（migration → worker handler → index.ts 路由 → admin 页面），新增两张 D1 表（`feedback` / `feedback_replies`），图片走 R2（`READMES` bucket，content-addressed key，`/r/` 反代下发）。C 端入口挂在 UserMenu 下拉 + Settings 页，登录态且非微信 UA 才展示。

**Tech Stack:** CF Worker（hand-rolled router）+ D1 + R2 / React 19 + react-router 7 + zustand + Tailwind / node:test。

---

## 0. 原始需求（用户 2026-07-05 提出，逐条对照）

| # | 需求 | 落点 |
|---|------|------|
| 1.1 | 微信浏览器：无此模块 | Task B：`isWeChatBrowser()` 时不渲染入口 + `/feedback` 路由重定向回 `/` |
| 1.2 | 非微信浏览器：登录注册后才在设置菜单展示「用户反馈」；每账号每天最多 3 条，超出 toast「操作太频繁了，稍后再试」 | Task B（入口 gating + toast）+ Task A（服务端 429 限频） |
| 1.3 | 反馈文字必填、图片选填最多 1 张 | Task A（服务端校验）+ Task B（表单） |
| 2.1 | DB 存反馈内容、图片、时间 + 设备信息、账号信息等定位问题所需信息 | Task A：migration 024 |
| 2.2 | 看板后台新增「用户反馈」tab，列表展示，可按账号查全部历史 | Task C |
| 2.3 | 后台可发起「回复用户」，图文回复 | Task A（API）+ Task C（UI） |
| 2.4 | 回复内容用户在 C 端接收和查看 | Task A（unread API）+ Task B（我的反馈列表 + 红点） |

## 1. 产品决策记录（autonomous 决策，用户可推翻）

1. **「设置菜单」= UserMenu 头像下拉菜单**，同时在 `/settings` 设置页加同款入口行（两处 gating 一致：`user && !isWeChatBrowser()`）。
2. **「每天」= 北京时区自然日**（沿用 `dub_wishlist.day` 的 BJT YYYY-MM-DD 先例）。
3. **限频是服务端硬校验**（D1 COUNT），前端只负责把 429 翻译成指定 toast 文案；不做前端预拦截（避免多端不同步）。
4. 文字上限 **2000 字**（trim 后非空）；图片 **jpeg/png/webp/gif ≤5MB**（显式禁 svg，防脚本注入）；回复文字上限 5000 字。
5. 回复已读机制：**打开 `/feedback` 页即全部标记已读**；UserMenu 入口红点 = 未读回复数 > 0（登录后拉一次 + 打开反馈页后清零）。
6. C 端「我的反馈」列表取最近 50 条（3 条/天上限下够用数月，v1 不做分页；admin 端有完整历史 + 分页）。
7. `account_info` 快照存**原始 identity 值**（phone/email/wechat openid）——identities 表本就明文存储，快照不扩大暴露面，且方便管理员联系用户定位问题。
8. 反馈图片经 `/r/<key>` 公网可读（sha256 不可枚举 key），与现有用户侧资产同一模型；如未来要私有化再加签名 URL。
9. 微信浏览器「无此模块」：入口不渲染 + 直接输 URL 访问 `/feedback` 时重定向回 `/`。服务端 API 不做微信 UA 拦截（微信内本就无登录态入口，无入口即无提交路径）。
10. 不做的（YAGNI）：用户撤回/删除反馈、多图、admin 回复后再追问的多轮对话结构（回复表天然支持多条 reply，界面按线程平铺即可）、邮件/短信通知。

## 2. Global Constraints（每个 Task 隐含遵守）

- 429 toast 文案**逐字**：`操作太频繁了，稍后再试`
- 限频：**每账号每天（北京时区）最多 3 条**；第 3 条成功、第 4 条 429
- 文字必填：trim 后非空，≤2000 字；回复 ≤5000 字
- 图片：≤1 张、≤5MB、MIME ∈ {image/jpeg, image/png, image/webp, image/gif}
- migration 编号 **024**（main 已到 023；021/022 已被其他分支占用）
- C 端 API 前缀 `/api/feedback*`，仅 GET/POST（CORS 方法白名单是 `GET, POST, OPTIONS`，不要引入 PUT/DELETE）
- admin API 前缀 `/api/admin/feedback*`，**每个 handler 第一行 `requireAuth(request, env)`**（`worker/src/admin.ts:114`）
- C 端所有需登录端点用 `authenticate(request, env, ctx)`（`worker/src/auth/session.ts:104`），`kind !== 'authenticated'` → 401 `{error:'not authenticated'}`
- R2 key：`feedback/<sha256>.<ext>`，存库/返回值一律 `/r/feedback/...` 相对路径（先例 `ph-r2.ts:99-110`）
- C 端 UI：**禁 emoji 当 icon**，用 lucide-react；颜色/间距/按钮 variant 严格按 `docs/frontend-ux-guidelines.md`（primary=`bg-neutral-900`，错误=`text-rose-600`，输入/按钮 `rounded-md`，模态 `rounded-xl`）
- admin 页面：延续 `admin-dashboard.ts` 模板字符串 HTML + 内联 JS 风格，nav 沿用现有 emoji 前缀风格，**所有用户内容经 esc() 转义**再入 HTML
- git：只 `git add` 自己改动的明确路径；**绝不触碰/提交**下列既有脏文件：`worker/src/digest/node-run.ts`、`worker/src/digest/node-run-options.ts`、`worker/src/digest/node-run-options.test.ts`、`codex-daily-payload-sample.json`、`daily-email-preview.html`、`dashboard/.env.staging`、`docs/beian/`、`drawer-snap.md`、`*.bak`、`worker/tsconfig.tsbuildinfo`；**绝不 push**
- commit message 以 `feat(feedback): ...` / `test(feedback): ...` 开头，结尾加 `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## 3. 数据库（migration 024，Task A）

`worker/migrations/024-user-feedback.sql`：

```sql
-- 024: user feedback —— C 端用户反馈 + 后台图文回复。
-- 限频:每账号每 BJT 自然日最多 3 条(服务端 COUNT day 列)。
-- 设计:docs/plans/2026-07-05-user-feedback-design.md

CREATE TABLE IF NOT EXISTS feedback (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       TEXT NOT NULL,          -- users.id
  content       TEXT NOT NULL,          -- 反馈文字(trim 后 ≤2000)
  image_key     TEXT,                   -- R2 key: feedback/<sha256>.<ext>,无图 NULL
  device_info   TEXT,                   -- JSON {client:{...前端上报}, server:{ip,ua,country,colo,asn}}
  account_info  TEXT,                   -- JSON 提交时账号快照 {display_name, identities:[{provider,identity_value}]}
  ip            TEXT,
  ua            TEXT,
  day           TEXT NOT NULL,          -- 北京时区 YYYY-MM-DD(限频)
  created_at    INTEGER NOT NULL,       -- ms
  last_reply_at INTEGER                 -- 最近官方回复时间,NULL=未回复
);
CREATE INDEX IF NOT EXISTS idx_feedback_user_day ON feedback(user_id, day);
CREATE INDEX IF NOT EXISTS idx_feedback_created ON feedback(created_at);

CREATE TABLE IF NOT EXISTS feedback_replies (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  feedback_id  INTEGER NOT NULL,        -- feedback.id
  content      TEXT NOT NULL,           -- 回复文字(≤5000)
  image_key    TEXT,                    -- 可选回复配图,同 R2 规则
  admin_email  TEXT,                    -- 回复人(CF Access JWT email;Basic 兜底时 NULL)
  created_at   INTEGER NOT NULL,        -- ms
  read_at      INTEGER                  -- 用户已读时间,NULL=未读
);
CREATE INDEX IF NOT EXISTS idx_feedback_replies_fb ON feedback_replies(feedback_id);
```

## 4. API 契约（Task A 产出，Task B/C 消费，**不得偏离**）

统一约定：错误返回 `{error: string}` + 对应 HTTP 状态码；成功含 `ok:true`；全部经 `withCors()` 包装；时间一律 epoch ms。

### 4.1 C 端（cookie session auth）

**`POST /api/feedback`** — multipart/form-data
- fields：`content`(string 必填)、`image`(File 选填)、`device`(string 选填，前端采集的 JSON)
- 校验顺序：① 未登录→401 `{error:'not authenticated'}` ② BJT 当日已 3 条→**429** `{error:'rate_limited'}` ③ content trim 空→400 `{error:'content required'}`；>2000→400 `{error:'content too long'}` ④ image size>5MB→400 `{error:'image too large'}`；MIME 不在白名单→400 `{error:'unsupported image type'}` ⑤ device 非法 JSON 或 >8KB→静默忽略（存 null），不报错
- 副作用：图片 sha256 → `env.READMES.put('feedback/<hash>.<ext>', buf, {httpMetadata:{contentType}})`；INSERT feedback（device_info 按 §3 结构合成，server 侧取 `getClientIp` + UA + `request.cf` 的 country/colo/asn；account_info 查 users + identities `unbound_at IS NULL` 快照）
- 200：`{ok:true, id:number, created_at:number, remaining:number}`（remaining = 今日剩余次数）

**`GET /api/feedback/mine`**
- 401 同上；200：
```json
{ "ok": true, "unread_count": 2,
  "items": [ { "id": 12, "content": "…", "image_url": "/r/feedback/ab12….jpg",
    "created_at": 1751600000000,
    "replies": [ { "id": 3, "content": "…", "image_url": null,
      "created_at": 1751690000000, "read_at": null } ] } ] }
```
- items 按 created_at DESC 取最近 50；replies 按 created_at ASC；`image_url` 无图为 null

**`POST /api/feedback/read`** — body 可空
- 将本人全部未读回复 `read_at = Date.now()`；200：`{ok:true, marked:number}`

**`GET /api/feedback/unread-count`**
- 200：`{ok:true, count:number}`（本人 feedback 下 `read_at IS NULL` 的 reply 数）

### 4.2 Admin（`requireAuth`，CF Access JWT / Basic 兜底）

**`GET /api/admin/feedback?q=&status=&page=&page_size=`**
- `q`：可空；匹配 `feedback.user_id` 精确 **OR** `users.display_name LIKE %q%` **OR** `identities.identity_value LIKE %q%`（LIKE 通配符 `%_` 需转义，参数绑定防注入）→ 满足「按账号查某用户全部历史反馈」
- `status`：`all`(默认) | `pending`(last_reply_at IS NULL) | `replied`
- `page` 1 起，`page_size` 默认 20 上限 100，按 created_at DESC
- 200：`{ok:true, total, page, page_size, items:[{id, user_id, display_name, identity, content, image_url, created_at, reply_count, last_reply_at}]}`（`identity` = 首个在用 identity 的 `provider:identity_value`；列表不带 device_info，详情才有）

**`GET /api/admin/feedback/:id`**
- 404 `{error:'not found'}`；200：`{ok:true, feedback:{id, user_id, display_name, identity, content, image_url, device_info, account_info, ip, ua, created_at, last_reply_at}, replies:[{id, content, image_url, admin_email, created_at, read_at}]}`（device_info/account_info 为解析后的 JSON 对象或 null）

**`POST /api/admin/feedback/:id/reply`** — multipart/form-data
- fields：`content`(必填 ≤5000)、`image`(选填，同 §4.1 图片规则)
- 404 反馈不存在；400 校验同上；成功 INSERT reply + `UPDATE feedback SET last_reply_at=?`；`admin_email` 从 `Cf-Access-Jwt-Assertion` 用 jose `decodeJwt` 取 `email` claim（requireAuth 已验签过同一 token，二次解码无需再验；Basic 兜底时存 NULL）
- 200：`{ok:true, id:number, created_at:number}`

### 4.3 路由接线（`worker/src/index.ts`）

- C 端 4 条放 dub-wishlist 路由块（index.ts ~493）附近；admin 3 条放 admin 路由块（~558-575）；`:id` 用 `path.match(/^\/api\/admin\/feedback\/(\d+)$/)` 与 `/^\/api\/admin\/feedback\/(\d+)\/reply$/`
- 全部 `return withCors(await handleXxx(...), request, env)`；handler 收 `(request, env, ctx)` 或含 id 参数，签名与文件内一致

## 5. C 端 UI 规格（Task B）

**文件**：新建 `dashboard/src/pages/Feedback.tsx`；改 `dashboard/src/App.tsx`（路由）、`dashboard/src/components/UserMenu.tsx`（入口+红点）、`dashboard/src/pages/Settings.tsx`（入口行）、`dashboard/src/api.ts`（API 函数 + protectedPaths）。

1. **入口 gating**（1.1/1.2）：UserMenu 下拉新增「用户反馈」项（lucide `MessageSquare` 图标，样式对齐现有「账号设置」项），仅当 `user && !isWeChatBrowser()` 渲染（`dashboard/src/lib/wechat.ts:4` 已有）；Settings 页在「账号管理」下加同 gating 的行。入口右侧红点（`h-2 w-2 rounded-full bg-rose-500`）当未读数 >0。
2. **路由**：App.tsx 加 `/feedback`，包 `<RequireAuth>`（先例 `/settings`）；Feedback.tsx 顶部 `if (isWeChatBrowser()) return <Navigate to="/" replace />`。
3. **表单**：textarea 必填（placeholder「说说你遇到的问题或建议…」，maxLength 2000 + 右下字数 counter `n/2000`）；「添加图片（选填，最多 1 张）」secondary 按钮触发隐藏 `<input type="file" accept="image/jpeg,image/png,image/webp,image/gif">`，选中后 80px 缩略预览 + 右上 ✕ 移除（lucide `X`）；客户端预校验：>5MB → `toast.error('图片不能超过 5MB')`、类型不符 → `toast.error('仅支持 jpg/png/webp/gif 图片')`；提交按钮 primary variant，`content.trim()` 为空或提交中时 disabled。
4. **提交**：multipart POST（`credentials:'include'` + `X-Device-Id` header，**不走 apiFetch 的 JSON/重试路径**——手写 fetch，绝不自动重试写请求）；`device` 字段 JSON：`{ua, platform, language, languages, screen:{w,h}, viewport:{w,h}, dpr, timezone, page: location.pathname, network: navigator.connection?.effectiveType ?? null}`。成功 → `toast.success('反馈已提交，感谢支持')` + 清空表单 + 刷新列表；**429 → `toast.error('操作太频繁了，稍后再试')`**（逐字）；401 → 复用 `openLoginModal('api_401')` 语义（把 `/api/feedback` 加进 api.ts `protectedPaths`，或在手写 fetch 中显式处理——与现有 401 拦截机制一致即可）；其他错误 → `toast.error('提交失败，请稍后再试')`。
5. **我的反馈列表**：表单下方「我的反馈」区块；每条卡片：内容（`whitespace-pre-wrap`）、图片缩略（h-20，点击 `<a target="_blank">` 原图）、相对时间（复用仓库现有时间格式函数）；回复以嵌套块展示：「官方回复」chip + 内容 + 可选图 + 时间；`read_at === null` 的回复标「新」红点。空态「还没有提交过反馈」。加载/错误态按 UX 规范（错误就地 + 重试按钮）。
6. **已读闭环**：页面 mount 且列表拉取成功后 fire-and-forget `POST /api/feedback/read`，并把本地未读数清零（红点消失）；渲染用拉取时的 read_at（本次访问仍可见「新」标记，下次访问消失）。
7. **未读数来源**：auth hydrate 成功后拉一次 `GET /api/feedback/unread-count`（存 UserMenu 局部 state 或轻量 zustand，B 自行选型但不得轮询）。
8. **图片 URL**：接口返回 `/r/...` 相对路径，展示时按仓库现有 `/r/` 资产的拼接方式加 API_BASE 前缀（dev 走 vite proxy，先例见 items 媒体渲染，grep `'/r/'`）。

## 6. Admin UI 规格（Task C）

**文件**：新建 `worker/src/admin-feedback.ts`（`serveAdminFeedbackHtml`，模板字符串 HTML+内联 JS，模仿 `admin-subscriptions.ts` 结构）；改 `worker/src/admin.ts` 的 `adminNavHtml`（新增 `💬 用户反馈` → `/admin/feedback`）；改 `worker/src/index.ts`（页面路由 + §4.2 三个 API 已由 Task A 就位）。

1. 顶部筛选条：搜索框（placeholder「用户ID / 昵称 / 手机号 / 邮箱」）+ 状态下拉（全部/未回复/已回复）+「查询」按钮 → 调 `GET /api/admin/feedback`（`credentials:'include'` 同现有 `getJson` 模式）。
2. 列表表格列：ID / 时间 / 用户（display_name + identity 两行）/ 内容（截 80 字）/ 图片（有则 40px 缩略）/ 回复数 / 最近回复 / 操作「查看」。分页：上一页/下一页 + `共 N 条`。
3. 「查看」→ 页内详情区（列表下方渲染）：完整内容、原图（max-width 400px）、账号快照、`device_info` 以 `<pre>` 格式化 JSON 展示、回复线程（每条：admin_email/时间/内容/图、用户已读状态）；底部回复表单：textarea + 文件选择 + 「回复用户」按钮 → multipart POST `/api/admin/feedback/:id/reply`，成功后刷新详情与列表行。
4. **所有用户产生内容经 esc() HTML 转义**（含 device_info 内字段）；图片 src 只允许 `/r/` 前缀值。
5. 按账号查全部历史 = 搜索框输入该用户任一标识 → 列表即该用户历史（服务端 §4.2 q 匹配已覆盖）。

## 7. 横切关注

- **安全**：admin 三端点逐个 `requireAuth`；C 端归属校验（mine/read 只操作 `user_id = auth.userId` 的行，reply 的 :id 不做 C 端暴露）；LIKE 转义；React 自动转义 + admin esc()；图片禁 svg；multipart 只信白名单 MIME + 大小双限（客户端提示 + 服务端强制）。
- **bot-UA gate**（index.ts:426）：curl 测试须带浏览器 UA（`-A "Mozilla/5.0 …"`），测试用例文档须注明。
- **限频原子性**：COUNT + INSERT 之间无事务，极端并发可能 4 条入库——个人反馈场景可接受，不引入锁（记录于此，reviewer 不必当缺陷）。
- **本地联调 harness**（A/B/C/review 共用）：
  1. `cd worker && npm run db:init:local`（schema.sql 基线）+ 逐个 apply 新 migration：`npx wrangler d1 execute xlist --local --file=migrations/024-user-feedback.sql`
  2. 造登录态：往本地 D1 INSERT users 一行 + sessions 一行（列结构见 `worker/migrations/006-users-identities-sessions.sql`，sid 任意 32 位字符串，expires_at 设未来），请求带 `Cookie: xlist_sid=<sid>`
  3. admin：本地无 CF Access 配置时 `checkAdminAuth` 自动回落 Basic Auth——`npx wrangler dev --var ADMIN_USER:admin --var ADMIN_PASS:test123`，请求带 `-u admin:test123`；**不得**把测试凭据写进任何被提交文件
  4. 端口纪律：Task A / R1 用 8787，Task B 用 8788（`wrangler dev --port`），Task C 用 8789，R2(E2E) 用 8787
- **staging/prod 差异**：staging cookie 名 `xlist_sid_stg`；prod admin 入口 `admin.ai-feeds.com`；staging admin 有 CF Access，自动化测不了 SSO 后渲染（先例见 memory），E2E 一律本地做，staging 只 smoke 公开面。

## 8. 任务拆解

> 顺序：A →（R1 ∥ B）→ C → R2(E2E) → 最终全分支 review → staging + PR。B/C 不并行改 worker 文件；A 与「测试用例撰写」并行。

### Task A：migration 024 + worker 全部 API + 单测

- **Files** — Create: `worker/migrations/024-user-feedback.sql`（§3 原文）、`worker/src/feedback.ts`（全部 7 个 handler + 纯函数 helpers）、`worker/src/feedback.test.ts`；Modify: `worker/src/index.ts`（§4.3 路由）
- **Interfaces produces**：§4 全部端点 + `serveAdminFeedbackHtml` 尚不存在（Task C 建）；导出 handler 名：`handleFeedbackSubmit` / `handleFeedbackMine` / `handleFeedbackMarkRead` / `handleFeedbackUnreadCount` / `handleAdminFeedbackList` / `handleAdminFeedbackDetail` / `handleAdminFeedbackReply`
- **实现参照**：auth 见 `share/handlers.ts:48-51`；BJT day / getClientIp / INSERT 模式见 `dub-wishlist.ts`；R2 put 见 `ph-r2.ts:74-110`；admin 鉴权见 `admin.ts:84-117`
- **单测**（node:test，跑法先看 `worker/src/feeds/ranking.test.ts` 用什么命令能跑通再照抄）：内容校验、图片 MIME/大小/扩展名映射、BJT day 边界（23:59/00:00 UTC+8）、LIKE 转义、remaining 计算
- **自验证**（报告必须附证据）：`npx tsc --noEmit`；单测通过；本地 harness 全链路 curl——401 / 首条成功 / 连发第 4 条 429 / 带图成功且 `/r/` 可取回 / mine / admin list / admin reply / unread-count 1 → read → 0

### Task B：C 端 UI

- **Files** — Create: `dashboard/src/pages/Feedback.tsx`；Modify: `App.tsx`、`UserMenu.tsx`、`Settings.tsx`、`api.ts`
- **Consumes**：§4.1 契约（Task A 已在分支上，可直连本地 worker 验证）
- **规格**：§5 全文
- **自验证**：`npm run build` 无 error；`npm run lint` 通过（若仓库现状本就有存量 lint 告警，不劣化即可）；vite dev（`VITE_API_PROXY=http://127.0.0.1:8788`）+ 本地 worker 手动/脚本 smoke：入口 gating（登录/未登录/微信 UA 模拟）、提交、429 toast 文案逐字、图片预览与移除、列表与回复展示、红点

### Task C：admin「用户反馈」tab

- **Files** — Create: `worker/src/admin-feedback.ts`；Modify: `worker/src/admin.ts`（adminNavHtml）、`worker/src/index.ts`（`/admin/feedback` 页面路由，`requireAuth` 后 `serveAdminFeedbackHtml`）
- **Consumes**：§4.2 契约
- **规格**：§6 全文；CI 有 `scripts/ci/admin-dashboard-smoke.sh`，改完确认其仍通过
- **自验证**：`npx tsc --noEmit`；本地 Basic Auth 打开 `/admin/feedback` 走通：列表 → 搜索（按 user_id / identity）→ 详情（device_info 展示）→ 图文回复成功 → 列表行回复数 +1；XSS 探针（content 提交 `<img src=x onerror=alert(1)>`）在 admin 页以文本展示不执行

### 测试用例撰写（与 Task A 并行）

- **Files** — Create: `docs/plans/2026-07-05-user-feedback-test-cases.md`
- 框架见 §9；产出供 R1/R2 逐条执行

### R1：backend 验收（Task A 后）

独立 review subagent：读 A 的 diff 包 + 测试用例 TC-A/TC-S，本地 harness 逐条执行，产出 spec 符合性 + 代码质量双结论。

### R2：E2E 验收（B+C 后）

独立 review subagent：本地 wrangler dev(8787) + vite dev，按 TC-B/TC-C/TC-I 全流程执行（含微信 UA 模拟、429 文案逐字断言、图片上传、admin 回复回环、红点闭环）；浏览器自动化优先 `npx playwright`（headless，截图存 `$CLAUDE_JOB_DIR/tmp/`）。

### 收尾（我执行/末次 subagent）

最终全分支 review → diff secret 扫描 → rebase 对账 `origin/main` → push 分支 + 开 PR → staging：migration 024 → 临时干净 worktree 部署 worker+dashboard staging → smoke → 汇报（prod 及 PR merge 留给用户）。

## 9. 测试用例框架（给测试用例撰写 subagent 的指导）

文档结构要求：① 环境准备章（本地 harness 步骤 §7 原样收录 + 断言工具约定）② 用例表，每条含：编号 / 前置 / 步骤(可执行命令或操作) / 期望(可断言) / 需求回链(§0 编号)。覆盖矩阵（编号段预分配）：

- **TC-A**（backend，~15 条）：401 未登录 ×4 端点；提交成功含 remaining 递减；第 4 条 429 `rate_limited`；content 空/超长 400；图片超 5MB、svg、非图 400；带图成功且 R2 取回 content-type 正确；device 非法 JSON 不报错；mine 结构与排序；跨用户隔离（用户甲看不到乙）；admin list 分页/status 过滤/q 三路匹配（user_id 精确、display_name 模糊、identity 模糊）；admin detail 404；admin reply 成功后 last_reply_at 更新 + unread 1→read→0
- **TC-S**（安全，~6 条）：admin 三端点无凭据 401；C 端不能调 admin 端点；LIKE 通配注入（q=`%`）不全表泄漏（转义后按字面匹配）；XSS 存储型探针在 admin/C 端均不执行；/r/ 图片 key 不可预测性说明；reply 对不存在 id 404
- **TC-B**（C 端，~12 条）：未登录无入口；登录后有入口；微信 UA（`Object.defineProperty(navigator,'userAgent')` 或 playwright UA override 含 `MicroMessenger`）无入口且 /feedback 重定向；空内容按钮 disabled；字数 counter；选图预览/移除/超限提示文案；提交成功 toast + 表单清空 + 列表出现；**第 4 条 429 toast 逐字 `操作太频繁了，稍后再试`**；回复展示 + 「新」标记；红点出现与清零；刷新后已读持久
- **TC-C**（admin，~8 条）：nav 有 tab；列表渲染；搜索按 user_id/identity 命中同一用户全部历史；status 过滤；详情 device_info/账号快照展示；图文回复成功；XSS 转义；分页
- **TC-I**（集成，~3 条）：完整回环 提交→admin 回复→C 端红点→查看→已读；双反馈多回复计数正确；图片全链路（C 传→admin 看→admin 回图→C 看）

## 10. 交付与部署清单

1. 全任务完成 + 最终 review 干净后：`git log origin/main..HEAD` 自查、diff 扫 secret（token/key/密码/绝对路径）
2. `git fetch origin && git rebase origin/main`（多 session 并行防覆盖）
3. push + `gh pr create`（PR body 含验收摘要 + **醒目注明：合并前必须先跑 prod migration 024**——CI 合并即自动部署 prod worker，代码先于表上线会 500）
4. staging 验证：`npx wrangler d1 execute xlist-staging --env staging --remote --file=migrations/024-user-feedback.sql` → 临时干净 worktree（避免把工作区他人 WIP 打进 bundle）`wrangler deploy --env staging` + dashboard build & pages deploy staging → smoke（未登录 401、admin 302 到 Access、dashboard 入口 gating）
5. 汇报用户：staging 真机验收路径（staging.ai-feeds.com 登录后头像菜单 → 用户反馈；admin-staging 走 SSO）；prod 上线三步（migration → merge → 验证）留给用户拍板

## 11. 风险与回滚

- 纯增量：新表 + 新端点 + 新页面，不改既有行为面；回滚 = revert PR（表可留存无害）
- multipart 是 worker 新模式：R1 重点盯内存（≤5MB arrayBuffer 在 128MB worker 内存内安全）与异常输入
- 与 `feat/wechat-login-*` 并行分支可能都改 UserMenu/LoginModal：本分支对 UserMenu 改动保持最小外科式插入，冲突留给后合者
