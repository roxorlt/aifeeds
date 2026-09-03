# 补录线索评估门禁修复 · 设计规格（2026-09-03）

> **背景事实（prod D1 实测，2026-09-03）**
> - `manual_news_assessment_generation_revisions_v2` 自 8/13 起共 54 次大模型评估调用，**0 次通过校验**（52 次 `validation_failed`：`invalid_claim_predicate` 12 / `non_atomic_source_assembled` 10 / `non_atomic_source_object` 7 / `invalid_claim_subject_role` 6 / `invalid_claim_object` 5 / `evidence_disposition_*` 8 / `invalid_editorial_projection_*` 4；2 次 `provider_failed`）。
> - 近 45 天 42 条线索：25 条 `needs_review`、16 条 `failed`、1 条 `recommended`。唯一进候选池的（8/29 `ml-20260828-916b99491d70`）走的是 `source_support_v1` 官方第一人称放行，**没有经过**大模型评估。
> - `confirmManualNewsLeadCandidate`（store.ts:2467）要求 `loadVerifiedManualAssessment` 非空，否则 409 `lead_not_fact_verified`；页面「确认加入候选池」按钮又要求 `assessment.event_key`（run.mjs:6009）。因此 `needs_review + assessment_validation_failed` 的线索 owner 无法手动确认，是死胡同。
> - 根因：校验器 `FACT_ACTION_PATTERNS`（manual-news-leads.ts:3707）要求谓语恰含 32 个动作之一，但提示词（`buildManualLeadAssessmentPrompt`，:2986）**从未告知模型这份词表**；且 AI 新闻最常见的动词（announce / unveil / introduce / roll out / 宣布 / 亮相 / 公布）不在词表里；重生成反馈（:3140）只给 code + path，不回显出错的槽位文本。
>
> **owner 决定（2026-09-03）**：方案 1 + 2 + 3 全做，设计、上线、验收由本会话完成，不再逐项索要授权。

---

## 0. 总体拆分与交付顺序

| 编号 | 内容 | 仓库 / 分支 | 交付形态 |
|---|---|---|---|
| PR-A | 方案 1（提示词词表 + 词表扩充 + 谓语归一化 + 反馈回显）+ 方案 2（官方 X 账号白名单） | aifeeds `cc/20260903-manual-news-predicate-vocab`（从 origin/main 开） | PR → staging 验证 → 合并（CI 自动部署 prod） |
| PR-B | 方案 3 云端：`owner_vouched_v1` 担保确认路径 + API | aifeeds `cc/20260903-manual-news-owner-vouch`（从 origin/main 开） | 同上；若 PR-A 先合并则 rebase |
| 面板 | 方案 3 页面：代理放行 `vouch-candidate` + latest 页面「担保加入候选池」+ 需复核原因文案 + 证据类型标签 | dailyVideo worktree `/Users/roxor/Documents/dailyVideo/.worktrees/review-ux-baton-race`（分支 `cc/20260902-review-ux-and-baton-race`，生产源码所在分支） | 代理：面板补丁脚本 v18；页面：render release 部署 + 当日 `--refresh-share-index` |

**硬约束（所有执行者）**
- 不改 secret 文件；不在代码、文档、日志里写任何 token 值；测试夹具用假值。
- 不改 `MANUAL_LEAD_VERIFICATION_POLICY_VERSION`（`fact-evidence-projection-hmac-v10`）；对已持久化的已验证评估只允许「放宽」不允许「收紧」（否则加载时会被判 tamper 隔离）。
- 每个 PR 全量跑 `cd worker && npm test`（vitest + node --test）并 `npx tsc --noEmit -p worker`；面板跑 `node --test workflows/aifeeds-daily/*.test.mjs`（从仓库根目录）。
- TDD：先写失败测试再实现；每处新逻辑做一轮变异验证（故意改坏实现确认测试变红）。
- 小步提交，commit message 中文，尾部按会话规范附 Co-Authored-By。
- 不 push、不 merge、不 deploy——交回主会话复核后统一执行。

---

## 1. PR-A · 方案 1：让模型知道词表，并让校验器认识常见动词

### 1.1 词表对照表（新增，manual-news-leads.ts）

