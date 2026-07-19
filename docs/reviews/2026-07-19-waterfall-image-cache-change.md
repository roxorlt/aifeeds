# 2026-07-19 瀑布流图片格式缓存变更证据

## 结论

瀑布流前端已使用 400/800 响应式候选并优先加载前两张真实封面。生产香港 Nginx 的 `/img`
二级缓存键此前没有区分 AVIF、WebP 与原图，这是一项确定的缓存正确性问题，本变更修正这一层
缓存身份，不改图片白名单、视频 Range、Worker 转码参数或业务数据。

激活后通过 `BYPASS` 进一步采证发现，生产 `Nginx → workers.dev` 路径的 Worker 转换本身也
没有发生，三种 Accept 均返回原 JPEG/PNG；所以缓存键不是“图片慢”的唯一根因。完整对照和
专用 Worker custom domain 修复见
[`2026-07-19-production-image-transform-root-cause.md`](2026-07-19-production-image-transform-root-cause.md)。

## 只读生产基线

2026-07-19 从香港 VPS 只读取得：

```text
/etc/nginx/sites-available/aifeeds.conf
SHA-256 0446c7076e8ca1dfdf1e591e74dd6a559a9599791fd2659589edba80f36c2214

/etc/nginx/conf.d/aifeeds-perf.conf
SHA-256 cd78847ba901509575e9c0df8c5674fe1b86723906da7216f2a486a1b0a74795
```

现有 `/img` 关键配置：

```nginx
proxy_cache_key "$scheme$request_method$host$request_uri";
proxy_no_cache       $img_skip_cache;
proxy_cache_bypass   $img_skip_cache;
```

抽样缓存元数据同时出现：

```text
KEY: httpsGETapi.ai-feeds.com/img?...&w=640
Content-Type: image/jpeg
Vary: Accept
```

现代浏览器 `Accept` 抽样仍命中约 152 KB JPEG。`Vary: Accept` 不会自动改变 Nginx
`proxy_cache_key`，因此根因在香港二级缓存，而不是 `<img>` 本身或 Worker 格式协商。

## 版本化执行物

```text
deploy/nginx/aifeeds-image-format-cache-apply.sh
SHA-256 3ecba8fb157997346ac38200ed31d65f8c0d65559c2a96b02e6b6c17248f3fca

deploy/nginx/aifeeds-image-format-cache-rollback.sh
SHA-256 54ea3e643c155d3bb67b8c1557de706e3d2fe112aa49b9651cb089c464ec3245
```

执行脚本具备以下门禁：

- 只接受上述两份生产配置的精确 SHA-256，发现漂移立即退出；
- 只替换恰好一条既有 `/img` cache key 和两条既有 cache bypass；
- 先建立 root-only 备份与校验清单；
- 现代浏览器只使用 `avif`、`webp`、`original` 三个有限桶；
- Worker 会尊重显式 `q=` 权重，因此这类少见请求直接绕过 Nginx cache，避免跨桶污染；
- `video.twimg.com` 继续由 `$img_skip_cache` 绕过缓存，Range 行为不变；
- 修改后先 `nginx -t`，失败会自动恢复备份且不会 reload 候选配置；
- apply 把激活后两份配置的精确 SHA 写入 root-only `activated.sha256`；
- 只删除缓存文件内容中 key 含 `/img?` 的对象，不清字体、HTML、JS、CSS 或 `/r`；
- reload 失败会自动恢复原配置并再次校验、reload。
- rollback 先用 `activated.sha256` 拒绝覆盖 apply 后的任何并发配置变更；恢复或 reload 任一步
  失败都会恢复回滚前配置并明确输出 `rollback_failed`。

本地契约：

```text
bash -n deploy/nginx/aifeeds-image-format-cache-apply.sh
bash -n deploy/nginx/aifeeds-image-format-cache-rollback.sh
node --test dashboard/src/lib/nginx-image-cache.contract.test.mjs

3 passed, 0 failed
```

## 精确执行流程

分支合入并完成 Dashboard staging 后，只复制本提交中的脚本到 VPS 临时目录，先核对脚本 SHA：

```bash
sha256sum /tmp/aifeeds-image-format-cache-apply.sh \
  /tmp/aifeeds-image-format-cache-rollback.sh
bash /tmp/aifeeds-image-format-cache-apply.sh --check
bash /tmp/aifeeds-image-format-cache-apply.sh --apply
```

