# 推文取证云端实现（aifeeds worker 侧，2026-09-03）

网关侧契约（权威来源，本文只写云端落点）：dailyVideo 仓
`docs/plans/2026-09-03-tweet-evidence-endpoint-contract.md`，第 7 节「云端 worker 待办清单」即本次范围。

**依赖**：网关补丁 `5b65a99` 已上线（`POST /v1/tweet` + `/v1/document` 对 X status 链接返回
`422 x_link_requires_tweet_api`）。本 PR 合并后云端自动部署，顺序上网关在前、云端在后，符合契约第 7.7 条。

## 1. 为什么 X 链接以前必然失败

线索 URL 被 `manual-news-leads-pipeline.ts` 交给 `/v1/document` 直抓 x.com：

1. 大陆机房直连 x.com 被墙 → 超时 → `502 document_fetch_failed` → 云端判 transient →
   3 次重试烧掉约 5 分钟 → `processing_retry_exhausted`；
2. 就算网络通了，x.com 对未登录请求只返回 JS 外壳，抽取结果为空，仍然失败。

推文取证走第三方 API，**不存在「连到 x.com 的某个 IP」这件事**，所以不能塞进 `/v1/document`
（那份 audit 的每个 hop 都要 `validated_ip === connected_ip` 且是公网地址，是一条 SSRF 防护）。

## 2. 落点

| # | 文件 | 改动 |
|---|---|---|
| 1 | `security/safe-url-fetch.ts` | 新增 `parseTwitterStatusUrl` / `isTwitterStatusUrl` / `fetchTweetEvidence` / `parseTweetEvidenceAudit`（**独立解析器**）/ `verifyTweetEvidenceAuditResponseHmac` / `isTweetEvidenceAudit` / `TWEET_EVIDENCE_ERROR_SEMANTICS` 与三个分类助手；`ManualNewsFetchAudit` 联合加入 `TweetEvidenceAudit`；`PublicDocument.extraction` 加 `'tweet_api'` |
| 2 | `digest/manual-news-leads-pipeline.ts` | adapter 增加可选 `fetchTweet`；取证循环按 host 分流；`isTransientManualLeadError` 在通用 5xx 规则**之前**接入推文错误码分级；取证失败时把可读原因写进 `error_message` |
| 3 | `digest/manual-news-leads-runtime.ts` | 生产 adapter 的 `fetchTweet` 实现（把推文取证结果整形成 `PublicDocument`）；`extractManualNewsEvidence` 新增推文分支 |
| 4 | `digest/manual-news-leads.ts` | `normalizedSignedEvidenceProvenance` 新增推文分支 + 持久化 audit 的 HMAC 校验分支 |
| 5 | `digest/manual-news-leads-api.ts` | 证据详情增加派生的 `evidence_kind` / `source_label` |
| 6 | `workflows/aifeeds-daily/fixtures/manual-news-leads-api-v1-contract.json` | **追加式**加入上面两个字段 |

## 3. audit 解析器设计

契约明确提醒不要复用 `parseGatewayAudit`（`parseFetchAudit`）——它见到没有 `hops` 的 audit 会直接
`unsafe_gateway_audit:invalid_schema`。`parseTweetEvidenceAudit` 与它**没有任何共用分支**，校验：

- 严格键集合（多一个键即拒，`hops` / `requested_limits` 之类直抓字段一律不允许出现）；
- `kind === 'tweet_api'`、`provider` 在白名单（当前只有 `scrapebadger`）；
- `requested_url` 与本次请求 URL 逐字一致；
- `canonical_url` 必须能被 `parseTwitterStatusUrl` 认可且等于其规范形式；
- `tweet_id` 与 `canonical_url` / `requested_url` 里的 id 三方一致；
- `fetched_at` 是合法 ISO，且与本地时钟偏差在 ±5min / +30s 之内（与文档 v2 同量级）；
- `provider_status` 是合法 HTTP 状态；
- **签名必检**：云端始终带 nonce/timestamp 请求，所以未签名的 audit 一律
  `unsafe_tweet_audit:signature_required`；`request_nonce` / `request_timestamp` 必须回显本次请求值；
  `body_sha256` 必须等于响应体的 sha256；HMAC 与 `signV2DocumentAudit` **逐字一致**
  （无域分隔，对去掉 `response_hmac` 的整个对象做 `canonicalJson`），并对整个 keyring 逐个试以支持轮换；