新增 `FACT_ACTION_VOCABULARY: ReadonlyArray<{ action: FactAction; zh: readonly string[]; en: readonly string[] }>`，每个动作给 2–5 个**规范写法**（zh 原形、en 原形），例如 `release → zh ['发布','推出','上线'], en ['release','launch','roll out']`。

守护测试：对表中每个 surface，`factActionOccurrences(surface)` 恰好返回 1 个 occurrence 且 `action` 相同；`FACT_ACTION_PATTERNS` 里每个 action 在表中都有条目。表与正则永远同步。

### 1.2 提示词（`buildManualLeadAssessmentPrompt` / `buildManualLeadAssessmentRegenerationPrompt`）

- system 增加一条：`atomic_fact.predicate 的动作必须且只能取 predicate_vocabulary 中某一个动作的写法（可加紧邻的时态 / 否定 / 情态 / “据报道” 标记）。证据使用同义动词（announce、unveil、introduce、debut、宣布、亮相、公布 等）时，改写为词表中对应动作的写法；“宣布 + 动作”“announced it will + 动作”只保留后面的动作。editorial_projection 的中文句子使用同一动作的中文写法。`
- user JSON 增加字段 `predicate_vocabulary: [{ action, zh, en }]`（全部条目；控制在 4KB 内，仍受 `MANUAL_NEWS_PROVIDER_PROMPT_MAX_CHARS` 64_000 约束，加测试断言 prompt 长度增量 < 5KB）。
- `output_schema.source_facts[].atomic_fact.predicate` 说明改为 `exactly one action from predicate_vocabulary, written in that vocabulary form, plus only its local tense/polarity/modality markers`。

### 1.3 校验器归一化（`factActionOccurrences` 与 `FACT_ACTION_PATTERNS`）

**扩充现有动作的正则（只放宽）**：
- `release`：zh 增 `亮相|公测|首发|正式推出|宣布推出`；en 增 `announc(?:e|es|ed|ing)|unveil(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|roll(?:s|ed|ing)?[ -]out|debut(?:s|ed|ing)?|ship(?:s|ped|ping)?|(?:make|makes|made)\s+available|(?:go|goes|went)\s+live`；`englishFiniteHead` 同步。
- `disclose`：zh 增 `透露|公开`；en 增 `reveal(?:s|ed)?`。
- `finance`：en 增 `rais(?:e|es|ed|ing)\s+(?:\$|US\$|€|£|¥)?\d`；zh 增 `完成[^，,。]{0,8}融资|获得[^，,。]{0,8}(?:投资|融资)`。
- `partner`：zh 增 `联手|携手|达成合作`。
- `open_source`：zh 增 `开放源码`。

**通告动词让位规则**（`factActionOccurrences` 的后过滤，参照 :3806 的 `mandate` 相邻过滤）：当 `release` 的匹配 surface 属于通告类（`宣布|announc\w*|unveil\w*|introduc\w*` 中的 announce/宣布 两类）且同一槽位中其后 ≤ 24 个字符内出现另一个非 `release` 动作，则丢弃该通告匹配。效果：`宣布收购` → 仅 `acquire`；`announced it will acquire` → 仅 `acquire`；`announced Gemini 3.8 Flash` → `release`。加正反测试。

**新增动作（≤ 8 个，每个都要：FactAction 联合类型、pattern、词表条目、正反测试；若某个动作与现有 `structuredFactUnit` / 投影比较逻辑冲突导致既有测试变红，则放弃该动作并在 PR 描述说明）**：
`update`（更新|升级|迭代 / updat(e|es|ed|ing)|upgrad(e|es|ed|ing)）、`integrate`（集成|接入|整合 / integrat(e|es|ed|ing)）、`deploy`（部署 / deploy(s|ed|ing)?）、`appoint`（任命|聘请|出任|加入 / appoint(s|ed)?|hir(e|es|ed)|join(s|ed)?）、`depart`（离职|辞职|离开 / resign(s|ed)?|depart(s|ed)?|step(s|ped)?\s+down|left|leav(e|es|ing)）、`reach`（达到|突破|超过 / reach(es|ed)?|surpass(es|ed)?|exceed(s|ed)?|hit(s)?）、`warn`（警告 / warn(s|ed)?）、`test`（测试|试点|试用 / test(s|ed|ing)?|pilot(s|ed)?）。
`OPPOSING_FACT_ACTIONS` 视需要补 `['appoint','depart']`。

