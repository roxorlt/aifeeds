#!/bin/bash
# 把 .secrets/ 里的 CF token 上传到 GitHub Actions secrets，让 workflow 能部署
# 一次性跑：./scripts/setup-github-secrets.sh
# 跑完后 push main / staging 会自动触发对应环境的部署

set -e
cd "$(dirname "$0")/.."

# 读本地 token
source .secrets/aifeeds-prod.env
source .secrets/aifeeds-prod.env

# gh cli 用 GITHUB_TOKEN env 自动认证
echo "── 设 CLOUDFLARE_API_TOKEN ──"
gh secret set CLOUDFLARE_API_TOKEN --body "$CLOUDFLARE_API_TOKEN" --repo roxorlt/aifeeds

echo "── 设 CLOUDFLARE_ACCOUNT_ID ──"
gh secret set CLOUDFLARE_ACCOUNT_ID --body "$CLOUDFLARE_ACCOUNT_ID" --repo roxorlt/aifeeds

echo
echo "── 验证 ──"
gh secret list --repo roxorlt/aifeeds

echo
echo "✓ Secrets 已设。下次 push 到 main 或 staging 分支：worker 自动部署 / dashboard 自动构建+部署"
