# PR1 实施计划：匿名访客 SDK + 完整 telemetry 上报

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 design doc 第 13 节 PR1 的完整范围 — Worker 端 events 表 + `/api/track` endpoint + CORS 扩展，Dashboard 端 telemetry SDK + 关键组件埋点，覆盖 design doc 3.5.2 中标记 PR1 的所有事件类型。

**Architecture:**
- **Worker**：复用现有 `corsHeaders` 模式（已在 index.ts:36），只扩展 Allow-Headers 加 `X-Device-Id`；新建 `track.ts` 模块（与 `enrich.ts` 平行）实现 POST `/api/track`，校验 event_type 白名单 + payload 大小，写入新建的 events 表
- **Dashboard**：新建 `dashboard/src/lib/telemetry/` 子目录，按职责拆分（device / queue / session / vitals / errors / impressions / beacon），提供统一 `track(event_type, payload)` 接口；fetch 拦截器自动注入 `X-Device-Id`；App.tsx init SDK 后在关键组件挂埋点
- **验证策略**：遵循项目惯例（CLAUDE.md「验证分层」）— Worker 用 `wrangler dev` + curl，Dashboard 用 `npm run build` + dev server 手动 smoke。**不引入 vitest 框架**（个人项目 YAGNI，与现有零测试惯例一致），关键 SDK 模块用 dev server 控制台输出验证

**Tech Stack:**
- Worker：TypeScript + Cloudflare Workers + D1 + wrangler
- Dashboard：TypeScript + React 19 + Vite + nanoid（新增）+ web-vitals（新增）
- 已有：`@cloudflare/workers-types`、`@types/react`、tailwindcss

**Branch:** `feat/telemetry-and-anonymous-id`（已从 main 出，含 design doc commit `266f667`）

**Worktree:** `/Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id`

**关联设计文档:** `/Users/roxor/brain/30-projects/aifeeds/docs/plans/2026-05-01-auth-system-design.md`

---

## File Structure

### 新建文件

**Worker 端**
- `worker/migrations/004-events-table.sql` — events 表 schema + 索引
- `worker/src/track.ts` — `/api/track` handler + event_type 白名单 + payload 校验

**Dashboard 端**
- `dashboard/src/lib/device.ts` — device_id SDK（LocalStorage UUID + sessionStorage 兜底）
- `dashboard/src/lib/telemetry/index.ts` — 统一 `track()` API + init
- `dashboard/src/lib/telemetry/types.ts` — TypeScript 类型定义
- `dashboard/src/lib/telemetry/event-types.ts` — event_type 常量 + payload 类型签名
- `dashboard/src/lib/telemetry/queue.ts` — 批量队列（10 条 / 5s）+ retry + LocalStorage 持久化
- `dashboard/src/lib/telemetry/session.ts` — 前端会话 token + 30min idle 过期 + start/end
- `dashboard/src/lib/telemetry/beacon.ts` — pagehide 用 sendBeacon flush 队列
- `dashboard/src/lib/telemetry/vitals.ts` — web-vitals 指标接入
- `dashboard/src/lib/telemetry/errors.ts` — global js_error / unhandledrejection / api_error
- `dashboard/src/lib/telemetry/impressions.ts` — IntersectionObserver helper（曝光 ≥ 1s）

### 修改文件

**Worker 端**
- `worker/src/index.ts` — 接入 `/api/track` 路由 + 扩展 CORS Allow-Headers
- `worker/schema.sql` — 全量 schema 加上 events 表（新部署用）

**Dashboard 端**
- `dashboard/package.json` — 加 `nanoid` + `web-vitals` 依赖
- `dashboard/src/api.ts` — fetch 拦截器统一注入 `X-Device-Id`，失败 emit `api_error`
- `dashboard/src/App.tsx` — init telemetry，发 `app_open / session_start`
- `dashboard/src/components/Feed.tsx` — `item_impression` + `source_filter_change` + `sort_change` + `new-content-banner_click`
- `dashboard/src/components/TweetCard.tsx` — `item_click` + `share_click` + `external_link_click`
- `dashboard/src/components/TweetDrawer.tsx` — `item_open_drawer` + `item_close_drawer`（带 dwell_ms）+ `thread_expand`
- `dashboard/src/components/Lightbox.tsx` — `image_lightbox_open`
- `dashboard/src/lib/utils.ts` — `proxyImg` onError → `image_load_error`

**文档**
- `docs/operations.md` — events 表 + `/api/track` 加入清单
- `TODO.md` — 不需要改（合 main 时同步过来）

---

## 阶段总览

| Phase | 内容 | Tasks |
|-------|------|-------|
| A | Worker backend | A1-A4 |
| B | Dashboard telemetry core | B1-B7 |
| C | Dashboard integration | C1-C5 |
| D | Component instrumentation | D1-D4 |
| E | Verification & ship | E1-E4 |

总 24 个 task，按依赖顺序串联。每个 task 一次小 commit。

---

## Phase A: Worker Backend

### Task A1: events 表迁移

**Files:**
- Create: `worker/migrations/004-events-table.sql`
- Modify: `worker/schema.sql`（追加 events 表定义到末尾）

- [ ] **Step 1: 写迁移文件 `worker/migrations/004-events-table.sql`**

```sql
-- PR1: events 表 — 完整产品行为 telemetry 落地点
-- 设计参考：docs/plans/2026-05-01-auth-system-design.md § 3.5

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  user_id TEXT,
  session_token_hash TEXT,
  event_type TEXT NOT NULL,
  event_payload TEXT,
  ip TEXT,
  ua TEXT,
  referer TEXT,
  page_path TEXT,
  occurred_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_did_time ON events(device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_path_time ON events(page_path, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_ingested ON events(ingested_at DESC);
```

- [ ] **Step 2: 把 events 表追加到 `worker/schema.sql` 末尾**

在 `worker/schema.sql` 文件末尾追加：

```sql

-- PR1: events 表 — 完整产品行为 telemetry 落地点
-- 详见 migrations/004-events-table.sql
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  user_id TEXT,
  session_token_hash TEXT,
  event_type TEXT NOT NULL,
  event_payload TEXT,
  ip TEXT,
  ua TEXT,
  referer TEXT,
  page_path TEXT,
  occurred_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_did_time ON events(device_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_user_time ON events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_path_time ON events(page_path, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_ingested ON events(ingested_at DESC);
```

- [ ] **Step 3: 本地应用迁移**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler d1 execute xlist --file=migrations/004-events-table.sql --local
```

期望输出：包含 `🌀 Executing on local database xlist` + `✓ Done`，无报错。

- [ ] **Step 4: 验证表已创建**

```bash
npx wrangler d1 execute xlist --command="SELECT name FROM sqlite_master WHERE type='table' AND name='events';" --local
```

期望输出：包含 `events` 这一行。

- [ ] **Step 5: 验证索引已创建**

```bash
npx wrangler d1 execute xlist --command="SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_events_%';" --local
```

期望输出：5 行索引名（idx_events_did_time / user_time / type_time / path_time / ingested）。

- [ ] **Step 6: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add worker/migrations/004-events-table.sql worker/schema.sql
git commit -m "$(cat <<'EOF'
feat(worker): events 表 schema (PR1 telemetry)

完整产品行为上报的统一落地点，覆盖导航/内容/筛选/分享/登录/性能/错误。
device_id NOT NULL（防协议爬虫 + 主键完整性），user_id 登录后才有。
5 个索引覆盖按 did/user/type/path/ingested 时间维度查询。

详见 docs/plans/2026-05-01-auth-system-design.md § 3.5

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A2: 扩展 CORS 允许 `X-Device-Id` header

**Files:**
- Modify: `worker/src/index.ts:36-46`（corsHeaders 函数）

- [ ] **Step 1: 修改 `corsHeaders` 函数允许 `X-Device-Id` header**

打开 `worker/src/index.ts`，找到第 43 行：

```typescript
'Access-Control-Allow-Headers': 'Content-Type, Authorization',
```

改为：

```typescript
'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Device-Id',
```

- [ ] **Step 2: typecheck 通过**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx tsc --noEmit
```

