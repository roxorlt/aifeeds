# Dashboard 前端响应式迭代设计

- **日期**：2026-04-29
- **作者**：roxor + Claude
- **状态**：brainstorm 已完成，等待落地为 implementation plan
- **影响范围**：`dashboard/` （React + Vite + Tailwind 4），不涉及 worker / scraper

---

## 1. 背景与问题

当前 dashboard 在 PC 与移动端共用同一套布局：顶 bar 上一行平台 chips（含「全部」），主区 1400px 宽 grid（移动 1 列、md 2 列、lg 3 列），每个 Feed 卡片有圆角边框 + 内置「热门 · 时间」切换。

落地以来积累了 7 类前端体验问题，本设计一次性把这 7 个问题拉齐解决，并把品牌从 `xList` 升级为 `AI-Feeds`。

非目标：

- 不改 worker / D1 schema
- 不动抓取/分类/翻译/enrich 管线
- 不引入新依赖（react-router、framer-motion 等都不加；纯 CSS + RAF）

---

## 2. 决议汇总

| ID | 主题 | 决议 |
|---|---|---|
| Q1 | 响应式判定 | 纯 CSS 断点 (Tailwind `md: 768px`)，微信 UA 留给未来 share 功能 |
| Q2 | 移动端 chips 交互 | 点击切平台 + 点当前 chip 回顶；横向溢出可滚 |
| Q3 | 排序选择器 | 移动端：merge 到 chip rail 右侧 `热度 v` → 弹底部 sheet；PC 端：每列 header 右侧 `热度 v` → 内联下拉；无排序能力的列隐藏 |
| Q4 | 回顶动效 | 300ms 固定 · ease-out (cubic-bezier 0.25, 0.46, 0.45, 0.94)；公共工具函数 |
| Q5 | PC 滚动结构 | PC = 列内独立滚（PC-2）+ techurls 留白美学；point top bar = 智能两段（page→cells）；点列 header = 该列回顶 |
| Q6 | metrics 显示 | 始终渲染 4 槽位，null → "—"；后端覆盖率提升记 TODO（已加） |
| Q7 | 圈选 vs 点击 | `onPointerDown` 记起点 + click 时距离 (>5px) + selection 非空双校验 |
| 品牌 | Title | xList → **AI-Feeds**，副标题 slogan 暂留空 |

---

## 3. 架构与关键文件

### 涉及文件

| 路径 | 改动性质 |
|---|---|
| `dashboard/src/App.tsx` | 中等 — Title 改名、chips 响应式分支、PC layout 容器调整、新增 page 级回顶联动 |
| `dashboard/src/components/Feed.tsx` | 中等 — 响应式去边框、排序组件抽离、cell 高度限制（PC）、点 header 回顶 |
| `dashboard/src/components/TweetCard.tsx` | 小 — `MetricButton` 渲染逻辑改为始终 4 槽位 + 圈选/点击区分 |
| `dashboard/src/components/SortSelector.tsx` | **新增** — 排序选择器组件，根据 `isMobile` 渲染 inline-dropdown 或 bottom-sheet |
| `dashboard/src/lib/scroll.ts` | **新增** — `smoothScrollToTop(el, opts)` 公共工具，300ms ease-out |
| `dashboard/src/lib/breakpoint.ts` | **新增** — `useIsNarrow()` hook，watches `(max-width: 767px)` |

### 依赖关系图

```
App.tsx
  ├── 用 useIsNarrow() 决定 chips 形态 + Title 副标题显示
  ├── PC 走 max-w-[1280px] + px-8/16 容器；移动端单列保持现状
  └── 渲染 Feed[]
        ├── Feed header → SortSelector + 列 title（点 header 回顶 = scrollToTop(feedBodyRef)）
        ├── Feed body 在 PC 用 calc(70vh) 限高 + overflow-y-auto；移动单 cell 走 page 滚
        ├── pull-to-refresh 仅移动端激活（保持现有逻辑）
        └── TweetCard
              ├── onPointerDown 记 {x,y}
              ├── onClick 校验 dist < 5 + getSelection 空 + 非 button/a
              └── MetricButton × 4 always render，count==null 显示 "—"

lib/scroll.ts:
  smoothScrollToTop(el, { duration=300, easing=easeOut })
  smoothScrollWindowToTop({ duration=300 })
  → 用 RAF + cubic-bezier(0.25, 0.46, 0.45, 0.94)
```

