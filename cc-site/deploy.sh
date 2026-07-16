#!/usr/bin/env bash
# Deploy cc-site/ static site to ai-feeds.cc (82.156.0.68:/www/wwwroot/ai-feeds.cc/).
# Requires ~/.ssh/aifeeds_temp private key.
#
# 只部署静态站（5 页 + 公安图标）。微信登录中转服务（server/）单独用
# server/deploy-to-cc.sh 部署（装 Node + systemd + secret，落点 /opt/aifeeds-cc-relay）。

set -euo pipefail

KEY="$HOME/.ssh/aifeeds_temp"
HOST="lighthouse@82.156.0.68"
REMOTE_ROOT="/www/wwwroot/ai-feeds.cc"
STAGING="/tmp/cc-site-staging"

if [[ ! -f "$KEY" ]]; then
  echo "ERROR: SSH key not found at $KEY" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "▶ scp cc-site/ → $HOST:$STAGING/"
ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST" "rm -rf $STAGING && mkdir -p $STAGING/assets $STAGING/cc-prompts"
scp -i "$KEY" -o StrictHostKeyChecking=accept-new \
  index.html privacy.html terms.html contact.html style.css sitemap.xml robots.txt \
  "$HOST:$STAGING/"
scp -i "$KEY" -o StrictHostKeyChecking=accept-new \
  assets/gongan-icon.png \
  "$HOST:$STAGING/assets/"
scp -i "$KEY" -o StrictHostKeyChecking=accept-new \
  cc-prompts/index.html \
  "$HOST:$STAGING/cc-prompts/"

echo "▶ sudo cp → $REMOTE_ROOT/"
ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST" "
  sudo mkdir -p $REMOTE_ROOT/assets $REMOTE_ROOT/cc-prompts
  sudo cp $STAGING/index.html $STAGING/privacy.html $STAGING/terms.html $STAGING/contact.html $STAGING/style.css $STAGING/sitemap.xml $STAGING/robots.txt $REMOTE_ROOT/
  sudo cp $STAGING/assets/gongan-icon.png $REMOTE_ROOT/assets/
  sudo cp $STAGING/cc-prompts/index.html $REMOTE_ROOT/cc-prompts/
  sudo chown www:www \
    $REMOTE_ROOT/index.html $REMOTE_ROOT/privacy.html $REMOTE_ROOT/terms.html $REMOTE_ROOT/contact.html \
    $REMOTE_ROOT/style.css $REMOTE_ROOT/sitemap.xml $REMOTE_ROOT/robots.txt \
    $REMOTE_ROOT/assets/gongan-icon.png $REMOTE_ROOT/cc-prompts $REMOTE_ROOT/cc-prompts/index.html
  sudo chmod 644 \
    $REMOTE_ROOT/index.html $REMOTE_ROOT/privacy.html $REMOTE_ROOT/terms.html $REMOTE_ROOT/contact.html \
    $REMOTE_ROOT/style.css $REMOTE_ROOT/sitemap.xml $REMOTE_ROOT/robots.txt \
    $REMOTE_ROOT/assets/gongan-icon.png $REMOTE_ROOT/cc-prompts/index.html
  sudo chmod 755 $REMOTE_ROOT/cc-prompts
  rm -rf $STAGING
"

echo "▶ smoke test"
SCHEME=https
curl -skI --max-time 5 https://ai-feeds.cc/ >/dev/null 2>&1 || SCHEME=http
for path in / /privacy.html /terms.html /contact.html /assets/gongan-icon.png /style.css /cc-prompts/ /sitemap.xml /robots.txt; do
  code=$(curl -sk -o /dev/null -w '%{http_code}' "$SCHEME://ai-feeds.cc$path")
  echo "  $SCHEME://ai-feeds.cc$path → $code"
done

echo "✓ static deploy done. Open https://ai-feeds.cc to verify."