期望输出：无任何 error，命令静默退出（exit 0）。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add worker/src/index.ts
git commit -m "feat(worker): CORS 允许 X-Device-Id header

为 PR1 telemetry SDK 上报做准备。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task A3: 新建 `track.ts` handler

**Files:**
- Create: `worker/src/track.ts`

- [ ] **Step 1: 创建 `worker/src/track.ts`**

```typescript
// PR1 telemetry 上报 handler
// 设计：docs/plans/2026-05-01-auth-system-design.md § 9.2 + § 3.5

import type { Env } from './index';

// 与 dashboard/src/lib/telemetry/event-types.ts 保持一致
// 任一端新增事件类型时两边都要改
const EVENT_TYPE_WHITELIST = new Set<string>([
  // 导航
  'app_open', 'page_view', 'session_start', 'session_end',
  // 内容
  'item_impression', 'item_click', 'item_open_drawer', 'item_close_drawer',
  'thread_expand', 'image_lightbox_open', 'external_link_click',
  // 筛选
  'source_filter_change', 'sort_change', 'new_content_banner_click',
  // 分享
  'share_click', 'share_landing',
  // 登录（PR2/3 才会真发，但白名单提前留好）
  'login_modal_open', 'sms_send_attempt', 'sms_send_success',
  'code_verify_attempt', 'login_success', 'logout', 'account_delete',
  // 互动（PR5 才会真发）
  'favorite_toggle', 'subscribe_toggle',
  // 性能
  'perf_lcp', 'perf_inp', 'perf_cls', 'perf_ttfb',
  // 错误
  'js_error', 'unhandled_promise', 'api_error', 'image_load_error',
]);

const MAX_PAYLOAD_BYTES = 8 * 1024;     // 单条事件 payload ≤ 8KB
const MAX_BATCH_SIZE = 50;              // 单次请求最多 50 条事件
const MAX_BODY_BYTES = 256 * 1024;      // 请求 body 总大小 ≤ 256KB（防爆量）

interface ClientEvent {
  type: string;
  payload?: Record<string, unknown>;
  occurred_at: number;          // 客户端时间 (ms)
  page_path?: string;
}

interface TrackRequest {
  events: ClientEvent[];
  session_token_hash?: string;  // 前端 SDK 生成的会话 hash
}

export async function handleTrack(request: Request, env: Env): Promise<Response> {
  // 1. X-Device-Id 必填
  const deviceId = request.headers.get('X-Device-Id');
  if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
    return jsonError('missing or invalid X-Device-Id', 400);
  }

  // 2. body 大小限制
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonError('payload too large', 413);
  }

  // 3. 解析 JSON
  let body: TrackRequest;
  try {
    body = await request.json() as TrackRequest;
  } catch {
    return jsonError('invalid json', 400);
  }

  if (!body || !Array.isArray(body.events)) {
    return jsonError('events[] required', 400);
  }
  if (body.events.length === 0 || body.events.length > MAX_BATCH_SIZE) {
    return jsonError(`events length must be 1..${MAX_BATCH_SIZE}`, 400);
  }

  // 4. 抽出 IP / UA / Referer (从请求 headers)
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
  const ua = request.headers.get('User-Agent') || '';
  const referer = request.headers.get('Referer') || '';
  const ingestedAt = Date.now();

  // 5. 校验 + 写入
  const stmts: D1PreparedStatement[] = [];
  const errors: string[] = [];

  for (let i = 0; i < body.events.length; i++) {
    const e = body.events[i];

    if (typeof e.type !== 'string' || !EVENT_TYPE_WHITELIST.has(e.type)) {
      errors.push(`events[${i}].type invalid: ${e.type}`);
      continue;
    }
    if (typeof e.occurred_at !== 'number' || e.occurred_at <= 0) {
      errors.push(`events[${i}].occurred_at invalid`);
      continue;
    }

    const payloadStr = e.payload ? JSON.stringify(e.payload) : null;
    if (payloadStr && payloadStr.length > MAX_PAYLOAD_BYTES) {
      errors.push(`events[${i}].payload too large`);
      continue;
    }

    stmts.push(
      env.DB.prepare(`
        INSERT INTO events
          (device_id, session_token_hash, event_type, event_payload,
           ip, ua, referer, page_path, occurred_at, ingested_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        deviceId,
        body.session_token_hash || null,
        e.type,
        payloadStr,
        ip,
        ua,
        referer,
        e.page_path || null,
        e.occurred_at,
        ingestedAt,
      ),
    );
  }

  if (stmts.length === 0) {
    return jsonError('no valid events', 400, { errors });
  }

  // 6. batch 写入
  await env.DB.batch(stmts);

  return jsonOk({ accepted: stmts.length, rejected: errors.length, errors: errors.length ? errors : undefined });
}

