# News Pool Hardening：剩余架构阻断项规格

- 日期：2026-08-27
- 状态：冻结的 Architecture Spec；仅覆盖 RAD-001 与 OBS-001
- 基线：6f42be1c8dd1ecc330b6db314b8f224e6fb4a77a 加当前两轮未提交补丁
- 本次修订：关闭 ARCH-RAD-001 至 ARCH-RAD-005、ARCH-OBS-001 至 ARCH-OBS-005
- 目标：不回退已关闭行为，为正式新闻授权和工作流耗尽告警提供单一、可审计、可执行、可测试的架构契约

## 0. 冻结范围与不变量

本规格只解决两个稳定阻断项：

1. RAD-001：正式新闻消费者必须使用同一个基于正向来源证明和可验证人工线索证明的授权决策。任何 radar 项、来源不匹配项、身份缺失项或伪造人工项不得进入正式新闻路径。
2. OBS-001：工作流重试耗尽告警必须先可靠持久化，再进行至少一次投递。并发、失败、跨日、切换和崩溃窗口不得造成静默丢失。

以下行为冻结，不在本规格中改变：

- 不改变任何评分权重、候选评分算法或排序权重。
- 不改变 X 不进入正式候选、日报或视频的规则。
- 不改变人工优先级语义，也不扩大人工审核权限。
- 不把 Fable 5.1 或其他社交传闻自动写成正式新闻。
- 不放宽既有跨天去重、高置信结构化指纹或来源隔离规则。
- 不重构所有 notifier。OBS-001 只为 workflow_retry_exhausted 建立可靠 D1 outbox；其他既有 KV warning consumer 保持兼容。
- 不以候选 JSON、item 的可伪造字段、调用方自述或“没有命中 deny”替代正向来源证明。
- 不因兼容历史数据而 fail-open。无法取得 backing item、registry 来源证明或人工持久化证明时，正式新闻路径必须拒绝。
- 已完成的 workflow terminal-wins、人工项不参与 recovery、podcast 文字项可恢复、X/radar 隔离、Anthropic/Z.ai discovery 和跨天事件去重行为不得回退。

### 0.1 Stable finding closure mapping

| finding | 本规格冻结位置 |
| --- | --- |
| ARCH-RAD-004 | A6/A6.1 把 deliver.ts、daily-api.ts、v1/staged Codex、DAILY_STAGED_PUSH_ENABLED=off workflow、manual repush、active/inactive review API、历史 projection 和所有 getPublishedNewsReviewSelection consumer 纳入 outward-time current authorization；A8/C 冻结 race 测试与写集 |
| ARCH-RAD-005 | A5.1 选择单 canonical registry JSON bind + json_each，冻结 schema、NFC、无不可信插值、bind 上限和完整生产 registry SQLite gate |
| ARCH-OBS-001 | B7/B7.1 冻结独立 */5 drain、UTC03:35 retention、UTC23 legacy digest、same-minute waitUntil/failure isolation、task names/status，以及 admin-tasks every-5-min cadence-band 表示 |
| ARCH-OBS-003 | B2/B3 冻结 producer_quarantine 的 NULL-safe DDL CHECK、GLOB 前缀、零 attempts/空 lease，以及 duplicate-integrity 对 pending/expired/active/delivered 的非破坏 CAS 与独立 conflict observation；B10/C 冻结 SQLite negatives/races |
| ARCH-OBS-004 | B4/B4.1 选择每 source 50×4/200-row keyset scan，冻结 safe_extra CTE、current-day legacy marker pre-filter、durable producer quarantine、exact predicate/order/cursor/exclusion/stop/mixed budget；B10/C 冻结压力矩阵 |

---

## A. RAD-001：正式新闻授权

### A1. 资产、威胁、信任边界与正向来源根

受保护资产：

- 正式新闻候选池及其冻结 revision。
- 已应用的人工选择与人工相对顺序。
- active/inactive review API 的外部投影。
- 日报页面、verified snapshot 和 staged push 中的正式新闻集合。
- 已确认人工线索的真实性、审核状态、内容版本、证据和审核日期绑定。
- “radar 只能作为发现信号、不能成为正式新闻”的隔离边界。

不可信输入：

- item 自身的 id、source_type、source_id、source_ref 和 extra。
- sources 表中不是由当前 registry 镜像契约确认的孤立或失配行。
- frozen batch、applied selection、候选快照、历史 revision 或 staged payload 携带的 item ID 和身份副本。
- 调用方传入的 manual_lead、editorial_type、official 或类似标记。
- 历史记录中缺失、损坏或彼此矛盾的身份字段。

这些输入可以提供拒绝信号，但不能单独提供授权。尤其是 source_ref=manual_lead、id=blog:manual:*、extra.manual_lead 或 extra.editorial_type=official 都是可复制字段，不是信任根。

可信边界：

1. 编译进 Worker 的 FEED_REGISTRY 是 scheduled source 的正向根。canonical descriptor 集包含 registry 中全部有限条目，并把 enabled 规范化为 boolean（缺省 true）；disabled descriptor 保留用于稳定拒绝，只有 enabled=true 才可正向授权：
   - id
   - key
   - kind
   - editorial_type
   - enabled
2. D1 sources 行是 registry 的运行时镜像，但只有与当前 descriptor 全字段一致时才可信：
   - sources.id = registry.id
   - sources.source_type = registry.kind
   - sources.source_ref = registry.key
   - sources.config 是合法 JSON object
   - config.id、config.key、config.kind、config.editorial_type 与 descriptor 精确一致
   - config.enabled 缺省按 true；显式 false 触发 disabled deny，其他类型视为 source mismatch
3. D1 当前 items backing row 用于确认 item 存在、未删除、身份 JSON 合法，并与上述 descriptor/source 行形成正向绑定。
4. D1 中 manual lead、assessment、verification、evidence 的持久化关联和现有 HMAC/key-lineage 校验是人工来源信任根。
5. 最终写入/推送前的数据库重授权与 CAS 是最终边界；早期内存判断不是最终授权。

scheduled formal 的允许条件不是“未命中 radar”，而是：

    registry descriptor
      + 精确匹配的 sources 镜像
      + 精确匹配的 item producer shape
      + descriptor/source/item 三侧均非 radar
      + item 存在且未删除

任一正向环节缺失或失配都拒绝。

主要攻击或失败路径：

- 向孤立 item 写 official 字段，但没有 registry/source 证明。
- 将 registry radar item 的 item 侧字段改为 official。
- 将 registry formal item 的 item 侧字段改为 radar，尝试依赖 source 侧覆盖。
- generic item ID 把 radar 身份藏在 source_id、source_ref、extra.feed_id 或 extra.feed_key。
- item 的 feed_id 指向一个 source，但 source_id、item ID、source_type/key 指向另一个 source。
- frozen candidate 只有 ID，后续消费者不读 backing item/source。
- 已应用或历史 revision 曾经合法，当前 backing identity 已变 radar/缺失，却仍被外部投影或 staged push 使用。
- 人工字段伪造、lead 状态/日期变化、evidence 变化或 verification 失效后仍沿用早期快照。
- SQL candidate policy 与 TypeScript runtime policy 漂移。

### A2. 判定优先级、正向 scheduled 绑定与稳定决策

正式新闻授权按以下顺序执行，前序拒绝不得被后序条件覆盖：

1. **缺少 backing item：拒绝。** 返回 DENY_MISSING_ITEM。
2. **item 已删除：拒绝。** 返回 DENY_DELETED_ITEM。
3. **item 身份损坏：拒绝。** extra 非合法 JSON object、关键字段类型错误或非法 null 时返回 DENY_MALFORMED_ITEM_IDENTITY。
4. **显式 item radar：最高优先级、不可覆盖拒绝。** extra.editorial_type 精确为 radar 时返回 DENY_EXPLICIT_ITEM_RADAR。即使 item 同时声称 manual，甚至存在有效 manual proof，也不得进入正式新闻。
5. **任何 manual-looking identity 进入 A3 的 durable manual 分支。** 不得回落 scheduled 分支。
6. **缺少 registry descriptor 或 sources backing row：拒绝。** 分别返回 DENY_NO_REGISTRY_SOURCE 或 DENY_NO_SOURCE_ROW。
7. **source disabled：拒绝。** registry descriptor enabled=false，或合法 sources.config 显式 enabled=false 时，返回 DENY_SOURCE_DISABLED。pool 创建时 enabled、向外读取/投递时 disabled 也必须拒绝。
8. **source-side radar：拒绝。** 当前 registry descriptor 或 sources.config 任一 editorial_type 为 radar 时，返回 DENY_SOURCE_RADAR。item 侧 official 不能覆盖。
9. **registry/source 镜像失配：拒绝。** id、kind/type、key/ref、enabled、config 或非 radar editorial_type 不一致时返回 DENY_SOURCE_MISMATCH。
10. **legacy radar identity：拒绝。** 按 A4 返回对应字段 reason。
11. **item 与 registry producer shape 失配：拒绝。** 返回 DENY_ITEM_SOURCE_MISMATCH。
12. **只有完整通过正向 scheduled 绑定才允许。** 返回 ALLOW_SCHEDULED_FORMAL。

item radar 高于 source radar；二者是 OR deny。必须覆盖以下对称场景：

- registry/source radar + item official：拒绝。
- registry/source formal + item radar：以 DENY_EXPLICIT_ITEM_RADAR 拒绝。
- registry/source radar + item radar：以最高优先级 item radar 拒绝。

#### A2.1 正向 scheduled producer shape

canonical policy 从 FEED_REGISTRY 生成有限 descriptor map 和 SQL VALUES CTE；SQL 与 runtime 不接受 descriptor map 之外的 source。

所有 scheduled item 均须满足：

- item.source_ref 必须为 NULL。当前 registry feed producer 不写 item.source_ref；非空值属于失配。manual_lead 只在 A3 分支允许。
- item.source_id 必须为 key + 冒号 + 非空稳定 suffix。
- extra.feed_id 必须精确等于 registry.id。
- extra 中的 key 字段必须精确等于 registry.key。
- sources 行和 sources.config 必须满足 A1 的完整镜像约束。
- extra.editorial_type：
  - 存在时必须是合法枚举并与 registry/source 精确一致；
  - radar 始终拒绝；
  - 缺失时只有 A2.2 的有限历史形状可继续。

有限 producer shape：

| shape | registry.kind | item.source_type | item.id 与 source_id | extra key |
| --- | --- | --- | --- | --- |
| current/historical blog | blog | blog | item.id = blog: + item.source_id；source_id = key:suffix | feed_key = key |
| current/historical audio podcast | podcast | podcast | item.id = podcast: + item.source_id；source_id = key:suffix | show_key = key |
| evidence-backed podcast text-blog | podcast | blog | item.id = podcast: + item.source_id；source_id = key:suffix | feed_key = key |

第三行是现有 podcast.ts 的真实生产形状：无音频 podcast 条目保留 podcast:* ID 和 podcast registry feed_id，但以 source_type=blog、extra.feed_key 进入 Blog workflow。除此之外不允许 kind/source_type 跨型。

suffix 必须非空，item.id 与 source_id 必须逐字节对应；仅前缀相似不足以授权。

#### A2.2 有限历史兼容

历史兼容仅允许代码库中已有 producer 能证明的真实形状：

- pre-editorial_type blog：完整 feed_id、feed_key、source_id、blog:* ID 和 registry/source 绑定均存在，仅 extra.editorial_type 缺失。
- pre-editorial_type audio podcast：完整 feed_id、show_key、source_id、podcast:* ID 和 registry/source 绑定均存在，仅 extra.editorial_type 缺失。
- pre-editorial_type podcast text-blog：完整 podcast feed_id、feed_key、source_id、podcast:* ID、item.source_type=blog 和 podcast registry/source 绑定均存在，仅 extra.editorial_type 缺失。

不兼容以下形状：

- extra 为 NULL、空 object 或缺少 feed_id。
- 只有 item ID 或 source_id 前缀，没有 feed_id/key。
- 只有 extra.editorial_type=official，没有正向 registry/source 绑定。
- 任意未被真实 fixture 证明的 alias。

因此“历史 clean item”不再意味着任意 NULL/{} 可放行；它必须命中上述一个有限 producer shape。

#### A2.3 稳定决策结果

canonical 模块返回稳定联合结果：

    ALLOW_SCHEDULED_FORMAL
    ALLOW_VERIFIED_MANUAL
    DENY_MISSING_ITEM
    DENY_DELETED_ITEM
    DENY_MALFORMED_ITEM_IDENTITY
    DENY_EXPLICIT_ITEM_RADAR
    DENY_UNVERIFIED_MANUAL
    DENY_MANUAL_IDENTITY_MISMATCH
    DENY_NO_REGISTRY_SOURCE
    DENY_NO_SOURCE_ROW
    DENY_SOURCE_DISABLED
    DENY_SOURCE_RADAR
    DENY_SOURCE_MISMATCH
    DENY_LEGACY_RADAR_ITEM_ID
    DENY_LEGACY_RADAR_SOURCE_ID
    DENY_LEGACY_RADAR_SOURCE_REF
    DENY_LEGACY_RADAR_FEED_ID
    DENY_LEGACY_RADAR_FEED_KEY
    DENY_ITEM_SOURCE_MISMATCH

每个 decision 包含 item_id、allowed、code；verified manual 另含 lead_id、verification_id 和 final guard bindings。调用方不得把 boolean false/undefined 当作可恢复授权。

### A3. Durable manual authorization、证据失效与最终 guard

manual item 不依赖 FEED_REGISTRY，但必须通过现有持久化链。确切允许条件冻结为：

    manual_news_leads.status IN ('recommended', 'needs_review')
    AND manual_news_leads.confirmed_at IS NOT NULL
    AND manual_news_leads.review_date = target_review_date

不存在“confirmed 即可”或其他状态 alias。

现有可信表和字段：

- manual_news_leads
  - id
  - review_date
  - status
  - version
  - confirmed_at
  - confirmed_batch_id 只作审计信息，不单独授权
- manual_news_event_assessments
  - lead_id
  - 精确 assessment_version
- manual_news_assessment_verifications
  - verification_id
  - lead_id
  - assessment_version
  - policy_version
  - verification_key_id
  - canonical_digest
  - hmac_sha256
  - verification_json
  - processing_owner
  - processing_attempt
  - creation_nonce
  - status 必须为 active
- manual_news_evidence
  - evidence 与 assessment/verification 的关联
  - response_key_id lineage

canonical manual item identity 必须全部满足：

- item.id = blog:manual: + lead.id
- item.source_type = blog
- item.source_id = manual: + lead.id
- item.source_ref = manual_lead
- item.deleted_at IS NULL
- item.extra 是合法 JSON object
- item.extra.manual_lead 的类型必须是 object，不是字符串
- item.extra.manual_lead.lead_id 必须精确等于 lead.id
- item.extra.manual_lead.evidence_ids 必须是当前 producer 形状的 JSON array
- item.extra.editorial_type 不得为 radar；若显式 radar，A2 第 4 步先拒绝

复用现有 loadVerifiedManualAssessment 语义：

1. lead 满足精确 status、confirmed_at 和 target review_date。
2. verification active，绑定同一 lead 和精确 assessment version。
3. verification key ID 已知，canonical digest 与 HMAC 校验通过。
4. assessment 内容、policy version 与 verification payload 一致。
5. evidence 集合、可靠性数据与 response key lineage 完整一致。
6. item 满足上述完整 canonical identity。

现有 MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL 只证明“当前 verification 行仍是同一个 active snapshot”，它只是最终 guard 的一部分，不是完整 final authorization。

规范性的 FORMAL_NEWS_FINAL_GUARD 必须在一个当前数据库读取/CAS 中同时绑定：

- review_date、batch_id、lineage_id、batch_revision、edit_revision、selection_hash 和 is_current 状态；
- 每个 selected item 仍存在且 deleted_at IS NULL；
- 每个 selected item 的完整当前 identity，而不只是 ID；
- item 侧显式 radar 仍未出现；
- scheduled item 的当前 FEED_REGISTRY descriptor、sources 镜像和 A2 producer shape；
- manual lead 当前仍满足精确 status、confirmed_at 和 review_date；
- extra.manual_lead.lead_id 和 canonical item identity 仍一致；
- 当前 verification 仍满足 MANUAL_VERIFICATION_SNAPSHOT_GUARD_SQL；
- 早期授权返回的 verification ID、nonce、digest 和 HMAC 仍未变化。

证据 mutation 不得留下 active verification：

- 所有 manual evidence 新增、删除、替换、可靠性/response key 修改必须经同一 store。
- evidence mutation、把该 lead 的 active verification 更新为 invalidated、写 invalidation audit、软删除/隔离 blog:manual:<lead> item 必须处于同一个 D1 batch/transaction，并带 lead version/owner/attempt/nonce guard。
- 任一 statement 的因果 changes 数不符合预期，整批失败；不得提交 evidence 已变但 verification 仍 active 的状态。
- 禁止绕过 store 直接更新 evidence。

早期授权后必须覆盖以下 race：

- lead status 改离 recommended/needs_review。
- confirmed_at 被清空。
- review_date 改变或 target date 不再一致。
- item 被删除。
- item source_id/source_ref/extra.manual_lead.lead_id 被改。
- item 显式改为 radar。
- verification 被 invalidated/replaced。
- evidence mutation 触发原子 invalidation。

任一 race 发生后，freeze、API projection、verified snapshot、daily page、staged push finalize 的 final guard 必须返回 stale/deny，不能发送或渲染。

### A4. Production radar identity 与有限 legacy alias

微博 radar 的生产 registry identity 是：

- registry/source id：blog:weibo-hot-tech
- registry/source key/ref：weibo-hot-tech
- registry/source kind/type：blog
- registry/source editorial_type：radar
- item id：blog:weibo-hot-tech:<suffix>
- item source_id：weibo-hot-tech:<suffix>
- item extra.feed_id：精确 blog:weibo-hot-tech
- item extra.feed_key：精确 weibo-hot-tech
- item extra.editorial_type：radar

所有这些都是独立 deny signal；generic item ID 不能隐藏其他字段中的 radar identity。

legacy deny 规则：

- item.id 精确生产前缀 blog:weibo-hot-tech:。
- source_id 精确 weibo-hot-tech 或生产前缀 weibo-hot-tech:。精确值仅为防御历史异常，不提供授权。
- source_ref 精确 weibo-hot-tech。
- extra.feed_id 精确 blog:weibo-hot-tech。
- extra.feed_key 精确 weibo-hot-tech。

特别冻结：

- production extra.feed_id 是 blog:weibo-hot-tech，不是 bare key。
- bare extra.feed_id=weibo-hot-tech 只有在加入一个来自真实历史行、保留字段全貌的 fixture 后，才可作为附加 deny alias；当前仓库没有该证据，因此本规格不纳入。
- 当前仓库没有 extra.source_ref=weibo-hot-tech 的真实 producer/fixture，因此不纳入兼容集合。若以后从历史数据审计获得证据，必须先加 fixture、更新本规格和 SQL/runtime 一致性测试。
- extra.feed_key=weibo-hot-tech 是当前真实生产字段，不是上述 bare feed_id alias。
- 不使用宽泛 substring。

即使正向 scheduled 绑定已经因 source mismatch 拒绝，policy 仍应产出稳定的 legacy radar reason，便于审计；但任何 reason 差异都不能改变 deny 结果。

### A5. 单一 canonical policy、SQL/runtime 一致性与 final guard

建立一个正式新闻 policy 模块，唯一拥有：

- FEED_REGISTRY 到有限 descriptor map/SQL VALUES CTE 的生成。
- sources 镜像合法性校验。
- item producer shape 和 finite legacy compatibility。
- radar/manual identity 常量。
- scheduled candidate SQL。
- backing item/source 批量读取。
- runtime authorization。
- durable manual verification 编排。
- stable decision code。
- FORMAL_NEWS_FINAL_GUARD SQL 及 bindings。

统一入口：

    authorizeFormalNewsSet(env, reviewDate, candidateSnapshots, purpose)

返回：

- 保持输入相对顺序的 allowed item IDs。
- 每个输入的完整 decision。
- verified manual 的 proof/final-guard bindings。
- scheduled item 使用的 registry/source descriptor snapshot。

SQL outline：

1. 由当前 FEED_REGISTRY 生成 registry(id, key, kind, editorial_type, enabled) CTE；具体绑定契约见 A5.1。
2. scheduled candidate SQL 必须 INNER JOIN registry 和 sources，而不是只对 items 做 NOT radar。
3. JOIN 条件绑定 sources.id/type/ref/config 和 item feed_id/key/id/source_id/source_type。
4. descriptor/source/item 任一 radar 直接排除。
5. manual-looking item 不在 scheduled SQL 中用 OR 放行；它们只经 durable manual 分支合入。
6. SQL 对 malformed extra、NULL/{}、缺 backing source 和 unknown descriptor fail-closed。

runtime 和 SQL 必须消费同一 descriptor builder 和同一 producer-shape fixture；不得维护两份手写 allowlist。若 SQLite SQL 和 runtime 对任一 fixture 的 code/allow 结论不同，测试失败。

#### A5.1 Registry SQL 生成与 D1 bind 上限

选择 **单个 canonical JSON bind + SQLite JSON1 json_each**，不生成每个 feed 多参数的 VALUES 列表，也不把 descriptor 值拼成 SQL literal。

该选择有现有运行时证据：

- worker/src/digest/selection.ts 已在生产 SQL 使用 json_each。
- worker/src/admin-subscriptions.ts 已使用 json_each。
- worker 的真实 SQLite 测试环境已执行这些 JSON1 查询。

registry descriptor bind schema 固定为一个 JSON array；每个元素只允许 exact object：

    {
      "editorial_type": "official|third-party-media|independent|radar",
      "enabled": true,
      "id": "blog:openai",
      "key": "openai",
      "kind": "blog|podcast"
    }

生成和规范化规则：

1. 输入只能来自编译期 FEED_REGISTRY，不接受 item、sources、HTTP、KV 或 D1 字符串。
2. id/key/kind/editorial_type 必须先通过 FeedDef 的严格枚举/格式校验；id 必须精确等于 kind + 冒号 + key，key 只允许 registry 已有的 a-z0-9-hyphen 形状。
3. enabled 缺省规范化为 true；false descriptor 仍进入 JSON，供 DENY_SOURCE_DISABLED 使用。
4. descriptor 按 id 字节序升序；object key 固定按 editorial_type、enabled、id、key、kind 顺序。
5. string 做 Unicode NFC；JSON.stringify 无空白；禁止 null、未知 key 和重复 id/kind/key。
6. 生成一次 registryJson，并作为 **一个 bind** 传入：

       WITH registry AS (
         SELECT
           json_extract(value, '$.id') AS id,
           json_extract(value, '$.key') AS key,
           json_extract(value, '$.kind') AS kind,
           json_extract(value, '$.editorial_type') AS editorial_type,
           CASE json_extract(value, '$.enabled') WHEN 1 THEN 1 ELSE 0 END AS enabled
         FROM json_each(?)
         WHERE json_type(value) = 'object'
       )

7. candidate ID 集合如需批量传入，也使用独立 JSON array + json_each bind，不扩成 N 个 placeholders。
8. scheduled authorization 的 canonical query 固定最多 3 个 binds：registry JSON、candidate ID JSON、review date/时间边界中的一个标量。registry 大小增长不增加 bind 数；任何新条件若使该查询超过 16 binds，架构测试直接失败，远低于 D1 约 100 参数边界。
9. SQL 模板只包含固定列名、固定 JSON path 和固定关键字。任何 item/source 值、registry descriptor 值、review date 或 candidate ID 都必须 bind；禁止不可信数据字符串插值。

兼容性 gate：

- 用完整当前 FEED_REGISTRY 生成 registryJson，在项目真实 SQLite/D1 compatibility fixture 中执行完整 scheduled predicate。
- fixture 同时包含 current blog、audio podcast、podcast text-blog、disabled source、source radar、item radar、source mismatch 和 malformed extra。
- 断言 SQL/runtime 结论一致。
- 断言 registry fragment bind count 精确为 1，完整 scheduled authorization query bind count不超过 3，并始终低于冻结上限 16。
- 若目标 D1/SQLite 环境的 json_each/json_type 不可用，测试必须失败并阻断；不得运行时降级为字符串拼接。

getPublishedNewsReviewSelection 的兼容导出可以保留，但必须成为 canonical authorization wrapper：

- 私有 helper 先解析 raw applied/default/previous selection。
- exported function 对 raw IDs 批量读取 backing item/source，调用 authorizeFormalNewsSet 后才返回。
- 不允许任何 production caller 访问 raw helper。
- null 与 [] 的语义仍按 A6 保留。

### A6. 所有消费者、API 与历史 audit 的统一契约

以下路径都必须调用 canonical authorization；上游合法结果不是永久授权：

1. **candidate SQL**
   - 只返回有正向 registry/source/item provenance 的 scheduled formal。
   - manual 只通过 durable verifier 合入。
2. **freeze/revision create**
   - 写新 revision 前重新授权全部 candidate。
3. **active sanitizer**
   - 批量读取完整 backing item/source。
   - 只过滤，不改变剩余人工选择的相对顺序或人工优先级。
4. **applied selection**
   - null：不存在 applied review，按现有规则使用授权后的自动候选 fallback。
   - []：applied review 存在，但全部被授权拒绝；不得 fallback 复活。
5. **active review API**
   - 无 batch GET 和 active batch GET 都先 sanitize/re-authorize。
   - candidates、default_selected_ids、batch_selected_ids、published_selected_ids 都只能投影 authorized IDs。
6. **inactive/historical review API**
   - 历史 D1 revision 行保持 immutable，不写 sanitizer revision、不改历史审计内容。
   - 外部响应必须通过当前 authorization 生成只读 projection。
   - candidates、default/applied/published selection 都过滤当前 deny 项。
   - projection 返回 denied IDs/reasons 作为 audit metadata。
   - 历史行曾经合法不能绕过当前 item/source/manual policy。
7. **review POST**
   - 提交前验证 selected IDs 属于当前 authorized candidate set。
   - 写 applied selection 后、触发 editorial/daily page 前再次 final re-authorize。
8. **daily page**
   - 只消费 verified/authorized selection，不能只按 item ID 读 items。
9. **verified snapshot**
   - create/read 均执行 canonical decision 与 FORMAL_NEWS_FINAL_GUARD。
10. **staged push**
    - editorial 只接收 verified snapshot。
    - finalize/send 前再次 re-authorize；任何 race 使发送失败关闭。
11. **manual lead merge**
    - 合入新人工 candidate 时，保护/继承的 published scheduled IDs 先经 canonical wrapper。
12. **email delivery（worker/src/digest/deliver.ts）**
    - digest_pool 中 source=news 的 item_ids 只是历史选品引用，不是发送授权。
    - collect 时批量读取完整 current item/source identity 并调用 canonical authorization。
    - 在 sendEmail 网络调用所在的最终 delivery attempt 内，再读取 current authorization；不得复用 workflow 早期 step 中持久化的 allow boolean。
    - 若 pool 创建后 source disabled、registry/source 改 radar、item 改 radar、source identity 失配、backing item 删除/缺失或 manual proof 失效，必须过滤并基于剩余项重建邮件；不得发送包含 deny item 的旧 render。
    - 若过滤后整封邮件没有 item，走现有 no_items/可观测终态，不发送空或含 stale news 的邮件。
13. **daily API snapshot（worker/src/digest/daily-api.ts）**
    - mode=snapshot 读取 digest_pool 后，在每次 HTTP read 时对 source=news 的 IDs 执行 current canonical authorization。
    - normal、curated、verbose/raw 三种 projection 使用同一个 filtered ID 集；raw 不能绕过。
    - source disabled、registry/source/item radar、backing item missing/deleted、identity mismatch 或 manual proof stale 时，response fail-closed 过滤。
    - historical digest_pool 行保持 immutable；只过滤 outward JSON projection，不回写 pool。
14. **v1 Codex payload/push（worker/src/digest/codex-push.ts）**
    - buildDailyCodexPayload 不能把 digest_pool 中 source=news 的 IDs 当作授权；每次 build 都批量读取 current item/source/manual proof，以 canonical authorization 重建 news items。
    - pushDailyToCodex 的每一次实际 HTTP attempt（包括首次、网络异常重试和 5xx 重试）都必须在 fetch 调用前立即重新读取 current authorization，并从授权后的 exact news ID 集重建完整 news section。
    - 每次重建须重新计算 news items/rank/count、section_order、review metadata、content hash/render key 和最终 JSON bytes；禁止复用 collect/build 阶段或上一次 attempt 的 body。
    - worker/src/digest/node-run.ts 中 DAILY_STAGED_PUSH_ENABLED!='1' 的 slot-8 workflow 必须调用上述受保护的 pushDailyToCodex，不得有直接 POST 旁路。
15. **staged Codex payload/push（worker/src/digest/codex-push.ts）**
    - buildStagedDailyCodexPayload/buildCodexSections 构建 editorial 或 finalize 时，都必须使用 current canonical authorization 产生 exact news section。
    - pushDailyStageToCodex/postDailyPayload 的每一次实际 HTTP attempt 都必须在 fetch 前执行同一 final reauthorization-and-rebuild helper；网络异常/5xx 重试不得复用 stale serialized body。
    - editorial attempt 若授权集变化，创建或复用与 exact rebuilt news payload 对应的新 immutable revision/hash 后再发送；旧 revision 不修改。
    - finalize attempt 若其 locked editorial revision 的 news 集已不再通过 current authorization，必须在 HTTP 前 fail-closed，并创建/返回 superseding editorial revision requirement；调用方先发送新 editorial，再基于它重建 finalize。不得原地修改 locked revision，也不得发送含 stale news 的 finalize。
    - 最终成功 attempt 的 exact news payload 必须与该 attempt 的 current authorized ID 集一致；source disabled、source/item radar、backing missing/deleted、identity mismatch 或 manual proof stale 都不能出现在 wire bytes 中。
16. **reachable Codex orchestration/manual repush（worker/src/digest/node-run.ts、worker/src/index.ts）**
    - DAILY_STAGED_PUSH_ENABLED off 的自动 v1 workflow、DAILY_STAGED_PUSH_ENABLED on 的 staged editorial/finalize workflow都复用同一最终边界保护。
    - index.ts 的 daily-codex-push manual endpoint：dry-run 的 build 返回当前授权 projection；非 dry-run 只调用受保护的 pushDailyToCodex。
    - index.ts 的 daily-codex-stage manual endpoint以及 daily-digest-rescore 触发的 staged auto-repair 只调用受保护的 staged build/push；不得直接发送旧 payload/revision。
    - manual repush 不是授权覆盖。调用时和每次 HTTP attempt 时仍按当前 item/source/manual proof fail-closed。

当前所有 getPublishedNewsReviewSelection 的 production direct consumer 必须纳入：

- news-review.ts
  - freeze previous selection repair
  - submit effective selection
  - verified snapshot
  - sanitizer
  - merge/freeze protected scheduled selection
- manual-news-leads-store.ts
  - confirm/merge existing published selection
- news-review-api.ts
  - active 和 inactive/historical GET projection

codex-push.ts 的 verified snapshot 只是选品输入，不是永久授权；v1/staged build 与每个 HTTP attempt 必须再走 canonical current authorization。daily-page path 必须走 authorized/verified结果。任何新增 direct consumer 都必须由 dependency test/rg guard 发现并要求使用 canonical wrapper。

#### A6.1 Outward-time current authorization

所有 outward read/delivery 都采用 **当前授权语义**，而不是 pool/batch 创建时授权语义：

- digest_pool、daily_news_review_batches 和 verified snapshot 保存的是历史选择/审计，不是永久 capability。
- email send、daily API snapshot response、active/inactive review API response、daily page generation、v1 Codex、staged editorial/finalize 在各自 outward boundary 重新读取 current FEED_REGISTRY、sources、items 和 manual proof。
- pool 创建后 source enabled→disabled、formal→radar、item official→radar、item soft-delete/物理缺失、source/item identity 失配，均立即从 outward projection/delivery 消失。
- 不允许先从 digest_pool 取 raw IDs，再只用 SELECT items WHERE id IN (...) 渲染/发送。
- historical row 不修改；projection 返回过滤后的 IDs/items 和 deny audit metadata。
- email 和 Codex v1/staged 的每个最终网络 attempt 必须对即将发送的 exact news IDs 重授权并重建 wire payload；daily API 每个 snapshot request 都重授权，不能使用未绑定 source policy 的缓存。
- collect/build 与 fetch 之间、以及两次 HTTP retry 之间发生授权变化时，下一 attempt 必须重新构建；不存在“build 一次、重试旧 body”的例外。

