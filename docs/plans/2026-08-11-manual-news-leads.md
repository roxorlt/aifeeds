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
5. DeepSeek V4 Pro 使用两次相互独立的严格 JSON 调用：第一遍生成候选 assessment；第二遍逐项核验 title、summary、event identity/type/time/material update 与每条 claim。每个待核事实只能看到其允许引用的 evidence，且必须返回能在对应 evidence 中按统一空白规范连续命中的原文 quote。任一事实不支持、方向/否定/版本/时间/范围不一致或 schema 非法，都不保存或暴露 assessment，线索进入 `needs_review`；模型 timeout、429、5xx 等瞬时错误交给 Workflow 重试。没有第三次修复调用、代码 JSON fallback 或 validator 放宽。
6. 确认时使用 lead version 与当前 batch revision 条件写入。冻结前确认的 item、lead、audit 与 date/lineage 单调 `candidate_generation` 递增在同一 D1 batch 中共同受“仍无 active batch”约束；首次 freeze 抢先时不留部分写入并返回 revision conflict。scheduled freeze 在读取任何候选前快照 generation，发布 revision 的同一 D1 batch 必须仍命中该 generation；若确认先提交导致 generation 前进，旧快照插入失败并重新采集候选，绝不发布遗漏线索的 V1。冻结后复制当前候选快照、按 event key 去重并生成不可变 V2+，旧批次记录 `superseded_by`。部分唯一索引保证每个日期/lineage 只有一个 active revision，冻结与确认均在 D1 batch 内 CAS 切换。
7. 任一后续 scheduled/date-scoped revision 都先合并 active snapshot 与 durable lead 中的 eligible confirmed manual candidates，再确定性裁至 10 条。手工候选保留 `origin=manual_lead` 与 `lead_id`；上限不足时只淘汰排序末尾的 scheduled 候选，异常导致无法保留全部手工候选时失败关闭。

## 安全与一致性

### 2026-08-13 架构重置：ARCH-01 / ARCH-02 / ARCH-03

本节是跨仓冻结计划 `2026-08-13-manual-news-proof-and-extractor-closure.md` 的 CF consumer addendum。稳定 finding ID 不重编号：

- **ARCH-01（HK，CF 明确不接管）**：Chromium preflight、session/process group、profile、TERM→KILL、wait/close、PGID 消失确认及 semaphore 释放只能由 HK Node 单一生命周期所有者负责。CF 不增加 browser 或任意用户域名网络能力。
- **ARCH-02（CF 阻断）**：完整网关正文若进入 `ManualNewsEvidence`、`claims_supported`、D1、Workflow step output、API DTO、日志/错误 metadata 或 proof canonical payload，会造成持久化泄露、响应放大和不同边界对正文/摘要关系的重新解释。完整正文只能在 `/v1/document` transport 函数局部存活；认证 HMAC、完整正文 SHA-256/UTF-8 byte/Unicode code-point size 后，CF 按冻结算法派生 excerpt，并在返回 transport DTO 前解除完整正文引用。任何后续层都不得接收完整正文参数。
- **ARCH-03（跨 HK/CF 阻断）**：只有请求显式协商 `response_profile='proof_excerpt_v1'` 时，HK 才增加已签名的 `response_profile`、`response_hmac_contract` 与 `proof_excerpt`。CF v10 每次 document 请求都必须显式发送该 profile，并对缺失、未知或结构不精确的 profile 失败关闭；旧 v2 兼容只属于 HK，不属于 CF v10 consumer。

`proof_excerpt_v1` 的冻结字段为：`contract='proof_excerpt_v1'`、`algorithm='utf8-nfc-ws1-codepoint-prefix-v1'`、`max=3000`、`sha256`（64 位小写 hex）、`utf8_bytes`、`code_points`。`response_hmac_contract='hmac-sha256-canonical-json-all-fields-except-response_hmac-v1'`；response HMAC 覆盖 audit 中除 `response_hmac` 外的全部字段，header 不携带 excerpt 文本。CF/HK 共同 golden artifact 固定为 `workflows/aifeeds-daily/fixtures/proof-excerpt-v1-golden.json`，canonical file SHA-256 固定为 `213f5b82e0e89d6c66b7c41d7d44824eea77196b5ee032c8b02e971adffb5a4c`；任一仓内容或 checksum 漂移都阻断。

