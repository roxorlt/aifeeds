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
| `assets/gongan-icon.png` | 公安备案徽章（36×40） |
| `372c4ae2a3701bbe3b091dff54fb6d14.txt` | 360 搜索站点所有权验证文件 |
| `sogousiteverification.txt` | 搜狗搜索站点所有权验证文件 |
| `shenma-site-verification.txt` | 神马搜索站点所有权验证文件 |
| `baidu_verify_codeva-OHhjgzJndf.html` | 百度搜索站点所有权验证文件 |
| `deploy.sh` | scp + chown + chmod 一键覆盖部署 |

服务器对应路径：`/www/wwwroot/ai-feeds.cc/`（OpenCloudOS 9.2，宝塔面板）。

## 部署

```bash
./deploy.sh
```

需要 `~/.ssh/aifeeds_temp` 私钥。脚本会：
1. scp 整个 cc-site/（含 assets/）到 `/tmp/cc-site-staging/`
2. ssh 到目标主机，sudo 把文件覆盖到 `/www/wwwroot/ai-feeds.cc/`
3. chown www:www + chmod 644 修正权限（不要 -R 整目录，会撞到 `.user.ini` immutable）

部署完之后浏览器打开 https://ai-feeds.cc 验证 footer 显示。

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