function jsonOk(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonError(message: string, status: number, extra?: Record<string, unknown>): Response {
  return new Response(JSON.stringify({ error: message, ...extra }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

- [ ] **Step 2: typecheck 通过**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx tsc --noEmit
```

期望：无 error。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add worker/src/track.ts
git commit -m "$(cat <<'EOF'
feat(worker): track.ts handler 接收 telemetry 事件

校验逻辑：X-Device-Id 必填 + event_type 白名单 + payload ≤ 8KB
+ 单次最多 50 条 + 总 body ≤ 256KB。
batch INSERT 写入 events 表。返回 accepted / rejected 计数。

事件白名单与 dashboard/src/lib/telemetry/event-types.ts 必须一致。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task A4: 路由接入 + 端到端 curl 验证

**Files:**
- Modify: `worker/src/index.ts`（加 import + 加路由）

- [ ] **Step 1: 在 `worker/src/index.ts` 顶部 import**

第 12 行 `} from './enrich';` 之后加一行：

```typescript
import { handleTrack } from './track';
```

- [ ] **Step 2: 加路由**

在 `worker/src/index.ts` 路由表（约第 88-93 行 `if (path === '/api/longform/submit'` 之前）加：

```typescript
      if (path === '/api/track' && request.method === 'POST') {
        const resp = await handleTrack(request, env);
        // 给响应加 CORS headers（与其他 endpoint 一致）
        const newHeaders = new Headers(resp.headers);
        for (const [k, v] of Object.entries(corsHeaders(request, env))) {
          newHeaders.set(k, v);
        }
        return new Response(resp.body, { status: resp.status, headers: newHeaders });
      }
```

- [ ] **Step 3: typecheck**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx tsc --noEmit
```

期望：无 error。

- [ ] **Step 4: 启动本地 wrangler dev**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler dev --local --port 8788
```

后台运行，等到看到 `Ready on http://localhost:8788` 后再继续。

> 提示：用 `run_in_background: true` 启动，或者另开一个终端 tab。

- [ ] **Step 5: curl 验证矩阵 — 缺 X-Device-Id 应 400**

```bash
curl -i -X POST http://localhost:8788/api/track \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"app_open","occurred_at":1714579200000}]}'
```

期望：HTTP 400，body 含 `"error":"missing or invalid X-Device-Id"`。

- [ ] **Step 6: curl 验证矩阵 — 非法 event_type 应被拒**

```bash
curl -i -X POST http://localhost:8788/api/track \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: test-device-12345" \
  -d '{"events":[{"type":"hacked","occurred_at":1714579200000}]}'
```

期望：HTTP 400，body 含 `"error":"no valid events"` + errors 数组含 `events[0].type invalid: hacked`。

- [ ] **Step 7: curl 验证矩阵 — 合法 batch 应 200 + accepted=2**

```bash
curl -i -X POST http://localhost:8788/api/track \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: test-device-12345" \
  -d '{"events":[{"type":"app_open","occurred_at":1714579200000,"payload":{"utm":"test"}},{"type":"page_view","occurred_at":1714579201000,"page_path":"/"}]}'
```

期望：HTTP 200，body 含 `"accepted":2,"rejected":0`。

- [ ] **Step 8: 验证 events 表已落数据**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler d1 execute xlist --command="SELECT event_type, device_id, page_path, occurred_at FROM events ORDER BY id DESC LIMIT 5;" --local
```

期望：看到 `app_open` 和 `page_view` 两行，device_id = `test-device-12345`。

- [ ] **Step 9: curl 验证矩阵 — 超大 batch 应 400**

```bash
# 51 条事件
EVENTS=$(node -e "console.log(JSON.stringify({events:Array.from({length:51},(_,i)=>({type:'page_view',occurred_at:Date.now()+i}))}))")
curl -i -X POST http://localhost:8788/api/track \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: test-device-12345" \
  -d "$EVENTS"
```

期望：HTTP 400，body 含 `events length must be 1..50`。

- [ ] **Step 10: 关闭 wrangler dev（如在前台），Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add worker/src/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): wire /api/track 路由

POST /api/track → handleTrack，CORS headers 与其他 endpoint 一致。
本地 curl 矩阵验证：缺 did 400 / 非法 type 400 / 合法 batch 200 +
落 events 表 / 超大 batch 400 全部通过。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase B: Dashboard Telemetry Core

### Task B1: 加依赖

**Files:**
- Modify: `dashboard/package.json`

- [ ] **Step 1: 安装 `nanoid` + `web-vitals`**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm install nanoid web-vitals
```

期望输出：成功安装，无 peer dependency 警告。

- [ ] **Step 2: 验证 build 仍通过**

```bash
npm run build
```

期望：构建成功，bundle size 与之前接近（应 ≤ 280KB gzip 87KB），无 error。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/package.json dashboard/package-lock.json
git commit -m "chore(dashboard): 加 nanoid + web-vitals 依赖

PR1 telemetry SDK 用 nanoid 生成 device_id / session_token，
web-vitals 接 LCP/INP/CLS/TTFB 性能指标。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B2: device.ts SDK

**Files:**
- Create: `dashboard/src/lib/device.ts`

- [ ] **Step 1: 创建 `dashboard/src/lib/device.ts`**

```typescript
// device_id SDK — LocalStorage UUID（合规优先，非指纹方案）
// 设计：docs/plans/2026-05-01-auth-system-design.md § 5

import { nanoid } from 'nanoid';

const DID_KEY = 'xlist_did';
const DID_LEN = 21;        // nanoid 默认 21 字符，碰撞概率可忽略
const SESSION_DID_PREFIX = 's_';

let cachedDid: string | null = null;

/**
 * 获取持久 device_id。
 * 优先 LocalStorage（首访生成 nanoid 21 字符）。
 * Safari 隐身 / LocalStorage 不可用时退化到 sessionStorage（id 带 s_ 前缀，标记为短命）。
 */
export function getDeviceId(): string {
  if (cachedDid) return cachedDid;

  try {
    let did = localStorage.getItem(DID_KEY);
    if (!did) {
      did = nanoid(DID_LEN);
      localStorage.setItem(DID_KEY, did);
    }
    cachedDid = did;
    return did;
  } catch {
    return getOrCreateSessionDid();
  }
}

function getOrCreateSessionDid(): string {
  try {
    let did = sessionStorage.getItem(DID_KEY);
    if (!did) {
      did = `${SESSION_DID_PREFIX}${nanoid(DID_LEN - SESSION_DID_PREFIX.length)}`;
      sessionStorage.setItem(DID_KEY, did);
    }
    cachedDid = did;
    return did;
  } catch {
    // 极端情况下两个 Storage 都不可用，生成内存 only id（关闭 tab 即丢）
    if (!cachedDid) cachedDid = `${SESSION_DID_PREFIX}${nanoid(DID_LEN - SESSION_DID_PREFIX.length)}`;
    return cachedDid;
  }
}

/**
 * 重置 device_id（用户在设置页主动清除时调用）。
 * 清 LocalStorage + sessionStorage + 内存缓存。
 */
export function resetDeviceId(): void {
  cachedDid = null;
  try { localStorage.removeItem(DID_KEY); } catch {}
  try { sessionStorage.removeItem(DID_KEY); } catch {}
}

/** 是否为 sessionStorage 兜底生成的临时 id（用于 telemetry 区分） */
export function isSessionOnlyDid(did: string): boolean {
  return did.startsWith(SESSION_DID_PREFIX);
}
```

- [ ] **Step 2: typecheck 通过**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：构建成功，无 error。

- [ ] **Step 3: 浏览器手动 smoke 验证**

```bash
npm run dev
```

打开 http://localhost:5173，DevTools Console 输入：

```javascript
const { getDeviceId } = await import('/src/lib/device.ts');
const did = getDeviceId();
console.log('did:', did, 'len:', did.length);
console.log('LS:', localStorage.getItem('xlist_did'));
```

期望：
- `did` 是 21 字符
- `LS` 与 `did` 相同
- 第二次调用 `getDeviceId()` 返回同样的值

刷新页面后再调用 `getDeviceId()` 仍返回同一个值（持久化生效）。

- [ ] **Step 4: 关 dev server，Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/lib/device.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): device.ts — 匿名访客 ID SDK

LocalStorage UUID（nanoid 21 字符）方案。Safari 隐身模式或
LocalStorage 不可用时退化到 sessionStorage（id 带 s_ 前缀标记）。
两端都不可用时退到内存缓存。提供 resetDeviceId() 给设置页用。

合规：不读硬件信息，不形成"设备指纹"。详见 design doc § 5.2。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B3: telemetry types + event-types 常量

**Files:**
- Create: `dashboard/src/lib/telemetry/types.ts`
- Create: `dashboard/src/lib/telemetry/event-types.ts`

- [ ] **Step 1: 创建 `dashboard/src/lib/telemetry/types.ts`**

```typescript
// telemetry SDK 类型定义
// 设计：docs/plans/2026-05-01-auth-system-design.md § 3.5

export interface TelemetryEvent {
  type: string;
  payload?: Record<string, unknown>;
  occurred_at: number;
  page_path?: string;
}

export interface TrackRequestBody {
  events: TelemetryEvent[];
  session_token_hash?: string;
}

export interface TrackResponse {
  accepted: number;
  rejected: number;
  errors?: string[];
}

export type EventTypeName =
  // 导航
  | 'app_open' | 'page_view' | 'session_start' | 'session_end'
  // 内容
  | 'item_impression' | 'item_click' | 'item_open_drawer' | 'item_close_drawer'
  | 'thread_expand' | 'image_lightbox_open' | 'external_link_click'
  // 筛选
  | 'source_filter_change' | 'sort_change' | 'new_content_banner_click'
  // 分享
  | 'share_click' | 'share_landing'
  // 登录（PR2/3）
  | 'login_modal_open' | 'sms_send_attempt' | 'sms_send_success'
  | 'code_verify_attempt' | 'login_success' | 'logout' | 'account_delete'
  // 互动（PR5）
  | 'favorite_toggle' | 'subscribe_toggle'
  // 性能
  | 'perf_lcp' | 'perf_inp' | 'perf_cls' | 'perf_ttfb'
  // 错误
  | 'js_error' | 'unhandled_promise' | 'api_error' | 'image_load_error';
```

- [ ] **Step 2: 创建 `dashboard/src/lib/telemetry/event-types.ts`**

```typescript
// event_type 常量集中点。新增事件类型在这里加，Worker 端 track.ts 同步加。
// 设计：docs/plans/2026-05-01-auth-system-design.md § 3.5.2

import type { EventTypeName } from './types';

export const EVENTS = {
  // 导航
  APP_OPEN: 'app_open',
  PAGE_VIEW: 'page_view',
  SESSION_START: 'session_start',
  SESSION_END: 'session_end',
  // 内容
  ITEM_IMPRESSION: 'item_impression',
  ITEM_CLICK: 'item_click',
  ITEM_OPEN_DRAWER: 'item_open_drawer',
  ITEM_CLOSE_DRAWER: 'item_close_drawer',
  THREAD_EXPAND: 'thread_expand',
  IMAGE_LIGHTBOX_OPEN: 'image_lightbox_open',
  EXTERNAL_LINK_CLICK: 'external_link_click',
  // 筛选
  SOURCE_FILTER_CHANGE: 'source_filter_change',
  SORT_CHANGE: 'sort_change',
  NEW_CONTENT_BANNER_CLICK: 'new_content_banner_click',
  // 分享
  SHARE_CLICK: 'share_click',
  SHARE_LANDING: 'share_landing',
  // 登录（PR2/3）
  LOGIN_MODAL_OPEN: 'login_modal_open',
  SMS_SEND_ATTEMPT: 'sms_send_attempt',
  SMS_SEND_SUCCESS: 'sms_send_success',
  CODE_VERIFY_ATTEMPT: 'code_verify_attempt',
  LOGIN_SUCCESS: 'login_success',
  LOGOUT: 'logout',
  ACCOUNT_DELETE: 'account_delete',
  // 互动（PR5）
  FAVORITE_TOGGLE: 'favorite_toggle',
  SUBSCRIBE_TOGGLE: 'subscribe_toggle',
  // 性能
  PERF_LCP: 'perf_lcp',
  PERF_INP: 'perf_inp',
  PERF_CLS: 'perf_cls',
  PERF_TTFB: 'perf_ttfb',
  // 错误
  JS_ERROR: 'js_error',
  UNHANDLED_PROMISE: 'unhandled_promise',
  API_ERROR: 'api_error',
  IMAGE_LOAD_ERROR: 'image_load_error',
} as const satisfies Record<string, EventTypeName>;
```

- [ ] **Step 3: 验证 build 通过**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：构建成功，无 error。

- [ ] **Step 4: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/lib/telemetry/
git commit -m "$(cat <<'EOF'
feat(dashboard): telemetry types + event-types 常量

EventTypeName 类型与 worker/src/track.ts 白名单镜像。
EVENTS 常量集中所有事件名，避免散落的字符串拼写错。
satisfies 约束保证 EVENTS.* 必为合法 EventTypeName。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B4: queue.ts — 批量队列 + retry + 持久化

**Files:**
- Create: `dashboard/src/lib/telemetry/queue.ts`

- [ ] **Step 1: 创建 `dashboard/src/lib/telemetry/queue.ts`**

```typescript
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
```

- [ ] **Step 2: 验证 build 通过**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：构建成功。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/lib/telemetry/queue.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): telemetry/queue.ts — 批量队列 + retry + 持久化

触发：10 条或 5s 间隔。失败 3 次指数退避（1/4/16s），
重试用尽存 LocalStorage 等下次启动 flush。
flushSync 用 sendBeacon 走 keepalive，关 tab 不丢。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B5: beacon.ts — pagehide flush

**Files:**
- Create: `dashboard/src/lib/telemetry/beacon.ts`

- [ ] **Step 1: 创建 `dashboard/src/lib/telemetry/beacon.ts`**

```typescript
// pagehide / visibilitychange 时把队列 flush 出去
// iOS Safari 不会触发 unload，但会触发 pagehide

import { flushSync } from './queue';

export function installBeacon(): void {
  if (typeof window === 'undefined') return;

  // pagehide：关闭 tab、刷新、navigate 离开
  window.addEventListener('pagehide', () => {
    flushSync(true);
  });

  // visibilitychange → hidden：切到后台（移动端尤其常见）
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flushSync(true);
    }
  });
}
```

- [ ] **Step 2: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/lib/telemetry/beacon.ts
git commit -m "feat(dashboard): telemetry/beacon.ts — pagehide flush

监听 pagehide + visibilitychange→hidden，用 sendBeacon 把队列 flush 出。
iOS Safari 不触发 unload，pagehide 是唯一可靠时机。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task B6: session.ts — 前端会话生命周期

**Files:**
- Create: `dashboard/src/lib/telemetry/session.ts`

- [ ] **Step 1: 创建 `dashboard/src/lib/telemetry/session.ts`**

```typescript
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
```

- [ ] **Step 2: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/lib/telemetry/session.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): telemetry/session.ts — 前端会话生命周期

session_token 32 字符，与登录 session 无关。30 分钟 idle 续新。
session_start / session_end 通过回调触发，由 telemetry/index.ts 包装成事件。
session_token_hash（FNV-1a 32 位）写到 events.session_token_hash，
不暴露原 token。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task B7: telemetry/index.ts — 主 API

**Files:**
- Create: `dashboard/src/lib/telemetry/index.ts`

- [ ] **Step 1: 创建 `dashboard/src/lib/telemetry/index.ts`**

```typescript
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
```

- [ ] **Step 2: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/lib/telemetry/index.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): telemetry/index.ts — 主 API 整合

