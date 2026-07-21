# GSC 旧内容深链 canonical 修复

日期：2026-07-20
分支：`codex/fix-gsc-deeplink-canonicals`

## 背景与证据

2026-07-18，Google Search Console 邮件新增五类“未编入索引”原因：

- 重复网页，用户未选定规范网页；
- 网页会自动重定向；
- 备用网页（有适当的规范标记）；
- 未找到（404）；
- 被 `noindex` 标记排除。

GSC 2026-07-10 快照中共有 3,420 个已索引 URL、29,615 个未索引 URL。后者主要是
29,176 个“已发现但尚未编入索引”，而不是 404 或 `noindex`。站点在 7 月 5 日后才开始产生
GSC 展示，且 7 月 17–19 日刚完成内容页、归档内链和首页 SSR 发布，当前不适合依据早期快照批量
删除或 `noindex` 内容。

生产 Googlebot 请求确认五类 `/i/...` 内容页均为 `200`、self-canonical、可索引并含唯一
`h1` 与 JSON-LD。真实缺陷集中在旧的 SPA 抽屉深链：

| 旧深链 | 当前错误 | 正确 canonical |
|---|---|---|
| `/t/:id` | 首页 `/` | `/i/x/:id` |
| `/g/:owner/:repo` | 首页 `/` | `/i/gh/:owner/:repo` |
| `/ph/:slug/:date` | 首页 `/` | `/i/ph/:slug` |
| `/h/:arxivId` | 首页 `/` | `/i/paper/:arxivId` |
| `/o/:compositeId` | 首页 `/` | `/i/news/:compositeId` |

这些 URL 当前返回经典版或瀑布版首页 SSR 壳，直接继承模板中的首页 canonical。Google 因而需要
自行猜测规范页，并把样本分散到“未选定规范网页”和“备用网页”两类。

其余邮件项目目前是预期行为：

- HTTP、`www` 与历史域名路径重定向到 HTTPS apex；
- 已正确 canonical 到 `/i/...` 的备用页；
- `fonts`、`api`、`staging-api` 服务根路径返回真实 404；
- 博客搜索结果页主动 `noindex`。

## 方案

保留 SPA 抽屉深链及经典版/瀑布版选择，不做 301。Pages Function 在返回首页体验 HTML 时，
只对五类已有独立 `/i/...` 实体页的深链替换 `<link rel="canonical">`：

1. 对路径段先安全解码再重新编码，避免注入和双重编码；
2. 新闻路由只接受 `blog:`、`podcast:` composite id；
3. 根路径及暂时没有 `/i/...` 实体页的 ClawHub、活动行、YouTube 路由保持原行为；
4. classic fallback 与 waterfall fallback 使用同一转换；
5. 首页公共 waterfall SWR 缓存仍只缓存 `/`，深链 canonical 在响应阶段生成，不改变缓存键。

暂不改 sitemap `lastmod`。7 月 17 日的批量重生成包含 Unicode/JSON-LD 实质修复，符合 Google
对显著结构化数据更新的定义；以后若出现仅渲染版本变化却刷新 `generated_at`，再单独拆分
`content_lastmod`。

暂不批量裁剪 X 页面。X 页面已在 GSC 获得自然点击，且当前数据不足以证明内容质量而非站点年龄、
抓取容量或新内链传播是主要瓶颈。

## 测试与发布

1. 在 `home-runtime.test.mjs` 先复现五类 classic deep link 的首页 canonical；
2. 覆盖 waterfall deep link，确认模板仍保留首页 canonical；
3. 运行 Dashboard 全量 Node tests、Functions TypeScript、生产构建；
4. 本地边缘 fixture 分别验证 PC/移动端 classic 与 waterfall 深链；
5. staging 验证五个路径的 HTTP 状态、canonical 和抽屉交互；
6. 合入 `main` 触发生产发布后重复 Googlebot curl；
7. 仅对“重复网页，用户未选定规范网页”发起 GSC 验证。重定向、备用页、真实 404 和主动
   `noindex` 不提交“修复”，避免把预期状态当故障。

## 回滚

回滚本分支 commit 即恢复原 Pages Function 行为。修复不改 D1、R2、Worker、nginx、sitemap、
缓存 schema 或用户数据，无数据回滚步骤。
