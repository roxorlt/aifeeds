# PR5 分享功能 实施计划

> **分支**：`feat/pr5-share`（worktree `worker/.worktrees/feat-pr5-share/`）
> **依赖**：PR3 ✅（auth + telemetry）/ PR4 ✅（route guards）/ staging ✅
> **目标**：分享单条内容生成海报（含二维码）+ 三态分流（PC / 移动 / 微信内）+ 落地回流上报 + 社交关系数据为未来推荐做铺垫
> **范围外**：微信 JS SDK 直接拉起分享（PR5+）/ PC 桌面微信客户端拉起（PR5+）/ favorites + 邮件 newsletter（PR7）

---

## 一、用户路径

```
用户 A（已登录）
  在 dashboard 看到一条 X tweet / GitHub repo / PH product
  点卡片上「分享」icon
    ↓
  Dashboard 调 worker POST /api/share/create
    ↓
  Worker 生成 share_token (nanoid 8 字符)，写 share_relations，返回 PNG URL
    ↓
  Dashboard 弹「分享」对话框：
    - 海报预览（9:16，1080×1920 缩到屏幕大小）
    - 按 UA 分流的操作按钮：
        PC      → [复制链接] [保存海报到本地]
        移动端  → [保存到相册] [分享到...]（系统 share sheet）
        微信内  → [分享到微信] [分享到朋友圈]（先 toast「点右上角···」引导，PR5+ 接 JS SDK）
    ↓
用户 B（未登录用户，扫码）
  扫码 → 浏览器打开 https://ai-feeds.com/s/<token>
    ↓
  Worker GET /s/:token：
    - 查 share_relations 拿 from_uid + item_id
    - 写 share_relations.landed_at + to_did
    - 302 redirect 到 https://ai-feeds.com/t/:item_id?from=<from_uid>&ref=share
    ↓
  Dashboard 详情页打开
    - URL 带 ?from=<from_uid>&ref=share → 触发 share_landing telemetry 上报
    - 用户 B 后续如果注册，回填 share_relations.registered_at + to_uid
```

---

## 二、数据模型

### 2.1 `share_relations` 表（新增）

```sql
CREATE TABLE share_relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT UNIQUE NOT NULL,            -- 短码（nanoid 8 字符）
  from_uid TEXT NOT NULL,                -- 分享人 user.id
  item_id TEXT NOT NULL,                 -- 被分享内容 (composite, 如 'x_list:123…' / 'github:owner/repo')
  shared_at INTEGER NOT NULL,            -- 创建时间 ms

  -- 落地后填
  to_did TEXT,                           -- 落地浏览器 device_id（首次扫码）
  to_uid TEXT,                           -- 落地用户后续注册的 user.id
  landed_at INTEGER,                     -- 首次扫码时间
  registered_at INTEGER,                 -- 落地后该 did 注册时间

  -- 多次扫码统计
  scan_count INTEGER DEFAULT 0,          -- 累计扫码次数（每次 GET /s/:token +1）
  last_scanned_at INTEGER                -- 最近一次扫码时间
);

CREATE UNIQUE INDEX idx_share_token ON share_relations(token);
CREATE INDEX idx_share_from_uid_time ON share_relations(from_uid, shared_at DESC);
CREATE INDEX idx_share_item_time ON share_relations(item_id, shared_at DESC);
CREATE INDEX idx_share_to_did ON share_relations(to_did) WHERE to_did IS NOT NULL;
```

**为什么 token 嵌进 share_relations 而非独立表**：每次分享创建一条 row，token 跟分享关系是 1:1。独立表会增加 join 成本。

### 2.2 telemetry 事件扩展

`events.event_type` 新增：
- `share_click`（PR1 已声明，本 PR 真发）— payload: `{item_id, channel: 'pc-copy' / 'mobile-share-sheet' / 'wechat-friend' / 'wechat-moments' / 'save-image'}`
- `share_landing`（PR1 已声明，本 PR 真发）— payload: `{from_uid, ref_type, item_id, share_token}`

