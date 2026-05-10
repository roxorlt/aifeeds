#!/bin/bash
# 启用本仓的 git hook（gitleaks pre-commit 防泄密）
# 用法：./scripts/setup-git-hooks.sh
# 一次性跑，之后每次 commit 自动扫 staged

set -e
cd "$(dirname "$0")/.."

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit

if ! command -v gitleaks >/dev/null 2>&1; then
  echo "⚠️  gitleaks 没装，先 brew install gitleaks"
  exit 1
fi

echo "✓ git hooks 已启用（core.hooksPath=.githooks）"
echo "✓ pre-commit 已装：gitleaks 扫 staged 改动，泄密自动 reject"
echo ""
echo "测试：往任意文件加一行 'sk-test12345678901234567890' 然后 git add + commit，应被 reject"