initTelemetry({ endpoint }) 一次初始化所有子系统。
track(type, payload) 上报事件，自动 touch session + 拼装 occurred_at + page_path。
session_start / session_end 由 session.ts 通过回调触发，
session_end 立即 flush 不等批量。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase C: Dashboard Integration

### Task C1: api.ts fetch 拦截器

**Files:**
- Modify: `dashboard/src/api.ts`

- [ ] **Step 1: 修改 `dashboard/src/api.ts` — 加 wrapped fetch 函数**

把现有 fetch 调用改为通过统一的 `apiFetch()` 走，自动注入 `X-Device-Id` 并在失败时上报 `api_error`。

修改 `dashboard/src/api.ts`：

```typescript
import type { Item, ItemsResponse, Source, SourceType, Stats } from "./types";
import { getDeviceId } from "./lib/device";
import { track, EVENTS } from "./lib/telemetry";

export interface ItemDetailResponse {
  item: Item;
  siblings: Item[];
}

export class ItemNotFoundError extends Error {
  constructor(id: string) {
    super(`item not found: ${id}`);
    this.name = "ItemNotFoundError";
  }
}

const API_BASE = (() => {
  if (import.meta.env.VITE_API_BASE) return import.meta.env.VITE_API_BASE;
  if (typeof window !== "undefined") {
    const host = window.location.hostname;
    if (host === "localhost" || host === "127.0.0.1") {
      return "http://localhost:8788";
    }
  }
  return "https://api.ai-feeds.com";
})();

export const TRACK_ENDPOINT = `${API_BASE}/api/track`;

/**
 * 统一 fetch 包装：自动注入 X-Device-Id，失败上报 api_error。
 * 业务 endpoint（/api/items / /api/sources 等）走这个；
 * /api/track 自身不能走（会循环），用原生 fetch。
 */
async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
  const headers = new Headers(init.headers);
  headers.set('X-Device-Id', getDeviceId());

  let res: Response;
  try {
    res = await fetch(url, { ...init, headers });
  } catch (e) {
    track(EVENTS.API_ERROR, {
      endpoint: path,
      status: 0,
      error_msg: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  if (!res.ok && res.status >= 400) {
    track(EVENTS.API_ERROR, {
      endpoint: path,
      status: res.status,
    });
  }
  return res;
}

export interface ItemsQuery {
  source_type?: SourceType | SourceType[];
  since?: string;
  until?: string;
  relevant?: 0 | 1;
  limit?: number;
  cursor?: string;
  sort?: "scraped_at" | "published_at" | "hot";
}

function buildQuery(params: Record<string, unknown>): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) {
      qs.set(k, v.join(","));
    } else {
      qs.set(k, String(v));
    }
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

export async function fetchItems(query: ItemsQuery = {}): Promise<ItemsResponse> {
  const path = `/api/items${buildQuery(query as Record<string, unknown>)}`;
  const res = await apiFetch(path);
  if (!res.ok) throw new Error(`fetchItems failed: ${res.status}`);
  return res.json();
}

export async function fetchSources(): Promise<Source[]> {
  const res = await apiFetch('/api/sources');
  if (!res.ok) throw new Error(`fetchSources failed: ${res.status}`);
  const data = await res.json();
  return data.sources || [];
}

export async function fetchItem(id: string): Promise<ItemDetailResponse> {
  const path = `/api/items/${encodeURIComponent(id)}`;
  const res = await apiFetch(path);
  if (res.status === 404) throw new ItemNotFoundError(id);
  if (!res.ok) throw new Error(`fetchItem failed: ${res.status}`);
  return res.json();
}

export async function fetchStats(): Promise<Stats> {
  const res = await apiFetch('/api/stats');
  if (!res.ok) throw new Error(`fetchStats failed: ${res.status}`);
  return res.json();
}
```

