# cc2im 定时任务可观测性问题

## Bad Case 描述

xlist-scraper 通过 cc2im 的 cron 功能每 30 分钟触发一次抓取任务（`scrapeList`）。

**现象**：用户肉眼看到 Chrome 被打开了（说明 cron 触发成功、Claude session 接收到了消息、scraper 开始执行），但 DB 里没有新数据入库，Obsidian notes 也没有增长。持续了好几个小时。

**问题**：无法定位原因。因为：
1. cc2im 的 cron 日志只记录了"delivered"，不记录任务的执行结果（成功/失败/stderr）
2. Claude Code session 执行 scraper 时如果中途报错，错误信息留在 Claude 对话上下文中，不会持久化到任何地方
3. scraper 如果在启动阶段就崩溃（比如 import error、browser-use 进程冲突、Chrome 扩展弹窗导致 JS eval 超时），还没走到 `export_run_summary` 就退出了，所以 Obsidian notes 里也没有错误记录

## 期望的改进

### cc2im 侧需要做的

1. **记录任务执行结果**：cron 触发的任务，在 Claude session 执行完成后，cc2im 应该能拿到：
   - exit code（0 成功 / 非 0 失败）
   - stdout/stderr 的最后 N 行（比如最后 20 行）
   - 执行耗时

2. **持久化 cron 执行日志**：每次 cron 触发的结果写入 cc2im 自己的 DB 或日志文件，包括：
   - 触发时间
   - 目标 agent
   - 状态（delivered / executed / success / error）
   - 错误摘要（如有）

3. **失败通知**：连续 N 次失败时，推送一条微信消息给用户告警，而不是默默失败

### scraper 侧已做的（参考）

scraper 自己已经在 `main.py` 的 pipeline 中加了 `export_run_summary`，每次成功执行会写一个 `_run-summary-*.md` 文件。但如果在到达这一步之前就崩溃，就没有任何输出。

scraper 侧后续会加 try/except 全局兜底，确保任何异常都写一个 error summary 文件。但 cc2im 侧的可观测性是独立问题，需要 cc2im 自己解决。

## 复现方式

1. cc2im cron 正常运行（`scrapeList every 30min`）
2. 制造一个 scraper 启动错误（比如临时改坏 config.py 的 import）
3. 等待下一次 cron 触发
4. 观察：cc2im 显示 delivered，但用户无从知道任务失败了