### 1.4 失败码与重生成反馈

- 谓语 0 个动作命中 → 新码 `predicate_action_unrecognized`（加入 `ASSESSMENT_VALIDATION_ERROR_CODES` 与 `REGENERATABLE_ASSESSMENT_VALIDATION_CODES`，路径规则同 `invalid_claim_predicate`）；≥ 2 个 → 维持 `non_atomic_{scope}_predicate`；含原因短语 → 维持 `invalid_claim_predicate`。
- `buildManualLeadAssessmentRegenerationPrompt` 的 `regeneration` 块新增：`failure_slot_text`（出错槽位的原文，≤ 160 code points，去除控制字符 / bidi / 零宽字符）、`matched_actions`（命中的 action id 数组，可空）、`vocabulary_hint`（`predicate_action_unrecognized` 时给「请从 predicate_vocabulary 选一个动作」）。需要把出错槽位文本从校验错误里带出来：`generatedFactValidationError` 增加可选 `slot_text`，`manualLeadAssessmentValidationFailure` 解析后透传。`SAFE_GENERATED_ASSESSMENT_PATH` 不变。
- 各槽位 `mechanical_instruction`（:3124-3139）中 predicate 一条改为引用词表。

### 1.5 验收测试（PR-A 必须包含）

用 8 条贴近真实 AI 新闻的 `source_facts` 夹具跑 `validateManualLeadGeneratedAssessment`（含 editorial_projection）：
1. `Google` / `organization` / `announced` / `Gemini 3.8 Flash` → 通过（release）。
2. `OpenAI` / `organization` / `is rolling out` / `GPT-6 to Plus users` → 通过。
3. `Anthropic` / `organization` / `宣布收购` / `Bun` → 通过（acquire）。
4. `Meta` / `organization` / `open-sourced` / `Llama 5` → 通过。
5. `xAI` / `organization` / `raised` / `$10 billion` → 通过（finance）。
6. `Google` / `organization` / `named` / `X as CEO`（若 appoint 落地）→ 通过。
7. `Apple` / `organization` / `considered` / `buying Perplexity` → `predicate_action_unrecognized`，反馈含 `failure_slot_text: 'considered'`。
8. `Google` / `organization` / `released and open-sourced` / `Gemma 4` → `non_atomic_source_predicate`，`matched_actions: ['release','open_source']`。

---

## 2. PR-A · 方案 2：官方 X 账号白名单

### 2.1 白名单（manual-news-leads-runtime.ts，参照 `TRUSTED_WECHAT_INDEPENDENT_PUBLISHERS`）

`OFFICIAL_X_ACCOUNT_ACTORS: ReadonlyMap<string /* handle 小写 */, { actor: string; label: string }>`，初始：
`googleai→Google`、`googledeepmind→Google DeepMind`、`openai→OpenAI`、`anthropicai→Anthropic`、`aiatmeta→Meta`、`xai→xAI`、`mistralai→Mistral AI`、`alibaba_qwen→Alibaba Qwen`、`deepseek_ai→DeepSeek`、`nvidia→NVIDIA`、`huggingface→Hugging Face`、`microsoft→Microsoft`、`github→GitHub`、`perplexity_ai→Perplexity`、`cohere→Cohere`。
可选 env `MANUAL_NEWS_OFFICIAL_X_HANDLES`（`handle=Actor Name,handle2=Actor 2`）合并覆盖；解析失败整体忽略并 `console.warn`。**handle 只能取自已签名的 `audit.canonical_url`**（`parseTwitterStatusUrl(audit.canonical_url)?.handle`，runtime.ts:275 现有做法），不得用未签名的 `tweet.author_handle`。

### 2.2 证据形状（`extractManualNewsEvidence` 推文分支）

白名单命中：`reliable: true`、`source_type: 'official_primary'`、`publisher: 'X @<handle>'`（不变）。未命中：维持现状（`reliable:false`、`'other'`）。不新增字段（`assertManualNewsEvidenceSet` 严格键）。
API（manual-news-leads-api.ts:59-77）：白名单推文 `source_label` = `'X/Twitter 官方账号推文（ScrapeBadger）'`。

### 2.3 官方第一人称放行的账号化（`officialPrimaryFirstPersonActorBinding`，manual-news-leads.ts:6429）