- [ ] **Step 2: build 通过**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/api.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): api.ts 加 fetch 拦截器

apiFetch() 统一注入 X-Device-Id header，失败时上报 api_error 事件
（含 endpoint / status / error_msg）。/api/track 不能走 apiFetch
避免循环依赖（telemetry queue 用原生 fetch 直接打）。

导出 TRACK_ENDPOINT 给 SDK 初始化用。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task C2: vitals.ts — web-vitals 接入

**Files:**
- Create: `dashboard/src/lib/telemetry/vitals.ts`

- [ ] **Step 1: 创建 `dashboard/src/lib/telemetry/vitals.ts`**

```typescript
// 性能指标接入：web-vitals 库捕获 LCP/INP/CLS/TTFB
// 设计：10% 采样上报（量大了再调）

import { onLCP, onINP, onCLS, onTTFB, type Metric } from 'web-vitals';
import { track } from './index';
import { EVENTS } from './event-types';

const SAMPLE_RATE = 0.1;  // 10%

export function installVitals(): void {
  // 每个 device_id 在初始化时决定是否采样（保持一致性，便于后续分析）
  if (Math.random() >= SAMPLE_RATE) return;

  onLCP(report(EVENTS.PERF_LCP));
  onINP(report(EVENTS.PERF_INP));
  onCLS(report(EVENTS.PERF_CLS));
  onTTFB(report(EVENTS.PERF_TTFB));
}

function report(eventType: string): (metric: Metric) => void {
  return (metric) => {
    track(eventType, {
      value: Math.round(metric.value * 100) / 100,
      rating: metric.rating,
      navigation_type: metric.navigationType,
    });
  };
}
```

- [ ] **Step 2: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/lib/telemetry/vitals.ts
git commit -m "feat(dashboard): telemetry/vitals.ts — web-vitals 性能指标

捕获 LCP/INP/CLS/TTFB，10% 采样上报。
metric value 保留 2 位小数，附带 rating 和 navigation_type。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task C3: errors.ts — 全局错误捕获

**Files:**
- Create: `dashboard/src/lib/telemetry/errors.ts`

- [ ] **Step 1: 创建 `dashboard/src/lib/telemetry/errors.ts`**

```typescript
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
```

- [ ] **Step 2: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/lib/telemetry/errors.ts
git commit -m "feat(dashboard): telemetry/errors.ts — 全局错误捕获

window.onerror 上报 js_error，unhandledrejection 上报 unhandled_promise。
stack 截前 10 行，message 截 500 字符避免 payload 爆。
跳过 image/script 加载错误（让 element 自己 onError 处理）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task C4: impressions.ts — IntersectionObserver helper

**Files:**
- Create: `dashboard/src/lib/telemetry/impressions.ts`

- [ ] **Step 1: 创建 `dashboard/src/lib/telemetry/impressions.ts`**

```typescript
// 卡片曝光埋点辅助 — IntersectionObserver
// 规则：
//   - 进入视口 ≥ 1s 才算 impression（防滚动飞掠误报）
//   - 同一 element 在同一会话只算一次

import { useEffect, useRef } from 'react';

const MIN_VISIBLE_MS = 1_000;
const VISIBLE_THRESHOLD = 0.5;  // 50% 进入视口才算可见

interface PendingObservation {
  element: Element;
  enteredAt: number;
  fired: boolean;
}

const pending = new WeakMap<Element, PendingObservation>();

let observer: IntersectionObserver | null = null;
let onImpressionCallback: ((el: Element) => void) | null = null;

function ensureObserver(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver(
    (entries) => {
      const now = Date.now();
      for (const entry of entries) {
        const state = pending.get(entry.target);
        if (!state) continue;
        if (state.fired) continue;

        if (entry.isIntersecting) {
          state.enteredAt = now;
          // 1s 后检查是否还在视口里
          setTimeout(() => {
            if (!state.fired && pending.get(entry.target) === state) {
              const stillIn = entry.target.getBoundingClientRect();
              const inViewport =
                stillIn.top < window.innerHeight && stillIn.bottom > 0;
              if (inViewport && Date.now() - state.enteredAt >= MIN_VISIBLE_MS) {
                state.fired = true;
                onImpressionCallback?.(entry.target);
              }
            }
          }, MIN_VISIBLE_MS);
        }
      }
    },
    { threshold: VISIBLE_THRESHOLD },
  );
  return observer;
}

export function setImpressionHandler(handler: (el: Element) => void): void {
  onImpressionCallback = handler;
}

/**
 * React hook — 监听 element 曝光。
 * 用法：
 *   const ref = useImpression(() => track(EVENTS.ITEM_IMPRESSION, { item_id }));
 *   return <article ref={ref}>...</article>;
 */
export function useImpression(onFire: () => void): React.RefCallback<Element> {
  const firedRef = useRef(false);
  const elRef = useRef<Element | null>(null);

  useEffect(() => {
    const ob = ensureObserver();
    return () => {
      if (elRef.current) ob.unobserve(elRef.current);
    };
  }, []);

  return (node) => {
    if (!node) {
      if (elRef.current) {
        ensureObserver().unobserve(elRef.current);
        pending.delete(elRef.current);
        elRef.current = null;
      }
      return;
    }
    if (elRef.current === node) return;
    if (firedRef.current) return;

    elRef.current = node;
    pending.set(node, {
      element: node,
      enteredAt: 0,
      fired: false,
    });
    setImpressionHandler((el) => {
      if (el === node && !firedRef.current) {
        firedRef.current = true;
        onFire();
      }
    });
    ensureObserver().observe(node);
  };
}
```

- [ ] **Step 2: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功。

- [ ] **Step 3: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/lib/telemetry/impressions.ts
git commit -m "feat(dashboard): telemetry/impressions.ts — IntersectionObserver helper

useImpression hook 监听 element ≥ 50% 进入视口持续 ≥ 1s 后触发回调。
同一 element 在同一组件实例只算一次。
单一 IntersectionObserver 全局复用（性能）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

### Task C5: App.tsx — init telemetry SDK + page_view 跟踪

**Files:**
- Modify: `dashboard/src/App.tsx`

- [ ] **Step 1: 修改 `dashboard/src/App.tsx`**

在 import 区域加：

```typescript
import { useEffect, useRef, useState } from "react";
import { Feed, type FeedHandle } from "./components/Feed";
import { TweetDrawer } from "./components/TweetDrawer";
import { DrawerProvider } from "./lib/drawer";
import { fetchSources, fetchStats, TRACK_ENDPOINT } from "./api";
import type { Source, SourceType, Stats } from "./types";
import { cn } from "./lib/utils";
import { useIsNarrow } from "./lib/breakpoint";
import { scrollFeedOrPage, smoothScrollWindowToTop } from "./lib/scroll";
import { initTelemetry, track, EVENTS } from "./lib/telemetry";
import { installVitals } from "./lib/telemetry/vitals";
import { installErrorHandlers } from "./lib/telemetry/errors";
```

在 `function App()` 内部，紧挨现有 `useEffect` 之后，加新的 init useEffect：

