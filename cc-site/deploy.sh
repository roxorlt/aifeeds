#!/usr/bin/env bash
# Deploy only manually maintained cc-site files. Generated /i content and
# stateDir/public/current outputs belong to the sync service.

set -euo pipefail

KEY="$HOME/.ssh/aifeeds_temp"
HOST="lighthouse@82.156.0.68"
REMOTE_ROOT="/www/wwwroot/ai-feeds.cc"
REMOTE_STAGING=""
SMOKE_DIR="/tmp/cc-site-smoke.$$.$RANDOM"

ROOT_FILES=(
  index.html
  privacy.html
  terms.html
  contact.html
  style.css
  robots.txt
  sitemap-static.xml
  372c4ae2a3701bbe3b091dff54fb6d14.txt
  sogousiteverification.txt
  shenma-site-verification.txt
  baidu_verify_codeva-OHhjgzJndf.html
)
PROMPT_FILES=(
  cc-prompts/index.html
  cc-prompts/best-practices.html
  cc-prompts/common-workflows.html
  cc-prompts/how-anthropic-teams-use-claude-code.html
)
VERIFICATION_RECORDS=(
  "372c4ae2a3701bbe3b091dff54fb6d14.txt|32|1f42e6168b957ed3d00eee2ff5e8d9e310996e0602268bdffbda6e1f6c888547"
  "sogousiteverification.txt|10|307e17cfe3aefe3236227ae7dd65dc140e01697649dcb50cd48acbf8e609a427"
  "shenma-site-verification.txt|68|6719f0568ed216f3c632a7347130d6a13335c2797c28933dc2776911e96864ab"
  "baidu_verify_codeva-OHhjgzJndf.html|32|48c98dd64434d9bd1634b1aaa3cbc1f8724b4fffc5ecc98899137b2ab1993f1b"
)

cleanup() {
  set +e
  rm -rf -- "$SMOKE_DIR"
  if [[ -n "$REMOTE_STAGING" ]]; then
    ssh "${SSH_OPTS[@]}" "$HOST" \
      "set -euo pipefail; rm -rf -- '$REMOTE_STAGING'" >/dev/null 2>&1
  fi
}
trap cleanup EXIT

# SSH 连接复用：全程共享一条 TCP 连接，避免服务器对短时间内
# 连续新建连接限流导致 scp "Connection closed"（2026-07-16 实际踩到）
SSH_OPTS=(-i "$KEY" -o StrictHostKeyChecking=accept-new
  -o ControlMaster=auto -o ControlPath=/tmp/cc-site-ssh-mux-%r@%h:%p -o ControlPersist=120)

if [[ ! -f "$KEY" ]]; then
  echo "ERROR: SSH key not found at $KEY" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
mkdir -m 0700 "$SMOKE_DIR"

check_verification_file() {
  local file=$1
  local expected_bytes=$2
  local expected_sha=$3
  local actual_bytes actual_sha
  actual_bytes=$(wc -c < "$file" | tr -d '[:space:]')
  actual_sha=$(shasum -a 256 "$file" | awk '{print $1}')
  [[ "$actual_bytes" == "$expected_bytes" ]]
  [[ "$actual_sha" == "$expected_sha" ]]
}

for record in "${VERIFICATION_RECORDS[@]}"; do
  IFS='|' read -r file bytes digest <<<"$record"
  check_verification_file "$file" "$bytes" "$digest"
done

REMOTE_STAGING=$(ssh "${SSH_OPTS[@]}" "$HOST" \
  'set -euo pipefail; mktemp -d /tmp/cc-site-staging.XXXXXX')
ssh "${SSH_OPTS[@]}" "$HOST" \
  "set -euo pipefail; mkdir -p '$REMOTE_STAGING/assets' '$REMOTE_STAGING/cc-prompts'"

scp "${SSH_OPTS[@]}" \
  "${ROOT_FILES[@]}" "$HOST:$REMOTE_STAGING/"
scp "${SSH_OPTS[@]}" \
  assets/gongan-icon.png "$HOST:$REMOTE_STAGING/assets/"
scp "${SSH_OPTS[@]}" \
  "${PROMPT_FILES[@]}" "$HOST:$REMOTE_STAGING/cc-prompts/"

ssh "${SSH_OPTS[@]}" "$HOST" \
  "bash -s -- '$REMOTE_STAGING' '$REMOTE_ROOT'" <<'REMOTE'
