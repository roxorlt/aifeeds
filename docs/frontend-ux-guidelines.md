# 前端 UX 规范（前端设计基线）

> 适用范围：`dashboard/` 下所有前端代码（React + Tailwind v4）。
> 基线：以 X List 卡片（`TweetCard.tsx`）的视觉风格为整站标准，其他源（GitHub / Drawer / 弹窗 / 设置页 / 未来源）向它对齐。
> 维护：每次新写或修改前端组件之前，先读这份规范。新规则在产生时同步写入。
> 引用：见 `CLAUDE.md`「Skill routing / 前端 UX 规范」章节。

---

## 一、设计原则

1. **内容优先，UI 沉静**。UI 元素本身不抢眼球，让内容（推文 / repo / 卡片正文）站 C 位。
2. **最小色彩**。整站基调 = `neutral` 灰阶 + 单一品牌色（`neutral-900` 作为主按钮 / 强调）。状态色（rose / amber / emerald / sky）只用在反馈性元素，不用在主结构。
3. **统一边框**。卡片 / 输入框 / 分隔用 `border-neutral-200`。`border-neutral-100` 仅用在更细的内部分隔（如下拉菜单 item 之间）。
4. **不用阴影做层级区分**。卡片用 `border-b` 分隔，不加 `shadow`。模态 / 下拉才用 `shadow-xl` / `shadow-lg`。
5. **Hover 用透明度叠加**。`hover:bg-neutral-50/60`，不用全色 fill。
6. **状态色家族化**。一个反馈用一个色家族（rose 系或 amber 系），不要 rose-50 + rose-600 + amber-700 混着用。

---

## 二、Design Tokens

### 颜色

| Token | 用途 | Tailwind |
|---|---|---|
| 全站背景 | body | `bg-neutral-50`（在 index.css 设置） |
| 卡片背景 | 容器 | 默认透明（让 body 透出），需要显式时 `bg-white` |
| 文字主色 | 标题 / 主体 | `text-neutral-900` |
| 文字次要 | meta / 时间 / handle | `text-neutral-500` |
| 文字辅助 | placeholder / 不可点 | `text-neutral-400` |
| 文字弱化 | 极小说明 | `text-neutral-400` 或 `text-[11px] text-neutral-500` |
| 边框 | 卡片 / 输入 / 分隔 | `border-neutral-200`（极少 `border-neutral-300`） |
| 主按钮 | 主 CTA | `bg-neutral-900 text-white hover:bg-neutral-800` |
| 次按钮 | 次 CTA / 取消 | `border border-neutral-300 text-neutral-700 hover:bg-neutral-50` |
| 危险按钮 | 注销 / 删除 | `bg-rose-600 text-white hover:bg-rose-700` |
| Hover 容器 | 卡片悬停 | `hover:bg-neutral-50/60` |
| 链接 / 行内 action | 「展开」「打开原文」 | `text-sky-600 hover:underline` |

### 状态色（仅反馈区使用，禁止用于主结构）

| 用途 | 行内（紧挨输入） | 块状（独立 alert 区） |
|---|---|---|
| 错误 | `text-xs text-rose-600` | `bg-rose-50 px-3 py-2 text-sm text-rose-700` |
| 警告 | `text-xs text-amber-600` | `bg-amber-50 px-3 py-2 text-sm text-amber-700` |
| 成功 | `text-xs text-emerald-600` | `bg-emerald-50 px-3 py-2 text-sm text-emerald-700` |

> ⚠️ **破例：搜索命中高亮**。搜索结果卡片里命中 query 的文案标红，用 `<mark class="bg-transparent text-rose-600 font-medium">`（`bg-transparent` 消掉 `<mark>` 默认黄底）。rose 常规仅用于错误态，这里破例作「搜索命中」语义色——命中高亮是结果页专属、瞬时且信息性的强调，不属于主结构，与"错误"语境不会同屏混淆。实现见 `dashboard/src/components/search/highlight.tsx`（Context 注入：feed 不注入 → 零高亮，搜索页注入 terms → 命中标红）。

