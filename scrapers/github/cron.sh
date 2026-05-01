#!/bin/bash
# GitHub trending AI scraper cron entry.
# Triggered by ~/Library/LaunchAgents/com.aifeeds.github-scraper.plist
# at BJT 01:00 + 13:00 each day.

set -euo pipefail

# Resolve to ai-feeds repo root (this script lives in scrapers/github/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

LOG_DIR="$PROJECT_ROOT/data/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/github-cron-$(date +%Y%m%d).log"

PYTHON="${HOME}/.browser-use-env/bin/python3"

cd "$PROJECT_ROOT"

{
  echo "=== $(date -Iseconds) | github cron tick ==="
  "$PYTHON" -m scrapers.github.scraper
  echo "=== $(date -Iseconds) | done ==="
} >> "$LOG_FILE" 2>&1