冻结派生算法按以下顺序执行且不得使用运行时 `\s`、locale 或 grapheme segmentation：正文 NFC；把连续的显式 whitespace code point 集合折叠为一个 ASCII space U+0020；去除首尾 ASCII space；取前 3000 个 Unicode code points；再次只去除尾部 ASCII space；不加省略号。冻结集合为 U+0009–U+000D、U+0020、U+0085、U+00A0、U+1680、U+2000–U+200A、U+2028、U+2029、U+202F、U+205F、U+3000、U+FEFF。CJK、emoji/ZWJ、combining sequence、CRLF、NBSP、全角空格、FEFF 与 2999/3000/3001 边界必须共享 golden vectors。

CF bounded API/persistence 不变量：

### Stage-2 key rotation、API profile 与 evidence preflight threat model

- **CF-S2-01（P1）**：response/verification key 轮换时，已知 key 上的 HMAC mismatch 是 tamper；配置缺失/畸形或历史 `key_id` 不在已配置 keyring 中是 dependency unavailable。前者才允许原子 quarantine；后者只能 fail-hidden 且不得修改 verification、item 或 audit。当前 key 必须同时有显式 bounded `KEY_ID` 与 64 位 lowercase-hex secret；可选 keyring JSON 最多 8 项，字段精确为 `id/secret`，ID 与 secret 在 current+history 全集合中都唯一。任何 secret 不得进入日志、错误或 audit metadata。
- 网关 response HMAC 必须先在配置 keyring 中匹配唯一 key，再把匹配的 `response_key_id` 写入 evidence；manual proof canonical evidence 绑定该 ID。proof 带 `verification_key_id`，签名 payload 同时绑定该 ID；历史 load 只按 persisted ID 选择 exact key，不尝试“任一 key 能否验证”。所有 persisted 判断继续只依赖结构、绑定字段和 HMAC，不用当前墙钟淘汰历史证据。
- **CF-S2-02（P1）**：现有 list route 保持 bounded summary，但 response 必须显式标识 profile/version；detail 与所有 mutation lead 使用同一个显式 detail profile/version DTO。HK client 必须先通过共享 contract fixture 的 full-list 与 summary→detail 测试并部署；production smoke 先验证旧 current response，再验证新 summary response，之后 CF 才可部署。不得让 unprofiled client 静默解释 summary 为旧 full-list。
- **CF-S2-03（P2）**：读取 evidence blob 前必须先读取 bounded key-lineage columns；配置不可用或 exact persisted key ID 未知立即 fail-hidden/non-mutating。key lineage 已知后，再用 lightweight aggregate SQL 检查 count 与每列最大长度；超限直接对 active verification snapshot 执行同一原子 quarantine，且不得读取/解析 blob。materialize query 显式列名并 `LIMIT 9`。quarantine batch 任一步失败必须整体 rollback；direct/detail/confirm/candidate/freeze/finalize/prior-event 全部汇合到该 preflight。

1. 每个 lead 的 store/load 允许 0–8 条 evidence，proof/create/current 只允许 1–8 条；拒绝第 9 条、重复 evidence ID 和重复规范化 final URL。0 条证据只允许沿既有 `needs_review` 失败关闭路径，不能创建 proof。
2. 每条持久化 excerpt 最多 3000 Unicode code points、最多 12000 UTF-8 bytes，且 digest/size 必须与 signed `proof_excerpt` 完全相同。`claims_supported` 只允许恰好一个与 excerpt 相同的 bounded 字符串，不能成为第二正文通道。
3. `article_text`、`text`、`json`、`pdf_text` 使用同一个 excerpt contract。transport 首先认证完整正文，持久化/current 则只用 response HMAC 与 signed excerpt digest/sizes 确定性复验，不读取当前墙钟。
4. list API 最多 50 条 summary，只返回 `evidence_count`，不返回 evidence/audit/excerpt；detail API 最多返回 8 条上述 bounded evidence。工作台先 list，再在需要展示详情或执行基于 version 的动作前 GET detail；CF API 自动化必须覆盖该交互。
5. D1 row、Workflow step return、API JSON、审计和错误日志的测试 sentinel 均不得出现完整正文尾部；旧无 profile、旧 full-body carrier、超限或重复证据统一走现有 invalid-proof 隐藏/隔离及显式 retry/re-evidence，不原地升级。