### 字号

| Token | 用途 | Tailwind |
|---|---|---|
| 页面标题 | h1 / banner | `text-xl font-semibold` |
| 模态标题 | modal h2 | `text-lg font-semibold` |
| 卡片标题 | author / repo name | `text-[15px] font-bold` |
| 正文 | tweet 文本 / 描述 | `text-[15px]`（推文）或 `text-[13px]`（描述）|
| 元信息 | meta（@handle / 时间 / 数据） | `text-[13px] text-neutral-500` |
| 表单 label | label | `text-sm text-neutral-700` |
| 表单 input value | 移动端键盘必须 ≥ 16px 防 iOS 缩放 | `text-base` |
| 表单 input placeholder | 视觉不抢眼，比 input value 小一档 | `placeholder:text-sm placeholder:text-neutral-400` |
| 极小辅助 | 标签内 / footer / 链接补充 | `text-[11px]` 或 `text-xs` |

> ⚠️ 移动端表单输入框必须用 `text-base`（≥ 16px），iOS Safari 在小于 16px 时会自动 zoom-in，体验差。但 placeholder **可以**单独缩成 `text-sm`（CSS `::placeholder` 字号缩小不会触发 iOS 缩放），让占位文本不抢戏。

### 间距

| Token | 用途 |
|---|---|
| 卡片内 padding | `px-4 py-3`（标准）|
| 卡片间隔 | `border-b border-neutral-200`（**不用 margin / gap**）|
| 元素行间 | `gap-2`（默认）/ `gap-3`（容器内更松）/ `gap-1.5`（紧凑列表）|
| Section 间 | `mb-6` 或 `mt-6` |
| Modal / Settings 区块间 | `mb-8` |
| 头像 + 内容 | `gap-3` |

### 圆角

| 用途 | Tailwind |
|---|---|
| 输入框 / 按钮 / 卡片次级容器 | `rounded-md` |
| 模态 / 大卡片 | `rounded-xl` |
| 头像 / 徽章 / 圆点 / 标签 | `rounded-full` |

### 阴影

| 用途 | Tailwind |
|---|---|
| 卡片 | 不用（用 border-b 分隔）|
| 模态 | `shadow-xl` |
| 下拉菜单 / Popover | `shadow-lg` + `border border-neutral-200` |

### 头像

| 用途 | Tailwind |
|---|---|
| 卡片主头像（推文 / repo） | `h-10 w-10 rounded-full bg-neutral-200` |
| 设置页 / Profile 大头像 | `h-12 w-12` 或 `h-14 w-14` |
| 用户菜单（顶栏） | `h-8 w-8` |
| 紧凑列表（contributors） | `h-5 w-5 -space-x-1.5 border-2 border-white` |
| Loading / 失败 fallback | `bg-neutral-200` 占位 |

### 转场

- 全局默认仍用 `transition-colors`，禁止 `transition-all`。
- 只动画 `transform` 与 `opacity`；不要动画 `width / height / margin / padding / top / left`。
- 进入/退出：`cubic-bezier(0.23, 1, 0.32, 1)`；在屏位置移动：
  `cubic-bezier(0.77, 0, 0.175, 1)`；Drawer：
  `cubic-bezier(0.32, 0.72, 0, 1)`。
- 高频频道/搜索/排序直接响应，不用骨架或页面转场模拟等待。小 Popover 125–200ms，
  Dropdown 150–250ms，Modal/Drawer 200–500ms，普通 UI 必须低于 300ms。
- Popover 从触发器方向设置 `transform-origin`，使用 `scale(.95–.97)+opacity`，禁止
  `scale(0)`；居中 Modal 保持 center origin。
