# AI 日报每日静态页 + SEO P0 整包 — 设计文档

- 日期：2026-07-06
- 状态：设计已获用户批准，待实施
- 关联：TODO.md §12（国内 SEO / GEO 镜像站）P0 项、`docs/memo/2026-05-07-seo-geo-discussion-memo.md`、`docs/plans/_research/2026-05-07-search-engines-ai-bots-research.html`
- 执行约定：本设计由 Fable 5 规划与管理，全部编码/测试/修复由 Opus 4.8 subagent 执行

## 1. 背景与目标

CF 实测 24 小时内 AI bot 抓取 200+ 次（AI Assistant 124 / AI Search 59 / AI Crawler 23），搜索引擎仅 5 次；但主站是 SPA 无 SSR，爬虫抓到的全是空壳，引用质量为零（memo 结论：SSR/prerender + robots + sitemap + JSON-LD 是阻塞一切 SEO 动作的 P0 瓶颈）。

本项目参照 tldr.tech 的模式（`tldr.tech/ai/YYYY-MM-DD`），在每天 8 点 daily 邮件推送的同时生成一个 SEO 友好的纯静态 HTML 日报页，并一次性补齐 robots.txt / sitemap.xml / llms.txt / index.html head 等 P0 配套。

**目标**：
1. 搜索引擎与 AI bot 能抓到有实质内容的中文页面，形成可持续增长的 SEO 落地页矩阵
2. 页面内每条内容链接到主站抽屉深链，承接回流
3. 零日常运维：生成挂在现有 workflow 上，失败不影响邮件

**非目标（out of scope，后续轮次）**：
- 抽屉深链页（/t/、/g/ 等）的 SSR / bot 定向 prerender
- `.cc` 国内镜像站（独立轨道，见 2026-05-08 设计稿）
- Google Search Console / Bing 站长验证与 sitemap 提交（用户手动，交付 step-by-step 指引）

## 2. 已拍板决策（2026-07-06 用户确认）