---

## 4. 详细设计

### 4.1 Title / 品牌

`App.tsx` 顶 bar：

```diff
- <h1>xList</h1>
- <span>AI 信息聚合看板</span>
+ <h1>AI-Feeds</h1>
+ {/* 副标题暂留空，slogan 后定 */}
```

Title 整条作为可点击区（`role="button"` + `cursor-pointer`），point 行为见 4.5。

### 4.2 响应式判定（Q1）

新增 `lib/breakpoint.ts`：

```ts
import { useEffect, useState } from "react";

export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== "undefined" ? window.matchMedia("(max-width: 767px)").matches : false
  );
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 767px)");
    const handler = (e: MediaQueryListEvent) => setNarrow(e.matches);
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);
  return narrow;
}
```

- 768px 是 Tailwind `md:` 的下边界 — 与 CSS 类保持一致
- SSR 首屏先按窄屏渲染（不会出现）；本项目纯 SPA 不影响

### 4.3 Chips 响应式（Q1+Q2）

`App.tsx` chips 行为按 `isNarrow` 二分：

```tsx
const isNarrow = useIsNarrow();

// 移动端：去掉「全部」，默认 X tab
const FILTER_CHIPS_MOBILE = FILTER_CHIPS.filter(c => c.key !== "all");
const initialFilter: FilterKey = isNarrow ? "x_list" : "all";

// 当窗口从宽变窄、当前在「全部」时，强制切到 X
useEffect(() => {
  if (isNarrow && filter === "all") setFilter("x_list");
}, [isNarrow, filter]);
```

PC 端：完全不渲染 chips 行（顶 bar 只有 Title + 刷新按钮 + 留白）。

移动端 chip 点击行为：

```tsx
onClick={() => {
  if (filter === key) {
    // 点的就是当前激活 chip → 回顶
    // 移动端 cell 不是 scroll container（overflow visible），只能走 page 级
    scrollFeedOrPage(null);
  } else {
    setFilter(key);
  }
}}
```

`scrollFeedOrPage` 见 4.5。移动端 cell 没有独立 scroll，传 null 即可；helper 会判断断点走 `smoothScrollWindowToTop()`。

**移动端 Feed header 形态**：保留 icon + title（实际 list 名如 `AI Feeds Mix` 比 chip 的「X」更具像），sort 移到 chip rail；header 本身**不**作为回顶热区（移动端已有 chip + top bar 两条入口，再加会冗余）。

### 4.4 排序选择器（Q3）

新组件 `SortSelector.tsx`：

```tsx
interface Props {
  value: SortMode;          // "hot" | "time"
  onChange: (mode: SortMode) => void;
  isNarrow: boolean;
}
```

**移动端形态**（isNarrow=true）：

- 触发器：`<button>` 显示「热度 v」/「时间 v」，placement 由父组件决定（在 chip rail 右侧）
- 点击 → render 全屏覆盖 `<div className="fixed inset-0 z-50 bg-black/30">` + 底部 sheet `<div className="fixed bottom-0 left-0 right-0 rounded-t-2xl bg-white">`
- Sheet 内容：标题「排序方式」+ 选项（热度 / 时间，当前选中带 ✓）+ 「取消」（独立行，灰底分隔）
- 关闭：点蒙层、点取消、点选项后都关闭
- 进入动效：transform translateY(100%) → 0，200ms ease-out（CSS transition）
- 选中后立即 `onChange` 并关闭 sheet，不需要额外确认

**PC 端形态**（isNarrow=false）：