```typescript
  // Telemetry init（仅一次）
  useEffect(() => {
    initTelemetry({ endpoint: TRACK_ENDPOINT });
    installVitals();
    installErrorHandlers();
    track(EVENTS.APP_OPEN, {
      utm_source: new URLSearchParams(window.location.search).get('utm_source') || undefined,
      utm_campaign: new URLSearchParams(window.location.search).get('utm_campaign') || undefined,
      referrer: document.referrer || undefined,
    });
    track(EVENTS.PAGE_VIEW, {
      path: window.location.pathname + window.location.search,
    });
  }, []);
```

- [ ] **Step 2: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功。

- [ ] **Step 3: 端到端 dev server smoke**

启动 wrangler dev（worker）+ dashboard dev：

```bash
# 终端 1
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler dev --local --port 8788
```

```bash
# 终端 2
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run dev
```

打开 http://localhost:5173，DevTools Network 面板应看到至少一次 `POST /api/track` 请求，body 包含 `app_open` 和 `page_view` 事件。

- [ ] **Step 4: 验证 events 表有数据**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler d1 execute xlist --command="SELECT event_type, page_path, occurred_at FROM events WHERE device_id NOT LIKE 'test-%' ORDER BY id DESC LIMIT 10;" --local
```

期望：看到 `session_start` / `app_open` / `page_view` 事件，page_path = `/`。

- [ ] **Step 5: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): App.tsx wire telemetry SDK

启动时初始化 telemetry / vitals / errors，发 app_open + page_view。
app_open payload 含 utm_source / utm_campaign / referrer。
端到端验证：dev server 启动后 events 表落 session_start + app_open + page_view 三条。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase D: Component Instrumentation

### Task D1: Feed.tsx 排序/新内容埋点 + App.tsx chip 埋点

**Files:**
- Modify: `dashboard/src/components/Feed.tsx`（line 1 imports + line 460 SortSelector + line 472 banner button）
- Modify: `dashboard/src/App.tsx`（chip 切换 onClick）

> **范围说明**：item_impression（卡片曝光）放到 D2 在 TweetCard 内部挂，因为 ref 直接拿到 article 元素更简单。本 task 只做 Feed 内的 sort / banner 埋点 + App 的 chip 埋点。

- [ ] **Step 1: Feed.tsx 顶部加 import**

打开 `dashboard/src/components/Feed.tsx`，在现有 import 末尾追加（约 line 12-15 区域）：

```typescript
import { track, EVENTS } from "../lib/telemetry";
```

- [ ] **Step 2: 包装 SortSelector 的 onChange — `dashboard/src/components/Feed.tsx:460`**

把：

```typescript
            <SortSelector value={sortMode} onChange={setSortMode} />
```

改为：

```typescript
            <SortSelector
              value={sortMode}
              onChange={(next) => {
                if (next !== sortMode) {
                  track(EVENTS.SORT_CHANGE, { from: sortMode, to: next, source: sourceType });
                }
                setSortMode(next);
              }}
            />
```

- [ ] **Step 3: 包装新内容 banner 的 onClick — `dashboard/src/components/Feed.tsx:472`**

把：

```typescript
        <button
          type="button"
          onClick={showPending}
```

改为：

```typescript
        <button
          type="button"
          onClick={() => {
            track(EVENTS.NEW_CONTENT_BANNER_CLICK, { count_pending: pending.length, source: sourceType });
            showPending();
          }}
```

- [ ] **Step 4: App.tsx 加 chip 埋点**

打开 `dashboard/src/App.tsx`，找到 chip 切换的 onClick（约 line 125 区域）：

```typescript
                    onClick={() => {
                      if (isActive) {
                        // Tap active chip → scroll current Feed to top
                        scrollFeedOrPage(null);
                      } else {
                        setFilter(key);
                      }
                    }}
```

改为：

```typescript
                    onClick={() => {
                      if (isActive) {
                        scrollFeedOrPage(null);
                      } else {
                        track(EVENTS.SOURCE_FILTER_CHANGE, { from_id: storedFilter, to_id: key });
                        setFilter(key);
                      }
                    }}
```

- [ ] **Step 5: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功，无 error。

- [ ] **Step 6: dev smoke**

启动 wrangler dev + dashboard dev，操作：
1. 切换排序（如有 SortSelector 渲染）→ events 应有 `sort_change`
2. 在移动端宽度切 chip → events 应有 `source_filter_change`
3. 等有新推文进来或手动点新内容 banner → `new_content_banner_click`

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler d1 execute xlist --command="SELECT event_type, event_payload FROM events WHERE event_type IN ('sort_change','source_filter_change','new_content_banner_click') ORDER BY id DESC LIMIT 5;" --local
```

- [ ] **Step 7: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/components/Feed.tsx dashboard/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): Feed/App — 筛选/排序/新内容 banner 埋点

source_filter_change（App.tsx chip 切换）+
sort_change（Feed.tsx SortSelector onChange，含 source 维度）+
new_content_banner_click（Feed.tsx pending banner，含 count_pending）。
卡片曝光（item_impression）放到 D2 在 TweetCard 挂。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D2: TweetCard.tsx — 卡片 impression + click

**Files:**
- Modify: `dashboard/src/components/TweetCard.tsx`（顶部 import + article ref + handleCardClick 内加 track）

> **范围说明**：external_link_click 在 TweetDrawer.tsx（D3）做（"打开X原文"按钮在 drawer header）。share_click 当前 UI 没有分享按钮，前置 1 完成才有，本 PR 不实现，留 TODO。

- [ ] **Step 1: 读 TweetCard.tsx 找 handleCardClick 定义和 import 区**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
grep -n "^import\|handleCardClick\|function TweetCard\|export function TweetCard\|^export" dashboard/src/components/TweetCard.tsx | head -20
```

记下：
- import 区结束行号（用于 import 插入）
- `handleCardClick` 定义起止行（用于 track 注入）
- TweetCard 主函数名（function or const）

- [ ] **Step 2: 加 import**

在 TweetCard.tsx 现有 import 末尾追加：

```typescript
import { track, EVENTS } from "../lib/telemetry";
import { useImpression } from "../lib/telemetry/impressions";
```

- [ ] **Step 3: 在组件函数 body 顶部声明 impressionRef**

找到 `function TweetCard(...)` 主函数 body 的开头（在 hook 调用区），加：

```typescript
  const impressionRef = useImpression(() => {
    if (embedded) return; // drawer 内嵌套的卡片不算曝光
    track(EVENTS.ITEM_IMPRESSION, {
      item_id: item.id,
      source: item.source_type,
    });
  });
```

注意 `embedded` 是 TweetCard 现有的 prop（drawer 内复用 TweetCard 时传 true）；如果当前没这个 prop，请省略 `if (embedded) return;` 一行。

- [ ] **Step 4: 把 article 元素加上 impressionRef**

找到 `dashboard/src/components/TweetCard.tsx:247-249`：

```typescript
    <article
      onPointerDown={handlePointerDown}
      onClick={handleCardClick}
```

改为：

```typescript
    <article
      ref={impressionRef}
      onPointerDown={handlePointerDown}
      onClick={handleCardClick}
```

- [ ] **Step 5: 在 handleCardClick 函数中加 item_click**

`handleCardClick` 应该是个内联或外面的函数，里面调用 drawer 打开。grep 找到位置后，在 drawer 调用之前加：

```typescript
    track(EVENTS.ITEM_CLICK, {
      item_id: item.id,
      source: item.source_type,
    });
```

例如，如果 handleCardClick 形如：

```typescript
const handleCardClick = (e: React.MouseEvent) => {
  if (isPointerInteraction(e)) return;
  openDrawer(item.id);
};
```

改为：

```typescript
const handleCardClick = (e: React.MouseEvent) => {
  if (isPointerInteraction(e)) return;
  track(EVENTS.ITEM_CLICK, {
    item_id: item.id,
    source: item.source_type,
  });
  openDrawer(item.id);
};
```

如果 handleCardClick 不是简单返回 openDrawer 的形式，找到所有"非 stopPropagation 路径会触发 drawer 打开"的分支，每个分支前都加 track。

- [ ] **Step 6: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功，无 error。

- [ ] **Step 7: dev smoke**

启动 wrangler dev + dashboard dev，操作：
1. 滚动 feed → events 应有 `item_impression` 事件，每张卡片一条
2. 点击一张卡片 → events 应有 `item_click`

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler d1 execute xlist --command="SELECT event_type, json_extract(event_payload, '$.item_id') as iid, COUNT(*) as n FROM events WHERE event_type IN ('item_impression','item_click') GROUP BY event_type, iid ORDER BY n DESC LIMIT 10;" --local
```

