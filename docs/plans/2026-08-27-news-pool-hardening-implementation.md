# 行业要闻候选池加固实施计划

> 实现者必须使用 TDD；每项先写红测并确认按预期失败，再写最小实现。

## Task 1：跨天事件去重红测与修复

文件：

- `worker/src/digest/selection.test.ts`
- `worker/src/digest/selection.ts`

步骤：

1. 加入真实 GLM-5.3/PhanRouter 历史条目（无指纹）与 GLM-5.3 Flash 新条目（高置信指纹）测试，确认旧逻辑删除新条目。
2. 加入同一 GLM-5.3 Flash 媒体复述对照测试，确保修复不会放走明确重复。
3. 实现单边高置信指纹的具体对象兼容守卫。
4. 运行 selection focused tests。

## Task 2：官方来源与 radar 隔离

文件：

- `worker/src/feeds/types.ts`
- `worker/src/feeds/registry.ts`
- `worker/src/feeds/page-index.ts`
- 必要的新官方模型发现模块及测试
- `worker/src/blog.ts`
- `worker/src/digest/selection.ts`
- 对应测试文件

步骤：

1. 用 fixture 红测 Anthropic 官方 sitemap 文章过滤。
2. 用 fixture 红测 `zai-org` 官方模型列表首次发现与更新时间不重复语义。
3. 将来源的 `editorial_type` 写入 item extra。
4. 用 D1/选择测试证明 radar 不能进入正式候选。
5. 实现最小来源发现逻辑，不在测试中访问网络。

## Task 3：blog/podcast 自动自愈

文件：

- `worker/src/blog.ts`
- `worker/src/podcast.ts`
- `worker/src/feeds/dedup.ts`
- `worker/src/ops/cron-routing.ts`
- `worker/src/index.ts`
- `worker/src/ops/cron-schedule.ts`
- 对应测试文件

步骤：

1. 红测 binding/create 失败写 pending 与错误元数据。
2. 红测 30 分钟延迟、6 次上限、成功后清理、同小时幂等。
3. 为 blog/podcast 增加独立自愈 cron actions 和可观测返回值。
4. 对 exhausted 告警增加日级去重，避免重复推送。
5. 终态 helper 清理 pending 与错误。

## Task 4：综合验证与交付

1. 运行 focused tests。
2. 运行受影响模块 tests、`tsc --noEmit` 和 worker 全量 tests。
3. 检查 diff、敏感信息与未跟踪文件。
4. 独立 reviewer 做 spec compliance 和代码质量 sweep，按稳定 finding ledger 闭环。
5. 提交、推送 PR，等待 required CI；全部通过后合并 main 并验证 production deploy。
6. 在生产只读确认官方源/cron 路由生效，重建 2026-08-27 候选池，验证 GLM-5.3 Flash 可进入候选；Fable 5.1 仍以未确认状态处理。