- 触发器：`<button>` 显示「热度 v」/「时间 v」，放在每列 header 右侧
- 点击 → render `<div className="absolute top-full right-0 mt-1 ...">` 内联下拉
- 下拉内容：选项列表（无标题、无取消按钮），当前选中带 ✓
- 关闭：点选项、点页面其他位置都关闭
  - 实现：`useEffect` 注册 `document.click`，target 不在下拉内则关闭
- 不需要 backdrop / 蒙层

**无排序能力时**：父组件传 `placeholder=true`（current `Feed` prop），`SortSelector` 不渲染，列 header 右侧空白。

### 4.5 滚动 & 回顶（Q4+Q5）

新建 `lib/scroll.ts`：

```ts
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const DEFAULT_DURATION = 300;

export function smoothScrollToTop(
  el: HTMLElement | null,
  opts: { duration?: number } = {}
): Promise<void> {
  if (!el) return Promise.resolve();
  return animate(
    () => el.scrollTop,
    (y) => (el.scrollTop = y),
    0,
    opts.duration ?? DEFAULT_DURATION
  );
}

export function smoothScrollWindowToTop(
  opts: { duration?: number } = {}
): Promise<void> {
  return animate(
    () => window.scrollY,
    (y) => window.scrollTo(0, y),
    0,
    opts.duration ?? DEFAULT_DURATION
  );
}

function animate(
  getCur: () => number,
  setVal: (y: number) => void,
  target: number,
  duration: number
): Promise<void> {
  const start = getCur();
  const dist = target - start;
  if (Math.abs(dist) < 0.5) return Promise.resolve();
  return new Promise((resolve) => {
    const t0 = performance.now();
    function step(now: number) {
      const t = Math.min(1, (now - t0) / duration);
      setVal(start + dist * easeOut(t));
      if (t < 1) requestAnimationFrame(step);
      else resolve();
    }
    requestAnimationFrame(step);
  });
}
```

**断点感知的 helper**（统一入口）：

```ts
// lib/scroll.ts
export function scrollFeedOrPage(feedBody: HTMLElement | null) {
  const isNarrow = window.matchMedia("(max-width: 767px)").matches;
  if (isNarrow || !feedBody) {
    return smoothScrollWindowToTop();
  }
  return smoothScrollToTop(feedBody);
}
```

**Top bar 智能两段**：

```ts
// PC：page 没在顶 → page 回顶；已在顶 → 三列回顶
// 移动端：单列 cell 不是 scroll container，page 是；逻辑等价于"始终 page 回顶"
async function onTopBarClick() {
  const isNarrow = window.matchMedia("(max-width: 767px)").matches;
  if (isNarrow) {
    return smoothScrollWindowToTop();
  }
  const pageAtTop = window.scrollY <= 1;
  if (!pageAtTop) {
    return smoothScrollWindowToTop();
  }
  // 已在页面顶 → 三列同时回顶
  feedRefs.current.forEach((ref) => {
    if (ref.current) smoothScrollToTop(ref.current);
  });
}
```

**列 header 点击回顶（PC only）**：

```tsx
<header
  className="md:cursor-pointer"
  onClick={(e) => {
    // 移动端跳过（chip rail 已提供回顶入口，避免冗余）
    if (window.matchMedia("(max-width: 767px)").matches) return;
    // 排除子按钮（排序、刷新等）
    if ((e.target as HTMLElement).closest("button")) return;
    smoothScrollToTop(feedBodyRef.current);
  }}
>
```

**已有 `showPending` 内的 `behavior:"smooth"` 全部替换**（Feed.tsx:332, 342）：

- `feedBodyRef.current?.scrollTo({top:0, behavior:"smooth"})` → `scrollFeedOrPage(feedBodyRef.current)` （断点感知）

### 4.6 PC 布局（Q5）

容器：

```diff
- <main className="mx-auto max-w-[1400px] px-3 py-3 sm:px-6 sm:py-6">
+ <main className="mx-auto max-w-[1280px] px-3 py-3 sm:px-8 lg:px-16 sm:py-6">
```

