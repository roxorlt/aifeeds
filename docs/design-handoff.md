# AI-Feeds Design Handoff

> 给 Claude Code CLI 用的设计决策摘要。把本文档放到代码库 `docs/design-handoff.md`（或随便哪里），让 CC 直接读。

最后更新：通过 Claude Design 项目 `019e0c54-0553-7374-9fb9-648fba6c25c1` 同步。

---

## 1. 品牌色 · 当前方向

**走法 B —— 全 UI 黑白灰，橙只活在 logo 里。**

- UI 主色：`neutral-900 / 950 / 600` 系灰阶（保持代码库现有 `_card.css` 的中性栈）
- 唯一彩色：链接 `sky-600` (`#0284c7`) — 已在 `dashboard/src/index.css` 使用
- 危险态：`rose-600` (`#e11d48`) — 仅注销账号、删除等不可逆按钮
- 品牌色 `#FF8A00`（胡萝卜橙）**只用于 logo 本身**，不进 UI 元件
- 暗色模式：未做，等需要时再说

**不要做的事**：把橙色用在主按钮、激活 chip、图标 hover 等任何 UI 元件上。

## 2. 字体 · 选定 HarmonyOS Sans SC

**最终 font stack**：
```css
font-family:
  "HarmonyOS Sans SC", "HarmonyOS_Sans_SC_Regular",
  -apple-system, BlinkMacSystemFont, "Segoe UI",
  "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
```

需更新的文件：`dashboard/src/index.css` 的 `:root { font-family: ... }`。

权重档位：400 (Regular) / 500 (Medium) / 700 (Bold) 三档够用，不要引入更多。

### 上线方案：Cloudflare R2 自托管 + 子集化（用户已选定）

**目标**：保障终端用户首屏速度，国内访问也快。

让 Claude Code 按以下步骤执行（操作主要在终端 + Cloudflare dashboard 里）：

