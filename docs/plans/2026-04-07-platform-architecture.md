# xList Scraper → AI Info Platform 架构设计

> 记录于 2026-04-07，基于与 Claude 的架构讨论

---

## 背景与动机

原有架构（xlist-scraper v1）：本机抓取 + 本机 SQLite 存储，只处理 X List 数据。

扩展目标：
- **抓取侧**：增加 YouTube、Podcast、Product Hunt、观猹等多个 AI 内容源
- **存储侧**：从本机 SQLite 迁移到公网可访问的远程数据库
- **展示侧**：提供一个 Web 看板，聚合展示所有内容
- **分发侧**：Newsletter 订阅服务

**核心约束**：抓取业务必须留在本机（因为访问 X/YouTube/PH 等需要翻墙），不能部署到服务器。

---

## 架构设计

```
本地（需翻墙）                       VPS（公网）
┌────────────────────────┐         ┌───────────────────────────┐
│                        │         │                           │
│  X List Scraper        │──POST──▶│  API Server               │
│  YouTube Scraper       │──POST──▶│    ├── /ingest   (写入)   │
│  Podcast Scraper       │──POST──▶│    ├── /items    (查询)   │
│  Product Hunt Scraper  │──POST──▶│    └── /subscribe(订阅)   │
│  观猹 Scraper          │──POST──▶│           │               │
│                        │         │    PostgreSQL              │
│  Cron 调度器           │         │           │               │
│  (launchd / crontab)   │         │    Dashboard (Web 看板)   │
│                        │         │    Newsletter (Cron + 邮件)│
└────────────────────────┘         └───────────────────────────┘
```

**为什么是 API Server 而非直连数据库：**
- 不暴露数据库端口，安全性更高
- API 层统一做认证（Bearer token）、数据校验、去重
- 同一服务兼顾数据写入和 Dashboard / Newsletter 的数据读取

---

## 统一内容模型（DB Schema）

从当前的 `tweets` 表扩展为通用的 `items` 表：

| 字段 | 类型 | 说明 |
|------|------|------|
| id | UUID | 主键 |
| source_type | VARCHAR | `x_list` / `youtube` / `podcast` / `product_hunt` / `guancha` |
| source_id | VARCHAR | 各平台原始 ID（推文 ID、视频 ID 等） |
| list_id / channel_id | VARCHAR | 来源 List / Channel / 栏目 |
| title | TEXT | 标题（推文可为空） |
| content | TEXT | 原文正文 |
| content_translated | TEXT | 中文翻译 |
| author | VARCHAR | 作者/频道名 |
| handle | VARCHAR | @handle（适用时） |
| url | TEXT | 原始链接 |
| media | JSONB | 附件/封面图（数组） |
| metrics | JSONB | 互动数据（views/likes/replies 等） |
| published_at | TIMESTAMPTZ | 内容发布时间 |
| scraped_at | TIMESTAMPTZ | 入库时间 |
| is_relevant | BOOLEAN | AI 相关性过滤结果 |
| tags | TEXT[] | LLM 打的主题标签 |
| emitted | BOOLEAN | 是否已纳入 Newsletter 发送 |

**兼容性**：`lists` 表保留，改为记录所有内容源的配置（source_type + source_id + 抓取游标 + 抓取频率）。

---

## 各数据源规划

| 数据源 | 抓取方式 | AI 相关过滤 | 更新频率 |
|--------|---------|------------|---------|
| X List | browser-use + Cookie 注入 | LLM（DeepSeek） | 每 2-4 小时 |
| YouTube Channel | YouTube Data API v3 | 标题/描述 LLM 过滤 | 每天 |
| Podcast | RSS Feed 解析 | 标题/摘要 LLM 过滤 | 每天 |
| Product Hunt | PH API 或网页抓取 | 标签/描述 LLM 过滤 | 每天 |
| 观猹 | 网页抓取（browser-use） | LLM 过滤 | 每天 |

---

## VPS 技术选型

| 组件 | 选型 | 说明 |
|------|------|------|
| 数据库 | PostgreSQL | 支持并发写入、JSONB、全文检索 |
| API Server | FastAPI (Python) | 轻量，与现有 Python 技术栈一致 |
| Dashboard | Next.js 或纯 HTML+JS | 静态站点或 SSR，查询 API 渲染 |
| Newsletter | Resend / SendGrid | 邮件发送服务 |
| 订阅管理 | 自建表（email + confirmed） | 简单邮件确认流程 |
| 部署 | 轻量 VPS（2C2G 足够） | Nginx 反代 + systemd 管理进程 |

---

## 本机 Scraper 改造要点

1. **抓取完成后**：从写本地 SQLite 改为 `POST /ingest`（带 Bearer token）
2. **去重逻辑**：移到 API Server 端，基于 `(source_type, source_id)` 唯一约束
3. **游标存储**：改为从 API 拉取（`GET /cursor?source_id=xxx`），本地不再持久化
4. **离线兜底**：网络不通时先写本地临时文件，下次启动时重试上传

---

## 实施阶段建议

### Phase 1：迁移基础设施
- [ ] VPS 上搭建 PostgreSQL + FastAPI
- [ ] `/ingest` 端点 + Bearer token 认证
- [ ] xlist-scraper 改为调用 API（向后兼容：本地也保留 SQLite 作为备份）

### Phase 2：多源扩展
- [ ] YouTube Scraper（YouTube Data API v3）
- [ ] Podcast Scraper（RSS）
- [ ] Product Hunt Scraper
- [ ] 观猹 Scraper

### Phase 3：Dashboard
- [ ] 设计聚合信息流看板（按时间倒序 + source_type 筛选）
- [ ] 开发并部署到 VPS

### Phase 4：Newsletter
- [ ] 订阅页面 + 邮件确认流程
- [ ] 每日/每周 Digest 生成 + 发送 Cron
