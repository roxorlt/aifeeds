# 手工补录行业新闻线索 vertical MVP

日期：2026-08-11
状态：本地实现完成，未迁移、未部署

## 目标与边界

运营者可在 HK `/aifeeds/latest/` 的行业要闻审核区按日期提交文字线索或 URL。系统异步检索与取证、核验事实、识别同事件/跨日重复并评分；只有运营者再次确认，线索才进入当日候选池。确认不改变已发布 Top 5，也不启动图片、文案、音频或视频生成；沿用原有 1–5 条选择、排序、显式重生成流程。

## 所有权与链路

1. HK 页面通过已有工作台 session 鉴权访问同源代理，不接触 CF secret。
2. CF API 以幂等键创建 `manual_news_leads`，随后创建 `manual-news-lead-workflow` 实例。
3. Workflow 依次推进 submitted、validating、researching、extracting、verifying、clustering、scored，最终进入 recommended、needs_review、duplicate、rejected 或 failed。中间状态可安全恢复。
4. Worker 不直接请求线索 URL。URL 与文字检索都只发往配置的固定 HTTPS 研究网关；网关负责逐跳 DNS 校验、连接 peer pinning、重定向审计、开放网络搜索和 PDF 文本转换。文字线索同时查询现有 D1 新闻与开放网络。来源文本和用户文本始终作为不可信数据。
5. DeepSeek adapter 只允许严格 schema JSON；所有 claims 必须绑定已持久化 evidence ID。官方产品文档可单独支持其明确范围；政治/监管事件必须有原始文件或官方声明及独立可靠报道。
6. 确认时使用 lead version 与当前 batch revision 条件写入。冻结前确认的 item、lead 与 audit 在同一 D1 batch 中共同受“该日期/lineage 仍无 active batch”约束；首次 freeze 抢先时不留部分写入并返回 revision conflict。冻结后复制当前候选快照、按 event key 去重并生成不可变 V2+，旧批次记录 `superseded_by`。部分唯一索引保证每个日期/lineage 只有一个 active revision，冻结与确认均在 D1 batch 内 CAS 切换。
7. 任一后续 scheduled/date-scoped revision 都先合并 active snapshot 与 durable lead 中的 eligible confirmed manual candidates，再确定性裁至 10 条。手工候选保留 `origin=manual_lead` 与 `lead_id`；上限不足时只淘汰排序末尾的 scheduled 候选，异常导致无法保留全部手工候选时失败关闭。

## 安全与一致性

- Mutating API 同时要求 Bearer secret、`Idempotency-Key` 与 `expected_version`；D1 条件更新负责并发冲突检测。
- 只允许 HTTP(S) 标准端口、无 URL credentials；Worker 的唯一网络 peer 是 `MANUAL_NEWS_RESEARCH_ORIGIN` 指定的固定 HTTPS origin。网关逐跳返回 target URL、DNS 验证 IP 和实际连接 IP；Worker 要求两 IP 相同且均为公网，否则在读取正文前失败关闭。最多 3 跳，读取正文期间继续执行 12 秒 deadline，并以流式方式执行 2 MiB 增量上限。
- PDF 二进制绝不在 Worker 中按 UTF-8/HTML 处理；网关必须返回 `source_content_type=application/pdf`、`extraction=pdf_text` 的有界纯文本和同一套 peer audit，否则拒绝。Worker 请求原始源 8 MiB、提取文本 2 MiB / 100 万字符上限；网关必须证明 requested/applied limits、原始/提取实际字节数、提取字符数、源/文本截断状态以及 parser result/version。截断、parser 失败、audit 与响应正文尺寸不一致或任一 actual 超过 applied limit 时全部失败关闭。
- 来源权威等级只由最终抓取 URL 的精确 registrable-domain allowlist 决定；用户和搜索 hint 不能指定 `source_type`、`reliable` 或官方身份。
- 模型额外字段、缺字段、非法枚举、未知 evidence ID 均失败关闭；不确定范围/时间必须显式输出。
- 候选批次最多 10 条，确认操作保留当前 production selection，`rerender_enqueued` 固定为 `false`。
- CF 将规范化抓取审计持久化在每条 `manual_news_evidence.fetch_audit_json`；HK 不存事实副本，只展示 CF 响应。

## 发布与验收

1. staging 执行 migration 033。
2. 配置 staging `MANUAL_NEWS_RESEARCH_ORIGIN` 与 secret `MANUAL_NEWS_RESEARCH_TOKEN`；研究网关必须实现 `/v1/search` 和 `/v1/document` 契约及连接 peer pinning。
3. 部署 staging Worker，确认 `MANUAL_NEWS_LEAD_WORKFLOW` binding、研究网关失败关闭和 API 鉴权。
4. 部署 staging HK，验证文字-only、URL-only、状态轮询、失败重试、确认候选、V1→V2，以及原 1–5 条排序/重生成回归。
5. 验证确认前后 Top 5 与渲染任务均无自动变化。
6. production 按相同顺序迁移与部署，完成两条示例线索的证据范围人工验收。

## 研究网关契约

- `/v1/search` 返回严格 `{results:[{url,title,snippet,published_at}]}`，最多 8 条；搜索摘要只用于发现 URL，所有候选 URL 仍须经过 `/v1/document` 重新取证。
- `/v1/document` 请求体为 `{url,limits:{source_bytes,extracted_text_bytes,extracted_text_characters},max_redirects}`；只返回 UTF-8 文本，并通过 `X-AIFeeds-Fetch-Audit` 提供严格对象：`hops`（逐跳 URL、DNS 验证 IP、实际连接 IP）、`source_content_type`、`extraction`、`requested_limits`、`applied_limits`、`actual_sizes`、`truncation:{source,extracted_text}`、`parser:{result,version}`。`requested_limits` 必须与 Worker 请求一致，applied 不得放宽 requested，actual 不得超过 applied；成功证据禁止任何截断且 parser result 必须为 `success`。HTML 可返回原文，PDF 必须由生产级 parser 转换成 `pdf_text`，不能把 PDF bytes 当文本返回。
- origin 未配置、token 缺失、schema 不合法、审计缺失、peer 不一致、正文超时或超限时，线索进入失败/待复核状态，绝不能把仅有 D1 或搜索摘要伪装成已完成开放网络研究。
