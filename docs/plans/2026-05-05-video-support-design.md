# Video Support — X 渲染 + PH 抓取双线整修

> 起点：用户 2026-05-05 反馈"X 和 PH 的视频在 ai-feeds 一律看不到"。
> 排查结论：X 视频已落库 240 条但前端只画"▶ 视频"角标，没真的渲染 `<video>`；PH 视频根本没抓，parser / sync 完全没 video 分支。

## 目标

1. **A — X 视频前端能播**：`TweetCard` / `TweetDrawer` / Lightbox 用 `<video>` 真渲染已有 240 条数据；不引入新依赖
2. **B — PH 视频能抓 + 落库 + 渲染**：parser 反推 PH 视频字段位置；sync 输出 `type:"video"` media；走已有 worker R2 迁移；`PhDrawerBody` 现成的 video 分支接上
3. 不改 schema、不改 ingest 协议、不改 worker 端 video 处理路径之外的东西

## 非目标（YAGNI）

- 视频缩略图生成 / 自定义播放器 controls
- 视频元数据（时长、分辨率）回填——浏览器自己读 `metadata` preload 即可
- 视频 R2 反代 host 的 GFW 优化（先用 PH / X 原 host，慢就慢，除非用户报障）
- 视频 lazy-load（视口外不加载）—— `preload="metadata"` 已经足够轻

## A 部分：X 视频前端渲染

### 现状（2026-05-05）

```ts
// dashboard/src/components/TweetCard.tsx:227
const images = media.filter((m) => m.type === "image" && ...);
const firstImage = images[0];
const hasVideo = media.some((m) => m.type === "video");
// 渲染时仅有图片走 <img>，hasVideo 仅显示 "▶ 视频" 角标
```

```ts
// dashboard/src/components/Lightbox.tsx
// 只有 <img>，无 <video> 分支
```

```ts
// dashboard/src/components/TweetDrawer.tsx
// 用 TweetCard 渲染 thread，间接受同样限制
```

### 设计

**关键决策：feed 卡片显示 video poster，详情/lightbox 才能播放**

- Feed 卡片要密集，自动播放 N 条 video 会卡 + 流量爆炸；不自动播放
- 卡片上 video 渲染成 `<video preload="metadata">` 拿首帧（自带 poster），叠 "▶" 居中按钮，点击进 Lightbox 全屏播
- Lightbox 加 video 分支：用浏览器原生 controls，不写自定义 UI
- video 和 image 在同一个 media row 里按 DOM 顺序排（X 推文一般是单视频或单图，混排极少）

### 改动清单

| 文件 | 改动 |
|---|---|
| `dashboard/src/components/TweetCard.tsx` | `firstImage` 改成 `firstMedia`（image \| video），video 渲染 `<video poster muted preload=metadata>` + 中央 ▶ 按钮 |
| `dashboard/src/components/Lightbox.tsx` | 渲染 `<img>` 还是 `<video controls autoPlay>` 按 `m.type` 切 |
| `dashboard/src/components/TweetCard.tsx` Lightbox 调用 | `media={images}` → `media={imagesAndVideos}` |
| `dashboard/src/lib/utils.ts proxyImg` | video.twimg.com host 走 worker `/img` 反代（GFW 用户播放） |
| `worker/src/index.ts /img` | 已有 host 白名单加 `video.twimg.com`（如果还没加） |

### /img proxy for video — 检查清单

需要确认 worker `/img` 当前白名单：
- `pbs.twimg.com` ✓
- `abs.twimg.com` ✓
- `video.twimg.com` 待查（如果没就加，并改 cache TTL，video 体积大不要缓 7 天）

**保守方案**：video 先**不走** `/img` 反代，直接 `https://video.twimg.com/...`。GFW 用户看不到再说——这条等用户报障再加。

## B 部分：PH 视频抓取

### 现状