- 触控手势必须跟手、可中断，支持速度阈值、边界阻尼和多指保护；业务 close 在退出完成后执行。
- `prefers-reduced-motion` 下保留 opacity/color，移除位移、旋转、脉冲和平滑滚动。
- Hover 位移必须放在 `@media (hover: hover) and (pointer: fine)` 中。
- 键盘高频动作不等待动画，例如 Escape 立即关闭 Lightbox/Drawer。

---

## 三、组件规范

### 按钮

**主按钮（Primary CTA）**：
```html
<button class="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40">
  登录
</button>
```

**次按钮（Secondary）**：
```html
<button class="rounded-md border border-neutral-300 px-3 py-1.5 text-sm font-medium text-neutral-700 hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-50">
  取消
</button>
```

**危险按钮（Danger，仅用于独立破坏入口）**：
```html
<button class="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-40">
  立即删除
</button>
```

> ⚠️ **rose-600 的使用边界**：仅用于"列表行直接发起破坏的按钮"或"确认 dialog 之外的一次性危险操作"。
>
> **破坏性 confirm 弹窗里的主操作按钮（如「确认注销」「确认删除」）一律用主按钮 `bg-neutral-900`**——dialog 标题 + 描述 + 「确认 X」三层文字已经传达了警示语义，按钮再涂红反而过度报警，也违背"破坏性操作菜单入口应弱化、不引导用户"的原则。rose 留给警示文字（`text-rose-700`）和错误提示（`text-rose-600`）。
>
> 反例：以前的 `<button class="bg-rose-600">确认注销</button>` 把 confirm 按钮涂红。现在 confirm dialog 主按钮改成黑色 `bg-neutral-900`，与登录、退出弹窗保持一致。

> ⚠️ disabled 状态用 `opacity-40` 而不是 `bg-neutral-300` / `bg-rose-300`：低饱和灰色在白底上对比度不足（≈1.6:1，低于 WCAG AA 4.5:1），用户分不清按钮在哪。`opacity-40` 保留按钮原色作为视觉锚点，且保证 disabled 含义清晰。

> 💡 **菜单入口弱化**：列表里的破坏性入口（如"注销账号" row）用 `text-neutral-500`（甚至更淡），不要 `text-rose-600`。把强警示留给确认弹窗的文案。

**图标按钮（顶栏 / 关闭 ✕ / 收起）**：
```html
<button class="rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100" aria-label="关闭">
  ✕
</button>
```

> ❌ 禁止使用 `bg-blue-600`、`bg-indigo-500`、`bg-purple-500` 等彩色作为主按钮背景。蓝紫绿等品牌色不属于本站调色板。

### 输入框

```html
<label class="mb-1 block text-sm text-neutral-700">手机号</label>
<input
  type="tel"
  placeholder="请输入手机号"
  class="w-full rounded-md border border-neutral-300 px-3 py-2 text-base placeholder:text-sm placeholder:text-neutral-400 focus:border-neutral-900 focus:outline-none disabled:bg-neutral-50 disabled:text-neutral-500"
/>
{error && <p class="mt-1 text-xs text-rose-600">{error}</p>}
```

- placeholder 文案：「请输入...」/「请先获取...」（**不要写示例值**如「13800001234」）
- focus border 用 `border-neutral-900`，不用蓝色
- 错误提示**紧挨输入框下方**（`mt-1`），不要堆到表单底部统一显示
- 错误样式：`text-xs text-rose-600`（行内提示，不要加背景）
- 大块错误（如 API 整体失败）才用 `bg-rose-50 px-3 py-2 text-sm text-rose-700`

### 卡片

```html
<article class="cursor-pointer border-b border-neutral-200 px-4 py-3 transition-colors hover:bg-neutral-50/60">
  <div class="flex gap-3">
    <img class="h-10 w-10 shrink-0 rounded-full bg-neutral-200 object-cover" />
    <div class="min-w-0 flex-1">
      <div class="text-[15px] font-bold text-neutral-900">标题</div>
      <div class="text-[13px] text-neutral-500">meta</div>
      <p class="mt-2 text-[15px] text-neutral-900">正文</p>
    </div>
  </div>
</article>
```

