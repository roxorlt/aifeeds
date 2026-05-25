#!/usr/bin/env bash
# CI 失败时推 PushDeer 通知管理员。
#
# 用法:
#   bash scripts/ci/pushdeer-notify.sh "标题" "正文"
#
# 环境变量:
#   PUSHDEER_ADMIN_KEYS  逗号分隔的多个 pushkey(GitHub secret 注入)
#
# 设计:守卫 — 没配 PUSHDEER_ADMIN_KEYS 时静默 skip(exit 0),
# 不让缺 secret 把 deploy abort 路径自己 abort 掉。
# 加完 GH secret PUSHDEER_ADMIN_KEYS 后自然生效。

set -euo pipefail

TITLE="${1:-CI 通知}"
BODY="${2:-(无正文)}"

if [ -z "${PUSHDEER_ADMIN_KEYS:-}" ]; then
  echo "[pushdeer] skip: PUSHDEER_ADMIN_KEYS not set"
  exit 0
fi

IFS=',' read -ra KEYS <<< "$PUSHDEER_ADMIN_KEYS" 2>/dev/null || true
# zsh / dash 兼容
if [ "${#KEYS[@]}" -eq 0 ] 2>/dev/null; then
  KEYS=()
  for k in $(echo "$PUSHDEER_ADMIN_KEYS" | tr ',' ' '); do
    KEYS+=("$k")
  done
fi

i=0
for k in "${KEYS[@]}"; do
  i=$((i+1))
  resp=$(curl -sS -X POST "https://api2.pushdeer.com/message/push" \
    --data-urlencode "pushkey=$k" \
    --data-urlencode "text=$TITLE" \
    --data-urlencode "desp=$BODY" \
    --data-urlencode "type=text" || true)
  echo "[pushdeer] key #$i: $resp"
done
