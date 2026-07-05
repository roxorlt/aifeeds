# 用户反馈功能 · 测试用例（User Feedback Test Cases）

> 依据：`docs/plans/2026-07-05-user-feedback-design.md`（§0 需求 / §2 全局约束 / §4 API 契约 / §5 C 端 UI / §6 admin UI / §7 harness / §9 用例框架）。
> 断言方式：**black-box spec-based** —— 期望值全部来自设计文档，不反推实现代码。
> 执行者：R1（backend，跑 TC-A / TC-S）+ R2（E2E，跑 TC-B / TC-C / TC-I）。
> 用例总数 **46**：TC-A ×17 · TC-S ×6 · TC-B ×12 · TC-C ×8 · TC-I ×3。

---

## 覆盖矩阵（§9 逐点回链）

| 段 | 覆盖点（§9） | 用例 |
|----|-------------|------|
| TC-A | 401 未登录 ×4 端点 | TC-A-01 |
| TC-A | 提交成功含 remaining 递减 | TC-A-02 |
| TC-A | 第 4 条 429 rate_limited | TC-A-03 |
| TC-A | content 空 / 超长 400 | TC-A-04 / TC-A-05 |
| TC-A | 图片 >5MB / svg / 非图 400 | TC-A-06 / TC-A-07 / TC-A-08 |
| TC-A | 带图成功且 R2 取回 content-type 正确 | TC-A-09 |
| TC-A | device 非法 JSON 不报错 | TC-A-10 |
| TC-A | mine 结构与排序 | TC-A-11 |
| TC-A | 跨用户隔离（甲看不到乙） | TC-A-12 |
| TC-A | admin list q 三路匹配 | TC-A-13 |
| TC-A | admin list status 过滤 | TC-A-14 |
| TC-A | admin list 分页 | TC-A-15 |
| TC-A | admin detail 404 | TC-A-16 |
| TC-A | admin reply → last_reply_at + unread 1→read→0 | TC-A-17 |
| TC-S | admin 三端点无凭据 401 | TC-S-01 |
| TC-S | C 端不能调 admin 端点 | TC-S-02 |
| TC-S | LIKE 通配注入 q=`%` 不全表泄漏 | TC-S-03 |
| TC-S | XSS 存储型探针（后端存原文、UI 不执行） | TC-S-04 |
| TC-S | /r/ 图片 key 不可预测性 | TC-S-05 |
| TC-S | reply 对不存在 id 404 | TC-S-06 |
| TC-B | 未登录无入口 / 登录后有入口 | TC-B-01 / TC-B-02 |
| TC-B | 微信 UA 无入口且 /feedback 重定向 | TC-B-03 |
| TC-B | 空内容按钮 disabled | TC-B-04 |
| TC-B | 字数 counter | TC-B-05 |
| TC-B | 选图预览 / 移除 | TC-B-06 |
| TC-B | 选图超限 / 类型提示文案 | TC-B-07 |
| TC-B | 提交成功 toast + 清空 + 列表出现 | TC-B-08 |
| TC-B | 第 4 条 429 toast 逐字 | TC-B-09 |
| TC-B | 回复展示 + 「新」标记 | TC-B-10 |
| TC-B | 红点出现与清零 | TC-B-11 |
| TC-B | 刷新后已读持久 | TC-B-12 |
| TC-C | nav 有 tab | TC-C-01 |
| TC-C | 列表渲染 | TC-C-02 |
| TC-C | 搜索按 user_id / identity 命中全部历史 | TC-C-03 |
| TC-C | status 过滤 | TC-C-04 |
| TC-C | 详情 device_info / 账号快照展示 | TC-C-05 |
| TC-C | 图文回复成功 | TC-C-06 |
| TC-C | XSS 转义 | TC-C-07 |
| TC-C | 分页 | TC-C-08 |
| TC-I | 完整回环 提交→回复→红点→查看→已读 | TC-I-01 |
| TC-I | 双反馈多回复计数正确 | TC-I-02 |
| TC-I | 图片全链路 | TC-I-03 |

---

## 1. 环境准备

> 所有命令的工作目录（除特别标注）：`/Users/roxor/brain/30-projects/aifeeds/worker`。
> 全套走**本地** wrangler dev + 本地 D1（`--local`），不碰任何 remote / staging / prod。

### 1.1 端口纪律（§7.4）

| 角色 | 端口 | 说明 |
|------|------|------|
| worker（wrangler dev） | **8787** | R1（TC-A/S curl）与 R2（TC-B/C/I E2E）统一用 8787 |
| vite dev（C 端） | **5173** | proxy `/api`、`/r` → `127.0.0.1:8787` |

> ⚠️ 计划 §8 Task B 开发期自测用的是 8788；**评审（R1/R2）统一 8787**（§7.4 明确 R1、R2(E2E) 都用 8787）。若你另起 8788，请把下文 `WORKER`、`VITE_API_PROXY` 里的端口一并改掉，保持一致即可。

### 1.2 起本地 worker

```bash
cd /Users/roxor/brain/30-projects/aifeeds/worker
npx wrangler dev --port 8787 \
  --var ADMIN_USER:admin \
  --var ADMIN_PASS:test123
```

- 本地无 `CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN`，`checkAdminAuth` 自动回落 Basic Auth（`worker/src/admin.ts:84`），凭据即上面注入的 `admin` / `test123`。
- **禁止**把 `admin:test123` 写进任何被 git 追踪的文件（§7.3）。
- 该进程前台常驻；后续命令另开终端执行。

### 1.3 初始化本地 D1 + apply migration 024

```bash
cd /Users/roxor/brain/30-projects/aifeeds/worker

# （可选）想要绝对干净的库，先清本地 D1 状态再 init：
# rm -rf .wrangler/state/v3/d1

# 1) schema.sql 基线（含 users / identities / sessions，已确认）
npm run db:init:local

# 2) apply 反馈表迁移（Task A 产出，内容即设计 §3）
npx wrangler d1 execute xlist --local --file=migrations/024-user-feedback.sql
```

> 若 `migrations/024-user-feedback.sql` 文件名有出入，以 Task A 实际落盘的 024 文件为准；表结构断言仍以设计 §3 为准（`feedback` / `feedback_replies` 两表）。

验证两张表已建：

```bash
npx wrangler d1 execute xlist --local --json \
  --command "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('feedback','feedback_replies') ORDER BY name;"
# 期望：返回 feedback、feedback_replies 两行
```

### 1.4 造测试数据（users / identities / sessions）

INSERT 列严格按 `worker/migrations/006-users-identities-sessions.sql`：
- `users`：NOT NULL 列 `id, created_at, last_active_at`；`status` 默认 `active`（显式写 `active`）。
- `identities`：NOT NULL 列 `user_id, provider, identity_value, verified_at`；**`unbound_at` 必须为 NULL**（= 在用身份，§4.2 / §7 account_info 快照都只取 `unbound_at IS NULL`）。
- `sessions`：NOT NULL 列 `id, user_id, created_at, last_used_at, expires_at`；`expires_at` 必须为**未来**、`revoked_at` 为 NULL（`findActiveSession` 要求 `revoked_at IS NULL AND expires_at > now AND users.status='active'`，见 `auth/session.ts:38`）。

