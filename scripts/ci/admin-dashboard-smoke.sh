#!/usr/bin/env bash
# admin-dashboard 浏览器级 smoke。
#
# 用途:防 2026-05-20 这类 "tsc 通过但浏览器加载报 SyntaxError" 的 bug。
# 触发:PR/main push 改了 worker/src/admin-dashboard.ts 时跑。
#
# 当前状态:placeholder。等 BE 在 admin-dashboard.ts 给关键 chart 卡片
# 加 data-testid 后,这里填上 playwright 断言:
#   1. 启 wrangler dev --local 跑 worker
#   2. curl /admin/dashboard 拿 HTML
#   3. playwright headless 加载 + 监听 page.on('pageerror')
#   4. 断言每个 [data-testid="chart-*"] 元素存在 + 内部 svg 渲染
#
# 设计:placeholder 阶段直接 exit 0,job 跑通(green),不阻断 PR/deploy。
# 等 data-testid 加完后改 exit 1 触发真断言。

set -euo pipefail

ADMIN_FILE="worker/src/admin-dashboard.ts"

if [ ! -f "$ADMIN_FILE" ]; then
  echo "[smoke] skip: $ADMIN_FILE not found"
  exit 0
fi

# Phase 1 临时静态检查:抓两类已知会塌的模式
#   A. document.write 内嵌完整 </script>(浏览器 HTML parser 会提前关 outer script)
#   B. template literal 里裸的 \d / \D / \w / \W / \s / \S / \b 在 regex 字面量外
#      (V8 当 invalid escape 吃掉 backslash,输出 HTML 里 regex 变形 → SyntaxError)
echo "[smoke] static check on $ADMIN_FILE"

if grep -nE "document\.write\([^)]*</script>" "$ADMIN_FILE"; then
  echo "[smoke][FAIL] document.write 内嵌未拆分的 </script>,会被 HTML parser 提前关闭外层 script"
  echo "[smoke][FIX] 拆成 '</scr' + 'ipt>' 或用 escape"
  exit 1
fi

# template literal 内 invalid escape 静态识别(粗粒度,易误报,后续 BE 加 data-testid 后用 playwright 取代)
# 仅在 \\ 反斜杠不成对的 backtick 字符串里报警 — 暂时不开启,等 playwright 全套上来再考虑删
echo "[smoke] static check passed (playwright assertions pending BE data-testid)"
exit 0
