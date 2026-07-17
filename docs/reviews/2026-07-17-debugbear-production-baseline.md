# 2026-07-17 DebugBear 生产基线

## 结论

本轮从 DebugBear 台湾、香港云端节点对 `https://ai-feeds.com/` 做了 20 次 Quick
Test，完全排除本机 Clash。每个地域分别测试默认 Mobile、Desktop 设备，各 5 次冷加载。

当前生产版本是已经合入首屏与动效优化的 classic SPA；尚未包含
`codex/waterfall-ssr-rum-parallel` 上的 waterfall SSR、新旧版切换和
`view_mode` RUM 维度。

当前 classic 基线不能通过既定的移动 cold LCP `p75 <= 3.5s` 门槛：

- 台湾 Mobile p75 LCP：`3.709s`
- 香港 Mobile p75 LCP：`3.765s`
- 台湾 Desktop p75 LCP：`3.020s`
- 香港 Desktop p75 LCP：`3.385s`

此外，采证同时稳定复现了一个生产分页游标契约回归，并发现 Desktop 仍有约 8 MB 的
完整页面传输，其中单个 Product Hunt GIF 占 4.28 MB。正式比较 classic 与 waterfall
前，应先消除这两个已知偏差，或在比较报告中明确将它们作为 classic 的已知缺陷。

## 测试口径

- 采集时间：2026-07-17
- DebugBear project：`104156`
- URL：`https://ai-feeds.com/`
- 地域：`taiwan`、`hongkong`
- 设备：
  - Mobile：DebugBear 默认 Mobile（1.6 Mbps、150 ms RTT、4x CPU）
  - Desktop：DebugBear 默认 Desktop（8 Mbps、40 ms RTT、1x CPU）
- 每个地域/设备组合：5 次 Quick Test
- 总样本：20
- p75：5 个有序样本的 nearest-rank 第 4 个值
- 本机浏览器、本机网络和 Clash：完全未参与
- 这些数据是 synthetic lab，不计入真实 RUM

DebugBear 设备配置与地域定义：

- <https://www.debugbear.com/docs/devices>
- <https://www.debugbear.com/docs/server-locations>

## 汇总

| 地域 / 设备 | n | LCP p50 / p75 | feed-ready p50 / p75 | TTFB p50 / p75 | TBT p50 / p75 | CLS p75 | 总传输 p50 | 请求数 p50 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 台湾 Mobile | 5 | 3.625s / 3.709s | 3.519s / 3.612s | 0.753s / 0.754s | 484ms / 725ms | 0.069 | 0.770 MB | 52 |
| 香港 Mobile | 5 | 3.119s / 3.765s | 3.059s / 3.703s | 0.699s / 0.798s | 285ms / 310ms | 0.069 | 0.717 MB | 50 |
| 台湾 Desktop | 5 | 2.940s / 3.020s | 2.101s / 2.301s | 0.224s / 0.236s | 246ms / 346ms | 0.033 | 7.958 MB | 109 |
| 香港 Desktop | 5 | 3.284s / 3.385s | 1.341s / 1.424s | 0.182s / 0.184s | 80ms / 96ms | 0.033 | 7.958 MB | 110 |

### 原始 LCP 值

| 地域 / 设备 | 5 次 LCP（ms，升序） |
|---|---|
| 台湾 Mobile | 3000, 3244, 3625, 3709, 3767 |
| 香港 Mobile | 2815, 2910, 3119, 3765, 4196 |
| 台湾 Desktop | 2602, 2871, 2940, 3020, 3201 |
| 香港 Desktop | 2424, 2803, 3284, 3385, 3386 |

## 关键发现

### 1. Mobile 的主要瓶颈仍是 SPA 渲染和主线程

台湾 Mobile 代表样本 `3509`：

- LCP：3.625s
- feed-ready：3.519s
- FCP：2.722s
- TBT：725ms
- TTFB：0.757s
- LCP element：首屏 tweet 文本
- LCP breakdown：
  - TTFB：0.758s
  - element render delay：2.868s
- 主线程：
  - script evaluation：1.175s
  - style/layout：0.551s
  - 总 CPU：3.267s

这说明香港链路或 HTML 文档 TTFB 不是这一样本的主要剩余时间；最大份额在客户端
React 执行、布局和文本出现之前的等待。它与继续验证 SSR waterfall 的方向一致。

代表结果：
<https://www.debugbear.com/project/104156/quickTest/EF0gcfTvtvSP3UVdPAPPmTkmZ/overview>

### 2. Desktop 仍有过量媒体竞争

台湾 Desktop 样本 `3519`：

- 总传输：7,830,440 B
- 图片：5,956,170 B
- 请求：109
- 最大单资源：
  - `https://api.ai-feeds.com/r/ph/35ac32f912e690496debcd7303a9ebb2fec98caeccbaf9f797d08fce3e44e326.gif`
  - 传输：4,276,378 B
  - 耗时：5.904s
  - 占该次完整页面传输约 54.6%

Mobile 默认只挂载当前频道，完整传输约 0.7–0.8 MB；Desktop 同时挂载多列后约
7.8–8.2 MB。虽然 Desktop LCP 暂时小于 3.5s，后台媒体会继续占用带宽、内存和布局
成本，并放大弱网长尾。

