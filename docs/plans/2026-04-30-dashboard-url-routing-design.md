# 设计：Dashboard URL routing — 推文详情页与深链分享

生成时间：2026-04-30
状态：设计已确认，待实施
相关 TODO：`前置 1: Dashboard URL routing — 当前是纯 SPA 全站 /，要补 tweet 详情页 /t/:id 和 thread 页 /thread/:id 两条路由`
依赖关系：分享功能链的 4 个前置之首，不完成则后续 OAuth / 上报 SDK / 数据看板 / 分享功能都没法落地

---

## 问题陈述

当前 dashboard 是纯 SPA，所有内容都在 `/`：
- 点击卡片打开 drawer，drawer 通过 `DrawerProvider` 持有内存中的 `Item` 引用，**URL 不变**
- 复制地址栏只能拿到 `/`，无法分享"我正在看的这条推"
- 刷新页面 drawer 状态丢失
- 无法通过 URL 进入特定推文（深链不可用）

这是分享功能链的根因卡点：所有分享逻辑都需要"每条推有稳定 URL"作为前提。

## 目标

1. **每条推有稳定 URL**：`/t/:id` 是该推的规范地址，刷新、分享、深链都成立
2. **桌面 / 移动 UX 在 URL 层面统一**：同一个 URL 在 PC 渲染为 drawer 抽屉，在 mobile 渲染为全屏页，由 `useIsNarrow()` 分流
3. **冷启动深链不漏留存**：从外部链接进入 `/t/:id` 后，点后退键回到首页 feed（不退出站点）
4. **不破坏现有性能**：应用内点开卡片仍然瞬时（不发请求），只在冷启动时才 fetch

## URL 路由结构

最终只引入一条新路由：

```
/          首页（Feed 多列）
/t/:id     推文详情（任何推文，包括 thread 中的某一条）
```

**不做 `/thread/:id`**（YAGNI）。理由：

- 分享 thread 时分享的就是 root 推文 URL，`/t/<root_id>` 拉数据时检测到 `thread_root_id` → 自动展示完整 thread
- 中间某条 reply `/t/<mid_id>` 同理，渲染完整 thread 并高亮当前条
- 多一条路由 = 多一种 URL 形态 + 多一个组件，没有额外信息量

## URL 与 drawer 的关系（seed-history 技巧）

桌面端 drawer 不再是纯 UI 状态，而是**与 URL 双向同步**：

```
应用内点击卡片 → history.pushState('/t/:id') → drawer 开
关闭 drawer / ESC / 点遮罩 → history.back() → URL 回到 /
浏览器后退键 → popstate → drawer 自动关
```

冷启动到 `/t/:id` 时（直接访问 / 分享链接进入），需要 **seed 一条 `/` 历史**到栈底，否则浏览器后退键会直接退出站点：

```js
// 仅当 location.pathname === '/t/:id' 且为初次加载时执行
history.replaceState({}, '', '/');
history.pushState({}, '', `/t/${id}`);
// 历史栈：['/', '/t/:id']
```

加这一步后用户后退 → `/` → drawer 关 → 露出底层 feed → 留在站内。这是 X / Twitter 同款做法。

### PC 体验（点击别人分享的链接）

- 新 tab 打开，地址栏 `/t/:id`
- 渲染：底层 Feed 正常加载 + drawer 从右滑入（被分享的推文）
- 关闭路径：后退键 / ESC / ✕ / 点遮罩 都等价 → drawer 关，露出 feed
- ESC 监听已在 `TweetDrawer.tsx:16-18` 实现，无需改动

### Mobile 体验

- 屏宽窄 → 渲染为全屏页（已有 `isNarrow` 分支）
- 顶部 ‹ 返回 按钮（已有）
- 后退键 / 点返回 → seeded `/` → 看到首页 feed
- 微信内置浏览器同样行为（webview history 走 seeded stack）

## 数据获取策略

**缓存优先 + 单一端点**。两条路径，UI 完全一致：

| 触发场景 | 数据来源 | 是否发请求 |
|---------|---------|-----------|
| 应用内点 feed 卡片 | 内存中的 `Item`（feed 已加载） | **否** |
| 冷启动 / 刷新 / 分享链接 | `GET /api/items/:id` | 是 |

### Worker 新增端点

```
GET /api/items/:id
→ 200 { item: Item, siblings: Item[] }
→ 404 { error: "not_found" }
```

实现要点：
1. 先 `SELECT * FROM tweets WHERE tweet_id = ?` 取 item
2. 如果 `thread_root_id` 非空 → `SELECT * FROM tweets WHERE thread_root_id = ? ORDER BY created_at ASC` 取 siblings
3. 否则 siblings 返回 `[]`
4. 现有 schema 已经有 `quote_of` / `link_card` / `extra` 等字段，不需要改 schema 也不需要 join 其他表

CORS 头复用现有 `Access-Control-*`。

### 前端数据流

