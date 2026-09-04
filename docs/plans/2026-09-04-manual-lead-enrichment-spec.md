# 手工补录线索的正文补充（enrichment）· 设计规格（2026-09-04）

> **owner 要求**：「补录数据，有链接时候需要抓取正文；没有链接的时候需要走搜索服务」。
>
> **背景**：9/4 上线的 `owner_asserted_v1` 直接录入让线索绕过取证直接入池，代价是口播词只有 owner 写的那一句话——`daily-media.mjs` 组装口播输入时，`title` 与 `evidence_text` 取的都是同一句陈述，模型没有别的素材。

## 1. 不可动的边界（先写在最前面）

- **入池不得再被取证阻塞**。这是 9/4 修复的核心，补充正文只能是入池之后的异步增强，失败不影响候选存在。
- **不得改动被正式新闻门绑定的字段**：`items` 的 `title` / `content` / `content_translated` / `author` / `url` / `published_at`，以及 `extra.event_fingerprint`，它们与签名投影逐字绑定（`news-source-policy.ts` 的最终守卫）。补充正文只能落在**未被绑定**的 `extra` 键上。
- **不得覆盖 `extra.ai_summary_zh`**。它是卡片与静态页显示的那句话，也是 owner 自己写的陈述；补充素材是口播的**补充证据**，不是替换品。owner 的陈述始终是这条新闻的主张。
- 不得改 `candidates_json` 快照（由签名投影重建，改了会让 sanitize 每次判 drift 空转 bump revision）。

## 2. 数据流

```
owner 直接录入 → 立即入池（现状，不变）
        ↓ 异步
  有链接 → 取证网关抓正文（X 链接走 /v1/tweet，其余走 /v1/document）
  无链接 → 取证网关 /v1/search 搜索 → 取排序最高的可抓结果抓正文
        ↓ 成功
  DeepSeek 压成 2–4 句中文背景（flash 即可）
        ↓
  写入 items.extra.manual_evidence_text（新键，未被门禁绑定）
        ↓
  render.ts 把它映射进 digest payload 的新字段 evidence_note
        ↓
  daily-media.mjs 的 evidence_text 追加该字段 → 口播模型拿到「owner 的主张 + 背景素材」
```

失败时什么都不写，候选保持只有陈述的状态，与今天行为一致。

## 3. 实现要点

### 3.1 触发

- 直接录入（`owner_asserted_v1`）与零证据担保成功后触发；已有签名证据的线索（`llm_verified` / `source_support_v1` / 有证据的 `owner_vouched_v1`）**不触发**——它们的 `ai_summary_zh` 本来就是核验过的正文摘要。
- 用 `ctx.waitUntil` 或既有的 manual-news Workflow 派发，**不得让确认请求等待它**。选型理由写进代码注释。
- 幂等：同一线索只补一次；重复触发要能识别已有 `manual_evidence_text` 并跳过。

### 3.2 取材

- 链接是 x.com/twitter.com 的 status 链接 → `adapters.fetchTweet`（`/v1/tweet`，今天可用）。
- 其它链接 → 既有安全取证 `/v1/document`。**注意：大陆网关取境外页面当前必 502**，这是已知拓扑约束（见 TODO 的「研究网关迁香港」），失败按正常失败处理，不重试到爆。
- 无链接 → `/v1/search`（提供方密钥当前缺失，多半直接失败）。取第一个可抓结果再走上面的抓取。
- 单条线索的总预算 60s，超时即放弃。

### 3.3 落库

- `extra.manual_evidence_text`：2–4 句中文，最长 400 code points。
- `extra.manual_evidence_source`：`{url, publisher, fetched_at, kind: 'tweet' | 'document' | 'search+document'}`，供排查与将来在卡片上标注来源。
- 写入用 `UPDATE items SET extra = json_set(...)`，**只改这两个键**，其余 `extra` 内容与所有被门禁绑定的列一字不动。写后跑一次既有正式新闻门断言，证明候选仍 `ALLOW_VERIFIED_MANUAL`。

### 3.4 消费

- `render.ts`：news 分支在返回对象里加 `evidence_note`（取 `ex.manual_evidence_text`，无则省略字段）。**不要动 `summary` / `summary_full` 的取值表达式**，静态页显示保持不变。
- `codex-push.ts`：payload 透传 `evidence_note`。
- 面板 `daily-media.mjs`：`evidence_text` 的字段列表追加 `item.evidence_note`（放在 `item.summary` 之后）。
- 口播提示词无需改动：模型本来就按「标题 + 证据文本」写。

## 4. 测试

- 直接录入后触发补充、成功写入两个 extra 键、正式新闻门仍放行、`candidates_json` 无 drift（连续两次 sanitize `changed:false`）。
- 抓取失败 / 搜索失败 / 超时三种路径下，候选完好且 extra 不被写脏。
- 已有签名证据的线索不触发。
- 幂等：重复触发不重复写。
- `render.ts` 在有/无 `manual_evidence_text` 两种情况下的输出快照。
- 面板：`evidence_text` 组装包含 `evidence_note` 的用例（真实文件切片方式）。

## 5. 覆盖率现实（必须写进交付说明）

今天能成功的：X 链接、大陆可达的页面（含微信公众号）。今天多半失败的：境外新闻站链接（网关在大陆，`/v1/document` 502）、无链接走搜索（提供方密钥缺失 + ScrapeBadger 不稳）。
真正的解法是把研究网关迁到香港 VPS（TODO 已列），迁完这条路才对境外源全面可用。本规格不做迁移。