Feed cell 高度（仅 PC）：

```diff
  <div className="flex flex-col overflow-hidden rounded-lg border ...
+    md:max-h-[70vh]
  ">
```

移动端：
- 不限高（cell 跟内容自然延展）
- 不显示外层 border + rounded（用 `md:rounded-lg md:border md:shadow-sm` 让样式只在 PC 生效）

```diff
- <div className="flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-sm">
+ <div className="flex flex-col overflow-hidden bg-white md:rounded-lg md:border md:border-neutral-200 md:shadow-sm md:max-h-[70vh]">
```

**移动端 page 滚 vs PC cell 滚**：

- PC：`feed-body` 始终 `overflow-y-auto`（已有），由 `max-h-[70vh]` 触发滚动条
- 移动端：`max-h` 不生效，`overflow-y-auto` 也不会触发（因为内容高度由父级决定，移动端 grid 是 1 列，cell 跟内容延展），自然走 page 滚

但有一个 subtle issue：当前 `feed-body` 是 `flex-1 overflow-y-auto`，移动端不限高时可能依然出现"列内滚条"。需要在移动端把 `feed-body` 的 overflow 改回 `visible`：

```diff
- <div ref={feedBodyRef} className="flex-1 overflow-y-auto feed-body">
+ <div ref={feedBodyRef} className="feed-body overflow-y-visible md:flex-1 md:overflow-y-auto">
```

移动端 `feedBodyRef.current.scrollTop = 0` 不会有效果（不是滚动容器），但回顶通过 page-level `smoothScrollWindowToTop()` 兜底。

回顶 helper `scrollFeedOrPage` 已在 4.5 定义并贯穿 chip click / showPending / 列 header click 等所有场景。

### 4.7 Metrics（Q6）

`TweetCard.tsx` 的 `MetricButton`：

```diff
- if (count === undefined || count === null) return null;
+ const display = (count === undefined || count === null) ? "—" : formatNumber(count);
```

整个组件保持渲染（icon + 数字槽位），null 时数字位显示「—」、icon 颜色淡化（`text-neutral-300`）：

```tsx
<span className={cn("text-[12px] tabular-nums", count == null && "text-neutral-300")}>
  {display}
</span>
```

后端覆盖率改进已加入 `TODO.md`，本次不实现。

### 4.8 圈选 vs 点击（Q7）

`TweetCard.tsx` `<article>`：

```tsx
const downPos = useRef<{ x: number; y: number } | null>(null);

<article
  onPointerDown={(e) => {
    downPos.current = { x: e.clientX, y: e.clientY };
  }}
  onClick={(e) => {
    if (embedded) return;
    const start = downPos.current;
    if (start) {
      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > 5 || dy > 5) return;
    }
    const sel = window.getSelection();
    if (sel && sel.toString().trim().length > 0) return;
    const target = e.target as HTMLElement;
    if (target.closest("button") || target.closest("a")) return;
    openTweet(item, siblings || []);
  }}
>
```

`onPointerDown` 在 React 里覆盖 mouse/touch/pen，无需分别处理。click 事件移动端在 tap 时也会触发（合成事件），合并校验逻辑覆盖两端。

---

## 5. 兼容性 / 回归风险