- **不要** `bg-white`（让 body `neutral-50` 透出）
- **不要** `rounded`（feed 是连续列表）
- **不要** `shadow`
- 用 `border-b border-neutral-200` 做分隔
- hover 用 `hover:bg-neutral-50/60`

### 模态（Modal / Dialog）

```html
<div class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
  <div class="w-full max-w-sm rounded-xl bg-white p-6 shadow-xl" onclick="stopPropagation">
    <header class="mb-4 flex items-center justify-between">
      <h2 class="text-lg font-semibold text-neutral-900">登录 / 注册</h2>
      <button class="-mr-2 rounded-md px-2 py-1 text-neutral-500 hover:bg-neutral-100" aria-label="关闭">✕</button>
    </header>
    <!-- content -->
  </div>
</div>
```

- backdrop：`bg-black/40`
- 内层最大宽度：`max-w-sm`（窄表单）/ `max-w-md`（中等）/ `max-w-2xl`（设置类宽页）
- 圆角 `rounded-xl`，padding `p-6`
- 内层加 `onClick={(e) => e.stopPropagation()}`，防点 backdrop 误关

### 下拉菜单 / Popover

```html
<div class="absolute right-0 z-30 mt-2 w-56 rounded-lg border border-neutral-200 bg-white py-1 shadow-lg">
  <div class="border-b border-neutral-100 px-3 py-2">
    <!-- 头部信息 -->
  </div>
  <button class="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50">⚙ 设置</button>
  <button class="block w-full px-3 py-2 text-left text-sm text-neutral-700 hover:bg-neutral-50">↩ 退出登录</button>
</div>
```

- 圆角：`rounded-lg`（比卡片 md 稍大）
- 内部 item 间用 `border-b border-neutral-100` 区分头部 vs 操作
- item 文字 `text-sm text-neutral-700`，hover `bg-neutral-50`

### Tag / 徽章

**通用极简徽章**（首选）：
```html
<span class="rounded-full bg-neutral-100 px-2 py-0.5 text-[11px] font-medium text-neutral-700">tag</span>
```

**分类彩色徽章**（仅当业务真需要色彩区分时，如 GH category / 状态枚举）：
- 限定单一色家族：例如 `bg-violet-100 text-violet-700`
- 不要在同一视图同时出现 5+ 种 hue（站点视觉碎片化）
- GitHub language dot 是平台标识（Python blue / Rust orange...）属于例外，**保留**

### 链接 / 行内交互

```html
<a class="text-sky-600 hover:underline">链接</a>
<button class="text-xs text-neutral-500 hover:text-neutral-700">辅助文字按钮</button>
```

- 主链接：`text-sky-600 hover:underline`（克制使用，不要遍地蓝色）
- 文字按钮（"展开 / 重发 / 取消"次级 action）：`text-neutral-500 hover:text-neutral-700`

---

## 四、Form 模式

完整登录表单的标准结构：

```html
<header class="mb-4 flex items-center justify-between">
  <h2 class="text-lg font-semibold">标题</h2>
  <button aria-label="关闭">✕</button>
</header>

<label class="mb-1 block text-sm text-neutral-700">字段 1</label>
<div class="flex gap-2">
  <input class="flex-1" />
  <button>action</button>
</div>
{error1 && <p class="mt-1 text-xs text-rose-600">{error1}</p>}

<label class="mb-1 mt-3 block text-sm text-neutral-700">字段 2</label>
<input class="w-full" />
{error2 && <p class="mt-1 text-xs text-rose-600">{error2}</p>}

<button class="mt-4 w-full bg-neutral-900">提交</button>

<p class="mt-4 text-center text-[11px] text-neutral-500">辅助文字</p>
```

