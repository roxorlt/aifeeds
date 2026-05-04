"""共享 helpers for browser-use based scrapers (PH / 未来 YouTube 等).

实现 CLAUDE.md「自动化 Chrome 工作流统一规范」的 5 条强制约定：

  1. focus 不抢用户：launch Chrome 前 snapshot frontmost，launch 后立刻 push back
  2. 禁用 `set visible to false`（hide 引发 JS throttle + 关闭不可靠 + 孤儿堆积）
  3. focus 恢复用 `open -a`（NSWorkspace），fallback 用 `tell app to activate`
  4. 兜底关闭按 `--user-data-dir` pgrep 杀（kill-by-data-dir）
  5. launchd wrapper 用 PRE/POST PID diff 兜底（在 cron.sh 实现，不在这里）

参考：~/.claude/skills/xlist-scraper/scripts/list_scraper.py 的对应方法
（X scraper 已稳定跑数月）
"""
from __future__ import annotations

import logging
import subprocess
import tempfile
import time
from pathlib import Path

log = logging.getLogger(__name__)


def find_session_data_dir() -> str | None:
    """browser-use 启动后会在 /tmp 下建 `browser-use-user-data-dir-*` 临时目录。
    返回最新一个（即本次 session 的），用于后续按目录精准杀进程。"""
    tmp = Path(tempfile.gettempdir())
    dirs = sorted(
        tmp.glob("browser-use-user-data-dir-*"),
        key=lambda d: d.stat().st_mtime,
        reverse=True,
    )
    return str(dirs[0]) if dirs else None


def kill_chrome_by_data_dir(data_dir: str | None) -> None:
    """SIGTERM Chrome 进程组里 cmdline 含 `data_dir` 的，2s 后残留 SIGKILL。

    `data_dir=None` 时退化为按 `browser-use-user-data-dir` 通配杀（不推荐 —
    可能误杀其他并行 session 的 Chrome）。
    """
    if not data_dir:
        log.warning("No session data dir tracked, killing all browser-use Chrome (may affect other sessions)")
        pattern = "browser-use-user-data-dir"
    else:
        pattern = data_dir
    try:
        result = subprocess.run(
            ["pgrep", "-f", pattern],
            capture_output=True, text=True, timeout=5,
        )
        pids = [p for p in result.stdout.strip().split() if p]
        if not pids:
            return
        log.warning("Found %d lingering Chrome process(es) for session %s, sending SIGTERM",
                    len(pids), data_dir or "(all)")
        subprocess.run(["kill"] + pids, timeout=5)
        time.sleep(2)
        # 再扫一次，残留 -9
        result2 = subprocess.run(
            ["pgrep", "-f", pattern],
            capture_output=True, text=True, timeout=5,
        )
        remaining = [p for p in result2.stdout.strip().split() if p]
        if remaining:
            log.warning("SIGTERM 没清干净，force kill %d 个", len(remaining))
            subprocess.run(["kill", "-9"] + remaining, timeout=5)
    except Exception as exc:
        log.warning("kill_chrome_by_data_dir failed: %s", exc)


def snapshot_frontmost() -> str | None:
    """记下 launch Chrome 之前用户 frontmost 的 app 名字，
    用于稍后 push_chrome_to_back 时还焦点。

    必须在 launch Chrome **之前**调用，否则 frontmost 已经是 Chrome。
    """
    try:
        proc = subprocess.run(
            ["osascript", "-e",
             'tell application "System Events" to get name of first application process whose frontmost is true'],
            capture_output=True, text=True, timeout=3,
        )
        if proc.returncode == 0:
            name = proc.stdout.strip()
            return name or None
    except Exception as exc:
        log.warning("[focus] snapshot failed: %s", exc)
    return None


def push_chrome_to_back(prev_frontmost: str | None) -> None:
    """把焦点还给 prev_frontmost（用户 launch Chrome 之前在用的 app）。

    效果：Chrome 仍然 visible（不 hide，避免 JS throttle / `bu close` 不可靠），
    但 z-bottom，被用户窗口盖住。Chrome 继续干活，用户也继续干活，互不打扰。

    智能判定：如果当前 frontmost **不是 Chrome**（用户自己已经切走了），
    跳过 — 不要把 prev_frontmost 拉到当前用户用的 app 之上，那也是打扰。

    Activation 策略（按可靠性优先）：
      1. `open -a "<App>"`（NSWorkspace.launchApplication，所有 app 类型可靠抬窗）
      2. fallback `tell application "<App>" to activate`（标准 Apple Event）

    禁用 `set frontmost of process` —— 对 Electron / 跨平台 app（WeChat /
    VS Code / Slack 等）只翻 frontmost 标记，不真正抬窗。
    """
    if not prev_frontmost:
        return
    # prev_frontmost 是 Chrome 自己 → 跳过（push 自己回前台没意义，且会抢焦点）
    if "Chrome" in prev_frontmost or "Google" in prev_frontmost:
        log.debug("[focus] prev_frontmost is Chrome itself, skipping push-back")
        return
    # 用户自己切走了 → 跳过
    current = snapshot_frontmost()
    if current and "Chrome" not in current and "Google" not in current:
        return
    # 首选 open -a
    try:
        proc = subprocess.run(
            ["open", "-a", prev_frontmost],
            capture_output=True, text=True, timeout=3,
        )
        if proc.returncode == 0:
            log.info("[focus] restored frontmost: %s", prev_frontmost)
            return
    except Exception as exc:
        log.warning("[focus] open -a failed: %s", exc)
    # fallback: activate
    name = prev_frontmost.replace('"', '\\"')
    try:
        proc = subprocess.run(
            ["osascript", "-e", f'tell application "{name}" to activate'],
            capture_output=True, text=True, timeout=3,
        )
        if proc.returncode == 0:
            log.info("[focus] restored frontmost via activate: %s", prev_frontmost)
            return
        log.warning("[focus] activate rc=%d stderr=%s",
                    proc.returncode, proc.stderr.strip()[:200])
    except Exception as exc:
        log.warning("[focus] activate failed: %s", exc)
