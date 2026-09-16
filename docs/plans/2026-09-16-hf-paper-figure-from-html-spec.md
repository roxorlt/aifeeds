# HF 论文插图：改为解析 arXiv 网页版 + 图片指针保护 + 日报只输出站内图（2026-09-16）

## 背景（已取证，勿重复排查）
- `worker/src/hf-paper/figure-arxiv-html.ts` 只靠拼 `https://arxiv.org/html/<id>/x{N}.png`。arXiv 约 2026-08-10 起新渲染的网页版改为保留原始文件名（`<id>v1/figures/<name>.png`，也可能是 `.jpg`），x1.png 一律 404 → 日志 `x1 404, no HTML rendering` → `figure_image.source='none'`。7 月及更早的论文 xN.png 仍存在。
- `ar5iv.ts` 第一步已经 `fetch('https://arxiv.org/html/<id>')` 拿到整页 HTML，但只用来抽段落，没解析图片。
- 网页版结构（实测 2609.11412）：`<figure class="ltx_figure ...">` 内 `<img class="ltx_graphics ... ltx_img_landscape|square|portrait" src="2609.11412v1/figures/fig_radar.png" width="229" height="225">`，`<figcaption>Figure 1: …</figcaption>`；表格是 `<figure class="ltx_table">` 无 img；页面 chrome 图片是 `/static/base/...`（svg/png）与 `data:image/...`。src 为相对路径，按 `https://arxiv.org/html/` 目录解析即得 `https://arxiv.org/html/2609.11412v1/figures/fig_radar.png`（已验证 200）。
- 入库 upsert（`worker/src/index.ts` ingestItems ON CONFLICT）`media = excluded.media` 无条件整列覆盖：HF 日榜周末重复列出同一批论文、PH 榜单重复出现同一产品、RSS 重复抓同一篇文章时，都会把已迁进 R2 的 `media[].url`（`/r/...`）改回外链，而 `extra.r2_migrated_at` 经 json_patch 保留 → 后续永远不再迁。
- 日报渲染 `worker/src/digest/render.ts` hf-paper 分支把 `media[0]` 原样当 cover，`buildMedia` 还回退到 `figure_image.raw_url`，会把 `cdn-thumbnails.huggingface.co` / `arxiv.org` 外链交给出片面板与静态页；出片机在大陆，这两个域名要么连不上要么 10s+ 一张，等于无图。邮件 `deliver.ts` 不经 renderItem 且不渲染图片，不受影响。

## 目标
新论文进库后 `figure_image.source='arxiv-html'` 的比例回到 8 月前水平（≈85%），且日报数据里论文条目的 cover/media 只含站内 `/r/` 图（可为空，绝不给外链）。重复入库不再丢失已迁移图片。可按日期范围重跑存量。

## 改动

### A1 `figure-arxiv-html.ts`：从 HTML 解析候选，xN 只作兜底
- 新增导出 `extractArxivFigureCandidates(html: string): FigureCandidateRef[]`，`FigureCandidateRef = { url: string; order: number; figureNumber: number | null; declaredWidth: number | null; declaredHeight: number | null }`。
  - 只取 `<figure` 且 class 含 `ltx_figure` 的块（排除 `ltx_table`）；块内每个 `<img>`（优先 class 含 `ltx_graphics`）取 `src`。
  - 跳过：`data:` URI、`.svg`、路径含 `/static/`、空 src。
  - 解析：`new URL(src, 'https://arxiv.org/html/')`；绝对 `http(s)` 直接用；只接受 host `arxiv.org`。
  - `figureNumber`：figcaption 文本匹配 `/^\s*Figure\s+(\d+)/i`；排序键 `(figureNumber ?? +∞, 文档顺序)`；同一 URL 去重。
  - `declaredWidth/Height`：读 `width`/`height` 属性（无则 null）。仅用于预排序（可选），真实尺寸仍以下载后探测为准。
