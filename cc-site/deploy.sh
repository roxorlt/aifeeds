#!/usr/bin/env bash
# Deploy cc-site/ to ai-feeds.cc (82.156.0.68:/www/wwwroot/ai-feeds.cc/).
# Requires ~/.ssh/aifeeds_temp private key.
#
# 用法：
#   ./deploy.sh           只部署静态站（5 页 + 图标，默认）
#   ./deploy.sh server    只部署微信登录中转服务（server/）+ pm2 reload
#   ./deploy.sh all       两者都部署
#
# ⚠️ server 模式只同步代码 + pm2 reload；首次部署（装 Node/pm2、/etc/aifeeds/relay.env、
#    nginx 配置、fail2ban）是手动一次性步骤，见 server/README.md。

set -euo pipefail

MODE="${1:-static}"   # static | server | all

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

deploy_static() {

echo "▶ scp cc-site/ → $HOST:$STAGING/"
ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST" "rm -rf $STAGING && mkdir -p $STAGING/assets"
scp -i "$KEY" -o StrictHostKeyChecking=accept-new \
  index.html privacy.html terms.html contact.html style.css \
  "$HOST:$STAGING/"
scp -i "$KEY" -o StrictHostKeyChecking=accept-new \
  assets/gongan-icon.png \
  "$HOST:$STAGING/assets/"

echo "▶ sudo cp → $REMOTE_ROOT/"
ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST" "
  sudo mkdir -p $REMOTE_ROOT/assets
  sudo cp $STAGING/index.html $STAGING/privacy.html $STAGING/terms.html $STAGING/contact.html $STAGING/style.css $REMOTE_ROOT/
  sudo cp $STAGING/assets/gongan-icon.png $REMOTE_ROOT/assets/
  sudo chown www:www \
    $REMOTE_ROOT/index.html $REMOTE_ROOT/privacy.html $REMOTE_ROOT/terms.html $REMOTE_ROOT/contact.html \
    $REMOTE_ROOT/style.css $REMOTE_ROOT/assets/gongan-icon.png
  sudo chmod 644 \
    $REMOTE_ROOT/index.html $REMOTE_ROOT/privacy.html $REMOTE_ROOT/terms.html $REMOTE_ROOT/contact.html \
    $REMOTE_ROOT/style.css $REMOTE_ROOT/assets/gongan-icon.png
  rm -rf $STAGING
"

  echo "▶ smoke test"
  # 先试 https，没配证书时 fallback 到 http
  SCHEME=https
  curl -skI --max-time 5 https://ai-feeds.cc/ >/dev/null 2>&1 || SCHEME=http
  for path in / /privacy.html /terms.html /contact.html /assets/gongan-icon.png /style.css; do
    code=$(curl -sk -o /dev/null -w '%{http_code}' "$SCHEME://ai-feeds.cc$path")
    echo "  $SCHEME://ai-feeds.cc$path → $code"
  done
  echo "✓ static deploy done."
}

deploy_server() {
  local SRV_STAGING="/tmp/cc-relay-staging"
  echo "▶ scp server/ → $HOST:$SRV_STAGING/"
  ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST" "rm -rf $SRV_STAGING && mkdir -p $SRV_STAGING/lib $SRV_STAGING/test"
  scp -i "$KEY" -o StrictHostKeyChecking=accept-new \
    server/relay.mjs server/package.json server/ecosystem.config.cjs \
    "$HOST:$SRV_STAGING/"
  scp -i "$KEY" -o StrictHostKeyChecking=accept-new \
    server/lib/config.mjs server/lib/crypto.mjs server/lib/wechat.mjs \
    "$HOST:$SRV_STAGING/lib/"
  scp -i "$KEY" -o StrictHostKeyChecking=accept-new \
    server/test/smoke.mjs \
    "$HOST:$SRV_STAGING/test/"

  echo "▶ sudo cp → $REMOTE_ROOT/server/ + pm2 reload"
  # 注意：不动 /etc/aifeeds/relay.env（secret，手动维护）。
  ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST" "
    sudo mkdir -p $REMOTE_ROOT/server/lib $REMOTE_ROOT/server/test
    sudo cp $SRV_STAGING/relay.mjs $SRV_STAGING/package.json $SRV_STAGING/ecosystem.config.cjs $REMOTE_ROOT/server/
    sudo cp $SRV_STAGING/lib/*.mjs $REMOTE_ROOT/server/lib/
    sudo cp $SRV_STAGING/test/*.mjs $REMOTE_ROOT/server/test/
    sudo chown -R www:www $REMOTE_ROOT/server
    rm -rf $SRV_STAGING
    # pm2 reload（0 停机）；首次没起过则提示走 README 手动 pm2 start
    if sudo pm2 describe aifeeds-cc-relay >/dev/null 2>&1; then
      sudo pm2 reload aifeeds-cc-relay
      echo '  pm2 reloaded'
    else
      echo '  ⚠️ aifeeds-cc-relay 未在 pm2 中，首次部署请按 server/README.md 手动 pm2 start'
    fi
  "

  echo "▶ relay health"
  code=$(curl -sk -o /dev/null -w '%{http_code}' --max-time 5 "https://ai-feeds.cc/auth/wechat/health" || echo "000")
  echo "  https://ai-feeds.cc/auth/wechat/health → $code"
  echo "✓ server deploy done."
}

case "$MODE" in
  static) deploy_static ;;
  server) deploy_server ;;
  all)    deploy_static; deploy_server ;;
  *) echo "ERROR: 未知模式 '$MODE'（用 static | server | all）" >&2; exit 1 ;;
esac

echo "✓ all done. Open https://ai-feeds.cc to verify."