把下面内容写到 `/tmp/fb-test/seed.sql`（`/tmp` 非仓库，不受 git 约束）：

```bash
mkdir -p /tmp/fb-test
cat > /tmp/fb-test/seed.sql <<'SQL'
-- 每次重跑 = 干净重建这两个测试用户 + 清空所有反馈数据
DELETE FROM feedback_replies;
DELETE FROM feedback;
DELETE FROM sessions   WHERE user_id IN ('u_test_jia','u_test_yi');
DELETE FROM identities WHERE user_id IN ('u_test_jia','u_test_yi');
DELETE FROM users      WHERE id      IN ('u_test_jia','u_test_yi');

-- 用户甲 / 乙
INSERT INTO users (id, display_name, avatar_url, created_at, last_active_at, status) VALUES
  ('u_test_jia', '测试用户甲', NULL, 1751000000000, 1751000000000, 'active'),
  ('u_test_yi',  '测试用户乙', NULL, 1751000000000, 1751000000000, 'active');

-- 身份：甲 phone 13800138000 / 乙 email test-b@example.com（unbound_at NULL）
INSERT INTO identities (user_id, provider, identity_value, verified_at, unbound_at) VALUES
  ('u_test_jia', 'phone', '13800138000',       1751000000000, NULL),
  ('u_test_yi',  'email', 'test-b@example.com', 1751000000000, NULL);

-- session（sid 32 位任意唯一串，模拟 nanoid(32)；expires_at=4102444800000 即 2100 年，远期未来）
INSERT INTO sessions (id, user_id, device_id, ip, ua, created_at, last_used_at, expires_at) VALUES
  ('sid-jia-000000000000000000000000', 'u_test_jia', 'dev-jia', '127.0.0.1', 'seed', 1751000000000, 1751000000000, 4102444800000),
  ('sid-yi-0000000000000000000000000', 'u_test_yi',  'dev-yi',  '127.0.0.1', 'seed', 1751000000000, 1751000000000, 4102444800000);
SQL

npx wrangler d1 execute xlist --local --file=/tmp/fb-test/seed.sql
```

> 重跑 `seed.sql` 会**清空所有 feedback / feedback_replies**并重建甲乙 —— 计数/限频类用例前置想要「干净起点」时，重跑它即可。

### 1.5 断言工具约定

在**每个新终端**先导出这些变量（curl 命令直接引用）：

```bash
export WORKER='http://127.0.0.1:8787'
# 浏览器 UA —— 必带，否则撞 index.ts:426 bot-UA gate（§7）
export UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
# 微信内置浏览器 UA（含 MicroMessenger，供 TC-B-03）
export WECHAT_UA='Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.30(0x18001e30) NetType/WIFI Language/zh_CN'
export SID_A='sid-jia-000000000000000000000000'   # 用户甲 session
export SID_B='sid-yi-0000000000000000000000000'   # 用户乙 session
```

约定：
- **C 端登录态**：请求带 `-H "Cookie: xlist_sid=$SID_A"`（`getSidFromRequest` 也接受 `-H "Authorization: Bearer $SID_A"`，二者等价，任选其一）。
- **未登录**：不带任何 cookie / Authorization。
- **admin 鉴权**：`-u admin:test123`（Basic）。
- **bot gate**：**所有** curl 都带 `-A "$UA"`（`/r/*` 虽豁免，也带着无害）。
- **取 HTTP 码 + body**：统一 `-sS -o /tmp/fb-test/out.json -w '%{http_code}\n'`，再 `jq . /tmp/fb-test/out.json`。
- **查库/改库助手**：

```bash
d1() { npx wrangler d1 execute xlist --local --json --command "$1"; }   # 在 worker/ 下用
# 例：d1 "SELECT id,user_id,day,image_key,last_reply_at FROM feedback ORDER BY id;"
# 清空反馈（限频/计数用例前置）：d1 "DELETE FROM feedback_replies; DELETE FROM feedback;"
```

### 1.6 测试图片素材

```bash
mkdir -p /tmp/fb-test

# ① 合法小 jpg（<5MB，1×1 真 JPEG，用于成功 + /r/ content-type 断言）
base64 -D -o /tmp/fb-test/small.jpg <<'B64'
/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkI
CQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA/8QAFAABAAAAAAAA
AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==
B64
# 备选（若上面 base64 解出的 jpg 被拒）：从系统任意图片转一张
#   sips -s format jpeg -z 8 8 <任意现成图片> --out /tmp/fb-test/small.jpg

# ② 超限大图（>5MB，6MB 全零；size 校验先于 decode，无需是合法 jpg）
dd if=/dev/zero of=/tmp/fb-test/big.jpg bs=1024 count=6144 status=none

# ③ svg（显式禁用类型）
printf '%s' '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>' > /tmp/fb-test/test.svg

# ④ 纯文本（非图）
printf 'this is not an image' > /tmp/fb-test/test.txt
```

> macOS `base64` 解码用 `-D`（大写）；GNU coreutils 用 `-d`。若报错换另一个。

### 1.7 C 端登录态注入（TC-B / TC-I 用）

本地 vite dev 在 `localhost:5173`，`/api`、`/r` proxy 到 worker（8787）。浏览器视角下 C 端调用是同源（`localhost:5173`），cookie 域挂在 `localhost`。

**方式一 · extraHTTPHeaders（最稳，推荐做「已登录」用例）** —— 直接给 context 全量请求塞 Cookie 头，绕过 cookie store 的 Secure/Domain/HttpOnly 规则：

```js
const ctx = await browser.newContext({
  baseURL: 'http://localhost:5173',
  userAgent: DESKTOP_UA,
  extraHTTPHeaders: { Cookie: 'xlist_sid=sid-jia-000000000000000000000000' },
});
```

**方式二 · addCookies（贴近真实 cookie 语义，做「登出/清零」类用例时用它，因为可控地「不注入」）**：

```js
await ctx.addCookies([{
  name: 'xlist_sid',
  value: 'sid-jia-000000000000000000000000',
  domain: 'localhost',   // 与浏览器访问的 host 一致；若你用 127.0.0.1:5173 则填 127.0.0.1
  path: '/',
  httpOnly: true,
  secure: false,         // ★ 本地是 http，dev cookie 无 Secure 属性（session.ts buildSessionCookie isDev 分支）；secure:true 会导致 cookie 不被发送
  sameSite: 'Lax',
}]);
```

**方式三 · 手动（devtools 冒烟）**：Chrome → Application → Storage → Cookies → `http://localhost:5173` → 新增 `xlist_sid = <SID_A>`（Secure 不勾、Domain=localhost、Path=/）。

**注入坑与判断（本文作者提示，标注「待 R2 验证」= 我未读实现代码只按 spec 推断）**：