- `fetchFirstFigureFromArxivHtml(env, arxivId, opts?: { html?: string; fetcher?: typeof fetch })`：
  - 若 `opts.html` 非空 → 候选 = `extractArxivFigureCandidates(html)`，最多取前 10 个（`MAX_FIGURES_PER_PAPER`）。
  - 候选为空（无网页版或纯文本论文）→ 走现有 xN 猜测循环（保留原逻辑，含 404 即停）。
  - 对每个候选：fetch（沿用 `fetchWithRetry`，改为可注入 fetcher）→ 大小上限 5MB → 探测尺寸：PNG 用现有 `probePngDimensions`（含 palette）；JPEG/GIF 新增分支（把 `ar5iv.ts` 里的 JPEG/GIF 探测搬进本文件并导出，`palette_size=null`；不要再复制第五份，`ar5iv.ts` 改为 import 本文件导出的探测函数）→ 现有 GATE（palette gate 仅 PNG）→ `scoreAspect` → early stop（100 分）/ lookahead 3 张。
  - 排序、R2 put、返回结构不变；`raw_url` = 候选绝对 URL；`picked_index` = 候选序号（1 起）；R2 key 扩展名按 content-type（png/jpg/gif），`httpMetadata.contentType` 相应设置；成功日志追加 `mode=html|guess`。
- 日志前缀保持 `[hf-paper:figure-arxiv-html]`，404/网络错误行为不变。

### A2 `ar5iv.ts`：把已抓 HTML 传入
- `fetchAr5ivAndExtractFigureForHf` 里改为 `fetchFirstFigureFromArxivHtml(env, arxivId, { html })`。其余（段落存 R2、media[0] 处理、`ensureR2Url` 兜底）不变。
- 删除本文件内的 `probeImageDimensions/probePngDimensions` 副本，改 import。

### A3 `index.ts` ingestItems：不覆盖已迁移的 media
- ON CONFLICT 的 `media = excluded.media` 改为：
  ```sql
  media = CASE
    WHEN items.media LIKE '%"url":"/r/%' AND coalesce(excluded.media, '') NOT LIKE '%"url":"/r/%'
      THEN items.media
    ELSE excluded.media
  END,
  ```
  含义：库里已有站内图、来的是外链 → 保留库里的；其余情况照旧。对所有 source_type 生效（HF / PH / RSS 同病）。
- 若已有 ingestItems 的测试夹具能拿到 SQL 文本，补一条断言含此 CASE；若没有夹具，在 `worker/src/ingest-upsert-media-guard.test.ts` 用最小 fake DB（记录 prepare 的 SQL）验证 SQL 含该子句即可（不要为此引入 miniflare）。

### A4 `render.ts` hf-paper：只输出站内图
- cover：`media[]` 中第一个 `type==='image'` 且 `isInternalR2(abs(url))` 的；否则 `figure_image.r2_url`（须 isInternalR2）；否则 `null`。
- `buildMedia` hf-paper：`media[]` 只保留 isInternalR2 的图；追加 `figure_image.r2_url`（isInternalR2 时）；**删掉 `raw_url` 回退**。
- 其他 source 分支逐字节不变。`render.test.ts`（或新建 `render-hf-paper-cover.test.ts`）补：外链 media + r2 figure → cover=figure；全外链 → cover=null 且 media 为空；已迁 media → 原样。

