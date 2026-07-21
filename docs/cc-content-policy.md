# AI源信 `.cc` 内容发布与下架政策

最后更新：2026-07-21

适用站点：`https://ai-feeds.cc`

投诉与权利通知：`support@ai-feeds.cc`

## 1. 发布边界

`.cc` 只发布 `ai-feeds.com` 已完成处理的 AI 相关静态内容变体，不重新抓取或复制源站全文。新闻与播客页面展示中文摘要、结构化分析、有限短摘录、来源署名和原文链接；用户主动点击 CTA 才进入 `.com`，页面不自动跳转。

一条内容只有同时满足以下条件才会公开：

- `is_relevant=1`，且未删除、未被判定为重复内容；
- 来源具有显式 `allow` 政策；`manual` 来源还必须有人工允许决定；
- 当前审核策略版本的结果为 `pass`；
- 不存在人工 deny 覆盖；
- 生成页面、同步哈希和发布状态全部成功。

审核失败、超时、结果缺字段或状态为 `pending`、`review`、`deny` 时一律不发布。

## 2. 来源政策

| 类别 | 初始政策 | 处理方式 |
|---|---|---|
| 海外 AI 厂商官方博客 | `allow` | 仍逐条审核 |
| TechCrunch AI、The Verge AI、MIT Technology Review AI | `allow` | 仍逐条审核，不因来源可信而跳过内容判断 |
| 海外技术播客 | `allow` | 仍逐条审核 |
| Last Week in AI、Lex Fridman 等广泛议题来源 | `manual` | 自动审核后仍需人工允许 |
| 国内博客、媒体、播客与国内热度来源 | `deny` | 不进入 `.cc` 发布链路 |
| GitHub、Product Hunt、Hugging Face Paper、X | `allow` 候选 | 逐条审核并按阶段回填 |
| 未知来源或 registry 缺项 | `deny` | fail closed，不按域名或地区猜测放行 |

来源政策只认版本库中的显式声明；RSS 传输域、企业国别、内容语言和编辑来源不能相互替代。

## 3. 内容风险判断

当前审核策略版本为 **v2**。系统审核的文本与页面实际可见文本采用同一渲染口径，长内容只取稳定的头部、中段和尾部样本，最多 11,000 字符。

| Flag | 含义 | 自动结果 |
|---|---|---|
| `china_negative` | 对中国、中国主体或中国相关技术作明显负面定性 | `deny` |
| `politics_governance` | 政府、政党、官员、国家间政治或政策阵营等政治治理内容 | `deny` |
| `military_conflict` | 军事、武器、国防或武装冲突 | `deny` |
| `sanctions_export_control` | 制裁、禁运或出口管制 | 单独命中时 `review` |
| `other_cn_distribution_risk` | 其他不适合在中国大陆公开静态分发的风险 | `deny` |
| `uncertain` | 证据或模型结果不确定 | `review` |

v2 在模型前增加了保守的确定性词法 backstop：明确涉及政府官员、政治治理、军事冲突或对华负面定性的内容直接拦截；仅明确涉及制裁/出口管制的内容进入人工复核。词法未命中不代表自动通过，后续仍必须经过结构化模型审核。

模型判断是站点的内容分发风控结果，不是法律结论。人工 override 只允许管理员执行，必须记录操作、原因、时间和决定令牌；人工 allow 不能绕过非 AI、删除、重复或来源 deny 等共同硬门。

## 4. 策略升级与重审

风险定义、提示词或确定性规则发生实质变化时：

1. 提升 `CC_REVIEW_POLICY_VERSION`；
2. 用固定泄漏样本和中性样本先跑回归；
3. 对已发布内容执行 `force_review` 分批重审；
4. 新判为 deny/review/pending 的页面立即产生 delete 事件；
5. 触发 VPS 同步，确认页面返回 404、归档和 sitemap 均移除；
6. 抽查通过后才继续下一批回填或开启自然增量。

旧版本结果不得在新策略下继续作为 `pass` 复用。

## 5. 投诉、下架与证据

收到投诉或发现误放时：

1. 根据 `.cc` URL 查明 `item_id`、来源、原文 URL、审核结果和当前 override；
2. 管理员提交 deny，并填写可审计原因；
3. 确认 Worker 已写入 delete 事件；
4. 触发或等待 `aifeeds-cc-sync.service`；
5. 确认公开 URL 返回 404/410，且归档与所有 sitemap 均不再包含该 URL；
6. 保存投诉、决定、事件序号、删除时间和验证结果，再回复投诉人。

自动同步目标为 15 分钟内从页面与 sitemap 移除。投诉响应目标为工作时间 2 小时内、其他时间 24 小时内；若任一自动步骤失败，先停止继续放量并人工执行同步和核验。

## 6. 紧急停止

- 停止新生成：把生产 `CC_MIRROR_ENABLED` 设为 `0` 并重新部署 Worker。
- 停止国内同步但保留现有页面：禁用 `aifeeds-cc-sync.timer`。
- 全量下线内容镜像：停止 timer，撤下 `/i/` 与同步器 `public/current`；保留首页、备案页、验证文件和 `/auth/wechat/` 服务。

完整命令、事务恢复和搜索平台提交步骤分别见 `docs/operations.md`、`cc-site/sync/README.md` 和 `docs/cc-search-engine-submission-runbook.md`。