1. **Secure**：dev cookie 无 `Secure`（`session.ts` isDev 分支不加 Secure/Domain）。addCookies 若误设 `secure:true`，http 下不发送 → 表现为「注了 cookie 仍未登录」。**必须 `secure:false`**。
2. **Domain 一致性**：cookie `domain` 要与浏览器访问的 host 完全一致（`localhost` ↔ `localhost`，`127.0.0.1` ↔ `127.0.0.1`），不要用 `.ai-feeds.com`。
3. **vite proxy 转发 Cookie**：`/api` 经 vite proxy 转发到 worker，Cookie 头默认会被 http-proxy 透传。**待 R2 验证**：若发现 worker 侧读不到 cookie（mine 返回 401），改用**方式一 extraHTTPHeaders**（它对所有出站请求强塞 Cookie，必过）。
4. **前端登录态 hydrate**：注入 cookie 后 UI 是否显示「已登录」，取决于前端 mount 时是否用 session-backed 接口（如 `GET /api/auth/session` 之类）拉 `user`。标准实现下 cookie 注入即够；**待 R2 验证**：`addCookies` + `goto` 后若 UserMenu 仍是未登录态，说明前端把登录态持久化在 localStorage/zustand-persist，需要额外 seed 该 store，或退回到「真实走登录弹窗」（但本地无短信通道，故优先方式一 + 确认 hydrate 接口带上了 cookie）。
5. **注入时机**：`addCookies` / 建 context 要在**首次 `page.goto` 之前**，确保首屏 hydrate 就带着登录态。

### 1.8 起 vite dev（C 端）

```bash
cd /Users/roxor/brain/30-projects/aifeeds/dashboard
VITE_API_PROXY=http://127.0.0.1:8787 npm run dev   # 默认 5173
```

playwright 依赖：`cd /Users/roxor/brain/30-projects/aifeeds && npx playwright install chromium`（首次）。截图统一存 `$CLAUDE_JOB_DIR/tmp/`（§8 R2）。

---

## 2. TC-A — Backend（curl，17 条）

> 端口 8787。C 端登录态用 `Cookie: xlist_sid=$SID_A`；admin 用 `-u admin:test123`。每条 curl 均带 `-A "$UA"`。

### TC-A-01 未登录访问 4 个 C 端端点全部 401
- **前置**：worker 已起。
- **步骤**（均**不带** cookie）：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -X POST "$WORKER/api/feedback" -F 'content=x'
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" "$WORKER/api/feedback/mine"
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -X POST "$WORKER/api/feedback/read"
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" "$WORKER/api/feedback/unread-count"
  ```
- **期望**：4 条均 HTTP `401`，body `{"error":"not authenticated"}`（§4.1 校验顺序 ①）。
- **需求回链**：1.2 / 2.4（登录门槛）。

### TC-A-02 首条提交成功，remaining 正确递减
- **前置**：`d1 "DELETE FROM feedback_replies; DELETE FROM feedback;"`（甲今日 0 条）。
- **步骤**：连续提交 3 条：
  ```bash
  for i in 1 2 3; do
    curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
      -H "Cookie: xlist_sid=$SID_A" -H "X-Device-Id: dev-jia-001" \
      -X POST "$WORKER/api/feedback" \
      -F "content=反馈第 $i 条" \
      -F 'device={"ua":"test","platform":"MacIntel","timezone":"Asia/Shanghai"}'
    jq '{ok,id,created_at,remaining}' /tmp/fb-test/out.json
  done
  ```
- **期望**：3 条均 HTTP `200`、`ok:true`、`id` 为数字、`created_at` 为 ms 时间戳；`remaining` 依次 `2 → 1 → 0`（`remaining = 3 - 今日已提交数`，§4.1 200 契约）。
- **需求回链**：1.2 / 1.3 / 2.1。

### TC-A-03 当日第 4 条 → 429 rate_limited
- **前置**：紧接 TC-A-02（甲今日已 3 条）；或先 `DELETE` 再补满 3 条。
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" -X POST "$WORKER/api/feedback" -F 'content=第四条应被限频'
  jq . /tmp/fb-test/out.json
  ```
- **期望**：HTTP `429`，body 精确 `{"error":"rate_limited"}`（§4.1 校验顺序 ②：限频先于内容校验）。第 3 条成功、第 4 条 429（§2）。
- **需求回链**：1.2（每账号每天最多 3 条）。

### TC-A-04 content 空（trim 后）→ 400 content required
- **前置**：`d1 "DELETE FROM feedback;"`（避免撞限频）。
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" -X POST "$WORKER/api/feedback" -F 'content=   '
  jq . /tmp/fb-test/out.json
  ```
- **期望**：HTTP `400`，body `{"error":"content required"}`（纯空白 trim 后为空，§2 / §4.1 ③）。
- **需求回链**：1.3。

### TC-A-05 content 超长（>2000）→ 400 content too long
- **前置**：`d1 "DELETE FROM feedback;"`。
- **步骤**：
  ```bash
  C2001=$(python3 -c "print('a'*2001)")
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" -X POST "$WORKER/api/feedback" -F "content=$C2001"
  jq . /tmp/fb-test/out.json
  ```
- **期望**：HTTP `400`，body `{"error":"content too long"}`（上限 2000，§2 / §4.1 ③）。
- **补充**：可另跑一条恰好 2000 字（`'a'*2000`）→ 期望 `200`（边界内通过；跑前 `DELETE` 防限频）。
- **需求回链**：1.3。

### TC-A-06 图片 >5MB → 400 image too large
- **前置**：`d1 "DELETE FROM feedback;"`。
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" -X POST "$WORKER/api/feedback" \
    -F 'content=带超大图' -F 'image=@/tmp/fb-test/big.jpg;type=image/jpeg'
  jq . /tmp/fb-test/out.json
  ```
- **期望**：HTTP `400`，body `{"error":"image too large"}`（size 校验先于 MIME，§4.1 ④）。
- **需求回链**：1.3。

### TC-A-07 svg 图 → 400 unsupported image type
- **前置**：`d1 "DELETE FROM feedback;"`。
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" -X POST "$WORKER/api/feedback" \
    -F 'content=带svg' -F 'image=@/tmp/fb-test/test.svg;type=image/svg+xml'
  jq . /tmp/fb-test/out.json
  ```
- **期望**：HTTP `400`，body `{"error":"unsupported image type"}`（白名单 {jpeg,png,webp,gif}，显式禁 svg，§2 / 决策 4）。
- **需求回链**：1.3 / 2.1（防脚本注入）。

### TC-A-08 非图（txt）→ 400 unsupported image type
- **前置**：`d1 "DELETE FROM feedback;"`。
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" -X POST "$WORKER/api/feedback" \
    -F 'content=带txt' -F 'image=@/tmp/fb-test/test.txt;type=text/plain'
  jq . /tmp/fb-test/out.json
  ```
- **期望**：HTTP `400`，body `{"error":"unsupported image type"}`。
- **需求回链**：1.3。

