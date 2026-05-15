# Video Playback Coordinator 设计文档

> 作者：roxor + Claude / 2026-05-15
> 状态：草案 v1（待 review）
> 关联代码：dashboard/src/components/{TweetCard,PhDrawerBody}.tsx 现有 `<video>` 实现；新增 dashboard/src/lib/videoCoordinator.ts + dashboard/src/lib/useVideoCoordinator.ts

---

## 1. 背景与问题

dashboard 是多列 feed 看板（PC 5 列 + 移动 1 列 chip 切换），目前任何 X 推文卡 / PH 抽屉 gallery 内有视频时，**所有进入视口的视频会同时自动播放**。带来的问题：

- **资源浪费**：5 列 × 多个视频同时播 → 网络带宽 / CPU / 电池电量爆炸式消耗。
- **声音冲突**：多个视频带声播放（虽然现在默认 muted，但用户 unmute 一个时其他没静音 → 声音叠播）。
- **注意力分散**：用户视线被多个动态画面拉扯，看不清楚任何一个。
- **行业反例**：TikTok / Twitter / Instagram / YouTube feed 都是「全局只 1 个视频在播」的模式，aifeeds 当前实现是反直觉的。

**目标**：实现一个全局协调器（VideoCoordinator），保证 dashboard 任何时间最多 1 个视频在播放，按预定优先级规则切换。

---

## 2. 规则定稿（v1）

### 2.1 可见性判定

视频区域 **≥ 67% 可见 + 持续 ≥ 200ms** → 才算"want to play"候选。

- 工具：`IntersectionObserver` + `threshold: [0, 0.33, 0.67, 1]`（多阈值，防漏触发）
- 200ms 防抖：用户快速滚过的视频不算候选
- 67% 而非 100%：避免高视频卡片永远不达 100%；避免边缘小幅滚动反复 toggle

### 2.2 优先级（feed 模式，抽屉关闭时）

按下面顺序选 active：

1. **同 feed（列）内多视频候选** → 取**最靠上**的那个
2. **跨 feed 多个候选** → **最近被 click 过的列**优先
3. **都没 click 过** → 按列位置：**从左到右、从上到下**

> ⚠️ scroll 不算列交互信号（trackpad 横滑会误触多列）。只 click 算（点击列内任意元素 / 卡片 / 视频本身 / chip 切换 等）。

### 2.3 抽屉模式（drawer 打开时）

抽屉是视频的**最高优先级 context**：

- 抽屉打开期间 → feed 视频**全部暂停**（不只是 active 那个）
- 抽屉内多视频 → 同 67%/200ms 规则但范围限抽屉容器
- 抽屉内 **YouTube / Vimeo iframe** → 不自动播（iframe 第三方播放器无法用 `.play()` API；postMessage 控制复杂度不值）→ 显示 thumbnail + 大播放按钮，用户手动点
- 抽屉关闭 → 重新跑 selectActive 算法，feed 按规则恢复 1 个 active

### 2.4 用户控制

#### 设置项
- **`自动播放视频`**：开 / 关（默认开）
- **`默认静音`**：开 / 关（默认开 — 浏览器 autoplay policy 要求 muted 才能 autoplay）

#### 入口
- **未登录**：顶栏右侧「登录」按钮**整体替换为齿轮 icon**（细线 SVG，跟全站 lucide 风格一致）。点开 dropdown menu，菜单内含：
  - 「登录」（高亮按钮，主 CTA）
  - 分隔线
  - 「自动播放视频」toggle
  - 「默认静音」toggle
- **已登录**：保留现有头像入口（`UserMenu.tsx` 已有），下拉菜单加上同样两个设置项 + 既有的「账号设置」入口

#### 数据
- **localStorage** key：`aifeeds:video_prefs`（schema：`{ autoplay: boolean, muted: boolean }`）
- 立即生效，**未登录用户也能改**
- 已登录态额外同步到后端 `user.preferences`（如表 schema 已有 / 否则后续 PR 加），登录时拉云端覆盖本地

### 2.5 用户主动行为的尊重

- **用户主动暂停某视频** → 该视频本 session 不再被自动播（`userPausedIds: Set<string>`）。除非用户手动 play 或刷新页面
- **用户在某视频 unmute（开声）** → 全局 `globalMuted = false` sticky 到 session 结束（直到用户 mute 回去 / 关 tab）

### 2.6 边界处理

