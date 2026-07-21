# 分批预生产与 08:00 最终组装实施计划

**目标：** 将每日视频从“08:00 收到全量后串行生成”改为“06:30/07:50/08:00 分批固化和预生产，08:00 以后按最终清单一次性组装”，同时移除新闻女声音频，并用确定性的内容绑定和 PCM 采样点时间轴消除音画漂移。

**涉及系统：**

- Cloudflare：`/Users/roxor/brain/30-projects/aifeeds`
- HK VPS 渲染服务：`/Users/roxor/Documents/dailyVideo`
- 生产服务：`/opt/dailyVideo`，`aifeeds-x-card.service`

## 一、固定业务规则

1. 北京时间 06:30 固化 `ph`、`gh`，使用当天 `YYYY-MM-DD-08` 的 `digest_pool` 槽位；后续 08:00 不重算这两个源。
2. 北京时间 07:50 固化 `news`、`x`；`news` 已包含图文新闻和播客，`x` 与其一起进入 editorial 预生产批次，但保留稳定原始 source 与 item_id。
3. 北京时间 08:00 固化 `hf-paper`，生成标题摘要，并发送 final manifest。订阅邮件、SEO 日报页仍只在 08:00 的正式节点产生。
4. HK 在前三批只写 stage store 并生成批次私有资产，不更新 `share/latest`，不发邮件，不发布 SEO。
5. final manifest 是栏目、条目、卡片与口播顺序的唯一事实源。缺批次、hash 不符、revision 落后时不得进入最终组装。
6. 男声按栏目生成：`opening`、`news`、`x`、`ph`、`gh`、`hf-paper`、`closing`。空栏目不生成；opening/closing 可在 final 阶段生成或复用。
7. 各栏目 MiniMax 返回的字幕时间戳保持局部坐标。最终音频先统一解码为 48kHz 双声道 PCM，以样本数累计偏移，栏目间插入 250ms 静音，最后只编码一次 AAC。
8. 字幕偏移来自 PCM 样本数，不使用 MP3 容器 duration，也不使用上一条字幕结束时间推算。
9. 删除新闻女声音频的新生成逻辑、manifest 字段、进度计数、发布复制和工作台模块；历史文件不主动删除，但页面不再展示。

## 二、跨端 payload v2

每次推送包含：

```json
{
  "protocol_version": 2,
  "date": "2026-07-21",
  "density": "normal",
  "batch_id": "daily-2026-07-21-normal",
  "stage": "foundation|editorial|papers|finalize",
  "revision": 1,
  "content_hash": "sha256:...",
  "render_key": "daily-2026-07-21-normal-<stage>-r1-<hash8>",
  "expected_stages": ["foundation", "editorial", "papers"],
  "digest": { "meta": {}, "sections": { "normal": [] } },
  "final_manifest": null
}
```

`finalize` 必须附带：

- `stage_revisions`：每批期望 revision 与 content_hash；
- `section_order`：最终栏目顺序；
- `items`：逐条 `segment_id/item_id/source/card_index/stage/revision`；
- `manifest_hash`：上述稳定字段的 SHA-256。

兼容规则：未带 `protocol_version` 的旧 payload 继续走原有全量任务；v2 payload 进入 staged 状态机。相同 stage/revision/hash 重复发送返回幂等成功；相同或更低 revision 但 hash 冲突返回 409；更高 revision 替换该批及其派生资产，并令旧 final 失效。

## 三、Cloudflare 任务

### Task CF-1：契约与构造器（TDD）

修改 `worker/src/digest/codex-push.ts`，新增 stage 类型、稳定 hash、分批 payload 与 final manifest 构造器；保留旧手动全量构造器用于回滚。

测试覆盖：source 集合、稳定 item 顺序、segment/card 编号、hash 稳定性、空批次拒绝、final 对三批 revision/hash 的引用。

### Task CF-2：分批快照锁定（TDD）

在 `worker/src/digest/pool-rebuild.ts` 增加按 source 列表重建能力。06:30 写 PH/GH；07:50 写 news/X；08:00 只写 hf-paper 和 subject。08:00 的订阅 deliver 直接消费同一 `-08` 池，不重写早批。

测试覆盖：08:00 不调用 PH/GH/news/X 选择器；重跑同一批可提升 revision 但相同内容 hash 保持幂等；跨天 key 隔离。

### Task CF-3：调度与恢复（TDD）