### TC-A-09 带合法图提交成功 + /r/ 取回 content-type 正确
- **前置**：`d1 "DELETE FROM feedback;"`。
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" -X POST "$WORKER/api/feedback" \
    -F 'content=带合法jpg' -F 'image=@/tmp/fb-test/small.jpg;type=image/jpeg'
  jq . /tmp/fb-test/out.json
  # 取 image_key
  d1 "SELECT id, image_key FROM feedback ORDER BY id DESC LIMIT 1;"
  # 用 image_key 反代取回（把 <KEY> 换成上面查到的 feedback/<sha256>.jpg）
  curl -sS -I -A "$UA" "$WORKER/r/<KEY>"
  ```
- **期望**：
  1. 提交 HTTP `200`、`ok:true`。
  2. DB `image_key` 形如 `feedback/<64位十六进制>.jpg`（§2 R2 key 规则）。
  3. `GET /r/<image_key>` HTTP `200`，响应头 `Content-Type: image/jpeg`（§4.1 put httpMetadata.contentType）。
- **需求回链**：1.3 / 2.1。

### TC-A-10 device 非法 JSON → 静默忽略、不报错
- **前置**：`d1 "DELETE FROM feedback;"`。
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" -X POST "$WORKER/api/feedback" \
    -F 'content=device非法' -F 'device=not-a-json{{{'
  jq . /tmp/fb-test/out.json
  d1 "SELECT id, device_info FROM feedback ORDER BY id DESC LIMIT 1;"
  ```
- **期望**：HTTP `200`、`ok:true`（非法 device 不报错，§4.1 ⑤）；`device_info` 里 client 段为 null（server 段仍含 ip/ua/country/colo/asn 之一，或整列可为仅 server），**绝不** 400。
- **需求回链**：2.1。

### TC-A-11 mine 结构与排序
- **前置**：`d1 "DELETE FROM feedback_replies; DELETE FROM feedback;"`；以甲身份提交 2 条（间隔可忽略），记第二条 id = `FB2`；对**第一条**（较早）用 admin 回复 1 条（见 TC-A-17 的 reply 命令，或此处直接 `POST /api/admin/feedback/<FB1>/reply`）。
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" "$WORKER/api/feedback/mine"
  jq . /tmp/fb-test/out.json
  ```
- **期望**（§4.1 mine 契约）：
  - HTTP `200`，`ok:true`，含 `unread_count`（此时 = 1，那条回复未读）。
  - `items` 按 `created_at` **DESC**（最新在前，即 FB2 在 FB1 之前），最多 50 条。
  - 每个 item 含 `id / content / image_url / created_at / replies`；无图时 `image_url` 为 `null`。
  - FB1 的 `replies` 按 `created_at` **ASC**；reply 含 `id / content / image_url / created_at / read_at`，未读时 `read_at` 为 `null`。
- **需求回链**：2.4。

### TC-A-12 跨用户隔离（甲看不到乙的反馈）
- **前置**：`d1 "DELETE FROM feedback;"`；以**乙**（`Cookie: xlist_sid=$SID_B`）提交 1 条「乙的私密反馈」。
- **步骤**：
  ```bash
  # 甲拉 mine
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" "$WORKER/api/feedback/mine"
  jq '.items[].content' /tmp/fb-test/out.json
  ```
- **期望**：甲的 `items` 中**不含**「乙的私密反馈」（mine 只返回 `user_id = auth.userId` 的行，§7 归属校验）。
- **需求回链**：2.2 / 2.4（账号维度隔离）。

### TC-A-13 admin list — q 三路匹配
- **前置**：`d1 "DELETE FROM feedback;"`；甲提交 1 条、乙提交 1 条（各含可识别文案）。
- **步骤**（分别用 user_id / display_name / identity 查甲）：
  ```bash
  # ① user_id 精确
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
    "$WORKER/api/admin/feedback?q=u_test_jia"
  jq '{total, ids:[.items[].user_id]}' /tmp/fb-test/out.json
  # ② display_name 模糊
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
    "$WORKER/api/admin/feedback?q=$(python3 -c "import urllib.parse;print(urllib.parse.quote('测试用户甲'))")"
  jq '{total, ids:[.items[].user_id]}' /tmp/fb-test/out.json
  # ③ identity 模糊（甲手机号片段）
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
    "$WORKER/api/admin/feedback?q=138001"
  jq '{total, ids:[.items[].user_id]}' /tmp/fb-test/out.json
  ```
- **期望**：三次均 HTTP `200`；结果集只含 `u_test_jia`（不含乙）。契约字段齐全：`items[]` 含 `id, user_id, display_name, identity, content, image_url, created_at, reply_count, last_reply_at`；`identity` 形如 `phone:13800138000`（首个在用 identity 的 `provider:identity_value`，§4.2）。**不含** `device_info`（列表不带，§4.2）。
- **需求回链**：2.2（按账号查某用户全部历史）。

### TC-A-14 admin list — status 过滤
- **前置**：`d1 "DELETE FROM feedback_replies; DELETE FROM feedback;"`；甲提交 2 条，其中 1 条走 admin reply（使其 `last_reply_at` 非空）。
- **步骤**：
  ```bash
  for S in all pending replied; do
    echo "== status=$S =="
    curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
      "$WORKER/api/admin/feedback?status=$S"
    jq '{total, rows:[.items[]|{id,last_reply_at}]}' /tmp/fb-test/out.json
  done
  ```
- **期望**：`all` 返回 2 条；`pending` 只返回 `last_reply_at IS NULL` 的 1 条；`replied` 只返回 `last_reply_at` 非空的 1 条（§4.2 status 语义）。
- **需求回链**：2.2 / 2.3。

### TC-A-15 admin list — 分页
- **前置**：`d1 "DELETE FROM feedback;"`；用直插造 25 条：
  ```bash
  d1 "WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<25) INSERT INTO feedback(user_id,content,day,created_at) SELECT 'u_test_jia','批量'||n,'2026-07-05', 1751000000000+n FROM c;"
  ```
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
    "$WORKER/api/admin/feedback?page=1&page_size=20"
  jq '{total,page,page_size,count:(.items|length), first:.items[0].content}' /tmp/fb-test/out.json
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
    "$WORKER/api/admin/feedback?page=2&page_size=20"
  jq '{page,count:(.items|length)}' /tmp/fb-test/out.json
  # 上限测试
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
    "$WORKER/api/admin/feedback?page=1&page_size=500"
  jq '.page_size' /tmp/fb-test/out.json
  ```
- **期望**：`total=25`；page1 返回 20 条、page2 返回 5 条；`page` 从 1 起；`page_size=500` 时服务端夹到 `100`（默认 20 / 上限 100，§4.2）；排序 `created_at DESC`（page1 首条为最新 `批量25`）。
- **需求回链**：2.2。

