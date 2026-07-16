# C 端双端动效系统修复 Implementation Plan

> **For Codex:** 使用 `test-driven-development` 逐项执行；修改后使用
> `verification-before-completion` 做完整验收。性能慢问题只诊断，不在本计划里顺手修复。

**Goal:** 按已批准的 PC/移动端动效评审全面修复频道、滚动、手势、Drawer、Popover、
Lightbox、Modal、Toast、Hover 和 reduced-motion，同时不改变业务数据与路由语义。

**Architecture:** 建立小而集中的 motion 常量/工具，预定型进出场交给 CSS animation/
transition，动态手势继续直接写目标元素 transform。高频频道点击删除伪加载和
胶状动画；退出动效在调用业务 close 之前完成，Escape 保持即时。所有 JS 动效共享
reduced-motion 判断和可取消控制器。

**Tech Stack:** React 19、TypeScript、Vite 8、Tailwind CSS 4、CSS Animations、Node
`node:test`、in-app browser。

---

### Task 1: Codex 项目入口与动效规范

**Files:**
- Create: `AGENTS.md`
- Modify: `docs/frontend-ux-guidelines.md`

**Steps:**
1. 把 `CLAUDE.md` 中仍有效的项目身份、secret、分支、验证、部署和运维规则改写成
   Codex 可执行的 `AGENTS.md`。
2. 删除已失效 Claude skill/本地 scraper 用法，纠正仓库 remote 与 CI 事实。
3. 在 UX 规范补入精确 motion tokens、时长、GPU、pointer 与 reduced-motion 规则。
4. review diff，确认不含 secret 和本地绝对路径。

### Task 2: 可测试的 Motion/Scroll 基础设施

**Files:**
- Create: `dashboard/src/lib/motion.ts`
- Create: `dashboard/src/lib/motion.test.mjs`
- Modify: `dashboard/src/lib/scroll.ts`
- Create: `dashboard/src/lib/scroll.test.mjs`

**Step 1 — RED:** 写测试断言：
- `shouldReduceMotion()` 读取 matchMedia 并允许测试注入。
- `shouldCommitDismiss()` 同时支持距离与约 `0.11px/ms` flick，拒绝反向/纵向手势。
- Scroll 时长按距离限制在 120–260ms。
- 后一次滚动会取消同一元素的前一次动画，用户输入可调用 cancel。

**Step 2:** 运行 `node --test src/lib/motion.test.mjs src/lib/scroll.test.mjs`，确认因导出
不存在/行为仍固定 300ms 而失败。

**Step 3 — GREEN:** 实现精确 easing/duration 常量、reduced-motion 判断、dismiss 判定和
每目标单实例的 cancelable scroll controller。

**Step 4:** 重跑测试，确认通过；再跑 `npm run build`。

### Task 3: 移动频道与 Header

**Files:**
- Modify: `dashboard/src/App.tsx`
- Create: `dashboard/src/App.motion.test.mjs`
- Optional delete when unused: `dashboard/src/lib/inkPill.ts`
- Optional delete when unused: `dashboard/src/lib/useFancyAnimation.ts`

**Step 1 — RED:** 源码契约测试断言：
- 不再存在 `transitionActive` 的 220ms 骨架 + 220ms 空遮罩链。
- active pill 不动画 `width/height`，也没有空闲持续 rAF。
- 点击频道直接切换；横滑仍保留双 panel transform 与边界阻尼。
- 横滑不会把隐藏 Header 强制恢复，adjacent top 使用当前 Header 可见比例。

**Step 2:** 运行测试并确认在现有实现上失败。

**Step 3 — GREEN:** 删除胶状双 pill/SVG bridge/idle rAF；单 pill 只动画 transform
160ms。点击直接换 Feed；手势沿用 220ms drawer curve，结束时可重定向。保存当前
Header ratio 给 adjacent panel，不改 Header 状态。

**Step 4:** 测试、build，并在 390px 断点 smoke 点击与横滑。

### Task 4: Pull-to-refresh、Hover 与全局 Reduced Motion

**Files:**
- Modify: `dashboard/src/components/Feed.tsx`
- Modify: `dashboard/src/components/TweetCard.tsx`
- Modify: `dashboard/src/index.css`
- Create: `dashboard/src/components/motion-contracts.test.mjs`

**Step 1 — RED:** 断言 pull 不通过 React state 逐帧更新 `height`；Hover 位移有
fine-pointer gate；reduced-motion 会移除位置移动、spin/pulse 与 smooth scroll。

**Step 2:** 运行并确认失败。

**Step 3 — GREEN:** Pull indicator 使用固定槽，touchmove 直接写 `transform/opacity`；
release 180ms 强 ease-out。图片 Hover 降至 1.01，仅 fine pointer 生效。全局 reduce
模式保留 opacity/color，移除 transform movement 和无限旋转/脉冲。

