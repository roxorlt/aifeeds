#!/bin/bash
# Product Hunt scraper cron entry.
# Triggered by ~/Library/LaunchAgents/com.aifeeds.ph-scraper.plist
# 时区 America/Los_Angeles，每天 PT 0:30 触发（即 BJT 16:30 PDT / 17:30 PST，
# 自动跟随夏令时切换）。
#
# 流程（scrapers.ph.scraper 默认行为）：
#   1. 拉昨天 PT 日期的 leaderboard
#   2. 单 session loop 抓 30+ 个 product 页（detail + comments + reviews）
#   3. LLM judge + 翻译（is_ai=1 才翻）
#   4. push 到 D1 via /api/ingest

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

LOG_DIR="$PROJECT_ROOT/data/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/ph-cron-$(date +%Y%m%d).log"

PYTHON="${HOME}/.browser-use-env/bin/python3"

cd "$PROJECT_ROOT"

# PRE: snapshot browser-use Chrome PIDs（CLAUDE.md 自动化 Chrome 规范 §5
# launchd wrapper 兜底）。退出时 diff，清残留。
PRE_PIDS=$(pgrep -f "browser-use-user-data-dir" 2>/dev/null || true)

{
  echo "=== $(date -Iseconds) | ph cron tick ==="
  echo "PRE chrome pids: $PRE_PIDS"
  "$PYTHON" -m scrapers.ph.scraper --push
  RC=$?
  echo "=== $(date -Iseconds) | done (rc=$RC) ==="
} >> "$LOG_FILE" 2>&1

# POST: PID diff 兜底清残留 Chrome
POST_PIDS=$(pgrep -f "browser-use-user-data-dir" 2>/dev/null || true)
LEAKED=""
for pid in $POST_PIDS; do
  if ! echo "$PRE_PIDS" | grep -qw "$pid"; then
    LEAKED="$LEAKED $pid"
  fi
done
if [ -n "$LEAKED" ]; then
  echo "[$(date -Iseconds)] orphans detected after ph cron: $LEAKED, killing..." >> "$LOG_FILE"
  kill $LEAKED 2>/dev/null || true
  sleep 2
  kill -9 $LEAKED 2>/dev/null || true
fi