- Mutating API 同时要求 Bearer secret、`Idempotency-Key` 与 `expected_version`；D1 条件更新负责并发冲突检测。
- 只允许 HTTP(S) 标准端口、无 URL credentials；Worker 的唯一网络 peer 是 `MANUAL_NEWS_RESEARCH_ORIGIN` 指定的固定 HTTPS origin。网关逐跳返回 target URL、DNS 验证 IP 和实际连接 IP；Worker 要求两 IP 相同且均为公网，否则在读取正文前失败关闭。最多 3 跳，读取正文期间继续执行 12 秒 deadline，并以流式方式执行 2 MiB 增量上限。
- 正式证据统一使用 negotiated signed `article_text_v2` + `proof_excerpt_v1` envelope。请求携带 `extraction_mode=article_text_v2`、`response_profile=proof_excerpt_v1`、随机 nonce、canonical request timestamp、limits 与 max redirects；响应 audit 必须完整包含相同 nonce/timestamp、canonical extracted timestamp、逐跳 peer、final URL、source/extraction、requested/applied/actual limits、无截断标记、成功 parser、完整 body SHA-256、`protocol_version=article_text_v2`、精确 profile/HMAC contract/proof excerpt claims，以及用环境独立 response secret 对除 `response_hmac` 外完整 canonical audit 计算的 HMAC。HTML/XHTML 只接受 Chromium 提取的完整单一 `article_text` 及一致的 title/published_at/selection/content_complete metadata，CF 不重解释 raw HTML；text/plain、JSON、PDF 分别保留 `text`、`json`、`pdf_text` 语义。所有模式都在 transport 层先认证 HMAC 和完整 body digest/sizes，再按冻结算法独立派生 bounded excerpt 并立即丢弃 body；后续 evidence/proof/D1/API 只持有 excerpt 与 signed audit。PDF bytes 绝不在 Worker 中按 UTF-8/HTML 处理。
- 来源权威等级只由最终抓取 URL 的精确 registrable-domain allowlist 决定；用户和搜索 hint 不能指定 `source_type`、`reliable` 或官方身份。
- 模型额外字段、缺字段、非法枚举、未知 evidence ID 均失败关闭；不确定范围/时间必须显式输出。
- 结构化高置信 anchor 在模型调用前执行精确 token-set 门控；URL 和 note 不参与，`o3` 不匹配 `o3-mini`，`GPT-5.6` 不匹配 preview/5.60，并保守支持 `Claude 5` 这类实体+独立版本组合。纯中文且无结构 anchor 的线索交给双模型与 quote gate，不做伪中文分词。
- 完整核验结果不写回 assessment JSON 自证。第一阶段把源语言、可逐字核验的 `source_atomic_facts_v2` 原子事实（稳定 fact ID）与逐句 fact-ID 映射的 `zh_editorial_projection_v2` 中文编辑投影分开持久化；summary 必须与源事实等长、同序且一一映射。程序本地从两侧四槽事实确定性派生正交的来源归因、认识可能性、计划/未来、进行/完成与 polarity，以及参与者/数量范围、对象关系与否定、与具体目标产品绑定的后缀、实体、地区、原因、版本和绝对/相对时间槽；`consumed-semantic-spans-v1` 要求 predicate/object 中的每段实义内容都被主动作、助动词或已签名槽位消费，未知情态/时长/条件/范围以及未绑定产品的 qualifier 失败关闭。第二阶段先核验源事实连续原文，再独立核验中文投影无增删改事实槽位。migration 034 的独立 verification 行持久化严格验证后的 `verification_json`，并使用 `MANUAL_NEWS_VERIFICATION_SECRET` 对 lead ID、assessment version、完整最终 assessment、派生双语语义合同、完整 evidence、规范化 signed-v2 provenance 及完整 verification JSON 的规范摘要做 HMAC-SHA256。当前 policy 为 `fact-evidence-projection-hmac-v10`；v9、旧 policy、legacy/v1/unsigned/malformed evidence 或旧 proof 一律经 invalid-proof 路径隐藏/隔离，须显式 retry/re-evidence，绝不原地升级。create、isCurrent、持久化 load、confirm、candidate rebuild、freeze/finalize 与跨日 prior-event load 统一复算同一条件；持久化检查不使用当前墙钟重新淘汰历史采集时间。
- evidence、assessment、verification 的写入/失效全部绑定 lead version、processing owner、`processing_attempt` fencing token 和状态。接管后即使 owner 相同，旧 attempt 对 `replaceEvidence`、`saveVerifiedAssessment`、`invalidateAssessment` 和状态转换均为零写入；失效只保留带 owner/attempt/version/digest/nonce 的审计并把 verification 标记为 invalidated，不物理删除历史 assessment。
- 候选批次最多 10 条，确认操作保留当前 production selection，`rerender_enqueued` 固定为 `false`。
- `daily_news_review_candidate_generations` 按日期/lineage 懒初始化为 0；历史日期及既有 batch 的 `candidate_generation` 默认 0。它只在成功的 pre-freeze confirmation 中单调递增，同幂等键重放不重复递增；active revision 仍沿用原 batch revision CAS。
- CF 将规范化抓取审计持久化在每条 `manual_news_evidence.fetch_audit_json`，但绝不持久化完整正文；HK 不存事实副本，只展示 CF bounded list/detail 响应。