`--apply` 成功输出 `backup_dir`、新配置 SHA、精确清理数量。该 `backup_dir` 是唯一允许传给回滚
脚本的路径。

## 激活后验证

固定使用公开、白名单内的静态图片：

```bash
IMAGE_URL='https://cdn-thumbnails.huggingface.co/social-thumbnails/papers/2605.30349.png'
```

分别以 AVIF、WebP 和原图能力请求同一 `w=400&q=75` URL；每组连续请求两次：

```bash
curl -sS --get 'https://api.ai-feeds.com/img' \
  --data-urlencode "url=$IMAGE_URL" --data 'w=400' --data 'q=75' \
  -H 'Accept: image/avif,image/webp,*/*;q=0.8' -D /tmp/img-avif-1.h -o /tmp/img-avif-1.bin
curl -sS --get 'https://api.ai-feeds.com/img' \
  --data-urlencode "url=$IMAGE_URL" --data 'w=400' --data 'q=75' \
  -H 'Accept: image/avif,image/webp,*/*;q=0.8' -D /tmp/img-avif-2.h -o /tmp/img-avif-2.bin

curl -sS --get 'https://api.ai-feeds.com/img' \
  --data-urlencode "url=$IMAGE_URL" --data 'w=400' --data 'q=75' \
  -H 'Accept: image/webp,*/*;q=0.8' -D /tmp/img-webp-1.h -o /tmp/img-webp-1.bin
curl -sS --get 'https://api.ai-feeds.com/img' \
  --data-urlencode "url=$IMAGE_URL" --data 'w=400' --data 'q=75' \
  -H 'Accept: image/webp,*/*;q=0.8' -D /tmp/img-webp-2.h -o /tmp/img-webp-2.bin

curl -sS --get 'https://api.ai-feeds.com/img' \
  --data-urlencode "url=$IMAGE_URL" --data 'w=400' --data 'q=75' \
  -H 'Accept: image/png,image/*;q=0.8,*/*;q=0.5' -D /tmp/img-original-1.h -o /tmp/img-original-1.bin
curl -sS --get 'https://api.ai-feeds.com/img' \
  --data-urlencode "url=$IMAGE_URL" --data 'w=400' --data 'q=75' \
  -H 'Accept: image/png,image/*;q=0.8,*/*;q=0.5' -D /tmp/img-original-2.h -o /tmp/img-original-2.bin
```

验收条件：

- AVIF 为 `Content-Type: image/avif`，WebP 为 `image/webp`，原图为输入图片对应类型；
- 三组都有 `Vary: Accept`；
- 同组第二次为 `X-Cache-Status: HIT`，不同格式不会复用另一组 body；
- `Content-Length` 有限，AVIF/WebP body 小于原图；
- API、首页和 waterfall Cookie smoke 均为 2xx。

## 回滚

使用 apply 输出的实际路径：

```bash
bash /tmp/aifeeds-image-format-cache-rollback.sh \
  /root/aifeeds-image-format-cache-<UTC timestamp>
```

回滚脚本验证 root 所有权、备份 manifest 与当前两份配置的精确激活 SHA，先保存回滚前配置，
恢复旧配置后执行 `nginx -t`。验证、定向清理或 reload 任一步失败都会恢复回滚前配置并再次
校验、reload，同时输出 `rollback_failed` 供独立回滚负责人接管。成功后同样只清 `/img?`
对象并 reload。备份与 rescue 目录保留用于复盘，不在本变更中删除。

## 执行记录

2026-07-19 已执行：

```text
apply_script_sha=3ecba8fb157997346ac38200ed31d65f8c0d65559c2a96b02e6b6c17248f3fca
rollback_script_sha=54ea3e643c155d3bb67b8c1557de706e3d2fe112aa49b9651cb089c464ec3245
purged_img_cache_files=51
backup_dir=/root/aifeeds-image-format-cache-20260719T081811Z
site_sha=9303f443c9530a06ae2339c735151206a2011d65e03fdfebcf96c123a5c8dfb3
perf_sha=55630f8c73aa8ee9cce056daa064788d57cbc54be48a354b3f163f6441ba6837
```

apply 的 checksum、两次 `nginx -t`、定向清理和 reload 全部成功。三组缓存均独立出现
`MISS→HIT`，证明格式桶生效；但上游 body 相同。显式 q 权重使 Nginx 返回 `BYPASS` 后，三组
仍返回同一个 800px JPEG，最终把未转换根因锁定到生产 Worker 调用拓扑，后续按上方根因文档
继续修复。