**Step 4:** 测试、build；移动端验证下拉阈值和刷新状态，PC 验证 Hover。

### Task 5: Drawer 退出与手势

**Files:**
- Modify: `dashboard/src/components/TweetDrawer.tsx`
- Modify: `dashboard/src/components/TweetDrawer.swipe.test.mjs`

**Step 1 — RED:** 增加测试覆盖：flick velocity、multi-touch ignore、直接 DOM transform、
260ms enter/200ms exit、完成退出后才调用业务 `close()`。

**Step 2:** 运行并确认现有 distance-only/React state 实现失败。

**Step 3 — GREEN:** touchstart 记录时间并锁定首指；touchmove 直接写 panel/backdrop；
touchend 使用距离或速度提交，反向可取消。按钮/backdrop 走 200ms exiting，Escape 即时；
取消未完成 timer/animation，避免重复 close。

**Step 4:** 测试、build；PC 点击关闭、移动触控滑动、浏览器返回和 Escape smoke。

### Task 6: Popover、Lightbox、Modal 与 Toast

**Files:**
- Create: `dashboard/src/lib/motionLayer.ts`
- Modify: `dashboard/src/components/UserMenu.tsx`
- Modify: `dashboard/src/components/Lightbox.tsx`
- Modify: `dashboard/src/components/LoginModal.tsx`
- Modify: `dashboard/src/components/ShareDialog.tsx`
- Modify: `dashboard/src/components/QuoteSnapshotModal.tsx`
- Modify: `dashboard/src/components/LogoutConfirm.tsx`
- Modify: `dashboard/src/components/DeleteAccountConfirm.tsx`
- Modify: `dashboard/src/components/AvatarPicker.tsx`
- Modify: `dashboard/src/components/Toast.tsx`
- Modify: `dashboard/src/lib/toast.ts`
- Modify: `dashboard/src/App.tsx`
- Create: `dashboard/src/lib/toast.test.mjs`

**Step 1 — RED:** 测试 Toast entering/leaving/重入；源码契约断言 Popover origin、
Lightbox 200ms、Modal 220/200ms、退出完成再关闭，Escape 即时。

**Step 2:** 运行确认失败。

**Step 3 — GREEN:** 用可取消 CSS state helper 在业务 close 前播放退出。Popover 从头像
方向 `scale(.95)` 160/125ms；Lightbox `scale(.97)+opacity` 200ms；居中 Modal
220/200ms，移动 Bottom Sheet translateY。Toast 用 entering/leaving 状态 160/110ms。

**Step 4:** 测试、build；逐个打开关闭，检查焦点、backdrop、重复触发与 reduced-motion。

### Task 7: PC 多列回顶与最终双端验收

**Files:**
- Modify: `dashboard/src/App.tsx`
- Modify: `dashboard/src/components/Feed.tsx`
- Modify: tests from Task 2/3

**Step 1 — RED:** 断言品牌点击只平滑回顶最近交互列，其余列即时或可取消；active tab
回顶使用距离自适应时长。

**Step 2 — GREEN:** Feed handle 记录最近交互；scroll controller 确保每目标只有一个
animation，pointer/wheel/touch 可取消，reduce 模式即时。

**Step 3 — Automated verification:**
- `node --test src/lib/*.test.mjs src/components/*.test.mjs`
- `npm run build`
- 针对本次改动文件运行 ESLint，记录但不混淆 main 的既有 lint debt。

**Step 4 — Browser verification:**
- PC：多列独立滚动、Logo 回顶、UserMenu、Drawer、Lightbox、Modal、Toast。
- 390px：Header 隐显、频道点击/横滑、active tab 回顶、pull refresh、Drawer 滑关。
- Reduced Motion：系统媒体查询与演示切换均无位置移动/无限旋转。
- 真机门槛：iOS Safari、Android Chrome、微信内置浏览器补 TouchEvent 与帧率验收。

### Task 8: 性能慢根因报告（只读，不修）

**Files:**
- Create: `docs/reviews/2026-07-10-c-end-performance-root-cause.md`

**Steps:**
1. 读取近 7–14 天 D1 `perf_nav/perf_fcp/perf_lcp/perf_img` 分位、冷首开/SW、网络和
   设备切片；只执行 SELECT。
2. 对比生产主域、Pages 源站、生产 API 和 staging API 的 DNS/TCP/TLS/TTFB/下载。
3. 对照 `index.html` 预取、Service Worker、香港 nginx 双跳和首屏 eager 图片策略。
4. 写“证据 → 假设 → 排除 → 根因 → 后续验证建议”，明确不在本分支改性能架构。
