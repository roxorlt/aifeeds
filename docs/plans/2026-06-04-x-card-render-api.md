# X 内容转社媒图片渲染 API — 设计与对接文档 (v1 草案)

> 2026-06-04 起草。Claude(aifeeds 数据侧) × Codex(腾讯云渲染侧) 协作项目。
> 状态:**草案,待 Codex 回 3 个开放项后定稿**(见 §9)。
> 分支:`feat/x-card-render`(与微信登录解耦,只从 main 发布,先过 staging)。

## 1. 背景与目标

把 aifeeds 收录的 X(Twitter)推文,渲染成 1080×1440 的社媒分享图(竖图,3:4)。
这是一个**按需 API**(不是定时任务):给一条推文,出一张/多张排版好的中文卡片图。

与现有「分享海报」(`/api/share/poster`, resvg-wasm SVG)**不是同一回事**:这套是另一个分享渠道,
排版布局完全不同、不带二维码等元素,所以由 Codex 用 Chrome/Puppeteer 另起渲染服务,不复用 SVG 那套。

## 2. 职责边界

| 侧 | 负责 |
|----|------|
| **aifeeds(Claude)** | X 抓取、清洗、字段标准化、中文翻译 + 摘要、**所有图片资源缓存到 R2 给稳定 https 链接**、拼完整 payload、调 Codex 渲染、把成品图转存回 R2 对外 |
| **Codex(腾讯云 82.156.0.68)** | 鉴权、接收 JSON、下载图片(已是 aifeeds R2 稳定链接)、套模板、Chrome 渲染 PNG、返回成品 |

**关键约定:Codex 保持无状态** —— 不查 aifeeds 数据库、不碰我们的鉴权、不依赖原始 twimg 链接。
所有它需要的数据都在 payload 里,所有图片 URL 都是 aifeeds R2 的 https 稳定地址。

## 3. 数据来源映射(aifeeds D1 `items` → payload)

aifeeds 把每条 X 推文存在 D1 `items` 表(`source_type='x_list'`),源专属字段在 `extra` JSON 里。
逐字段确认(2026-06-04 抽真实数据核对):

| payload 字段 | aifeeds 来源 | 备注 |
|-------------|-------------|------|
| `tweet.id` | `items.source_id` | |
| `tweet.permalink` | `https://x.com/{handle}/status/{id}` | 底部署名/出处用 |
| `tweet.author_name` | `items.author` | 显示名 |
| `tweet.author_handle` | `items.handle` | @用户名 |
| `tweet.author_avatar` | `extra.profile_image_url` | 原始是 `_normal`(48px),**换 `_400x400` + 缓存进 R2** |
| `tweet.verified` | `extra.is_verified` | |
| `tweet.created_at` | `items.published_at` | |
| `tweet.lang` | `items.lang` | `zh`/`en`/... |
| `tweet.text` | `items.content` | **原文**(已含完整长推/转推全文,见注) |
| `tweet.text_zh` | `items.content_translated` | 中文译文;**原文即中文时为 null**(渲染端回退 `text`) |
| `tweet.summary_zh` | `extra.ai_summary` | 一句话中文摘要(流水线已产出) |
| `tweet.metrics` | `items.metrics` / `extra` | likes/reposts/replies/views,**可能缺字段**(views 偶为 null) |
| `tweet.media[]` | `items.media[]` | 每个 `url` 缓存进 R2;视频带 `poster_url` |
| `tweet.quoted_tweet` | `extra.quote_of` | 数据很全;**v1 不渲染,v2 再开** |
| `tweet.thread[]` | `extra.thread_root_id`/`reply_to_id` 重建 | **v1 不做,v2 再开** |

> 注:2026-06-02 已修复「转推长推被截断」问题,`content` 现在是完整正文(最长 ~25k 字)。
> 超长推文渲染端用 `summary_zh` 放下半屏,正文区截断显示。

## 4. 资源 R2 缓存策略(本项目核心基建)

**现状**:Product Hunt、HF 论文的图已迁 R2(`worker/src/ph-r2.ts` 模式 + `/r/<key>` 反代);
**X 的头像/媒体、GitHub 头像仍是原始外链,未缓存**。

**要做**:新增「X 媒体 → R2」缓存,把 `items.media[].url` + `extra.profile_image_url`(及嵌套
`quote_of`/`retweet_of` 的同名字段)迁到 R2,落库写回 `/r/<key>` 链接。理由:
- twimg 原始链接会过期、对陌生服务器 IP 可能防盗链、头像链接会轮换;
- 渲染机(及任何消费方)走 Cloudflare R2 CDN,稳定且快。

**顺带**:日报 API(`/api/digest/daily`)返回的 `logo`/`media` 等资源字段,统一输出 R2 链接
(PH/HF 已是,补齐 X/GH),减少消费方(82.156 daily workflow)对原始源/慢服务器的依赖延迟。
—— 这与 X 卡片要做的媒体缓存是同一套底层,合并在本分支一起做。

## 5. JSON Schema v1

> 2026-06-04 Codex 已确认 3 个开放项 + 提议扁平结构,本节为**双方约定的 v1 schema**。

端点:`POST http://82.156.0.68/aifeeds/api/render/x-card`
请求头:`Authorization: Bearer <shared_token>` + `Content-Type: application/json` + `Accept: image/png`

### 5.1 请求体(aifeeds → Codex)

采用 Codex 提议的扁平结构(`tweet`/`author`/`media`/`metrics`/`style` 平级):