改为表驱动：保留现有 Anthropic MHS 条目**逐字等价**（`manual-news-source-support.test.ts` 全部照旧通过），新增「官方 X 账号」条目：
- 匹配条件：`selected.reliable === true && selected.source_type === 'official_primary'`，`selected.url` 形如 `https://x.com/<handle>/status/<digits>`（严格解析：https、无凭证、无端口、host 恰为 `x.com` 或 `twitter.com`、无 query/hash），handle 在白名单。
- 第一人称开头（大小写不敏感）：`^(?:today,?\s+)?(?:we(?:['’]re|\s+are)|we(?:['’]ve|\s+have)|we)\s+`；`isFirstPersonSourceSupportQuote` 同步放宽（仅在 quote 位于 excerpt 首个非空白位置时生效，规则不变）。
- 主体替换：`We're rolling out X` → `<Actor> is rolling out X`；`We've released X` → `<Actor> has released X`；`We released X` → `<Actor> released X`。替换后的句子必须恰含 1 个动作（依赖 1.3 的扩充）。
- `binding_contract` 值：`'official_x_account_first_person_actor_v1'`。
- 若 `canonicalSubjectIdentity` / `canonicalEntityRole` 不认识某 Actor 名，补入实体登记（同文件现有登记处），至少覆盖白名单全部 Actor。

验收测试：夹具推文 `https://x.com/GoogleAI/status/2095175881690173885`，excerpt `We're rolling out Gemini 3.8 Flash to all users today.`，owner 输入事实 `Google 推出 Gemini 3.8 Flash`，走 `validateManualNewsSourceSupportSelection` → `createManualNewsSourceSupportPayload` → `createManualNewsSourceSupportProof` 全链路通过；非白名单 handle 的同样推文 → `source_support_evidence_invalid`。

---

## 3. PR-B · 方案 3 云端：owner 担保确认 `owner_vouched_v1`

### 3.1 语义

owner 对一条**已有可核验证据链**但未获得自动评估的线索，用一句话陈述事实并担保，该线索以此陈述为标题与摘要进入候选池。证据链的密码学校验（`assertManualNewsEvidenceBodyDigests`）照旧执行；被替换的只是「大模型事实评估」这一环。

### 3.2 常量与新文件

- `MANUAL_NEWS_OWNER_VOUCH_POLICY = 'owner_vouched_v1'`。
- 新文件 `worker/src/digest/manual-news-owner-vouch.ts`：陈述校验、payload 构建、proof（HMAC）构建与快照校验；尽量不改 `manual-news-leads.ts`（只允许导出既有内部函数）。

### 3.3 陈述（statement）校验

trim 后 6–160 code points；单行（无 `\r\n`）；无控制字符、bidi、零宽字符（复用现有 unicode 过滤）；至少含 4 个汉字或 3 个英文单词。不合规 → 400 `invalid_vouch_statement`。

### 3.4 payload 与 proof

```
payload = {
  policy_version: 'owner_vouched_v1',
  lead_id, review_date,
  statement,                       // 规范化后的陈述
  primary_evidence_id,             // 首个 reliable 证据，否则第一条
  evidence: canonicalEvidence(lead.evidence),   // 复用 source_support 的规范化
  event_identity: { event_key: 'mnvo1:' + sha256Hex('mnvo1\0' + canonical(primary.url)) },
  item_projection: { item_id: 'blog:manual:<lead>', source_id: 'manual:<lead>',
                     title: statement, summary: statement, score: null,
                     url: primary.url, published_at: primary.published_at ?? null },
  vouched_at,                      // ms
}
```
HMAC 域 `manual-news-owner-vouch-hmac-v1\0`，`canonical_digest = sha256Hex(domain + canonicalJson(payload))`，`hmac_sha256 = hmacSha256Hex(secret, domain + canonicalJson({policy_version, verification_key_id, lead_id, assessment_version, canonical_digest}))`，key 来自 `manualNewsVerificationKeyring(env).currentKeyId`。`assessment_version = expected_version * 1_000_000 + 900_000`。行 id `mav:<lead>:<assessment_version>:<digest 前 16 位>`，写入 `manual_news_assessment_verifications`（`status='active'`，`verification_json` = payload）。
快照校验函数 `verifyOwnerVouchCandidateProofSnapshot`：重建 payload 与 canonicalJson 逐字相等 + HMAC 常量时间比较 + 证据 body digest 校验，任一失败按现有 tamper 处理路径隔离。