- label 用 `mb-1 block text-sm text-neutral-700`
- 错误紧挨输入框（`mt-1 text-xs text-rose-600`）**不要** 堆到表单底部
- 标签 + 输入框之间不用 `mb-3`（让错误紧凑），用 `mt-3` 在下一个 label 上
- 主按钮 `mt-4 w-full`

---

## 五、当前不一致清单（follow-up，按优先级）

> 列表里的项不阻塞当前 PR3 完成。规范文档落地后，逐项 PR 整改对齐。

### 高优先级（视觉违和明显）

- **`GithubCard.tsx` meta 字号**：`text-[12px]` → 应该改 `text-[13px]` 与 TweetCard 对齐
- **`GithubCard.tsx` 容器**：`px-4 py-4` → 应该改 `px-4 py-3` 与 TweetCard 对齐
- **`GithubCard.tsx` hover 透明度**：`hover:bg-neutral-50/50` → 改 `/60`
- **`GithubCard.tsx` 显式 `bg-white`**：移除（让 body 透出）

### 中优先级（色彩家族）

- **`GithubCard.tsx` 分类徽章** 同时使用 violet / rose / blue / orange / emerald / amber 6 种 hue，与全站 neutral 风格分裂。**讨论方向**：
  - a) 全部归约为单一色家族（如统一 `bg-neutral-100 text-neutral-700`，分类用文字而非颜色识别）
  - b) 保留色彩但收敛到 2-3 个 hue（如 agent/model 用 violet，tool/infra 用 blue，其他用 neutral）
  - c) 保留全色（如果业务上分类色感对用户辨识有帮助）
  
  → 待决定，作为 follow-up

### 低优先级（精细打磨）

- `TweetDrawer.tsx`：未审计，找时间扫一遍
- `GithubDrawerBody.tsx`：README 渲染样式 vs 卡片样式一致性
- `Lightbox.tsx`：是否符合 modal 规范
- `Settings.tsx` 的「危险区」`bg-rose-50/50` 边框 — 是否需要改成更明显的 `border-rose-200 bg-rose-50`

### 已对齐（PR3 内）

- ✅ `LoginModal.tsx` — 主按钮 `bg-neutral-900`、错误紧挨输入框、placeholder 用「请输入」、字号统一
- ✅ `UserMenu.tsx` — 登录按钮 `bg-neutral-900`、下拉 `shadow-lg border border-neutral-200`
- ✅ `DeleteAccountConfirm.tsx` — 危险按钮 `bg-rose-600`
- ✅ `Settings.tsx` — 主体结构

---

## 六、新增组件 checklist

写新前端组件 / 改现有组件时，对照本规范过一遍：

- [ ] 颜色：仅用本规范列出的 token，不引入新 hue
- [ ] 字号：按规范的 token，不出现 `text-[14px]` 等离群值
- [ ] 间距：卡片 `px-4 py-3`，表单 label `mb-1`，section `mb-6 / mb-8`
- [ ] 边框：`border-neutral-200`（少数 300）
- [ ] 圆角：`rounded-md`（小）/ `rounded-xl`（模态）/ `rounded-full`（圆）
- [ ] 按钮：3 种 variant 之一（primary / secondary / danger），不自创
- [ ] Hover：用透明度叠加（`hover:bg-neutral-50/60`），不要换主色
- [ ] 错误：行内紧挨输入框（`mt-1 text-xs text-rose-600`）
- [ ] 移动端：input 用 `text-base`（≥ 16px 防 iOS zoom）
- [ ] 阴影：卡片不用，模态 `shadow-xl`，下拉 `shadow-lg`
- [ ] 转场：不用 `transition-all`；位移动效仅 `transform/opacity`，并覆盖 reduced-motion

如果业务确实需要规范外的元素（新色 / 新字号 / 新组件），先在本文档讨论 + 加进去，再实施。