- **`document.visibilityState === 'hidden'`**（切 tab / 锁屏 / 应用切后台）→ 暂停所有视频；恢复 visible 时 → 重新跑 selectActive
- **浏览器拒绝 autoplay**（`play()` Promise reject `NotAllowedError`）→ 静默 fallback：显示首帧 + 大播放按钮，用户点了算 user gesture 后续可正常播
- **iOS Safari**：所有 `<video>` 加 `playsinline`；低电量模式下走 fallback；`play()` 是 async 必须正确 await pause 旧视频再 play 新视频（避免 race）
- **preload 策略**：默认 `metadata`（约 50KB / 视频，拿到时长 + 首帧），active 视频升级 `auto`，滚出视口降回 `metadata`

---

## 3. 架构

### 3.1 数据流

```
┌──────────────────────────────────────────────────────────┐
│  VideoCoordinator (zustand store)                        │
│   state:                                                 │
│     candidates: Map<videoId, {                           │
│       columnId: string,        // 所在列 id              │
│       visibleRatio: number,    // 0..1                   │
│       isVisible: boolean,      // ≥67% + 200ms 后 true   │
│       userPaused: boolean,     // 用户主动暂停过           │
│     }>                                                   │
│     activeId: string | null    // 当前在播的视频 id       │
│     drawerVideoId: string | null  // 抽屉内当前应播视频   │
│     mode: 'feed' | 'drawer'    // 当前 context           │
│     lastClickedColumnId: string | null                   │
│     globalMuted: boolean       // 静音 sticky            │
│     prefs: { autoplay: bool, muted: bool }              │
│                                                          │
│   actions:                                               │
│     register(videoId, columnId)                         │
│     unregister(videoId)                                 │
│     setVisibility(videoId, ratio)                       │
│     markUserPaused(videoId, paused)                     │
│     markColumnClick(columnId)                           │
│     setMode('feed' | 'drawer')                          │
│     setGlobalMuted(muted)                               │
│     selectActive()  // 内部根据规则计算 activeId        │
└──────────────────────────────────────────────────────────┘
        ▲                              ▼
   register / setVisibility       activeId 变化 broadcast
        ▲                              ▼
   ┌──────────────┐               ┌──────────────┐
   │  VideoCard   │     ...       │  VideoCard   │
   │  (X tweet)   │               │  (PH drawer) │
   │              │               │              │
   │  uses hook   │               │  uses hook   │
   │  to register │               │  to register │
   │  + receive   │               │  + receive   │
   │  play/pause  │               │  play/pause  │
   └──────────────┘               └──────────────┘
```

### 3.2 store schema (zustand)

新增 `dashboard/src/lib/videoCoordinator.ts`：

```ts
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface VideoCandidate {
  columnId: string;
  visibleRatio: number;
  isVisible: boolean;
  userPaused: boolean;
}

interface VideoPrefs {
  autoplay: boolean;
  muted: boolean;
}

interface VideoCoordinatorState {
  candidates: Map<string, VideoCandidate>;
  activeId: string | null;
  drawerVideoId: string | null;
  mode: 'feed' | 'drawer';
  lastClickedColumnId: string | null;
  globalMuted: boolean;
  prefs: VideoPrefs;

  register: (videoId: string, columnId: string) => void;
  unregister: (videoId: string) => void;
  setVisibility: (videoId: string, ratio: number, isVisible: boolean) => void;
  markUserPaused: (videoId: string, paused: boolean) => void;
  markColumnClick: (columnId: string) => void;
  setMode: (mode: 'feed' | 'drawer') => void;
  setGlobalMuted: (muted: boolean) => void;
  setPrefs: (patch: Partial<VideoPrefs>) => void;
  selectActive: () => void;
}

export const useVideoCoordinator = create<VideoCoordinatorState>()(
  persist(
    (set, get) => ({
      // ...实现见后续 commit
    }),
    {
      name: 'aifeeds:video_prefs',
      partialize: (s) => ({ prefs: s.prefs }), // 只持久化 prefs，运行态不持久化
    },
  ),
);
```

### 3.3 hook 签名

新增 `dashboard/src/lib/useCoordinatedVideo.ts`：

```ts
export function useCoordinatedVideo(opts: {
  videoId: string;
  columnId: string;
}): {
  /** Pass to <video ref={ref}> */
  ref: RefObject<HTMLVideoElement>;
  /** Pass to <video muted={muted}> — 跟全局静音状态同步 */
  muted: boolean;
  /** 用户在视频上点暂停时调（避免 coordinator 自动 resume） */
  onUserPause: () => void;
  /** 用户在视频上点 unmute 时调 */
  onUnmute: () => void;
  /** 当前是否被 coordinator 选为 active */
  isActive: boolean;
};
```

