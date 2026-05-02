# Dev Log

> 跨 session / 跨 phase 的开发实测发现 / 决策点 / 路径调整。**append-only**，不改旧条目。
> 跟 design doc 的区别：design doc 描述「应该做什么」，dev log 记「做了之后才发现的事」。

---

## 2026-05-03 · PH Phase 1 POC：CF Browser Rendering 不够

**背景**：PH 站走 Cloudflare turnstile 防护，curl 直接 403。Phase 0 设计选 CF Browser Rendering（B 方案）作首选，本地 Python（A 方案）作 fallback。

**POC 实测**：worker `/poc/ph?slug=zed`，跑了两轮：

| 轮次 | 配置 | 结果 |
|------|------|------|
| 1 | `waitUntil: domcontentloaded` + 8s wait-for-selector | status 403, title `"Just a moment..."`, isTurnstileFinal: **true**, ldJsonBlocks: 0, total 8.7s |
| 2 | 同上 + 25s wait + mouse 移动 + scroll 模拟 | status 403, title `"Just a moment..."`, isTurnstileFinal: **true**, ldJsonBlocks: 0, total 28.9s |

**结论**：CF Browser Rendering **不能自动通过 PH 的 CF turnstile**。即使加大等待时长 + 行为模拟（鼠标移动 / scroll）turnstile 仍未放行。CF Browser 的 IP / fingerprint 被识别为非真人浏览器。

**根因（推测）**：

- CF Browser Rendering 跑在 CF 数据中心 IP 段，PH 的 turnstile 对数据中心 IP 评分较低
- @cloudflare/puppeteer 默认 fingerprint 仍带 `navigator.webdriver=true` 等机器人信号
- PH 自身用的是 CF turnstile，但不代表"自己人放行自己人"——分账户独立评估

**决策**：切换到 fallback A — **本地 Python + browser-use**。理由：

- X scraper 已经用同样方式跑了几个月稳定（`~/.claude/skills/xlist-scraper/`）
- browser-use 自动从 Chrome profile 复制 cookie，注入一次 PH 登录后 30 天内 turnstile 免疫
- 本地跑没有 CF Browser 月度时长成本

**保留**：worker 的 `/poc/ph` 路由保留作诊断工具。未来若需重测（CF Browser 升级、PH 降低防护等场景）可直接用，不用从零再写一遍 POC。

**对 design doc 的影响**：风险登记 #1 命中（"CF Browser Rendering 过不了 PH turnstile"），按预案 fallback A，整体工时不变（设计时已预算 +1 天）。Phase 2 起改用 `scrapers/ph/` Python 实现，结构对齐 `scrapers/github/`。

---

## 2026-05-03 · PH 原生 categories 暂时不解析（用 LLM 分类顶上）

**现象**：PH 产品页 HTML 里 `"categories":[...]` 数组出现 ~10 次：

- 主产品 1 个
- 相关产品 9 个（每个产品自己的 categories）
- 还有 `featuredCategories`（推荐位）+ `trendingCategories`（热门位）

单凭正则定位主产品的那一个不可靠（每个相关产品也长一样的结构），需要顺
着 NextJS RSC stream 找到带主产品 `slug` 的对象。

**决策**：v1 跳过原生 categories 解析，`extract_categories()` 直接返回空。
让 LLM judge 输出的 `ai_category`（基于 tagline + description + maker post
推断的 AI 分类 slug）顶上。mockup 上 drawer 的 category chip 也是用 AI 分
类，UI 不依赖原生 categories。

**未来改进**：如果想要 PH 原生 categories 准确解析，得做 RSC stream 解码
（self.__next_f.push 的 JSON-string-encoded 流式数据）。工作量 ~半天，
v2 再做。

---