---

## 三、Worker endpoints

### 3.1 `POST /api/share/create`

**输入**: `{ item_id: string }`（cookie 鉴权拿到 user.id）

**响应**:
```json
{
  "token": "Ax7f3pQ2",
  "share_url": "https://ai-feeds.com/s/Ax7f3pQ2",
  "poster_url": "https://api.ai-feeds.com/api/share/poster/Ax7f3pQ2",
  "expires_at": 1772985600000
}
```

**实现**:
1. 鉴权：`requireAuth(request, env)` → 获得 `user.id`，未登录返回 401
2. 校验 `item_id` 存在于 D1
3. nanoid(8) 生成 `token`（碰撞概率忽略不计，约 50 亿次）
4. INSERT share_relations
5. 返回

不在创建时渲染 PNG —— 海报渲染走 lazy（首次 `/api/share/poster/:token` 命中时才渲染并缓存）。

### 3.2 `GET /api/share/poster/:token?ratio=9:16`

**响应**: `image/png`（带 `Cache-Control: public, max-age=604800` 7 天 + R2 持久化缓存）

**实现**:
1. 检查 R2 `posters/<token>-<ratio>.png` 是否存在 → 直接 stream
2. 不存在：
   - 查 share_relations → item_id, from_uid
   - 查 items 表拿 item 数据（author/handle/content/metrics 等）
   - 查 users 表拿 from_uid 的 nickname / avatar_url
   - 调 `renderPoster(item, sharer, token)` → SVG 字符串
   - resvg-wasm 渲染 SVG → PNG buffer
   - 写 R2 `posters/<token>-<ratio>.png` + 返回

ratio 参数为后续多比例预留，PR5 默认 `9:16`。

### 3.3 `GET /s/:token`

**响应**: 302 redirect 到详情页

**实现**:
1. 查 share_relations 拿 `from_uid`, `item_id`
2. 提取 `device_id` from `X-Device-Id` header（如果 dashboard 已 hydrate cookie）或 cookie
3. 写 `share_relations` UPDATE：
   - 首次扫码：`to_did = ?, landed_at = NOW`
   - 后续扫码：`scan_count += 1, last_scanned_at = NOW`
4. 302 → `https://ai-feeds.com/t/:item_id?from=<from_uid>&ref=share`

### 3.4 `POST /api/share/landing`

落地详情页时由前端调用，补充 device_id（redirect 时浏览器可能还没有 device_id cookie）。

**输入**: `{ token: string }`

**实现**: 如果 share_relations.to_did 为空，UPDATE 写入。

### 3.5 `GET /api/admin/share/:token`

Admin panel 工具：看某 token 的扫码统计。

---

## 四、海报渲染（worker 端 SVG → PNG）

### 4.1 技术选型

| 选项 | bundle 大小 | 优点 | 缺点 |
|---|---|---|---|
| **`@resvg/resvg-wasm`** | ~600KB wasm | 稳定、SVG 1.1 支持完整 | 需要内嵌字体 |
| `satori` | ~1.5MB | 接 React JSX 易写 | 大、CSS 支持有限制 |
| CF Browser Rendering | 无 bundle，但 quota | 1:1 还原浏览器 | 月 10h quota（PH POC 已用）/ 每张 1-2s |

**选 resvg-wasm**：bundle 控制 + worker 渲染速度 200-500ms + 跟 mockup v7 SVG 模板 1:1 同构。

### 4.2 字体策略

中文字体不嵌入 → resvg fallback 到无衬线，中文显示成方块 ❌。

方案：
- 选 **Noto Sans SC**（开源 SIL OFL）— Regular / Medium / Bold 三个 weight
- 用 `subset-font` 工具（pnpm 跑）按 mockup 文案预生成子集字体
- 实际只覆盖 ~3000 常用汉字 + 数字 + 标点 → 单文件 ~250KB
- 三个 weight 共 ~750KB，约等于一个图片

子集策略文档放 `worker/src/share/fonts/README.md`。

### 4.3 SVG 模板