内部：
- mount 时 register；unmount 时 unregister
- IntersectionObserver 报告 visibleRatio → setVisibility
- `useEffect` 监听 isActive 变化 → 调 `videoEl.play() / .pause()`
- 处理 play() Promise + 浏览器拒绝场景

### 3.4 列 click 信号

App.tsx / Feed.tsx 已有 column 容器，加事件捕获：

```tsx
<section
  data-column-id={sourceType}
  onClickCapture={(e) => {
    useVideoCoordinator.getState().markColumnClick(sourceType);
  }}
>
```

`onClickCapture` 在事件 bubble 之前触发，捕获列内任何 click。

### 3.5 抽屉 mode 切换

`useDrawer` hook 已存在（`dashboard/src/lib/drawer.tsx`）。在 drawer open / close 时调：

```ts
useEffect(() => {
  useVideoCoordinator.getState().setMode(open ? 'drawer' : 'feed');
}, [open]);
```

### 3.6 visibility / tab 切换

App.tsx 顶层加：

```ts
useEffect(() => {
  const onVis = () => {
    if (document.hidden) {
      // 全部暂停（实现：mode='feed' + activeId=null + 实际 video el pause）
      useVideoCoordinator.getState().setMode('hidden');
    } else {
      useVideoCoordinator.getState().setMode(drawerOpenRef.current ? 'drawer' : 'feed');
    }
  };
  document.addEventListener('visibilitychange', onVis);
  return () => document.removeEventListener('visibilitychange', onVis);
}, []);
```

> 实际实现里 `mode` 加一个 'hidden' state 比直接 setActive(null) 更清晰。

---

## 4. 组件改造点

### 4.1 现有视频组件

| 组件 | 行 | 当前状态 | 改造 |
|------|----|---------|------|
| `TweetCard.tsx:101` | `<video>` | X 视频，preload=metadata，muted | 接 useCoordinatedVideo + 加 playsinline |
| `PhDrawerBody.tsx:334` | `<video>` | PH 直链 mp4 gallery 视频 | 接 useCoordinatedVideo（在 drawer mode 内） |
| `PhDrawerBody.tsx:323` | `<iframe>` | YouTube / Vimeo embed | **不自动播**，改成 thumbnail + 点击播 fallback（独立 PR 也行，本 PR 范围可缩） |

### 4.2 新增组件 / 文件

- `dashboard/src/lib/videoCoordinator.ts` — zustand store
- `dashboard/src/lib/useCoordinatedVideo.ts` — hook
- `dashboard/src/components/SettingsMenu.tsx` — 齿轮 dropdown menu（未登录态）
- 改 `dashboard/src/components/UserMenu.tsx` — 未登录分支换齿轮 icon；已登录头像下拉菜单加设置项

### 4.3 列 id 来源

每个 feed 列 = `Feed` 组件 一个 instance，prop `sourceType: SourceType`。`columnId` 直接用 `sourceType`（如 `x_list` / `huodongxing` / `clawhub` 等）。

抽屉容器单独的 columnId：`'drawer'`。

---

## 5. UI 设计

### 5.1 齿轮 icon

- lucide `<Settings />` 或自定义 SVG，**风格跟现有 SourceIcon / IconShare 等一致**：1.5 stroke，neutral-700 color，hover neutral-900
- 尺寸：h-8 w-8（跟头像 button 一致），padding 8px
- 移动端 / 桌面端同款

### 5.2 dropdown menu

```
┌────────────────────────────┐
│  [登录]    （未登录态）       │  ← 高亮主 CTA
├────────────────────────────┤
│  自动播放视频          [●]  │  ← toggle
│  默认静音              [●]  │  ← toggle
└────────────────────────────┘
```

已登录态：

```
┌────────────────────────────┐
│  @username  ✓             │  ← 用户信息行
├────────────────────────────┤
│  自动播放视频          [●]  │
│  默认静音              [●]  │
├────────────────────────────┤
│  账号设置                  │  ← 跳 /settings
│  退出登录                  │
└────────────────────────────┘
```

- toggle 用现有 Tailwind switch 风格（如果项目里没有，新写一个最小实现）
- 菜单宽度 240px，圆角 8px，shadow-lg
- 点菜单外关闭（mousedown 监听）