## 发布与验收

1. 先把 HK feature 合入 HK 主线；安装 dedicated Chromium account/sandbox/resource gate、研究网关与 `AIFEEDS_MANUAL_NEWS_RESPONSE_SECRET`，完成真实 offline Chromium sandbox smoke。
2. 在 HK 完成 authenticated gateway/secret 及 legacy、v1、v2、tamper、stale、private-target smoke；任何 skip 或环境缺口都不得视为通过。此门禁通过前不得部署 CF consumer。
3. HK client 先读取 `workflows/aifeeds-daily/fixtures/manual-news-leads-api-v1-contract.json`，通过旧 full-list/current response 与新 `manual_news_leads_summary_v1` list→`manual_news_lead_detail_v1` detail contract 测试并部署；先在 production 对尚未变更的 CF 验证旧 current response。未通过此门禁不得部署 CF schema change。
4. 再配置 CF staging 的 `MANUAL_NEWS_RESEARCH_ORIGIN`、`MANUAL_NEWS_RESEARCH_TOKEN`、两组 current `*_KEY_ID` + 64 位 lowercase-hex secret、可选最多 8 项的 `*_KEYRING_JSON` 和 Workflow binding；按序确认既有 migration 033-036，再执行 additive migration 037 后部署 Worker/Workflow。
5. 在 CF staging 验证文字-only、URL-only、状态轮询、失败重试、retained/unknown/malformed key rotation、v9/unsigned proof 隐藏与隔离、确认候选、freeze/finalize 以及原 1–5 条排序/重生成回归；确认 Top 5 与渲染任务无自动变化。
6. staging 全部通过后才进入 CF production，按同一 key ID/secret/keyring/binding/migration inventory 部署；随后验证新的 summary marker→detail production smoke，并完成两条示例线索的证据范围人工验收。禁止 consumer-first 发布。

新线索正常成本是两次 DeepSeek V4 Pro 调用。同一次 Workflow 的状态转换重放若 active verification 的 policy、完整 digest 与 HMAC 都仍有效，则复用 assessment，模型调用为 0；运营侧显式 retry 在同一 D1 batch 中先审计并失效旧 active verification，确保下一轮重新检索和生成。旧记录、证据变化或无效凭证也会先失效再生成。第一次模型调用后、verification 原子持久化前发生瞬时失败时，Workflow 保持 at-least-once，下一次会重新执行两次模型调用，不在代码中伪造恢复结果。

## 研究网关契约

- `/v1/search` 返回严格 `{results:[{url,title,snippet,published_at}]}`，最多 8 条；搜索摘要只用于发现 URL，所有候选 URL 仍须经过 `/v1/document` 重新取证。
- `/v1/document` 的 CF v10 请求体为 `{url,extraction_mode:'article_text_v2',response_profile:'proof_excerpt_v1',request_nonce,request_timestamp,limits:{source_bytes,extracted_text_bytes,extracted_text_characters},max_redirects}`；只返回 UTF-8 提取文本，并通过 `X-AIFeeds-Fetch-Audit` 提供上述严格 signed profile audit。`requested_limits` 必须与 Worker 请求一致，applied 不得放宽 requested，actual 不得超过 applied；成功证据禁止任何截断且 parser result 必须为 `success`。HTML/XHTML 不得返回 raw HTML，PDF 必须由生产级 parser 转换成 `pdf_text`。
- origin 未配置、token 缺失、schema 不合法、审计缺失、peer 不一致、正文超时或超限时，线索进入失败/待复核状态，绝不能把仅有 D1 或搜索摘要伪装成已完成开放网络研究。