`DrawerProvider` 改造：
- state 增加 `loading: boolean` 和 `error: string | null`
- 增加 `openTweetById(id: string)` 方法 → `fetchItem(id)` → 写入 state
- 保留 `openTweet(item, siblings)` 给应用内点击使用
- Drawer 组件读 state，loading 时显示骨架屏，error 时显示重试按钮（错误页风格已有）

URL 监听器（在 `App.tsx` 顶层）：
- 监听 `popstate` 事件
- 路径 `/t/:id` → 如果 context 里没有匹配 id 的 item → 调 `openTweetById(id)`；如果有 → `openTweet(cachedItem)`
- 路径 `/` → `close()`

### Staleness 取舍：故意不刷新

应用内点 feed 卡片**不重发请求**，即使内存中的 metrics 可能稍旧。理由：

- feed 里看到的数和 drawer 里看到的数一致 = 不诡异
- 想要新数据的路径已经存在（顶栏"新内容"提示条 / 下拉刷新）
- 多一次 fetch on every click 在 dashboard 里非常嘈杂

如果以后真的要"打开就是最新数据"，做法是 enricher 推送（websocket / SSE），不是每次点开都 GET。

## 实现拆解

按依赖顺序：

### M1: Worker 端点
- `worker/src/index.ts` 加 `path === '/api/items/:id' && request.method === 'GET'` 分支
- 提取 id（regex `^/api/items/([^/]+)$`），调用新函数 `handleItemById(env, id)`
- 单元测试：已知 thread root id / 普通 id / 不存在的 id

### M2: 前端 router
- `npm install react-router`（v7）
- `main.tsx` 包一层 `<BrowserRouter>`
- `App.tsx` 增加 `<Routes>`：`/` → 现有内容，`/t/:id` → 同样的内容（drawer 由 context 驱动）
- 注意：feed 必须挂载在 `/` 和 `/t/:id` 两条路由下都常驻（不能 unmount），否则 desktop 关 drawer 时背景空白

### M3: DrawerProvider 改造
- state 增加 `loading` / `error` / `currentId`
- 新增 `openTweetById(id)` 方法 → `fetchItem(id)` → 同时 `pushState`
- 改造 `close()` → `history.back()` 而不是直接清 state（让 popstate 来清）

### M4: URL ↔ drawer 同步
- `App.tsx` 顶层 `useEffect` 监听 `popstate`
- 初次加载时 seed history（如果 path 是 `/t/:id`）
- popstate 时根据新 path 决定开 / 关 drawer

### M5: api.ts 加 `fetchItem`
```ts
export async function fetchItem(id: string): Promise<{ item: Item; siblings: Item[] }>
```

### M6: 验证
- 应用内点击卡片 → drawer 开 → 地址栏变化 → 后退键关 drawer
- 复制 drawer 状态下的 URL → 新 tab 打开 → 看到 drawer + 底层 feed
- mobile viewport 同上 → 看到全屏页 + 后退回首页
- thread 中间一条的 URL → 渲染完整 thread + 高亮当前条
- 不存在的 id → 错误状态

## 不做的事（YAGNI）

- **`/thread/:id` 路由**：`/t/:id` 已覆盖
- **`/a/:handle` 作者页**：与本任务无关，未来需要再说
- **OG meta tags / 服务端渲染分享卡**：分享功能本身的事，本 PR 不做
- **路由切换时的过渡动画**：drawer 现有滑入动画够用，不加 page transition
- **scroll position 保留**：浏览器默认行为已经够用，不手工 stash
- **route prefetch**：dashboard 数据量小，不优化
- **TweetCard 上的"复制链接"按钮**：分享功能本身的事

## 验证

- [ ] `cd worker && wrangler dev` → `curl localhost:8787/api/items/<known_id>` 返回正确结构
- [ ] 同上 → `curl localhost:8787/api/items/notexist` 返回 404
- [ ] `cd dashboard && npm run dev` → 应用内点卡片 URL 变化、后退关 drawer
- [ ] dev 模式下直接访问 `localhost:5173/t/<known_id>` → 看到 feed + drawer
- [ ] DevTools 切到 mobile viewport → 同 URL → 看到全屏页
- [ ] thread 中一条的 URL → 完整 thread 渲染
- [ ] `npm run build` 无 type error
- [ ] 上线后用真实分享链接（微信内 / X 内）验证 webview 后退键行为

## 风险与回滚

- **风险**：seed history 在某些 webview（旧版微信、QQ 内置）可能行为异常 → 上线后跑一遍主要 webview，发现问题降级为"显式返回首页按钮 + 不 seed"（功能降级，不影响主流程）
- **回滚**：路由本身可以保留，drawer 不做 URL 同步即可——回到当前 SPA 行为，影响仅限于"分享链接进来后的体验"
- **数据回滚**：纯前端 + 一个新只读 endpoint，无 D1 schema 变更，零数据风险
