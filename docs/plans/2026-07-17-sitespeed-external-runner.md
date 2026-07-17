# sitespeed.io 外部基线执行计划

## 目标

在不使用本机 Clash 网络、不部署代码、不修改生产状态的前提下，由 GitHub 托管 Linux runner
对 `https://ai-feeds.com/` 分别执行移动端与桌面端五轮 sitespeed.io 测试，并只把完整 HTML、
JSON、瀑布图和视频作为 GitHub Actions artifact 保存。

## 安全边界

- 只在 `codex/waterfall-ssr-rum-parallel` 分支新增 workflow 时自动运行，也允许在该
  workflow 已进入默认分支后手动运行。
- 仓库权限固定为 `contents: read`；不读取 secret，不包含部署、SSH、Cloudflare 或 Git 写命令。
- 测试目标写死为生产首页 GET 导航；不接受 workflow 输入覆盖 URL。
- Docker 镜像固定到精确 sitespeed.io 版本，移动端与桌面端各五轮并使用固定网络整形参数。
- 无论测量成功或失败都上传已有报告，便于定位 runner 或站点问题。

## 实施与验收

1. 先写静态契约并确认在 workflow 不存在时失败。
2. 新增 workflow，把契约纳入现有 `validate-performance-ops`。
3. 运行契约、现有 Actions runtime 契约、YAML 解析和 diff/secret 检查。
4. 仅提交并推送 feature branch；不合并 `main`、不触发部署。
5. 读取首次 workflow 结论与 artifacts，并把合成数据和 DebugBear/RUM 的适用边界写入评审记录。