### 3.5 分发点（必须逐个落地，逐个写测试）

1. `manual-news-leads-verification.ts:537-590` `loadVerifiedManualCandidateProof`：新增 `owner_vouched_v1` 分支，返回与 source_support 同形的 `{ assessment: {title, summary, score, event_key, url, published_at}, record }`。
2. `manual-news-leads-store.ts:2444` `confirmManualNewsLeadCandidate`：`verified` 改由 `loadVerifiedManualCandidateProof` 提供（LLM 与 source_support 行为不变——后者已 confirmed 会先撞 `lead_already_confirmed`）。
3. 新 store 函数 `vouchManualNewsLeadCandidate(env, id, expectedVersion, expectedBatchRevision, statement, idempotencyKey, now)`：
   - 前置：线索存在；`status === 'needs_review'`（`failed` 且 `evidence.length ≥ 1` 也允许）；`!confirmed_at`；未过期；版本匹配；`evidence.length ≥ 1`；证据 body digest 通过；幂等键复用返回同结果。
   - 步骤 1：在一个 `DB.batch` 内插入 proof 行（`INSERT OR IGNORE` 以 `verification_id` 幂等）+ 审计 `vouch_candidate`（`metadata_json` 含 `statement`、`canonical_digest`、`candidate_authorization: 'owner_vouched_v1'`）+ 线索 `status='needs_review'` 不变但 `version+1`、`last_mutation_kind='vouch'`。
   - 步骤 2：调用 `confirmManualNewsLeadCandidate(env, id, version+1, expectedBatchRevision, idempotencyKey + ':confirm', now)` 复用既有确认流程（含 `pending_initial_freeze` / 新批次 / 事件冲突）。
   - 步骤 2 失败（409）时 proof 行保留（owner 可用新 batch revision 重试确认，不必重写陈述）；API 返回该 409。
4. `orderedVerifiedManualCandidates`（store.ts:157-203）：`authorization_order` 给 `owner_vouched_v1` 一个明确序（LLM 验证 < source_support < owner_vouched，同类按 confirmed_at）。
5. `news-review.ts` `verifiedManualCandidateSnapshot` / `durableConfirmedManualCandidates` / `sanitizeCurrentNewsReviewBatchAttempt`：确认担保候选能进批次、sanitize 不 drift（confirm 时与重建时字段逐字一致，复用 store.ts:2512 注释的约束）。
6. `news-source-policy.ts` 正式新闻门（`collectFormalNewsPreflight` / `sameManualProof` / 最终守卫）：`owner_vouched_v1` 通过，不得 `DENY_UNVERIFIED_MANUAL`。
7. 去重历史（store.ts:2155-2229）：担保线索不参与跨天事件去重——在 PR 描述与 `docs/operations.md` 补录节写明为已知限制。
8. 迁移：检查 `manual_news_lead_audit.action`、`manual_news_leads.last_mutation_kind`、`manual_news_assessment_verifications.policy_version` 是否有 CHECK 约束；有则新增 `worker/migrations/0NN_manual_news_owner_vouch.sql`（先 staging 后 prod，见 CLAUDE.md 发布 checklist）。

### 3.6 API（manual-news-leads-api.ts）

- 路由正则 `:264` 增 `vouch-candidate`；`POST /{id}/vouch-candidate`，body `{expected_version, expected_batch_revision, statement}`，`Idempotency-Key` 必需；无 dependency 检查（与 confirm 一致）。
- 响应：成功 200 `manualNewsMutationResult`（`rerender_enqueued: false`，`batch`、`pending_initial_freeze`、`lead`）；失败沿用 confirm 的错误码 + `invalid_vouch_statement` / `lead_not_vouchable`（状态不允许或无证据）。
- 摘要与详情增加 `candidate_authorization`（`'llm_verified' | 'source_support_v1' | 'owner_vouched_v1' | null`）与 `vouch: { statement, vouched_at } | null`；详情已有的 `assessment_generation` 保持。
- `docs/operations.md`（本地文件，不入 git）补录节追加端点说明——由主会话执行，执行 agent 不改该文件。