缺 backing item、source disabled、source/registry 失配、malformed identity 或 durable proof 不可读取时，freeze、review APIs、email、daily API snapshot、日报、verified snapshot 和 push 均 fail-closed。

### A7. 向后兼容、人工行为和不可变审计

- 有效 scheduled 历史 item 只有命中 A2.2 的有限 producer shape 才允许。
- extra.editorial_type 缺失可由当前 formal registry/source 补足分类；其他关键 provenance 字段不能缺失。
- extra NULL、{}、非法 JSON、缺 feed_id/key、unknown registry/source 均拒绝。
- 完整通过 durable verification 的 manual item 保持现有相对顺序和人工优先级。
- 仅有 item 字段、旧 batch 标记或失效 proof 的历史 manual item 拒绝。
- 显式 item radar 永远拒绝，包括同时具有有效 manual proof 的异常记录。
- source-side radar 永远拒绝，即使 item 声称 official。
- applied review 被全部过滤时返回明确 []，不回退自动候选。
- historical revision 数据行不可变；只有外部 projection 按当前 authorization 收敛。
- RAD-001 不需要 migration。现有 registry/sources/items 和 manual verification 表足以建立信任链。

### A8. 红测矩阵与最小写入集

必须先新增红测并确认失败原因对应正向 provenance/API/race 旁路，再做最小绿。

#### A8.1 Scheduled provenance 与 radar

| 场景 | 期望 |
| --- | --- |
| backing item 缺失 | DENY_MISSING_ITEM |
| item deleted_at 非空 | DENY_DELETED_ITEM |
| extra NULL、{}、array、非法 JSON | fail-closed |
| item 有 official 字段但没有 registry descriptor | DENY_NO_REGISTRY_SOURCE |
| descriptor 存在但没有 sources row | DENY_NO_SOURCE_ROW |
| registry descriptor 或 sources.config disabled | DENY_SOURCE_DISABLED |
| sources id/type/ref/config 任一与 registry 不一致 | DENY_SOURCE_MISMATCH |
| item feed_id 指 source A，source_id/key/id 指 source B | DENY_ITEM_SOURCE_MISMATCH |
| registry/source radar，item official | DENY_SOURCE_RADAR |
| registry/source formal，item radar | DENY_EXPLICIT_ITEM_RADAR |
| item radar + valid manual proof | DENY_EXPLICIT_ITEM_RADAR |
| valid current blog producer shape | ALLOW_SCHEDULED_FORMAL |
| valid current audio podcast shape | ALLOW_SCHEDULED_FORMAL |
| valid podcast text-blog shape | ALLOW_SCHEDULED_FORMAL |
| historical blog 缺 editorial_type，但完整真实 shape | SQL/runtime 均允许 |
| historical podcast 缺 editorial_type，但完整真实 shape | SQL/runtime 均允许 |
| historical text-blog 缺 editorial_type，但完整真实 shape | SQL/runtime 均允许 |
| arbitrary historical extra NULL/{} | SQL/runtime 均拒绝 |
| SQL 与 runtime 遍历同一 fixture | allow 和稳定 reason 一致 |
| 完整生产 registry 经 canonical JSON + json_each | 真实 SQLite/D1 fixture 执行成功，registry bind=1、完整 query binds≤3 |

#### A8.2 Production/legacy radar identity

| generic item ID，仅下列字段命中 | 所有消费者期望 |
| --- | --- |
| source_id=weibo-hot-tech:<suffix> | 拒绝 |
| source_ref=weibo-hot-tech | 拒绝 |
| extra.feed_id=blog:weibo-hot-tech | 拒绝 |
| extra.feed_key=weibo-hot-tech | 拒绝 |

另测：

- production item.id=blog:weibo-hot-tech:<suffix> 拒绝。
- extra.feed_id=weibo-hot-tech 不作为当前 compatibility alias；fixture 应证明它不能授权，若作为 deny alias 的政策改变必须先加入真实历史 fixture。
- generic ID + production extra.feed_id=blog:weibo-hot-tech 必须在 applied selection、active API、historical API、daily page、verified snapshot、staged editorial/finalize 中全部排除。

#### A8.3 Durable manual 与 races

| 场景 | 期望 |
| --- | --- |
| status 不是 recommended/needs_review | 拒绝 |
| confirmed_at NULL | 拒绝 |
| review_date 与 target 不同 | 拒绝 |
| extra.manual_lead 是字符串 | 拒绝 |
| extra.manual_lead.lead_id 缺失/不匹配 | 拒绝 |
| item id/source_type/source_id/source_ref 任一不匹配 | 拒绝 |
| verification inactive/revoked | 拒绝 |
| assessment/HMAC/key/evidence lineage 篡改 | 拒绝 |
| 完整有效 proof | ALLOW_VERIFIED_MANUAL，顺序保持 |
| evidence mutation | 同事务 invalidates verification 并隔离 item |
| evidence write 成功但 invalidation/audit 失败 | 整批回滚 |
| early auth 后 lead status 改变 | final guard 拒绝 |
| early auth 后 confirmed_at/date 改变 | final guard 拒绝 |
| early auth 后 item 删除/identity 改变 | final guard 拒绝 |
| early auth 后 item 改 radar | final guard 拒绝 |
| early auth 后 verification/evidence 改变 | final guard 拒绝 |

#### A8.4 Consumer/API/audit

| 场景 | 期望 |
| --- | --- |
| applied mixed valid/radar/missing item | 只保留 valid，原相对顺序不变 |
| applied 存在但全部拒绝 | []，不 fallback |
| active GET | 四组候选/选择字段均当前授权 |
| inactive historical GET 含 radar/missing/manual stale | DB 行不变，response projection 排除并给 reason |
| historical row 在创建时合法、当前 source 变 radar | response 排除 |
| valid review pool 后 source disabled | active/inactive GET 均过滤，历史 DB row 不变 |
| valid review pool 后 registry/source radar | active/inactive GET 均过滤，历史 DB row 不变 |
| valid review pool 后 item radar | active/inactive GET 均过滤，历史 DB row 不变 |
| valid review pool 后 backing item deleted/missing | active/inactive GET 均过滤，历史 DB row 不变 |
| review POST selected IDs 含当前 deny | 409 stale/deny，不 staged |
| valid digest_pool 后 source disabled | email 不发送该 news；daily API snapshot 不返回 |
| valid digest_pool 后 registry/source radar | email 不发送该 news；daily API snapshot 不返回 |
| valid digest_pool 后 item radar | email 不发送该 news；daily API snapshot 不返回 |
| valid digest_pool 后 backing item deleted/missing | email 不发送该 news；daily API snapshot 不返回 |
| daily API normal/curated/verbose snapshot | 三种 projection 使用同一 authorized news IDs |
| email collect 后、send attempt 前授权变化 | 最终 attempt 重授权并重建，不发送 stale render |
| email/daily API 直接读取 raw digest_pool IDs | dependency/behavior test 阻断旁路 |
| daily page frozen batch 含 deny | 不渲染 |
| verified snapshot race | 不创建/不消费 |
| v1 build：valid pool 后 source disabled、source radar、item radar、backing missing | buildDailyCodexPayload 重建后均排除，pool 不回写 |
| v1 push：collect/build 后、每次 fetch 前发生上述任一变化 | pushDailyToCodex 重授权并重建 exact news body；stale bytes 不发送 |
| v1 retry：第一次 HTTP 5xx 后授权变化 | 第二次 attempt 重建 body，不复用第一次 JSON |
| DAILY_STAGED_PUSH_ENABLED off slot-8 workflow | 只走受保护 v1 push；source disabled/radar/missing 均 fail-closed |
| manual daily-codex-push dry/non-dry | dry projection和每次 non-dry attempt均当前授权，无 repush override |
| staged editorial：build 后 source disabled、source radar、item radar、backing missing | 每次 attempt 重授权，生成 exact replacement revision/body或不发送 |
| staged finalize：locked editorial 后发生上述变化 | finalize HTTP 前失败关闭，要求 superseding editorial；旧 locked revision不修改 |
| staged retry：第一次 HTTP 5xx 后授权变化 | 下一 attempt 重建/revision-check，不复用 stale body |
| manual daily-codex-stage 与 rescore auto-repair | 使用同一 staged final guard，无旧 revision/raw ID旁路 |
| v1/staged collect/build→send race | final reauthorization与 exact payload rebuild 在 fetch 紧邻边界执行 |
| 每个 getPublishedNewsReviewSelection direct consumer | 使用 canonical wrapper，无 raw bypass |

最小写入集：

- worker/src/digest/news-source-policy.ts
  - registry descriptor builder
  - sources/item positive provenance
  - finite legacy shapes
  - manual orchestration
  - stable decisions
  - SQL/runtime/final guard
- worker/src/digest/selection.ts
  - candidate SQL 使用 registry/source positive join
- worker/src/digest/news-review.ts
  - canonical published wrapper、freeze/sanitize/verified/final guard、null/[] 语义
- worker/src/digest/news-review-api.ts
  - active/inactive/historical projection 与 POST re-authorization
- worker/src/digest/deliver.ts
  - email collect 与最终 send attempt 对 source=news 做 current authorization，禁止 raw digest_pool ID bypass
- worker/src/digest/daily-api.ts
  - mode=snapshot 的 normal/curated/verbose outward projection 使用 current authorization
- worker/src/digest/manual-news-leads-store.ts 和 verification store
  - 仅在现有 evidence mutation 尚未原子 invalidation 时补齐 transaction/guard
- worker/src/digest/daily-page-run.ts
  - 只增加 canonical/verified authorization 调用，不重构内容生产
- worker/src/digest/codex-push.ts
  - v1/staged canonical current authorization、每 HTTP attempt 的 exact news payload rebuild、immutable staged revision guard
- worker/src/digest/node-run.ts
  - DAILY_STAGED_PUSH_ENABLED off/on 自动 workflow 均只路由到受保护 push helper
- worker/src/index.ts
  - daily-codex-push、daily-codex-stage、daily-digest-rescore auto-repair 的 manual/reachable route 不得绕过 final guard
- focused tests
  - source policy、registry JSON1 compatibility/bind count、selection、review、review API、email delivery、daily API snapshot、revision race、manual verification、daily page
  - worker/src/digest/codex-push.test.ts：v1/staged build/send/retry final-authorization race
  - worker/src/digest/node-run.test.ts：DAILY_STAGED_PUSH_ENABLED off/on reachable routing
  - worker/src/index-codex-routing.test.ts（新增或等价现有 index route harness）：manual repush、staged repush、rescore auto-repair 不旁路
- docs/operations.md 和本设计文档
- RAD-001 无 migration，无评分/X/人工优先级改动

---

## B. OBS-001：可靠工作流告警 Outbox

### B1. 为什么 KV 不能作为权威，以及 authoritative store

共享 KV JSON array 不能作为 workflow_retry_exhausted 的权威状态：

- get/append/put 没有事务。不同 producer 并发会覆盖，静默丢失 distinct event。
- 没有逐事件 deterministic ID，不能区分 duplicate 和 distinct。
- get/send/delete 与 producer append 并发时，delete 会删除 send 期间新增且未投递的 warning。
- TTL、无 KV、put rejection 都可能在告警尚未可靠排队时丢失。
- 没有逐事件 lease、attempts、next_retry、delivered/failed ack。
- KV 不能与 D1 中 item 的 exhaustion 条件形成同一 transaction/CAS。

选择现有 D1 为唯一 authoritative outbox。现有表不具备逐事件唯一键、lease、retry、payload integrity 和 retention，因此需要严格 additive migration：

    worker/migrations/039-warning-outbox.sql

本地当前 origin/main 的 migration 末尾是 038，故规格保留 039；但在提交 PR 前必须执行一次 fresh fetch origin/main，并运行 migration-number conflict gate：

- origin/main 仍以 038 结束且不存在任何 039 文件时，保留 039。
- 若 origin/main 已出现 039 或更高冲突，实施者必须在 PR 前重编号并更新 migration tests/docs。
- 未 fresh fetch 或 gate 不通过不得提交 PR。
- 本轮架构修订不访问网络、不创建 migration。

### B2. 精确 D1 schema、epoch 时间与确定性 identity

所有时间列统一使用 UTC Unix epoch **毫秒整数**，来源为受控 nowMs/scheduledTime：

- observed_at_ms
- next_retry_at_ms
- lease_until_ms
- created_at_ms
- updated_at_ms
- delivered_at_ms
- failed_at_ms
- expires_at_ms

禁止在 outbox 表混用 ISO text、epoch seconds 或 SQLite datetime text。UTC 日期 dedup_period 由 new Date(nowMs).toISOString().slice(0, 10) 生成。

规范 schema：

    CREATE TABLE warning_outbox (
      event_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK (schema_version = 1),
      event_type TEXT NOT NULL CHECK (event_type = 'workflow_retry_exhausted'),
      source_type TEXT NOT NULL CHECK (source_type IN ('blog', 'podcast')),
      subject_id TEXT NOT NULL,
      dedup_period TEXT NOT NULL,
      observed_at_ms INTEGER NOT NULL CHECK (observed_at_ms >= 0),
      record_kind TEXT NOT NULL DEFAULT 'deliverable'
        CHECK (record_kind IN ('deliverable', 'producer_quarantine')),
      payload_json TEXT,
      payload_sha256 TEXT,
      state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending', 'leased', 'delivered', 'failed')),
      attempts INTEGER NOT NULL DEFAULT 0
        CHECK (attempts >= 0 AND attempts <= 6),
      next_retry_at_ms INTEGER
        CHECK (next_retry_at_ms IS NULL OR next_retry_at_ms >= 0),
      lease_owner TEXT,
      lease_until_ms INTEGER,
      created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
      updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
      delivered_at_ms INTEGER,
      failed_at_ms INTEGER,
      last_error_code TEXT,
      last_error_detail TEXT,
      expires_at_ms INTEGER,
      CHECK (
        (record_kind = 'deliverable'
          AND payload_json IS NOT NULL
          AND payload_sha256 IS NOT NULL)
        OR
        (record_kind = 'producer_quarantine'
          AND payload_json IS NULL
          AND payload_sha256 IS NULL
          AND state = 'failed'
          AND attempts = 0
          AND next_retry_at_ms IS NULL
          AND lease_owner IS NULL
          AND lease_until_ms IS NULL
          AND delivered_at_ms IS NULL
          AND last_error_code IS NOT NULL
          AND last_error_code GLOB 'PRODUCER_*'
          AND failed_at_ms IS NOT NULL
          AND failed_at_ms >= 0
          AND expires_at_ms IS NOT NULL
          AND expires_at_ms > failed_at_ms)
      ),
      UNIQUE (event_type, source_type, subject_id, dedup_period)
    );

    CREATE INDEX warning_outbox_due_idx
      ON warning_outbox (state, next_retry_at_ms, lease_until_ms, created_at_ms, event_id);

    CREATE INDEX warning_outbox_retention_idx
      ON warning_outbox (state, expires_at_ms, event_id);

状态约束由代码/CAS 共同维持：

- pending：lease_owner/lease_until_ms 为空，delivered_at_ms 为空。
- leased：lease_owner/lease_until_ms 非空，delivered_at_ms/failed_at_ms 为空。
- delivered：lease 为空，delivered_at_ms/expires_at_ms 非空。
- failed：lease 为空，failed_at_ms/expires_at_ms 非空。
- producer_quarantine 的 DDL 不依赖应用代码补齐不变量：record_kind 必须精确为 producer_quarantine、state 必须精确为 failed、attempts=0、payload/sha/next_retry/lease_owner/lease_until/delivered_at 全为 NULL、last_error_code/failed_at/expires_at 全非 NULL，且 expires_at_ms>failed_at_ms。它从插入起永不进入 claim/send。
- quarantine error prefix 冻结为 SQLite `last_error_code GLOB 'PRODUCER_*'`；不得改回 LIKE。CHECK 同时显式要求 `last_error_code IS NOT NULL`，时间也显式 IS NOT NULL，因此 SQLite 的“CHECK 结果为 NULL 视为通过”不能放过缺失字段。

首个且本规格唯一 event type 是 workflow_retry_exhausted。每个 item 每个 UTC 日最多一个 event。

deterministic event identity 输入是以下 exact canonical JSON：

    {
      "dedup_period": "YYYY-MM-DD",
      "event_type": "workflow_retry_exhausted",
      "schema_version": 1,
      "source_type": "blog|podcast",
      "subject_id": "<NFC item id>"
    }

event_id 是上述 canonical JSON 的 UTF-8 bytes 做 SHA-256 后的小写 64 位 hex。

producer quarantine 使用完全相同的 event_type/source_type/NFC subject_id/dedup_period canonical identity 和 event_id；record_kind 不进入 event ID。这样同一 subject/day 的永久拒绝会占据同一个唯一 tuple，后续 keyset scan 可由 outbox anti-join 排除，而不会产生第二套可绕过 dedup 的 identity。

### B3. Versioned immutable payload 与完整性验证

payload schema v1 固定为以下 exact object，不允许未知 key：

    {
      "attempt_limit": 6,
      "dedup_period": "YYYY-MM-DD",
      "event_type": "workflow_retry_exhausted",
      "observed_at_ms": 1720000000000,
      "schema_version": 1,
      "source_type": "blog|podcast",
      "subject_id": "<NFC item id>"
    }

canonicalization 规则：

1. object key 按上述 ASCII 字典序固定；实现不得依赖任意 map insertion order。
2. 所有 string value 在编码前做 Unicode NFC normalization。
3. JSON.stringify 语义输出，无空白、UTF-8 编码。
4. 只允许 JSON safe integer；observed_at_ms 必须为非负整数。
5. null 不允许。v1 没有 optional field；缺字段、null 或未知字段都视为 corrupt。
6. subject_id NFC 后 UTF-8 长度必须为 1 至 1024 bytes。
7. 整个 canonical payload UTF-8 长度上限为 8192 bytes。
8. payload_sha256 是 canonical payload UTF-8 bytes 的 SHA-256 小写 hex。

observed time 语义：

- observed_at_ms 是该 deterministic event 第一次成功插入 D1 时的 recovery nowMs。
- 同日 duplicate 不更新 observed_at_ms、payload_json、payload_sha256、created_at_ms 或 next_retry_at_ms。
- duplicate producer 不用“本次 nowMs 重新构造的 payload hash”与首个 payload比较；它读取已存在行，验证已有 payload 自身的 canonical bytes/hash/event identity 和 tuple。
- 若已有行的 payload、hash、event ID 或 tuple 不一致，记 alert_integrity_errors，绝不覆盖。

consumer 在任何网络发送前必须重新：

1. parse payload。
2. 验证 exact schema/type/null/unknown-key/UTF-8 cap/NFC canonical form。
3. 重新 canonicalize 并要求逐字节等于 payload_json。
4. 重新计算 payload_sha256。
5. 从 identity subset 重新计算 event_id。
6. 验证 payload fields 与行 columns 一致。

任一失败都不发送。consumer 以当前 lease owner CAS 把该行转为 terminal failed：

- last_error_code 使用 OUTBOX_CORRUPT_JSON、OUTBOX_CORRUPT_SCHEMA、OUTBOX_CORRUPT_HASH、OUTBOX_CORRUPT_EVENT_ID 或 OUTBOX_CORRUPT_COLUMNS。
- failed_at_ms=nowMs。
- expires_at_ms=nowMs + 90 天。
- last_error_detail 清洗并截断到 500 UTF-8 bytes。

corrupt quarantine 受每批/每 invocation 上限约束，不允许单个坏行无限占页首。

producer 侧永久拒绝也必须 durable quarantine，但不得把基础设施故障误判为永久错误：

- 仅以下由纯函数/已成功读取的持久数据确定、相同输入必然得到相同结果的 code 可形成永久 producer quarantine：PRODUCER_SUBJECT_INVALID、PRODUCER_CANONICALIZATION_REJECTED、PRODUCER_EVENT_ID_INTEGRITY、PRODUCER_DUPLICATE_INTEGRITY。尚无 deliverable row 时写 record_kind=producer_quarantine；已有 deliverable row 时按下一条做 terminal CAS，不改成 nullable-payload record。
- quarantine INSERT 使用同一 deterministic event_id/tuple，payload_json/payload_sha256/next_retry_at_ms/lease_owner/lease_until_ms/delivered_at_ms 为 NULL，record_kind='producer_quarantine'、state='failed'、attempts=0、last_error_code 为冻结的 PRODUCER_* code、failed_at_ms=nowMs、expires_at_ms=nowMs+90天，并把清洗后最多500 UTF-8 bytes detail 写入 error 列。任一字段不满足 B2 CHECK，INSERT 必须失败而不是以 NULL CHECK 结果通过。
- 若 producer 已成功读取到同 tuple deliverable row，但其 event ID/columns/payload/hash 不一致，先保存 observed state、updated_at_ms、lease_owner、lease_until_ms、delivered_at_ms，再严格按下列状态表处理；不得使用只绑定 event_id 的宽松 UPDATE。
- subject/payload validation 和 canonicalization 必须在任何网络调用前完成；永久拒绝行一旦 durable quarantine，计 alert_producer_quarantined，后续同日 scan由 anti-join 排除。
- D1 prepare/bind/batch/transaction/busy/timeout/table/index/unknown I/O failure一律是 transient：不得插 quarantine、不得写 legacy day marker、不得声明 enqueue。该 row 保持 eligible，下一 recovery invocation 重试并计 alert_enqueue_failed。

duplicate-integrity 状态/CAS 冻结如下：

| observed deliverable state | 精确行为 |
| --- | --- |
| pending | 允许 terminalize。CAS 必须绑定 event_id、record_kind='deliverable'、state='pending'、updated_at_ms=:observed_updated，并要求 delivered_at_ms IS NULL。成功后 state='failed'、next_retry_at_ms=NULL、lease字段=NULL、delivered_at_ms=NULL、failed/expires/error 写 PRODUCER_DUPLICATE_INTEGRITY；attempts 保持原值。若 claim 先赢导致 CAS=0，重新读取并按 active leased 规则处理。 |
| leased 且 lease_until_ms<=nowMs | 允许 terminalize。CAS 必须额外绑定 observed lease_owner、lease_until_ms、updated_at_ms，并再次要求 lease_until_ms<=:now_ms。成功后 state='failed'、清 lease、next_retry=NULL、failed/expires/error 写入；attempts 保持原值。若 reclaim/ack 先赢导致 CAS=0，重新读取并按新状态处理。 |
| leased 且 lease_until_ms>nowMs | **禁止 UPDATE outbox row**，不得清 lease、改 payload/state/error 或阻止当前 owner 的 send/ack。写独立 integrity conflict observation，计 alert_integrity_conflicts_active；consumer 仍按 B3 在自己实际发送前重新验证 payload。 |
| delivered | **禁止 UPDATE outbox row**；delivered_at_ms、expires_at_ms、payload/hash/state 全部保持 immutable。写独立 integrity conflict observation，计 alert_integrity_conflicts_delivered。 |
| failed | 不覆盖原 terminal reason/timestamps；写 duplicate observation/metric，若已是相同 integrity reason则按 idempotent duplicate 处理。 |

pending terminal CAS outline：

    UPDATE warning_outbox
    SET state='failed',
        next_retry_at_ms=NULL,
        lease_owner=NULL,
        lease_until_ms=NULL,
        delivered_at_ms=NULL,
        failed_at_ms=:now_ms,
        expires_at_ms=:now_ms + 90_days_ms,
        updated_at_ms=:now_ms,
        last_error_code='PRODUCER_DUPLICATE_INTEGRITY',
        last_error_detail=:sanitized_detail
    WHERE event_id=:event_id
      AND record_kind='deliverable'
      AND state='pending'
      AND updated_at_ms=:observed_updated_at_ms
      AND delivered_at_ms IS NULL;

expired-lease terminal CAS outline：

    UPDATE warning_outbox
    SET state='failed',
        next_retry_at_ms=NULL,
        lease_owner=NULL,
        lease_until_ms=NULL,
        delivered_at_ms=NULL,
        failed_at_ms=:now_ms,
        expires_at_ms=:now_ms + 90_days_ms,
        updated_at_ms=:now_ms,
        last_error_code='PRODUCER_DUPLICATE_INTEGRITY',
        last_error_detail=:sanitized_detail
    WHERE event_id=:event_id
      AND record_kind='deliverable'
      AND state='leased'
      AND lease_owner=:observed_lease_owner
      AND lease_until_ms=:observed_lease_until_ms
      AND updated_at_ms=:observed_updated_at_ms
      AND lease_until_ms <= :now_ms
      AND delivered_at_ms IS NULL;

两条 UPDATE 的 changes=0 都必须重新读取，不允许无条件 retry UPDATE；新状态为 active leased 或 delivered 时只能走非破坏 conflict observation。

“独立 integrity conflict observation”使用现有 recovery action 的 durable cron_runs.result_json 加结构化清洗日志，不修改 warning_outbox row，也不创建第二个 warning event。每个 observation 的 conflict_id 是以下 canonical JSON UTF-8 SHA-256：

    {
      "event_id": "<observed event id>",
      "lease_owner": "<owner or empty string>",
      "lease_until_ms": 1720000000000,
      "observed_state": "leased|delivered|failed",
      "observed_updated_at_ms": 1720000000000,
      "reason_code": "PRODUCER_DUPLICATE_INTEGRITY"
    }

key 顺序固定如上；无 lease 时 lease_owner=''、lease_until_ms=0，不使用 null。result_json 返回 active/delivered/failed conflict counts 和最多前25个按 conflict_id 排序的 ID，日志以 conflict_id 去重；不得借 integrity conflict 递归产生 notifier warning。若 durable cron run recording 本身失败，当前 recovery action 必须报 error，不得谎报 conflict 已记录。

### B4. Producer transaction/CAS、existing markers 与公平性

对每个 exhaustion candidate 使用单个 D1 batch/transaction：

1. 数据库中重新验证：
   - workflow_completed_at IS NULL。
   - workflow_recovery_attempts >= 6。
   - registry-managed feed item。
   - source_ref 不等于 manual_lead。
   - 属于受管 blog/podcast recovery producer shape。
   - item 未删除。
2. 计算当前 UTC dedup_period 和 deterministic event ID。
3. 用 guarded INSERT ... SELECT ... ON CONFLICT DO NOTHING 写 warning_outbox。
4. insert 与清理旧 pending claim marker/写审计元数据处于同一 D1 batch。
5. item.extra 的 alert day/pending/claim 不再是新 outbox 的 authority。

SQL outline（normalized_items/decoded_items 必须使用 B4.1 冻结的 safe_extra CTE；不得直接读取 i.extra）：

    WITH normalized_items AS (...safe_extra exact expression...),
         decoded_items AS (...all json reads from safe_extra...)
    INSERT INTO warning_outbox (...)
    SELECT :event_fields
    FROM decoded_items d
    WHERE d.id = :subject_id
      AND d.extra_is_valid = 1
      AND d.deleted_at IS NULL
      AND d.source_ref IS NOT 'manual_lead'
      AND d.workflow_completed_at IS NULL
      AND d.current_attempts >= 6
      AND current registry-managed recovery provenance holds
    ON CONFLICT(event_type, source_type, subject_id, dedup_period) DO NOTHING;

结果分类：

- changes=1：alert_enqueued +1。
- unique conflict 且 existing row 自身完整性通过：alert_duplicates +1。
- duplicate row identity/hash/canonical payload 失败：alert_integrity_errors +1；仅 pending 或 CAS 命中的 expired lease 可转 durable terminal failed 并计 alert_producer_quarantined。active leased/delivered 严禁改写，按 B3 记录独立 integrity conflict。
- payload/subject 的确定性 producer validation 失败：写同 tuple producer_quarantine，alert_producer_quarantined +1；同日不再占 scan head。
- D1/batch failure：alert_enqueue_failed +1；不写已排队/已推送 marker，下一 tick 可重试。

并发和 terminal race：

- 同 item/同日 producer 并发：一行，一个 enqueued，一个 duplicate。
- 不同 item 并发：各自一行，无共享数组覆盖。
- terminal completion 先提交：guarded insert 为零，不产生 event。
- enqueue 先提交、terminal 后提交：event 保留为真实 exhaustion audit，可继续投递。

#### B4.1 唯一冻结的 producer scan 算法

选择 **每 recovery source 独立的有界 keyset multi-page scan**；不允许 OFFSET、随机排序、单页 LIMIT 50 后返回、内存全表扫描或另一个未持久化 cursor 方案。

每个 sourceType（blog、podcast）每次 hourly recovery invocation 的常量：

- PAGE_SIZE = 50。
- MAX_PAGES = 4。
- MAX_SCANNED_ROWS = 200。
- blog 与 podcast 各有独立 200-row budget；同一个 :30 tick 合计最多扫描 400 rows。
- 两个 source action 是独立 waitUntil；一个 source 失败不消耗或取消另一个 source 的 budget。

exact eligible predicate：

- item.source_type 精确等于当前 recovery sourceType。podcast registry 产生的 text-blog 因 item.source_type=blog，进入 blog recovery lane，保持既有行为。
- item.deleted_at IS NULL。
- item.source_ref IS NULL 且明确不等于 manual_lead。
- 当前 extra 合法；所有 workflow/feed 字段都从下述 safe_extra 解码，workflow_completed_at IS NULL。
- scraped_at 可解析且早于 30 分钟门槛。
- workflow_recovery_attempts >= 6。
- item 满足 registry-managed recovery producer provenance；孤立/unmanaged item 排除。
- extra.workflow_retry_exhausted_alert_day 不等于当前 UTC dedup_period；当前日 legacy-owned row 必须在 SQL WHERE 中排除，不能先进入 page 再在内存分类为 legacy_owned。
- NOT EXISTS 当前 UTC dedup_period、同 event_type/source_type/subject_id 的 warning_outbox row，不区分该 outbox row 的 state。

stable order：

    attempts ASC, scraped_at ASC, id ASC

其中 attempts 是从合法 extra 读取的非负整数；scraped_at 使用持久化原值；id 是最终 tie-break。不得按 mutable title、lastModified 或当前 wall-clock 排序。

item.extra 的唯一安全 SQL 入口冻结为以下 CTE/alias；scan query 与 B4 单 item guarded INSERT 必须复用相同形状：

    WITH normalized_items AS (
      SELECT
        i.*,
        CASE
          WHEN i.extra IS NOT NULL AND json_valid(i.extra) = 1
          THEN i.extra
          ELSE '{}'
        END AS safe_extra,
        CASE
          WHEN i.extra IS NOT NULL AND json_valid(i.extra) = 1
          THEN 1
          ELSE 0
        END AS extra_is_valid
      FROM items i
    ),
    decoded_items AS (
      SELECT
        n.*,
        CASE
          WHEN n.extra_is_valid = 1
           AND json_type(n.safe_extra, '$.workflow_recovery_attempts') = 'integer'
          THEN CAST(json_extract(n.safe_extra, '$.workflow_recovery_attempts') AS INTEGER)
          ELSE NULL
        END AS current_attempts,
        json_extract(n.safe_extra, '$.workflow_completed_at') AS workflow_completed_at,
        json_extract(n.safe_extra, '$.workflow_retry_exhausted_alert_day') AS legacy_alert_day
      FROM normalized_items n
    )

约束：

- 安全表达式精确为 `CASE WHEN i.extra IS NOT NULL AND json_valid(i.extra)=1 THEN i.extra ELSE '{}' END AS safe_extra`；空格/排版可变，语义不得变。
- 除该表达式中的 json_valid 外，producer scan/guarded INSERT 对 workflow_recovery_attempts、workflow_completed_at、workflow_retry_exhausted_alert_day、feed_id、feed_key、source/feed provenance 以及任何其他 item.extra 字段的所有 json_extract/json_type 都只能接收 safe_extra alias；禁止 `json_extract(i.extra, ...)`、`json_type(i.extra, ...)`。
- 所有 safe_extra 的 json_extract/json_type 必须位于 normalized_items 的外层 decoded CTE/query。不得把 `json_valid(i.extra)=1 AND json_extract(i.extra,...)` 当作保护，因为 SQLite planner 不保证 AND 的求值顺序。
- extra_is_valid=0 的 row 在 eligible predicate 中 fail-closed，计 malformed_extra_excluded，但不证明 workflow 已 exhausted，因此不创建 workflow warning event。它在 ORDER BY/LIMIT 前排除，不消耗 page/scanned budget；同 invocation 中后续合法 exhausted row 仍可被选中。
- extra 合法但随后通过确定性 subject/payload validation 失败时，才按 B3 写 producer_quarantine。D1/SQLite evaluation error仍是 transient query failure，不得误写 quarantine。
- registry-managed provenance 若读取 item.extra.feed_id/feed_key 等字段，也必须使用 decoded safe_extra 字段；registry 编译常量和非 item.extra 列不受此 alias 约束。