#### 步骤 1 — 下载 HarmonyOS Sans SC 原始字体
从 [华为官方](https://developer.huawei.com/consumer/cn/design/resource) 或 [chinese-fonts-cdn 仓库](https://github.com/wsa-2019/chinese-fonts-cdn) 拿到 Regular / Medium / Bold 三档的 ttf / otf 原始文件。

#### 步骤 2 — 用 cn-font-split 做子集化
[cn-font-split](https://github.com/KonghaYao/cn-font-split) 会把每档字体按 unicode-range 切成几十个 ~50KB 的小 woff2 + 一份 css。浏览器只下载用到的字符块。

```bash
# 在 aifeeds 项目里
bunx cn-font-split path/to/HarmonyOS_Sans_SC_Regular.ttf -o public/fonts/hmos-regular
bunx cn-font-split path/to/HarmonyOS_Sans_SC_Medium.ttf  -o public/fonts/hmos-medium
bunx cn-font-split path/to/HarmonyOS_Sans_SC_Bold.ttf    -o public/fonts/hmos-bold
```

每个目录会生成 ~30-50 个 `.woff2` + 一份 `result.css`。三档加起来通常 4–6 MB，但实际单页只下载 ≈ 200 KB。

#### 步骤 3 — 上传到 Cloudflare R2

1. CF dashboard → R2 → 新建 bucket（比如 `ai-feeds-fonts`）
2. 把上一步生成的所有 `.woff2` 和 `result.css` 拖进去
3. bucket 设置 → Public Access → 绑定子域 `fonts.ai-feeds.com`（在 R2 settings 里点 Connect Custom Domain）
4. CORS 配置允许 `https://ai-feeds.com` 跨域

#### 步骤 4 — 调整 css 里的字体路径

`cn-font-split` 生成的 `result.css` 里的字体路径默认是相对的，CC 需要把它们改成 `https://fonts.ai-feeds.com/...` 完整路径。或者直接把每档目录整个传到 R2 同名子目录，相对路径仍然有效。

#### 步骤 5 — index.html 引入

```html
<link rel="preconnect" href="https://fonts.ai-feeds.com" crossorigin>
<link rel="stylesheet" href="https://fonts.ai-feeds.com/hmos-regular/result.css">
<link rel="stylesheet" href="https://fonts.ai-feeds.com/hmos-medium/result.css">
<link rel="stylesheet" href="https://fonts.ai-feeds.com/hmos-bold/result.css">
```

#### 步骤 6 — 验证

- Chrome devtools → Network → Font，应当只下载几个 50KB 左右的小 woff2
- Lighthouse → 看 LCP 没有被字体阻塞
- 用国内 [PageSpeed China](https://www.itdog.cn/http/) 等工具检查国内访问速度

**回退**：如果某步骤遇到问题，CC 可以临时改成方案 A（直接用 chinese-fonts-cdn 的公共 CDN）作为兜底，链接如下：

```html
<link rel="stylesheet" href="https://chinese-fonts-cdn.deno.dev/packages/hmos/dist/HarmonyOS_Sans_SC_Regular/result.css">
<link rel="stylesheet" href="https://chinese-fonts-cdn.deno.dev/packages/hmos/dist/HarmonyOS_Sans_SC_Medium/result.css">
<link rel="stylesheet" href="https://chinese-fonts-cdn.deno.dev/packages/hmos/dist/HarmonyOS_Sans_SC_Bold/result.css">
```

## 3. 图标库 · lucide 风格 + X 平台 SVG

- 通用 UI 图标：lucide-react 风格的线性图标（已经在 `dashboard/src/components/icons.tsx` 自绘）
- X 平台原生图标（IconReply / IconRetweet / IconHeart / IconEye）：保留现有填充图样式，匹配 X 视觉
- 刷新交互：**只有下拉刷新**，没有按钮。沿用 `Feed.tsx` 用的 `⟳` Unicode 字符 + `animate-spin`

## 4. Logo

- 主图标：`ai-feeds_logo_rounded_*.svg`（rounded square）— app bar、应用图标
- 圆形：`ai-feeds_logo_circle_*.svg` — favicon、avatar 场景
- 方形：`ai-feeds_logo_square_*.svg` — 仅当外层容器自己裁剪时用
- 导出预设：24 / 32 / 48 / 64 / 96 / 128 / 256 / 512 八档 PNG，加一份 SVG 矢量源

## 5. AppBar 组件约定

- 没有右上角刷新按钮（已删）
- 结构：logo + "AI-Feeds" + slogan「专注 AI 领域信息聚合」+ 移动端 chips + UserMenu
- 移动端 chips 等宽 grid 布局（`repeat(7, 1fr)`），不是横向 scroll
- 顺序按 `App.tsx SOURCE_COLUMNS`：X List → ClawHub → GitHub → Product Hunt → YouTube → Podcast → arXiv

## 6. 登录 · 单一弹窗（无密码）

参考 `LoginModal.tsx`：邮箱 + 验证码 + Cloudflare Turnstile，登录注册一体，不分流。

## 7. 边界声明（哪些不归"设计决策"管，但 CC 依然要做）

**这一节定义的是 Claude Design 这边不参与的部分，不是 CC 不做的部分。** CC 仍然按产品需求正常开发以下内容，只是不需要回到 Claude Design 来确认视觉方案：

- **图片 / 媒体优化** — CC 正常开发，使用 Cloudflare Images 服务做缩放、格式转换、CDN 分发。视觉规范（圆角、占位图样式、loading 状态）按本文档第 5 节 / `frontend-ux-guidelines.md` 执行即可，不需要专门走 Claude Design。
- **blog.ai-feeds.com 子站** — 独立的开源播客项目，有自己的 UI 体系，CC 按那边项目自己的规范开发，不沿用本文档。
- **暗色模式** — 暂缓，等用户反馈再做。CC 现在不要主动加。
- **幻灯片 / 营销页面模板** — 当前不需要。

---

## 给 Claude Code 的使用建议

1. ✅ 已放在 `aifeeds/docs/design-handoff.md`（2026-05-10 项目重命名后从 Downloads 迁入）
2. 在 `aifeeds/CLAUDE.md` 顶部 / 「前端 UX 规范」节加一行：
   ```md
   设计决策见 docs/design-handoff.md，做 UI 改动前先读。
   ```
3. 如果设计决策有更新，回来 Claude Design 让我重写这份文档，再下载替换。