| # | 决策点 | 结论 |
|---|--------|------|
| 1 | URL 方案 | 主域路径 `ai-feeds.com/daily/YYYY-MM-DD`（需改 HK nginx 路由 + sw.js 排除） |
| 2 | 内容范围 | 与 8 点邮件一致：五源 normal 档（news/ph/gh/hf-paper/x，约 23 条/天） |
| 3 | 打包范围 | P0 整包：daily 页 + robots.txt + sitemap.xml + llms.txt + index.html head 修复 + IndexNow 自动 ping |
| 4 | 历史回填 | 回填 digest_pool 中全部可重建的历史日期 |
| 5 | AI 爬虫策略 | /daily/* 对搜索引擎 + AI 检索 + AI 训练爬虫全部放行（GEO 收益最大化） |

容量评估结论（2026-07 官方文档查证）：每天 1 页 50-200KB，10 年 3650 页约 730MB。R2 对象数无上限、免费档 10GB；worker 请求配额零头；D1 只存索引行。**四种承载方案在付费档全部终身安全，无需任何上限处理**。选型 Worker + R2（CF Pages 已进维护模式，排除）。

## 3. 架构总览

```
[8 点 DigestNodeRunWorkflow]
  Phase 1  选品 → digest_pool（现有）
  Phase 1.5 LLM 邮件主题 → digest_pool _subject 行（现有）
  Phase 2  订阅邮件分发（现有）
  Phase 3  Codex 日报推送（现有，非阻塞）
  Phase 4  ★新增：生成日报静态页（非阻塞，学 Phase 3 的容错写法）
            ├─ 读 digest_pool 五源 normal 档 → renderItem()（复用 render.ts）
            ├─ daily-page.ts 渲染纯 HTML（内联 CSS，零 JS）
            ├─ PUT R2 daily/YYYY-MM-DD.html
            ├─ UPSERT D1 daily_pages 索引行
            └─ ping IndexNow（失败仅记日志）

[伺服] 用户/爬虫 → ai-feeds.com（灰云 → HK nginx）
  /daily/* /robots.txt /sitemap.xml /llms.txt /<indexnow-key>.txt
    → nginx location 转发 worker upstream（★新增 location 块）
  其余路径 → CF Pages SPA（现状不变）
```

## 4. 组件详设

### 4.1 生成器 `worker/src/digest/daily-page.ts`（新文件）

- 输入：`env` + `date`（BJT 日期字符串）。数据源与 `codex-push.ts` 的 `buildDailyCodexPayload()` 同构：读 `digest_pool` 当日 normal 档快照 → `render.ts` 的 `renderItem()` 得到 `RenderedItem[]`（title/summary/summary_full/url/deep_link/author/cover 均现成）
- 源范围与展示顺序：`news → ph → gh → hf-paper → x`（沿用 `DIGEST_SOURCE_ORDER` 剔除 clawhub），源标签沿用 `source_labels`（行业新闻/热门产品/开源项目/论文/X 精选）
- 页面标题副题与 meta description 复用 `digest_pool` 的 `_subject` meta 行（当日 LLM 汇总主题）；缺失时回落 `buildDigestSubjectFallback` 同款文案
- 输出：完整 HTML 字符串（规格见 §5）
- 幂等：同日重跑覆盖同一 R2 key；`daily_pages` 行 UPSERT
- 空数据保护：当日 digest_pool 无 normal 档数据时跳过生成并记日志，不写空页
- 相邻日互链：生成日期 D 的页面后，若 `daily_pages` 存在 D 的前一个已生成日期，则**重渲染该前日页面**（内容快照不变，仅令其「后一日」导航指向 D），保证历史页链式互链完整；backfill 按日期升序执行天然满足

### 4.2 存储

- R2：`daily/YYYY-MM-DD.html`（复用 worker 现有 R2 binding，与 `/r/<key>` 反代同 bucket，前缀隔离）
- D1 新表（migration 文件放 `worker/migrations/`，先 staging 后 prod）：

```sql
CREATE TABLE daily_pages (
  date TEXT PRIMARY KEY,          -- YYYY-MM-DD（BJT）
  title TEXT NOT NULL,            -- 页面 title（含当日主题）
  item_count INTEGER NOT NULL,
  generated_at TEXT NOT NULL      -- ISO8601
);
```

sitemap 与 `/daily/` 归档索引均从此表读取，不做 R2 list。

### 4.3 workflow 挂载（`worker/src/digest/node-run.ts`）

- 在 Phase 3（Codex 推送）之后新增 Phase 4，仅 `slotHourBjt === 8` 执行
- 与 Phase 3 相同的容错模式：独立 workflow step + try/catch，任何异常只记日志，不影响邮件分发结果
- 开关：新增 env `DAILY_PAGE_ENABLED`（'1' 开启；staging 默认关，与 `DAILY_PUSH_ENABLED` 管理方式一致，加入 `.secrets/` 两个 env 文件）

### 4.4 手动触发与历史回填

- 扩展现有 `POST /api/enrich/run`（admin 鉴权）新增 `mode=daily-page`：
  - `&date=YYYY-MM-DD`：重建指定日期
  - `&backfill=1`：遍历 `digest_pool` 中全部有 normal 档快照的历史日期，逐日生成（循环内串行，避免 R2/D1 写放大）
  - `&dry=1`：只返回将生成的日期清单与首页 HTML 摘要，不落盘
- 上线后执行一次 backfill，预期产出几十个页面

### 4.5 worker 公开路由（`worker/src/index.ts`）

| 路由 | 行为 | 缓存头 |
|---|---|---|
| `GET /daily/:date` | 校验 `YYYY-MM-DD` 格式 → 读 R2 → `text/html; charset=utf-8` | `public, max-age=3600` |
| `GET /daily` `/daily/` | 从 `daily_pages` 表实时渲染归档索引（按月分组，倒序） | `public, max-age=3600` |
| `GET /robots.txt` | 模板生成（§4.6） | `public, max-age=86400` |
| `GET /sitemap.xml` | 从 `daily_pages` 生成（§4.7) | `public, max-age=3600` |
| `GET /llms.txt` | 模板生成（§4.8） | `public, max-age=86400` |
| `GET /<indexnow-key>.txt` | 返回 IndexNow key 纯文本 | `public, max-age=86400` |

- 404：日期格式合法但 R2 无对象 → 简洁 HTML 404 页（含返回 `/daily/` 链接）；格式非法 → 302 到 `/daily/`
- **bot gate 豁免**：上述全部路径加入现有 bot UA gate 豁免清单（参照 `/s/<token>` 豁免的实现位置），确保所有爬虫可达；放行策略统一收口 robots.txt
- 绝对 URL 一律用 `SITE_BASE` / `API_BASE` env 拼接，禁止取 request host（HK 中转会改写 Host，2026-06-08 事故教训）

### 4.6 robots.txt 规格

按 2026-05-07 调研的「训练 / 检索 / 用户代抓」三类法 + 决策 5（全放）：

```
User-agent: *
Allow: /
Disallow: /api/
Disallow: /admin
Disallow: /settings
Disallow: /me/
Disallow: /unsubscribe

Sitemap: https://ai-feeds.com/sitemap.xml
```

说明：决策 5 选择全放（含 GPTBot/CCBot 等训练爬虫），因此不再按 bot 分组 disallow；仅屏蔽无收录价值/带鉴权的路径。worker 侧 bot gate 维持现状（只豁免 §4.5 路径），API 防刷不受影响。

### 4.7 sitemap.xml 规格

- 条目：`https://ai-feeds.com/`、`https://ai-feeds.com/daily/`、全部 `daily_pages` 行（`<lastmod>` 用 `generated_at` 日期部分）
- 单文件即可（5 万 URL 上限，够用 130+ 年）；未来若加深链条目再拆 sitemap-index
- 首页 `<changefreq>daily</changefreq>`，日报页 `monthly`（生成后冻结）

### 4.8 llms.txt 规格

Markdown 纯文本：站点一句话定位（中英双语一行各一）、核心入口清单（`/daily/` 归档 + 最近 7 天日报页链接 + 订阅页）、内容说明（五源、中文摘要、每日 8 点更新）。最近 7 天列表从 `daily_pages` 动态取。

### 4.9 IndexNow

- 生成随机 key 存 worker secret（`INDEXNOW_KEY`，加入 `.secrets/` 两个文件），key 文件路由见 §4.5
- Phase 4 成功后 POST `https://api.indexnow.org/indexnow`（host=ai-feeds.com，urlList=[当日页, /daily/, /sitemap.xml]）；HTTP 非 2xx 仅记日志
- backfill 模式批量提交（一次 POST 最多 1 万 URL，一批足够）

### 4.10 nginx 变更（HK VPS，`ai-feeds.com` server block）

```nginx
# aifeeds daily 静态页 + SEO 文件 → worker（其余路径仍走 Pages）
location ~ ^/(daily(/.*)?|robots\.txt|sitemap\.xml|llms\.txt|<indexnow-key>\.txt)$ {
    proxy_pass https://<worker upstream，与 api.ai-feeds.com 同源>;
    proxy_set_header Host api.ai-feeds.com;
    # 不启用 proxy_cache（流量低，避免 6-21 新旧 HTML 混喂类缓存事故）
}
```

- 实施时以 VPS 上实际 nginx 配置为准（worker upstream 写法对齐现有 api 段），改完 `nginx -t` + reload
- 同步更新 `docs/operations.md` §6b（新增路由表行 + 回滚说明：删 location 块即回滚）

### 4.11 dashboard 改动（3 处小改，与 worker 同 PR 或同批部署）

1. `dashboard/public/sw.js`：`shellFirst` 导航拦截排除 `pathname.startsWith('/daily')`（直接 fetch 透传）；`VERSION` bump 触发老客户端更新
2. 首页 footer 加「AI 日报」入口：普通 `<a href="/daily/">`（整页导航，非 SPA route），样式对齐 `docs/frontend-ux-guidelines.md` footer 链接规范
3. `dashboard/index.html` head 修复：`lang="en"` → `lang="zh-CN"`；补 `og:title` / `og:description` / `og:type=website` / `og:url` / `og:image`（站点默认分享图，若无现成资产则用 favicon 衍生的 1200×630 静态图，放 `public/`）；title 改「AI Feeds — 一站式 AI 信息聚合看板」

## 5. 日报页 HTML 规格

- `<html lang="zh-CN">`；title：`AI 日报 YYYY-MM-DD · {当日主题} | AI Feeds`
- head：meta description（当日主题）、canonical、og:title/description/type=article/url/image（当日首条 cover，兜底站点默认图）、viewport
- JSON-LD：`CollectionPage` + `ItemList`（每条 item：name=标题、url=深链绝对 URL）
- body 结构：
  - header：站名（链回 `https://ai-feeds.com/`）+ 日期 + 前一日/后一日导航：前一日取 `daily_pages` 中相邻的已生成日期（缺则隐藏）；后一日在生成时刻尚不存在，先渲染为指向 `/daily/` 归档页，待次日 Phase 4 重渲染本页时替换为真实链接（见 §4.1 相邻日互链）
  - 每源一个 `<section>`：`<h2>` 源标签；每条 item 为 `<article>`：`<h3><a href="深链绝对URL">中文标题</a></h3>` + 中文摘要（summary_full 优先，clamp 同邮件逻辑）+ 来源/作者行 + 原文外链（`target="_blank" rel="noopener"`）+ 封面缩略图（`loading="lazy"`，绝对 URL 走 `API_BASE` 的 `/r/` 反代）
  - footer：订阅入口（`/subscribe`）+「进站看全部」+ 归档页链接
- 样式：单 `<style>` 内联，系统字体栈，品牌色对齐 `docs/design-handoff.md`（主色/文字/分割线三个 token 即可），移动优先单列，目标整页 ≤ 200KB（图片为外链不计入）
- 零 `<script>`

## 6. 错误处理汇总

| 场景 | 行为 |
|---|---|
| Phase 4 任意异常 | 记日志，邮件与 Codex 推送不受影响 |
| 当日 digest_pool 无数据 | 跳过生成，记日志 |
| R2 写失败 | 该日无页面，下次手动 `mode=daily-page&date=` 补 |
| 伺服时 R2 miss | 404 页（合法日期）/ 302 归档页（非法路径） |
| IndexNow 失败 | 仅记日志，不重试（下一日自然再 ping） |
| nginx 回滚 | 删 location 块 + reload，worker 路由无状态可直接回滚 |

## 7. 测试计划与验收标准

### 7.1 单元测试（vitest，参照 `node-run-options.test.ts` 既有模式）

- `daily-page.ts`：fixture 快照 → 断言 title/canonical/JSON-LD 合法（可解析且 ItemList 条数正确）/五源 section 齐全/深链绝对 URL 正确/零 script 标签/后一日链接指向归档页
- sitemap 生成：条目数 = daily_pages 行数 + 2；XML 合法
- robots/llms 生成：包含 Sitemap 行 / 最近 7 天链接
- 路由：非法日期 302；合法日期 R2 miss 404；正常 200 + 正确 Content-Type 与 Cache-Control

### 7.2 staging 全链路

1. migration 在 `xlist-staging` 执行 → deploy staging worker
2. `mode=daily-page&date=<staging 有数据的日期>` 手动生成 → curl `staging-api` 域断言 200 + 关键标签
3. sitemap 包含该页；robots/llms 200
4. `notify-digest-now` 跑一轮确认邮件链路零回归（Phase 4 关闭态 `DAILY_PAGE_ENABLED` 未设时应完全静默）

### 7.3 prod 验收（全部通过才算完成）

1. `curl -I https://ai-feeds.com/daily/<最新日期>` 等五个 URL 全 200（经 HK nginx 主域路径）
2. backfill 后 `daily_pages` 行数 = digest_pool 可重建历史天数，sitemap 条数一致
3. 页面内任一深链点击可打开对应抽屉（人工 smoke）
4. Google Rich Results Test 对日报页通过（无致命错误）
5. 次日 8 点自然生成新页 + IndexNow 日志成功（观察一个周期）
6. 老用户 SW 更新后直访 `/daily/` 不再被壳劫持（新版 sw.js 生效后验证）

### 7.4 用户手动项（交付指引文档）

Google Search Console + Bing Webmaster 域名验证、提交 sitemap。

## 8. 上线步骤

1. feature branch `feat/daily-static-page`（worker + dashboard 同分支）
2. D1 migration：staging → 验证 → prod
3. staging 部署 + §7.2 验证
4. PR review → 合 main
5. prod 部署：worker + dashboard 同步（发布 checklist 全项对照，deploy 前 rebase 检查 + source 整个 env 文件）
6. HK nginx 加 location + reload + 清 nginx 缓存（`rm -rf /var/cache/nginx/aifeeds/*`）
7. prod secrets：`DAILY_PAGE_ENABLED=1`、`INDEXNOW_KEY`（同步 `.secrets/` 文件 + `gh secret set` 如 CI 涉及）
8. 执行 backfill → §7.3 验收
9. 文档收尾：operations.md（路由表 + nginx 段 + secrets 清单）、TODO.md §12 勾选 P0 完成项、CLAUDE.md 如有必要

## 9. 风险与备注

- **多 session 并行**：当前 main 上有未提交的 `node-run.ts` 改动与新文件 `node-run-options.ts`（另一 session 的工作），实施前确认其已合并或协调 rebase，Phase 4 挂载点以合并后代码为准
- **微信内打开日报页**：纯静态页无鉴权无跳转，不触发 RequireAuth 微信逻辑，预期无影响；smoke 一次
- **`.cc` 镜像联动**（未来）：daily 页 HTML 可直接被 `.cc` 轨道复用为国内静态页源，本设计的生成器保持「输入 date → 输出完整 HTML」纯函数形态以便复用
