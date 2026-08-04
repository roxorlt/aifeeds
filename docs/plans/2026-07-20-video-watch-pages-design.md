# 独立视频观看页设计

## 背景

Google Search Console 把现有 `/daily/:date` 判为“视频不在观看页面上”。线上检查已经排除
MP4、Range、封面、可见尺寸、canonical 和 `VideoObject` 缺失；根因是日报页包含大量独立
文章卡片，页面主要用途是阅读日报，视频只是摘要。

## 已选方案

新增 `GET /video/daily/:date` 作为单视频观看页，保留 `/daily/:date` 的现有播放器，并在日报
播放器附近增加可抓取的“观看独立视频页”链接。该方案不改视频上传格式、不新增 D1 表，也不
复制整份日报正文。

没有采用以下方案：

- 把日报页删成薄视频页：会破坏日报阅读用途和现有普通搜索收录。
- 只放大或上移播放器：当前播放器已经在首屏且尺寸合格，不能改变页面主要用途。
- 只改结构化数据而不建观看页：无法解决 Google 对页面用途的判断。

## 页面与数据流

观看页直接读取现有 `daily_videos` 行并动态生成 HTML：

1. 严格匹配 `YYYY-MM-DD`。
2. 命中视频行时输出 200、self canonical、首屏原生播放器、标题、日期、视频简介、字幕轨与
   返回完整日报的普通链接。
3. JSON-LD 使用 `WebPage`、`VideoObject`、`BreadcrumbList` 和 `Organization`；视频
   `@id` 绑定观看页。
4. 日期非法或无视频时输出 `noindex` 404，不伪造空观看页。
5. HTML 继续使用项目现有 SEO 页面骨架，零可执行 JavaScript。

## Sitemap 与发现

- `/video-sitemap.xml` 的每个 `<loc>` 从 `/daily/:date` 改为 `/video/daily/:date`。
- `/sitemap-daily.xml` 同时列出观看页，`lastmod` 使用视频 `updated_at`。
- `/sitemap.xml` 继续引用 `video-sitemap.xml`，无需新增 sitemap 文件。
- 视频发布的 IndexNow URL 集合增加观看页，同时保留日报页和 sitemap URL。
- Worker、Service Worker 与 nginx 权威副本同步放行 `/video/daily/*`，避免被 SPA 壳截获。

## 兼容、错误与回滚

- 日报页继续可独立阅读和播放视频；新增链接对旧 R2 快照在伺服时幂等补入，不要求批量重写
  历史对象。
- 无视频日期不会进入视频 sitemap，也不会生成可索引空页。
- Worker 路由无状态；回滚代码和 nginx 路径即可恢复旧行为，视频媒体与 D1 数据无需回滚。

## 验收标准

- PC 与 390px 移动视口中，播放器都是首屏主内容，没有日报卡片流。
- watch page 200/self canonical，缺失页 404/noindex。
- `VideoObject.contentUrl`、封面、字幕与现有 R2 资源一致，`@id` 指向 watch page。
- 视频 sitemap 和普通 sitemap 都列 watch page，不再把日报页作为视频落地页。
- 日报页存在普通 `<a>` 内链到对应 watch page。
