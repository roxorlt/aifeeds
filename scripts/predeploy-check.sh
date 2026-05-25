#!/usr/bin/env bash
# Pre-deploy check: ensure local HEAD includes origin/main HEAD before deploy.
#
# 背景: Cloudflare deploy 是整包替换,从落后 origin/main 的 branch deploy
# 会回退 main 上对方已 deploy 的改动(2026-05-19 海报模板事故的根因)。
#
# 这个脚本接到 npm script 的 `predeploy` lifecycle,在 `npm run deploy`
# 自动跑。check 失败 fail-fast,deploy 不会触发。
#
# 用法:
#   bash scripts/predeploy-check.sh
#   (或通过 npm: 加 "predeploy": "bash ../scripts/predeploy-check.sh")
#
# 退出码:
#   0 = 安全,可以 deploy
#   1 = 本地 HEAD 落后 origin/main,需要 git pull --rebase
#   2 = git fetch 失败(网络问题)
#   3 = 不在 git repo 或其他错误

set -euo pipefail

# 颜色
RED='\033[31m'
GREEN='\033[32m'
YELLOW='\033[33m'
RESET='\033[0m'

# 找到 git repo root (从 cwd 往上找 .git)
if ! REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null); then
  echo -e "${RED}[predeploy-check] Not in a git repository${RESET}" >&2
  exit 3
fi
cd "$REPO_ROOT"

BRANCH=$(git rev-parse --abbrev-ref HEAD)
HEAD=$(git rev-parse --short HEAD)

echo -e "${YELLOW}[predeploy-check]${RESET} branch=$BRANCH HEAD=$HEAD"

# Fetch origin/main (静默)
if ! git fetch origin main --quiet 2>/dev/null; then
  echo -e "${RED}[predeploy-check] git fetch origin main failed (网络? auth?)${RESET}" >&2
  echo -e "${YELLOW}如果离线确认本地 main 是最新,可跳过 check: SKIP_PREDEPLOY_CHECK=1 npm run deploy${RESET}" >&2
  exit 2
fi

ORIGIN_MAIN=$(git rev-parse --short origin/main)
echo -e "${YELLOW}[predeploy-check]${RESET} origin/main=$ORIGIN_MAIN"

# 核心 check: HEAD 必须包含 origin/main HEAD(即 origin/main is ancestor of HEAD)
if git merge-base --is-ancestor origin/main HEAD; then
  echo -e "${GREEN}[predeploy-check] ✓ HEAD ($HEAD) 包含 origin/main ($ORIGIN_MAIN),可以 deploy${RESET}"
  exit 0
fi

# 失败:HEAD 落后 origin/main,列出缺失的 commits
BEHIND_COUNT=$(git rev-list --count HEAD..origin/main)
echo "" >&2
echo -e "${RED}[predeploy-check] ✗ 本地 HEAD ($HEAD) 落后 origin/main ($ORIGIN_MAIN) $BEHIND_COUNT commits${RESET}" >&2
echo -e "${RED}    deploy 会把 origin/main 上对方的 $BEHIND_COUNT 个 commit rollback!${RESET}" >&2
echo "" >&2
echo -e "${YELLOW}缺失的 commits (origin/main 有但本地没):${RESET}" >&2
git log --oneline -10 HEAD..origin/main >&2 || true
echo "" >&2
echo -e "${YELLOW}修复:${RESET}" >&2
echo "  git pull --rebase origin main      # 把对方 commits rebase 到当前 branch" >&2
echo "  # 解决 conflict 后重跑 deploy" >&2
echo "" >&2
echo -e "${YELLOW}应急逃生 (确认知道在做什么):${RESET}" >&2
echo "  SKIP_PREDEPLOY_CHECK=1 npm run deploy   # 完全跳过 check" >&2
echo "" >&2

# 检查 escape hatch
if [ "${SKIP_PREDEPLOY_CHECK:-0}" = "1" ]; then
  echo -e "${YELLOW}[predeploy-check] SKIP_PREDEPLOY_CHECK=1 设置,跳过 check${RESET}" >&2
  exit 0
fi

exit 1
