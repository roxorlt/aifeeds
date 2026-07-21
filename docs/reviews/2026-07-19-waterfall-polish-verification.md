# 2026-07-19 瀑布流精修验证

## 范围

本轮验证覆盖：

- 设备视图选择在刷新、冷启动及 Service Worker 控制下保持；
- 移动端上推收起、下拉展示顶栏，PC 保持 sticky；
- 第一张真实封面优先加载、图片域预连接、400/800 响应式候选；
- 精致内容社区卡片视觉；
- 2/3/4/5/6 列布局、失败图片收紧、无横向溢出和 CLS 预算。

## 自动验证

### 基线

新工作树基于生产 `origin/main`：

```text
cec2edd65afa758dc6882951c0262ae612d6c8d1
```

改动前：

```text
npm run test:unit
352 passed, 0 failed
```

### 红绿证据

持久化与顶栏聚焦测试在实现前出现 3 个预期失败：

- 首页仍被 Service Worker 导航壳拦截；
- `WaterfallShell` 没有滚动方向接线；
- `waterfallHeader.ts` 尚不存在。

实现后：

```text
node --test src/archiveLinks.contract.test.mjs \
  src/home/home-ui.contract.test.mjs \
  src/home/waterfallHeader.test.mjs
14 passed, 0 failed
```

真实封面优先级与预连接测试在实现前出现 2 个预期失败，实现后：

```text
node --test src/home/waterfallMedia.test.mjs \
  src/home/home-ui.contract.test.mjs
11 passed, 0 failed
```

响应式封面测试在实现前出现 3 个预期失败，实现后：

```text
node --test src/home/homeData.test.mjs \
  src/home/home-ui.contract.test.mjs
19 passed, 0 failed
```

视觉契约在实现前因 10px 平面卡片和缺少媒体状态类而失败，实现后：

```text
node --test src/home/home-ui.contract.test.mjs \
  src/home/waterfallCardModel.test.mjs
14 passed, 0 failed
```

### 完整门禁

```text
npm run test:unit
365 passed, 0 failed

npm run lint
exit 0

npm run build:ssr
exit 0
home_build_identity=6b02081b314f...
waterfall CSS=6.86 kB / gzip 2.03 kB
waterfall JS=20.82 kB / gzip 7.77 kB
```

本地边缘 fixture 以生产构建和 SSR renderer 运行，最终浏览器矩阵：

```text
WATERFALL_E2E=1 npx playwright test e2e/waterfall-home.spec.ts
45 passed
```

最终发布前于 2026-07-19 重跑同一组门禁；365/365 单测、lint、SSR build 与 45/45
五设备浏览器矩阵全部通过。新增的 3 项单测覆盖 Nginx 图片格式缓存执行与回滚契约。

独立合入前审阅发现 Service Worker 只放行 `/`、回滚未校验激活后精确 SHA 两个 Important。
补充失败测试后，SW v6 放行全部有限 home-experience 深链；apply 记录 `activated.sha256`，
rollback 对当前配置做精确校验并在失败时恢复 rescue 配置、输出 `rollback_failed`。修复后的
最终复验仍为 365/365 单测、lint 0、SSR build `6b02081b314f...` 与五设备 Playwright 45/45。

设备：

- Desktop Chromium，1440×900；
- Tablet Chromium，820×1180；
- iPhone Chromium，390×844；
- iPhone WebKit，390×844；
- Android Chromium，412×915。

矩阵逐设备验证：

- JS 关闭时 SSR 仍有 12 张卡；
- 无控制台错误；
- 2/3/4/5/6 列匹配断点；
- CLS ≤ 0.1；
- 无横向溢出；
- 最大纵向视觉间距 < 17px；
- 首张真实图片为 `eager/high`；
- 400/800 `srcset` 与 API `preconnect` 存在；
- 移动顶栏上推隐藏、下拉恢复，PC 不隐藏；
- Service Worker 控制后的新页面仍由 Cookie 返回 waterfall SSR；
- Service Worker 控制后的 `/t/*` 详情深链刷新仍由 Cookie 返回 waterfall SSR；
- 图片失败后卡片消失且网格重新收紧；
- 减弱动效、键盘切换、加载更多、详情 Drawer 和 API fail-open 保持正常。

