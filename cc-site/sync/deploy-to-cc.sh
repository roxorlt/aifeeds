#!/usr/bin/env bash
# Stage and install the zero-dependency .cc content synchronizer on the Tencent
# Cloud host. This script never writes the manually maintained web root files.

set -euo pipefail
set +x
umask 077

if (($# != 1)) || [[ "$1" != "prod" ]]; then
  echo "ERROR: target must be prod" >&2
  exit 2
fi

TARGET=$1
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
SSH_KEY="$HOME/.ssh/aifeeds_temp"
SSH_HOST="lighthouse@82.156.0.68"
REMOTE_STAGING=""
LOCAL_ENV=""
LOCAL_PAYLOAD=""
SSH_OPTIONS=(-i "$SSH_KEY" -o StrictHostKeyChecking=accept-new)

cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ -n "$LOCAL_ENV" ]]; then rm -f -- "$LOCAL_ENV"; fi
  if [[ -n "$LOCAL_PAYLOAD" ]]; then rm -rf -- "$LOCAL_PAYLOAD"; fi
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

SECRET_FILE="$SECRETS_DIR/aifeeds-prod.env"
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

BASE_URL="https://api.ai-feeds.com"

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

REPO_ROOT=$(cd "$SCRIPT_DIR/../.." && pwd)
LOCAL_PAYLOAD=$(mktemp -d "${TMPDIR:-/tmp}/aifeeds-cc-payload.XXXXXX")
rmdir "$LOCAL_PAYLOAD"
/usr/bin/env node "$SCRIPT_DIR/build-payload.mjs" \
  "$REPO_ROOT" "$LOCAL_PAYLOAD" "$LOCAL_ENV" >/dev/null
MANIFEST_DIGEST=$(/usr/bin/env node "$SCRIPT_DIR/deployment-security.mjs" \
  sha256 "$LOCAL_PAYLOAD/MANIFEST.sha256")
INSTALLER_DIGEST=$(/usr/bin/env node "$SCRIPT_DIR/deployment-security.mjs" \
  sha256 "$LOCAL_PAYLOAD/cc-site/sync/install-remote.sh")
SECURITY_DIGEST=$(/usr/bin/env node "$SCRIPT_DIR/deployment-security.mjs" \
  sha256 "$LOCAL_PAYLOAD/cc-site/sync/deployment-security.mjs")
FILE_TRANSACTION_DIGEST=$(/usr/bin/env node "$SCRIPT_DIR/deployment-security.mjs" \
  sha256 "$LOCAL_PAYLOAD/cc-site/sync/deployment-file-transaction.mjs")
NGINX_TRANSACTION_DIGEST=$(/usr/bin/env node "$SCRIPT_DIR/deployment-security.mjs" \
  sha256 "$LOCAL_PAYLOAD/cc-site/sync/nginx-config-transaction.mjs")
NGINX_EDITOR_DIGEST=$(/usr/bin/env node "$SCRIPT_DIR/deployment-security.mjs" \
  sha256 "$LOCAL_PAYLOAD/cc-site/sync/nginx-vhost-editor.mjs")
for digest in \
  "$MANIFEST_DIGEST" "$INSTALLER_DIGEST" "$SECURITY_DIGEST" \
  "$FILE_TRANSACTION_DIGEST" "$NGINX_TRANSACTION_DIGEST" \
  "$NGINX_EDITOR_DIGEST"; do
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: payload helper returned an invalid SHA-256 digest" >&2
    exit 1
  fi
done
unset digest

REMOTE_STAGING=$(ssh "${SSH_OPTIONS[@]}" "$SSH_HOST" \
  'set -euo pipefail; umask 077; mktemp -d /tmp/aifeeds-cc-sync.XXXXXX')
if [[ ! "$REMOTE_STAGING" =~ ^/tmp/aifeeds-cc-sync\.[A-Za-z0-9]+$ ]]; then
  echo "ERROR: remote returned an unsafe staging path" >&2
  exit 1
fi

scp "${SSH_OPTIONS[@]}" -r \
  "$LOCAL_PAYLOAD/cc-site" "$LOCAL_PAYLOAD/deploy" \
  "$LOCAL_PAYLOAD/MANIFEST.sha256" \
  "$SSH_HOST:$REMOTE_STAGING/"
ssh "${SSH_OPTIONS[@]}" "$SSH_HOST" \
  "set -euo pipefail; chmod 0600 '$REMOTE_STAGING/deploy/cc-sync.env' '$REMOTE_STAGING/MANIFEST.sha256'"