### TC-A-16 admin detail — 不存在 id → 404
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
    "$WORKER/api/admin/feedback/99999999"
  jq . /tmp/fb-test/out.json
  ```
- **期望**：HTTP `404`，body `{"error":"not found"}`（§4.2 detail）。
- **需求回链**：2.2。

### TC-A-17 admin reply 成功 → last_reply_at 更新 + unread 1→read→0
- **前置**：`d1 "DELETE FROM feedback_replies; DELETE FROM feedback;"`；甲提交 1 条，记 id = `FB`。
- **步骤**：
  ```bash
  # 回复前 unread=0
  curl -sS -A "$UA" -H "Cookie: xlist_sid=$SID_A" "$WORKER/api/feedback/unread-count" | jq .
  # admin 图文回复
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
    -X POST "$WORKER/api/admin/feedback/$FB/reply" \
    -F 'content=已收到，正在处理' -F 'image=@/tmp/fb-test/small.jpg;type=image/jpeg'
  jq . /tmp/fb-test/out.json
  d1 "SELECT id,last_reply_at FROM feedback WHERE id=$FB;"
  # 回复后 unread=1
  curl -sS -A "$UA" -H "Cookie: xlist_sid=$SID_A" "$WORKER/api/feedback/unread-count" | jq .
  # 标记已读
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" -X POST "$WORKER/api/feedback/read"
  jq . /tmp/fb-test/out.json
  # 再查 unread=0
  curl -sS -A "$UA" -H "Cookie: xlist_sid=$SID_A" "$WORKER/api/feedback/unread-count" | jq .
  ```
- **期望**：
  1. reply HTTP `200`、`ok:true`、返回 `id`（reply id）+ `created_at`。
  2. `feedback.last_reply_at` 由 NULL 变为该回复的 ms 时间戳（§4.2 reply 副作用）。
  3. unread-count：回复前 `count:0` → 回复后 `count:1`（§4.1）。
  4. `POST /read` 返回 `{"ok":true,"marked":1}`；之后 unread-count 回到 `count:0`。
  5. reply 的 `admin_email` 在本地 Basic 兜底下为 **NULL**（无 CF Access JWT，§4.2）——可 `d1 "SELECT admin_email FROM feedback_replies WHERE feedback_id=$FB;"` 验证。
- **需求回链**：2.3 / 2.4。

---

## 3. TC-S — 安全（curl，6 条）

### TC-S-01 admin 三端点无凭据 → 401
- **步骤**（均**不带** `-u`）：
  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' -A "$UA" "$WORKER/api/admin/feedback"
  curl -sS -o /dev/null -w '%{http_code}\n' -A "$UA" "$WORKER/api/admin/feedback/1"
  curl -sS -o /dev/null -w '%{http_code}\n' -A "$UA" -X POST "$WORKER/api/admin/feedback/1/reply" -F 'content=x'
  ```
- **期望**：三条均 HTTP `401`（`requireAuth` 首行拦截，§2 / admin.ts:114）；响应带 `WWW-Authenticate: Basic ...` 头（Basic 兜底模式）。
- **需求回链**：2.2 / 2.3（后台鉴权）。

### TC-S-02 C 端 session 不能调 admin 端点
- **步骤**（带 C 端 cookie、**不带** admin Basic）：
  ```bash
  curl -sS -o /dev/null -w '%{http_code}\n' -A "$UA" -H "Cookie: xlist_sid=$SID_A" "$WORKER/api/admin/feedback"
  curl -sS -o /dev/null -w '%{http_code}\n' -A "$UA" -H "Authorization: Bearer $SID_A" "$WORKER/api/admin/feedback"
  ```
- **期望**：均 HTTP `401`（C 端 session 不是 admin 凭据；`checkAdminAuth` 要 CF Access JWT 或 Basic，session cookie/Bearer 都不满足）。
- **需求回链**：2.2（权限隔离）。

### TC-S-03 LIKE 通配注入 q=`%` 不导致全表泄漏
- **前置**：`d1 "DELETE FROM feedback;"`；甲、乙各提交 1 条。
- **步骤**：
  ```bash
  # q 为单个 %（LIKE 通配符）——若未转义，%display_name LIKE '%%'% 会命中所有行
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
    "$WORKER/api/admin/feedback?q=%25"
  jq '{total, ids:[.items[].user_id]}' /tmp/fb-test/out.json
  ```
- **期望**：HTTP `200`；`%` 被按**字面**匹配（转义 `\%`，§4.2 / §7 LIKE 转义），即返回「display_name 或 identity 里真的含 `%` 字符」的行 —— 甲乙都不含，故 `total=0`。**绝不**返回全部反馈。
- **补充**：另测 `q=_`（`%5F`）同理应字面匹配、不泛匹配。
- **需求回链**：2.2（防注入泄漏）。