```json
{
  "render_key": "2061117302528188712-a1b2c3d4",
  "tweet": {
    "id": "2061117302528188712",
    "lang": "en",
    "text": "原文,保留换行",
    "text_zh": "中文译文,可为空(原文即中文时,渲染端回退 text)",
    "summary_zh": "一句话中文摘要",
    "permalink": "https://x.com/sama/status/2061117302528188712",
    "created_at": "2026-06-01T12:34:56Z"
  },
  "author": {
    "name": "Sam Altman",
    "handle": "sama",
    "avatar_url": "https://api.ai-feeds.com/r/x-avatar/<key>.jpg",
    "verified": true
  },
  "media": [
    { "type": "image", "url": "https://api.ai-feeds.com/r/x-media/<key>.jpg", "poster_url": null, "width": 1200, "height": 800 }
  ],
  "metrics": { "likes": 1234, "reposts": 123, "replies": 45, "views": null },
  "style": { "template": "x-card-v1", "size": "1080x1440" }
}
```

- `render_key` = `<tweet_id>-<内容哈希前 8 位>`,幂等键(见 §6)。
- **`author.verified`**(aifeeds 补充字段):蓝V 在卡片里是关键视觉,aifeeds 有 `extra.is_verified`,建议保留。
- **v1 视频处理**:v1 Codex 不做视频封面卡,故 aifeeds **只发 image**——纯视频推文把封面图当 `type:"image"` 发(`url` 给封面),保证卡片有主视觉;无任何图则纯文字卡。
- `media[].width`/`height`:aifeeds 可附带(帮判断横竖排版),Codex 不需可忽略。
- `metrics` 缺字段(如 `views: null`)渲染端优雅降级,不强依赖。
- `created_at`:aifeeds 发 ISO 8601 UTC;`reposts` = aifeeds 侧转推数。

### 5.2 响应(Codex → aifeeds)

**直接返回 PNG 字节**,`Content-Type: image/png`(v1 单图,不返 JSON/zip)。
aifeeds 收到字节后转存 R2,对外统一用 `https://api.ai-feeds.com/r/x-card/<render_key>.png`。
82.156 只做渲染机,不托管公网图片。

## 6. 鉴权与幂等

- **鉴权**:`Authorization: Bearer <shared_token>`。**token 由 Codex 生成**(存其 `/opt/dailyVideo/.env`
  的 `X_CARD_SHARED_TOKEN`),单独发给 aifeeds。aifeeds 把它**存进 `.secrets/aifeeds-{prod,staging}.env`
  + worker secret**(不写进代码/文档/payload),调用时带 Header。
- **幂等**:`render_key = tweet_id + 内容哈希`。哈希覆盖 `text + text_zh + summary_zh + media urls + metrics`。
  内容变了(互动数刷新、翻译回填)→ 哈希变 → Codex 重渲染;没变 → 命中缓存返同一张图。
  **不可只用 tweet_id 当幂等键**,否则回填更新后会返回旧图。幂等缓存由 Codex 侧按 `render_key` 维护。

## 7. 成品图托管流程

```
aifeeds 拼 payload → POST Codex 渲染 → Codex 回成品(URL 或字节)
   → aifeeds 拉取 → 存入 aifeeds R2 → 对外 https://api.ai-feeds.com/r/x-card/<job_id>/NN.png
```

82.156 只当渲染机、不对外服流量。所有公开 URL 均为 aifeeds HTTPS + CDN
(避免 `http://82.156...` 纯 IP 在 HTTPS 站上的混合内容拦截 + 慢延迟)。

## 8. aifeeds 侧实现计划(本分支 `feat/x-card-render`)

| 阶段 | 内容 | 落点 |
|------|------|------|
| P0 | **X 媒体 → R2 缓存**:扩展 ph-r2 模式,迁 `media[].url` + 头像;workflow 实时迁新推 + cron 增量迁存量 | 新 `worker/src/x-media-r2.ts` |
| P1 | **日报 API 换链**:`/api/digest/daily` 的 logo/media 统一输出 R2 链接(补 X/GH) | `worker/src/digest/` |
| P2 | **payload 组装器**:给 tweet_id,从 D1 拼出 §5.1 payload(含内容哈希) | 新内部函数 |
| P3 | **调 Codex + 转存**:POST payload → 取回成品 → 存 R2 → 返最终 URL;幂等缓存 | 新 endpoint |

验证:每阶段 staging 跑通再合 main;只从 main 发 prod。Codex 侧是其自有服务器/仓库,与本分支无关。

## 9. 开放项

**Codex 已确认(2026-06-04)**:
1. ✅ 成品交付:直接返回 PNG 字节(`Content-Type: image/png`),aifeeds 转存 R2;v1 单图不返 zip。
2. ✅ `shared_token`:Codex 生成,aifeeds 带 Header(见 §6)。
3. ✅ 尺寸:v1 固定 1080×1440;`style.size` 字段预留,v2 再支持 1:1 / 4:3 / 16:9。

**待 Codex 点头(aifeeds 提议的 2 处小补充)**:
- `author.verified` 字段是否保留(蓝V 视觉)。
- v1 视频推文降级为「封面图当 image 发」是否 OK。

## 10. 分期 roadmap

- **v1**:单 tweet + 中文摘要,单图。媒体/头像/成品全走 aifeeds R2。
- **v2**:thread 多图、quoted tweet 卡片、视频封面、批量渲染。
