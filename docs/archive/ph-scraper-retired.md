# [归档] Product Hunt 本地 scraper（已退役 2026-05-13）

> **状态**：2026-05-13 归档。
> **原因**：本地 browser-use + Chrome profile 抓取已被 CF Worker + PH GraphQL API 全面替代（主 PR 2026-05-11 上线 prod，连续 2 天稳定，提前清理本地 fallback 不再保留）。
> **当前 PH 数据源**：`worker/src/scrapers/ph.ts`（fetch）+ `worker/src/ph-r2.ts`（R2 资源迁移）+ `worker/src/enrich.ts`（DeepSeek judge/translate）+ dispatcher UTC 10:10 daily cron。
>
> **何时回头看这份归档**：
> - CF Worker PH cron 出严重不可恢复问题，需临时回滚到本地 browser-use 抓取救火
> - 接入新 PH 同类站点（需要 turnstile 绕过 / 评论 DOM 提取）时参考 dom_extract.py / parser.py 实现
> - 任何项目里要写 browser-use + Chrome profile 自动化抓取时，先看这里 + [`automation-chrome-rules.md`](automation-chrome-rules.md) 规避反复踩的坑
>
> **配套要恢复时的入口**：
> - 最后活跃 commit：`1210ae8 feat(card+poster+scraper): PH 4 列 KPI + 海报 4 列 + parser 修 multi-launch votes 抓错`（恢复用 `git checkout 1210ae8 -- scrapers/ph/ launchd/com.aifeeds.ph-scraper.plist`）
> - 第一次上线 commit：`9c09a2b feat(scrapers/ph): #8 — launchd cron.sh + plist (PT 0:30 daily)`
> - 完整接入设计文档（保留在仓库）：[`docs/plans/2026-05-03-product-hunt-source-design.md`](../plans/2026-05-03-product-hunt-source-design.md)（12 个 milestone 全程记录）

---

## 旧实现摘要

**触发方式**：本地 macOS launchd plist（`launchd/com.aifeeds.ph-scraper.plist`），BJT 16:30 每天起跑，调 `scrapers/ph/cron.sh` 包装脚本。

**核心流程**（`scrapers/ph/scraper.py`）：

1. **leaderboard fetch**：拉 PT yesterday 的 `/leaderboard/daily/Y/M/D` 页面（PH bot UA 返 LLM-friendly markdown，双格式兼容 HTML 和 markdown 解析），抠出 ~21 个产品 slug
2. **单 PHSession 串行抓**：一个常驻 browser-use Chrome profile（避免重复登录），5 秒/产品 节流
3. **每个产品页**（`dom_extract.py` + `parser.py`）：
   - 导航到 `/products/<slug>` 详情页
   - 等 turnstile 通过（rank 14+ 偶尔失败，需要补抓脚本兜底）
   - 解析 JSON-LD（产品基础信息）+ DOM 提取（comments / reviews / makers / media）
   - 只抓 top-level threads（不展开嵌套回复），按单 handle 划 review root
4. **DeepSeek LLM**（`llm_judge.py` + `translate.py`）：
   - is_ai 二分类（AI 相关性判别）
   - 拿到 ai_category + ai_summary
   - is_ai=1 才走翻译（tagline / description / comments）
5. **push 到 D1**（`sync.py`）：POST `/api/ingest`，鉴权用 `XLIST_INGEST_TOKEN`

**节流 + 防孤儿**：cron.sh 用 PRE/POST PID diff 兜底 kill-by-data-dir（详见 [`automation-chrome-rules.md`](automation-chrome-rules.md)），跟 X scraper 同一套防 Chrome 孤儿 pattern。

## 为什么退役

| 维度 | 旧本地实现 | 新 CF Worker 实现 |
|---|---|---|
| **依赖** | macOS 必须开机 + Chrome profile 必须登录 + launchd 跑 | 全云端，跟 mac 状态无关 |
| **turnstile** | rank 14+ 经常被拦，要补抓脚本兜底 | PH GraphQL API（OAuth client_credentials）完全绕过 |
| **数据完整性** | DOM 抠出来的字段不稳（PH 改版会断） | GraphQL schema 稳定 |
| **可观测性** | 看 `data/logs/ph-cron-YYYYMMDD.log` 本地文件 | CF Workers Logs / Analytics（阶段 1 启用后） |
| **rate limit** | PH 站点 5s/产品 节流 | PH API 5000 req/15min（client_credentials） |
| **comments 作者** | DOM 能拿到完整作者名 | client_credentials mask 非 hunter 用户为 "PH 用户"（**唯一倒退**，TODO §0.2 切 OAuth user-token 修复） |

唯一的功能倒退是 comments 作者 mask，这是 PH API 鉴权方式的限制（client_credentials），后续切到 user-token 流程会恢复。

## 兜底 fallback（如果 CF Worker PH 翻车）

**短期救火**（不恢复全套本地实现）：
- 直接调 `POST /api/admin/ph-fetch-now?force=1&pt_date=YYYY-MM-DD` 让 worker 立即重跑特定日期
- 或调 `POST /api/admin/ph-r2-migrate-now?limit=2` 重跑 R2 资源迁移
- 看 `worker/src/scrapers/ph.ts` runPhDailyFetch 入口排查

**长期回滚**（恢复完整本地实现）：

```bash
# 1. 恢复代码
git checkout 1210ae8 -- scrapers/ph/ launchd/com.aifeeds.ph-scraper.plist

# 2. install launchd（项目根目录 symlink）
ln -sf $(pwd)/launchd/com.aifeeds.ph-scraper.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.aifeeds.ph-scraper.plist

# 3. 临时关停 worker PH cron（worker/src/index.ts dispatcher 改 false 重 deploy）

# 4. 验证手动跑
~/.browser-use-env/bin/python3 -m scrapers.ph.scraper --leaderboard YYYY-MM-DD --push --log-level INFO
```
