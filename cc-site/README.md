# cc-site/ — ai-feeds.cc 国内静态合规站

`.cc` 域名（备案主体「科赞源信」，对外品牌「AI源信」）部署在腾讯云轻量服务器（82.156.0.68）的宝塔静态站上。本目录是**本地源文件副本 + 部署脚本**，所有 footer / 文案改动先在这里改 → 跑 `./deploy.sh` 覆盖部署，避免直接 SSH 改服务器导致版本失控。

## 文件

| 路径 | 用途 |
|------|------|
| `index.html` | 首页 |
| `privacy.html` | 隐私政策 |
| `terms.html` | 服务条款 |
| `contact.html` | 联系我们 |
| `style.css` | 共用样式 |
| `robots.txt` | 爬虫规则；根 sitemap 指向同步器生成的 `/sitemap.xml` |
| `sitemap-static.xml` | 人工维护静态页的独立 sitemap |
| `assets/gongan-icon.png` | 公安备案徽章（36×40） |
| `cc-prompts/index.html` | Claude Code 官方提示词库中文版（自包含单文件，源头在 `~/brain/30-projects/cc-prompt-library/`，更新时重新 build 后复制过来） |
| `cc-prompts/{common-workflows,best-practices,how-anthropic-teams-use-claude-code}.html` | 三份官方参考文档中文版（常见工作流 / 最佳实践 / Anthropic 团队实践），同一源头项目 build 产出 |
| `372c4ae2a3701bbe3b091dff54fb6d14.txt` | 360 搜索站点所有权验证文件 |
| `sogousiteverification.txt` | 搜狗搜索站点所有权验证文件 |
| `shenma-site-verification.txt` | 神马搜索站点所有权验证文件 |
| `baidu_verify_codeva-OHhjgzJndf.html` | 百度搜索站点所有权验证文件 |
| `deploy.sh` | scp + chown + chmod 一键覆盖部署 |
| `sync/static-urls.json` | `sitemap-static.xml` 的显式公开 URL 清单 |

服务器对应路径：`/www/wwwroot/ai-feeds.cc/`（OpenCloudOS 9.2，宝塔面板）。

## 部署

```bash
./deploy.sh
```

需要 `~/.ssh/aifeeds_temp` 私钥。脚本会：
1. 校验四个搜索验证文件的固定字节数和 SHA-256；
2. 在远端用 `mktemp` 创建唯一 staging，并由本地与远端双重 trap 清理；
3. 逐文件 `sudo install -o www -g www -m 0644` 到站点目录；
4. HTTPS smoke 必须严格返回 200，神马验证文件另做 HTTP 200 与内容哈希校验。

部署完之后浏览器打开 https://ai-feeds.cc 验证 footer 显示。

## 发布所有权边界

`deploy.sh` 只维护首页、隐私、条款、联系页、样式与 assets、四个
`cc-prompts/` 页面、`robots.txt`、`sitemap-static.xml` 及四个搜索站点验证
文件。脚本逐个列出公开文件，不使用会吞入生成目录的根目录通配符。

内容同步器独占以下生成输出：

- `${CC_SITE_ROOT}/i/`：逐条内容页；
- `${CC_SYNC_STATE_DIR}/public/generations/<uuid>/ai-news/`：50 条一页的内容归档；
- `${CC_SYNC_STATE_DIR}/public/generations/<uuid>/sitemaps/`：内容与归档 sitemap 分片；
- `${CC_SYNC_STATE_DIR}/public/generations/<uuid>/sitemap.xml`：根 sitemap 索引；
- `${CC_SYNC_STATE_DIR}/public/current`：只允许指向 `generations/<uuid>` 的受控相对
  symlink，是 Nginx 暴露归档与根 sitemap 的原子入口；
- `${CC_SYNC_STATE_DIR}/public/publication-journal.json`：崩溃恢复与 current/previous
  保留信息。

同步用户只需写 `${CC_SITE_ROOT}/i/` 和 `${CC_SYNC_STATE_DIR}`；站点根对同步器只读，
归档不再落到 `${CC_SITE_ROOT}/ai-news/`。人工部署脚本不得复制或删除 `/i/`、
`/ai-news/`、`/sitemaps/`，也不得在站点根目录写旧版 `sitemap.xml`。生产 Nginx
将 `/ai-news/` 和根 sitemap alias 到 `public/current/` 下对应路径。根 sitemap
中的分片 URL 固定为 `/sitemaps/<generation-v4-uuid>/<allowlisted-file>.xml`；
Nginx 只把严格匹配的 UUID 与 `archive.xml` 或
`(news|x|gh|ph|hf-paper)-<正整数>.xml` 映射到对应不可变 generation，其他
`/sitemaps/` 请求一律 404，不能通过 URL 选择任意文件或使用 `..`。

发布器先 fsync 完整 generation，再以一次 `rename` 原子替换 `current` symlink；
GC 保留按 manifest 时间排序的最近 24 个完整 generation，并无条件保留 journal 的
current 与 previous。正常运行的磁盘边界是 24 个完整 generation；时钟异常导致
current/previous 不在最新集合时，硬上界为 26 个。10 分钟 timer 加 30 秒 jitter 下，
旧分片约保留 4 小时，覆盖 Nginx `max-age=600` 后仍有 3 小时以上 crawler grace；
因此旧根 sitemap 在 current 切换后仍能抓到其列出的不可变 XML。启动时按持久 journal
恢复 SIGKILL 中断并清理已确认安全的孤立 stage。相同 state 指纹会跳过重建。item
state 当前没有镜像生成/修改时间字段，因此 item sitemap 明确省略 `lastmod`，不会把
来源文章的 `published_at` 冒充本站修改时间；归档 sitemap 使用真实 generation
生成时间。

`publish-indexes.mjs` 不提供独立 CLI；唯一生产调用链是已持有同一
`acquireSyncLock` 的 `sync.mjs`。

### 神马验证的 HTTP 例外

神马站长平台的文件验证器需要直接读取
`http://ai-feeds.cc/shenma-site-verification.txt`，不能依赖跳转到 HTTPS。生产
Nginx 的 HTTP → HTTPS 规则必须排除这一条路径：

```nginx
if ($server_port !~ 443) {
    rewrite ^(?!/shenma-site-verification\.txt$)(/.*)$ https://$host$1 permanent;
}
```

除该验证文件外，其余 HTTP 路径仍然跳转到 HTTPS。腾讯云轻量服务器防火墙还需
放行入站 TCP 80，否则验证请求不会到达 Nginx。

## 改 footer / 文案的标准流程

1. 在本目录改文件
2. `./deploy.sh`
3. 浏览器验证
4. `git commit` 改动（包括 footer 改动 + memo 更新）

## 备案信息引用

footer 标准片段 + 备案号 + 查询链接见 [`../docs/beian/README.md`](../docs/beian/README.md)。