---

## 4. 面板 · 方案 3 页面（dailyVideo worktree）

### 4.1 代理（`workflows/aifeeds-daily/manual-news-leads-proxy.mjs`）

- `:130/:136` 路径正则增 `vouch-candidate`。
- body 重建：`vouch-candidate` → `{ expected_version, expected_batch_revision, statement }`，`statement` 校验同 3.3（不合规 400 `invalid_vouch_statement`）。
- 更新 `manual-news-leads-proxy.test.mjs`（现有精确断言）并新增 vouch 用例。

### 4.2 页面（`run.mjs` `writeShareIndex` 内联脚本）

- `renderManualLeadCards`：
  - 需复核原因行：`needs_review` 且无 `assessment.event_key` 时显示 `manualLeadReviewReason(lead)`：`assessment_validation_failed` → 「自动事实核验没有通过格式校验（不代表事实有误），可由你担保加入」；`evidence_insufficient` → 「证据不足，无法自动核验」；`source_support_not_supported` → 「官方来源未支持这条表述」；其他 → 原码。`failed` 线索的现有 `manualLeadEvidenceFailureMessage` 不变。
  - 新按钮「担保加入候选池」（`data-action="vouch-candidate"`），显示条件：`['needs_review','failed'].includes(status) && !assessment.event_key && evidence_count ≥ 1（或 evidence.length ≥ 1）&& !confirmed_at && !confirmed_batch_id`。点击展开内联表单：`<textarea maxlength="160">` 预填 `lead.input_text`（截 160），提示「用一句话写清事实（中文为主，将作为候选标题与口播依据）」，按钮「确认担保」「取消」。
  - 证据列表：每条同时显示 `source_label`（来自 API 的 `evidence_kind`/`source_label`；官方账号推文显示「官方账号推文」）与 `title`（`publisher · title`），不再二选一。
  - 已担保线索（`candidate_authorization === 'owner_vouched_v1'`）卡片标注「owner 担保」并显示陈述。
- `mutateManualNewsLead`：支持 `vouch-candidate`，body 带 `statement`；`keyName` 把 `statement` 的 sha 前 8 位纳入幂等键；成功处理与 confirm 相同（`rerender_enqueued===false` 断言、`batch.review_url` 链接、`pending_initial_freeze` 文案改为「已担保加入冻结前候选池；07:50 生成首批候选时会自动合入」/「已担保并生成新的候选批次…」）。
- 测试：`share-index.test.mjs` 现有 `renderManualLeadCards` 用例的桩对象补新协作函数；新增用例覆盖按钮显隐、原因文案、证据标签、担保表单提交体；`manual-news-leads-controller.test.mjs` 视需要补。

### 4.3 部署（主会话执行）

1. 云端 PR-A、PR-B 合并且 prod 生效后再部署面板（页面依赖新 API 字段与端点，旧端点对新字段容错）。
2. 代理：面板补丁脚本 v18（沿用 v14–v17 形态：idle guard → 备份 → dry-run → patch → node --check → restart → 日志）。
3. 页面：render release 打包部署（沿用 v13 脚本形态），随后以渲染用户身份对**当天**执行 `run.mjs --refresh-share-index --skip-render --skip-media`（参数取自当日 share 目录与 runtime manifest；执行 agent 在交付物里写出完整命令与取值来源），刷新 latest 页面；刷新前后 `curl` 对比页面含 `担保加入候选池` 字样；清香港 nginx 缓存与提示用户硬刷新（PWA SW）。

---

## 5. 验收（主会话）

1. staging：`wrangler deploy --env staging` 后，用 `Bearer DAILY_NEWS_REVIEW_SECRET`（staging 值）提交 X 链接线索与文字线索，观察 `manual_news_assessment_generation_revisions_v2` 校验码分布变化；对 `needs_review` 线索调用 `vouch-candidate` 进入候选池并出现在 `daily-news-review` 候选里。
2. prod：合并后重新提交 9/3 的 X 线索（`https://x.com/officiallogank/status/2095175881690173885`，非白名单 → 走大模型评估）与文字线索；对仍 `needs_review` 的线索在 latest 页面担保加入；候选批次里可见。
3. 记录：`docs/operations.md` 补录节、TODO.md、memory（评估 0/52 根因与三条修复）。
