# ai-feeds.com 移动端性能实测诊断（2026-05-14）

> 朋友反馈手机访问慢，跑一次 chrome-devtools MCP 实测看到底卡在哪。
> 实测条件：viewport 390x844x3 mobile + Slow 4G + CPU 4x throttle（模拟中端国产手机 + 普通 4G 网络）。
> 测试路径：`https://ai-feeds.com/` 首屏冷加载。
> 关联：[`TODO.md`](../../TODO.md) #4 CF 服务端迁移、#11 ICP 备案 + 国内镜像、#13 字体上线。

---

## 核心指标

| 指标 | 实测值 | 评分 | 标准 |
|------|--------|------|------|
| **LCP（最大内容渲染）** | **2160 ms** | 中等 / 边界 | Good ≤ 2500ms / Needs improvement ≤ 4000ms / Poor > 4000ms |
| **TTFB（首字节）** | 246 ms | 良好 | 服务器+CDN 响应快，不是瓶颈 |
| **LCP Load delay** | **1884 ms** | 大头 | 资源开始下载到 LCP 元素出现之间的等待时间，占 LCP 87% |
| **CLS（布局抖动）** | 0.01 | 优秀 | 视觉稳定，无明显抖动 |

**翻译给非技术读者**：从用户点开链接到看到主要内容，**手机弱网下要等 2 秒多**。这里面服务器响应（TTFB）很快只占 0.25 秒，剩下的 1.9 秒在等"前端 JS 解析 + 图片下载排队"。

---

## 主要瓶颈（按贡献度排）

### 1. PH 图片直连 imgix CDN，没走 R2 反代 ⚠️ **疑似 bug**

首屏并行加载了 **30+ 张 `ph-files.imgix.net/...png`**，全部直连 Product Hunt 自家 CDN：
- imgix 在美东，国内访问通常 200-400ms 延迟 + 弱网下排队严重
- **违反设计**：[`CLAUDE.md`](../../CLAUDE.md) 架构概览说 PH 资源（logo/screenshot/video/avatar）应该已经迁到 R2 + `/r/<key>` 反代
- 实际看到的是原始 imgix URL 直出 — 说明：
  - 要么 dashboard 渲染时没用 R2 URL（前端 bug，直接用了 `extra.logo_url` 原始值）
  - 要么 PH worker 流水线的 ph-r2-migrate 任务没跑完 / 跑错
- **影响**：首屏 30 张图同时排队 → 视口外图片占用并发槽 → 视口内的 LCP 图片也被卡住

**查证方法**（高优先级）：
```
查 D1 prod 库，看 items where source_type='product_hunt' 的 extra.logo_url
是否是 /r/<key> 还是 ph-files.imgix.net 原值。
```

### 2. GitHub 头像直连 githubusercontent.com（40+ 张）

首屏拉了 40+ 张 `avatars.githubusercontent.com/u/<id>?v=4`：
- GitHub 在国内访问偶发慢 / 被劫持（302 重定向到 camo）
- 单张延迟可能 100-500 ms 不等
- **影响**：跟 PH 图片叠加，首屏并行请求数轻松超过 100

**修复**：和 PH 图片一样走 worker `/img?url=...` 反代（X 头像已经在用这个模式 — 看 reqid 54/56 等）

### 3. TweetDrawer.js 114 KB 首屏 eager 加载

各 JS chunk 实际大小（br 压缩后 / 原始）：

| chunk | br size | raw size | 用途 | 是否首屏需要 |
|-------|---------|----------|------|-------------|
| `index.js` | 78 KB | 256 KB | 主 entry（React + 路由 + 卡片） | ✅ 需要 |
| `TweetDrawer.js` | **114 KB** | **395 KB** | 抽屉（DOMPurify + 富文本 + 海报） | ❌ **点击 item 才需要** |
| `toast.js` | 28 KB | 80 KB | toast 通知组件 | ⚠️ 通常不需要 |
| `index.css` | 10 KB | 52 KB | 全局样式 | ✅ 需要 |
| `api.js` | 8 KB | 20 KB | API 客户端 | ✅ 需要 |
| `share.js` | 0.5 KB | 0.9 KB | 分享逻辑 | ❌ 点击分享才需要 |
| `device.js` | 0.3 KB | 0.5 KB | 设备识别 | ✅ 需要 |
| **首屏总计** | **≈ 229 KB（br）** | ≈ 803 KB（raw） |  |  |
| **理想首屏**（lazy 化 drawer + share + toast） | **≈ 86 KB（br）** | ≈ 328 KB（raw） |  |  |

**TweetDrawer.js 114 KB 是最大单 chunk**，但用户必须**点击一条 item 打开抽屉**才用得上。首屏 eager 加载是浪费，应该 `React.lazy()` 切出去。

**改造工作量**：~半天（路由级 lazy split）。**收益**：首屏 JS 砍 62%（229 → 86 KB），LCP 预期减 400-800 ms。

### 4. 首页同时拉 5 个源的 items + 每个 CORS preflight

