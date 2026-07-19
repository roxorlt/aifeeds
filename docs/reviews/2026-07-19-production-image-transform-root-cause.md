# 2026-07-19 生产封面转换根因与修复

## 结论

瀑布流前端的首图优先级、400/800 `srcset` 和解码均已在生产生效；封面仍慢的最终根因是生产
`api.ai-feeds.com` 经香港 Nginx 调用 `xlist-api.*.workers.dev` 时，Cloudflare 的 `cf.image`
转换完全没有执行。它既没有输出 AVIF/WebP，也没有把 800px 原图缩成请求的 400px。

同一 Worker、同一图片、同一参数经 `staging-api.ai-feeds.com` 自定义域直达 Cloudflare 时，
转换正常。因此不是前端、图片源、Accept 解析或 Worker 业务代码问题，而是生产 Worker 的调用
拓扑问题。

## 生产实测

固定使用当前生产首页的一张真实活动行封面，请求 `w=400&q=82`。

生产外层 Nginx 通过显式 Accept 权重绕过缓存后：

```text
AVIF accept:    X-Cache-Status BYPASS, image/jpeg, 49,152 B, 800×474
WebP accept:    X-Cache-Status BYPASS, image/jpeg, 49,152 B, 800×474
original:       X-Cache-Status BYPASS, image/jpeg, 49,152 B, 800×474
```

相同请求直达 staging Worker 自定义域：

```text
AVIF accept:    image/avif, 10,045 B, 400×237
WebP accept:    image/webp, 10,912 B, 400×237
original:       image/jpeg, 11,794 B, 400×237
```

Cloudflare Zone API 同时确认 `image_resizing=on`。这排除了“功能开关未开启”；生产路径只要改为
Worker 自定义域即可恢复转换。Cloudflare 官方也说明 `cf.image` 可在 Worker 中执行，而自定义域
会由 Cloudflare 创建 DNS 与证书：

- <https://developers.cloudflare.com/images/optimization/transformations/transform-via-workers/>
- <https://developers.cloudflare.com/images/reference/troubleshooting/>
- <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>

## 方案

1. 在生产 `xlist-api` 上新增 `image-api.ai-feeds.com` custom domain。
2. Wrangler 的 route 列表是权威配置，因此同一个变更显式保留既有
   `admin.ai-feeds.com`，不能只写新域。
3. 浏览器仍请求 `https://api.ai-feeds.com/img`，中国用户到香港 VPS 的路径不变。
4. VPS 的 `/img` 仅把 Worker 上游从 `xlist-api.*.workers.dev` 改为
   `image-api.ai-feeds.com`；既有 `X-Origin-Secret`、限流、缓存、Range 和安全白名单都不变。
5. 新域没有 origin secret 的直连请求仍由 Worker origin gate 返回 403，不新增公开 API 面。
6. 先前已经激活的 AVIF/WebP/original Nginx 缓存桶继续保留；转换恢复后它才真正承担格式隔离。

## 版本化执行物

```text
deploy/nginx/aifeeds-image-transform-upstream-apply.sh
SHA-256 6a387024cf9e1874c698d886700b2b37170ca31368e66a6e3ab8ba7bc6fb2d9f

deploy/nginx/aifeeds-image-transform-upstream-rollback.sh
SHA-256 501b48c80c2f297c6c63cfae794c488763bc24617f691946b99ea0b593f9bbe9
```

apply 脚本只接受当前生产已激活的两份精确基线：

```text
/etc/nginx/sites-available/aifeeds.conf
9303f443c9530a06ae2339c735151206a2011d65e03fdfebcf96c123a5c8dfb3

/etc/nginx/conf.d/aifeeds-perf.conf
55630f8c73aa8ee9cce056daa064788d57cbc54be48a354b3f163f6441ba6837
```

它会先从现有 `/img` location 内读取 origin secret，但不会输出；用该 secret 直连新域，要求返回
小于 30KB 的 AVIF 后才允许继续。修改只发生在 `/img` block 的 `proxy_pass`、`Host` 和
`proxy_ssl_name` 三行。候选配置通过 `nginx -t` 后才写入、定向清理 `/img?` 缓存并 reload；
任一步失败自动恢复。

rollback 只接受 apply 创建的 root-only 备份，先验证 manifest 和当前激活配置的精确 SHA。
回滚过程另存 rescue 配置；恢复、清理或 reload 失败会恢复回滚前状态并输出
`rollback_failed`。

## 本地门禁

```text
Dashboard node tests: 367 passed
Worker Vitest:         835 passed
Worker TypeScript:     pass
Wrangler prod dry-run: pass
Wrangler staging:      pass
Nginx contracts:       2 passed
bash -n apply/rollback: pass
```

## 发布顺序

1. feature branch 部署 Worker staging，复测既有 `staging-api` 三种格式与 400px 尺寸；
2. 合入 main，生产 Worker deploy 创建 `image-api.ai-feeds.com`，并核对
   `admin.ai-feeds.com` 仍绑定 `xlist-api`；
3. 在 VPS 执行 apply `--check`，只有直连新域 AVIF 预检通过才执行 `--apply`；
4. 经正式 `api.ai-feeds.com/img` 连续验证 AVIF/WebP/original 各自 MISS→HIT、格式和尺寸；
5. 重跑生产首页五设备冒烟和 API 2xx。

## 回滚顺序

如果新上游异常，先执行本变更 rollback，让 `/img` 回到 `workers.dev`，恢复缓存后复测。
如果需要连同此前格式桶一起撤回，再执行：

```text
/tmp/aifeeds-image-format-cache-rollback.sh
/root/aifeeds-image-format-cache-20260719T081811Z
```

必须按这个顺序；此前格式桶 rollback 会校验当前 site SHA，不能越过上游回滚直接覆盖。

## 生产执行记录

待 feature staging、main Worker deploy 和 VPS 激活完成后追加。
