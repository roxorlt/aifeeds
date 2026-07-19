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
362 passed, 0 failed

npm run lint
exit 0

npm run build:ssr
exit 0
home_build_identity=35d3da7ec3a4...
waterfall CSS=6.86 kB / gzip 2.03 kB
waterfall JS=20.82 kB / gzip 7.77 kB
```

本地边缘 fixture 以生产构建和 SSR renderer 运行，最终浏览器矩阵：

```text
WATERFALL_E2E=1 npx playwright test e2e/waterfall-home.spec.ts
45 passed
```

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

前端响应式候选和预连接已在本分支完成；Nginx 的格式缓存键修复仍需按单独生产清单执行和回滚验证。

## 当前限制

- 本地 fixture 图片是确定性 SVG 内容，用于布局、优先级和响应式选择，不用于模拟公网图片 TTFB。
- RUM 继续作为上线后的观察任务，不阻塞本轮代码交付。
- 生产 Nginx 变更和生产部署证据将在执行后追加。