| 风险点 | 现状 | 处理 |
|---|---|---|
| pull-to-refresh | 移动端 cell `overflow-y-auto` + native touch listener 绑在 feedBodyRef | **必须迁移**：cell 改为 `overflow-y-visible` 后 `el.scrollTop` 永远是 0，原算法的"if (el.scrollTop <= 0)"会误判为「随时可拉」。需把 listener 改绑到 `document.documentElement`，把 `el.scrollTop` 校验改成 `window.scrollY <= 0`，`pullStartY` / `pullYRef` 算法保留。仅移动端激活（`isNarrow=false` 时不绑） |
| Thread 卡片 | ThreadCard 内部嵌套 TweetCard | onPointerDown/onClick 在每个 TweetCard 上独立绑定，互不干扰 |
| Drawer overlay | 当前点卡片打开 drawer | 圈选拦截后路径不变 |
| 「N 条新推文」banner 点击 | 当前用 `behavior:"smooth"` | 替换为 `smoothScrollToTop` 统一动效 |
| Pending 动画 + 头像叠加 | 不变 |
| 已知覆盖（hot mode `getSeenIds`）| 不变 | |
| Sort 切换的 useEffect 重新拉数据 | 已存在 dep | SortSelector 通过 `onChange` 触发同样的 setSortMode，逻辑一致 |
| `event.stopPropagation` | 列 header 子按钮（刷新、排序按钮）必须 stopPropagation 防止冒泡到 header 触发回顶 | 在 SortSelector 触发器、刷新按钮中加 |

---

## 6. 实施分阶段

P0 → 一次性 PR（worktree feature branch `feat/responsive-iteration`）：

1. **基础工具层**：`lib/scroll.ts` + `lib/breakpoint.ts`（无 UI 影响，可单独提）
2. **Q6 metrics 4 槽位**（最小、最独立的改动；可单独验证）
3. **Q7 圈选/点击区分**（独立改 TweetCard）
4. **Q4 回顶动效统一**：替换 `showPending` 内 2 处 `behavior:"smooth"`
5. **Q3 SortSelector 组件**（新文件 + Feed header 替换）
6. **Q1+Q2 chips 响应式**：useIsNarrow + 条件渲染 + chip click 行为
7. **Q5 PC layout + 回顶联动**：max-w/padding 调整、cell max-h、top bar click handler、列 header click handler
8. **Title 改名**：xList → AI-Feeds

每步完成后 dev server 手动 smoke：宽窗、窄窗（Chrome DevTools 切移动设备）、长按选词、长滚动回顶。

---

## 7. 验证

每个 Q 的人工验收脚本：

| Q | 验证步骤 |
|---|---|
| Q1 | DevTools 拖拽窗口宽度过 768px：窄 → 看到 chips（无「全部」），宽 → chips 消失 |
| Q2 | 移动模式：点 X chip 到 Feed 顶；滚下后再点 X chip → 平滑回顶 |
| Q3 移动 | 点「热度 v」→ 底部 sheet 上滑出现；点蒙层 / 「取消」/ 选项后都关 |
| Q3 PC | 点列 header「热度 v」→ 内联下拉；点页面别处关闭；点选项立即切换排序并关 |
| Q4 | 滚到底点「N 条新推文」/ top bar / 列 header → 计时约 300ms 完成回顶（DevTools Performance 看） |
| Q5 PC | 三列布局，左右大留白；鼠标在列内 wheel 滚列；鼠标在列外/留白 wheel 滚 page；点 top bar 一次（page 已在中段）→ page 回顶；再点一次 → 三列回顶 |
| Q5 移动 | 点 top bar = page 回顶；点 active chip = page 回顶；列 header 不是回顶热区（不绑事件） |
| Q6 | 找一条只有 likes / retweets 的 tweet：4 个 metric 槽位都渲染，replies / views 显示「—」 |
| Q7 | PC：拖拽选中正文 → 复制（不弹 drawer）；单击空白 → 弹 drawer；移动端：长按选词 → 系统菜单出现（不弹 drawer） |

---

## 8. 后续 / Out of scope

- metrics 后端覆盖率提升（TODO.md 已加，由 enricher daemon L0/L1 层补全空字段）
- 微信 UA 检测（留给未来 share 功能）
- Slogan 副标题（"一手最新鲜的资讯"思路，但还没定稿）
- URL routing / 详情页（TODO.md 前置 1）
- Dark mode（TODO.md P1）

---

## 9. 开放问题（写实施 plan 前最后窗口）

无。如有补充以 PR comment 形式回评，spec 不再回滚。

