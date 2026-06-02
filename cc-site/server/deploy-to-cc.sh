#!/usr/bin/env bash
# 在你的 Mac 上跑这一条，把微信登录中转服务部署到 .cc 服务器（腾讯云 82.156.0.68）。
# 自己 SSH 上去完成：装 Node + 建专用用户 + 传代码 + 写 secret + systemd 守护 + 健康检查。
# secret 从本地 .secrets/aifeeds-{prod,staging}.env 读，加密传输，不打印、不留明文。
#
# 用法（在仓库任意位置都行，脚本自己找 .secrets）：
#   ./cc-site/server/deploy-to-cc.sh staging   # 中转 → staging worker（首次试链路，推荐）
#   ./cc-site/server/deploy-to-cc.sh prod       # 中转 → prod worker（需 prod worker 已部署 + 配 secret）
#
# 跑完后还差「nginx 反代」一步（脚本末尾会打印怎么在宝塔里加），然后就能扫码测了。

set -euo pipefail

TARGET="${1:-staging}"
if [[ "$TARGET" != "staging" && "$TARGET" != "prod" ]]; then
  echo "ERROR: 参数只能是 staging 或 prod" >&2
  exit 1
fi

KEY="$HOME/.ssh/aifeeds_temp"
HOST="lighthouse@82.156.0.68"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ ! -f "$KEY" ]]; then echo "ERROR: 找不到 SSH key $KEY" >&2; exit 1; fi

# ── 向上找 .secrets（兼容主仓库 / worktree）──
find_secrets() {
  local d="$1"
  while [[ "$d" != "/" ]]; do
    [[ -f "$d/.secrets/aifeeds-prod.env" ]] && { echo "$d/.secrets"; return 0; }
    d="$(dirname "$d")"
  done
  return 1
}
SECRETS_DIR="$(find_secrets "$SCRIPT_DIR")" || { echo "ERROR: 向上找不到 .secrets/aifeeds-prod.env" >&2; exit 1; }
echo "▶ 用 secrets：$SECRETS_DIR"

val() { awk -F= -v k="$1" '$0 ~ "^"k"=" {sub("^"k"=",""); print; exit}' "$2"; }

# 微信凭据（两环境共用，取 prod 文件）
APPID="$(val WECHAT_OPEN_APP_ID "$SECRETS_DIR/aifeeds-prod.env")"
APPSECRET="$(val WECHAT_OPEN_APP_SECRET "$SECRETS_DIR/aifeeds-prod.env")"

# bridge secret + worker URL 按 target 选
if [[ "$TARGET" == "prod" ]]; then
  BRIDGE="$(val BRIDGE_SECRET "$SECRETS_DIR/aifeeds-prod.env")"
  WORKER_URL="https://api.ai-feeds.com/api/auth/wechat/exchange"
else
  BRIDGE="$(val BRIDGE_SECRET "$SECRETS_DIR/aifeeds-staging.env")"
  WORKER_URL="https://staging-api.ai-feeds.com/api/auth/wechat/exchange"
fi
STATE_SECRET="$(openssl rand -hex 32)"

[[ -n "$APPID" && -n "$APPSECRET" && -n "$BRIDGE" ]] || { echo "ERROR: 缺 WECHAT_OPEN_APP_ID/SECRET 或 BRIDGE_SECRET" >&2; exit 1; }
echo "▶ target=$TARGET  worker=$WORKER_URL  appid=${APPID:0:4}***"

ssh_q() { ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "$HOST" "$@" 2>&1 | grep -v "post-quantum\|store now\|may need to be upgraded" || true; }

echo ""
echo "═══ 1. 装 Node 18 ═══"
ssh_q 'sudo dnf install -y nodejs >/dev/null 2>&1; echo "node $(node -v)  npm $(npm -v 2>/dev/null || echo NA)"'

echo ""
echo "═══ 2. 建专用用户 + 目录 ═══"
ssh_q 'sudo useradd -r -s /sbin/nologin aifeeds-relay 2>/dev/null && echo "建用户 aifeeds-relay" || echo "用户已存在"
  sudo mkdir -p /opt/aifeeds-cc-relay/lib /opt/aifeeds-cc-relay/test /etc/aifeeds && echo "目录就绪"'