### 5.3 视频角标提示

可选：当前 active 视频左下角加一个小喇叭 icon（mute / unmute 状态）+ 暂停 / 播放按钮。**v1 不强求**，如果 implementation 简单可加。

---

## 6. 非目标 / 不做的事

- ❌ 第三方 iframe（YouTube / Vimeo）双向通信控制：复杂度高，收益小，v1 改成 thumbnail + 手动点
- ❌ 后端 user.preferences 同步：留给单独 PR（看 user 表 schema 是否需要先改）
- ❌ "下一候选预加载首帧" 优化：v1 不做，看实际用户反馈
- ❌ 蜂窝网络判断 / 仅 WiFi 自动播：mobile 高级功能，留给后续
- ❌ 无障碍 keyboard 导航全套：基本 ARIA 标签做到位即可

---

## 7. 测试清单

### 7.1 手动测试场景

- [ ] PC 5 列同时有视频 → 只有 1 个在播
- [ ] 滚动时 active 视频按 67% 阈值切换，无闪播
- [ ] click 列 A 的视频卡 → 该列优先获得 active
- [ ] click 列 A 任意非视频元素 → 该列同样获得 active 优先
- [ ] 没 click 过任何列 → 按从左到右从上到下选第一个候选
- [ ] 用户暂停视频 A → 滚出视口再滚回来 → A 不自动 resume
- [ ] 用户 unmute 视频 A → 切到视频 B → B 也是带声播放
- [ ] 切到别的浏览器 tab → 所有视频暂停；切回来恢复 active
- [ ] 打开抽屉（含视频）→ feed 视频全停 / 抽屉视频按规则播
- [ ] 关闭抽屉 → feed 恢复 active
- [ ] 设置「自动播放」关 → 所有视频不自动播，只显示首帧
- [ ] 设置「默认静音」关 → 视频带声播放（首次可能被 autoplay policy 拒）
- [ ] 未登录态点齿轮 → 弹菜单可见登录 + 两个 toggle
- [ ] 改 toggle 后刷新页面 → 设置保留
- [ ] 已登录态点头像 → 弹菜单含同样设置项

### 7.2 性能验证

- DevTools Network 面板：滚动时观察视频请求数，应该只 1 个视频在 streaming
- DevTools Performance：CPU usage 对比改造前后
- iOS Safari 真机：playsinline 生效、不被全屏接管

### 7.3 浏览器兼容

- Chrome / Edge / Safari / Firefox 桌面 — 全部测
- iOS Safari / Chrome — 真机测
- 微信内置浏览器 — 真机测（autoplay policy 严格）

---

## 8. 实施分阶段

### Phase 1 — 核心 coordinator（本 PR）

- VideoCoordinator store + hook
- 接现有 TweetCard / PhDrawerBody 视频
- visibility / drawer mode / column click 信号
- 设置 UI（齿轮菜单 + 2 toggle + localStorage）

### Phase 2 — 抽屉 iframe fallback（同 PR 或后续）

- YouTube / Vimeo iframe 改成 thumbnail + 手动点
- iframe `src` 仅在用户 click 后注入

### Phase 3 — 后端 prefs 同步（后续）

- 后端 user 表加 `preferences` 列（如未存在）
- 登录时拉云端覆盖 localStorage
- 改 prefs 时同步上传

### Phase 4 — polish（后续，按反馈）

- 视频角标提示（mute / pause icon）
- 仅 WiFi 自动播放（蜂窝网络判断）
- 下一候选预加载首帧
- 无障碍 keyboard 导航完善

---

## 9. 已敲定的实施细节

- **zustand**：已装 `^5.0.12`（package.json 验过）
- **localStorage key**：`ai-feeds-video-prefs`（跟 authStore 的 `ai-feeds-auth` 同前缀风格）
- **抽屉 mode 触发时机**：所有 drawer 走 `useDrawer` 同一 context（drawer.tsx），coordinator 监听该 context 的 open 状态
- **iframe fallback 的 thumbnail**：PH parser 已抓 `video.poster`（YouTube embed 直接用 `https://img.youtube.com/vi/<id>/maxres.jpg`）

## 10. 残留 Open questions

- **后端 user.preferences 同步**：v1 不做（Phase 3）。需 user 表加 `preferences` JSON 列（如未存在）
- **toggle 组件**：项目无现成 switch，本 PR 内最小实现一个