期望：看到 ≥ 3 条不同 item_id 的 impression，至少 1 条 item_click。

- [ ] **Step 8: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/components/TweetCard.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): TweetCard — item_impression + item_click 埋点

useImpression 挂 article ref 监听 ≥ 50% 入视口 ≥ 1s 触发 item_impression。
embedded（drawer 内嵌 TweetCard）跳过曝光以免重复计数。
handleCardClick 在打开 drawer 前上报 item_click。

share_click 等"分享功能"实装后再加（前置 1 后续 TODO）。
external_link_click 由 D3（TweetDrawer "打开X原文"按钮）负责。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D3: TweetDrawer.tsx — open / close / dwell + external_link_click

**Files:**
- Modify: `dashboard/src/components/TweetDrawer.tsx`

> **范围说明**：thread_expand 当前 drawer UI 没有显式"展开 thread"按钮（thread 是自动展开的 threadMembers），暂不埋；前置 1 完成后如出现"展开全部祖先"按钮再加（PR-C 后续，留 TODO）。

- [ ] **Step 1: 加 import**

打开 `dashboard/src/components/TweetDrawer.tsx`，找到 line 1 附近的 `import { useEffect, useState } from "react";`，改为：

```typescript
import { useEffect, useRef, useState } from "react";
```

并在 import 区末尾加：

```typescript
import { track, EVENTS } from "../lib/telemetry";
```

- [ ] **Step 2: 在 TweetDrawer 主函数 body 顶部 hooks 区加 open/close 埋点**

找到 TweetDrawer 函数 body 的 hooks 区（应在 `return null;` 之前），加：

```typescript
  const openTimeRef = useRef<number>(0);
  useEffect(() => {
    if (!open || !item) return;
    openTimeRef.current = Date.now();
    track(EVENTS.ITEM_OPEN_DRAWER, {
      item_id: item.id,
      source: item.source_type,
    });
    const startedAt = openTimeRef.current;
    const itemId = item.id;
    return () => {
      track(EVENTS.ITEM_CLOSE_DRAWER, {
        item_id: itemId,
        dwell_ms: Date.now() - startedAt,
      });
    };
  }, [open, item?.id]);
```

> 注意：cleanup 闭包要 capture `itemId / startedAt` 局部变量副本，避免 React 重渲染导致 ref 已被 reset。

- [ ] **Step 3: "打开 X 原文" 链接加 onClick 上报 external_link_click**

找到 `dashboard/src/components/TweetDrawer.tsx:174-182`（"打开X原文"链接）：

```typescript
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-200"
                title="在 x.com 打开"
              >
                打开X原文 ↗
              </a>
```

改为：

```typescript
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => {
                  let host = "x.com";
                  try { host = new URL(item.url!).host; } catch {}
                  track(EVENTS.EXTERNAL_LINK_CLICK, {
                    item_id: item.id,
                    target_url_host: host,
                  });
                }}
                className="rounded-md px-2 py-1 text-xs text-neutral-600 hover:bg-neutral-200"
                title="在 x.com 打开"
              >
                打开X原文 ↗
              </a>
```

- [ ] **Step 4: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功。

- [ ] **Step 5: dev smoke**