第一页没有 keyset 条件；后续页使用上一页 **最后一个 scanned row** 的 tuple：

    attempts > :cursor_attempts
    OR (attempts = :cursor_attempts AND scraped_at > :cursor_scraped_at)
    OR (attempts = :cursor_attempts
        AND scraped_at = :cursor_scraped_at
        AND id > :cursor_id)

SQL outline（接在上述 normalized_items/decoded_items CTE 后；这里的 d.safe_extra 是唯一 JSON 输入）：

    SELECT d.id, d.scraped_at, d.current_attempts AS attempts
    FROM decoded_items d
    JOIN exact registry-managed recovery source provenance
    WHERE d.extra_is_valid = 1
      AND d.source_type = :source_type
      AND d.deleted_at IS NULL
      AND d.source_ref IS NULL
      AND d.workflow_completed_at IS NULL
      AND datetime(d.scraped_at) <= datetime(:threshold)
      AND d.current_attempts >= 6
      AND COALESCE(CAST(d.legacy_alert_day AS TEXT), '') <> :period
      AND NOT EXISTS (
        SELECT 1 FROM warning_outbox o
        WHERE o.event_type='workflow_retry_exhausted'
          AND o.source_type=:source_type
          AND o.subject_id=d.id
          AND o.dedup_period=:period
      )
      AND keyset_after_cursor
    ORDER BY d.current_attempts ASC, d.scraped_at ASC, d.id ASC
    LIMIT 50;

page loop：

1. 对 page 中每一 row 执行 B4 guarded enqueue。
2. 无论结果是 enqueued、concurrent duplicate、durable producer_quarantine、integrity_error 或 transient enqueue_failed，cursor 都推进到该 page 最后一个 scanned tuple；不得只按成功 enqueue 的 row 推进。current-day legacy_owned 不应出现在 page 中。
3. 即使 page 内 50 rows 在 SELECT 后被并发 producer 变成 duplicate，也继续下一页。
4. page rows 少于 50 时停止。
5. page rows 等于 50 且 pages<4 时继续。
6. 达到 4 pages/200 scanned rows 时停止并返回 scan_cap_reached=true、scanned_rows=200；本 invocation 不继续。
7. 任何 SQL/page error 停止当前 source，返回/抛出该 source failure；另一 source action继续。

当 eligible rows >200：

- 当前 invocation 只处理排序最前 200。
- 已成功/并发建立 current-period outbox tuple 的 rows 在下一 invocation 被 anti-join 排除，因此下一批确定性前进。
- enqueue_failed 且仍无 outbox row 的较早 row 会在下一 invocation重试，并可能继续占位；这是可靠性优先，alert_enqueue_failed/scan_cap_reached/oldest_age 必须暴露，不能静默跳过。
- durable producer_quarantine 已占 current-period tuple，下一 invocation 被 anti-join 排除；因此一批永久坏 row最多占一个 invocation 的 bounded scan，不会持续占页首。
- sustained arrivals 使用 attempts、scraped_at、id 的稳定顺序；较新的同-attempt arrivals 排在旧 backlog 后，不能永久插队。

producer 的 found/exhausted 是观察数，alert_enqueued 只计 durable insert；另返回 pages_scanned、scanned_rows、scan_cap_reached 和 oldest_scanned_age。

### B5. Precise attempts 状态机与 claim CAS

常量：

- MAX_DELIVERY_ATTEMPTS = 6。
- LEASE_MS = 5 分钟。
- CLAIM_BATCH_MAX = 100。
- INVOCATION_BATCH_MAX = 2，即每次最多处理 200 rows。
- retry delay：第 1 至第 5 次失败后分别为 5、10、20、40、80 分钟。

attempts 精确定义：

- attempts 是已经 claim 并允许发生的 send attempt 数。
- claim CAS 成功时 attempts 原子加一。
- 只有 attempts < 6 的 due/stale row 可以 claim。
- 第 6 次 claim 可以发送。
- 第 6 次发送失败后直接 terminal failed。
- attempts=6 的 expired lease 不得再次 claim/send；必须转 terminal failed。
- 因此不存在第 7 次 send。

先处理 expired-at-limit：

    SELECT event_id
    FROM warning_outbox
    WHERE state = 'leased'
      AND attempts = 6
      AND lease_until_ms <= :now_ms
    ORDER BY lease_until_ms ASC, created_at_ms ASC, event_id ASC
    LIMIT 100;

逐行 CAS：

    UPDATE warning_outbox
    SET state='failed',
        lease_owner=NULL,
        lease_until_ms=NULL,
        failed_at_ms=:now_ms,
        updated_at_ms=:now_ms,
        expires_at_ms=:now_ms + 90_days_ms,
        last_error_code='DELIVERY_LEASE_EXPIRED_AT_LIMIT'
    WHERE event_id=:event_id
      AND state='leased'
      AND attempts=6
      AND lease_until_ms <= :now_ms;

due/stale selection 的稳定公平 key：

    effective_due_ms =
      CASE WHEN state='leased' THEN lease_until_ms ELSE next_retry_at_ms END

    SELECT event_id
    FROM warning_outbox
    WHERE attempts < 6
      AND (
        (state='pending' AND next_retry_at_ms <= :now_ms)
        OR
        (state='leased' AND lease_until_ms <= :now_ms)
      )
    ORDER BY effective_due_ms ASC, created_at_ms ASC, event_id ASC
    LIMIT 100;

claim CAS：

    UPDATE warning_outbox
    SET state='leased',
        attempts=attempts+1,
        lease_owner=:owner,
        lease_until_ms=:now_ms + 300000,
        updated_at_ms=:now_ms
    WHERE event_id=:event_id
      AND attempts < 6
      AND (
        (state='pending' AND next_retry_at_ms <= :now_ms)
        OR
        (state='leased' AND lease_until_ms <= :now_ms)
      );

claim 后只读取 lease_owner 等于本 owner 的 rows。初始 SELECT 看见但 CAS 未取得的 row 禁止发送。

ack/nack 都必须要求：

- state=leased
- lease_owner 精确匹配
- lease_until_ms > ackNowMs

旧 owner 在 lease 过期、被接管或 terminalize 后的 late ack/nack 必须是 no-op。

成功 ack：

    state='delivered'
    delivered_at_ms=ackNowMs
    updated_at_ms=ackNowMs
    expires_at_ms=ackNowMs + 30_days_ms
    lease_owner=NULL
    lease_until_ms=NULL
    last_error_code=NULL
    last_error_detail=NULL

失败 nack：

- 当前 attempts 1 至 5：回 pending，next_retry_at_ms=ackNowMs+固定 backoff，failed_at_ms=ackNowMs，清 lease。
- 当前 attempts=6：转 failed，failed_at_ms=ackNowMs，expires_at_ms=ackNowMs+90 天，清 lease。

### B6. Digest chunk、per-chunk delivery 与崩溃窗口

consumer 按 claim 后的稳定顺序渲染：

    effective_due_ms, created_at_ms, event_id

chunk 冻结双上限：

- 每 chunk 最多 25 events。
- PushDeer Markdown body 经 UTF-8 编码最多 16384 bytes，包含 header 和每条 event 行。
- title 最多 256 UTF-8 bytes。
- 按顺序 greedy chunk；加入下一 event 会突破任一上限即开启新 chunk。
- 单 event 若不能在 schema cap 下渲染进一个 chunk，按 OUTBOX_CORRUPT_RENDER terminal failed，不发送。

每个 chunk 独立发送和 ack：

- 对所有配置的 PushDeer destination 尝试发送。
- 至少一个 destination 明确 HTTP 成功且业务 code=0，才 ack 该 chunk 的 rows。
- 所有 destination HTTP 500、业务失败、throw 或无 key，nack 该 chunk。
- chunk 1 成功、chunk 2 失败时，只 ack chunk 1；chunk 2 按 attempts 状态重试/failed。
- 不以 invocation 级整体成功覆盖 chunk 级结果。

投递保证：

- D1 event exactly-once 创建。
- external delivery at-least-once。
- PushDeer 没有可信远端 idempotency key，故不能承诺远端 exactly-once。
- 消息包含稳定 event/day 标识，便于识别可接受重复。

崩溃窗口：

- lease 后、HTTP 前崩溃：lease 到期后重试；若该 lease 已是第 6 次，转 failed，不做第 7 次 send。
- HTTP failure 后、nack 前崩溃：同上。
- HTTP success 后、ack 前崩溃：attempts<6 时 lease 到期可能重复发送；attempts=6 时不做第 7 次，expired-at-limit 转 failed。优先保证不静默丢失，同时严格限制发送上限。
- ack 成功后崩溃：delivered 不再发送。
- old owner late ack：owner/active-lease CAS no-op。

### B7. Cron coexistence、legacy KV lane 与失败隔离

生产只有现有 wrangler 的 */5 * * * * cron。D1 outbox drain 不新增 trigger，接入 scheduled() 顶层独立 waitUntil：

- 每个 */5 tick，在任何带 early return 的 legacy dispatcher 之前注册 drainWarningOutbox。
- drain 不进入 source action 的 first-match/return，也不进入 legacy mode async block。
- PH fetch、UTC 23:00 warning digest、list poll 等任何 return 都不能遮蔽 outbox drain。
- outbox retention 在 UTC 03:35 tick 作为另一个独立 waitUntil 注册。
- 每个 action 独立 recordCronRun/log/error handling。

#### B7.1 Exact routing、task registry 与 same-minute coexistence

ops routing 必须返回独立 action，不把 outbox drain/retention 塞进 legacy dispatcher：

- warning-outbox-drain：每个 */5 tick 都返回一次。
- warning-outbox-retention：仅 utcHour=3 且 utcMinute=35 返回。
- warning-digest：保持现有 legacy dispatcher，仅 utcHour=23 且 utcMinute=0。

worker/src/ops/cron-schedule.ts 必须新增两个独立 task definition；字段必须精确、稳定，供 worker/src/admin-tasks.ts 直接展示：

| task name | label | source | category | bjt_times | frequency | description/result status |
| --- | --- | --- | --- | --- | --- | --- |
| warning-outbox-drain | 可靠告警 Outbox 投递 | common | system | ['*/5'] | every-5-min | 每5分钟独立租约投递；disabled、ok、partial，异常为 cron_runs.status=error |
| warning-outbox-retention | 可靠告警 Outbox 清理 | common | cleanup | ['11:35'] | daily | UTC03:35/BJT11:35有界清理；disabled、ok，异常为 cron_runs.status=error |

现有 warning-digest definition 的 name/label/description 保持不变，source=common、category=system、bjt_times=['07:00']、frequency='daily'；不与 D1 drain 合并或改名。

CronTaskDef.frequency 的有限 union 增加 every-5-min；不把 drain 伪装成 hourly/multi-tick。

worker/src/admin-tasks.ts 的 schedule parse/render 必须采用显式 discriminated frequency model：

- parseBjtTimes 接收 task.frequency；先匹配 frequency='every-5-min'，返回 `{ kind: 'cadence-band', startMinute: 0, endMinute: 1440, stepMinutes: 5 }`。不得对字符串 `*/5` 执行 parseInt，不得把 NaN fallback 成 00:00。
- cadence-band 在 common lane 渲染为一条覆盖 00:00-24:00 的连续横向 band，单一 task hit target；label/tooltip 精确显示“每 5 分钟（288 次/日）”，并关联 warning-outbox-drain 的 task name、状态和 runs_24h。
- 不渲染 288 个节点，也不在午夜绘制一个 daily circle/triangle。dashboard JSON/task list仍只包含一个 warning-outbox-drain task。
- frequency='daily' 继续按现有 HH:MM point 解析；hourly-2x、hourly-1x、multi-tick 与其他现有 hourly 频率继续按现有 hourly rendering。新增 cadence-band 分支不得改变这些 task 的位置、tooltip、分组或统计。
- unknown frequency/bjt_times 继续走现有 fail-safe unknown display，不得借由 every-5-min 分支宽松解析任意 cron expression。

recording contract：

- 每个 action 单独调用 recordCronRun，task_name 精确为 warning-outbox-drain、warning-outbox-retention、warning-digest。
- action 正常返回时 cron_runs.status=ok；action result_json.status 保存 disabled、ok 或 partial。
- gate off 是可观察的 disabled 结果，不伪装为 delivered。
- table/index missing、claim SQL failure、retention SQL failure必须 throw，使对应 cron_runs.status=error，并保留清洗后的 error。
- 一个 waitUntil 的 catch 只记录自己的 action label，不重新抛到兄弟 action，也不取消其他 waitUntil。

same-minute coexistence：

- 每个普通 */5 tick：warning-outbox-drain 与既有命中 action并存。
- UTC 03:35：warning-outbox-drain、warning-outbox-retention、legacy cleanup/search reconcile 等各自注册，互不 shadow。
- UTC 23:00：warning-outbox-drain先独立注册；legacy block随后运行 warning-digest 和 daily-health-checks。legacy block 的 return 不影响已注册 drain。
- UTC :30：warning-outbox-drain、blog-workflow-recovery、podcast-workflow-recovery 作为三个独立 action并存；任一失败不吞掉另两个。

operations dashboard/task registry 必须把三个 warning task 显示为三条不同任务，分别汇总 runs_24h、ok_24h、error_24h、last_status。不得按 common/source 折叠成一个 warning task。

task/dashboard integration 必须证明：warning-outbox-drain 是 cadence-band 且不是 midnight point；warning-outbox-retention 是 BJT11:35 daily point；warning-digest 是 BJT07:00 daily point。三者 name/frequency/display kind 各自独立，任一 action 的 cron_runs.status=error 不改变或吞掉另外两个 action 的 run/status projection。

legacy KV warning digest 保持原语义：

- pushDeerWarning 的其他 consumer 继续写 legacy KV buffer。
- sendDailyWarningDigest 只在 UTC 23:00 legacy dispatcher 执行。
- D1 outbox drain 不读取、合并或删除 KV buffer。
- KV digest 成功不能 ack D1。
- D1 drain 成功不能删除 KV。
- KV unavailable/put/delete failure 不能阻止 D1 lane。
- D1 table/drain failure不能把 D1 event 报为 pushed，也不能提前删除 legacy KV buffer。

gate 和 table failure：

- WARNING_OUTBOX_DRAIN_ENABLED != 1：不访问 outbox table、不发送 D1 event，返回 status=disabled。
- WARNING_OUTBOX_DRAIN_ENABLED = 1 但 table/index 缺失：独立 drain action 失败并写 cron failure/metric；legacy UTC 23:00 lane仍按自身状态运行，但 D1 rows 不被伪造为成功。
- WARNING_OUTBOX_PRODUCER_ENABLED = 1 但 table 缺失或 insert 失败：不 fallback 到 KV，不写 authoritative delivered/day marker；alert_enqueue_failed，下一 recovery tick 重试。
- producer enabled、drain disabled：允许 durable enqueue、禁止发送，并发出 invalid_gate_combination 运维信号；用于短时暂停 drain，不丢 event。

### B8. Retention、有界清理与可观测性

retention：

- delivered ack 时写 expires_at_ms=delivered_at_ms+30 天。
- terminal failed/corrupt 时写 expires_at_ms=failed_at_ms+90 天。
- pending 和 leased 的 expires_at_ms 必须为空，不按年龄删除。
- expired lease 只能 reclaim 或 attempts=6 terminalize。
- UTC 03:35 每日运行一次 bounded retention，稳定排序：

    SELECT event_id
    FROM warning_outbox
    WHERE state IN ('delivered','failed')
      AND expires_at_ms <= :now_ms
    ORDER BY expires_at_ms ASC, event_id ASC
    LIMIT 500;

- 删除使用 state、event_id、expires_at_ms 的 CAS；每次最多 500 行。下一日继续，不无限循环。

producer 可观测字段：

- found
- triggered
- failed
- exhausted
- oldest_age
- alert_enqueued
- alert_duplicates
- alert_enqueue_failed
- alert_integrity_errors
- alert_integrity_conflicts_active
- alert_integrity_conflicts_delivered
- alert_integrity_conflicts_failed
- integrity_conflict_ids（按 conflict_id 排序，最多25）
- alert_producer_quarantined
- alert_producer_quarantine_conflicts
- alert_legacy_owned
- alert_bridge_suppressed
- pages_scanned
- scanned_rows
- scan_cap_reached
- oldest_scanned_age
- malformed_extra_excluded

consumer 可观测字段：

- due_found
- stale_at_limit
- leased
- lease_conflicts
- chunks_attempted
- chunks_delivered
- destinations_attempted
- destinations_succeeded
- delivered
- retried
- terminal_failed
- corrupt_failed
- http_failures
- exceptions
- oldest_due_age
- retained_deleted
- status/invalid_gate_combination

可按 event type/source/day 查询 pending、leased、delivered、failed、oldest due age 和 attempts distribution。日志不得含凭据；last_error_detail 和 payload preview 必须清洗/截断。

### B9. Cutover bridge、gate roundtrip、rollout 与 rollback

两个 gate 的精确模式：

| Producer gate | Drain gate | 语义 |
| --- | --- | --- |
| 0 | 0 | pure legacy：workflow exhaustion 沿用 KV/current marker；不访问 outbox table |
| 0 | 1 | bridge/rollback：drain D1；新 event 默认 legacy KV，但先查同 tuple D1，存在则抑制 KV，避免 dual-write |
| 1 | 1 | target：新 workflow exhaustion 只写 D1；D1 每 5 分钟 drain |
| 1 | 0 | paused drain：仍只写 D1，不写 KV；积压可见，并告 invalid configuration |

任何单个 event 都不双写 D1 和 KV。

#### B9.1 Existing item markers/KV/D1 bridge

现有 item.extra markers：

- workflow_retry_exhausted_alert_day
- workflow_retry_exhausted_alert_pending_day
- workflow_retry_exhausted_alert_claim_token
- workflow_retry_exhausted_alert_claimed_at
- workflow_retry_exhausted_at
- workflow_error

切换规则：

1. 若当前 UTC day 的 workflow_retry_exhausted_alert_day 已存在，表示 legacy KV enqueue 曾明确成功；target producer 本日不再建 D1 event。该条件必须作为 B4.1 keyset SELECT 的 SQL pre-filter，在 ORDER BY/LIMIT 前排除，不能选入 page 后才分类；可用独立的 bounded aggregate/metric 计 alert_legacy_owned，但该统计不消耗200-row producer scan budget。次日 dedup_period 变化，前一日 marker 不再匹配，row 可按新 period 正常建 D1。
2. pending_day/claim_token/claimed_at 不证明 durable KV enqueue；target producer可建 D1。D1 insert 与清理旧 pending claim marker在同一 D1 batch。
3. 现有 legacy KV buffer 不批量迁入 D1，仍只在 UTC 23:00 发送，避免无法原子证明 tuple 的错误迁移。
4. 切换窗口可能存在唯一受控重复：KV put 已成功但进程在写 alert_day 前崩溃，target producer随后建 D1。该 item 在切换日最多出现 legacy KV 一次 + D1 一次；不是无限重复，必须以 bridge_duplicate_possible 指标记录。
5. 已存在的 D1 rows 始终由 D1 drain 处理，不写回 KV。

bridge/rollback 模式下：

- 新 exhaustion event 在写 KV 前查询同 deterministic tuple 的 D1 row。
- 任意 D1 state 已存在则不写 KV，计 alert_bridge_suppressed。
- D1 查询失败时 fail-closed：不写 KV、不声明 enqueue，保留 retryable item signal，避免不确定状态下 dual-write。

#### B9.2 Rollout

1. PR 前 fresh fetch origin/main，migration gate 确认 039 未冲突。
2. 先应用 additive 039；不删除/修改任何旧表列。
3. 发布代码，P=0、D=0，验证 pure legacy 与 migration 存在。
4. 开 D=1、保持 P=0，进入 bridge mode；验证空表 drain、cron coexistence、table failure metrics 和 legacy UTC 23:00 digest。
5. 开 P=1、保持 D=1；从此新的 workflow exhaustion 只写 D1，不写 KV。
6. 观察 pending age、attempts、delivery、corrupt、duplicate、bridge 指标。

#### B9.3 Rollback

1. 关闭 P，保持 D=1，进入 bridge/rollback mode。
2. 新 event 使用 legacy KV，但同 tuple 已有 D1 row 时抑制 KV；既有 D1 backlog继续 drain。
3. 等 pending/leased backlog 归零或形成明确 terminal audit。
4. 为避免当日 delivered D1 与 pure legacy 重复，保持 bridge mode 到下一个 UTC dedup_period 边界。
5. 新 UTC 日再关闭 D，回 pure legacy。
6. 不 drop 039 table；旧代码不引用新表时可继续运行。

gate/table failure 绝不静默 fallback；roundtrip 0/0 → 0/1 → 1/1 → 0/1 → 0/0 必须有测试，证明每个 event 每个阶段只有一个 producer authority。

### B10. 红测/状态机矩阵与最小写入集

必须使用真实 SQLite/D1 语义验证唯一约束、transaction、稳定 ordering 和 CAS；纯内存 mock 不足以作为并发证据。HTTP/KV 使用本地 fake，不联网。

#### B10.1 Producer/payload

| 场景 | 期望 |
| --- | --- |
| 单 exhausted item | deterministic event durable insert |
| 同 item/日并发 producer | 一 enqueued、一 duplicate、表一行 |
| 不同 item 并发 producer | 两行都保留 |
| duplicate 使用不同本次 nowMs | 首个 observed_at/payload 不变，不误报 hash mismatch |
| existing payload/hash 被篡改 | duplicate integrity error，不覆盖 |
| canonical key order 改变 | consumer/duplicate integrity error |
| Unicode NFD subject | NFC 后 event ID/payload稳定 |
| null、未知 key、unsafe integer | corrupt failed，不发送 |
| payload UTF-8 超 8192 或 subject 超 1024 | producer拒绝/可观测 |
| deterministic producer subject/canonicalization拒绝 | 同 tuple durable producer_quarantine，failed/attempts=0/90天 expiry，不发送 |
| SQLite migration：完整 producer_quarantine | INSERT成功；record_kind/state/attempts/null fields/error/failed/expiry逐项符合DDL |
| quarantine 缺 last_error_code、failed_at_ms 或 expires_at_ms（逐项） | 每个 INSERT 均触发 CHECK constraint；NULL 不得被当作通过 |
| quarantine error 为 NULL、OUTBOX_*、producer_* 或非 PRODUCER_ 前缀 | 每个 INSERT 均失败；只有非NULL且 `GLOB 'PRODUCER_*'` 可通过 |
| quarantine attempts=1 | CHECK constraint失败 |
| quarantine 残留 lease_owner 或 lease_until_ms | 逐项 CHECK constraint失败 |
| quarantine next_retry_at_ms 或 delivered_at_ms 非NULL | 逐项 CHECK constraint失败 |
| duplicate row完整性永久失败 | pending/expired lease仅按精确CAS terminalize；active leased/delivered只记独立conflict，不破坏并发状态 |
| D1 busy/timeout/table/batch/unknown failure | transient enqueue_failed；不 quarantine、不 marker，下一 tick重试 |
| consumer recompute hash/event ID mismatch | terminal corrupt failed |
| terminal completion 先提交 | guarded insert 零行 |
| enqueue 先提交再 terminal | event 保留 |
| D1 transaction 任一步失败 | 整体回滚、下 tick 可重试 |
| 无 KV/KV rejection | target D1 enqueue 不受影响 |
| 已存在当前日 legacy alert_day | 在 keyset SQL 的 ORDER/LIMIT 前排除，不建 D1；legacy_owned统计不占scan budget |
| 200个当前日 legacy-owned + 排序第201个valid | 同一 invocation直接选到valid并enqueue；scanned_rows只计真正page row，不被前200个占满 |
| 上一日 legacy alert_day + 当前日同subject | 不被当前period pre-filter；建立当前日新event |
| stale pending claim 无 alert_day | D1 insert并原子清 claim |
| malformed extra 排在 valid exhausted row 前 | 真实SQLite query不抛 malformed JSON；坏row在LIMIT前fail-closed，valid row同一 invocation被enqueue |
| producer SQL source audit | 除safe expression的json_valid外，所有item.extra json_extract/json_type参数均为safe_extra alias，无raw i.extra读取 |
| 前 50 已有当日 event，第 51 eligible | 同一有界 invocation 可进展 |
| 第 1 页 50 rows 在 SELECT 后均并发变 duplicate | cursor 仍推进并扫描第 2 页 |
| 连续 3 页均混有 duplicate/enqueue failure | 按最后 scanned tuple 继续，不按成功数停页 |
| 单 source 201 eligible | 本次只扫描前 200，cap=true；下次由 anti-join 接第 201 |
| 排序前200个永久producer拒绝 + 第201个valid | 第一次有界扫描durable quarantine前200且cap=true；下一 invocation anti-join跳过并enqueue valid |
| 同上但前200个为transient D1失败 | 不写 quarantine；下一 invocation继续重试，alert_enqueue_failed/oldest_age/cap明确可见 |
| blog 250 + podcast 61 eligible | 同 tick 各自最多200，合计最多400；一方 cap不削减另一方 |
| blog page SQL失败 | podcast独立 action仍推进 |
| sustained newer arrivals | 旧 scraped_at backlog在相同 attempts 下优先，无永久饥饿 |

#### B10.2 Attempts/lease/time ordering

| 场景 | 期望 |
| --- | --- |
| first claim | attempts 0→1 |
| sixth claim | attempts 5→6，允许第六次 send |
| sixth send failure | terminal failed |
| sixth lease 过期 | failed without send |
| drain 再运行 | 无第七次 send |
| old owner lease过期后 late ack | CAS no-op |
| old owner被新 owner接管后 late nack | CAS no-op |
| pending 与 stale lease 混合 | effective_due_ms、created_at_ms、event_id 稳定顺序 |
| 相同 due/created 时间 | event_id tie-break 稳定公平 |
| epoch 0/边界/未来整数 | 精确 due/stale 行为，无 ISO/seconds 混用 |
| attempts 1-5 failure | 5/10/20/40/80 分钟 next_retry |
| duplicate integrity vs pending，integrity CAS先赢 | row terminal failed；并发 claim CAS=0，绝不send |
| duplicate integrity vs pending，claim先赢 | producer pending CAS=0，重读active lease；不改row，独立记录active conflict |
| duplicate integrity vs expired lease，integrity CAS先赢 | terminal failed并清lease；旧owner ack/reclaim均CAS=0 |
| duplicate integrity vs expired lease，reclaim先赢 | producer expired CAS=0，重读active lease；不改row并记录active conflict |
| duplicate integrity on active lease | state/owner/lease/payload/error全不变；记录active conflict；consumer仍执行pre-send integrity check |
| active lease conflict发生在owner pre-send check前 | owner完整性检查失败、不发HTTP，并以owner/state CAS terminalize；producer不抢写lease |
| active lease conflict发生在owner check后、HTTP/ack前 | producer不改row；owner按既有send/ack CAS结束，独立conflict observation保留该race |
| active lease integrity observation后owner ack | ack按owner CAS正常决定delivered；producer不得破坏ack，conflict audit保留 |
| duplicate integrity on delivered | delivered_at/expiry/state/payload/hash全不变；记录delivered conflict |
| repeated active/delivered integrity observation | deterministic conflict_id去重，cron result计数有界、最多25 IDs |

#### B10.3 Chunk/delivery/crash

| 场景 | 期望 |
| --- | --- |
| 26 events、小 body | 25+1 两 chunk |
| body bytes 超 16384 前 | 按 UTF-8 bytes 分 chunk |
| 多字节 Unicode | 字节上限准确，不按字符数 |
| chunk 1成功、chunk 2 HTTP 500 | 仅 chunk 1 delivered |
| HTTP throw/业务 code失败 | 当前 chunk retry/failed |
| 多 destination 一成功 | 当前 chunk ack |
| 无 destination key | 不 delivered |
| lease 后 HTTP 前崩溃 | lease到期 retry；attempt 6则 failed无 send |
| HTTP success 后 ack 前崩溃 | at-least-once且总 send 不超6 |
| append during send | 新 event 保留 pending，不被本 chunk ack |
| 两 consumer并发同 row | 只有 claim owner发送 |
| 两 consumer并发 distinct row | 两者可独立发送 |

#### B10.4 Cron/retention/gates/cutover

| 场景 | 期望 |
| --- | --- |
| 每个 */5 tick | outbox drain 独立 waitUntil |
| UTC 23:00 legacy block early return | D1 drain仍注册；KV digest仅此 tick |
| PH/list-poll/其他 early return | 不遮蔽 D1 drain |
| UTC 03:35 | drain + retention +既有同分钟任务全部独立注册 |
| UTC :30 | drain + blog recovery + podcast recovery全部独立注册 |
| drain失败 | retention/recovery/legacy同分钟兄弟 action仍完成并各自记账 |
| retention失败 | drain与其他 action仍完成并各自记账 |
| UTC23:00 drain失败 / legacy digest失败 | 另一 action仍运行并分别记录 warning-outbox-drain / warning-digest；无共享catch或状态覆盖 |
| UTC03:35 drain失败 / retention失败 | 另一 action仍运行并分别记录 warning-outbox-drain / warning-outbox-retention |
| task dashboard registry | drain、retention、warning-digest 三个 task name 分列 |
| admin parse `*/5` | drain呈现cadence-band“每 5 分钟（288 次/日）”，绝不成为00:00 point |
| admin hourly/daily regression | retention 11:35、digest 07:00及既有hourly/daily位置/tooltip不变 |
| cron run result | gate off result_json.status=disabled；table failure cron_runs.status=error |
| drain gate off | 不访问 table、不发送 |
| drain gate on/table missing | 独立 failure，不报 delivered |
| producer on/table missing | no KV fallback，enqueue_failed |
| producer on/drain off | D1 enqueue，invalid configuration，可见积压 |
| retention UTC 03:35 | 最多删500 terminal到期 rows |
| retention有 pending/leased | 不删除 |
| delivered/failed ack | 分别写30/90天 expiry |
| 0/0→0/1→1/1 | legacy→bridge→D1，无 dual-write |
| 1/1→0/1 | rollback新event legacy，existing D1 tuple抑制 |
| bridge D1 lookup failure | fail-closed，不写KV |
| 0/1 到下一UTC日后 0/0 | controlled rollback，无当日重复 |
| next day same subject | 新 deterministic event独立发送 |
| migration 039 conflict gate | fresh origin/main冲突时失败并要求重编号 |

最小写入集：

- worker/migrations/039-warning-outbox.sql
  - 仅新增 warning_outbox 和两个索引
- worker/src/notifier-warning-outbox.ts
  - canonical identity/payload、producer、integrity、lease、chunk、delivery、retry、retention、bridge
- worker/src/feeds/dedup.ts
  - exhaustion guarded enqueue、legacy marker bridge、observability
- worker/src/blog.ts、worker/src/podcast.ts
  - 只接 outbox producer，不改变 workflow 业务
- worker/src/notifier.ts
  - 暴露现有 PushDeer destination sender给 D1 lane；legacy KV lane保持
- worker/src/ops/cron-routing.ts
  - 新增独立 operational action union/router：每 */5 返回 warning-outbox-drain，UTC 03:35 额外返回 warning-outbox-retention
- worker/src/index.ts
  - 在 legacy dispatcher 前为上述每个 operational action注册独立 waitUntil/recordCronRun；UTC 23:00 legacy digest不变
- worker/src/ops/cron-schedule.ts
  - 新增 warning-outbox-drain 与 warning-outbox-retention 独立 task definition，以及 every-5-min frequency
- worker/src/admin-tasks.ts
  - every-5-min discriminated parse 与 cadence-band display；preserve既有hourly/daily rendering
