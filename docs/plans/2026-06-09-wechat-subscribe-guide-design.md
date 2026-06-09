# 微信内订阅引导（关注公众号）设计

> 2026-06-09 · feat/wechat-subscribe-guide · 纯前端改动（含静态资源）

## 背景

`/subscribe` 页第一步是「邮箱 + Cloudflare Turnstile 人机校验」一键订阅。微信内置浏览器
（WeChat WKWebView / Android X5）对 Turnstile 很不友好，校验经常过不去 → 微信里邮箱订阅
基本是死路。原先只在登录弹窗加了一条「请用 Safari 打开」的黄条提示，订阅页没处理。

## 方案

微信内置浏览器（UA 含 `MicroMessenger`）访问 `/subscribe` 时，整页改为引导用户**长按二维码
关注公众号「AI Feeds」**（每早收 AI 日报），不再出现邮箱 / Turnstile / 验证码。非微信环境
（Safari / Chrome 等）完全不变，照旧走邮箱 + Turnstile 一键订阅。

订阅流程本就是匿名的（不挂 `requireAuth`），微信里不存在「点订阅弹登录」；登录弹窗
`LoginModal` 是另一条路（语义是登录账号，非订阅），本次不改其行为。

## 改动文件

| 文件 | 改动 |
|------|------|
| `dashboard/src/lib/wechat.ts` | 新增。`isWeChatBrowser()` 共享检测（从 LoginModal 提取，两处复用） |
| `dashboard/src/components/WechatFollowGuide.tsx` | 新增。引导卡片组件（公众号名片 + 二维码 + 往期日报横划） |
| `dashboard/src/pages/Subscription.tsx` | `AnonymousSubscribe` 所有 hooks 之后 early return：微信 → `<WechatFollowGuide />` |
| `dashboard/src/components/LoginModal.tsx` | 删本地 `isWeChatBrowser`，改 `import` 共享函数（行为不变） |

## 静态资源（放 `public/`，随 CF Pages 部署）

- `public/wechat-qr.png` — 公众号关注二维码（中心带胡萝卜 logo，60KB）
- `public/digest/digest-00.webp … digest-10.webp` — 往期日报封面 + 内页 11 张（横划预览，
  从 06-09 当期截图压成 600×800 webp，共 292KB）。图片不常更换，换期时覆盖同名文件即可。
- 公众号名片头像复用现有 `/favicon.svg`（胡萝卜钓竿 logo），不新增。

## 卡片结构与文案（包装成「公众号账号」形态）

- 标题：**关注公众号，每早看 AI 日报**
- 公众号名片：`[logo]` **AI Feeds** `✓ 公众号` + 简介「聚合 X、Product Hunt、GitHub、arXiv 等 AI 资讯精华」
- 二维码 + **长按二维码关注**（微信内长按图片即识别关注）
- **往期日报 ↓** + 11 张横划预览（第一张米色封面，后为内页条目）

视觉对齐站点 neutral 色阶 + 圆角卡片 + HarmonyOS Sans SC，图标手写 lucide path（不用 emoji）。

## 验证（dev server + 真实 Chrome 移动端模拟）

- `vite build` 编译打包通过（`tsc -b` 被并行 session 的 `types.ts` WIP 挡住，与本改动无关）
- 微信 UA：走引导分支（`isWxBranch:true`）；普通 UA：原邮箱表单不变
- 无横向溢出：`document.scrollWidth === viewportWidth === 390`，简介完整未裁剪
- 真实 Chrome `emulate` 390×844 移动端 fullPage 截图视觉正常

## mockup

`docs/plans/_mockups/2026-06-09-wechat-subscribe-guide.html`（含 `_assets/`，设计存档）

## 不改的部分

非微信订阅流程、登录弹窗 `LoginModal`、订阅管理页 `ManageSubscription`、`SubscribeBanner`
（微信里点「立即订阅」仍 `navigate('/subscribe')`，由页面按 UA 切内容）。