### TC-S-04 XSS 存储型探针（后端存原文、UI 不执行）
- **前置**：`d1 "DELETE FROM feedback;"`。
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" \
    -H "Cookie: xlist_sid=$SID_A" -X POST "$WORKER/api/feedback" \
    -F 'content=<img src=x onerror=alert(1)>'
  jq '{ok,id}' /tmp/fb-test/out.json
  d1 "SELECT content FROM feedback ORDER BY id DESC LIMIT 1;"
  ```
- **期望**：
  1. 提交 `200`（后端不因含 HTML 而拒收，按原文存储）。
  2. DB `content` 精确为 `<img src=x onerror=alert(1)>`（原文，未被后端改写）。
  3. **渲染不执行**的断言在 UI 层：C 端见 TC-B-08 备注、admin 见 **TC-C-07**（admin 必须 `esc()` 转义，React 端自动转义）。
- **需求回链**：2.1 / 2.2（安全存证 + 转义）。

### TC-S-05 /r/ 图片 key 不可预测性
- **前置**：以甲提交两条**不同**图片各一（可用 small.jpg + 另一张；若只有一张图，改 content 不影响图 key —— 需两张内容不同的图）。
- **步骤**：
  ```bash
  d1 "SELECT id, image_key FROM feedback WHERE image_key IS NOT NULL ORDER BY id DESC LIMIT 5;"
  ```
- **期望 / 说明**：`image_key` = `feedback/<sha256>.<ext>`，sha256 由**图片内容**决定，非自增、非顺序、不可枚举（§2 / 决策 8）：相同内容图片 → 相同 key（content-addressed）；不同内容 → 完全不同的 64 位十六进制。攻击者无法通过遍历猜到他人图片。**此条为不可预测性说明 + 结构核对**，无需暴力枚举。
- **需求回链**：2.1（图片可读性模型）。

### TC-S-06 reply 对不存在的 feedback id → 404
- **步骤**：
  ```bash
  curl -sS -o /tmp/fb-test/out.json -w '%{http_code}\n' -A "$UA" -u admin:test123 \
    -X POST "$WORKER/api/admin/feedback/98765432/reply" -F 'content=回复一个不存在的反馈'
  jq . /tmp/fb-test/out.json
  ```
- **期望**：HTTP `404`，body `{"error":"not found"}`（§4.2 reply「404 反馈不存在」）；DB 不产生游离 reply（`d1 "SELECT COUNT(*) FROM feedback_replies WHERE feedback_id=98765432;"` = 0）。
- **需求回链**：2.3。

---

## 4. TC-B — C 端 UI（playwright headless 优先 / 手工备选，12 条）

> 起 vite dev（§1.8）+ worker（§1.2）。登录态注入见 §1.7。截图存 `$CLAUDE_JOB_DIR/tmp/`。
> **playwright 脚手架**（每条 `.mjs` 复用）：
> ```js
> import { chromium } from 'playwright';
> const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
> const WECHAT_UA  = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.30(0x18001e30) NetType/WIFI Language/zh_CN';
> const SID_A = 'sid-jia-000000000000000000000000';
> const browser = await chromium.launch();        // headless
> // 已登录：extraHTTPHeaders 强塞 cookie（§1.7 方式一，最稳）
> const ctx = await browser.newContext({ baseURL:'http://localhost:5173', userAgent:DESKTOP_UA, extraHTTPHeaders:{ Cookie:`xlist_sid=${SID_A}` } });
> const page = await ctx.newPage();
> ```
> 选择器一律**文案定位**：`getByText` / `getByRole('button',{name})` / `getByPlaceholder`。

### TC-B-01 未登录 → 无「用户反馈」入口
- **前置**：worker + vite dev 起；**不注入** cookie（context 不带 extraHTTPHeaders / addCookies）。
- **步骤**（playwright）：`page.goto('/')` → 打开 UserMenu（点头像/用户菜单触发器）→ 检查下拉；再 `page.goto('/settings')`。
- **期望**：UserMenu 下拉**无**「用户反馈」项；Settings「账号管理」下**无**反馈入口行（gating `user && !isWeChatBrowser()`，未登录 `user` 为空，§5.1）。
- **手工备选**：无痕窗口开 `localhost:5173`，展开头像菜单，确认无「用户反馈」。
- **需求回链**：1.2。

### TC-B-02 登录后 → 有「用户反馈」入口（两处）
- **前置**：注入甲登录态（§1.7 方式一）。
- **步骤**：`page.goto('/')` → 打开 UserMenu；再 `page.goto('/settings')`。
- **期望**：UserMenu 下拉出现「用户反馈」项（lucide `MessageSquare` 图标 SVG，非 emoji，样式对齐「账号设置」项）；Settings「账号管理」下出现同款入口行（§5.1）。点击「用户反馈」跳转 `/feedback` 且正常渲染表单。
- **需求回链**：1.2。

### TC-B-03 微信 UA → 无入口 + 直接访问 /feedback 重定向回 /
- **前置**：新建 context 时 `userAgent: WECHAT_UA`（含 `MicroMessenger`），并注入甲登录态：
  ```js
  const ctx = await browser.newContext({ baseURL:'http://localhost:5173', userAgent:WECHAT_UA, extraHTTPHeaders:{ Cookie:`xlist_sid=${SID_A}` } });
  ```
- **步骤**：① `page.goto('/')` 打开 UserMenu；② `page.goto('/feedback')` 后读 `page.url()`。
- **期望**：① 即便已登录，UserMenu / Settings **无**「用户反馈」入口（`isWeChatBrowser()` 为真，§5.1 / 需求 1.1）；② 直接访问 `/feedback` 被 `<Navigate to="/" replace>` 重定向，最终 `page.url()` 为站点根 `/`（§5.2）。
- **需求回链**：1.1。

### TC-B-04 空内容 → 提交按钮 disabled
- **前置**：甲登录态，`page.goto('/feedback')`。
- **步骤**：不输入任何内容，检查提交按钮（primary）`disabled`；在 textarea 输入纯空格后再检查；输入有效文字后再检查。
- **期望**：textarea 为空或纯空白（`content.trim()===''`）时提交按钮 `disabled`；输入非空文字后按钮可点（§5.3）。
- **需求回链**：1.3。

### TC-B-05 字数 counter
- **前置**：甲登录态，`/feedback`。
- **步骤**：向 textarea 输入 5 个字符（`page.getByPlaceholder('说说你遇到的问题或建议…').fill('你好世界！')`），读右下角 counter 文案。
- **期望**：counter 显示 `5/2000`（格式 `n/2000`，§5.3）；textarea `maxLength=2000`（输入超过 2000 被浏览器截断）。
- **需求回链**：1.3。

### TC-B-06 选图预览 / 移除
- **前置**：甲登录态，`/feedback`。
- **步骤**：点「添加图片（选填，最多 1 张）」按钮触发隐藏 `<input type=file>`，用 `page.setInputFiles('input[type=file]','/tmp/fb-test/small.jpg')` 选图；断言出现约 80px 缩略预览 + 右上 ✕（lucide `X`）；点 ✕ 移除，断言预览消失、可重新选择。
- **期望**：选中后显示缩略预览与移除按钮；点移除后预览消失（§5.3）。`accept` 属性为 `image/jpeg,image/png,image/webp,image/gif`。
- **需求回链**：1.3。

### TC-B-07 选图超限 / 类型不符 → 客户端 toast 文案逐字
- **前置**：甲登录态，`/feedback`。
- **步骤**：① `setInputFiles(... '/tmp/fb-test/big.jpg')`（>5MB）；② `setInputFiles(... '/tmp/fb-test/test.txt')`（类型不符）。分别捕获 toast 文案。
- **期望**：① toast 文案**逐字** `图片不能超过 5MB`；② toast 文案**逐字** `仅支持 jpg/png/webp/gif 图片`（§5.3 客户端预校验）。
- **需求回链**：1.3。

### TC-B-08 提交成功 → toast + 表单清空 + 列表出现
- **前置**：`d1 "DELETE FROM feedback;"`；甲登录态，`/feedback`。
- **步骤**：textarea 填「这是一条端到端反馈」→（可选加 small.jpg）→ 点提交（primary 按钮）；等待。
- **期望**：
  1. 成功 toast **逐字** `反馈已提交，感谢支持`（§5.4）。
  2. 表单清空（textarea 空、图片预览清除）。
  3. 「我的反馈」列表刷新，出现刚提交的卡片（内容 `whitespace-pre-wrap`、相对时间；有图则 h-20 缩略，点击 `<a target=_blank>` 开原图）。
  4. **XSS 不执行（承接 TC-S-04）**：若提交内容为 `<img src=x onerror=alert(1)>`，列表以纯文本展示、无 `alert`/无图片加载（React 自动转义）；可 `page.on('dialog')` 断言无对话框弹出。
- **需求回链**：1.3 / 2.4。

### TC-B-09 当日第 4 条 → 429 toast 逐字
- **前置**：`d1 "DELETE FROM feedback;"`；甲登录态，`/feedback`。用 UI 或 curl 先提交 3 条把当日额度用满（curl 更快：TC-A-02 的循环）。
- **步骤**：在 UI 填第 4 条内容 → 提交。
- **期望**：toast 文案**逐字** `操作太频繁了，稍后再试`（§2 / §5.4，429 → 该 toast）。**关键断言，不得转述、不得改标点**。表单内容保留（未清空，因未成功）。
- **需求回链**：1.2。

### TC-B-10 回复展示 + 「新」标记
- **前置**：`d1 "DELETE FROM feedback_replies; DELETE FROM feedback;"`；甲提交 1 条（curl 或 UI），admin 对其回复 1 条图文（curl TC-A-17 的 reply）。**注意先不要触发 read**。
- **步骤**：新 context（甲登录态）**首次** `page.goto('/feedback')`，读取该反馈卡片下的回复块。
- **期望**：回复以嵌套块展示：「官方回复」chip + 回复内容 + 可选图 + 时间；该回复因 `read_at===null` 标「新」红点（§5.5）。
- **需求回链**：2.4。

### TC-B-11 红点出现与清零
- **前置**：接 TC-B-10 状态（存在 1 条未读回复）；准备甲登录态的新 context。
- **步骤**：① 新 context `page.goto('/')`（不进 /feedback），auth hydrate 后应拉一次 `GET /api/feedback/unread-count`；打开 UserMenu，断言「用户反馈」入口右侧红点（`h-2 w-2 rounded-full bg-rose-500`）存在。② 同 page `goto('/feedback')`（mount 后 fire-and-forget `POST /api/feedback/read`）→ 返回 `/` 再开 UserMenu，断言红点消失。
- **期望**：未读 >0 时入口有红点；打开反馈页后本地未读清零、红点消失（§5.1 / §5.6 / §5.7；不得轮询）。
- **需求回链**：2.4。

### TC-B-12 刷新后已读持久
- **前置**：接 TC-B-11（已打开过 /feedback、已 read）。
- **步骤**：`page.reload()`（或新 context 重新进 `/feedback`）。
- **期望**：① 服务端已读持久 —— 新会话进入后 unread-count 为 0、UserMenu 无红点；② 同一次会话内本次打开时抓取到的 `read_at` 若仍为 null，当次可保留「新」标记，但**下一次访问**（reload/新 context）该回复不再标「新」（§5.6：渲染用拉取时的 read_at，本次可见、下次消失）。
- **需求回链**：2.4。

---

## 5. TC-C — Admin UI（playwright，8 条）

> admin 页由 worker 直出，无需 vite。playwright context 用 Basic Auth + 浏览器 UA：
> ```js
> const ctx = await browser.newContext({
>   httpCredentials: { username:'admin', password:'test123' },   // 自动应答 Basic 挑战（含页面内 fetch）
>   userAgent: DESKTOP_UA,
> });
> const page = await ctx.newPage();
> await page.goto('http://127.0.0.1:8787/admin/feedback');
> ```
> 手工备选：浏览器直接开 `http://admin:test123@127.0.0.1:8787/admin/feedback`。