在现有 `*/5` scheduled handler 上增加 UTC 22:30（BJT 06:30）、23:50（BJT 07:50）、00:00（BJT 08:00）入口。使用日期+stage 的 Workflow instance id。失败通过 Workflow retry 和 PushDeer 告警；08:00 final 缺前批时主动补建缺批，不静默跳过。

保留手动 admin mode，可按日期/stage 重放，供 staging 与生产恢复。

### Task CF-4：配置与运维

补 Env 类型、staging/prod 配置说明和 `docs/operations.md` SOP；staging 只能推测试 endpoint，生产 endpoint 继续使用 Bearer token。

## 四、HK VPS 任务

### Task HK-1：staged ingest 与状态存储（TDD）

在 `workflows/aifeeds-x-card/server.mjs` 增加 v2 校验和按 `date/stage/revision` 的原子化落盘。状态机：`received → queued → preproducing → ready`，失败进入 `retry_wait`，达到现有重试上限后显示 `failed` 并告警，但保留可手动重放能力。

finalize 只有在三批 ready 且 hash 匹配时才能排队；乱序到达时保持 `waiting_for_stages`，后续批次完成后自动唤醒。

### Task HK-2：分批海报与男声资产（TDD）

重构 `run.mjs` 为可调用阶段：

- `preproduce-stage`：只处理本批条目，生成批次私有卡片、结构化栏目逐字稿、MiniMax 音频和局部字幕；
- `finalize-day`：按 final manifest 组合三批资产、生成总封面/横版封面/分享文案、最终视频和发布文件。

每个派生文件旁保存 `asset-manifest.json`，记录 input hash、模型、voice、speed、item IDs 和完成时间。hash 未变时复用，变更时只重做受影响批次。

### Task HK-3：确定性口播绑定和 PCM 时间轴（TDD）

在 `daily-media.mjs`：

- DeepSeek 输入、输出按栏目拆分，每个 item 仍有稳定 segment_id；
- MiniMax 每栏目独立调用并保存局部时间戳；
- FFmpeg 解码为 48kHz stereo PCM，按真实 sample count 计算每栏起点；
- 250ms 静音也按固定 12,000 samples 计入；
- 合并字幕时把局部毫秒换算为 sample 后加 offset，再转换为最终毫秒；
- 最终 PCM 只编码一次 AAC，画面 timeline 直接消费 segment/card 绑定，不再根据句子文本猜归属。

质量门控：segment/item/card 一一对应；字幕单调、不重叠、不越栏目；最后 cue、音频、视频时长误差不超过 100ms；固定结尾完整；任何失败不发布 latest。

### Task HK-4：移除女声音频（TDD）

删除 `synthesizeNewsItemAudios` 调用和 manifest/余额累计；删除 `run.mjs` 的复制发布、工作台 HTML/JS、进度 `news_audio_count` 与测试预期。固定结尾仍由男声总口播生成，不受影响。

### Task HK-5：工作台进度（TDD）

当天即使尚未 finalize，也展示 foundation/editorial/papers/finalize 四行状态、revision、更新时间、资产数、失败原因和下次重试时间。06:30 后即可看到当天任务，不再继续显示“昨天已完成”作为唯一状态。

## 五、联调与验收

1. 两端 JSON fixture 契约测试：CF 产物必须被 HK parser 接受；篡改 hash/revision/item order 必须被拒绝。
2. 故障注入：重复推送、乱序、07:50 修订、服务重启、MiniMax 暂时超时、final 先到、单批缺失。
3. 运行完整单测和静态检查；不得只运行新增测试。
4. staging 按指定日期执行 06:30 → 07:50 → 08:00 三批重放，检查状态与资产复用。
5. 用当日生产素材重放；抽检每个栏目首尾和至少两条中间内容，验证口播、字幕、卡片一致。
6. 检查最终 AAC/MP4/VTT/SRT duration，检查 `/aifeeds/latest/` 下载、视频播放、工作台阶段状态、Video SEO 发布不回归。
7. CF 分支合并 `main` 后从 `main` 部署生产；HK 分支合并本地 `main` 后同步到 `/opt/dailyVideo`，重启服务并做健康检查。

## 六、回滚

- CF 关闭 staged 开关后恢复旧 08:00 全量 push；旧 `daily-codex-push` 手动模式保留。
- HK v1 payload 兼容路径保留；上线异常时可切回上一版 server/run/daily-media，并重启服务。
- staged 资产在日期私有目录中，不覆盖成功的历史日；只有 final 质量门控通过后才原子切换 `latest`。