### A5 管理模式 `hf-paper-figure-rerun`（`handleEnrichRun`，Bearer INGEST_TOKEN）
- 参数：`date`（BJT `YYYY-MM-DD`，默认今天）、`days`（默认 1，1–14，范围 = `[date-days+1, date]` 按 `scraped_at` 的 BJT 日期）、`ids`（逗号分隔 arxiv id，给了就忽略 date/days）、`limit`（默认 10，1–30）、`dry=1`、`force=1`。
- 选取：`source_type='hf_paper'`，范围内，且（非 force 时）`json_extract(extra,'$.figure_image.source') IS NOT 'arxiv-html'`；按 `scraped_at` 升序。
- 每条：调用 `fetchAr5ivAndExtractFigureForHf(env, id, arxivId)`（它会重写 `figure_image` 与 `media[0]`，取不到图时把 HF 缩略图迁进 R2）。成功取到插图后 `json_remove(extra, '$.card_variant_version', '$.card_variant_status')`，让现有 `card-image-variant-backfill` 模式按 `figure_image.raw_url` 重新生成卡片变体。
- 串行执行；返回 `{ scanned, rerun, figure_found, thumbnail_only, failed, remaining, items: [{id, source, r2_url}] }`；`dry=1` 只返回将处理的 id 列表。
- 复制 `cover-quality-sweep` 的写法（`index.ts` ~5301 与 `feeds/media-r2.ts` ~942）。实现放 `worker/src/hf-paper/figure-rerun.ts`，index.ts 只做参数解析与调用。

## 不改
- 出片面板（dailyVideo 仓）不改。
- `hf-paper/media.ts`、workflow 步骤顺序不改。
- 邮件 `deliver.ts` 不改。

## 验证
- `cd worker && npx tsc --noEmit && npm test` 全绿。
- 新测试覆盖：相对路径解析、排除 static/svg/data、按 Figure N 排序、JPEG 接受、图标被 gate 拒、横图优先于方图、HTML 无 figure 时回退 xN、render 三种 cover 情形、upsert SQL 子句。
- 之后由主 agent 发 staging 验证 `?mode=hf-paper-figure-rerun&ids=2609.11412&dry=1` 与真跑，再合 main 由 CI 发 prod，回填 9/8 起论文。

## 裁决记录
- 不解析 PDF、不用第三方论文站接口（5 月已否决 PDF 路线）。
- media 保护做在 SQL 层且对所有来源生效，不做 per-source 白名单。
- 日报层对论文条目采取「无站内图就不给图」而不是给外链。

## 实现记录（2026-09-16，规格没写到、实现时定下的几处）

- **日志**：gate 失败的 reason 串保留原来的 `png_parse_fail`（现在也探测 JPEG/GIF，但改字符串会动到现有日志行）。候选标签在 guess 模式仍是 `xN`（与老版逐字节一致），html 模式用 `cN`。
- **404 语义按模式分开**：guess 模式保持「x1 404 即停」；html 模式里单张候选 404 只跳过这一张，继续看后面的候选（HTML 已经明说图在那儿，一张失效不代表后面都没有）。
- **`picked_index` 与 `order`**：`order` 记文档顺序（1 起），`picked_index` 记候选排序后的序号（1 起）；guess 模式下 `picked_index` 仍等于 `xN` 的 N。
- **嵌套子图**：外层块的 `Figure N` 编号覆盖子图的「(a)/(b)」，同一 URL 去重时保留先出现的那条（即外层）。
- **日期区间换算**：`scraped_at` 是 ISO UTC 串，字典序即时间序，区间边界在 JS 里算成 UTC 字符串比较，不用 SQLite 的 `date(..., '+8 hours')`，免掉时区函数对带 `Z` 后缀取值的解析风险。
- **`thumbnail_only` / `failed` 判定**：重跑后回读 `extra.figure_image.source`，`arxiv-html` 记 figure_found，其余情况按这一轮是否 `fetched` 分到 thumbnail_only 或 failed。
- **`ids` 模式的 `remaining`**：按同一谓词只在这批 id 上计数；`force=1` 时谓词不含插图门，`remaining` 不会随重跑递减，需要自行控制调用次数。
- **A3 的测试口径**：夹具手抄一份 SQL 容易漂移，改成从 `ingestItems` 真实 `prepare` 出来的 SQL 取文本，既断言含该 CASE，又把这条 SQL 灌进内存 SQLite（`node:sqlite`）跑五种组合验证语义。
