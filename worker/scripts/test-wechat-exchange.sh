#!/usr/bin/env bash
# PR-WechatAuth(worker)：测试 /api/auth/wechat/exchange 端到端
#
# 用法：
#   BRIDGE_SECRET=<hex64> HOST=https://staging-api.ai-feeds.com ./test-wechat-exchange.sh
#   BRIDGE_SECRET=<hex64> HOST=http://localhost:8787 ./test-wechat-exchange.sh
#
# 用了 .secrets/aifeeds-staging.env 的 BRIDGE_SECRET：
#   set -a; source ../../.secrets/aifeeds-staging.env; set +a
#   HOST=https://staging-api.ai-feeds.com ./scripts/test-wechat-exchange.sh
#
# 3 个 case：
#   1) 正确签名 + 当前 ts + 合法 openid → 200 + session_token
#   2) 正确签名 + 过期 ts（now - 60s） → 401 timestamp_out_of_window
#   3) 错误签名 + 当前 ts → 401 signature_mismatch

set -euo pipefail

if [[ -z "${BRIDGE_SECRET:-}" ]]; then
  echo "ERROR: BRIDGE_SECRET env var required" >&2
  exit 1
fi
HOST="${HOST:-https://staging-api.ai-feeds.com}"

# DEV_TOKEN：bot UA gate bypass（远端 staging/prod 拦 curl 默认 UA）。
# .cc 中转服务实际调用时不需要这个 — 它有正常浏览器 UA。
# 仅 dev/OPS curl smoke 测试用。
DEV_TOKEN_HEADER=()
if [[ -n "${DEV_TOKEN:-}" ]]; then
  DEV_TOKEN_HEADER=(-H "X-Dev-Token: $DEV_TOKEN")
fi

# 生成一个唯一 openid（带时间戳，避免与之前测试用户冲突）
TEST_OPENID="test_openid_$(date +%s)_$(openssl rand -hex 4)"

sign() {
  local ts="$1"
  local body="$2"
  local body_sha
  body_sha=$(printf '%s' "$body" | openssl dgst -sha256 -hex | awk '{print $NF}')
  printf '%s' "${ts}.${body_sha}" | \
    openssl dgst -sha256 -hmac "$BRIDGE_SECRET" -hex | awk '{print $NF}'
}

run_case() {
  local name="$1"
  local ts="$2"
  local sig="$3"
  local body="$4"
  local expected_status="$5"

  echo ""
  echo "=== Case: $name (expected $expected_status) ==="
  HTTP_CODE=$(curl -s -o /tmp/wechat-exchange-resp.json -w '%{http_code}' \
    -X POST "$HOST/api/auth/wechat/exchange" \
    -H "Content-Type: application/json" \
    -H "X-Bridge-Timestamp: $ts" \
    -H "X-Bridge-Signature: $sig" \
    "${DEV_TOKEN_HEADER[@]}" \
    -d "$body")
  echo "  HTTP: $HTTP_CODE"
  echo "  body: $(cat /tmp/wechat-exchange-resp.json | head -c 500)"
  if [[ "$HTTP_CODE" != "$expected_status" ]]; then
    echo "  ❌ FAIL: expected $expected_status, got $HTTP_CODE"
    return 1
  fi
  echo "  ✅ PASS"
}

# ─── Case 1: 正确签名 + 当前 ts ─────────────
NOW=$(date +%s)
BODY1=$(printf '{"openid":"%s","unionid":"u_%s","nickname":"测试用户","avatar_url":"https://example.com/avatar.png","device_id":"test_dev_123","ip":"1.2.3.4","ua":"test-script/1.0"}' "$TEST_OPENID" "$TEST_OPENID")
SIG1=$(sign "$NOW" "$BODY1")
run_case "正确签名 200" "$NOW" "$SIG1" "$BODY1" "200"

# ─── Case 2: 过期 ts（60 秒前，超过 30 秒窗口）─────────────
OLD=$((NOW - 60))
SIG2=$(sign "$OLD" "$BODY1")
run_case "ts 过期 401" "$OLD" "$SIG2" "$BODY1" "401"

# ─── Case 3: 错误签名 ─────────────
BAD_SIG="0000000000000000000000000000000000000000000000000000000000000000"
run_case "错误签名 401" "$NOW" "$BAD_SIG" "$BODY1" "401"

# ─── Case 4: 同一 openid 第二次调（应命中现有 user, is_new=false）─────────────
NOW2=$(date +%s)
SIG4=$(sign "$NOW2" "$BODY1")
run_case "重复 openid is_new=false（200）" "$NOW2" "$SIG4" "$BODY1" "200"
IS_NEW=$(cat /tmp/wechat-exchange-resp.json | python3 -c "import sys, json; print(json.load(sys.stdin).get('is_new'))" 2>/dev/null || echo "?")
if [[ "$IS_NEW" == "False" || "$IS_NEW" == "false" ]]; then
  echo "  ✅ is_new=false（命中现有 identity）"
else
  echo "  ⚠️  is_new=$IS_NEW（期待 false）"
fi

echo ""
echo "✓ 全部 case 通过"