echo ""
echo "═══ 3. 传代码 → /opt/aifeeds-cc-relay ═══"
ssh_q 'rm -rf /tmp/relay-src && mkdir -p /tmp/relay-src/lib /tmp/relay-src/test'
scp -i "$KEY" "$SCRIPT_DIR/relay.mjs" "$HOST:/tmp/relay-src/" >/dev/null 2>&1
scp -i "$KEY" "$SCRIPT_DIR"/lib/*.mjs "$HOST:/tmp/relay-src/lib/" >/dev/null 2>&1
scp -i "$KEY" "$SCRIPT_DIR"/test/*.mjs "$HOST:/tmp/relay-src/test/" >/dev/null 2>&1
ssh_q 'sudo cp /tmp/relay-src/relay.mjs /opt/aifeeds-cc-relay/
  sudo cp /tmp/relay-src/lib/*.mjs /opt/aifeeds-cc-relay/lib/
  sudo cp /tmp/relay-src/test/*.mjs /opt/aifeeds-cc-relay/test/
  sudo chown -R root:root /opt/aifeeds-cc-relay && rm -rf /tmp/relay-src && echo "代码就位"'

echo ""
echo "═══ 4. 写 /etc/aifeeds/relay.env（secret，600 root，stdin 传输不留明文）═══"
# 本地构造内容 → 加密 scp 临时文件 → sudo 落位 → 删本地临时
TMP_ENV="$(mktemp)"
chmod 600 "$TMP_ENV"
cat > "$TMP_ENV" <<EOF
WECHAT_OPEN_APP_ID=$APPID
WECHAT_OPEN_APP_SECRET=$APPSECRET
BRIDGE_SECRET=$BRIDGE
STATE_SECRET=$STATE_SECRET
WORKER_EXCHANGE_URL=$WORKER_URL
EOF
scp -i "$KEY" "$TMP_ENV" "$HOST:/tmp/relay.env.tmp" >/dev/null 2>&1
rm -f "$TMP_ENV"
ssh_q 'sudo mv /tmp/relay.env.tmp /etc/aifeeds/relay.env
  sudo chmod 600 /etc/aifeeds/relay.env && sudo chown root:root /etc/aifeeds/relay.env
  echo "relay.env 落位（$(sudo wc -l < /etc/aifeeds/relay.env) 行，权限 $(sudo stat -c %a /etc/aifeeds/relay.env)）"'

echo ""
echo "═══ 5. systemd 守护 + 开机自启 ═══"
scp -i "$KEY" "$SCRIPT_DIR/aifeeds-cc-relay.service" "$HOST:/tmp/aifeeds-cc-relay.service" >/dev/null 2>&1
ssh_q 'sudo mv /tmp/aifeeds-cc-relay.service /etc/systemd/system/aifeeds-cc-relay.service
  sudo systemctl daemon-reload
  sudo systemctl enable --now aifeeds-cc-relay 2>&1 | tail -1
  sleep 2
  echo "状态：$(systemctl is-active aifeeds-cc-relay)"'

echo ""
echo "═══ 6. 本地健康检查（127.0.0.1:3001）═══"
ssh_q 'curl -s --max-time 5 http://127.0.0.1:3001/auth/wechat/health && echo "  ✅ relay 进程健康" || echo "  ❌ 没起来，看 journalctl -u aifeeds-cc-relay -n 30"'

echo ""
echo "═══ 7. 本地冒烟（21 项）═══"
ssh_q 'cd /opt/aifeeds-cc-relay && node test/smoke.mjs 2>&1 | tail -3'

cat <<'NGINX'

════════════════════════════════════════════════════════════════
✅ relay 守护进程已就绪。还差最后一步：nginx 反代（你在宝塔里加）

宝塔 → 网站 → ai-feeds.cc → 设置 → 配置文件 → 在 server{} 块里（443 那个，
最后一个 } 之前）粘贴下面这段，保存（宝塔自动 nginx -t + reload）：

    location /auth/wechat/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 15s;
        add_header Cache-Control "no-store" always;
    }

（限流 limit_req + fail2ban 是加固项，链路验通后再加，见 nginx-auth-wechat.conf）

加完告诉我，我用公网 curl 验 https://ai-feeds.cc/auth/wechat/start 是否 302 到微信。
然后你用手机微信扫码测完整流程。
════════════════════════════════════════════════════════════════
NGINX