### TC-C-01 nav 有「用户反馈」tab
- **前置**：打开任一 admin 页（如 `/admin/feedback`）。
- **步骤**：读顶部 nav。
- **期望**：nav 含 `💬 用户反馈` 项，指向 `/admin/feedback`（§6 / Task C：`adminNavHtml` 新增，沿用现有 emoji 前缀风格）。
- **需求回链**：2.2。

### TC-C-02 列表渲染
- **前置**：`d1 "DELETE FROM feedback;"`；甲、乙各提交 ≥1 条（含 1 条带图）。
- **步骤**：打开 `/admin/feedback`。
- **期望**：表格列齐全：ID / 时间 / 用户（display_name + identity 两行）/ 内容（截 80 字）/ 图片（有图则 40px 缩略）/ 回复数 / 最近回复 / 操作「查看」；底部分页控件「上一页 / 下一页」+ `共 N 条`（§6.2）。
- **需求回链**：2.2。

### TC-C-03 搜索按 user_id / identity 命中同一用户全部历史
- **前置**：`d1 "DELETE FROM feedback;"`；甲提交 3 条、乙提交 1 条。
- **步骤**：搜索框（placeholder `用户ID / 昵称 / 手机号 / 邮箱`）依次输入 `u_test_jia`、`13800138000`、`测试用户甲`，各点「查询」。
- **期望**：三种输入均只列出甲的**全部 3 条**历史反馈，不含乙（§6.5，服务端 §4.2 q 匹配覆盖）。
- **需求回链**：2.2（按账号查全部历史）。

### TC-C-04 status 过滤
- **前置**：甲 2 条，其一已 admin 回复。
- **步骤**：状态下拉切换「全部 / 未回复 / 已回复」，各点「查询」。
- **期望**：全部=2；未回复=只列 `last_reply_at IS NULL` 的 1 条；已回复=只列已回复的 1 条（§6.1 / §4.2）。
- **需求回链**：2.2 / 2.3。

### TC-C-05 详情：device_info / 账号快照展示
- **前置**：甲带 device 提交 1 条（device 用合法 JSON，如 `{"ua":"...","platform":"MacIntel","screen":{"w":390,"h":844}}`），记 id。
- **步骤**：列表该行点「查看」→ 页内详情区渲染。
- **期望**：详情区含完整内容、原图（若有，max-width 400px）、账号快照（display_name + identities）、`device_info` 以 `<pre>` 格式化 JSON 展示（含 client 前端上报 + server 侧 ip/ua/country/colo/asn）、回复线程（每条 admin_email / 时间 / 内容 / 图 / 用户已读状态）、底部回复表单（§6.3）。
- **需求回链**：2.1 / 2.2。

### TC-C-06 图文回复成功
- **前置**：甲 1 条，记 id；打开其详情。
- **步骤**：详情底部回复表单 textarea 填「后台图文回复测试」→ 文件选 `/tmp/fb-test/small.jpg` → 点「回复用户」。
- **期望**：回复成功后详情线程新增该回复（含图）、列表对应行「回复数」+1、「最近回复」时间更新（§6.3）；后端 `feedback.last_reply_at` 更新（可 `d1` 复核）。本地 Basic 下该 reply `admin_email` 为 NULL。
- **需求回链**：2.3。

### TC-C-07 XSS 转义（存储型探针在 admin 不执行）
- **前置**：甲提交 content = `<img src=x onerror=alert(1)>`（承接 TC-S-04；device 里也塞一个 `<script>alert(2)</script>` 字段值以验 device_info 转义）。
- **步骤**：`page.on('dialog', d=>{ throw new Error('XSS 弹窗:'+d.message()); })`；打开列表 + 该行详情。
- **期望**：content 与 device_info 内字段在 admin 页以**文本**展示（`&lt;img …&gt;`），**不触发** `alert`、不加载探针图（§6.4 所有用户内容经 `esc()`；图片 src 只允许 `/r/` 前缀）。断言无 dialog 抛出、页面 HTML 中出现转义实体而非可执行标签。
- **需求回链**：2.1 / 2.2。

### TC-C-08 分页
- **前置**：造 25 条（可复用 TC-A-15 的批量插入 SQL）。
- **步骤**：`/admin/feedback` 默认页 → 点「下一页」→ 点「上一页」。
- **期望**：默认每页 20 条、`共 25 条`；下一页显示剩余 5 条；上一页回到第 1 页 20 条；边界页按钮禁用/无更多（§6.2）。
- **需求回链**：2.2。

---

## 6. TC-I — 集成（3 条）

### TC-I-01 完整回环：提交 → admin 回复 → C 端红点 → 查看 → 已读
- **前置**：`d1 "DELETE FROM feedback_replies; DELETE FROM feedback;"`。
- **步骤**：
  1. C 端（甲登录态）在 `/feedback` 提交 1 条文字反馈 → 成功 toast、列表出现。
  2. admin（`/admin/feedback`）搜到该反馈 → 查看 → 图文回复。
  3. C 端新 context `goto('/')` → UserMenu 红点出现。
  4. C 端进 `/feedback` → 看到「官方回复」+「新」标记 → 触发已读。
  5. C 端返回 `/` 重开 UserMenu → 红点消失；`reload` 后仍无红点。