- worker/src/ops/cron-routing.test.ts、worker/src/ops/cron-schedule.test.ts（新增）、worker/src/admin-tasks.test.ts（新增）和 scheduled/admin task registry integration test
  - 证明 same-minute action coexistence、三个 warning task不折叠、recordCronRun name/status独立、`*/5`不被解析成午夜、一个action失败不吞其他action
- worker/src/index.ts 的 Env 类型
  - WARNING_OUTBOX_PRODUCER_ENABLED
  - WARNING_OUTBOX_DRAIN_ENABLED
- focused tests
  - migration quarantine CHECK negatives/NULL semantics、producer concurrency/payload/safe_extra keyset pages、duplicate-integrity vs claim/lease/ack/delivered CAS、consumer CAS/chunk/crash、cron routing/coexistence/task dashboard、retention、gate/cutover
- docs/operations.md 和本设计文档
- 不改其他 notifier consumer、评分、X 或人工优先级

---

## C. 验收门槛

实现只有在以下条件全部满足时可交付：

1. RAD-001 与 OBS-001 的上述红测先失败，失败原因分别对应正向 provenance/API/final-guard 旁路和 KV/outbox 可靠性缺口；随后以最小实现转绿。
2. scheduled formal 必须具有当前 FEED_REGISTRY descriptor、精确 sources 镜像和有限 item producer shape。未知来源、无 source、source mismatch、NULL/{} extra 均 fail-closed。
3. extra.editorial_type=radar 是 item 侧最高优先级不可覆盖拒绝；registry/source radar 与 item radar 是 OR deny。
4. production extra.feed_id=blog:weibo-hot-tech 在 generic ID 情况下，applied、active/inactive review API、email、daily API snapshot、daily page、verified snapshot 和 Codex v1/staged push 全部排除。未被真实 fixture证明的 bare feed_id alias 不得进入兼容集合。
5. manual 只在 status IN (recommended,needs_review)、confirmed_at 非空、review_date 等于 target 且完整 durable verification/identity 通过时允许。
6. extra.manual_lead 必须是 object，lead_id 精确匹配。evidence mutation 与 verification invalidation/item quarantine/audit 原子提交。
7. FORMAL_NEWS_FINAL_GUARD 同时绑定 batch、item existence/deleted/full identity、registry/source、item radar、manual lead状态/date和当前 verification。所有 early-auth races 都有红绿证据。
8. active/inactive review API、历史 audit projection、email delivery、daily API snapshot、Codex v1/staged build/push 和所有 getPublishedNewsReviewSelection direct consumer 都使用 canonical authorization；历史 DB/pool/revision 行不可变，外部投影/投递按 current authorization fail-closed。
9. applied review 被全部过滤时保持明确 []，不 fallback；有效人工项保持原相对顺序和优先级。
10. email、daily API snapshot、buildDailyCodexPayload/pushDailyToCodex、staged editorial/finalize 从 valid pool 开始，随后 source disabled、registry/source/item radar 或 backing item deleted/missing 的 race 全部红→绿；不得出现 raw digest_pool ID bypass。
11. Codex v1 和 staged 的每一次实际 HTTP attempt 均在 fetch 前立即 final re-authorize，并重建 exact news section、hash/revision/render key和最终JSON bytes；网络/5xx retry不复用旧body。DAILY_STAGED_PUSH_ENABLED off/on、manual repush和rescore auto-repair均有reachable route测试；stale locked staged revision先要求superseding editorial，绝不原地修改或发送。
12. SQL 与 runtime 在冻结的 current/historical/radar/manual fixture 上逐项一致；registry descriptor 使用单个 canonical JSON/json_each bind，完整生产 registry 在真实 SQLite fixture执行，registry binds=1、完整 scheduled query binds≤3且≤16。
13. migration 039 严格 additive；PR 前 fresh fetch origin/main 并通过 migration-number conflict gate。
14. outbox payload/event ID 的 canonical JSON、NFC、UTF-8 cap、null/unknown-key、hash和 observed-at语义有逐项测试；consumer发送前重算完整性。producer_quarantine DDL以显式非NULL、`GLOB 'PRODUCER_*'`、attempts=0、空next_retry/lease/delivered和精确failed状态阻止SQLite NULL CHECK旁路，所有负例有真实migration测试。
15. claim 原子递增 attempts，CAS 只允许 attempts<6。第六次失败或第六次 lease过期后 terminal failed，绝无第七次 send；old owner late ack/nack no-op。duplicate-integrity仅可terminalize pending或CAS命中的expired lease；active leased/delivered不可破坏，必须独立记录deterministic conflict，claim/send/ack/delivered race矩阵全绿。
16. producer scan 对每 source 固定 keyset order、50 rows/page、4 pages/200 scanned；blog+podcast同 tick最多400。所有item.extra JSON读取只从冻结safe_extra CTE的外层alias执行，绝不依赖AND求值顺序；malformed row在LIMIT前逐行fail-closed且不阻塞后续valid。current-day legacy marker必须在ORDER/LIMIT前SQL排除；permanent producer rejection/integrity failure必须写deterministic tuple的durable quarantine，transient D1失败绝不能quarantine。malformed-before-valid、200 legacy+第201 valid、200永久拒绝+后续valid、next-day marker和cap均有真实SQL测试。
17. due/stale 使用 epoch-ms整数和 stable fair key；chunk 同时受25 events/16384 UTF-8 bytes限制，并逐 chunk ack。
18. D1 drain 在每个现有 */5 cron tick 作为独立 waitUntil，retention只在UTC03:35，legacy KV digest只在UTC23:00；同分钟 action互不shadow。
19. cron-schedule/task dashboard 将 warning-outbox-drain、warning-outbox-retention、warning-digest记录为三个独立任务；admin-tasks把every-5-min呈现为cadence-band“每 5 分钟（288 次/日）”而非午夜点，hourly/daily行为不变；gate/table failure状态准确，一个 action失败不吞兄弟 action。
20. producer/consumer/table/gate failure均可观测，不静默 fallback；no-KV、KV failure、HTTP 500/throw和crash windows不造成D1 event静默丢失。
21. cutover/rollback 0/0→0/1→1/1→0/1→0/0 有真实状态机测试，无单event dual-write；切换日唯一可能重复有明确上界和指标。
22. retention在UTC03:35有界清理最多500个到期terminal rows；不删除pending/leased。
23. 所有扫描、claim、send、payload、retry和retention均有冻结上限；无无限重试、无限扫描或告警轰炸。
24. 既有已关闭行为继续通过：terminal completion优先、manual不触发recovery、podcast text-blog可恢复、跨天去重、Anthropic/Z.ai discovery、X/radar隔离等不回退。
25. 完成focused tests、受影响模块tests、worker全量npm test、npx tsc --noEmit、git diff --check；测试不访问网络、.env、真实凭据或生产。
26. 自审确认无评分权重、X policy、人工优先级、人工审核权限或 broader notifier redesign 的范围扩张。

只有以上门槛全部满足，两个 finding 才可关闭。任何无法在现有 durable manual链、positive registry provenance 或 additive D1 outbox 中安全实现的冲突，都必须停止实现并重新架构评审，不得以 fail-open、字段信任或无界补丁替代。

---

# Architecture Supplement: RAD-001 / OBS-001

本补充只处理剩余 RAD-001 与 OBS-001；此前已关闭的架构、实现与测试 ID 全部保持关闭，不改变评分、X 策略、人工优先级、审核权限或 notifier 的其他消费者。

## RAD-001：日报静态页发布线性化

### 1. 冻结方案

采用唯一方案：**私有版本化 R2 对象 + D1 当前发布指针 + 发布时和读取时双重 final guard**。

不再覆盖 `daily/YYYY-MM-DD.html`。每次生成写入不可变候选对象：

```text
daily/versions/<date>/<publication_id>.html
```

该版本路径不得注册公开路由，R2 bucket 也不得暴露公共域名。公开入口仍只有：

```text
/daily/<date>
```

`publication_id` 为以下 canonical JSON 的 SHA-256：

```json
{
  "authorization_sha256": "...",
  "content_sha256": "...",
  "date": "YYYY-MM-DD",
  "renderer_version": 1,
  "video_snapshot_sha256": "..."
}
```

授权快照必须包含：

- exact news ID 顺序；
- FORMAL_NEWS_FINAL_GUARD 所需完整 scheduled/manual expected rows；
- review date；
- batch 模式或 automatic 模式；
- batch 的 lineage、batch ID/revision、is_current、edit revision、candidate generation、candidate/default/applied/published IDs、selection hash、superseded 状态；
- manual lead、verification、proof snapshot；
- 构建时 head generation；
- exact daily video row 或明确的 null snapshot。

快照使用固定 key order、NFC 字符串和 canonical JSON；重新计算结果必须逐字节匹配 `authorization_sha256`。

### 2. Additive D1 模型

039 保持不变。新增 040 migration，至少包含：

```sql
CREATE TABLE daily_page_publications (
  publication_id TEXT PRIMARY KEY
    CHECK (
      length(publication_id) = 64
      AND publication_id NOT GLOB '*[^0-9a-f]*'
    ),
  date TEXT NOT NULL,
  base_generation INTEGER NOT NULL CHECK (base_generation >= 0),
  r2_key TEXT NOT NULL UNIQUE,
  renderer_version INTEGER NOT NULL CHECK (renderer_version = 1),
  authorization_snapshot_json TEXT NOT NULL
    CHECK (json_valid(authorization_snapshot_json) = 1),
  authorization_sha256 TEXT NOT NULL
    CHECK (
      length(authorization_sha256) = 64
      AND authorization_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  video_snapshot_json TEXT NOT NULL
    CHECK (json_valid(video_snapshot_json) = 1),
  video_snapshot_sha256 TEXT NOT NULL
    CHECK (
      length(video_snapshot_sha256) = 64
      AND video_snapshot_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  content_sha256 TEXT NOT NULL
    CHECK (
      length(content_sha256) = 64
      AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
  title TEXT NOT NULL,
  item_count INTEGER NOT NULL CHECK (item_count >= 0),
  generated_at TEXT NOT NULL,
  lastmod TEXT NOT NULL,
  state TEXT NOT NULL
    CHECK (state IN ('prepared','published','superseded','abandoned')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  promoted_at_ms INTEGER,
  cleanup_after_ms INTEGER,
  last_error_code TEXT,
  CHECK (
    r2_key =
      'daily/versions/' || date || '/' || publication_id || '.html'
  )
);

CREATE INDEX daily_page_publications_cleanup_idx
  ON daily_page_publications(state, cleanup_after_ms, publication_id);

CREATE TABLE daily_page_publication_heads (
  date TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL UNIQUE,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  promoted_at_ms INTEGER NOT NULL CHECK (promoted_at_ms >= 0),
  FOREIGN KEY(publication_id)
    REFERENCES daily_page_publications(publication_id)
);
```

040 严格 additive；不删除固定 key 或旧 `daily_pages` 数据。

### 3. 发布协议

1. 批量执行当前 formal-news/batch guard，得到不可变授权快照。
2. 读取渲染数据、主题、相邻日期及 daily video。
3. 渲染 HTML，计算 content、video、authorization digest 和 `publication_id`。
4. 在 D1 插入或读取相同 `publication_id` 的 `prepared` 行；内容不一致即 integrity failure。
5. 写私有版本化 R2 key，custom metadata 带 publication/content/authorization digest。
6. 读取 R2 metadata，确认与候选行一致。
7. 执行一个 D1 transaction/batch：
   - guarded head UPSERT 同时运行完整 current FORMAL_NEWS_FINAL_GUARD、manual proof guard、batch snapshot guard、video snapshot guard；
   - 要求当前 head generation 等于 `base_generation`；
   - guard 成功时把 head 更新为新 publication、generation 加一；
   - 将新候选标为 `published`；
   - 将旧 head 对象标为 `superseded` 并设置清理时间；
   - 仅在 head 已指向新 publication 时更新 `daily_pages` 的 title、count、generated_at、lastmod。
8. 任一步不满足时，整个 D1 transaction 不改变公开 head。

### 4. 线性化点

唯一发布线性化点是：**包含 guarded head UPSERT 的 D1 transaction 成功提交**。

- 授权或 batch/manual/video mutation 先提交：final joined guard/CAS 为零，新对象不成为 head。
- head transaction 先提交：页面在该线性化点是授权的；后续 mutation 排在线性化点之后。
- 两个并发 publisher：只有匹配当前 `base_generation` 的一个可以提升；另一个返回 stale 并重新构建。
- R2 put 不是发布点；没有 D1 head 的版本对象永远不可公开。
- 不宣称 D1 与 R2 跨系统原子。

### 5. 公开读取协议

`/daily/<date>`：

1. 单次 D1 joined query 读取 head、publication、完整授权快照，并运行当前 formal/batch/manual/video guard。
2. deny、缺 backing item、source mismatch/disabled/radar、batch stale、proof stale、snapshot/hash malformed 时，不访问 R2，返回 no-store 404。
3. D1 异常返回 no-store 503，不回退固定 R2 key。
4. 读取 head 指向的 exact versioned R2 object。
5. 校验 R2 metadata 和实际 body SHA-256。
6. 在构造 Response 前，再执行一次同样的 joined guard，并绑定 exact date、publication ID、generation、authorization digest。
7. 第二次 guard 失败则丢弃已读 body，返回 no-store 404/503。
8. 成功响应使用 `Cache-Control: no-store`，避免 mutation 后边缘缓存继续暴露旧 HTML。

`/daily/`、sitemap、相邻日期、freshness monitor 与 daily-video 上传检查只承认存在有效 head 的日期；不得根据裸 `daily_pages` 行或固定 R2 key 宣称已发布。

daily-video 上传不得原地修改当前版本对象；必须触发同一重建和 promotion 协议。

### 6. 失败、重试与清理

- R2 put 失败：head 不变；prepared row 可重试。
- R2 成功、guard 失败：候选标记 `abandoned`，现有 head 不变。
- D1 promotion 结果不确定：按 publication ID/head generation 重新读取；head 已匹配视为成功，否则重试完整 guard。
- promotion 后进程崩溃：head 已是权威，读取路径正常工作。
- 相同输入重试复用相同 publication ID/key，不制造新对象。
- 每次非 dry-run 生成前后最多清理 50 个到期、且不是当前 head 的对象。
- prepared/abandoned 保留 24 小时；superseded 保留 7 天。
- 清理顺序为 R2 delete 后 D1 CAS delete；当前 head 二次校验失败时禁止删除。
- 若不再发生生成，不会继续产生对象，已有孤儿保持有限数量。

### 7. 残余风险

无法消除第二次 serve guard 成功与 HTTP bytes 实际离开 Worker 之间的极短窗口。该 mutation 被定义为发生在本次 response authorization 之后。系统保证的是：

> 在 promotion transaction 或最终 outward guard 之前已经提交的 deny mutation，绝不能导致该 HTML 被提升或返回。

若版本化 R2 prefix 可被外部直接访问，该不变量不成立，部署必须阻断。

### 8. 确定性红测

- mutation after render：item radar、identity/feed mutation、source disabled/mismatch、backing deleted、batch revision、manual lead status/proof mutation；head 不改变。
- mutation after video read：同上；head 不改变。
- mutation immediately before candidate put：候选可写私有 key，但 promotion 拒绝。
- mutation after candidate put/before promotion：promotion CAS 为零。
- mutation after promotion/before first route guard：route 不读 R2 并返回 no-store deny。
- mutation after first route guard/before R2 get：第二 guard 拒绝。
- mutation after R2 get/before final Response：第二 guard 拒绝并丢弃 body。
- R2 put throw：无 head。
- R2 body/metadata hash mismatch：503，不返回 body。
- concurrent publisher：generation CAS 只有一个成功。
- D1 batch 中任一步失败：head、candidate state、`daily_pages` metadata 全部回滚。
- daily-video 上传不修改旧版本，使用新 publication promotion。
- archive/sitemap/latest 与 head 同事务可见，无裸 `daily_pages` 或固定-key 旁路。
- enforced 模式下缺 head 的 legacy fixed object fail-closed。

---

## OBS-001：Unicode canonical fairness

### 1. 冻结方案

选择 **持久化 raw alias→NFC canonical subject 映射、canonical subject 队列和每 source 高水位游标**。

不得继续使用固定 201-row alias probe，也不得依赖 SQLite 对 raw Unicode bytes 的相等比较。

所有 outbox tuple、bridge lookup、legacy marker ownership、producer anti-join、payload、event ID、quarantine 和 next-day dedup 均使用同一：

```text
canonical_subject_id = raw_item_id.normalize("NFC")
```

### 2. Additive D1 模型

新增 041 migration；039 保持原样：

```sql
CREATE TABLE warning_canonical_subjects (
  source_type TEXT NOT NULL
    CHECK (source_type IN ('blog','podcast')),
  canonical_subject_id TEXT NOT NULL,
  canonical_version INTEGER NOT NULL
    CHECK (canonical_version = 1),
  first_item_rowid INTEGER NOT NULL CHECK (first_item_rowid > 0),
  sort_attempts INTEGER NOT NULL CHECK (sort_attempts >= 0),
  sort_scraped_at TEXT NOT NULL,
  sort_raw_subject_id TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY(source_type, canonical_subject_id)
);

CREATE INDEX warning_canonical_subject_order_idx
  ON warning_canonical_subjects(
    source_type, sort_attempts, sort_scraped_at,
    sort_raw_subject_id, canonical_subject_id
  );

CREATE TABLE warning_subject_aliases (
  source_type TEXT NOT NULL
    CHECK (source_type IN ('blog','podcast')),
  raw_subject_id TEXT NOT NULL,
  canonical_subject_id TEXT NOT NULL,
  canonical_version INTEGER NOT NULL
    CHECK (canonical_version = 1),
  item_rowid INTEGER NOT NULL CHECK (item_rowid > 0),
  state TEXT NOT NULL CHECK (state IN ('mapped','quarantined')),
  last_error_code TEXT,
  mapped_at_ms INTEGER NOT NULL CHECK (mapped_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  PRIMARY KEY(source_type, raw_subject_id),
  CHECK (
    (state='mapped' AND last_error_code IS NULL)
    OR
    (state='quarantined'
      AND last_error_code IS NOT NULL
      AND last_error_code GLOB 'CANONICAL_*')
  )
);

CREATE INDEX warning_subject_alias_canonical_idx
  ON warning_subject_aliases(
    source_type, canonical_subject_id, raw_subject_id
  );

CREATE INDEX warning_subject_alias_rowid_idx
  ON warning_subject_aliases(source_type, item_rowid);

CREATE TABLE warning_subject_scan_cursors (
  source_type TEXT PRIMARY KEY
    CHECK (source_type IN ('blog','podcast')),
  after_item_rowid INTEGER NOT NULL DEFAULT 0
    CHECK (after_item_rowid >= 0),
  cycle_high_water_rowid INTEGER NOT NULL DEFAULT 0
    CHECK (cycle_high_water_rowid >= 0),
  cycle_no INTEGER NOT NULL DEFAULT 0 CHECK (cycle_no >= 0),
  initial_backfill_complete INTEGER NOT NULL DEFAULT 0
    CHECK (initial_backfill_complete IN (0,1)),
  lease_owner TEXT,
  lease_until_ms INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (
    (lease_owner IS NULL AND lease_until_ms IS NULL)
    OR
    (lease_owner IS NOT NULL
      AND lease_until_ms IS NOT NULL
      AND lease_until_ms >= 0)
  )
);

INSERT INTO warning_subject_scan_cursors
  (source_type, updated_at_ms)
VALUES ('blog', 0), ('podcast', 0);
```

### 3. 未来写入边界

所有使 workflow attempts 达到 6 的 blog/podcast recovery CAS，必须在同一 D1 batch 中：

1. 以 JS NFC 计算 canonical subject；
2. UPSERT `warning_canonical_subjects`；
3. INSERT exact raw alias；
4. 再提交 item attempts 更新。

canonical subject 的排序字段取所有 alias 中最小的：

```text
attempts ASC, scraped_at ASC, raw_subject_id ASC
```

普通 future transition 因此不依赖后台 cursor。podcast registry 产生的 text-blog 仍进入现有 blog recovery lane。

bridge、event builder 和 tuple lookup 接收 raw ID 时必须先 NFC；已经 canonical 的输入必须满足 `value === value.normalize('NFC')`。

### 4. 历史/修复游标

每 source、每小时：

- `MATERIALIZE_PAGE_SIZE=50`
- `MATERIALIZE_MAX_PAGES=4`
- `MATERIALIZE_MAX_ROWS=200`
- lease 5 分钟
- blog/podcast 各有独立 200-row budget

算法：

1. CAS claim source cursor。
2. 新 cycle 把 `cycle_high_water_rowid` 固定为当时 items 的 `MAX(rowid)`。
3. 只扫描：
   - `rowid > after_item_rowid`
   - `rowid <= cycle_high_water_rowid`
   - registry-managed；
   - non-terminal、non-manual、non-deleted；
   - safe_extra 合法；
   - attempts≥6；
   - 尚无 exact raw alias mapping。
4. 按 `rowid ASC, id ASC` 每页 50。
5. JS 计算 NFC，在一个 D1 batch 中写 canonical subject、aliases，并以 owner/lease CAS 推进 cursor。
6. transient D1 failure 不推进 cursor、不 quarantine。
7. 永久 canonical validation/integrity failure 写 alias quarantine，随后可继续推进。
8. 页面不足 50，表示当前 frozen high-water 后没有更多 unmapped eligible rows；完成 cycle。
9. 完成 cycle 后设置：
   - `after_item_rowid=0`
   - `cycle_no+=1`
   - 新 high-water=`MAX(rowid)`
10. 若当次仍有剩余 200-row budget，可立即进入下一 cycle。
11. crash 后 lease 到期重领；mapping insert 幂等。旧 owner 的 cursor CAS 为零。
12. 第一个 frozen high-water cycle 完成后，`initial_backfill_complete=1`。

在 `initial_backfill_complete=0` 时，target D1 producer 不得发送该 source 的新 warning，返回 `CANONICAL_BACKFILL_PENDING`。这避免尚未映射的历史 legacy alias 被错误双写。

### 5. Canonical producer scan

producer 只分页 canonical subjects，不分页 raw aliases。

SQL 使用 safe_extra CTE 后：

1. `eligible_aliases` 将当前 eligible items 与 `warning_subject_aliases(state='mapped')` join。
2. 按 canonical subject 汇总是否存在当前 UTC day legacy marker。
3. `ROW_NUMBER() OVER (PARTITION BY canonical_subject_id ORDER BY attempts,scraped_at,raw_id)` 选择代表行。
4. 在 `ORDER BY/LIMIT` 前排除：
   - 任一 alias 当前日 legacy-owned；
   - 当前 period 已存在任意状态 warning_outbox canonical tuple；
   - 无当前 eligible alias 的 canonical subject。
5. stable order：

```text
attempts ASC,
scraped_at ASC,
raw_subject_id ASC,
canonical_subject_id ASC
```

6. 保持原有每页 50、最多 4 页/200 canonical subjects。
7. guarded enqueue 在 INSERT 时再次要求：
   - 至少一个 mapped alias 当前 eligible；
   - canonical group 没有当前日 legacy marker；
   - terminal/manual/unmanaged guard 仍成立。

payload、event ID 与 outbox unique tuple 只使用 canonical subject；raw alias 不进入 event identity。

### 6. 有界进展/SLA

在无 transient D1 failure 的情况下，某 valid raw row 前存在 `N` 个尚未映射 raw aliases 时：

```text
最多 ceil((N + 1) / 200) 次该 source 的小时 invocation 完成 materialization
```

因此：

- 401 aliases 后的 valid row：最多第 3 次小时 invocation；
- 4001 aliases 后的 valid row：最多第 21 次小时 invocation。

高水位在 cycle 开始时冻结，持续到达的新 row 不能延长当前 cycle 或插到已有 valid row 之前。已有 item 在 cursor 后方才转 exhausted 时，由同步 transition hook 直接物化；修复 cursor 仍会在下一有限 cycle 补漏。

若另有 `M` 个不同 canonical subjects 排在目标前，producer 的额外上界为：

```text
ceil((M + 1) / 200) 次成功 invocation
```

transient D1 failure 不承诺墙钟 SLA，但必须保持 cursor 并暴露 oldest/cap/error 指标。

---

## OBS-001：精确可观测契约

所有时间为 UTC epoch integer；age 字段单位为秒。计数均为非负整数。

### 1. Producer/recovery result

```ts
{
  contract_version: 1;
  action: "blog-workflow-recovery" | "podcast-workflow-recovery";
  status: "disabled" | "ok" | "partial" | "error";
  source_type: "blog" | "podcast";
  producer_gate: "missing" | "disabled" | "enabled";
  drain_gate: "missing" | "disabled" | "enabled";
  table_state: "not_checked" | "ready" | "missing" | "error";
  invalid_gate_combination: boolean;
  error_code: string | null;

  found: number;
  triggered: number;
  failed: number;
  exhausted: number;
  oldest_age: number | null;

  alert_enqueued: number;
  alert_duplicates: number;
  alert_enqueue_failed: number;
  alert_integrity_errors: number;
  alert_integrity_conflicts_active: number;
  alert_integrity_conflicts_delivered: number;
  alert_integrity_conflicts_failed: number;
  integrity_conflict_ids: string[]; // sorted，最多25
  alert_producer_quarantined: number;
  alert_producer_quarantine_conflicts: number;
  alert_legacy_owned: number;
  alert_bridge_suppressed: number;
  bridge_duplicate_possible: number;

  pages_scanned: number;
  scanned_rows: number;
  scan_cap_reached: boolean;
  oldest_scanned_age: number | null;
  malformed_extra_excluded: number;

  canonicalization_ready: boolean;
  canonical_rows_scanned: number;
  canonical_rows_mapped: number;
  canonical_alias_duplicates: number;
  canonical_rows_quarantined: number;
  canonical_pages_scanned: number;
  canonical_scan_cap_reached: boolean;
  canonical_cursor_after_rowid: number;
  canonical_cycle_high_water_rowid: number;
  canonical_cycle_no: number;
  canonical_cursor_wrapped: boolean;
  canonical_lease_conflicts: number;
}
```

### 2. Drain result

```ts
{
  contract_version: 1;
  action: "warning-outbox-drain";
  status: "disabled" | "ok" | "partial" | "error";
  gate_state: "missing" | "disabled" | "enabled";
  table_state: "not_checked" | "ready" | "missing" | "error";
  error_code: string | null;

  due_found: number;
  stale_at_limit: number;
  leased: number;
  lease_conflicts: number;
  ack_conflicts: number;

  chunks_attempted: number;
  chunks_delivered: number;
  chunks_failed: number;
  destinations_configured: number;
  destinations_attempted: number;
  destinations_succeeded: number;

  delivered: number;
  retried: number;
  terminal_failed: number;
  corrupt_failed: number;

  http_failures: number;
  provider_failures: number;
  exceptions: number;
  oldest_due_age: number | null;

  attempts_claimed: {
    "1": number;
    "2": number;
    "3": number;
    "4": number;
    "5": number;
    "6": number;
  };
}
```

精确语义：

- `destinations_attempted`：实际开始的 HTTP 请求数。
- `destinations_succeeded`：HTTP 2xx 且 PushDeer business code 成功。
- `http_failures`：非 2xx。
- `provider_failures`：HTTP 成功但响应非法或业务 code 失败。
- `exceptions`：fetch throw/timeout。
- `chunks_delivered`：至少一个 destination 成功且该 chunk 的 ack CAS 成功。
- `delivered`：实际变为 delivered 的 row 数。
- `retried`：实际 nack 回 pending 的 row 数。
- `terminal_failed`：本次实际转 failed 的总数；包含 `stale_at_limit`、第六次失败和 `corrupt_failed`。
- HTTP 成功但 ack CAS 为零不得计 delivered，计 `ack_conflicts` 并使 action partial。
- 无 destination key：configured/attempted/succeeded 均为0；chunk 进入 retry/terminal，不能报告 pushed。

### 3. Retention result

```ts
{
  contract_version: 1;
  action: "warning-outbox-retention";
  status: "disabled" | "ok" | "partial" | "error";
  gate_state: "missing" | "disabled" | "enabled";
  table_state: "not_checked" | "ready" | "missing" | "error";
  error_code: string | null;

  eligible_found: number;
  delete_attempted: number;
  retained_deleted: number;
  delete_conflicts: number;
  cap_reached: boolean;
  oldest_expired_age: number | null;
}
```

每次最多删除 500 个到期 terminal rows；pending/leased 永不进入 eligible。

### 4. 状态分类与持久化

- `disabled`：gate missing/disabled；不得访问相关 D1 table。
- `ok`：无 delivery/enqueue/integrity/corrupt/recording failure。
- `partial`：动作完成但存在 retry、terminal failure、destination failure、ack conflict、canonical backfill pending 或 invalid gate。
- `error`：D1 query/transaction/table/integrity observation 本身失败。
- `cron_runs.status` 只有 `ok/error`：
  - result `ok/disabled` → `cron_runs.status=ok`
  - result `partial/error` → `cron_runs.status=error`
- drain、retention 和两个 recovery action 必须使用 required recorder。
- `result_json` 写入上述完整、固定字段；不得 `slice()` 成非法 JSON。
- 合同最大形状必须小于 4000 UTF-8 bytes；超限作为 `CRON_RESULT_OVERSIZE` 失败，不能静默截断。
- required `cron_runs` INSERT 失败必须使 action promise 失败；不得仅 console 吞掉。
- 日志和 result 不得包含 PushDeer key、凭据、完整异常堆栈或未清洗 payload。

---

## OBS-001 可执行红测

使用真实 SQLite/D1 fixture；HTTP/KV 使用本地 fake，不联网。

### Unicode/fairness

- SQLite 证明 NFC/NFD raw IDs 按 bytes 不相等，但 mapping 得到相同 canonical subject。
- NFC/NFD：
  - event ID 相同；
  - payload subject 相同；
  - bridge tuple 相同；
  - outbox 只一行。
- 使用七个不同 canonical combining marks 的排列生成至少 401 和 4001 个可验证为同一 NFC 的不同 raw IDs。
- 401 aliases + 后续 valid：不晚于第3次真实小时 invocation 发现。
- 4001 aliases + 后续 valid：不晚于第21次真实小时 invocation 发现。
- 每次扫描≤200 raw rows、≤4 pages。
- 持续在 high-water 之后插入新 rows 不能推迟当前 valid row。
- cursor 经过某 item 后，该 item 转 exhausted：同步 transition batch 立即建立 mapping。
- materialization crash：
  - mapping 写前崩溃：cursor 不前进；
  - mapping 写后/cursor CAS 前崩溃：幂等重跑；
  - lease 过期 old owner CAS 为零。
- current-day legacy marker 出现在任一 canonical alias：整个 canonical tuple 在 LIMIT 前排除。
- next UTC day 同 canonical subject 产生独立 event。
- initial backfill 未完成：target producer 零 enqueue、返回明确 partial。
- initial backfill 完成后同一 invocation 开始 canonical producer。
- 200 canonical duplicate/outbox-owned groups 不会阻塞下一 valid canonical group。
- malformed extra 在前，后续合法 exhausted canonical 仍推进。
- blog 与 podcast cursor 和 budget 独立。

### Consumer/cron observability

- gate missing、0、1 各返回精确 gate/table 状态。
- table missing/query failure 返回 error，cron row 为 error。
- 无 destination key：零 HTTP、row retry/terminal、非 delivered。
- 一个 destination HTTP 500、另一个成功：attempted=2、succeeded=1、http_failures=1，chunk ack 成功但 action 为 partial。
- HTTP throw 与 provider code 失败分别计 exceptions/provider_failures。
- 两个 chunk 一成一败：只成功 chunk ack；各字段精确。
- send 成功后 ack lease 冲突：delivered=0、ack_conflicts=rows、partial。
- 第六次 lease 过期：stale_at_limit 与 terminal_failed 增加，不发第七次 HTTP。
- retries 分别写 5/10/20/40/80 分钟。
- corrupt payload：零 HTTP、corrupt_failed 和 terminal_failed 增加。
- retention 混合 pending/leased/delivered/failed：只删到期 terminal，最多500，冲突单独计。
- drain 失败不吞 retention/legacy/recovery 兄弟 action，各自有独立 cron row。
- result JSON 最大合同仍可 parse 且≤4000 bytes。
- required cron insert 失败使 action 失败，不伪报成功。

