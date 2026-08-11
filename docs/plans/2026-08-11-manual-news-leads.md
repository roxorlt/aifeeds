# 手工补录行业新闻线索 vertical MVP

日期：2026-08-11
状态：本地实现完成，未迁移、未部署

## 目标与边界

运营者可在 HK `/aifeeds/latest/` 的行业要闻审核区按日期提交文字线索或 URL。系统异步检索与取证、核验事实、识别同事件/跨日重复并评分；只有运营者再次确认，线索才进入当日候选池。确认不改变已发布 Top 5，也不启动图片、文案、音频或视频生成；沿用原有 1–5 条选择、排序、显式重生成流程。

## 所有权与链路

1. HK 页面通过已有工作台 session 鉴权访问同源代理，不接触 CF secret。
2. CF API 以幂等键创建 `manual_news_leads`，随后创建 `manual-news-lead-workflow` 实例。
3. Workflow 依次推进 submitted、validating、researching、extracting、verifying、clustering、scored，最终进入 recommended、needs_review、duplicate、rejected 或 failed。中间状态可安全恢复。
4. URL 由 safe-fetch adapter 做 SSRF、DNS、重定向、响应类型/大小/超时门禁；文字线索先查现有 D1 新闻。来源文本和用户文本始终作为不可信数据。
5. DeepSeek adapter 只允许严格 schema JSON；所有 claims 必须绑定已持久化 evidence ID。官方产品文档可单独支持其明确范围；政治/监管事件必须有原始文件或官方声明及独立可靠报道。
6. 确认时使用 lead version 与当前 batch revision 条件写入。冻结前线索等待首批 freeze 合入；冻结后复制当前候选快照、按 event key 去重并生成不可变 V2+，旧批次记录 `superseded_by`。

## 安全与一致性

- Mutating API 同时要求 Bearer secret、`Idempotency-Key` 与 `expected_version`；D1 条件更新负责并发冲突检测。
- 只允许 HTTP(S) 标准端口、无 URL credentials；拒绝 loopback、私网、link-local、metadata、ULA 和保留地址。每次重定向重新校验，最多 3 跳、12 秒、2 MiB。
- 模型额外字段、缺字段、非法枚举、未知 evidence ID 均失败关闭；不确定范围/时间必须显式输出。
- 候选批次最多 10 条，确认操作保留当前 production selection，`rerender_enqueued` 固定为 `false`。
- CF 持有审计记录；HK 不存事实副本，只展示 CF 响应。

## 发布与验收

1. staging 执行 migration 033。
2. 部署 staging Worker，确认 `MANUAL_NEWS_LEAD_WORKFLOW` binding 和 API 鉴权。
3. 部署 staging HK，验证文字-only、URL-only、状态轮询、失败重试、确认候选、V1→V2，以及原 1–5 条排序/重生成回归。
4. 验证确认前后 Top 5 与渲染任务均无自动变化。
5. production 按相同顺序迁移与部署，完成两条示例线索的证据范围人工验收。

## 已知扩展点

当前文字检索 adapter 只查询已入库内容；可在不改领域和 UI 合约的前提下接入开放互联网搜索 provider。新 provider 必须返回 URL/hint，由同一 safe-fetch 与证据校验链重新抓取，搜索摘要本身不能作为最终事实证据。