首屏发起的 API：
```
GET /api/sources, /api/stats, /api/auth/me
+ /api/items?source_type=x_list&limit=30
+ /api/items?source_type=product_hunt&limit=30
+ /api/items?source_type=huodongxing&limit=30&...
+ /api/items?source_type=clawhub&limit=30&...
+ /api/items?source_type=github&limit=30
```

总计：**5 个源 × (OPTIONS preflight + GET) = 10 个 API round trip**。

每个跨域请求都有 OPTIONS preflight（因为 dashboard 在 `ai-feeds.com`、worker 在 `api.ai-feeds.com`，浏览器认作跨域）。Slow 4G 下每个 RTT ~100-200 ms，**光 preflight 就吃 500-1000 ms**。

**修复路径**：
- **A**：API 路径合并 — `/api/feed/home?sources=x,gh,ph,ch,hx&limit=30`，一次 round trip 拉所有
- **B**：让 worker 走 same-origin（如 `ai-feeds.com/api/...` 反代到 worker），消除 CORS preflight
- **C**：dashboard 首屏只渲染 1-2 个 tab，其他 tab 切换时再拉

### 5. 字体子集 30+ 个 woff2

首屏触发了 30+ 个 `fonts.ai-feeds.com/hmos-*/*.woff2` 请求。这次因为 304（已缓存）实际带宽为零，但**首次访问时**这 30 个文件会全下载。

`cn-font-split` 切包默认 unicode-range 分桶细，命中过多反而退化。理想是首屏文案能命中 5-10 个包以内。

**优化**：调 cn-font-split 切包策略（更粗粒度 + 单包 50KB 上限）。**注意**：#13 TODO 已经规划上线 HarmonyOS Sans SC，但似乎已上线了（看到了 hmos-regular/medium/bold 三档），只是切包过细。

### 6. 国内 CF 节点延迟（结构性，不可消除）

ai-feeds.com 在 Cloudflare，国内访问通常走香港 / 日本节点：
- 联通 / 移动 → 香港 ~50-150 ms
- 电信 → 美西 ~200-400 ms（部分线路）

**唯一解**：#11 ICP 备案 + #12 `.cc` 国内镜像站（已有方案，待备案后实施）。

---

## 可执行优化项（按 ROI 排）

| # | 项 | 工作量 | LCP 预期收益 | 是否在 TODO 里 |
|---|------|--------|--------------|----------------|
| **A** | **查 PH 图片为什么没走 R2，修前端 / 修迁移流水线** | 0.5 天 | -300~600 ms（30 张图国内变近） | ❌ 没明确列，应新增 |
| **B** | **TweetDrawer / toast / share lazy split** | 0.5 天 | -400~800 ms（首屏 JS 减 60%） | ❌ 没明确列，应新增 |
| **C** | **GH 头像走 worker /img 反代** | 0.5 天 | -100~300 ms | ❌ 没明确列，应新增 |
| **D** | **API 合并 + 消除 OPTIONS preflight** | 1 天 | -300~600 ms（少 5 次 RTT） | ❌ 没明确列，应新增 |
| E | TODO #4 阶段 2：图片走 cdn-cgi/image webp/avif | 0.5 天 | -100~200 ms | ✅ #4 阶段 2 |
| F | 字体 cn-font-split 调粗粒度 | 0.5 天 | 首次访问 -100~300 ms（重复访问 0） | ⚠️ #13 部分 |
| G | TODO #11 备案 + #12 国内镜像 | 1-3 月 | -500~1500 ms（结构性） | ✅ #11 / #12 |

**前 4 项（A/B/C/D）合计预算 2.5 天，预期 LCP 减 1100~2300 ms** —— **可以把当前 2.16s 砍到 1s 左右**（mobile Slow 4G 实测），跨过 Google "Good" 门槛。

---

## 跟 #4 CF 迁移的关系

- 项 **E**（图片 webp/avif）是 #4 阶段 2 的核心动作。但 **A / C** 是前置 —— PH 和 GH 图片得**先走 worker 反代**才能套 cdn-cgi/image。
- 项 **D**（OPTIONS 消除）在 #4 没列。Workflow 迁移不解决 CORS 问题，需要单独动手。
- 项 **G** 在 TODO 里有但被备案阻塞，短期不能依赖。

---

## 这次实测没覆盖的

- **未登录用户首屏**（cookie / device_id 流程）—— 这次测的是匿名访问
- **抽屉打开 + 海报生成**（用户主要交互路径）
- **真实国内运营商 + 真实 4G**（这次是 Chrome emulate，跟真实运营商路由有差异）
- **CrUX field data**（CF Web Analytics 启了之后才有真实用户数据）

**建议补做**：等 TODO #4 阶段 1 Web Analytics + Workers Logs 落地后，看真实国内用户的 LCP 分布，比 emulate 更准。

---

## 一句话总结

**首屏 2.16s 的 LCP 主要是被 30 张 PH 图直连 imgix + 4 个不必要的 JS chunk 首屏 eager 加载 + 5 个源 API 串行 preflight 三件事拖的**。这三件每件半天，做完能砍掉一半 LCP，跨过 Good 门槛。剩下的国内 CDN 节点延迟得等备案 + 镜像站结构性解决。