```python
# scrapers/ph/parser.py:99-147 parse_product_page
# 只取 main.get("image") + main.get("screenshot") 都 type="image"
# JSON-LD 不含视频字段（PH 选择不暴露在 schema.org WebApplication 块）

# scrapers/ph/sync.py:69-72
media = []
if p.get("image"): media.append({"type": "image", ...})
for s in (p.get("screenshots") or []):
    media.append({"type": "image", ...})
# 没 video 分支
```

### 推测的 PH 视频字段位置（待 recon 验证）

PH Next.js 的 GraphQL state 在 `self.__next_f.push("data")` 序列里，已知 votesCount / pricingType 等都从这套 state 抠出来（见 `parser.extract_metrics`）。视频可能字段：
- `videoUrl` / `media[].videoUrl` / `posterUrl`
- `featuredVideo` / `productVideo`
- `vimeo` / `youtube` URL（PH 早期允许直接嵌外部）

### 实施步骤

1. **Recon**：用 browser-use 重抓一个有视频的 PH 产品页（如 manus、screen-studio），grep 所有 `.mp4` / `videoUrl` / `vimeo` / `youtube` / `<video` 出现的位置 → 确定字段名
2. **parser**：加 `extract_video(html: str) -> dict | None` 返回 `{url, type: "mp4|youtube|vimeo", poster_url?}`
3. **sync**：`product_to_item` 的 media 构造时，若有 video 数据 append `{type: "video", url, poster: ...}`
4. **worker `ph.ts` R2 迁移**：已有 video 分支（设计阶段就考虑过），验证它能正常处理 mp4 → R2；youtube/vimeo embed URL 不迁移直接保留
5. **重抓**：跑一次 `--leaderboard 2026-05-04 --push` 把现有 21 条产品的 video 抓到位
6. **PhDrawerBody 渲染**：`<video src controls preload="metadata">` 已存在（gallery 段），不用改

### 边界 case

- **YouTube/Vimeo embed**：iframe 不是 mp4。`PhDrawerBody` 的 `<video>` 渲染不了。两种方案：
  - 简方案：embed video 暂存 `media[].type="video_embed"`，前端单独渲染 `<iframe>`
  - 偷懒方案：embed 视频跳过不抓（先看占比再决定）
- **没视频的产品**：parser 返回 None，sync 不 append video media，与现状一致

## 验证 / 部署流程

按 CLAUDE.md 流程：

1. **本地 build**：`cd dashboard && npm run build` 无 error
2. **本地 dev server**：`npm run dev`，feed 列表里翻到带视频的推文（240 条之一），看卡片 + 点开 Drawer + Lightbox
3. **scraper 小批量**：`python -m scrapers.ph.scraper --slug manus`（dry-run 模式，不 push），看 parser 抓到 video 字段
4. **PH 重抓 + push 到 staging**：`--leaderboard 2026-05-04 --push --staging`（如 sync.py 支持 staging 目标，否则手动改 INGEST_URL）
5. **staging 验收**：`https://staging.ai-feeds.com` 看 X video + PH video 都能播
6. **合 main + prod 部署**：worker（如改 /img 白名单）+ dashboard 同步部署
7. **prod 重抓 PH 5/4 leaderboard**：手动跑 `--leaderboard 2026-05-04 --push` 覆盖 prod D1

## Rollout 风险

- **A**：纯前端，可回滚（rollback dashboard build）；240 条视频不会因为前端崩了被删
- **B**：parser 改动可能误伤现有 image 抓取——加 video 字段是新增分支，不动 image 路径
- **R2 配额**：21 条产品平均 1 个 video × ~2-10MB = ~100MB/day 多。R2 免费 10GB/月足够
- **video.twimg.com 反代**：暂不加白名单，避免被滥用 + 流量爆炸

## TODO 后置

- 视频 lazy-load（IntersectionObserver 触发 video 元素挂载）
- video poster 单独抠首帧（如果 PH 没给 poster 字段）
- GFW 用户的 video.twimg.com 反代（按用户报障决定）
- 视频时长 / 文件大小展示