代表结果：
<https://www.debugbear.com/project/104156/quickTest/Yjf4NkTWz2KaZ64a0JmiXpDnC/overview>

### 3. 生产分页游标由服务端生成后被同一服务端拒绝

生产首屏响应：

```text
GET /api/items?source_type=x_list&limit=12
next_cursor = v2|0|2026-07-17 00:55:49|x_list:2077920104655016250
```

立即重放该 `next_cursor`：

```text
HTTP 400
{"error":"invalid_cursor"}
```

根因已经定位：

1. `worker/src/index.ts` 用 D1 原始 TEXT 排序值构造 `next_cursor`；
2. 当前 D1 数据可使用 SQLite 风格 `YYYY-MM-DD HH:mm:ss`；
3. 2026-07-13 加入的 `isCursorSortTime()` 只接受带 `T` 的 RFC3339；
4. 因此 Worker 返回的合法响应无法被同一版本 Worker 作为下一页输入消费。

DebugBear Mobile 的 10/10 样本均记录 3 个分页 400；Desktop 本轮没有触发这组自动
分页请求。该问题会阻断 classic 移动首页继续加载，并制造无效请求与错误遥测。

本轮只完成定位，没有修改或发布代码。

## 对发布门槛的影响

1. 20 个外部 synthetic 样本足以替代“发布前等待 100 个真实 RUM”的机械门槛，但不能
   冒充 RUM，也不能证明真实人群绝对体验。
2. 当前 classic 自身未通过移动 cold LCP `p75 <= 3.5s`，因此不能用本轮数据宣告性能
   已达标。
3. waterfall 应先部署 perf-staging，再在同一地域、设备和测试配置下与 classic 成对
   比较；当前 production 只有 classic，无法完成 A/B。
4. 建议新的放量规则：
   - external synthetic：每个核心地域/设备至少 5 次；波动超过 20% 时增加到 10 次；
   - waterfall 相对 classic 的 p75 LCP 不得劣化超过 10%；
   - CLS `<= 0.1`；
   - 0 个 5xx、0 个 hydration/fallback 错误；
   - 已知分页 400 和 4.28 MB GIF 在 canary 前关闭；
   - synthetic 通过后进入小流量 canary，真实 RUM 继续作为上线后确认，不阻塞 staging。

## 20 个结果

### 台湾 Mobile

- `3509` <https://www.debugbear.com/project/104156/quickTest/EF0gcfTvtvSP3UVdPAPPmTkmZ/overview>
- `3511` <https://www.debugbear.com/project/104156/quickTest/Ez5SWSotMMmXLWt5Z5yE4ttPm/overview>
- `3512` <https://www.debugbear.com/project/104156/quickTest/ZIJgshwoViu93hXAm5hJM3HqY/overview>
- `3513` <https://www.debugbear.com/project/104156/quickTest/KhJkIfPyfIR4JryeBRs2dClDn/overview>
- `3514` <https://www.debugbear.com/project/104156/quickTest/NpdbzTVPf9KYKsLzaE6FXVSOW/overview>

### 台湾 Desktop

- `3515` <https://www.debugbear.com/project/104156/quickTest/0g13KTxuNMgL3jEHDVUec4CNv/overview>
- `3516` <https://www.debugbear.com/project/104156/quickTest/rpsvgklaEJDJht0L63gmpH52u/overview>
- `3517` <https://www.debugbear.com/project/104156/quickTest/aeU7ltEugqJSZiEWj3SpZwD2Z/overview>
- `3518` <https://www.debugbear.com/project/104156/quickTest/kwtSr8DBujNzpVRyYuPktB3i1/overview>
- `3519` <https://www.debugbear.com/project/104156/quickTest/Yjf4NkTWz2KaZ64a0JmiXpDnC/overview>

### 香港 Mobile

- `3520` <https://www.debugbear.com/project/104156/quickTest/l4vHjDpD30KVakuCEJos7nATC/overview>
- `3521` <https://www.debugbear.com/project/104156/quickTest/rI9ZG1EJv9a65K2HEVHUTbbx1/overview>
- `3522` <https://www.debugbear.com/project/104156/quickTest/2T1gggjiAZerA8yt4hRCSz5c5/overview>
- `3523` <https://www.debugbear.com/project/104156/quickTest/ySJWTZ9E3Upny1sfi884afPUz/overview>
- `3524` <https://www.debugbear.com/project/104156/quickTest/kZhqqGsxkGrw1HTOwzDhGthho/overview>

### 香港 Desktop

- `3525` <https://www.debugbear.com/project/104156/quickTest/lVgvOoUCL2FKpQv5u7EhCAWTL/overview>
- `3526` <https://www.debugbear.com/project/104156/quickTest/JLQSQIOebPcWHjgAjZMYPbN0m/overview>
- `3527` <https://www.debugbear.com/project/104156/quickTest/rPEUUxHSyiSCBil882uEVOrX0/overview>
- `3528` <https://www.debugbear.com/project/104156/quickTest/Rzy5CvvkHATAKAjI28jVx06TU/overview>
- `3529` <https://www.debugbear.com/project/104156/quickTest/AWINGnNJwUotNH1rzraVFTbiP/overview>