`worker/src/share/svg-template.ts` 把 v7 mockup HTML 翻译成 SVG 字符串模板：

```ts
export function renderPoster(item: Item, sharer: Sharer, token: string): string {
  const source = item.source_type;
  const hero = renderHero(source);
  const card = source === 'x_list' ? renderXCard(item) :
               source === 'github'  ? renderGitHubCard(item) :
                                      renderPHCard(item);
  const footer = renderFooter(sharer, token);
  return `<svg width="1080" height="${POSTER_HEIGHT}" viewBox="0 0 1080 ${POSTER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
    <style>${INLINE_FONTS_CSS}</style>
    ${hero}${card}${footer}
  </svg>`;
}
```

SVG 用 `@font-face` `data:font/woff2;base64,...` 内嵌字体。

### 4.4 海报高度自适应

mockup 用 ResizeObserver + transform:scale 处理。SVG 端：
- 计算每个 source 的卡片实际高度（content-card 内 element 累加）
- 按 SVG 元素堆叠固定 `y` 坐标（不像 HTML 流式 layout 自然撑开）
- 简化方案：固定 1920 高，长内容多行截断；短内容底部留空

**PR5 用固定 1920**，长度变化等 PR6 优化（resvg 不直接支持 flex layout）。

---

## 五、Dashboard 端

### 5.1 三态分流 UA 检测

```ts
type ShareEnv = 'pc' | 'mobile-default' | 'wechat';

function detectShareEnv(): ShareEnv {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('micromessenger')) return 'wechat';
  if (/mobile|android|iphone|ipad/.test(ua)) return 'mobile-default';
  return 'pc';
}
```

### 5.2 各环境 UI

| 环境 | 主操作（按钮） | 实现 |
|---|---|---|
| **PC** | 复制链接 | `navigator.clipboard.writeText(share_url)` |
| **PC** | 保存海报到本地 | `<a download href={poster_url}>` 或 fetch + Blob |
| **mobile-default** | 保存到相册 | `<a download>` (iOS Safari 用 `web share` 的 `files` 兜底) |
| **mobile-default** | 分享到... | `navigator.share({ files: [pngBlob], url: share_url, text: '...' })` |
| **wechat** | 分享到微信好友 | toast「点右上角 ··· → 发送给朋友」 |
| **wechat** | 分享到朋友圈 | toast「点右上角 ··· → 分享到朋友圈」 |

### 5.3 组件拆分

- `lib/share.ts` — `createShare(item_id) → {token, poster_url, share_url}` / `detectShareEnv()`
- `components/ShareButton.tsx` — 卡片上的小图标按钮，点击调用 createShare + 打开 ShareDialog
- `components/ShareDialog.tsx` — 弹窗，左侧海报预览，右侧分流按钮
- `components/icons.tsx` — 加 `IconShare`（lucide style 24x24）

### 5.4 落地回流处理

详情页 `/t/:item_id` 加载时，检查 URL `from` 和 `ref=share` 参数：
- 上报 `share_landing` telemetry
- 如果 `?token=xxx`（redirect 时附带），调 `POST /api/share/landing` 补 device_id

---

## 六、实施步骤

按依赖顺序，分小提交跟踪：

### Step 1：worker 基础（半天）
- [ ] migration `009-share-relations.sql`，跑 staging + prod
- [ ] `worker/src/share/types.ts` 定义类型
- [ ] `worker/src/share/handlers.ts` 写 5 个 handler（暂用占位 SVG，先把数据流跑通）
- [ ] `worker/src/index.ts` 注册路由
- [ ] 部署 staging worker，curl 测 5 个 endpoint

### Step 2：海报渲染（1 天）
- [ ] 装 `@resvg/resvg-wasm`，bundle 测试 worker 大小
- [ ] 装 `subset-font`，跑一遍 Noto Sans SC 子集脚本，生成 woff2
- [ ] `worker/src/share/svg-template.ts` 按 v7 mockup 写 SVG 模板（X / GH / PH × media / no-media 共 6 个变体）
- [ ] `worker/src/share/render.ts` resvg 渲染 + R2 缓存
- [ ] staging 测试：用真 item 数据生成海报，肉眼对比 v7 mockup

