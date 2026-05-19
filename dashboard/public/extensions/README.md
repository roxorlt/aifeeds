# 浏览器扩展本地下载兜底

此目录给墙内不翻墙用户提供浏览器扩展 `.crx` 安装包直链。

CF Pages 自动把 `dashboard/public/*` 内的文件部署到根路径,所以访问 URL:

```
https://ai-feeds.com/extensions/<filename>.crx
```

## 当前期望放置的文件

| 文件名 | 来源 | 用途 |
|--------|------|------|
| `immersive-translate-latest.crx` | https://github.com/immersive-translate/immersive-translate/releases/latest | HF Paper drawer 正文 iframe tips 提供"下载 .crx"兜底,墙内用户侧载到 Chrome/Edge |

## 上传步骤

1. 去 GitHub release 下最新 `.crx`(非 `.zip`)
2. 重命名为 `immersive-translate-latest.crx`
3. `cp` 到此目录
4. `cd dashboard && npm run build && npx wrangler pages deploy dist --project-name=xlist-dashboard`
5. verify `https://ai-feeds.com/extensions/immersive-translate-latest.crx` HTTP 200

## 注意

- `.crx` 文件大小通常 5-10 MB,**不要 commit 到 git**(会污染历史)。本目录已加 `.gitignore` 忽略 `*.crx`
- 升级新版时直接覆盖文件 + 重新 deploy(不需要改 dashboard 代码)
- 如果未来扩展多了,可以加 `extensions/list.json` index FE 动态读
