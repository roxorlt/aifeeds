#!/usr/bin/env bash
# Deploy cc-site/ to ai-feeds.cc (82.156.0.68:/www/wwwroot/ai-feeds.cc/).
# Requires ~/.ssh/aifeeds_temp private key.

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

echo "✓ deploy done. Open https://ai-feeds.cc to verify."