## 人工视觉检查

Playwright CLI 在 1440×1000 和 390×844 下截图检查：

- PC 五列没有侧栏和分类 Tab；
- 移动端保持双列；
- 图片卡以封面为第一层级，图片下方身份、标题、摘要层级清楚；
- 纯文字卡使用更完整摘要，不因没有封面形成大块空白；
- 来源图标、身份、时间与热度信息弱于标题；
- 12px 圆角、轻边框和双层浅阴影提供卡片分割，不形成厚重浮层；
- 卡片仍保持 8px 网格密度；
- 顶栏、视图入口和搜索在移动端没有挤压内容列。

本地截图（测试产物，不纳入 Git）：

```text
dashboard/output/playwright/waterfall-polish-desktop.png
dashboard/output/playwright/waterfall-polish-mobile.png
dashboard/output/playwright/waterfall-polish-mobile-header-hidden.png
```

## 生产图片根因

2026-07-19 只读核对香港 VPS 的实际 `/img` 配置，当前缓存键是：

```nginx
proxy_cache_key "$scheme$request_method$host$request_uri";
```

它没有包含格式桶。Worker 会根据 `Accept` 选择 AVIF/WebP 并返回 `Vary: Accept`，但外层 Nginx
可能先被不带现代图片 Accept 的客户端写入 JPEG，之后把相同 URL 的 JPEG 返回给支持 AVIF/WebP
的浏览器。生产抽样中，带现代浏览器 Accept 的请求仍命中约 152KB JPEG，确认不是前端主观感觉。

前端响应式候选和预连接已随 PR `#200` 上线。后续生产清单已完成 Nginx 格式缓存桶和
Cloudflare 图片转换上游修复；正式 `/img` 当前分别返回约 10KB AVIF、11KB WebP 和 12KB JPEG，
并能按格式独立 MISS→HIT。完整根因和回滚证据见
[`2026-07-19-production-image-transform-root-cause.md`](./2026-07-19-production-image-transform-root-cause.md)。

## 生产完成证据

- PR `#200` 合入 `main`：`5b93e99`；
- Dashboard production workflow：`29679356914`，成功；
- 生产构建身份：`6b02081b314f...`；
- Desktop Chromium、Tablet Chromium、iPhone Chromium、iPhone WebKit、Android Chromium
  五设备生产冒烟均通过；
- desktop 为 5 列、tablet 为 3 列、移动端为 2 列，首屏分别得到 24 张卡和真实封面；
- 移动端顶栏上推隐藏、下拉恢复；刷新、冷启动和 Service Worker 控制后仍保持 waterfall 选择；
- 生产浏览器矩阵 console error 为 `0`；
- Service Worker 控制下的 `/` 与 `/c/clawseccheck` 均返回 waterfall DOM，没有被旧经典壳覆盖；
- 视频经 `/img` 与 `/media` 的 `Range: bytes=0-1023` 均返回 `206 video/mp4`、正确
  `Content-Range` 和 1,024 B，不受图片变更影响。

外部 sitespeed.io 又以只读 HAR 门完成 classic/waterfall × desktop/mobile 各 5 次生产冷加载。
waterfall desktop LCP 相对改善 `42.6%`，mobile 改善 `25.1%`，两端 CLS 均为 `0`；详见
[`2026-07-19-sitespeed-view-matrix.md`](./2026-07-19-sitespeed-view-matrix.md)。

## 当前限制与非阻塞观察

- 本地 fixture 图片是确定性 SVG 内容，用于布局、优先级和响应式选择，不用于模拟公网图片 TTFB；
  公网性能已由上述生产图片验证和外部 sitespeed 补足。
- classic desktop 仍有若干 Product Hunt 原始大图和两个较小动画 logo；这不是已修复的
  4.276MB GIF 回归，已单列为后续 P1 媒体预算。
- RUM 继续作为上线后的观察任务，不阻塞本轮代码交付、生产发布或计划终态。