## 最小写入集（后续实现时）

- `worker/migrations/040-daily-page-publications.sql`
- `worker/migrations/041-warning-subject-canonicalization.sql`
- `worker/src/digest/daily-page-run.ts`
- `worker/src/digest/daily-page.ts`
- `worker/src/digest/daily-video.ts`
- `worker/src/digest/daily-page-monitor.ts`
- `worker/src/digest/news-source-policy.ts`
- `worker/src/digest/news-review.ts`
- `worker/src/seo-routes.ts`
- `worker/src/ops/warning-outbox.ts`
- `worker/src/blog.ts`
- `worker/src/podcast.ts`
- `worker/src/notifier.ts`，仅增加 outbox 专用详细投递结果，不改变其他消费者
- `worker/src/index.ts`
- `worker/src/cron-runs.ts`
- 对应 focused SQLite/race/route/cron tests
- `docs/operations.md` 与现有 architecture 文档

回滚只允许暂停新 publication/producer；读取端继续使用 head 与 current guard。不得回退到公开固定 R2 key 覆盖或 raw Unicode probe。040/041 均不 drop；PR 前必须 fresh fetch 并检查 039–041 编号冲突。

当前补充稿在要求范围内无已知设计缺口。

---

# Architecture Supplement v2: RAD-001 / OBS-001

本 v2 是 RAD-001 与 OBS-001 的最终补充契约。它只修正上一补充中 reviewer 指出的可执行性缺口；其他已关闭 architecture/implementation ID 不重开。与上一补充冲突时，以 v2 为准。本阶段仅冻结设计，不创建 040/041 migration，不改任何生产代码或测试。

## V2.1 实际路径与能力基线

已根据当前 worktree 只读核实：

- `worker/src/index.ts`
  - 全局 `OPTIONS` CORS 在路由分派前直接返回 204。
  - 匿名 `/r/*` 目前支持 GET、HEAD 和 GET+Range，并在空 Referer 时放行。
  - 当前 private namespace 只有 `cc-item-pages/`。
  - `/r/*` 会对普通对象返回长时间 public immutable cache 和 `Access-Control-Allow-Origin: *`。
- `worker/wrangler.toml`
  - production/staging 都绑定 READMES R2，且 `workers_dev=true`。
  - API relay、custom domain 和 workers.dev 均可到达同一 Worker。
  - repo 内没有 R2 bucket public-domain 声明，但 dashboard/bucket 外部状态仍需部署前 preflight。
- `worker/src/digest/daily-page-run.ts` / `worker/src/seo-routes.ts`
  - 当前覆盖 `daily/<date>.html`，`/daily/<date>` 直接读该 key。
- `worker/src/digest/daily-video.ts`
  - 当前先写 `daily-video/<date>/<hash>.*`，再裸 UPSERT `daily_videos`，覆盖 legacy daily HTML，最后更新 `daily_pages.lastmod` 和发 IndexNow。
  - `daily_video_gc` 目前无 claim/fence。
- `worker/src/seo-routes.ts`
  - watch route、daily sitemap、video sitemap 和 sitemap index 目前直接信任 `daily_videos`。
- `worker/src/feeds/dedup.ts`
  - 实际 attempts CAS 在 private `markWorkflowRecoveryAttempt()`。
  - 当前 attempts UPDATE 与 canonical subject/alias 没有同一因果写契约。
- 当前 D1/SQLite 测试语义：`DB.batch()` 对语句抛错执行 rollback；但语句 `changes=0` 是成功语句，batch 会继续并 commit。

## V2.2 稳定不变量

1. R2 put/delete 与 D1 commit 之间没有跨系统原子性；任何协议都不得如此宣称。
2. 没有 authoritative D1 release head 的 page/video candidate 永远不能通过任何 public gateway 返回。
3. D1 batch 中每个安全相关写都有自己的 exact causal guard；不依赖前一语句零 changes 使后续语句 rollback。
4. outward projection 只承认当前 release head 同时绑定的 page/video publication；裸 `daily_pages`、`daily_videos` 和 R2 key 都不是授权。
5. cleaner 必须先持久 claim，promotion 永不抢占 cleanup-owned candidate；旧 cleaner 永远无法删除新 candidate 的 R2 key。
6. workflow attempts CAS 失败或 terminal completion 先赢时，不得留下由该失败 transition 授权的 canonical subject/alias。
7. migration/cutover 暖机期仍由 legacy 告警通道拥有唯一 producer authority；不得因最长 21 小时 historical materialization 导致无 legacy 也无 D1。
8. cron `result_json` 不存 raw item ID/title/error detail；严格小于 4000 UTF-8 bytes，不使用破坏 JSON 的字符串截断。

# RAD-001 v2

## RAD-V2.1 全部 public R2 gateway 的 namespace deny

实现时新增一个 host/Referer-independent canonical predicate：

```ts
isPrivateR2Namespace(rawPathOrKey): boolean
```

冻结 deny 集：

```text
cc-item-pages/**                       existing private page versions
daily/versions/**                      daily page candidates/versions
daily/publications/**                  reserved daily publication metadata objects
daily/*.html                           all legacy fixed daily HTML keys
daily-video/candidates/**              uploaded private video media candidates
daily-video/private/**                 reserved private video/media namespace
daily-video/** except virtual daily-video/public/**
```

`daily-video/public/<video_publication_id>/<mp4|poster|vtt>` 是虚拟 outward path，不是同名 R2 physical key。它必须先查 D1 current release head，再由 publication row 取出 `daily-video/candidates/**` physical key 读取。generic `/r/*` handler 不得直接拼接该 key。

public gateway 冻结覆盖：

| Gateway/变体 | private namespace 行为 |
| --- | --- |
| `GET /r/<private>` | 404 + `Cache-Control:no-store`，读 R2=0 |
| `HEAD /r/<private>` | 同 GET，不做 R2 head |
| `GET + Range /r/<private>` | 在 parse Range/R2 head 前 404，不返回 size/ETag/Content-Range |
| `OPTIONS /r/<private>` | 在全局 CORS responder 前 404/no-store，无 ACAO/credentials |
| 空 Referer | 仍 deny；Referer 不是 private authorization |
| 伪造 allowlisted Referer | 仍 deny |
| API/custom domain/workers.dev | 使用同一 predicate，host 不能覆盖 deny |
| encoded slash/backslash/dot form | raw 和一次 strict decode 均检查；非法 percent、`%2f`、`%5c`、backslash fail-closed |
| R2 bucket public domain | 部署 gate 要求 prod/staging bucket public access 为 disabled；未证明则阻断 |

private deny 必须在三处复用同一 predicate：

1. `fetch()` 全局 OPTIONS/CORS 之前；
2. `/r/*` route dispatch 之前；
3. `handleR2Asset()` 内部防御性复查。

share-poster 等内部通过 R2 binding 读取的路径不是 public gateway；它们不能把 private key 重建为 `/r/*` URL 或写入 outward payload。添加 dependency test/rg gate 阻止新的 public R2 handler 绕过 predicate。

## RAD-V2.2 统一 release head 与 video publication

上一补充的 `daily_page_publication_heads` 被一个统一指针取代：

```sql
CREATE TABLE daily_release_heads (
  date TEXT PRIMARY KEY,
  release_generation INTEGER NOT NULL CHECK (release_generation >= 1),
  page_publication_id TEXT NOT NULL UNIQUE,
  video_publication_id TEXT,
  promoted_at_ms INTEGER NOT NULL CHECK (promoted_at_ms >= 0),
  CHECK (video_publication_id IS NULL OR length(video_publication_id) = 64)
);
```

`daily_page_publications` 保留 immutable page candidate、authorization/batch snapshot、content hash 和 R2 physical key；但增加：

```text
publish_attempt_id          random 128-bit token; retry authority
base_release_generation
base_page_publication_id
bound_video_publication_id  nullable
promotion_owner
promotion_lease_until_ms
cleanup_token
cleanup_claimed_at_ms
state = prepared | promoting | published | superseded |
        abandoned | cleanup_claimed | cleaned
```

`publication_id` 必须包含 `publish_attempt_id`，不再只由 content 决定。同一调用的 retry 复用已持久 attempt ID/publication ID；cleaned 后的新调用使用新 ID 和新 R2 key，从而消除旧 cleaner 删除未来 retry-put 的 ABA。

新增 `daily_video_publications`：

```text
video_publication_id PK (64 lowercase hex)
publish_attempt_id
date
base_release_generation
mp4_key/poster_key/vtt_key              physical private candidate keys
mp4/poster/vtt sha256 + byte size + MIME
title/description/duration
state/promotion_owner/promotion_lease
cleanup_token/cleanup_claimed_at
created/promoted/cleanup timestamps
```

physical keys 冻结为：

```text
daily-video/candidates/<video_publication_id>/video.mp4
daily-video/candidates/<video_publication_id>/poster.jpg
daily-video/candidates/<video_publication_id>/captions.vtt
```

所有 daily outward consumer 使用同一 exact join：

```text
daily_release_heads
  -> daily_page_publications(state=published, exact date/generation)
  -> optional daily_video_publications(state=published, exact date)
  -> page.bound_video_publication_id IS head.video_publication_id
  -> current FORMAL_NEWS_FINAL_GUARD + batch/manual proof guard
```

`daily_pages` 和 `daily_videos` 降为 compatibility/audit projection；裸更新它们不会更改任何 outward 结果。

## RAD-V2.3 发布因果 SQL：不把 zero changes 当 rollback

### Candidate/promotion claim

page/video candidate 先以 exact attempt ID 持久为 `prepared`。promotion 在任何 R2 put 前执行：

```sql
UPDATE <publication_table>
SET state='promoting',
    promotion_owner=:owner,
    promotion_lease_until_ms=:lease_until,
    updated_at_ms=:now
WHERE publication_id=:publication_id
  AND publish_attempt_id=:attempt_id
  AND cleanup_token IS NULL
  AND state IN ('prepared','promoting')
  AND (promotion_owner IS NULL OR promotion_owner=:owner)
  AND NOT EXISTS (
    SELECT 1 FROM daily_release_heads h
    WHERE h.page_publication_id=:publication_id
       OR h.video_publication_id=:publication_id
  );
```

claim changes=0 时不 put R2，而是读当前 candidate/head 做幂等或 stale 判定。

### Release promotion batch

R2 candidate 写入且 metadata/hash 验证后，执行以下 batch。D1 在语句抛错时仍可提供 transaction rollback，但本协议不依赖 zero-change rollback。

**S1 — 唯一 release-head CAS/线性化语句：**

```sql
INSERT INTO daily_release_heads(
  date, release_generation, page_publication_id,
  video_publication_id, promoted_at_ms
)
SELECT :date, :base_generation + 1,
       :new_page_id, :new_video_id, :now
WHERE :base_generation = 0
  AND NOT EXISTS (SELECT 1 FROM daily_release_heads WHERE date=:date)
  AND EXISTS (
    SELECT 1 FROM daily_page_publications p
    WHERE p.publication_id=:new_page_id
      AND p.state='promoting'
      AND p.promotion_owner=:owner
      AND p.promotion_lease_until_ms>:now
      AND p.cleanup_token IS NULL
      AND p.base_release_generation=0
      AND p.bound_video_publication_id IS :new_video_id
      AND <page R2 metadata/hash exact>
  )
  AND (<new_video_id IS NULL> OR EXISTS (<matching promoting video candidate>))
  AND <current formal/batch/manual/video final guards>
ON CONFLICT(date) DO UPDATE SET
  release_generation=excluded.release_generation,
  page_publication_id=excluded.page_publication_id,
  video_publication_id=excluded.video_publication_id,
  promoted_at_ms=excluded.promoted_at_ms
WHERE daily_release_heads.release_generation=:base_generation
  AND daily_release_heads.page_publication_id IS :base_page_id
  AND daily_release_heads.video_publication_id IS :base_video_id
  AND <same candidate/owner/R2/final guards>;
```

**S2 — page candidate finalize，自身完整 guard：**

```sql
UPDATE daily_page_publications
SET state='published', promoted_at_ms=:now,
    promotion_owner=NULL, promotion_lease_until_ms=NULL
WHERE publication_id=:new_page_id
  AND state='promoting' AND promotion_owner=:owner
  AND cleanup_token IS NULL
  AND EXISTS (
    SELECT 1 FROM daily_release_heads h
    WHERE h.date=:date
      AND h.release_generation=:base_generation+1
      AND h.page_publication_id=:new_page_id
      AND h.video_publication_id IS :new_video_id
  )
  AND <publication digest/R2 metadata exact>;
```

**S3 — optional video candidate finalize，同样完整 guard：**

```sql
UPDATE daily_video_publications
SET state='published', promoted_at_ms=:now,
    promotion_owner=NULL, promotion_lease_until_ms=NULL
WHERE video_publication_id=:new_video_id
  AND state='promoting' AND promotion_owner=:owner
  AND cleanup_token IS NULL
  AND EXISTS (
    SELECT 1 FROM daily_release_heads h
    WHERE h.date=:date
      AND h.release_generation=:base_generation+1
      AND h.page_publication_id=:new_page_id
      AND h.video_publication_id=:new_video_id
  )
  AND <all three private R2 object hashes/sizes exact>;
```

**S4 — old page/video supersede，不能动任何 current/future head：**

```sql
UPDATE <publication_table>
SET state='superseded', cleanup_after_ms=:retention_deadline
WHERE publication_id=:old_id
  AND state='published'
  AND EXISTS (<exact new release head generation/IDs>)
  AND NOT EXISTS (
    SELECT 1 FROM daily_release_heads
    WHERE page_publication_id=:old_id OR video_publication_id=:old_id
  );
```

**S5 — compatibility `daily_pages`/`daily_videos` projection：**

`INSERT ... SELECT`/`UPDATE` 必须从 exact release head JOIN `state='published'` publication 取值，并在 `DO UPDATE WHERE` 内重复 exact date/generation/page/video IDs。不允许使用 caller 中的裸 title/key 绑定不带 head guard 的写。

### Expected changes/state matrix

| 场景 | S1 head | S2 page | S3 video | S4 old | S5 projection | 权威判定 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| 首次无 video publish | 1 | 1 | n/a | 0/1 | 1 | reread exact head+published page = success |
| upload+page joint publish | 1 | 1 | 1 | 0–2 | 1–2 | reread exact mutually-bound head/page/video = success |
| exact replay，已完成 | 0 | 0 | 0 | 0 | 0 | reread exact state = idempotent success |
| auth/batch/manual/video guard stale | 0 | 0 | 0 | 0 | 0 | stale；old release 不变 |
| base generation/head 已变 | 0 | 0 | 0 | 0 | 0 | stale，重建 |
| candidate cleanup-owned | 0 | 0 | 0 | 0 | 0 | cleanup_won，不 put/不 promote |
| S1=1 但某后续语句因软件缺陷为0 | 1 | 0/1 | 0/1 | guarded | guarded | outward mutual join fail-closed；reconciler 仅按 exact head 补写 |
| batch 语句抛错 | rollback | rollback | rollback | rollback | rollback | R2 orphan private，head 不伪成功 |
| D1 response unknown | unknown | unknown | unknown | unknown | unknown | 只读 authoritative state，不根据 meta/超时猜测 |

`meta.changes` 只用于诊断和预期矩阵断言，不是因果授权。返回 success 前必须重读：

```text
head(date,generation,page_id,video_id)
AND page.state=published + exact digests
AND optional video.state=published + exact three media digests
AND page.bound_video_publication_id IS head.video_publication_id
AND current FORMAL_NEWS_FINAL_GUARD
```

unknown outcome 处理：

- exact state 完整：成功；
- head 已是新 ID，但 ancillary state/projection 不完整：使用只能命中 exact head 的 reconciler 补 S2–S5，期间 outward fail-closed；
- head 仍是 base：重新运行 final guard 后 replay 同 attempt；
- head 已是其他 generation：stale，不覆盖。

## RAD-V2.4 Cleanup claim/fence

cleaner 每次最多 claim 50 个 due candidate。它首先用随机 128-bit `cleanup_token` 做 CAS：

```sql
UPDATE <publication_table>
SET state='cleanup_claimed',
    cleanup_token=:token,
    cleanup_claimed_at_ms=:now,
    promotion_owner=NULL,
    promotion_lease_until_ms=NULL
WHERE publication_id=:id
  AND state IN ('prepared','abandoned','superseded','cleanup_claimed')
  AND cleanup_after_ms<=:now
  AND (cleanup_token IS NULL OR cleanup_token=:token)
  AND (promotion_lease_until_ms IS NULL OR promotion_lease_until_ms<=:now)
  AND NOT EXISTS (
    SELECT 1 FROM daily_release_heads
    WHERE page_publication_id=:id OR video_publication_id=:id
  );
```

规则：

1. promotion claim 绝不接管 `cleanup_claimed`，即使 cleaner 已超时。
2. cleaner 在每个 R2 delete 紧前重读 exact token/state 且再查无 release-head reference。
3. 只有成功 claim 的 token 可执行 R2 delete。
4. delete 成功/对象本已不存在后，用 token CAS 标为 `cleaned`；不立即物理删除 tombstone。
5. cleaner 在 R2 delete 前 crash：重跑使用同一 durable token；新 promotion 不得使用该 candidate。
6. cleaner 在 R2 delete 后/D1 ack 前 crash：delete 幂等，重跑后标 cleaned。
7. repeated/concurrent cleaner：只有 exact token 路径可操作；重复 delete 安全。
8. retry-put 继续使用原 candidate 时，必须仍拥有 promotion claim 且 cleanup_token 为 NULL。
9. cleaned candidate 永不复活；新 publish attempt 生成新 publication ID/R2 key，旧 cleaner 无法删新 key。
10. daily video physical keys 的 cleaner 还必须证明没有 current release head 绑定它的 video publication。

## RAD-V2.5 Daily video 唯一可见性协议

### Upload/promotion

1. 验证 bearer/multipart/MIME/size/hash。
2. 生成 video publication/attempt ID，写 `daily-video/candidates/**`；该 namespace 对所有 public gateway deny。
3. 插入 `daily_video_publications(state=prepared)`，不写 outward-authoritative `daily_videos`。
4. 读当前 release head 与 formal authorization，以新 video candidate 重新渲染 page candidate。
5. claim page+video promotion，校验所有 private R2 hashes/sizes。
6. S1 一次更新统一 release head 的 page/video IDs；S2–S5 按上述独立 guard finalize。
7. authoritative reread 完整后才返回 upload success，并才可提交 IndexNow。

可见性只有两种：

| 时间 | Daily page | Watch route | Media route | Sitemap/IndexNow |
| --- | --- | --- | --- | --- |
| upload/promotion 前与进行中 | 旧 release 或无 | 旧 release 或 404 | 旧 release 或 404 | 旧 release only |
| exact new release fully finalized | 新 page | 新 video | 新 virtual media URLs | 新 release |

不允许新 `daily_videos`+旧 HTML、新 watch+旧 media、或 sitemap 先暴露 candidate。

### Outward boundaries

- `/daily/<date>`：使用 release head+page/video mutual join 和双 final guard。
- `/video/daily/<date>` watch route：使用同一 mutual join/current formal guard；不直接 `loadDailyVideo()`。
- `/r/daily-video/public/<video_id>/<kind>`：
  - GET/HEAD/Range 先查 current release head 精确绑定 video ID；
  - 再取 publication 中 private physical key；
  - 校验 kind/hash/size；
  - 返回 `Cache-Control:no-store`，避免旧 media URL 在 supersede/authorization deny 后继续由 edge 外放；
  - Range 仍支持 206/416，但不允许越过 head guard。
- `video-sitemap.xml`、daily sitemap 中 video URL、sitemap index lastmod：只从 current complete release projection生成。
- IndexNow：只在 authoritative reread success 后发；HTTP失败可重试，不改 release state。
- cache：watch/page/media 全部 no-store；sitemap 可短缓存，但只基于 complete release，并在 release 变更时使用新 ETag/lastmod。
- legacy `daily-video/<date>/<hash>.*` 在 cutover 后列入 generic `/r/*` deny；旧 public URL 不再有效。
- 裸 `daily_videos` mutation 只改 compatibility row，不改 head，因而不影响 page/watch/media/sitemap。

## RAD-V2.6 RAD 失败、重试与红测矩阵

| 场景 | 期望 |
| --- | --- |
| private GET/HEAD/Range，空/伪 Referer | 统一 404 no-store，R2 read/head=0 |
| private OPTIONS preflight | 全局 CORS 前 deny，无 ACAO |
| API、staging API、workers.dev、custom domain | 同 namespace 同结果 |
| encoded slash/backslash/dot bypass | fail-closed，不解析到 R2 |
| bucket public-domain preflight 未证明 disabled | release gate fail |
| head S1 zero，S2–S5执行 | 每个均因自身 head guard zero，无伪 ancillary state |
| S1 fresh=1，S2 故意 zero | outward mutual join deny，reconciler exact repair |
| replay exact completed publish | 全 zero 但 authoritative reread判 success |
| unknown D1 response，commit/未 commit 两种 | 只按 reread state 定 success/replay，不重写其他 head |
| concurrent base-generation publishers | 只一个 head CAS=1，另一个 stale |
| cleaner 先 claim，promoter 后到 | promotion=0，无 retry-put |
| promoter active lease，cleaner 到 | cleanup claim=0 |
| cleaner pre-delete crash | same token retry，current head不可删 |
| cleaner post-delete/pre-ack crash | repeated delete+token ack 幂等 |
| old cleaner delayed，new attempt 发布同 content | R2 key 因新 attempt ID 不同，旧 cleaner 不能删新 key |
| cleanup candidate 成为 current/future head 的任何 race | claim/delete guard zero，不删 |
| upload media put1成功、put2/3失败 | candidate private，head/daily_videos/IndexNow不变 |
| video candidate 完整但 page auth stale | joint promotion=0，旧 release继续 |
| page S1 与 video ancillary mismatch | page/watch/media/sitemap mutual join全 fail-closed，reconcile后同时可见 |
| 裸 daily_videos update/delete | 所有 outward bytes/URLs不变 |
| watch/media/sitemap collect 后 head race | final joined reread deny或转为新 release，不发混合响应 |
| Range first guard 后 release 变更 | R2 get前/响应前 final guard deny，不流出 old bytes |
| IndexNow failure/throw | release仍成功，只记可重试外部失败 |
| old release/media URL after supersede | no-store 404，无裸 R2 fallback |

## RAD-V2.7 RAD rollout/rollback

1. PR 前 fresh fetch，确认 040 编号未冲突；若冲突必须重编号并更新本文。
2. 先安装 additive publication/release schema；不改旧 route。
3. 部署 writer/reader shadow mode：生成 page/video candidates 和 release heads，但 outward 仍走旧路；校验快照/hash。
4. 有界回填所有需保留的 daily page/video release。
5. 验证 prod/staging R2 bucket 没有 public domain/r2.dev/custom-domain public access；无证据不 cutover。
6. 先将 outward page/watch/media/sitemap 切到 release-head reader 且 no-store；等待旧 3600s 缓存到期或做受控 purge。
7. 同一 release 打开 generic `/r/*` private/legacy deny，包含 pre-CORS OPTIONS。
8. 最后打开新 writer promotion 和 cleanup。

回滚：

- 可关闭新 writer/cleanup，但 release-head reader 与 private namespace deny 保持开启。
- 现有 complete release 继续服务；新上传/发布返回暂停，不回退覆盖 legacy key。
- 不 drop 040，不恢复裸 `daily_videos` outward 授权。

# OBS-001 v2

## OBS-V2.1 Future transition 的因果原子性

实现时在 `worker/src/feeds/dedup.ts` 新增并导出唯一 shared helper：

```ts
claimWorkflowRecoveryAttemptWithCanonicalIdentity(...)
```

blog/podcast 不得在 wrapper 内各自写 attempts/canonical mapping。helper 在 JS 中先计算：

```text
transition_token = random 128-bit hex
canonical_subject_id = item_id.normalize('NFC')
canonical_version = 1
```

对 next attempt 达到 6 的 transition，一个 D1 batch 使用以下因果链。所有后续语句都自己验证 item 上的 exact token；绝不依赖 A1 zero changes 触发 rollback。

**A1 — attempts CAS + durable cause token：**

```sql
UPDATE items
SET pending_workflow=1,
    extra=json_set(
      safe_extra,
      '$.workflow_recovery_attempts', :next_attempts,
      '$.workflow_recovery_bucket', :hour_bucket,
      '$.workflow_recovery_transition_token', :token,
      '$.workflow_recovery_transition_canonical_id', :canonical_id,
      '$.workflow_recovery_transition_version', 1
    )
WHERE id=:raw_id
  AND <exact registry-managed provenance from safe_extra>
  AND deleted_at IS NULL
  AND source_ref IS NOT 'manual_lead'
  AND workflow_completed_at IS NULL
  AND current_attempts=:prior_attempts
  AND current_bucket<>:hour_bucket
  AND :next_attempts=:prior_attempts+1
  AND :next_attempts<=6;
```

**A2 — canonical subject UPSERT，只从 cause row SELECT：**

```sql
INSERT INTO warning_canonical_subjects(...)
SELECT :source_type,:canonical_id,1,i.rowid,
       :next_attempts,i.scraped_at,i.id,:now_ms,:now_ms
FROM items i
WHERE i.id=:raw_id
  AND <exact managed/non-terminal safe_extra guard>
  AND json_extract(safe_extra,'$.workflow_recovery_transition_token')=:token
  AND json_extract(safe_extra,'$.workflow_recovery_transition_canonical_id')=:canonical_id
  AND current_attempts=:next_attempts
  AND current_bucket=:hour_bucket
ON CONFLICT(source_type,canonical_subject_id) DO UPDATE SET
  sort_attempts=MIN(sort_attempts,excluded.sort_attempts),
  sort_scraped_at=MIN(sort_scraped_at,excluded.sort_scraped_at),
  sort_raw_subject_id=MIN(sort_raw_subject_id,excluded.sort_raw_subject_id),
  updated_at_ms=excluded.updated_at_ms
WHERE EXISTS (<same exact cause-token item guard>);
```

**A3 — alias INSERT，只从同一 cause row SELECT：**

```sql
INSERT INTO warning_subject_aliases(...)
SELECT :source_type,i.id,:canonical_id,1,i.rowid,
       'mapped',NULL,:now_ms,:now_ms
FROM items i
WHERE i.id=:raw_id
  AND <same exact cause-token item guard>
ON CONFLICT(source_type,raw_subject_id) DO NOTHING;
```

**A4 — clear transition token，要求 durable exact mapping已存在：**

```sql
UPDATE items
SET extra=json_remove(
  safe_extra,
  '$.workflow_recovery_transition_token',
  '$.workflow_recovery_transition_canonical_id',
  '$.workflow_recovery_transition_version'
)
WHERE id=:raw_id
  AND workflow_completed_at IS NULL
  AND current_attempts=:next_attempts
  AND current_bucket=:hour_bucket
  AND transition_token=:token
  AND EXISTS (
    SELECT 1 FROM warning_subject_aliases a
    WHERE a.source_type=:source_type
      AND a.raw_subject_id=:raw_id
      AND a.canonical_subject_id=:canonical_id
      AND a.canonical_version=1
      AND a.state='mapped'
  );
```

状态矩阵：

| Race/结果 | A1 | A2/A3 | A4 | 最终状态 |
| --- | ---: | ---: | ---: | --- |
| CAS won | 1 | subject 0/1, alias 1/0-idempotent | 1 | attempt+mapping durable |
| same-hour/prior-attempt CAS lost | 0 | 0/0 | 0 | 不留该 token 授权的 mapping |
| terminal commits before batch | 0 | 0/0 | 0 | terminal wins |
| batch starts first, terminal waits | full batch commit | guarded mapping | clear | attempt transition 先线性化，terminal 随后可清 recovery state；mapping是历史 provenance，不自身授权 warning |
| 任一语句抛错 | rollback | rollback | rollback | next invocation retry |
| unknown response | unknown | unknown | unknown | 读 item token/attempt/bucket + exact alias；不重复增加 attempts |
| A1=1 但 A2/A3 因缺陷 zero | 1 | zero | A4=0 | token保留，producer fail-closed；reconciler仅以 token 补写 |

terminal workflow helpers 清除 recovery fields 时必须同时清 transition token/canonical/version。一个 historical alias row 仅表示 identity mapping；producer 仍在建 event 时用 current item terminal/attempt/provenance guard，所以 terminal 后 mapping 不能单独发告警。

## OBS-V2.2 Historical materializer 与独立 action

保留 v1 的 per-source frozen high-water cursor、50/page、4 pages/200 raw rows/hour 和 NFC canonical queue。但 materializer 从 workflow recovery producer 中拆成独立 action：

```text
warning-subject-backfill-blog
warning-subject-backfill-podcast
```

两者在现有 */5 scheduler 的固定 hourly slot 独立 `waitUntil` 运行，各自用 `recordCronRunRequired`；不嵌入 blog/podcast recovery early return。新 gate：

```text
WARNING_CANONICAL_BACKFILL_ENABLED
```

per-source durable readiness 只在以下条件同时成立后设为 1：

1. 第一个 frozen high-water cycle 完成；
2. 本部署的 future-hook contract version=1 已写入 cursor/state row；
3. 不存在带 transition token 但缺 exact alias 的 item；
4. 041 table/index/capability self-check 通过。

readiness 一旦为 1 不因空 backlog 重置；发现 integrity/capability 故障时转 `ready=0,error_code=...`，该 source 自动回到 legacy/bridge authority，不 fail-open 到 D1 producer。

## OBS-V2.3 Migration/cutover/rollback 阶段矩阵

P=`WARNING_OUTBOX_PRODUCER_ENABLED`，D=`WARNING_OUTBOX_DRAIN_ENABLED`，B=`WARNING_CANONICAL_BACKFILL_ENABLED`，Rₛ=每 source durable ready。effective target producer 必须满足 `P=1 AND D=1 AND Rₛ=1`。

| 阶段 | 041 | future hook | B/Rₛ | P/D | 新 exhaustion 唯一 authority | D1 backlog | 说明 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| O0 pre-migration | absent | old | off/0 | 0/0 | legacy KV | none | 现状 |
| O1 migration installed | present | old | off/0 | 0/0 | legacy KV | none | 代码尚不访问041 |
| O2 code deployed, warm start | present | v1 active | on/0 | 0/0 | legacy KV | none | future attempt=6 原子物化；historical独立扫描；可持21h但 legacy不中断 |
| O3 optional drain bridge | present | active | on/mixed | 0/1 | legacy KV after canonical D1 tuple reservation/lookup | existing only | D1 lookup failure fail-closed且下次 retry；不双写 |
| O4 one source ready | present | active | on/blog=1,podcast=0 或反之 | 1/1 | ready source=D1；not-ready source=legacy bridge | drain on | global P 不能覆盖 per-source ready |
| O5 target | present | active | on/1,1 | 1/1 | D1 only | drain */5 | 不写 KV/day marker |
| O6 rollback | present | active | keep | 0/1 | legacy bridge；existing D1 tuple suppresses KV | continue drain | 保持到 next UTC period+backlog terminal |
| O7 pure legacy rollback | present | active or disabled | keep | 0/0 | legacy KV | must be empty/terminal | 只在新 UTC period进入；不 drop041 |

稳定规则：

- `P=1,D!=1` 仍是 invalid configuration；不自动写 legacy，不假报 target。rollout 编排必须先 D 后 P。
- `P=1,D=1,Rₛ=0` 时，该 source 必须显式走 legacy bridge，不返回“producer partial 但什么都不发”。
- 041/readiness lookup 在 warm stage 失败：保持 legacy authority 并使 backfill cron error。
- target 阶段 readiness lookup 不确定：不建 D1 event；走 bridge 前必须能确定无 D1 tuple，否则保留可重试 signal，绝不双写。
- rollback 时不清 canonical tables/cursors/readiness，以便再启。

## OBS-V2.4 <4000-byte 观测合同

`cron_runs.result_json` 使用专用 `serializeWarningCronObservation()`，不直接序列化 wrapper 的任意对象。契约只包含前一补充冻结的 scalar counters/booleans/status，加以下有界 integrity 字段：

```ts
integrity_conflict_count: number;
integrity_conflict_digest: string | null;       // 64 lowercase hex
integrity_conflict_sample_tokens: string[];     // max 4, each exactly 16 hex
quarantine_conflict_count: number;
quarantine_conflict_digest: string | null;      // 64 lowercase hex
```

