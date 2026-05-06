# [归档] 自动化 Chrome 工作流统一规范

> **状态**：2026-05-06 归档。
> **原因**：本地 chrome 自动化抓取（list / longform / quote 等）已被 ScrapeBadger API 全面替代，
> 三个 launchd job（`com.xlist-scraper.cron` / `.tune` / `.longform`）均已 unload。
> 这套规范是历史踩坑总结，留档备查；**默认不加载到 CLAUDE.md** 避免新 session 误以为还在跑。
>
> **何时恢复 / 重看**：
> - 接入新数据源（YouTube / Podcast / arXiv 等）需要本地 chrome 抓取时
> - ScrapeBadger 出问题需要回滚到本地 chrome 流程时
> - 任何项目里写 osascript / launchd / browser-use 自动化时，先看这里规避反复踩的坑
>
> **配套要恢复的代码 / 文件**（unload 的 plist 还在）：
> - `~/Library/LaunchAgents/com.xlist-scraper.cron.plist`
> - `~/Library/LaunchAgents/com.xlist-scraper.tune.plist`
> - `~/Library/LaunchAgents/com.xlist-scraper.longform.plist`
> - `~/.claude/skills/xlist-scraper/scripts/list_scraper.py` 里的 `_snapshot_frontmost` / `_push_chrome_to_back` / `_kill_chrome_by_data_dir`

---

## ⚠️ 自动化 Chrome 工作流统一规范（强制，跨 session 适用）

> 适用范围：**所有由本项目自动打开 Chrome 的 pipeline**——抓取（list_scraper）、长文补全（enrich_longform）、热度数据补全（refresh-metrics）、quote/link_card 补全、reply 补全、thread 补全、未来任何新加的浏览器侧补全任务。
>
> 核心原则：**自动化 Chrome 必须不影响用户正常办公**。窗口可以可见，但不能抢焦点；进程可以驻留，但绝不能 cron 跑完后泄漏 PPID=1 的孤儿。

### 1. 不抢用户焦点（焦点恢复模式）

- launch Chrome 之前，调用 `_snapshot_frontmost()` 抓取用户当前 frontmost 进程名（用 `osascript` + System Events）
- launch Chrome 之后立刻调用 `_push_chrome_to_back(prev_frontmost)`，把焦点还给用户原本在用的 app
- 每次 `bu open <url>` 之后也要再 push 一次（macOS Chrome 每次导航都可能 re-activate）
- 视觉效果：Chrome 是开着的、可见的，但被用户的窗口盖住，document.visibilityState 仍是 `visible`，JS 不被 throttle

### 2. ❌ 禁用 `set visible to false` / `osascript ... set visible to false`

- 历史教训：曾经用「set visible to false」把 Chrome 隐藏，后果：
  - Chrome 的 `document.visibilityState` 翻成 `hidden` → X 把 setTimeout/rAF 限频到 1Hz → JS eval 拿不到 tweet → 抓取卡死
  - `bu close --all` 在 hidden 状态下不可靠 → daemon 退出后 Chrome 子进程被 reparent 到 launchd（PPID=1）→ 跨 cron 周期累积成几十个 Chrome 孤儿，用户手动关不掉
- 正确做法：**用 push-to-back（焦点恢复）替代 hide**。Chrome 必须保持 visible，只是 z-bottom

### 3. ⚠️ 焦点恢复必须用 `open -a` 或 `tell app to activate`，**禁用** `set frontmost of process`

- 历史教训：最初用 `tell application "System Events" to set frontmost of process "X" to true`，结果 osascript 返回 rc=0 但 z-order 根本没变——Chrome 仍盖在前台干扰用户
- 根因：System Events 的 `set frontmost = true` 在 macOS 上**只翻一个内部 frontmost 标记位**，对 Electron / 跨平台 app（WeChat、VS Code、Slack、QQ 等）**根本不会真正抬起窗口**。看似成功，实则无效
- 正确做法（按可靠性优先）：
  1. **首选**：`open -a "<AppName>"`（走 NSWorkspace.launchApplication，对所有 app 类型都可靠抬窗）
  2. **兜底**：`osascript -e 'tell application "<AppName>" to activate'`（标准 Apple Event）
  3. **额外兜底**：在 push 之前先 `_snapshot_frontmost()` 看一眼，如果当前 frontmost 已经不是 Chrome（用户已自己切走），就跳过这次 push，避免抢用户当前 app 的焦点
- **不要**写"先 set frontmost、不行再降级"这种链路，第一招就用 `open -a`

### 4. 兜底关闭（kill-by-data-dir）

- 每个 pipeline 必须在 `finally` 块里：先 `bu close --all`，再 `_kill_chrome_by_data_dir(session_data_dir)`
- 为什么：browser-use daemon 的 Chrome 子进程在 setsid 后属于不同的进程组，SIGKILL daemon **不会**传染到 Chrome；只有按 `--user-data-dir=<temp_dir>` pgrep 命中才能精准杀掉本次 run 的 Chrome
- 写法：snapshot 启动前的 browser-use Chrome PID 集合 → 启动后跑业务 → 退出时 pgrep 命中 data-dir → SIGTERM → 等 2s → 残留 SIGKILL

### 5. launchd wrapper 兜底（多层防护）

- `cron.sh` / `longform-cron.sh` 等 launchd 拉起的 wrapper 必须有 PRE/POST PID diff 兜底，防止 Python 异常退出绕过 finally
- 不能只检测 PPID=1（browser-use daemon 主动 setsid，PPID=1 是正常态，不是孤儿信号）
- 必须用「本次 run 启动前 vs 退出时的 PID 集合 diff」识别真正的泄漏

### 实现模板

参考 `scripts/list_scraper.py` 中的 `_snapshot_frontmost`、`_push_chrome_to_back`、`_find_session_data_dir`、`_kill_chrome_by_data_dir`，以及 `scrape_list()` 的 `prev_frontmost` 串联方式。新写的 pipeline 直接 import / 抄过去，不要重新发明轮子，更不要走回 hide 那条路，也不要把 push 实现成 `set frontmost`。

### 验收标准

- 自动化任务跑起来时，用户能看到 Chrome 弹出又退到后面，全程不打扰前台 app（VS Code / 浏览器 / 终端 / WeChat 等）
- `tail -f data/cron.log data/longform-cron.log` 能看到 `[focus] restored frontmost: <AppName>`，且**用户实际感知到** Chrome 退到了后面（rc=0 不等于成功，必须用眼睛验证 z-order）
- 任务结束后 `pgrep -f browser-use-user-data-dir-` 返回空
- launchd 跑了 N 个周期之后，`pgrep -f browser-use-user-data-dir- | wc -l` 仍然是 0