启动 wrangler dev + dashboard dev，操作：
1. 点一张卡片 → drawer 打开 → events 应有 `item_open_drawer`
2. 在 drawer 停留 ≥ 5 秒
3. 关闭 drawer → events 应有 `item_close_drawer`，`dwell_ms ≥ 5000`
4. 重新打开 drawer → 点 "打开X原文 ↗" → events 应有 `external_link_click`，`target_url_host = 'x.com'`

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler d1 execute xlist --command="SELECT event_type, json_extract(event_payload, '$.dwell_ms') as dwell, json_extract(event_payload, '$.target_url_host') as host FROM events WHERE event_type IN ('item_open_drawer','item_close_drawer','external_link_click') ORDER BY id DESC LIMIT 6;" --local
```

- [ ] **Step 6: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/components/TweetDrawer.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): TweetDrawer — open/close/dwell + external_link_click

useEffect on (open, item.id) 上报 item_open_drawer，cleanup 上报
item_close_drawer 含 dwell_ms（capture 局部副本避免 React rerender 抖动）。
"打开X原文" 链接 onClick 上报 external_link_click（含 url host）。

thread_expand 等 PR-C 显式祖先展开按钮上线后再加（TODO）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task D4: Lightbox.tsx — image_lightbox_open + image_load_error

**Files:**
- Modify: `dashboard/src/components/Lightbox.tsx`

> **范围说明**：image_load_error 在 Lightbox 内 `<img>` 加 onError 即可（line 85-90）。其他用到 `proxyImg` 的位置（TweetCard 等）当前迭代不加，等真发现图片失败率有问题再扩散（YAGNI）。Lightbox.tsx 没有 itemId prop，本 PR 不做跨组件 refactor 添加，事件 payload 只带 image_index / images_count / url_host。

- [ ] **Step 1: 加 import**

打开 `dashboard/src/components/Lightbox.tsx`，line 1-3 现有：

```typescript
import { useEffect, useState } from "react";
import type { MediaItem } from "../types";
import { proxyImg } from "../lib/utils";
```

末尾追加一行：

```typescript
import { track, EVENTS } from "../lib/telemetry";
```

- [ ] **Step 2: 在组件 body 加 image_lightbox_open useEffect**

找到 `dashboard/src/components/Lightbox.tsx` 的现有 useEffect（line 14-23 `onKey` 那个）下方，再加一个 useEffect（mount 一次触发，不依赖 index）：

```typescript
  useEffect(() => {
    track(EVENTS.IMAGE_LIGHTBOX_OPEN, {
      image_index: startIndex,
      images_count: media.length,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
```

- [ ] **Step 3: 在 `<img>` 加 onError 上报**

找到 `dashboard/src/components/Lightbox.tsx:85-90`：

```typescript
      <img
        src={proxyImg(current.url)}
        alt={current.alt || ""}
        className="max-h-[90vh] max-w-[92vw] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
```

改为：

```typescript
      <img
        src={proxyImg(current.url)}
        alt={current.alt || ""}
        className="max-h-[90vh] max-w-[92vw] object-contain"
        onClick={(e) => e.stopPropagation()}
        onError={() => {
          let host = "";
          try { host = new URL(current.url).host; } catch {}
          track(EVENTS.IMAGE_LOAD_ERROR, {
            url_host: host,
            source: "lightbox",
          });
        }}
      />
```

- [ ] **Step 4: build**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功，无 error。

- [ ] **Step 5: dev smoke**

启动 wrangler dev + dashboard dev，操作：
1. 打开有图的卡片 → drawer → 点击图片放大 → Lightbox 打开 → events 应有 `image_lightbox_open`，含 `image_index` 和 `images_count`

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler d1 execute xlist --command="SELECT event_type, event_payload FROM events WHERE event_type IN ('image_lightbox_open','image_load_error') ORDER BY id DESC LIMIT 5;" --local
```

期望：每次打开 lightbox 一条 image_lightbox_open。

- [ ] **Step 6: Commit**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
git add dashboard/src/components/Lightbox.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): Lightbox — image_lightbox_open + image_load_error

mount useEffect 触发 image_lightbox_open（含 image_index / images_count）。
<img> onError 触发 image_load_error（含 url_host）。
其他 proxyImg 使用点暂不加，等真有图片失败率问题再扩散（YAGNI）。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Phase E: Verification & Ship

### Task E1: 端到端验证矩阵

**Files:** 无（仅运行 + 检查）

- [ ] **Step 1: 启动本地 stack**

```bash
# 终端 1
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler dev --local --port 8788
```

```bash
# 终端 2
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run dev
```

- [ ] **Step 2: 清空本地 events 表（用作干净基线）**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler d1 execute xlist --command="DELETE FROM events;" --local
```

- [ ] **Step 3: 跑完整交互矩阵**

打开 http://localhost:5173 + DevTools。依次执行：

1. 首访（自动）→ 期望 events 表有：`session_start`, `app_open`, `page_view`
2. 切移动端宽度 + chip 切换 → `source_filter_change`
3. 排序切换（如果 UI 有 sort 切换）→ `sort_change`
4. 滚动 feed 看到至少 3 条卡片 → ≥ 3 条 `item_impression`
5. 点击一条卡片 → `item_click` + `item_open_drawer`
6. 在 drawer 停留 5 秒 → 关闭 → `item_close_drawer`，`dwell_ms` ≥ 5000
7. 点击"打开 X 原文 ↗" → `external_link_click`
8. 打开有图的卡片 → 点开大图 → `image_lightbox_open`
9. 关闭 tab → pagehide 触发 → `session_end` 应被 sendBeacon 发出（重新打开页面后能查到）

- [ ] **Step 4: 验证 events 表完整性**

```bash
npx wrangler d1 execute xlist --command="SELECT event_type, COUNT(*) as n FROM events GROUP BY event_type ORDER BY n DESC;" --local
```

期望：覆盖至少 PR1 标记的 8 个核心事件类型，没有 NULL device_id 行。

- [ ] **Step 5: 验证 device_id 持久性**

DevTools Console：
```javascript
console.log('did:', localStorage.getItem('xlist_did'));
```
刷新页面 → 同样的 did → events 表新行的 device_id 应同。

- [ ] **Step 6: 验证错误捕获**

DevTools Console:
```javascript
throw new Error('test js_error from console');
```

```javascript
Promise.reject(new Error('test unhandled_promise'));
```

```bash
npx wrangler d1 execute xlist --command="SELECT event_type, json_extract(event_payload, '$.message') as msg FROM events WHERE event_type IN ('js_error','unhandled_promise') ORDER BY id DESC LIMIT 4;" --local
```

期望：两条事件都落库，message 含 'test js_error' / 'test unhandled_promise'。

- [ ] **Step 7: 关 dev server，无 commit（仅验证步骤）**

---

### Task E2: 部署 Worker（生产环境）

**Files:** 无源码改动

- [ ] **Step 1: 远端应用迁移**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler d1 execute xlist --file=migrations/004-events-table.sql --remote
```

期望：远端 D1 加上 events 表。

- [ ] **Step 2: 部署 worker**

```bash
npm run deploy
```

期望：成功，输出新 deploy 的 version id 和 endpoint URL。

- [ ] **Step 3: 远端 curl 验证 — 缺 X-Device-Id 应 400**

```bash
curl -i -X POST https://api.ai-feeds.com/api/track \
  -H "Content-Type: application/json" \
  -d '{"events":[{"type":"app_open","occurred_at":1714579200000}]}'
```

期望：HTTP 400。

- [ ] **Step 4: 远端 curl 验证 — 合法请求 200**

```bash
curl -i -X POST https://api.ai-feeds.com/api/track \
  -H "Content-Type: application/json" \
  -H "X-Device-Id: deploy-smoke-12345" \
  -d '{"events":[{"type":"app_open","occurred_at":'$(($(date +%s) * 1000))'}]}'
```

期望：HTTP 200，body `{"accepted":1,"rejected":0}`。

- [ ] **Step 5: 验证远端 events 表有数据**

```bash
npx wrangler d1 execute xlist --command="SELECT event_type, device_id, occurred_at FROM events WHERE device_id='deploy-smoke-12345';" --remote
```

期望：1 行 `app_open` 事件。

---

### Task E3: 部署 Dashboard

**Files:** 无源码改动

- [ ] **Step 1: 部署前 build 验证**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/dashboard
npm run build
```

期望：成功，bundle size 合理（应 ≤ 320KB JS gzip ≤ 100KB）。如超 350KB 检查 web-vitals 是否 tree-shake 正常。

- [ ] **Step 2: 部署 Pages**

```bash
npx wrangler pages deploy dist --project-name=xlist-dashboard
```

期望：成功，给出新 preview URL 和 production URL。

- [ ] **Step 3: 生产环境冒烟**

打开 https://ai-feeds.com 在 Chrome：
1. DevTools Network → 看到 `POST /api/track` 请求
2. Response 200，body `{"accepted":N,"rejected":0}`
3. 等 5 秒，再做几次交互（点卡片、切 chip），再次看到 track 请求

- [ ] **Step 4: 远端 events 表验证**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id/worker
npx wrangler d1 execute xlist --command="SELECT event_type, COUNT(*) FROM events WHERE ingested_at > $(($(date +%s) * 1000 - 600000)) GROUP BY event_type;" --remote
```

期望：最近 10 分钟有真实流量事件分布。

---

### Task E4: 文档同步 + 最终 commit

**Files:**
- Modify: `docs/operations.md`（运维清单加 events 表 + /api/track endpoint）

- [ ] **Step 1: 在 `docs/operations.md` 「Worker：xlist-api」endpoint 表中加一行 `/api/track`**

找到「端点清单」表格（line 60 附近），插入新行：

```markdown
| `/api/track` | POST | Dashboard telemetry 上报（必带 `X-Device-Id`） | 无（CORS 白名单+device_id 必填） |
```

- [ ] **Step 2: 在 `docs/operations.md` 「D1: xlist」表清单中加 `events`**

在「items / sources / run_stats / enrich_state / metrics_snapshots / refresh_log」后加 `events`。

可能需要补充一段子章节描述 events 表用途（参考 design doc § 3.5）。

简短示例：

```markdown
**events 表**：完整产品行为 telemetry 落地点，覆盖导航/内容/筛选/分享/性能/错误等。
- 写入：`POST /api/track`（前端 SDK）
- 索引：device_id / user_id / event_type / page_path / ingested_at
- cleanup：30 天前数据由后续 retention cron 清理（PR 后置 TODO）
- 详见 `docs/plans/2026-05-01-auth-system-design.md` § 3.5
```

- [ ] **Step 3: 验证 operations.md typo / 渲染**

```bash
cd /Users/roxor/brain/30-projects/aifeeds/.worktrees/feat-telemetry-and-anonymous-id
head -150 docs/operations.md
```

确保 markdown 表格和缩进无破损。

- [ ] **Step 4: 最终 commit**

```bash
git add docs/operations.md
git commit -m "$(cat <<'EOF'
docs(ops): operations.md 加 /api/track 端点和 events 表清单

PR1 上线后必备的运维文档同步。后续 retention cron 由 PR 后置 TODO
跟进，30 天清理策略与 metrics_snapshots / refresh_log 一致。

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: 跑一次 git log 看分支提交链**

```bash
git log --oneline main..HEAD
```

期望：约 22-24 个 commit，全部为 feat/docs/chore 三类。

---

## 完成验收

- [ ] 所有 24 个 task 都 commit
- [ ] events 表本地 + 远端都有真实流量数据
- [ ] dashboard 部署到 prod 后真实用户访问产生事件
- [ ] operations.md 同步更新
- [ ] 没有任何 hardcoded secret / 测试 device_id 留在生产代码

## 后续步骤

- 走 superpowers:finishing-a-development-branch 决定是否合 main / 等观察期
- 准备 PR2（auth backend），从 main 出新 worktree

## TODO（不在本 PR）

- 30 天 retention cron（清旧 events）
- 真实 cookie 解析的隐私 banner / 同意机制（PR3 上隐私政策时再做）
- events 表查询 API（PR4 数据看板）
- 分享按钮的 share_click 埋点（依赖前置 1 完成的 share 功能）