移除 `integrity_conflict_ids` 和所有 raw IDs。sample token 是 `SHA256(full_internal_id).slice(0,16)`；不存原 ID。digest 是对排序后完整 internal conflict IDs 的 canonical hash，只存一个 64-hex。

硬上限：

```text
WARNING_CRON_RESULT_MAX_UTF8_BYTES = 3840
```

证明契约：

- canonical JSON 无空白，key/status/error_code 全为 ASCII；
- counter 限制为 JS safe non-negative integer，单值最多 16 ASCII bytes；
- `error_code` 只能是编译时 enum，最多 64 ASCII bytes；不存 error detail；
- digest 每个最多 64 bytes；sample array 最多 `4*16 + 7` bytes；
- 不存 title、subject/raw ID、payload preview、destination key 或 stack；
- worst-case fixture 将每个 counter 设为 `9007199254740991`、每个 enum 设最长值、填满 4 tokens，使用 `TextEncoder` 断言 exact serialized bytes `<=3840`。

serializer 在实际结果超过 3840 时不 slice；它返回一个固定小于 512 bytes 的 `status=error,error_code=CRON_RESULT_OVERSIZE` 合法 JSON，并使 required recorder/action 失败。这是合同 bug，不是正常降级。

## OBS-V2.5 Drain/chunk/lookahead/retention 计数守恒

新增/精化 scalar：

```text
due_lookahead_found
due_cap_reached
rows_send_attempted
failed_at_limit
still_leased
chunks_retried
chunks_terminal_failed
chunks_ack_conflicted
retention_lookahead_found
```

### Drain lookahead

- `CLAIM_BATCH_MAX=100`、`INVOCATION_BATCH_MAX=2`。
- 每 batch due query `LIMIT 101`；只 claim 前 100，第 101 行只用于 cap signal。
- 整个 invocation 最多读 202 个 due lookahead rows、claim 200 rows。
- `due_lookahead_found` 是两次 query 实际返回数之和（0–202）；`due_cap_reached=true` 当任一 query 返回 101。
- lookahead row 不计 leased/send/retry/delivered，下次 invocation 按 stable due key 继续。

### Disjoint conservation

destination 级：

```text
destinations_attempted
  = destinations_succeeded
  + http_failures
  + provider_failures
  + exceptions
```

chunk 级每个 attempted chunk 只进入一个终态：

```text
chunks_attempted
  = chunks_delivered
  + chunks_retried
  + chunks_terminal_failed
  + chunks_ack_conflicted
```

一个 chunk 有任一 destination 成功后执行 row CAS ack：

- 全部 rows ack：`chunks_delivered+1`；
- 部分 rows ack：已 ack 计 delivered，其余计 ack_conflicts，chunk 只计 `chunks_ack_conflicted+1`；
- 零 rows ack：chunk 同样 ack-conflicted，不得计 delivered chunk。

row 级：

```text
leased
  = corrupt_failed
  + rows_send_attempted
  + still_leased

rows_send_attempted
  = delivered
  + retried
  + failed_at_limit
  + ack_conflicts

terminal_failed
  = corrupt_failed
  + failed_at_limit
  + stale_at_limit
```

`stale_at_limit` 是 invocation 开始时将 expired attempts=6 lease 转 failed 的 rows，它们不在本次 `leased` 中。`still_leased` 只允许在抛错/unknown ack 窗口出现，非零即 partial/error，下次由 lease 恢复。

### Retention semantics

retention query 固定 `LIMIT 501`：

- `retention_lookahead_found`：实际返回 0–501；
- `eligible_found = min(retention_lookahead_found,500)`；
- `delete_attempted = eligible_found`；
- 每个 DELETE 用 exact `event_id,state,expires_at_ms<=now` CAS；
- `retained_deleted`：CAS changes 总和；
- `delete_conflicts = delete_attempted-retained_deleted`；
- `cap_reached = retention_lookahead_found=501`；
- oldest age 来自第一个 stable ordered eligible row；
- pending/leased 不进 lookahead/eligible/attempted。

## OBS-V2.6 SQLite/D1/R2 能力前提与失败关闭

实现只允许使用以下已冻结能力：

| 能力 | 用途 | 验收/失败行为 |
| --- | --- | --- |
| SQLite JSON1 `json_valid/json_extract/json_type/json_each` | safe_extra、registry binds、canonical scans | 真实 SQLite + Miniflare/D1 compatibility test；缺失则 gate 不能开 |
| Window `ROW_NUMBER() OVER` | canonical alias representative | migration/runtime fixture 实执行；不降级 OFFSET/JS无界扫描 |
| UPSERT `ON CONFLICT DO UPDATE ... WHERE` | guarded head/subject writes | SQLite fixture 证明 WHERE zero-change；后续语句仍自带 guard |
| ordinary `items.rowid` | frozen high-water repair cursor | schema 没有 WITHOUT ROWID；capability test 失败则 backfill error/legacy authority |
| D1 `batch()` statement-error rollback | 减少部分 exception write | 不将 zero-change 当 exception/rollback；测试两种 |
| `meta.changes` | diagnostics only | 不作为后续语句的授权或应用层 rollback |
| R2 `head/get(range)/put/delete` | immutable candidate/media | 不假设 rename、conditional delete、transaction或 D1+R2 atomic |
| Web Crypto SHA-256 + JS NFC | event/publication identity | known vectors + NFC/NFD fixture；异常不写 cursor/head |

table/index missing、JSON/window/UPSERT 不兼容、D1 busy/timeout/unknown response、R2 I/O 失败都必须结构化返回/throw。RAD outward 在不能证明 current release 时 404/503 no-store；OBS 在 target 不能证明 D1 tuple/readiness 时不双写，保留 retryable signal。不得使用 raw JSON、raw ID byte equality、Referer、裸 compatibility row 或无界内存扫描作为降级授权。

## OBS-V2.7 OBS 完整红测矩阵

### Future transition causality

| 场景 | 期望 |
| --- | --- |
| attempts 5→6 CAS won | item=6、canonical subject+alias durable、token cleared |
| same-hour concurrent CAS | 只一个 A1=1；loser A2/A3/A4=0 |
| terminal commits before A1 | A1–A4全 zero，无新 mapping |
| terminal waits behind winning batch | mapping可作历史 identity，terminal后 producer current guard=0 |
| A1 zero 但 batch正常 commit | A2–A4 各自 zero，证明不需 rollback |
| A1=1，A2/A3语句抛错 | batch rollback，attempt未增 |
| injected A2/A3 soft zero | token保留，不清；producer deny；reconciler exact repair |
| unknown D1 response, committed | reread exact attempt/bucket/alias，不增第七次 |
| unknown D1 response, not committed | 原 CAS仍 eligible，replay一次 |
| NFC/NFD future transitions | canonical row/event tuple唯一，raw aliases两行 |
| terminal helper | transition token/canonical/version被清理 |

### Cutover/authority

| 场景 | 期望 |
| --- | --- |
| O1 041 installed/code old | legacy正常，无041 query |
| O2 4001 historical aliases | 21小时内逐步物化，期间每小时 legacy 仍是 authority |
| one source ready/one not ready, P=1,D=1 | ready走D1，not-ready走legacy bridge，不丢不双写 |
| future-hook token gap存在 | readiness不能变1 |
| 041 capability test fail | backfill cron error，ready=0，legacy authority保留 |
| P before D | invalid config，发布/cutover gate 阻断 |
| target→rollback 0/1 | existing D1 tuple suppress legacy，new tuple只写legacy reservation |
| rollback→0/0 before UTC boundary/backlog empty | gate test fail |
| next UTC period | same canonical subject得到新 event，旧 tuple不阻塞 |

### Fairness/materializer

- SQLite byte order中 401/4001 NFC-equivalent raw aliases，高水位分别在3/21次成功 hourly action 内跨过。
- sustained arrivals 在 frozen high-water 后，不延长当前 cycle。
- source cursor claim conflict、lease expiry、old-owner late advance、page write exception、crash before/after mapping 都有真实 SQLite CAS 测试。
- malformed extra/current-day legacy/permanent quarantine 在 SQL LIMIT 前排除；后续 valid canonical 同 invocation 进展。
- blog/podcast 独立 action、cursor、ready 和 200-row budget；一方失败不吞另一方。

### Observability/conservation

- worst-case observation fixture exact UTF-8 bytes `<=3840`；每个 sample token只16 hex，输出不包含 1024-byte raw ID。
- 超限 injection 输出可 parse `<512` byte error result，cron status=error，不出现 truncated JSON。
- destination 四分类在 HTTP 2xx success、500、business failure、throw 混合时严格守恒。
- 26/101/201 events 覆盖 chunk 25-event/byte cap、due lookahead 101、两 batch 202 read/200 claim cap。
- 多 destination 一成功一失败：destination 计数守恒，row ack按 chunk CAS。
- partial ack：一部分 delivered、剩余 ack_conflicts，chunk只属于 ack-conflicted。
- corrupt-before-send、retry、attempt6 failure、expired-at-limit、throw后 still-leased 逐一验证 row conservation。
- retention 0/1/500/501/mixed stale conflict：`eligible=min(lookahead,500)`、attempt=eligible、conflict=attempt-deleted，pending/leased不计入。
- required cron record failure使 action fail；兄弟 waitUntil 仍独立完成/记账。

## V2.3 最小写入集（后续实现）

### RAD-001

- `worker/migrations/040-daily-publication-release.sql`
  - page/video publication tables、unified release head、candidate promotion/cleanup state/indexes。
- `worker/src/index.ts`
  - pre-CORS private namespace deny、generic `/r/*` deny、guarded virtual daily-video media route。
- `worker/src/digest/daily-page-run.ts`
  - candidate claim/R2 put/causal promotion/reconcile/cleanup。
- `worker/src/digest/daily-page.ts`
  - authorization+video-bound immutable render snapshot。
- `worker/src/digest/daily-video.ts`
  - private upload candidate、joint page/video promotion、new cleanup fence；移除 legacy overwrite outward semantics。
- `worker/src/digest/daily-page-monitor.ts`
  - release-head freshness。
- `worker/src/digest/news-source-policy.ts`、`worker/src/digest/news-review.ts`
  - serializable final guard/batch snapshot SQL bindings，不改策略。
- `worker/src/seo-routes.ts`
  - page/watch/daily+video sitemap/index current release projection。
- `worker/wrangler.toml` 和 operations deployment check
  - 仅在需要时声明/private-bucket release gate；不开 public bucket domain。
- focused route/Range/CORS/host、D1 zero-change/unknown outcome、cleanup、video race tests。

### OBS-001

- `worker/migrations/041-warning-subject-canonicalization.sql`
  - canonical subjects、aliases、cursor/readiness/lease/index。
- `worker/src/feeds/dedup.ts`
  - **必须加入最小集**：shared attempts+cause-token+canonical mapping helper、terminal token cleanup。
- `worker/src/ops/warning-outbox.ts`
  - canonical producer、historical materializer、readiness、bounded serializer、lookahead/conservation/retention。
- `worker/src/blog.ts`、`worker/src/podcast.ts`
  - 只调 shared helper/effective per-source authority，不实现自有 CAS。
- `worker/src/ops/cron-routing.ts`、`worker/src/ops/cron-schedule.ts`、`worker/src/admin-tasks.ts`
  - 两个独立 backfill action/gate/dashboard。
- `worker/src/index.ts`、`worker/src/cron-runs.ts`
  - independent waitUntil、required bounded observation recording。
- `worker/src/notifier.ts`
  - 仅 outbox detailed destination outcome；不改其他 notifier consumer。
- `docs/operations.md`
  - 040/041 rollout、R2 private preflight、P/D/B/Rₛ matrix、rollback、metrics。
- focused real SQLite/Miniflare capability、causality、cutover、fairness、serializer/conservation tests。

## V2.4 验收门槛

1. private namespace 在 OPTIONS/GET/HEAD/Range、空/伪 Referer、API/workers.dev/custom-domain 全部无 R2 读且 404 no-store；bucket public access preflight通过。
2. page/video promotion 的每个写都有 exact release/candidate/generation guard；测试明确证明 D1 batch zero-change 会 commit，但不能造成伪 ancillary state。
3. cleanup claim/fence、promotion、retry-put、crash/replay 矩阵全绿，current/future head R2 key 永不被删。
4. upload 期间只可见完整 old release 或完整 new release；裸 `daily_videos` 不能影响 page/watch/media/sitemap/IndexNow。
5. attempts CAS lost/terminal wins 不留该 transition 授权的 mapping；shared helper 位于 `feeds/dedup.ts`。
6. O0→O7 每阶段每 source 只有一个 producer authority；4001-alias 暖机期 legacy持续，不出现21小时告警真空。
7. observation worst-case exact bytes≤3840、无 raw IDs；destination/chunk/row/retention conservation 全绿。
8. JSON1/window/UPSERT/rowid/D1 batch/R2 range 能力使用真实 SQLite+Miniflare compatibility fixture 证明；任一缺口阻断 gate，不运行时弱化。
9. 所有此前已关闭行为继续通过；不改评分权重、X policy、manual priority/审核权限或 broader notifier design。

只有以上 v2 红测、能力 gate、rollout state machine 和完整回归全部满足，才可关闭剩余 RAD-001(P1) 和 OBS-001(P1)。

# Architecture Supplement v3

本节是最后一轮局部设计修正，只替代 v2 的以下条款：

- `RAD-V2.3` 的 S1/S2/S3 video 选择语义，由 `RAD-V3.1` 的三种互斥模式替代。
- `RAD-V2.3` 中笼统的 “candidate 先持久化、再 put” 顺序，由 `RAD-V3.2` 的 parent/object 状态机替代。
- `OBS-V2.1` 的 A2/A3/A4 完整性条件与 readiness 条件，由 `OBS-V3.1` 替代。
- `OBS-V2.5` 的 chunk/row 守恒等式，由 `OBS-V3.2` 替代；destination、lookahead、retention 其余条款保持不变。

此前已关闭的 formal-news authorization、R2 deny namespaces、cleanup fence、Unicode canonical identity、公平游标、outbox、cutover、指标字节上限及所有明确排除项均保持关闭，不因本节重开或放宽。

## V3.1 稳定不变量

1. 每次 page promotion 必须且只能选择 `none`、`reuse_current`、`joint_new` 三种 video mode 之一；mode 不是可空推断值。
2. 已有 current-head video 的 page-only rerender 必须 `reuse_current`；`none` 不能隐式删除、替换或解除已有 video。
3. `reuse_current` 只能复用同 date、exact base generation/head、已发布且 digest 完全相同的 video；不执行 S3，也不 supersede 该 video。
4. `joint_new` 只能绑定同 date、exact base generation 的新 video candidate；S1 成功后必须由 S3 finalize exact candidate。
5. page/video publication parent row 及其全部 R2 object rows 必须先 durable，再取得有效 promotion/put claim；任何 R2 `put` 之前都必须能从 D1 枚举对应 owner、key、digest 和 cleanup fence。
6. A4 只有在 exact canonical subject 与 exact alias 同时存在、彼此绑定且仍由同一 cause token 授权时才清 token；单边存在永远不能变 ready。
7. 每个 claimed row 在一次 drain observation 中只有一个 pre-send 终态；每个已尝试发送的 row 只有一个 post-send 终态。`post_send_unresolved` 是正式互斥终态，不与 delivered/retried/failed 重叠。
8. 每个 attempted chunk 只有一个分类。不同 attempt bucket 的 rows 永远不进入同一 chunk，因此 retry 与 terminal-failure 不会混在一个 chunk。

## RAD-V3.1 S1 三种互斥 video mode

### Frozen binding fields

`daily_page_publications` 在 v2 字段之外冻结：

```text
video_mode = none | reuse_current | joint_new
bound_video_publication_id       nullable only for none
bound_video_digest               nullable only for none; 64 lowercase hex
base_video_publication_id        snapshot from exact base head
base_video_digest                snapshot from exact base published video
```

`video_digest` 是下列 immutable canonical tuple 的 SHA-256：

```text
schema_version
date
video_publication_id
mp4_sha256 + mp4_size + mp4_mime
poster_sha256 + poster_size + poster_mime
vtt_present + vtt_sha256/vtt_size/vtt_mime with explicit nulls
duration
```

canonical JSON、NFC、null 与编码规则沿用 outbox 的冻结规则。page render 输入、S1 guard、outward join 和 authoritative reread都使用同一 `video_digest`，不得分别重算不同子集。

### Mode matrix

| mode | exact base head | new page binding | video candidate | S3 | 允许结果 |
| --- | --- | --- | --- | --- | --- |
| `none` | base 不存在，或 base head 的 video ID 为 NULL | ID/digest 均 NULL | 不允许 | 不执行 | 无 video 的首次发布或无 video 的 page rerender |
| `reuse_current` | base head 必须有 published video | exact current ID + exact current digest | 不允许 | 不执行 | page-only rerender，video 原样保留 |
| `joint_new` | base 可无 video或有旧 video | exact new candidate ID + digest | 必须是 owned、claimed、artifacts-ready candidate | 必须执行 | page 与 exact 新 video 联合切换 |

`none` 在 base head 已有 video 时固定拒绝。移除已发布 video 属于独立 depublication 流程，不属于本补充，也不能借 page rerender 实现。

### S1 mode predicate

S1 保留 v2 的 exact date/generation/page/auth/batch/manual/R2 guards，并新增一个且只有一个为真的分支：

```sql
AND :video_mode IN ('none','reuse_current','joint_new')
AND (
  (
    :video_mode='none'
    AND :new_video_id IS NULL
    AND :new_video_digest IS NULL
    AND p.video_mode='none'
    AND p.bound_video_publication_id IS NULL
    AND p.bound_video_digest IS NULL
    AND (
      (:base_generation=0 AND NOT EXISTS (
        SELECT 1 FROM daily_release_heads h0 WHERE h0.date=:date
      ))
      OR EXISTS (
        SELECT 1 FROM daily_release_heads hb
        WHERE hb.date=:date
          AND hb.release_generation=:base_generation
          AND hb.page_publication_id=:base_page_id
          AND hb.video_publication_id IS NULL
      )
    )
  )
  OR
  (
    :video_mode='reuse_current'
    AND :new_video_id=:base_video_id
    AND :new_video_digest=:base_video_digest
    AND p.video_mode='reuse_current'
    AND p.base_release_generation=:base_generation
    AND p.base_video_publication_id=:base_video_id
    AND p.base_video_digest=:base_video_digest
    AND p.bound_video_publication_id=:base_video_id
    AND p.bound_video_digest=:base_video_digest
    AND EXISTS (
      SELECT 1
      FROM daily_release_heads hb
      JOIN daily_video_publications v
        ON v.video_publication_id=hb.video_publication_id
       AND v.date=hb.date
       AND v.state='published'
      WHERE hb.date=:date
        AND hb.release_generation=:base_generation
        AND hb.page_publication_id=:base_page_id
        AND hb.video_publication_id=:base_video_id
        AND v.video_digest=:base_video_digest
    )
  )
  OR
  (
    :video_mode='joint_new'
    AND :new_video_id IS NOT NULL
    AND :new_video_digest IS NOT NULL
    AND p.video_mode='joint_new'
    AND p.base_release_generation=:base_generation
    AND p.bound_video_publication_id=:new_video_id
    AND p.bound_video_digest=:new_video_digest
    AND EXISTS (
      SELECT 1 FROM daily_video_publications v
      WHERE v.video_publication_id=:new_video_id
        AND v.publish_attempt_id=:video_attempt_id
        AND v.date=:date
        AND v.base_release_generation=:base_generation
        AND v.state='artifacts_ready'
        AND v.promotion_owner=:owner
        AND v.promotion_lease_until_ms>:now
        AND v.cleanup_token IS NULL
        AND v.video_digest=:new_video_digest
    )
  )
)
```

参数必须是 typed bind。即使 caller 同时提供 reuse 与 joint 字段，`:video_mode` 也只能命中一个分支；不允许 `COALESCE` 或根据 nullable ID 猜 mode。

### S2/S3/S4 exact behavior

- S2 必须重复 exact `video_mode`、head generation、head video ID、page bound ID/digest。
- S3 的 `WHERE` 必须包含 `:video_mode='joint_new'`；`none`/`reuse_current` 时该语句不得被生成或执行。
- `reuse_current` 的旧 video ID 仍是新 head video ID，因此 S4 video supersede 的 `NOT EXISTS current/future head` 必须使 changes=0。
- `joint_new` 只 supersede 不再被任何 head 引用的旧 video。
- authoritative success reread必须返回 exact mode；`reuse_current` 还要重读 current video row/digest，`joint_new` 还要验证 S3 后 `state='published'`。

### RAD-V3.1 expected changes

| 场景 | S1 | S2 | S3 | old video S4 | 结果 |
| --- | ---: | ---: | ---: | ---: | --- |
| 无现有 video，`none` page publish | 1 | 1 | 不执行 | 0 | 成功 |
| 有现有 video，page-only rerender `reuse_current` | 1 | 1 | 不执行 | 0 | 新 page + 原 video |
| 前日已发布 video，次日补 page/link 且 date/head相同 release domain | 1 | 1 | 不执行 | 0 | exact head video 保留 |
| 新 video `joint_new` | 1 | 1 | 1 | 0/1 | exact 新 page/video 同时 outward |
| 有现有 video 却请求 `none` | 0 | 0 | 不执行 | 0 | stale/invalid，旧 release不变 |
| `reuse_current` ID相同但 digest 已变 | 0 | 0 | 不执行 | 0 | fail-closed，重读/重建 |
| `reuse_current` base generation/date不符 | 0 | 0 | 不执行 | 0 | fail-closed |
| `joint_new` candidate digest/date/base generation不符 | 0 | 0 | 0 | 0 | fail-closed |

## RAD-V3.2 Durable attempt/object row 先于任何 R2 put

### One parent/child model

v2 的 page/video publication rows 是 parent attempt rows；新增统一 child object inventory。这里的 “page/html/video/mp4/poster/vtt” 明确定义为：

- parent kind `page`，required child role `html`；
- parent kind `video`，required child roles `mp4`、`poster`，以及由 parent 的 `vtt_required` 决定是否 required 的 `vtt`。

不存在无 parent 的 `html/mp4/poster/vtt`，也不存在绕开 child inventory 的 R2 key。

```sql
CREATE TABLE daily_publication_objects (
  object_id TEXT PRIMARY KEY,
  publication_kind TEXT NOT NULL CHECK (publication_kind IN ('page','video')),
  publication_id TEXT NOT NULL,
  publish_attempt_id TEXT NOT NULL,
  object_role TEXT NOT NULL CHECK (object_role IN ('html','mp4','poster','vtt')),
  r2_key TEXT NOT NULL UNIQUE,
  expected_sha256 TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK (expected_size>=0),
  expected_mime TEXT NOT NULL,
  required INTEGER NOT NULL CHECK (required IN (0,1)),
  state TEXT NOT NULL CHECK (state IN (
    'planned','put_claimed','put_verified','promotion_bound',
    'superseded','cleanup_claimed','cleaned','failed'
  )),
  put_owner TEXT,
  put_lease_until_ms INTEGER,
  cleanup_token TEXT,
  cleanup_claimed_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  verified_at_ms INTEGER,
  cleaned_at_ms INTEGER,
  UNIQUE(publication_id, object_role),
  CHECK (
    (state='put_claimed' AND put_owner IS NOT NULL AND put_lease_until_ms IS NOT NULL AND cleanup_token IS NULL)
    OR state<>'put_claimed'
  )
);
```

parent FK/trigger能力若 D1 migration test不能证明，则 writer 用 exact parent EXISTS guard，reader/cleaner也执行 reciprocal join；不能假设 pragma 在生产始终开启。

### Frozen order and linearization points

1. **Prepare transaction:** 先写 immutable parent attempt row `state='prepared'`，再写其全部 child object rows `state='planned'`。video 的 optional VTT 必须在此时确定 required=0/1；之后不能改变 inventory。commit 成功前不调用 R2。
2. **Parent claim:** CAS parent 为 `state='promoting'`、exact owner/lease，要求 cleanup token NULL、attempt ID/base generation匹配。
3. **Per-object put claim:** 每个 child 由 `planned` 或同 owner 的 expired/retry `put_claimed` CAS 到 `put_claimed`，同时 exact join parent owner/lease/attempt。changes=1 或 authoritative exact same-owner claim 才可 put。
4. **R2 put:** 只写 immutable `r2_key`；请求 metadata携带 object ID、publication ID、attempt ID、expected digest。写后 HEAD 并比较 key/digest/size/MIME。
5. **Object verify CAS:** exact owner/lease/attempt/key/digest guard 将 child 置 `put_verified`。unknown response只 reread D1+R2 HEAD，不创建新 key/row。
6. **Parent artifacts-ready CAS:** 只有 exact inventory 中每个 required child 都 `put_verified` 且 hash/size/MIME匹配，parent 才到 `artifacts_ready`；optional absent VTT 必须是 durable `required=0, planned` 或专门 `failed` 不够，冻结为 `required=0,state='planned'` 且不 put、不参与 ready。
7. **Final authorization + S1:** page 使用 `none/reuse_current/joint_new`；joint video parent 与全部 required objects 必须 exact `artifacts_ready/put_verified`。S1 是 public head 线性化点，但不提供跨 D1/R2 原子性。
8. **Finalize:** S2/S3 将 parent published，child `put_verified` 以 exact current head guard置 `promotion_bound`。outward 必须 reciprocal join head、published parent、promotion_bound required objects；S1 后 finalize crash期间 fail-closed。

### Parent/object cleanup claim and fence

cleaner 先 claim parent，再 claim children；promotion 与 put 都拒绝 cleanup-owned：

```sql
UPDATE <page_or_video_publication>
SET state='cleanup_claimed', cleanup_token=:cleanup_token,
    cleanup_claimed_at_ms=:now
WHERE publication_id=:publication_id
  AND publish_attempt_id=:attempt_id
  AND state IN ('prepared','promoting','artifacts_ready','superseded','cleanup_claimed')
  AND cleanup_after_ms<=:now
  AND (cleanup_token IS NULL OR cleanup_token=:cleanup_token)
  AND NOT EXISTS (<any current or future release-head reference>);

UPDATE daily_publication_objects
SET state='cleanup_claimed', cleanup_token=:cleanup_token,
    cleanup_claimed_at_ms=:now
WHERE publication_id=:publication_id
  AND publish_attempt_id=:attempt_id
  AND state IN ('planned','put_claimed','put_verified','superseded','cleanup_claimed')
  AND (cleanup_token IS NULL OR cleanup_token=:cleanup_token)
  AND EXISTS (<exact cleanup-owned parent with same token>)
  AND NOT EXISTS (<any current or future release-head reference to parent>);
```

每个 R2 delete 前再次 authoritative read exact parent+child cleanup token、key、attempt和 no-head-reference。delete success/not-found 后才 CAS child `cleaned`。全部 materialized children cleaned 后 parent 才 `cleaned`。cleaner crash/retry复用 durable token；不同 token changes=0。promotion retry看到 cleanup claim必须结束为 `cleanup_won`，不得抢回。

### Crash/recovery matrix

| crash/failure window | durable state | 可执行恢复 | public可见性 |
| --- | --- | --- | --- |
| parent commit 前 | 无 row、且从未 put | 正常重试 prepare | old release only |
| parent已写、child inventory未完整且 transaction抛错 | 全部 rollback | 重试 prepare | old release only |
| prepare commit后、parent claim前 | parent+all children planned | promoter claim或 due cleaner枚举 | old release only |
| parent claim后、第一个 put前 | owned parent/children planned | same owner retry；lease后 fenced cleaner | old release only |
| child claim后、put前 | exact put_claimed row | HEAD absent则retry put；或 cleaner claim后删除/not-found | old release only |
| put success、D1 verify前 | exact put_claimed row + private object | HEAD验证后verify；或 fenced cleaner删除 | old release only |
| 多个video objects部分put | 全部key均有rows，部分verified | retry剩余；或逐row cleanup | old release only |
| 全部verified、artifacts-ready前 | inventory可枚举 | parent ready CAS replay | old release only |
| artifacts-ready后、S1前 | private complete candidate | final auth/S1 replay；或 due cleanup | old release only |
| S1后、S2/S3/child finalize前 | exact new head + rows | exact-head reconciler finalize | outward mutual join deny，绝不半发布 |
| promotion完成后 cleaner旧读到due | current/future-head no-reference guard zero | 不删除 | new release only |
| cleaner claim后 promoter/retry-put到达 | cleanup token durable | promotion/put zero | old/current release only |
| cleaner delete后自身crash | child仍cleanup_claimed，R2已 absent | replay delete/not-found后mark cleaned | current head不受影响 |

“无 D1 行的 R2 orphan”由调用顺序和测试 spy共同阻断：所有 page HTML、MP4、poster、VTT put helper 都必须接收从 committed object row返回的 opaque claim，而不是裸 key；没有 claim type无法调用 put。R2 put unknown也已有 row，不会产生不可枚举 key。

## OBS-V3.1 A4 exact canonical + alias completeness

### Frozen identity binding

`warning_canonical_subjects` 的 exact durable identity为：

```text
source_type
canonical_version = 1
canonical_subject_id = NFC normalized ID
canonical_row_id = SHA256("warning-subject\0" + source_type + "\0v1\0" + canonical_subject_id)
state = mapped
```

`warning_subject_aliases` 必须同时保存同一 `source_type/canonical_version/canonical_subject_id/canonical_row_id`。A2、A3、A4 的值只能来自 shared helper在 A1 写入的 exact cause tuple；不得在 A4 重新按 raw ID宽松推断。

### A2/A3 refinements

A2 的 UPSERT 在 conflict 时只有 existing row 的四元组完全相同才允许 idempotent changes=0；同 key不同 version/row ID/state 是 integrity conflict，不授权 A3。

A3 必须从 cause item JOIN exact canonical row 后 INSERT：

```sql
INSERT INTO warning_subject_aliases(
  source_type,raw_subject_id,canonical_version,
  canonical_subject_id,canonical_row_id,state,created_at_ms,updated_at_ms
)
SELECT :source_type,i.id,:canonical_version,
       :canonical_id,c.canonical_row_id,'mapped',:now_ms,:now_ms
FROM items i
JOIN warning_canonical_subjects c
  ON c.source_type=:source_type
 AND c.canonical_version=:canonical_version
 AND c.canonical_subject_id=:canonical_id
 AND c.canonical_row_id=:canonical_row_id
 AND c.state='mapped'
WHERE i.id=:raw_id
  AND <exact A1 cause-token/attempt/bucket/non-terminal guard>
ON CONFLICT(source_type,raw_subject_id) DO NOTHING;
```

### A4 replacement

```sql
UPDATE items
SET extra=json_remove(
  safe_extra,
  '$.workflow_recovery_transition_token',
  '$.workflow_recovery_transition_canonical_id',
  '$.workflow_recovery_transition_version',
  '$.workflow_recovery_transition_canonical_row_id'
)
WHERE id=:raw_id
  AND workflow_completed_at IS NULL
  AND current_attempts=:next_attempts
  AND current_bucket=:hour_bucket
  AND transition_token=:token
  AND transition_canonical_id=:canonical_id
  AND transition_canonical_version=:canonical_version
  AND transition_canonical_row_id=:canonical_row_id
  AND EXISTS (
    SELECT 1
    FROM warning_canonical_subjects c
    JOIN warning_subject_aliases a
      ON a.source_type=c.source_type
     AND a.canonical_version=c.canonical_version
     AND a.canonical_subject_id=c.canonical_subject_id
     AND a.canonical_row_id=c.canonical_row_id
    WHERE c.source_type=:source_type
      AND c.canonical_version=:canonical_version
      AND c.canonical_subject_id=:canonical_id
      AND c.canonical_row_id=:canonical_row_id
      AND c.state='mapped'
      AND a.source_type=:source_type
      AND a.raw_subject_id=:raw_id
      AND a.canonical_version=:canonical_version
      AND a.canonical_subject_id=:canonical_id
      AND a.canonical_row_id=:canonical_row_id
      AND a.state='mapped'
  );
```

A4 expected changes固定为1。changes=0时 token 保留，future producer不得把该 transition计为 canonical-ready；只允许 exact-token reconciler或人工 integrity处置。

### Readiness reciprocal-integrity queries

