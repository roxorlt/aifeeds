#!/usr/bin/env bash
# Stage and install the zero-dependency .cc content synchronizer on the Tencent
# Cloud host. This script never writes the manually maintained web root files.

set -euo pipefail
set +x
umask 077

if (($# != 1)) || [[ "$1" != "prod" && "$1" != "staging" ]]; then
  echo "ERROR: target must be prod or staging" >&2
  exit 2
fi

TARGET=$1
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SSH_KEY="$HOME/.ssh/aifeeds_temp"
SSH_HOST="lighthouse@82.156.0.68"
REMOTE_STAGING=""
LOCAL_ENV=""
SSH_OPTIONS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ -n "$LOCAL_ENV" ]]; then rm -f -- "$LOCAL_ENV"; fi
  if [[ "$REMOTE_STAGING" =~ ^/tmp/aifeeds-cc-sync\.[A-Za-z0-9]+$ ]]; then
    ssh "${SSH_OPTIONS[@]}" "$SSH_HOST" \
      "rm -rf -- '$REMOTE_STAGING'" >/dev/null 2>&1
  fi
  exit "$status"
}
trap cleanup EXIT

if [[ ! -f "$SSH_KEY" || -L "$SSH_KEY" ]]; then
  echo "ERROR: SSH key is missing or unsafe: $SSH_KEY" >&2
  exit 1
fi

find_secrets_dir() {
  local directory=$SCRIPT_DIR
  while [[ "$directory" != "/" ]]; do
    if [[ -f "$directory/.secrets/aifeeds-prod.env" ]]; then
      printf '%s\n' "$directory/.secrets"
      return 0
    fi
    directory=$(dirname "$directory")
  done
  return 1
}

if [[ -n "${AIFEEDS_SECRETS_DIR:-}" ]]; then
  SECRETS_DIR=$AIFEEDS_SECRETS_DIR
else
  SECRETS_DIR=$(find_secrets_dir) || {
    echo "ERROR: unable to find .secrets/aifeeds-prod.env" >&2
    exit 1
  }
fi
if [[ ! -d "$SECRETS_DIR" || -L "$SECRETS_DIR" ]]; then
  echo "ERROR: secrets directory is missing or unsafe" >&2
  exit 1
fi

SECRET_FILE="$SECRETS_DIR/aifeeds-$TARGET.env"
if [[ ! -f "$SECRET_FILE" || -L "$SECRET_FILE" ]]; then
  echo "ERROR: target secret file is missing or unsafe" >&2
  exit 1
fi

CC_SYNC_SECRET=""
secret_count=0
while IFS= read -r line || [[ -n "$line" ]]; do
  if [[ "$line" == *$'\r'* ]]; then
    echo "ERROR: secret file contains CR or embedded line ending" >&2
    exit 1
  fi
  case "$line" in
    CC_SYNC_SECRET=*)
      secret_count=$((secret_count + 1))
      if ((secret_count > 1)); then
        echo "ERROR: duplicate CC_SYNC_SECRET" >&2
        exit 1
      fi
      CC_SYNC_SECRET=${line#CC_SYNC_SECRET=}
      ;;
    CC_SYNC_*)
      echo "ERROR: unknown CC_SYNC_ key in target secret file" >&2
      exit 1
      ;;
  esac
done < "$SECRET_FILE"
unset line

if ((secret_count != 1)); then
  echo "ERROR: CC_SYNC_SECRET is required exactly once" >&2
  exit 1
fi
if [[ ! "$CC_SYNC_SECRET" =~ ^[0-9A-Fa-f]{64,128}$ ]]; then
  echo "ERROR: CC_SYNC_SECRET must be 64 to 128 hexadecimal characters" >&2
  exit 1
fi

case "$TARGET" in
  prod) BASE_URL="https://api.ai-feeds.com" ;;
  staging) BASE_URL="https://staging-api.ai-feeds.com" ;;
esac

LOCAL_ENV=$(mktemp "${TMPDIR:-/tmp}/aifeeds-cc-sync-env.XXXXXX")
chmod 0600 "$LOCAL_ENV"
{
  printf 'CC_SYNC_SECRET=%s\n' "$CC_SYNC_SECRET"
  printf 'CC_SYNC_BASE_URL=%s\n' "$BASE_URL"
  printf 'CC_SITE_ROOT=/www/wwwroot/ai-feeds.cc\n'
  printf 'CC_SYNC_STATE_DIR=/var/lib/aifeeds-cc-sync\n'
  printf 'CC_SYNC_CONCURRENCY=8\n'
  printf 'CC_SYNC_PAGE_LIMIT=200\n'
  printf 'CC_SYNC_REQUEST_TIMEOUT_MS=15000\n'
} > "$LOCAL_ENV"
unset CC_SYNC_SECRET

REMOTE_STAGING=$(ssh "${SSH_OPTIONS[@]}" "$SSH_HOST" \
  'set -euo pipefail; umask 077; mktemp -d /tmp/aifeeds-cc-sync.XXXXXX')
if [[ ! "$REMOTE_STAGING" =~ ^/tmp/aifeeds-cc-sync\.[A-Za-z0-9]+$ ]]; then
  echo "ERROR: remote returned an unsafe staging path" >&2
  exit 1
fi

ssh "${SSH_OPTIONS[@]}" "$SSH_HOST" \
  "set -euo pipefail; mkdir -m 0700 '$REMOTE_STAGING/test'"

SOURCE_FILES=(
  auth.mjs
  client.mjs
  config.mjs
  fs-safe.mjs
  nginx-vhost-editor.mjs
  package.json
  publish-indexes.mjs
  state.mjs
  static-urls.json
  sync.mjs
  aifeeds-cc-sync.service
  aifeeds-cc-sync.timer
  nginx-content-mirror.conf
  deploy-to-cc.sh
  install-remote.sh
)
for file in "${SOURCE_FILES[@]}"; do
  if [[ ! -f "$SCRIPT_DIR/$file" || -L "$SCRIPT_DIR/$file" ]]; then
    echo "ERROR: deployment source is missing or unsafe: $file" >&2
    exit 1
  fi
done
TEST_FILES=("$SCRIPT_DIR"/test/*.test.mjs)
if [[ ! -f "${TEST_FILES[0]}" ]]; then
  echo "ERROR: no sync tests found" >&2
  exit 1
fi

scp "${SSH_OPTIONS[@]}" \
  "${SOURCE_FILES[@]/#/$SCRIPT_DIR/}" \
  "$SSH_HOST:$REMOTE_STAGING/"
scp "${SSH_OPTIONS[@]}" "${TEST_FILES[@]}" \
  "$SSH_HOST:$REMOTE_STAGING/test/"
scp "${SSH_OPTIONS[@]}" "$LOCAL_ENV" \
  "$SSH_HOST:$REMOTE_STAGING/cc-sync.env"
ssh "${SSH_OPTIONS[@]}" "$SSH_HOST" \
  "set -euo pipefail; chmod 0600 '$REMOTE_STAGING/cc-sync.env'"

ssh "${SSH_OPTIONS[@]}" "$SSH_HOST" \
  sudo env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  bash "$REMOTE_STAGING/install-remote.sh" "$REMOTE_STAGING" "$BASE_URL"

echo "✓ aifeeds .cc sync service and timer installed for $TARGET."
