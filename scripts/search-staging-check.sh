#!/usr/bin/env bash
# scripts/search-staging-check.sh — C 端搜索 API staging 集成断言（可重复执行，全绿即通过）。
#
# 覆盖：参数校验 400 族 / grouped 分组模式 / 单源 list 模式 / 中文 2 字词 /
#       suggest 前缀 + 热搜 / KV 限流 429。
#
# 环境坑（务必保留）：
#   1. staging edge 的 bot gate 会 403 掉默认 curl UA → 所有请求必须带浏览器 UA（见 UA 封装）。
#   2. 限流按 X-Device-Id（缺失回落真实 IP）计数，search / suggest 各自独立桶，命中 Cache API 不计数。
#      故功能断言用「每次运行唯一」的 device-id（FNDEV），彼此隔离且不被历史运行污染；
#      限流断言单独用 RLDEV 连打 14 次触发 429。
#
# 合规过滤复检（cn_sensitive / dedup_of / 软删 测试行不出现在搜索结果）是额外手工步骤，
# 需 admin 通道 + 造/删测试行，不在本脚本内；执行结果记录在 Task 7 commit / 报告中。
#
# Run: bash scripts/search-staging-check.sh [BASE_URL]
set -euo pipefail

BASE="${1:-https://staging-api.ai-feeds.com}"
UA='Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'
RUN="$(date +%s)-$$"      # 每次运行唯一，隔离限流桶
FNDEV="chk-fn-$RUN"       # 功能断言共用（各桶请求数 < 12，不触发限流）

PASS=0; FAIL=0
pass() { echo "✅ $1"; PASS=$((PASS+1)); }
fail() { echo "❌ $1"; FAIL=$((FAIL+1)); }

# 浏览器 UA + 功能 device-id + 轻量重试（抗偶发网络抖动），返回响应体。
j()    { curl -s --max-time 20 --retry 2 --retry-connrefused -H "User-Agent: $UA" -H "X-Device-Id: $FNDEV" "$@"; }
# 同上，只回 HTTP 状态码。
code() { curl -s --max-time 20 --retry 2 --retry-connrefused -o /dev/null -w '%{http_code}' -H "User-Agent: $UA" -H "X-Device-Id: $FNDEV" "$@"; }

# ── 参数校验 400 族（校验在限流之前，不消耗额度）──
[ "$(code "$BASE/api/search?q=")" = 400 ] && pass "空 q → 400" || fail "空 q → 400"
[ "$(code "$BASE/api/search?q=$(printf 'a%.0s' {1..101})")" = 400 ] && pass "超长 q(101) → 400" || fail "超长 q → 400"
[ "$(code "$BASE/api/search?q=x&source=evil")" = 400 ] && pass "非法 source → 400" || fail "非法 source → 400"

# ── 业务模式 ──
j "$BASE/api/search?q=claude"               | grep -q '"mode":"grouped"' && pass "分组模式 grouped" || fail "分组模式 grouped"
j "$BASE/api/search?q=claude&source=github" | grep -q '"mode":"list"'    && pass "单源 list 模式"   || fail "单源 list 模式"
# CJK 查询必须 URL 编码：裸 UTF-8 放进 URL 会被 edge 判 400（-G --data-urlencode 让 curl 编码）。
j -G "$BASE/api/search" --data-urlencode "q=模型" | grep -q '"mode"' && pass "中文 2 字词命中" || fail "中文 2 字词命中"

# ── suggestion（超限时返回 200 空数组，仍含 "terms" 键 → 断言天然稳）──
j "$BASE/api/search/suggest?prefix=c" | grep -q '"terms"' && pass "suggest 前缀" || fail "suggest 前缀"
j "$BASE/api/search/suggest?prefix="  | grep -q '"terms"' && pass "suggest 热搜（空前缀）" || fail "suggest 热搜"

# ── 限流：search 限 12/min（按 X-Device-Id 计数）。KV 最终一致会让快打的读落后于写，
#    单轮偶发不触发；故最多 5 轮、每轮 16 连击（每轮换新 device-id + 0.25s 间隔让 KV 落地），
#    见到一次 429 即通过（消耗当分钟额度，放最后）。──
RL=0
for a in $(seq 1 5); do
  rldev="chk-rl-$RUN-$a"
  for i in $(seq 1 16); do
    # || true：curl 超时/网络抖动退出非 0 时不让 set -e 中断整个限流循环。
    c=$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' -H "User-Agent: $UA" -H "X-Device-Id: $rldev" "$BASE/api/search?q=rl$a-$i&_no=$i" || true)
    [ "$c" = 429 ] && { RL=1; break; }
    sleep 0.25
  done
  [ "$RL" = 1 ] && break
done
[ "$RL" = 1 ] && pass "限流 429（≤5 轮×16 连击触发）" || fail "限流 429 未触发"

echo "──────────────────────────────"
echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" = 0 ] && { echo "🎉 全部通过"; exit 0; } || { echo "存在失败项"; exit 1; }