REMOTE_BOOTSTRAP='set -euo pipefail
umask 077
if (($# != 8)); then
  echo "ERROR: invalid bootstrap argument count" >&2
  exit 2
fi
staging=$1
base_url=$2
manifest_digest=$3
installer_digest=$4
security_digest=$5
file_transaction_digest=$6
nginx_transaction_digest=$7
nginx_editor_digest=$8
if [[ ! "$staging" =~ ^/tmp/aifeeds-cc-sync\.[A-Za-z0-9]+$ ]]; then
  echo "ERROR: invalid bootstrap staging path" >&2
  exit 2
fi
if [[ "$base_url" != https://api.ai-feeds.com ]]; then
  echo "ERROR: invalid bootstrap API origin" >&2
  exit 2
fi
for digest in \
  "$manifest_digest" "$installer_digest" "$security_digest" \
  "$file_transaction_digest" "$nginx_transaction_digest" \
  "$nginx_editor_digest"; do
  if [[ ! "$digest" =~ ^[0-9a-f]{64}$ ]]; then
    echo "ERROR: invalid bootstrap digest" >&2
    exit 2
  fi
done
unset digest
bootstrap=$(mktemp -d /var/tmp/aifeeds-cc-bootstrap.XXXXXX)
cleanup_bootstrap() { rm -rf -- "$bootstrap"; }
trap cleanup_bootstrap EXIT
install -o root -g root -m 0700 \
  "$staging/cc-site/sync/install-remote.sh" \
  "$bootstrap/install-remote.fixed"
install -o root -g root -m 0600 \
  "$staging/cc-site/sync/deployment-security.mjs" \
  "$bootstrap/deployment-security.fixed.mjs"
install -o root -g root -m 0600 \
  "$staging/cc-site/sync/deployment-file-transaction.mjs" \
  "$bootstrap/deployment-file-transaction.fixed.mjs"
install -o root -g root -m 0600 \
  "$staging/cc-site/sync/deployment-file-transaction.mjs" \
  "$bootstrap/deployment-file-transaction.mjs"
install -o root -g root -m 0600 \
  "$staging/cc-site/sync/nginx-vhost-editor.mjs" \
  "$bootstrap/nginx-vhost-editor.mjs"
install -o root -g root -m 0600 \
  "$staging/cc-site/sync/nginx-config-transaction.mjs" \
  "$bootstrap/nginx-config-transaction.fixed.mjs"
printf "%s  %s\n" "$installer_digest" \
  "$bootstrap/install-remote.fixed" | sha256sum --check --status
printf "%s  %s\n" "$security_digest" \
  "$bootstrap/deployment-security.fixed.mjs" | sha256sum --check --status
printf "%s  %s\n" "$file_transaction_digest" \
  "$bootstrap/deployment-file-transaction.fixed.mjs" | sha256sum --check --status
printf "%s  %s\n" "$file_transaction_digest" \
  "$bootstrap/deployment-file-transaction.mjs" | sha256sum --check --status
printf "%s  %s\n" "$nginx_editor_digest" \
  "$bootstrap/nginx-vhost-editor.mjs" | sha256sum --check --status
printf "%s  %s\n" "$nginx_transaction_digest" \
  "$bootstrap/nginx-config-transaction.fixed.mjs" | sha256sum --check --status
AIFEEDS_FIXED_SECURITY_TOOL="$bootstrap/deployment-security.fixed.mjs" \
  AIFEEDS_FIXED_FILE_TOOL="$bootstrap/deployment-file-transaction.fixed.mjs" \
  AIFEEDS_FIXED_NGINX_TOOL="$bootstrap/nginx-config-transaction.fixed.mjs" \
  "$bootstrap/install-remote.fixed" \
  "$staging" "$base_url" "$manifest_digest" </dev/null'

printf '%s\n' "$REMOTE_BOOTSTRAP" | ssh "${SSH_OPTIONS[@]}" "$SSH_HOST" \
  sudo env -i \
  PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \
  bash -s -- \
  "$REMOTE_STAGING" "$BASE_URL" "$MANIFEST_DIGEST" \
  "$INSTALLER_DIGEST" "$SECURITY_DIGEST" "$FILE_TRANSACTION_DIGEST" \
  "$NGINX_TRANSACTION_DIGEST" "$NGINX_EDITOR_DIGEST"

echo "✓ aifeeds .cc sync service and timer installed for $TARGET."