每 source `ready=1` 前，除 v2 条件外必须同时证明以下两个查询均不存在结果：

```sql
-- alias without exact canonical
SELECT 1
FROM warning_subject_aliases a
LEFT JOIN warning_canonical_subjects c
  ON c.source_type=a.source_type
 AND c.canonical_version=a.canonical_version
 AND c.canonical_subject_id=a.canonical_subject_id
 AND c.canonical_row_id=a.canonical_row_id
 AND c.state='mapped'
WHERE a.source_type=:source_type
  AND a.state='mapped'
  AND c.canonical_row_id IS NULL
LIMIT 1;

-- canonical without at least one exact alias
SELECT 1
FROM warning_canonical_subjects c
LEFT JOIN warning_subject_aliases a
  ON a.source_type=c.source_type
 AND a.canonical_version=c.canonical_version
 AND a.canonical_subject_id=c.canonical_subject_id
 AND a.canonical_row_id=c.canonical_row_id
 AND a.state='mapped'
WHERE c.source_type=:source_type
  AND c.state='mapped'
  AND a.raw_subject_id IS NULL
LIMIT 1;
```

任一命中都令 `ready=0,error_code=CANONICAL_MAPPING_INCOMPLETE`；target producer fail-closed并由 token reconciler/backfill修复，不能回退为按 raw byte identity生产 D1 event。

### OBS-V3.1 state matrix

| A1 | A2 | A3 | A4 | durable result |
| ---: | ---: | ---: | ---: | --- |
| 1 | 1 | 1 | 1 | new exact canonical+alias，token清除 |
| 1 | 0 exact-idempotent | 1 | 1 | 既有 exact canonical + 新 alias，合法 |
| 1 | 1 | 0 exact-idempotent same alias | 1 | exact mapping已存在，合法 replay |
| 1 | 0 mismatch/conflict | 0 | 0 | token保留，integrity conflict，ready=0 |
| 1 | 1 | 0 alias maps other canonical | 0 | canonical-without-alias可检测；token保留，ready=0 |
| 0 | 0 | 0 | 0 | lost CAS/terminal wins，不留本 token授权mapping |
| 1 | statement throw | rollback | rollback | 整批rollback；下次重试 |
| unknown | unknown | unknown | unknown | authoritative读 exact cause+canonical+alias；不重复attempt |

## OBS-V3.2 Row/chunk disjoint conservation

### Attempt-homogeneous chunks

claim 后先按 `attempts_after_claim` 分 bucket，再按 deterministic event key切 chunk。一个 chunk 内所有 rows 的 attempts完全相同：

```text
chunk_partition_key = destination_set_id + attempts_after_claim
chunk_order = period_key ASC, event_id ASC
```

不同 attempts、不同 destination set 不得合并。由此同一次 known transport failure不可能让一个 chunk同时产生 retry rows与attempt-limit terminal rows。

### Frozen row counters

```text
rows_claimed
rows_failed_pre_send
rows_send_attempted
pre_send_unresolved

rows_delivered
rows_retried
rows_failed_at_limit
post_send_unresolved

stale_at_limit
```

语义：

- `rows_failed_pre_send`：发送前通过 exact CAS durable转为 failed/quarantined 的 corrupt/integrity rows。
- `pre_send_unresolved`：已 claim，但在任何 destination attempt前发生 transient/unknown，且本 invocation未能可靠解除 lease或置 retry；row 保持 leased。
- `rows_send_attempted`：至少一个 destination调用已开始；调用 throw也算 attempted，因为请求可能已离开 worker。
- `rows_delivered`：至少一个 destination confirmed success，且 exact lease CAS 已 durable ack delivered。
- `rows_retried`：所有 destination已知失败，attempts<6，且 exact lease CAS 已 durable置 pending/next_retry。
- `rows_failed_at_limit`：所有 destination已知失败，attempts=6，且 exact lease CAS 已 durable置 failed。
- `post_send_unresolved`：发送已开始，但 delivered/retry/failed CAS结果 unknown、changes=0或状态不能归因于本 owner；该 row 在本 invocation中只能计这里。它可以在后续 invocation authoritative reconciliation后进入 durable终态，但不得回写前一次 observation。
- `stale_at_limit`：invocation开始时发现 expired lease且 attempts=6，并在未发送情况下 exact CAS到 failed；不属于本次 claimed rows。

严格等式：

```text
rows_claimed
  = rows_failed_pre_send
  + rows_send_attempted
  + pre_send_unresolved

rows_send_attempted
  = rows_delivered
  + rows_retried
  + rows_failed_at_limit
  + post_send_unresolved

rows_unresolved
  = pre_send_unresolved + post_send_unresolved

terminal_failed
  = rows_failed_pre_send + rows_failed_at_limit + stale_at_limit
```

四个 RHS category 在各自等式内两两互斥。`still_leased` 从 serialized contract 删除，避免与 unresolved双计；兼容 dashboard若需要显示，使用 derived `rows_unresolved`，不另存独立计数。

### Frozen chunk counters and unique classification

```text
chunks_attempted
chunks_delivered
chunks_retried
chunks_terminal_failed
chunks_post_send_unresolved
```

每个 attempted chunk按以下优先且互斥规则分类一次：

1. 任何 member row 为 `post_send_unresolved`：整个 chunk计 `chunks_post_send_unresolved`；其中已 durable的其他 rows仍按 row等式计 delivered/retried/failed。
2. 否则全部 member rows为 delivered：计 `chunks_delivered`。
3. 否则该 homogeneous bucket attempts<6，且全部 rows为 retried：计 `chunks_retried`。
4. 否则该 homogeneous bucket attempts=6，且全部 rows为 failed_at_limit：计 `chunks_terminal_failed`。
5. 任何不符合上述条件的组合是 `CONSERVATION_INTEGRITY_ERROR`，required cron result为 error；不得塞入最接近的类别。

严格等式：

```text
chunks_attempted
  = chunks_delivered
  + chunks_retried
  + chunks_terminal_failed
  + chunks_post_send_unresolved
```

删除含义模糊的 `chunks_failed` 和 v2 `chunks_ack_conflicted` serialized fields。需要汇总已知发送失败时可派生：

```text
chunks_known_failed = chunks_retried + chunks_terminal_failed
```

它是展示值，不持久为独立 counter。HTTP 500/throw仍由 destination counters记录；chunk结果依据 row durable outcome分类，不能把 destination failure和chunk terminal state混为一项。

### Partial ack and mixed-attempt rules

- send success + 全部 ack：rows均delivered，chunk delivered。
- send success + 部分 ack + 其余 ack unknown/conflict：已ack rows delivered，其余 post-send unresolved；chunk只计 post-send-unresolved。
- send success + ack response unknown：所有 rows post-send unresolved；不得计 delivered，即使 provider可能已收到；provider event ID负责 at-least-once dedup。
- attempts=5 与 attempts=6 rows同时 due：必须生成两个 chunks。known HTTP failure后前者 chunk retried，后者 terminal-failed；不存在 mixed chunk。
- 同一 attempt bucket因 CAS race出现部分 known retry、部分 unresolved：row分别计 retried/post-send-unresolved，chunk只计 post-send-unresolved。
- destination部分成功时进入 ack路径，不再执行 retry/failed CAS；ack unknown仍是 post-send-unresolved。

## V3.3 精确红测矩阵

### RAD-001

| 红测 | 必须断言 |
| --- | --- |
| existing published video + page-only rerender | mode=`reuse_current`；S1/S2各1；S3未prepare/未执行；old video S4=0；page/watch/media仍指 exact同一video |
| 前日补链/补页面保留video | 使用 exact current date/release-domain head绑定；新page outward后video ID/digest不变 |
| existing video + caller误传mode none | S1=0，旧head/page/video保持可见 |
| reuse same ID but mutate video digest after render | S1=0，candidate private，旧release保持 |
| reuse base generation/date mismatch | S1=0且不执行S3/S4 |
| joint new candidate exact | S1/S2/S3各1，互相bind；旧video仅在无head引用时supersede |
| joint candidate digest changes before S1 | S1/S2/S3=0 |
| caller同时填reuse/new字段 | typed mode仅允许一个分支；冲突字段使guard zero |
| spy every page/video R2 put | parent+child row已commit，parent/child claim有效；否则 helper拒绝且put调用数0 |
| crash after parent/children prepare | cleaner可枚举全部planned keys；无R2 object |
| crash after each of html/mp4/poster/vtt put before verify | exact child row可HEAD/retry或claim/delete |
| partial video upload then crash | 每个已put key有exact row；未put rows仍planned；无public route可见 |
| crash after all verify before parent ready/S1 | same attempt可replay；cleaner也可fenced claim |
| crash after S1 before each S2/S3/object finalize | outward reciprocal join fail-closed；reconciler只按exact head修复 |
| cleaner claim vs retry-put/promotion | cleanup-owned后所有put/promotion CAS=0 |
| cleaner crash before/after each delete | repeated cleaner幂等；current/future head key从不删除 |
| forced R2 put without object row/claim | type/runtime guard拒绝，R2 spy=0；证明无D1行孤儿 |

### OBS-001 canonical mapping

| 红测 | 必须断言 |
| --- | --- |
| A2=0 exact existing，A3=1 | A4=1，仅当canonical四元组exact；ready integrity query为空 |
| A2=1，A3=0 exact same alias replay | A4=1 |
| A2=1，A3 conflict to other canonical | A4=0，token保留；canonical-without-alias query命中；ready=0 |
| forged alias without canonical | A4=0；alias-without-canonical query命中 |
| canonical version/source/row ID任一 mismatch | A4=0，不清token |
| A1 lost/terminal wins | A2/A3/A4均0，无该token授权的新mapping |
| A2/A3中任意statement throw | transaction rollback；attempt不增，mapping不残留 |
| unknown response | exact cause+canonical+alias authoritative reread，不重复attempt |

### OBS-001 conservation

| 红测 | 必须断言 |
| --- | --- |
| send success + ack unknown | `rows_send_attempted=N,post_send_unresolved=N`，其他post categories为0；chunk只计post-send-unresolved；两条等式成立 |
| send success + partial ack | `delivered=K,post_send_unresolved=N-K`；chunk post-send-unresolved恰为1 |
| attempts5+attempts6 mixed input + HTTP500 | 分成两个chunks；rows分别retried/failed-at-limit；chunks分别retried/terminal-failed；无mixed/failed字段 |
| same-attempt failure + partial retry CAS conflict | known rows retried，其余post-send-unresolved；chunk唯一post-send-unresolved |
| exception before any destination call | claimed rows仅pre-send-unresolved；rows_send_attempted=0 |
| fetch throw after call begins | rows_send_attempted且post-send-unresolved，不计pre-send |
| corrupt row before send | rows_failed_pre_send，未进入chunk/rows_send_attempted |
| stale attempts=6 lease | stale_at_limit增加，不计rows_claimed或rows_send_attempted |
| generated invalid category combination | serializer/required recorder返回`CONSERVATION_INTEGRITY_ERROR`，action失败 |
| every fixture serialized | exact row/chunk equations成立，UTF-8总大小仍≤3840 |

## V3.4 最小实现写集

本节不授权立即实现；未来实现仅在既有 v2 最小写集上增加/明确以下位置：

- RAD migration（v2规划的 page/video publication migration）：增加 page video-mode/digest binding 与 `daily_publication_objects`、claim/cleanup indexes/checks。
- `worker/src/digest/daily-page-run.ts`：typed video mode、durable parent/object prepare、page HTML claim/put、S1/S2/reconcile。
- `worker/src/digest/daily-video.ts`：video parent + mp4/poster/vtt inventory、claim/put、joint S3、fenced cleanup。
- `worker/src/seo-routes.ts`、`worker/src/index.ts`：仅补 reciprocal outward joins；不改变 v2 deny策略。
- `worker/src/feeds/dedup.ts`：A2/A3/A4 exact shared helper与 authoritative result。
- `worker/src/ops/warning-outbox.ts`：readiness reciprocal checks、attempt-homogeneous chunker、v3 counters/equations/serializer validation。
- 对应 focused SQLite/Miniflare/R2 fake tests；不得改评分、X、manual priority、审核权限或 broader notifier design。

## V3.5 验收门槛

1. 三种 video mode在类型、SQL、状态矩阵和 tests中互斥；现有 video 的 page-only rerender永不丢 video，reuse digest变化必拒绝。
2. page/html/video/mp4/poster/vtt 的每个 R2 put都可由预先 committed D1 row + exact active claim证明；所有 put后 crash windows都能由同 attempt replay或 fenced cleaner有界回收。
3. A4 对 exact canonical和exact alias做单一 joined EXISTS；A2-zero/A3-one 与 A2-one/A3-conflict两条真实 SQLite tests通过，readiness双向缺口均fail-closed。
4. row/chunk categories逐项互斥且严格守恒；send-success/ack-unknown与mixed-attempt fixtures通过；`chunks_failed`/`chunks_ack_conflicted`不再出现在持久合同。
5. v2 的 private namespaces、formal authorization、cleanup no-current/future-delete、Unicode公平、cutover、destination/retention合同与≤3840-byte上限继续全绿。

只有本节红测与 v2 全部回归共同通过，才可关闭剩余 RAD-001(P1) 与 OBS-001(P1)。

# Architecture Supplement v4: Append-Only Final Contract

本节是 RAD-001 的最终替代合同。它完整取代 `RAD-V3.2` 中 publication object 自动 cleanup、cleanup claim、R2 DELETE、`cleaned`/tombstone 与 sweeper 设计；保留 v2/v3 已冻结的 private/public deny、formal-news final authorization、三种 video mode、release-head CAS、OBS 合同及所有已关闭项。

最终选择：**append-only immutable private objects；业务运行时永不自动 DELETE publication objects。**

## V4.1 Threat model 与明确 tradeoff

### 保留的失败模型

- D1 与 R2 不共享事务或线性化点。
- R2 put timeout/throw 代表 unknown completion；abort、isolate退出或调用方超时不能证明服务端停止写入。
- late put 可以在调用方已记录失败后完成。
- 同一 business revision 可能被并发 publisher、cron retry 或人工 repush同时请求。
- R2 HEAD/PUT 也可能 timeout/unknown；D1 batch response同样可能unknown。
- private object存在不等于可公开；只有 current authorized D1 release head 可以 outward。

### 主动放弃的承诺

本合同不承诺业务运行时物理回收 abandoned/orphan publication objects。失败、unknown、未promotion的对象可以永久保留在 private namespace。

这是明确 tradeoff：

- 获得：彻底移除 active lease/cleaner、DELETE/late-put resurrection、cleaner crash与永久probe容量竞态。
- 付出：publication payload存储单调增长。
- 控制：per-date/type revision quota、per-object大小上限、global cumulative payload budget、原子reservation与容量告警。

不允许把未来GC、R2 lifecycle、人工脚本或“多数失败不会真正put”计入当前容量证明。

### 最终不变量

1. publication physical key属于冻结的private deny namespaces；GET/HEAD/Range/OPTIONS、任意host/Referer均不能直接公开读取。
2. 没有 current exact release head、published publication/object tuple与 current formal-news authorization的对象不能 outward。
3. 每个新 business revision只预留一个256-bit attempt key；same revision replay读取同一reservation/token/key。
4. 失败重试不得增加slot、reserved bytes或生成新key。
5. 同一key只允许 exact相同的 business revision、attempt、role、SHA-256、size、MIME和bytes。
6. R2 HEAD tuple mismatch永久进入integrity failure；不得overwrite、promote或用新metadata解释旧对象。
7. unknown/late put只能针对same key写same bytes；没有cleanup，也就没有delete后复活。
8. abandoned object永久private且不被head引用；current/future head对象永远不删。
9. quota与global cumulative bytes在同一statement-error-backed D1事务中分配；zero changes从不充当rollback。
10. failed-before-put reservation仍永久占用slot与reserved bytes，不释放、不复用。
11. runtime publication storage adapter不暴露DELETE；所有业务、cron、admin和rollback路径的publication R2 DELETE调用数为0。
12. feature gate off只停止新reservation/put/promotion，不恢复legacy fixed-key writer、DELETE或未授权reader。

## V4.2 Additive DDL

以下为逻辑完整DDL。migration编号必须在实现前fresh fetch确认；若当时039–041仍按本spec占用，使用下一可用编号，不覆盖既有migration。

### Global cumulative budget singleton

`3 TiB = 3,298,534,883,328 bytes`。这是本namespace的运营硬预算，不是Cloudflare R2账号或bucket的技术上限。

```sql
CREATE TABLE publication_storage_budget (
  singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  namespace TEXT NOT NULL UNIQUE
    CHECK (namespace = 'daily-publications-v1'),
  budget_bytes INTEGER NOT NULL
    CHECK (budget_bytes > 0),
  legacy_baseline_bytes INTEGER NOT NULL
    CHECK (legacy_baseline_bytes >= 0),
  reserved_bytes INTEGER NOT NULL
    CHECK (reserved_bytes >= 0),
  version INTEGER NOT NULL
    CHECK (version >= 0),
  state TEXT NOT NULL
    CHECK (state IN ('uninitialized','active','frozen')),
  legacy_inventory_digest TEXT,
  legacy_inventory_object_count INTEGER,
  legacy_inventory_at_ms INTEGER,
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (legacy_baseline_bytes + reserved_bytes <= budget_bytes),
  CHECK (
    (state = 'uninitialized'
      AND legacy_inventory_digest IS NULL
      AND legacy_inventory_object_count IS NULL
      AND legacy_inventory_at_ms IS NULL)
    OR
    (state IN ('active','frozen')
      AND legacy_inventory_digest IS NOT NULL
      AND length(legacy_inventory_digest) = 64
      AND legacy_inventory_digest NOT GLOB '*[^0-9a-f]*'
      AND legacy_inventory_object_count IS NOT NULL
      AND legacy_inventory_object_count >= 0
      AND legacy_inventory_at_ms IS NOT NULL
      AND legacy_inventory_at_ms >= 0)
  )
);

INSERT INTO publication_storage_budget(
  singleton_id,namespace,budget_bytes,
  legacy_baseline_bytes,reserved_bytes,version,state,updated_at_ms
) VALUES(
  1,'daily-publications-v1',3298534883328,
  0,0,0,'uninitialized',0
);
```

`state!='active'` 时禁止reservation。migration不能把baseline=0解释为已盘点；必须由rollout inventory步骤激活。

审计预算/inventory变更：

```sql
CREATE TABLE publication_budget_audit (
  audit_id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (action IN ('activate_inventory','increase_budget','freeze')),
  old_budget_bytes INTEGER NOT NULL,
  new_budget_bytes INTEGER NOT NULL,
  old_occupied_bytes INTEGER NOT NULL,
  new_occupied_bytes INTEGER NOT NULL,
  inventory_digest TEXT,
  actor TEXT NOT NULL,
  reason TEXT NOT NULL,
  ticket_ref TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  CHECK (new_budget_bytes >= new_occupied_bytes),
  CHECK (action <> 'increase_budget' OR new_budget_bytes > old_budget_bytes)
);
```

### Reservation rows同时充当per-date/type slots

```sql
CREATE TABLE publication_reservations (
  reservation_token TEXT PRIMARY KEY,
  publication_date TEXT NOT NULL,
  publication_type TEXT NOT NULL
    CHECK (publication_type IN ('page','video')),
  slot_no INTEGER NOT NULL,
  business_revision_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL UNIQUE,
  manifest_digest TEXT NOT NULL,
  object_count INTEGER NOT NULL,
  vtt_present INTEGER NOT NULL CHECK (vtt_present IN (0,1)),
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes > 0),
  budget_version_before INTEGER NOT NULL CHECK (budget_version_before >= 0),
  state TEXT NOT NULL
    CHECK (state IN ('reserved','put_pending','put_unknown','put_verified','published','abandoned','integrity_failed')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
  CHECK (length(reservation_token)=64 AND reservation_token NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(business_revision_id)=64 AND business_revision_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(attempt_key)=64 AND attempt_key NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (
    (publication_type='page'
      AND slot_no BETWEEN 1 AND 16
      AND object_count=1
      AND vtt_present=0
      AND reserved_bytes<=2097152)
    OR
    (publication_type='video'
      AND slot_no BETWEEN 1 AND 4
      AND object_count=2+vtt_present
      AND reserved_bytes<=277872640)
  ),
  UNIQUE(publication_date,publication_type,business_revision_id),
  UNIQUE(publication_date,publication_type,slot_no)
);

CREATE INDEX publication_reservations_budget_idx
  ON publication_reservations(publication_date,publication_type,slot_no,state);
```

`277,872,640 bytes = 265 MiB`，对应MP4 256 MiB + poster 8 MiB + VTT 1 MiB。

### Publication与object rows

```sql
CREATE TABLE append_only_publications (
  publication_id TEXT PRIMARY KEY,
  reservation_token TEXT NOT NULL UNIQUE,
  publication_date TEXT NOT NULL,
  publication_type TEXT NOT NULL CHECK (publication_type IN ('page','video')),
  slot_no INTEGER NOT NULL,
  business_revision_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL UNIQUE,
  manifest_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','put_pending','put_unknown','put_verified','published','abandoned','integrity_failed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (length(publication_id)=64 AND publication_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(reservation_token)=64 AND reservation_token NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(business_revision_id)=64 AND business_revision_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(attempt_key)=64 AND attempt_key NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*'),
  UNIQUE(publication_date,publication_type,business_revision_id),
  UNIQUE(publication_date,publication_type,slot_no)
);

CREATE TABLE append_only_publication_objects (
  object_id TEXT PRIMARY KEY,
  reservation_token TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  publication_date TEXT NOT NULL,
  publication_type TEXT NOT NULL CHECK (publication_type IN ('page','video')),
  slot_no INTEGER NOT NULL,
  business_revision_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  object_role TEXT NOT NULL CHECK (object_role IN ('html','mp4','poster','vtt')),
  r2_key TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  mime TEXT NOT NULL,
  tuple_digest TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('reserved','put_pending','put_unknown','put_verified','publication_bound','abandoned','integrity_failed')),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK (length(object_id)=64 AND object_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(reservation_token)=64 AND reservation_token NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(business_revision_id)=64 AND business_revision_id NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(attempt_key)=64 AND attempt_key NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(sha256)=64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(tuple_digest)=64 AND tuple_digest NOT GLOB '*[^0-9a-f]*'),
  CHECK (
    (publication_type='page' AND object_role='html' AND size_bytes<=2097152 AND mime='text/html; charset=utf-8')
    OR
    (publication_type='video' AND object_role='mp4' AND size_bytes<=268435456 AND mime='video/mp4')
    OR
    (publication_type='video' AND object_role='poster' AND size_bytes<=8388608 AND mime IN ('image/jpeg','image/png','image/webp'))
    OR
    (publication_type='video' AND object_role='vtt' AND size_bytes<=1048576 AND mime='text/vtt; charset=utf-8')
  ),
  UNIQUE(reservation_token,object_role),
  UNIQUE(publication_id,object_role),
  UNIQUE(
    r2_key,business_revision_id,attempt_key,
    object_role,sha256,size_bytes,mime
  )
);

CREATE TABLE publication_manifest_commits (
  reservation_token TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL UNIQUE,
  manifest_digest TEXT NOT NULL,
  object_count INTEGER NOT NULL,
  total_size_bytes INTEGER NOT NULL,
  committed_at_ms INTEGER NOT NULL,
  CHECK (length(reservation_token)=64 AND reservation_token NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(manifest_digest)=64 AND manifest_digest NOT GLOB '*[^0-9a-f]*')
);
```

### Immutable-row guards

以下字段禁止UPDATE：date/type/slot、business revision、reservation token、attempt key、manifest、object tuple、reserved bytes。reservation/publication/object/manifest rows禁止DELETE。state/timestamps只能按冻结状态机前进。

实现DDL必须用`BEFORE UPDATE OF ... SELECT RAISE(ABORT,'PUBLICATION_IDENTITY_IMMUTABLE')`及`BEFORE DELETE ... RAISE(ABORT,'APPEND_ONLY_DELETE_FORBIDDEN')` triggers证明，而不是仅靠TypeScript约定。

## V4.3 单一D1 allocation transaction

### Budget trigger：constraint error是rollback authority

```sql
CREATE TRIGGER publication_reservation_budget_guard
BEFORE INSERT ON publication_reservations
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM publication_storage_budget b
    WHERE b.singleton_id=1
      AND b.namespace='daily-publications-v1'
      AND b.state='active'
      AND b.version=NEW.budget_version_before
      AND b.legacy_baseline_bytes+b.reserved_bytes+NEW.reserved_bytes<=b.budget_bytes
  ) THEN RAISE(ABORT,'PUBLICATION_BUDGET_OR_VERSION_REJECTED') END;

  UPDATE publication_storage_budget
  SET reserved_bytes=reserved_bytes+NEW.reserved_bytes,
      version=version+1,
      updated_at_ms=NEW.created_at_ms
  WHERE singleton_id=1
    AND state='active'
    AND version=NEW.budget_version_before
    AND legacy_baseline_bytes+reserved_bytes+NEW.reserved_bytes<=budget_bytes;

  SELECT CASE WHEN changes()!=1
    THEN RAISE(ABORT,'PUBLICATION_BUDGET_CAS_FAILED') END;
END;
```

若主reservation INSERT随后因business revision、slot或attempt key UNIQUE冲突而失败，同一SQLite statement中的trigger UPDATE也必须rollback。真实D1/SQLite测试必须证明；不通过则migration gate阻断。

### Exact reservation linkage triggers

`append_only_publications` 的 BEFORE INSERT trigger必须要求exact reservation tuple存在：

```text
reservation_token/date/type/slot/business_revision_id/
attempt_key/manifest_digest 全部相等
```

`append_only_publication_objects` 的 BEFORE INSERT trigger除上述tuple外，还必须验证：

- page role只能为html，key exact为`daily/versions/<attempt_key>/page.html`；
- video key exact为`daily-video/candidates/<attempt_key>/<role filename>`；
- role/MIME/size符合DDL；
- `tuple_digest = SHA256(canonical JSON of key,business_revision_id,attempt_key,role,sha256,size,mime)`；
- object不能引用另一个reservation的slot或attempt。

`publication_manifest_commits` 的 BEFORE INSERT trigger必须验证：

```text
exact reservation exists
exact publication exists
COUNT(objects) = reservation.object_count
SUM(objects.size_bytes) = reservation.reserved_bytes
set(objects.roles) = expected role set
canonical manifest digest = reservation/publication/commit manifest_digest
every object tuple references exact same reservation/date/type/slot/business revision/attempt
```

任一条件不满足必须`RAISE(ABORT,...)`。不得使用可能返回零行却成功commit的`INSERT ... SELECT`作为assertion。

### Allocation batch

新revision使用一个D1 transactional batch：

1. direct `INSERT VALUES publication_reservations`；budget trigger执行CAS。
2. direct `INSERT VALUES append_only_publications`；trigger检查exact reservation。
3. 对每个object direct `INSERT VALUES`；trigger检查exact tuple。
4. direct `INSERT VALUES publication_manifest_commits`；trigger检查count/sum/roles/digest。

任何statement error必须使budget、reservation、publication、objects和manifest全部rollback。zero changes不代表rollback，也不能被caller解释为成功。

### Slot分配与并发

- caller读取date/type最小未占用slot及当前budget version。
- 两个不同revision竞争同一末位slot：一个UNIQUE INSERT成功；loser整个batch error/rollback，authoritative reread后得到quota exhausted。
- 两个相同revision竞争：一个成功；loser因business revision UNIQUE error且budget trigger变更rollback，随后读取winner exact reservation，作为same-revision replay。
- stale budget version：trigger error，整个batch rollback；caller reread并最多有界重试3次。仍竞争则返回`budget_contention`，R2 put=0。

### Same-revision replay

replay先按`date/type/business_revision_id`读取完整reservation+manifest：

- exact manifest/object tuple相同：返回原reservation token、slot、attempt key；budget/slot不变。
- reservation存在但manifest不完整：这是migration/integrity error，fail closed；不得补插新token。
- same business revision但caller manifest不同：永久integrity failure；不得overwrite。
- D1 response unknown：authoritative读取exact tuple；存在完整commit则成功，不存在才用原planned tuple重试allocation。

## V4.4 Immutable R2 tuple与put protocol

持久identity tuple固定为：

```text
r2_key
business_revision_id
attempt_key
object_role
sha256
size_bytes
mime
```

put前必须对实际本地bytes重新计算SHA-256与byte length，并与D1 exact tuple比较：

- mismatch：`LOCAL_OBJECT_TUPLE_MISMATCH`，R2 HEAD/PUT均为0。
- match：执行R2 HEAD。

HEAD处理：

- absent：PUT exact bytes，metadata写入完整tuple及tuple digest。
- exact tuple match：idempotent reuse，PUT调用数0。
- key存在但任一tuple字段、R2 custom metadata、size或MIME mismatch：永久`integrity_failed`，PUT调用数0，绝不overwrite。
- HEAD unknown：保持`put_unknown`，不得换key或revision；same tuple下次重试。

PUT timeout/throw：

- 状态为`put_unknown`；
- 原服务端put即使late completion，也只能写same key/same bytes；
- retry重复本地校验和HEAD；
- 不创建新reservation、slot、attempt key或reserved bytes。

非确定render如果产生不同SHA或size，必须产生不同`business_revision_id`并占用新slot。禁止把不同bytes当成同revision的“修复重试”。render schema version、字体/assets/config digest必须进入business revision计算，确保差异可解释。

## V4.5 Quota、对象数与容量数学

### 固定quota与size

```text
MAX_PAGE_REVISIONS_PER_DATE  = 16
MAX_VIDEO_REVISIONS_PER_DATE = 4

HTML   <=   2 MiB
MP4    <= 256 MiB
Poster <=   8 MiB
VTT    <=   1 MiB
```

每date最坏：

```text
page:  16 × 1 object = 16 objects; 16 × 2 MiB = 32 MiB
video: 4 × 3 objects = 12 objects; 4 × 265 MiB = 1,060 MiB
total: 28 objects/date; 1,092 MiB/date = 1.06640625 GiB/date
```

365天：

```text
10,220 objects
398,580 MiB
389.23828125 GiB
```

366天：

```text
10,248 objects
399,672 MiB
390.3046875 GiB
```

failed-before-put、unknown、abandoned与published reservation全部占用上述slot/bytes；不释放，因此公式是可执行上界而非对“成功对象”的估计。

### Global cumulative budget

runtime唯一容量公式：

```text
occupied_bytes = legacy_baseline_bytes + reserved_bytes
remaining_bytes = budget_bytes - occupied_bytes
```

绝不按UTC年、publication year或任何period重置。3 TiB hard budget的raw零baseline理论长度：

```text
3072 GiB / 390.3046875 GiB per worst leap-year = 7.8707 years
```

运营必须保留至少10%给legacy inventory误差边界、R2 metadata/计费舍入和非payload安全余量。以2.7 TiB planning envelope计算：

```text
2764.8 GiB / 390.3046875 = 7.0837 worst leap-years
```

因此“3 TiB约7年”指带10%安全余量、baseline为0的planning horizon。存在legacy baseline时：

```text
planning_years = max(0, 0.9*budget_bytes - legacy_baseline_bytes)
                 / 390.3046875 GiB
```

3 TiB只是namespace运营硬预算，不代表R2账号技术容量。到100%时，budget trigger原子拒绝任何正reserved-bytes的新reservation；same-revision replay仍可读取原reservation。

### Legacy baseline inventory

在migration激活前执行一次离线、只读R2 inventory，覆盖所有将保留的legacy page/video/publication/private/fixed prefixes。输出immutable audit manifest：

```text
namespace/prefix
key
size_bytes
etag/custom digest when available
inventory timestamp
object count
total bytes
canonical manifest SHA-256
```

manifest存档位置、operator、命令版本和digest进入变更记录。migration后仅以该audit结果把singleton从`uninitialized` CAS到`active`。inventory缺prefix、LIST分页不完整、size unknown、digest缺失或总数不守恒时不激活writer。

### Alerts与预算变更

按`occupied_bytes / budget_bytes`：

- 70%：warning。
- 85%：high。
- 95%：critical，要求容量评审。
- 100%：atomic reservation rejection。

预算只能通过独立审计变更增加：必须写`publication_budget_audit`，包含actor/reason/ticket，且`new_budget_bytes >= current occupied_bytes`并严格大于旧budget。不得自动扩容、自动重置、自动删除或降低budget到已占用以下。预算变更不属于日常publication workflow。