set -euo pipefail
staging=$1
root=$2
trap 'rm -rf -- "$staging"' EXIT

verify_file() {
  local file=$1
  local expected_bytes=$2
  local expected_sha=$3
  local actual_bytes actual_sha
  actual_bytes=$(wc -c < "$file" | tr -d '[:space:]')
  actual_sha=$(sha256sum "$file" | awk '{print $1}')
  [[ "$actual_bytes" == "$expected_bytes" ]]
  [[ "$actual_sha" == "$expected_sha" ]]
}

verify_file "$staging/372c4ae2a3701bbe3b091dff54fb6d14.txt" 32 1f42e6168b957ed3d00eee2ff5e8d9e310996e0602268bdffbda6e1f6c888547
verify_file "$staging/sogousiteverification.txt" 10 307e17cfe3aefe3236227ae7dd65dc140e01697649dcb50cd48acbf8e609a427
verify_file "$staging/shenma-site-verification.txt" 68 6719f0568ed216f3c632a7347130d6a13335c2797c28933dc2776911e96864ab
verify_file "$staging/baidu_verify_codeva-OHhjgzJndf.html" 32 48c98dd64434d9bd1634b1aaa3cbc1f8724b4fffc5ecc98899137b2ab1993f1b

sudo install -d -o www -g www -m 0755 "$root" "$root/assets" "$root/cc-prompts"
root_files=(
  index.html privacy.html terms.html contact.html style.css
  robots.txt sitemap-static.xml
  372c4ae2a3701bbe3b091dff54fb6d14.txt
  sogousiteverification.txt shenma-site-verification.txt
  baidu_verify_codeva-OHhjgzJndf.html
)
for relative in "${root_files[@]}"; do
  sudo install -o www -g www -m 0644 "$staging/$relative" "$root/$relative"
done
sudo install -o www -g www -m 0644 \
  "$staging/assets/gongan-icon.png" "$root/assets/gongan-icon.png"
prompt_files=(
  index.html best-practices.html common-workflows.html
  how-anthropic-teams-use-claude-code.html
)
for relative in "${prompt_files[@]}"; do
  sudo install -o www -g www -m 0644 \
    "$staging/cc-prompts/$relative" "$root/cc-prompts/$relative"
done

verify_file "$root/372c4ae2a3701bbe3b091dff54fb6d14.txt" 32 1f42e6168b957ed3d00eee2ff5e8d9e310996e0602268bdffbda6e1f6c888547
verify_file "$root/sogousiteverification.txt" 10 307e17cfe3aefe3236227ae7dd65dc140e01697649dcb50cd48acbf8e609a427
verify_file "$root/shenma-site-verification.txt" 68 6719f0568ed216f3c632a7347130d6a13335c2797c28933dc2776911e96864ab
verify_file "$root/baidu_verify_codeva-OHhjgzJndf.html" 32 48c98dd64434d9bd1634b1aaa3cbc1f8724b4fffc5ecc98899137b2ab1993f1b
REMOTE

smoke_200() {
  local url=$1
  local output=${2:-/dev/null}
  local code
  code=$(curl --fail --silent --show-error --max-time 10 \
    --output "$output" --write-out '%{http_code}' "$url")
  [[ "$code" == "200" ]]
}

for web_path in \
  / /privacy.html /terms.html /contact.html /assets/gongan-icon.png /style.css \
  /robots.txt /sitemap-static.xml \
  /cc-prompts/ /cc-prompts/best-practices.html \
  /cc-prompts/common-workflows.html /cc-prompts/how-anthropic-teams-use-claude-code.html; do
  smoke_200 "https://ai-feeds.cc$web_path"
done

for record in "${VERIFICATION_RECORDS[@]}"; do
  IFS='|' read -r file bytes digest <<<"$record"
  downloaded="$SMOKE_DIR/$file"
  smoke_200 "https://ai-feeds.cc/$file" "$downloaded"
  check_verification_file "$downloaded" "$bytes" "$digest"
done
smoke_200 \
  "http://ai-feeds.cc/shenma-site-verification.txt" \
  "$SMOKE_DIR/shenma-http.txt"
check_verification_file \
  "$SMOKE_DIR/shenma-http.txt" \
  68 \
  6719f0568ed216f3c632a7347130d6a13335c2797c28933dc2776911e96864ab

echo "✓ static deploy completed and every smoke check returned HTTP 200."