- 响应体与 audit 自洽：body 里的 `tweet_id` / `canonical_url` 必须等于 audit 的，防止「换一条推文的正文」。

类型上 `TweetEvidenceAudit` 把签名字段声明为**必填**（因为云端总是要签名），并用
`hops?: never` / `document?: never` 等标记让联合类型可判别。

## 4. 契约没点名、但会直接卡死的一处

`normalizedSignedEvidenceProvenance`（`manual-news-leads.ts`）是证据签名前的来源归一化，
原本只认「直抓 audit」和「provider audit」两种形状。推文 audit 会掉进直抓分支，
因为没有 `hops` / `requested_limits` / `parser` 而被判 `manual_news_evidence_provenance_invalid` ——
**推文线索能取证、却签不出证据**。本次补了独立分支（同样是严格键集合 + 与证据行自洽校验），
并在下游 HMAC 校验处加了 `tweet_evidence_v1` 分支。

## 5. 错误码映射

`TWEET_EVIDENCE_ERROR_SEMANTICS` 照搬契约第 4 节的「云端应视为」列，13 个码 + 止血码
`x_link_requires_tweet_api`，每条都有中文可读原因。

只有 `tweet_provider_unavailable` / `egress_proxy_unavailable` 可重试。关键点：
`tweet_provider_auth`(502)、`tweet_provider_not_configured`(503)、
`tweet_response_signing_unavailable`(503) 虽然是 5xx，但都是不会自愈的凭证/配置问题，
必须在 `isTransientManualLeadError` 的通用 5xx 规则**之前**摘出来判终态，否则重试三次纯属浪费。

仓里此前**没有**任何 error-code → 中文的映射表，owner 看到的一直是
`search_public:trusted_gateway_http_502 …` 这种原始英文串。本次新增的可读原因写进
`error_message`（`error_code` 保持 `evidence_insufficient` 不变，避免动既有枚举与下游消费方）。

## 6. 呈现层区分

- 证据 `publisher` = `X @handle`（推文的来源是**账号**，不是域名）；
- 证据详情 API 增加**派生**字段 `evidence_kind`（`tweet_api` | `web`）与
  `source_label`（`X/Twitter 推文（ScrapeBadger）` | `网页`），**不新增持久化字段**，
  直接从已持久化的 `fetch_audit.kind` 推出；
- `published_at` 用推文自己的发布时间（Twitter 格式 → ISO 归一，原文另存 `published_at_raw`）。

⚠️ 这会让 `manual_news_leads_api_v1` 的 `evidence_fields` 多两个键，是**追加式**变更，
已同步更新冻结契约 fixture。既有消费方读旧字段不受影响。

## 7. 有意的取舍

推文证据的 `source_type` 仍是 `other`、`reliable: false`。一条推文的权威性取决于**账号**，
而 `sourceIdentity` 是按 host 白名单判定的，把 `x.com` 整个域加进官方白名单是错的。
后果：单条 X 链接线索能完成取证、证据进链、owner 在工作台能看到全文，但不会自动被
`evidenceTier` 抬进「一手/独立」档位，通常落到 `needs_review` 由 owner 决定 ——
这正是补录流程该有的行为，而不是取证失败。

## 8. 残余风险

- **端到端未实跑**。本 PR 全部是构造响应的单测；真实 `/v1/tweet` 的响应形状、
  `X-AIFeeds-Tweet-Audit` 头的实际编码、ScrapeBadger 的字段命名，都只按契约文档实现，
  上线后需要用一条真实 X 链接做一次真跑验证。
- **provider 白名单只有 `scrapebadger`**。网关将来换提供方需要云端同步放行，否则
  `unsafe_tweet_audit:provider` 会把证据全拒掉。
- **`AIFEEDS_TWEET_EVIDENCE_VIA_PROXY` 是网关侧开关**，云端只通过
  `egress_proxy_unavailable` 感知；代理故障与目标站故障已区分，但云端无法主动探测。
- **`tweet_empty` 有两个来源**：网关返回的 `422 tweet_empty`，以及云端拿到 body 后发现
  `text` 为空。两者都终态、消息一致，但审计上不可区分。
- 推文的 `metrics` / `images` 已解析但目前只落在 `TweetEvidence` 上，没有进证据字段，
  下游看不到互动数据与配图。