- **期望**：每一步现象符合 TC-B-08 / TC-C-06 / TC-B-11 / TC-B-10 / TC-B-12 的分解断言，端到端闭环成立（需求 2.3 → 2.4 全链路）。
- **需求回链**：2.1 / 2.2 / 2.3 / 2.4。

### TC-I-02 双反馈多回复，计数正确
- **前置**：`d1 "DELETE FROM feedback_replies; DELETE FROM feedback;"`；甲提交 2 条（FB1、FB2）。
- **步骤**：admin 对 FB1 回复 2 条、对 FB2 回复 1 条；C 端拉 `mine` 与 `unread-count`；admin 列表看 FB1/FB2 的「回复数」。
- **期望**：
  - admin 列表：FB1 回复数=2、FB2 回复数=1。
  - C 端 `unread-count`= 3（未读回复总数，跨两条反馈）。
  - `mine`：FB1.replies 长度 2 且按 `created_at ASC`、FB2.replies 长度 1；items 按 `created_at DESC`。
  - C 端 `POST /read` 后 `marked`=3、unread-count=0。
- **需求回链**：2.3 / 2.4。

### TC-I-03 图片全链路（C 传 → admin 看 → admin 回图 → C 看）
- **前置**：`d1 "DELETE FROM feedback;"`。
- **步骤**：
  1. C 端提交带 `small.jpg` 的反馈。
  2. admin 详情看到原图（`/r/feedback/<sha256>.jpg`，max-width 400px 正常渲染，非坏图）。
  3. admin 回复也带一张图（`small.jpg`）。
  4. C 端 `/feedback` 看到该回复的配图缩略、点击可开原图。
- **期望**：全链路图片可显示；两处 `image_url` 均为 `/r/feedback/...` 相对路径（C 端展示时按仓库 `/r/` 资产拼接 API_BASE / dev 走 vite proxy，§5.8）；`GET /r/<key>` content-type = `image/jpeg`（承接 TC-A-09）。
- **需求回链**：1.3 / 2.1 / 2.3 / 2.4。

---

## 7. 执行记录表（review agent 填写）

> 结果填 ✅PASS / ❌FAIL / ⚠️BLOCKED；证据填 curl 输出摘要 / 截图路径（`$CLAUDE_JOB_DIR/tmp/...`）/ DB 查询结果。

| 编号 | 标题 | 结果 | 证据 |
|------|------|------|------|
| TC-A-01 | 未登录 4 端点全 401 |  |  |
| TC-A-02 | 首条成功 + remaining 递减 |  |  |
| TC-A-03 | 第 4 条 429 rate_limited |  |  |
| TC-A-04 | content 空 400 content required |  |  |
| TC-A-05 | content 超长 400 content too long |  |  |
| TC-A-06 | 图片 >5MB 400 image too large |  |  |
| TC-A-07 | svg 400 unsupported image type |  |  |
| TC-A-08 | 非图 400 unsupported image type |  |  |
| TC-A-09 | 带图成功 + /r/ content-type |  |  |
| TC-A-10 | device 非法 JSON 不报错 |  |  |
| TC-A-11 | mine 结构与排序 |  |  |
| TC-A-12 | 跨用户隔离 |  |  |
| TC-A-13 | admin list q 三路匹配 |  |  |
| TC-A-14 | admin list status 过滤 |  |  |
| TC-A-15 | admin list 分页 |  |  |
| TC-A-16 | admin detail 404 |  |  |
| TC-A-17 | admin reply → last_reply_at + unread 1→read→0 |  |  |
| TC-S-01 | admin 三端点无凭据 401 |  |  |
| TC-S-02 | C 端不能调 admin 端点 |  |  |
| TC-S-03 | LIKE 通配注入 q=% 不泄漏 |  |  |
| TC-S-04 | XSS 存储探针后端存原文 |  |  |
| TC-S-05 | /r/ key 不可预测性 |  |  |
| TC-S-06 | reply 不存在 id 404 |  |  |
| TC-B-01 | 未登录无入口 |  |  |
| TC-B-02 | 登录后有入口（两处） |  |  |
| TC-B-03 | 微信 UA 无入口 + 重定向 |  |  |
| TC-B-04 | 空内容按钮 disabled |  |  |
| TC-B-05 | 字数 counter |  |  |
| TC-B-06 | 选图预览 / 移除 |  |  |
| TC-B-07 | 选图超限 / 类型提示文案 |  |  |
| TC-B-08 | 提交成功 toast + 清空 + 列表 |  |  |
| TC-B-09 | 第 4 条 429 toast 逐字 |  |  |
| TC-B-10 | 回复展示 + 「新」标记 |  |  |
| TC-B-11 | 红点出现与清零 |  |  |
| TC-B-12 | 刷新后已读持久 |  |  |
| TC-C-01 | nav 有 tab |  |  |
| TC-C-02 | 列表渲染 |  |  |
| TC-C-03 | 搜索命中同一用户全部历史 |  |  |
| TC-C-04 | status 过滤 |  |  |
| TC-C-05 | 详情 device_info / 账号快照 |  |  |
| TC-C-06 | 图文回复成功 |  |  |
| TC-C-07 | XSS 转义 |  |  |
| TC-C-08 | 分页 |  |  |
| TC-I-01 | 完整回环 |  |  |
| TC-I-02 | 双反馈多回复计数 |  |  |
| TC-I-03 | 图片全链路 |  |  |

---

## 附：关键逐字断言速查（不得转述/改标点）

| 场景 | 逐字文案 / 值 | 出处 |
|------|--------------|------|
| 429 toast（C 端） | `操作太频繁了，稍后再试` | §2 / §5.4 |
| 提交成功 toast | `反馈已提交，感谢支持` | §5.4 |
| 图片超限 toast | `图片不能超过 5MB` | §5.3 |
| 图片类型 toast | `仅支持 jpg/png/webp/gif 图片` | §5.3 |
| 其他错误 toast | `提交失败，请稍后再试` | §5.4 |
| textarea placeholder | `说说你遇到的问题或建议…` | §5.3 |
| 字数 counter 格式 | `n/2000` | §5.3 |
| 加图按钮 | `添加图片（选填，最多 1 张）` | §5.3 |
| 空态 | `还没有提交过反馈` | §5.5 |
| 回复 chip | `官方回复` | §5.5 |
| 未读标记 | `新` | §5.5 |
| admin 搜索框 placeholder | `用户ID / 昵称 / 手机号 / 邮箱` | §6.1 |
| admin nav | `💬 用户反馈` | §6 |
| admin 回复按钮 | `回复用户` | §6.3 |
| 错误码枚举（§4.1） | `not authenticated` / `rate_limited` / `content required` / `content too long` / `image too large` / `unsupported image type` | §4.1 |