## V4.6 No DELETE / no manual GC

publication runtime adapter只暴露`head()`与`putImmutable()`，不暴露`delete()`。page/video writer、cron、admin、rollback和reconciler不得持有publication-prefix DELETE capability。

本合同不交付人工离线GC。未来如需GC，必须新RFC、审计manifest、独立维护窗口和双人批准；不能作为本PR容量证明或rollout依赖。

此前永久tombstone、quiet period、cleanup lease、HEAD/re-delete sweeper和`cleaned`状态全部不进入实现。

## V4.7 Rollout / rollback状态矩阵

G=`private deny + outward current authorization + no-delete adapter`；R/P/H分别为reservation、private PUT、head promotion gate。missing gate按0处理。

| 阶段 | Inventory | Budget/schema | G | R/P/H | 写入authority | Outward | 规则 |
| --- | --- | --- | ---: | --- | --- | --- | --- |
| V4-R0 preflight | offline inventory进行中 | absent | 0 | 0/0/0 | 现有系统冻结变更 | 现状 | 不启用新writer |
| V4-R1 permanent guards | inventory完成并封存digest | absent | 1 | 0/0/0 | 无新append writer | guarded existing projection | private deny/no-delete/head guards先部署；不可回退 |
| V4-R2 migration | audit manifest ready | singleton uninitialized | 1 | 0/0/0 | none | guarded current | legacy fixed writer/delete仍禁用 |
| V4-R3 activation | digest/count/bytes写入 | active baseline, reserved=0 | 1 | 0/0/0 | none | guarded current | CAS激活budget |
| V4-R4 shadow | fixed baseline | active | 1 | 0/0/0 | none | guarded current | 只计算revision/size/slot，不占quota |
| V4-R5 private canary | fixed baseline | active | 1 | 1/1/0 | append-only reservation+private PUT | old guarded head | 消耗真实slot/bytes；无promotion |
| V4-R6 target | cumulative | active | 1 | 1/1/1 | append-only only | exact new/old authorized head | 正常目标态 |
| V4-R7 rollback | cumulative不减 | active或frozen | 1 | 0/0/0 | none | 最后已授权head | 停止增长；不fixed fallback、不DELETE |

无效gate组合：

- P=1,R=0；
- H=1且R/P任一为0；
- G!=1且R/P/H任一为1。

无效组合fail closed并记录required cron/config error，不恢复legacy路径。

Rollout顺序严格为：

1. private deny、no-delete adapter、outward current guards；
2. 离线inventory完成与audit digest冻结；
3. additive migration，singleton保持uninitialized；
4. 写入baseline并激活3 TiB cumulative budget；
5. shadow business revision/manifest/quota；
6. reservation；
7. private immutable PUT；
8. final authorization后head promotion。

Rollback必须保留G、schema、baseline、reserved bytes、reservation/object rows与R2 objects。feature gate off不能恢复`daily/<date>.html` fixed overwrite、裸`daily_videos` outward、publication DELETE或tombstone sweeper。

## V4.8 三十条可执行红测与 exact expected

1. **Migration singleton：** migration后恰有一行`singleton_id=1,budget=3298534883328,baseline=0,reserved=0,version=0,state=uninitialized`；第二行或reservation均constraint error。
2. **Inventory activation：** exact audit digest/count/bytes CAS后`state=active,baseline=inventory total,version=1`；缺digest或分页不完整时changes=0/error且R保持off。
3. **Stale budget version：** reservation带旧version时trigger抛`PUBLICATION_BUDGET_OR_VERSION_REJECTED`；budget/reservation/publication/object/manifest均零变化。
4. **Budget CAS error rollback：** 强制budget UPDATE changes=0时抛`PUBLICATION_BUDGET_CAS_FAILED`；不得仅返回partial/zero-success。
5. **Exactly-at-budget：** `occupied+new=budget`的reservation成功且total恰100%；下一正bytes reservation抛budget rejected，所有下游零行。
6. **Same revision replay：** 重放100次得到同reservation token/slot/attempt key；budget version、reserved bytes和row counts均只增加一次。
7. **Concurrent same revision：** 两个transaction barrier并发，恰一个INSERT成功；loserconstraint rollback后读取winner；最终一个slot、一次bytes、一个attempt key。
8. **Concurrent final page slot：** 两个不同revision竞争slot16，恰一个完整manifest commit；另一方quota exhausted；budget只计winner。
9. **Concurrent final budget bytes：** 两个revision各自可单独容纳但合计超budget，恰一个成功；最终occupied<=budget且loser无任何rows。
10. **Quota boundary：** page slots1–16成功、17失败；video slots1–4成功、5失败；失败时R2 HEAD/PUT均0。
11. **Failed-before-put occupies：** reservation commit后本地render/put失败，slot和reserved bytes保持占用；同date新revision不能复用该slot。
12. **Missing exact reservation：** publication INSERT引用不存在token，trigger error使整个batch和budget rollback。
13. **Cross-slot/token object：** object混用另reservation的slot/attempt，trigger error；object/manifest零行且allocation rollback。
14. **Manifest count/sum：** 少一个role、额外role、SUM(size)不等reserved或object_count不等时manifest trigger error；整个transaction rollback。
15. **D1 response unknown：** commit实际成功时authoritative reread返回exact manifest并作为成功；实际rollback时原planned tuple重试；两者都不双计budget。
16. **256-bit identities：** token/attempt/business/manifest/sha/tuple digest必须64 lowercase hex；63/65位或非hex全部constraint error。
17. **Local bytes mismatch：** 本地SHA或length与D1不同，返回`LOCAL_OBJECT_TUPLE_MISMATCH`；R2 HEAD=0、PUT=0、head CAS=0。
18. **HEAD exact reuse：** existing R2 key的key/business/attempt/role/SHA/size/MIME全匹配，PUT=0并可转put_verified。
19. **HEAD mismatch：** 任一tuple字段/custom metadata不同，state=`integrity_failed`，PUT=0、overwrite=0、promotion=0，后续retry仍拒绝。
20. **Unknown/late put：** 首次PUT timeout、HEAD暂时absent、原PUT晚到；retry仍使用same key/same bytes，最终exact HEAD通过，reservation/slot/bytes均不增加。
21. **Non-deterministic render：** same business revision产生不同SHA/size时永久integrity failure；只有包含新render digest的新business revision可占新slot。
22. **Private gateway：**所有publication private prefixes对GET/HEAD/Range/OPTIONS、空/伪Referer、workers.dev/API/custom/bucket域均无R2 read并返回冻结的404/no-store。
23. **No head：** put_verified或abandoned object无current head时page/watch/media/API/email/Codex outward全部fail closed。
24. **Current authorization mutation：** head建立后item/source/manual proof变为deny，所有outward consumer立即拒绝；R2 object保留且DELETE=0。
25. **Concurrent publisher promotion：** 同base generation两个完整publication最多一个S1成功；loser对象永久private且不删除，winner exact tuple outward。
26. **Per-date count/bytes：** 填满16 page+4 video(含VTT)后恰28 objects、1,092 MiB reserved；第29个业务对象只能来自已占slot的same-revision retry。
27. **Year math：** 365-date fixture恰10,220 objects/398,580 MiB；366-date fixture恰10,248 objects/399,672 MiB。
28. **3 TiB cumulative alerts：** baseline+reserved跨70/85/95%各只发对应去重级别；无年度重置；按10%余量计算horizon为7.0837 worst leap-years；100%新reservation原子拒绝。
29. **No DELETE invariant：** success、quota fail、local mismatch、HEAD mismatch、PUT unknown、abandoned、auth revoke、concurrency loser、gate off和rollback每条路径的publication R2 DELETE调用数恰为0；cron/admin registry无cleanup action。
30. **Rollback/gate semantics：** 从R6切R7后新reservation/PUT/promotion均0，最后authorized head仍可读；legacy fixed-key writes、裸outward、DELETE和tombstone sweeper调用数均0。

## V4.9 最小实现写集

本节只冻结未来实现范围，本次不修改下列文件：

- 新 additive publication migration：budget singleton/audit、reservation slots、publication/object/manifest tables、budget/linkage/immutable/no-delete triggers与indexes。
- `worker/src/digest/daily-page-run.ts`：page business revision、manifest、reservation replay、本地bytes校验、immutable HTML PUT、promotion。
- `worker/src/digest/daily-video.ts`：video business revision、MP4/poster/VTT tuple、size checks、immutable PUT、三态video promotion。
- 新或现有 publication storage adapter：只暴露HEAD/PUT，不暴露DELETE；HEAD exact matcher。
- release-head/final authorization模块及`worker/src/seo-routes.ts`、`worker/src/index.ts`：保持v2/v3 outward guards与private deny。
- cron/admin schedule与dashboard：仅容量/unknown/integrity observation；显式不存在publication cleanup task。
- migration、real SQLite D1 transaction/trigger、R2 fake、concurrency、gateway、outward、rollout/rollback focused tests，正文逐条覆盖上述30项。
- `docs/operations.md`：离线inventory manifest、3 TiB cumulative budget、10%余量、告警、扩容审计、gate matrix和rollback。

明确排除：R2 lifecycle、automatic/manual GC、DELETE、tombstone、quiet-period sweeper、bucket copy/rename、评分/X/manual priority/审核权限或broader notifier redesign。

## V4.10 最终验收门槛

1. 真实SQLite/D1 fixture证明trigger内budget UPDATE在主INSERT UNIQUE/CHECK/manifest error时整体rollback；任何zero changes均不被当作rollback。
2. exact reservation token贯穿publication/object/manifest，same-revision concurrent replay不双计slot/bytes。
3. tuple mismatch、本地bytes mismatch和unknown late put矩阵全绿，任何不同内容都不能overwrite同key。
4. global cumulative baseline+reserved从不年度重置，3 TiB hard budget、10%planning余量、inventory audit和70/85/95/100规则可观测。
5. 30条红测、所有既有outward authorization/private deny/full regression全绿。
6. 全worker publication路径、cron/admin registry与rollback证明R2 DELETE调用数为0；旧tombstone设计未进入schema、routing或runtime。

满足以上条件后，才能以append-only storage tradeoff关闭最终 RAD-001(P1)。

# Architecture Supplement v5: Executable Digest and Media Limits

本节只替代 v4 中两处不可执行/已过时合同：SQLite/D1 digest职责与MP4/容量上限。v4 的append-only、global cumulative budget、reservation transaction、private deny、outward guards、no-DELETE、rollout/rollback及其余已关闭项保持不变。

## V5.1 SQLite/D1 不具备 SHA-256 UDF

冻结事实：当前SQLite/D1 runtime没有可依赖的`sha256()` SQL function，也不安装custom UDF。migration、trigger、query不得声称能重算或验证SHA-256、canonical JSON digest或实际R2 payload digest。

因此，v4以下表述被替代：

- object INSERT trigger“验证`tuple_digest = SHA256(...)`”；
- manifest trigger“计算canonical manifest digest”；
- 任何暗示D1能证明格式正确的64-hex值具有密码学正确性的文字。

D1 trigger只允许执行：

- NOT NULL、length、lowercase-hex format；
- role/type/MIME/size limit；
- object count、`SUM(size_bytes)`、VTT presence与role set；
- reservation token、date/type/slot/business revision/attempt key的跨表exact equality；
- reservation/publication/object/manifest中重复digest字段的byte-for-byte equality；
- UNIQUE、immutable、append-only与statement-error rollback guards。

D1不能断言digest对应canonical tuple或实际bytes。格式正确但内容错误的digest可能通过纯DDL；安全性由同一个Worker/WebCrypto canonicalization boundary在所有业务边界重新证明。

## V5.2 Worker/WebCrypto是唯一canonicalization boundary

共享模块冻结为唯一实现，例如：

```text
worker/src/digest/publication-canonical.ts
```

所有page/video writer、promotion、outward route必须调用该模块；禁止各消费者自写排序、null、MIME或hash逻辑。

### Canonical object tuple v1

输入字段全部来自独立D1列与实际bytes，不从stored `tuple_digest`反向信任：

```json
{
  "schema_version": 1,
  "r2_key": "...",
  "business_revision_id": "...",
  "attempt_key": "...",
  "object_role": "html|mp4|poster|vtt",
  "sha256": "sha256(actual_bytes)",
  "size_bytes": 0,
  "mime": "..."
}
```

序列化规则：

- key顺序严格为上述顺序；不按runtime object insertion order推断；
- 所有string先Unicode NFC；禁止undefined；本schema无nullable字段；
- integer使用无前导零十进制JSON number；size必须JS safe non-negative integer；
- 无额外空白，UTF-8编码；
- `sha256(actual_bytes)`使用WebCrypto `crypto.subtle.digest('SHA-256', ArrayBuffer)`；
- `tuple_digest=SHA256(canonical tuple UTF-8 bytes)`，64 lowercase hex。

### Canonical publication manifest v1

```json
{
  "schema_version": 1,
  "publication_date": "YYYY-MM-DD",
  "publication_type": "page|video",
  "slot_no": 1,
  "business_revision_id": "...",
  "attempt_key": "...",
  "vtt_present": 0,
  "objects": []
}
```

规则：

- key顺序严格为上述顺序；
- `objects`包含完整canonical object tuple，不只包含stored digest；
- role顺序固定为`html`，或`mp4,poster,vtt`；VTT不存在时数组仅`mp4,poster`且`vtt_present=0`；
- manifest中每个object tuple必须由该次实际bytes重算；
- `manifest_digest=SHA256(canonical manifest UTF-8 bytes)`。

business revision canonicalization沿用v4字段集合，但也必须由该共享模块显式排序/NFC/UTF-8/WebCrypto生成。caller提供的business/tuple/manifest digest均不能替代重算结果。

## V5.3 四个强制重算边界

### Boundary 1：pre-reservation

在调用D1 allocation batch之前：

1. 完整render实际HTML/MP4/poster/VTT bytes；本合同不streaming。
2. 对每个实际bytes计算size与SHA-256。
3. 检查role size/MIME limit。
4. 从独立tuple字段构建canonical object tuple并计算tuple digest。
5. 构建完整canonical manifest并计算manifest digest。
6. D1 reservation/publication/object/manifest INSERT的所有字段只能来自该重算结果。

caller若同时传入expected digest，必须与Worker结果exact相等，否则在任何D1 write前返回`PRE_RESERVATION_DIGEST_MISMATCH`。

### Boundary 2：每次R2 PUT前

每次PUT或unknown retry都必须：

1. 重新读取D1的key/business revision/attempt/role/stored SHA/size/MIME/tuple digest及完整manifest字段；
2. 对本次待写实际bytes重新计算SHA和size；
3. 从D1独立字段+实际SHA/size重建tuple与manifest；
4. 要求recomputed SHA/size/tuple digest/manifest digest全部与D1 exact相等；
5. 不相等则`PUT_BOUNDARY_DIGEST_MISMATCH`，HEAD/PUT均为0。

HEAD exact tuple match只授权“本次PUT可幂等复用已有对象”；HEAD metadata本身不是promotion密码学证明。HEAD mismatch仍永久integrity fail，绝不overwrite。

### Boundary 3：promotion前

final authorization与S1之前：

1. 单次batch读exact reservation/publication/all object独立列；
2. 从private R2 GET每个required object的完整实际bytes；
3. 在Worker内重算每个SHA/size/tuple digest及完整manifest digest；
4. exact比较D1字段、R2 metadata和重算结果；
5. 任一GET/重算/比较unknown或mismatch，S1 changes必须为0。

promotion guard携带刚重算的exact manifest/object digests与D1 reservation token/generation；CAS仍检查D1当前字段未改变。不能只凭HEAD、stored digest或格式正确的64-hex promotion。

### Boundary 4：outward读取前

page HTML、watch/media、daily API及所有public media GET/HEAD/Range在current authorization/head join后，还必须：

1. 从D1独立列重建expected tuple/manifest输入；
2. 读取对应R2对象完整实际bytes；
3. WebCrypto重算SHA、size、tuple digest与manifest digest；
4. 全部exact后才生成response。

Range请求也先完整读取并验证最多64 MiB对象，再从已验证ArrayBuffer切片；HEAD同样执行完整验证后只返回headers。本合同明确不设计streaming、增量hash或trusted cache token。任何内存/GET失败都fail closed为503/404 no-store，不降级到未验证stream。

## V5.4 格式正确但错误digest的处理

真实D1 fixture必须承认以下事实：如果测试直接绕过Worker写入一组跨表相等、长度正确的错误tuple/manifest digest，DDL可以接受，因为SQLite没有SHA UDF。

安全合同是：

- 正常reservation API在写前重算并拒绝错误digest，因此不产生D1 rows；
- 测试/历史/损坏数据若已存在，promotion boundary从实际R2 bytes重算后使S1=0；
- outward boundary再次重算，哪怕错误row曾被错误标成published，也必须fail closed；
- 不允许trigger、HEAD custom metadata或caller声明覆盖Worker重算结果。

这不是DB validation缺口的fail-open，而是明确的职责分离：D1保证关系完整性和CAS，Worker/WebCrypto保证密码学内容身份。

## V5.5 可执行media limits

v4的MP4 256 MiB上限及所有派生的265/1,092 MiB数值被以下合同替代：

```text
HTML   <=  2 MiB =  2,097,152 bytes
MP4    <= 64 MiB = 67,108,864 bytes
Poster <=  8 MiB =  8,388,608 bytes
VTT    <=  1 MiB =  1,048,576 bytes
```

video revision最坏：

```text
64 + 8 + 1 = 73 MiB
73 MiB = 76,546,048 bytes
```

因此v4 reservation DDL的video branch必须在实现时使用：

```text
reserved_bytes <= 76,546,048
```

object DDL的MP4 branch必须使用：

```text
size_bytes <= 67,108,864
```

不允许保留v4的`277,872,640`或`268,435,456`限制。对象在pre-reservation前已经完整materialize；超过64 MiB直接fail closed，不占reservation，不尝试streaming或multipart。

## V5.6 替代容量数学

quota保持：

```text
16 page revisions/date
4 video revisions/date
28 objects/date worst case
```

每date：

```text
page:  16 × 2 MiB = 32 MiB; 16 objects
video: 4 × 73 MiB = 292 MiB; 12 objects
total: 324 MiB/date = 0.31640625 GiB/date; 28 objects
```

365天：

```text
28 × 365 = 10,220 objects
324 × 365 = 118,260 MiB
118,260 / 1024 = 115.48828125 GiB
```

366天：

```text
28 × 366 = 10,248 objects
324 × 366 = 118,584 MiB
118,584 / 1024 = 115.8046875 GiB
```

3 TiB global cumulative budget、baseline=0的raw horizon：

```text
3072 GiB / 115.8046875 GiB per worst leap-year
= 26.5274 worst leap-years
```

保留10%运营余量后的planning envelope：

```text
2764.8 GiB / 115.8046875
= 23.8747 worst leap-years
```

存在legacy baseline时，v4公式替换为：

```text
planning_years = max(0, 0.9*budget_bytes - legacy_baseline_bytes)
                 / 115.8046875 GiB
```

global cumulative budget、inventory baseline、70/85/95/100阈值与永不年度重置规则不变。failed-before-put reservation仍占slot和reserved actual bytes且不释放。

## V5.7 对v4三十条红测的替代

受影响编号及exact expected：

- **#12–#14 linkage/manifest：** D1只验证exact relationship、role、count、sum和重复digest equality；不得断言trigger重算SHA。manifest count/sum错误仍statement-error整批rollback。
- **#16 identities：** 64 lowercase hex只证明格式；增加断言migration SQL不引用`sha256()`或任何custom digest UDF。
- **#17 local bytes mismatch：** pre-reservation及PUT boundary分别重算实际bytes；任一SHA/size mismatch使D1 write或R2 HEAD/PUT为0。
- **#18 HEAD exact reuse：** HEAD exact仅使PUT=0；promotion仍必须R2 GET完整bytes并WebCrypto重算。
- **#19 HEAD mismatch：** 任一metadata/tuple mismatch永久integrity fail、PUT=0、overwrite=0、promotion=0。
- **#20 unknown/late put：** retry只用same key/same bytes；promotion和outward各自重新GET/hash，不信任unknown调用结果。
- **#21 non-deterministic render：** digest/size变化必须产生新business revision；同revision mismatch不得写D1/R2。
- **#26 per-date：** exact expected改为28 objects、324 MiB reserved；不再是1,092 MiB。
- **#27 year：** exact expected改为365天10,220 objects/118,260 MiB/115.48828125 GiB；366天10,248 objects/118,584 MiB/115.8046875 GiB。
- **#28 budget horizon：** raw/planning exact expected改为26.5274/23.8747 worst leap-years；70/85/95/100 cumulative行为不变。

在上述编号中增加以下真实D1+Worker subcases，不增加v4“恰30条”总编号：

1. 直接D1写入跨表相等、格式正确但错误的tuple/manifest digest，关系trigger允许；promotion Worker对实际bytes重算后S1=0。
2. 同一损坏published fixture经过outward reader，完整GET/hash mismatch后返回fail-closed且响应body bytes=0。
3. 正常Worker reservation入口收到格式正确但错误caller digest，在第一条D1 statement前拒绝，budget version/reserved rows均不变。
4. migration SQL文本/真实SQLite执行证明无`sha256()`依赖；若意外调用应出现`no such function`红测，修复后migration正常。
5. 64 MiB MP4成功完成pre-reservation、PUT、promotion与outward full-buffer验证；64 MiB+1 byte在pre-reservation fail closed，D1/R2均0。
6. Range/HEAD对64 MiB fixture仍先完成full-buffer SHA验证；损坏尾字节即使Range只请求开头也必须拒绝。

## V5.8 实现门槛与最小写集

实现门槛：

1. 当前Worker内存/测试runtime必须实际完成64 MiB ArrayBuffer + WebCrypto SHA-256 + Range slice；skip、OOM或deselect不能算通过。
2. promotion/outward的R2 GET必须有明确64 MiB hard cap；Content-Length缺失、超限或读取后size不符立即fail closed。
3. canonical module必须被page/video reservation、PUT、promotion和outward共同调用；dependency/rg test禁止复制实现。
4. migration/trigger tests必须明确证明D1只做关系断言，不做密码学断言。
5. 所有受影响红测及v4其余30条、private deny、formal authorization、no-DELETE完整回归必须全绿。

最小写集在v4基础上只需：

- additive publication migration：把video reservation/MP4 limit改为73/64 MiB，并移除任何digest-UDF trigger声明；保留format/equality/count/sum triggers。
- 新共享`worker/src/digest/publication-canonical.ts`及focused tests。
- `worker/src/digest/daily-page-run.ts`、`worker/src/digest/daily-video.ts`：pre-reservation与PUT重算。
- promotion/release-head模块：完整R2 GET + WebCrypto重算后CAS。
- `worker/src/seo-routes.ts`、`worker/src/index.ts`及其他outward media readers：完整读取、重算、再返回full/HEAD/Range。
- R2 fake/real Worker memory、真实SQLite migration、digest corruption、64 MiB boundary、Range tail-corruption tests。
- `docs/operations.md`：64 MiB no-streaming限制与更新后的累计容量horizon。

明确无需且禁止加入：streaming hash、multipart、trusted digest cache、SQLite SHA UDF、R2 DELETE、tombstone或cleanup sweeper。

满足本节执行门槛后，v4 append-only合同才具备可实现的密码学边界与media容量证明。

# Architecture Supplement: Publication Capacity Warning Outbox (042)

本补充只关闭append-only publication容量告警的持久投递缺口。它不改变migration 039的DDL、事件identity、payload、producer、KV bridge、renderer、golden或既有workflow warning语义；039与042只共享无业务字段的底层lease/chunk/delivery/retention primitive。

## C1. 稳定不变量

1. `publication_storage_budget`仍是namespace累计容量权威；`occupied_bytes=legacy_baseline_bytes+reserved_bytes`永不按年重置，100%不生成告警事件，下一笔positive-byte reservation由040原子拒绝。
2. 70%、85%、95%是永久、可审计的threshold crossing。一次成功的040 reservation、inventory activation或budget increase所引发的control/crossing变化，与budget UPDATE处于同一SQLite/D1 transaction；任何下游statement error使budget、crossing和publication graph一起rollback。
3. crossing是事实日志，永久不删除；outbox只是可重建的投递状态。publication writer的R/P/H gate关闭时，已存在的capacity pending仍必须继续投递。
4. capacity事件不进入039、不写legacy KV、不使用raw item/subject ID，也不改变PushDeer其它消费者。
5. event identity只绑定`namespace/epoch/threshold_bps/schema_version/event_type`；budget version和容量snapshot只进入payload。相同identity的不同payload是integrity conflict，不允许覆盖。

## C2. Additive DDL与事务边界

migration `042-publication-capacity-warning-outbox.sql`在040之后、budget activation之前安装，创建三张独立表：

- `publication_capacity_warning_control`：`singleton_id=1`，固定namespace/schema，保存epoch、budget/version/baseline/reserved/occupied snapshot、`uninitialized|active|frozen`与最后audit id。
- `publication_capacity_threshold_crossings`：永久主键`(namespace,epoch,threshold_bps)`，threshold只允许`7000|8500|9500`，保存完整budget snapshot、crossed time及`pending|materialized|quarantined`物化状态。
- `publication_capacity_warning_outbox`：主键`event_id`且唯一`(namespace,epoch,threshold_bps)`，record kind为`deliverable|quarantine`，投递状态为`pending|leased|delivered|failed`，attempts为0..6，并保存lease/retry/delivered/failed/expiry及结构化错误字段。

040 budget行上的042 `BEFORE UPDATE` guard只接受四类精确transition：active reservation version CAS、带exact audit的inventory activation、带exact audit且严格扩大的budget increase、带exact audit的freeze。`AFTER UPDATE` trigger在同一transaction中执行：

| Transition | epoch | crossing行为 |
| --- | --- | --- |
| uninitialized→active | `0→1` | 对activation snapshot已达到的70/85/95各插一条 |
| active reservation | 不变 | 只插`OLD ratio<threshold<=NEW ratio`的真实上穿 |
| audited budget increase | `epoch+1` | 不立即重复；只rearm后续真实上穿 |
| active→frozen | 不变 | 不产生crossing |

仍高于某阈值的小幅扩容不会在新epoch立即重复该阈值；只有扩容使ratio先落到阈值下，未来reservation再次上穿时才产生新epoch事件。crossing INSERT或control UPDATE失败会使原budget transition失败，不允许以zero changes冒充rollback。

activation/increase helper以`publication_budget_audit INSERT + exact budget CAS`执行D1 batch。response unknown后只做authoritative reread：exact audit、budget和control均匹配则视为replay；否则失败关闭。audit id、actor、reason、ticket、inventory digest/count/time均必须完整，扩容不能小于或等于旧budget。

## C3. Event、producer与损坏隔离

identity canonical JSON键序固定为：

```json
{"epoch":1,"event_type":"publication_capacity_threshold_crossed","namespace":"daily-publications-v1","schema_version":1,"threshold_bps":7000}
```

`event_id=SHA-256(identity UTF-8)`。payload canonical JSON键序固定为`budget_bytes,budget_version,crossed_at_ms,epoch,event_type,legacy_baseline_bytes,namespace,occupied_bytes,reserved_bytes,schema_version,threshold_bps`；必须满足snapshot守恒，UTF-8不超过2048 bytes，不含raw ID、subject、token、secret或任意自由文本。`payload_sha256`由Worker/WebCrypto计算；D1不声称具有SHA UDF。

producer gate为`PUBLICATION_CAPACITY_WARNING_PRODUCER_ENABLED`，missing/非`1`均disabled且不读表。每次按`crossed_at_ms,epoch,threshold_bps`读取最多50条pending crossing，并在一个D1 batch中执行deliverable outbox INSERT与crossing exact CAS。并发duplicate或response unknown必须authoritative reread完整identity/payload/hash：完全一致为materialized/replay；单边存在或内容不一致把crossing置为`quarantined`并保留确定错误，绝不覆盖active/delivered outbox。暂时D1失败保持crossing pending，供下次重试。

## C4. 独立consumer、守恒与retention

drain gate为`PUBLICATION_CAPACITY_WARNING_DRAIN_ENABLED`，missing按disabled；它与publication R/P/H gate完全独立。底层primitive固定：单次最多2页、每页100条并有101 lookahead；lease 5分钟；claim CAS把attempts原子加1且仅允许`attempts<6`。第六次HTTP/provider失败进入failed；第六次lease过期由下一次drain直接terminalize且不send，旧owner的late ack/nack为0 changes。

chunk按attempt bucket分组，每chunk最多25 events且正文最多16384 UTF-8 bytes。至少一个destination成功才逐chunk ack delivered；HTTP 500/provider callback失败进入有界retry；send throw与success-after-ack-unknown保持leased并记`post_send_unresolved`，lease过期后允许at-least-once重投。精确守恒为：

```text
rows_claimed = rows_failed_pre_send + rows_send_attempted + pre_send_unresolved
rows_send_attempted = rows_delivered + rows_retried + rows_failed_at_limit + post_send_unresolved
chunks_attempted = chunks_delivered + chunks_retried
                 + chunks_terminal_failed + chunks_post_send_unresolved
destinations_attempted = destinations_succeeded + http_failures
                       + provider_failures + exceptions
```

required cron observation使用固定计数、gate/table/status/error、attempt buckets、oldest age与cap字段；serializer移除任何`id/payload/secret/token/detail`字段，UTF-8硬上限3840 bytes。partial/error或cron_runs写入失败都使独立action失败。

delivered outbox保留30天；failed/quarantine保留90天；daily retention每次最多删除500条到期outbox并报告lookahead/eligible/attempted/deleted/conflicts/cap/oldest age。crossing永久保留且有no-delete trigger。

## C5. Cron、rollout与rollback

每个现有`*/5` tick分别启动以下独立`waitUntil` action，任一失败不能shadow其它action或legacy lane：

- `publication-capacity-warning-produce`
- `publication-capacity-warning-drain`
- 既有`warning-outbox-drain`

UTC 03:35（BJT 11:35）另运行`publication-capacity-warning-retention`与既有039 retention；legacy KV digest仍只在UTC 23:00。task registry/dashboard把两个capacity `*/5` action显示为cadence band，不解释成午夜点。

rollout顺序冻结为：040 schema且R/P/H off → 042 schema → 离线inventory/audit → activate budget → capacity drain gate on → capacity producer gate on → publication R/P/H逐级启用。启用producer前必须先确认drain可用；若042 table/control缺失或gate组合未准备好，publication activation/writer fail closed，不回退legacy writer。

rollback只关闭publication R/P/H及capacity producer；capacity drain保持开启直到所有既有deliverable终态。不得drop 042、删除crossing、回收reserved bytes、把capacity事件双写到039/KV或恢复任何publication DELETE路径。

## C6. 可执行红测矩阵与最小写集

必须具备：真实SQLite三表/CHECK/index/no-delete；activation缺audit拒绝；reservation失败使crossing rollback；exact-budget成功且下一positive byte拒绝；70/85/95各一次且无100%；扩容epoch rearm/仍高不重复/降后再上穿；stable identity与不同budget payload；payload≤2048且无raw/secret；producer concurrent duplicate、commit/rollback unknown authoritative reread、单边损坏quarantine；gate off与table missing；concurrent lease；HTTP、provider callback、exception、partial destination、ack unknown；恰六次send且无第七次；expired sixth lease与late owner；30/90天retention且crossing保留；R/P/H off仍drain；required cron记录与action隔离；039 migration hash、payload/bridge/renderer/golden全回归。

同时补齐v4/v5 #2、#5、#7–#9、#15、#26–#28：same revision并发只计一次；最终slot/预算竞争只有一个完整winner；D1 unknown复用原planned tuple且不双计；28 objects/324 MiB每date；365/366为10,220/10,248 objects与118,260/118,584 MiB；3 TiB raw/planning horizon为26.5274/23.8747 worst leap-years。

最小写集仅限：migration 042；capacity outbox module/tests；抽取的不含039业务语义的reliable-outbox primitive；040 reservation并发/unknown修复与capacity常量测试；cron routing/schedule/index/admin tests；本architecture、implementation plan与operations文档。明确排除评分、X、manual priority、审核权限、039 schema/业务payload、其它notifier redesign、部署与生产变更。