### Step 3：dashboard 分享按钮 + 弹窗（半天）
- [ ] `lib/share.ts` 加 createShare / detectShareEnv
- [ ] `components/ShareButton.tsx` 组件
- [ ] `components/ShareDialog.tsx` 弹窗（先做 PC 版，后续叠加 mobile/wechat）
- [ ] `icons.tsx` 加 `IconShare`
- [ ] X / GH / PH 卡片接入 ShareButton

### Step 4：三态分流 UI（半天）
- [ ] ShareDialog 按 detectShareEnv 渲染不同按钮
- [ ] PC：复制 link / 保存图（fetch poster + download）
- [ ] mobile-default：Web Share API + 保存相册
- [ ] wechat：toast 引导

### Step 5：落地回流（小）
- [ ] App.tsx URL 解析 from / ref=share / token，发 share_landing 事件
- [ ] 注册时回填 share_relations.registered_at（在 worker handleLogin 里加一段查 to_did → 找 share_relations 写 to_uid + registered_at）

### Step 6：dev 跑通 + staging 验证（半天）
- [ ] dashboard `npm run dev` 测分享流程
- [ ] 真手机扫码 staging 海报二维码，验证 redirect + 落地上报

### Step 7：合 main + prod（小）
- [ ] worker prod 部署
- [ ] dashboard prod 部署
- [ ] 真手机微信扫真海报验证（找朋友扫一下）

---

## 七、文档同步（按 staging 设计要求）

- [ ] `docs/operations.md` 加 share 端点 + R2 `posters/` 目录约定
- [ ] `CLAUDE.md` 发布前 checklist 加：「分享改动 prod 验证：真手机微信扫码 + Web Share API 测试」
- [ ] `TODO.md` 标记 PR5 完成

---

## 八、风险点与回滚

| 风险 | 表现 | 缓解 |
|---|---|---|
| resvg-wasm bundle 超 1MB | worker 部署失败 | 字体子集化 / 用 wasm streaming load |
| 中文字体子集不全 | 海报某些字符显示方框 | 用 `glyphhanger` 扫所有可能字符（item.content 抽样） |
| 微信内 Web Share API 不可用 | mobile-default 检测错误 | 检测顺序：先 micromessenger 再 mobile，最后 PC |
| 短码碰撞 | 极小概率 token 撞库 | nanoid 8 字符 ≈ 218 万亿组合，加 unique index 兜底 |
| R2 缓存越来越大 | 月 R2 费用上升 | TTL 30 天 / lifecycle policy 自动清理 |
| 用户分享后 user 注销 | from_uid 失效 | UI 显示 「来自 ai-feeds 用户」兜底，不影响落地 |

回滚：
- DB 改动：drop share_relations（无副作用）
- worker：rollback 到上一版本
- dashboard：rollback 到上一版本

---

## 九、之后的延伸（不在 PR5）

- **PR5+ 微信 SDK 拉起**：接微信 JS SDK，把 wechat 两个按钮从 toast 改成真调起 `wx.shareToFriend`
- **PR5+ PC 桌面微信**：拉起桌面微信客户端
- **PR6 多比例预生成**：3:4 / 1:1 / 9:16 一次渲染存 R2，前端横划切换
- **PR6 海报模板 A/B**：worker 端模板可服务端版本管理
- **PR7 newsletter** 邮件分享：把 share token 也用作邮件订阅追踪
- **PR7+ 社交推荐**：基于 share_relations 表 join 出「你朋友 X 分享过的」推荐源

---

## 十、设计文档清单

- mockup：[`docs/mocks/2026-05-04-share-poster-v7.html`](../mocks/2026-05-04-share-poster-v7.html)
- spec（用户提供）：`~/Downloads/share_poster/ai_feeds_share_poster_design_spec.md`
- 本文档：实施计划 + endpoint + schema
