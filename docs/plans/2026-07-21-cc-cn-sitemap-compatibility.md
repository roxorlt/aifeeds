# 国内搜索平台稳定 Sitemap Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在保留现有 generation sitemap 原子发布模型的同时，生成百度可逐片长期登记、神马可通过稳定索引抓取的一组国内平台专用 sitemap，并安全合入 `main`、部署生产、输出四家最终提交地址。

**Architecture:** 现有 `/sitemap.xml` 与 `/sitemaps/<uuid>/...` 保持不变。每个完整 generation 额外生成稳定入口 `/sitemap-cn.xml` 与 `/sitemap-cn-NNNN.xml`；Nginx 从原子 `public/current` 暴露它们。`sitemap-cn.xml` 是一层索引且每个子项带真实 `lastmod`，内容叶子最多 10,000 URL；manifest 保存叶子高水位，内容量下降时继续发布安全空 `urlset`，保证百度已登记的文件不变成 404。

**Tech Stack:** Node.js 18+ ESM、`node:test`、Nginx alias、Bash 事务部署器、systemd、Cloudflare Worker/D1、腾讯云 VPS。

---

### Task 1: 同步主线并锁定发布器契约

**Files:**
- Create: `docs/plans/2026-07-21-cc-cn-sitemap-compatibility.md`
- Merge: `main` into `feat/cc-content-mirror`

**Step 1: 保存本计划并提交**

```bash
git add docs/plans/2026-07-21-cc-cn-sitemap-compatibility.md
git commit -m "docs(cc): plan domestic sitemap compatibility"
```

**Step 2: 合入当前 main**

```bash
git merge main
```

只解决当前功能分支与 `main` 的真实冲突，不改动 `main` 工作树现有未跟踪文件。

**Step 3: 跑 sitemap/部署基线测试**

```bash
cd cc-site/sync
node --test test/publish-indexes.test.mjs test/deployment.test.mjs
```

Expected: 现有测试 0 failure。

### Task 2: 先写稳定 CN sitemap 的失败测试

**Files:**
- Modify: `cc-site/sync/test/publish-indexes.test.mjs`
- Test: `cc-site/sync/test/publish-indexes.test.mjs`

**Step 1: 写首发结构测试**

测试一次 publication 后：

- `public/current/sitemap-cn.xml` 存在且为一层 `<sitemapindex>`；
- 存在 `sitemap-cn-0001.xml`；
- 索引对子 sitemap 与 `sitemap-static.xml` 都给出 `<lastmod>`；
- 稳定叶子包含归档 URL 与 item URL，不混入 `.com`；
- manifest 含 `cn_sitemap_leaf_count: 1`。

**Step 2: 写 10,001 边界测试**

构造足够 URL，让专用内容集超过 10,000：断言 `0001` 正好 10,000，`0002` 为余数；每片 XML 小于 10 MB。

**Step 3: 写高水位测试**

先发布两片，再把状态缩到一片：断言 `0002` 仍是 200 对应的常规空 `<urlset>`、根索引仍引用它、manifest 高水位仍为 2。

**Step 4: 写旧 manifest 兼容测试**

旧 generation 没有 `cn_sitemap_leaf_count` 时仍能恢复与 GC；新的 sitemap URL schema 会迫使当前状态重建为含 CN sitemap 的 generation。

**Step 5: 验证 RED**

```bash
cd cc-site/sync
node --test test/publish-indexes.test.mjs
```

Expected: 新测试因 `sitemap-cn.xml`/叶子/manifest 字段不存在而失败，旧测试仍通过到新增断言处。

### Task 3: 最小实现稳定 CN sitemap

**Files:**
- Modify: `cc-site/sync/publish-indexes.mjs`
- Test: `cc-site/sync/test/publish-indexes.test.mjs`

**Step 1: 定义兼容常量与文件名**

```js
const CN_SITEMAP_SHARD_SIZE = 10_000;
const CN_SITEMAP_MAX_BYTES = 10 * 1024 * 1024;
const CN_SITEMAP_MAX_SHARDS = 9_999;
```

文件名固定为 `sitemap-cn-${String(n).padStart(4, '0')}.xml`，编号从 1 开始。

**Step 2: 让索引渲染支持真实 lastmod**

索引 renderer 接收 `{loc,lastmod}`，现有 generation 根索引继续省略 `lastmod`；CN 索引的静态 sitemap 使用已固定 inode 的真实 mtime，CN 叶子使用 generation `generatedAt`。

**Step 3: 生成稳定叶子**

专用叶子按“归档 URL + item URL”确定性顺序切片，每片最多 10,000 URL；写文件后用实际 UTF-8 byte length 断言 `< 10 MB`。

**Step 4: 保存并继承高水位**

`readManifest` 对旧 manifest 缺少字段返回 `null`；新 manifest 写 `cn_sitemap_leaf_count`。新 generation 的叶子数取 `max(当前需要数, 当前 manifest 高水位, 1)`，多余编号写空 `urlset`。

**Step 5: 版本与完整性**

把 `SITEMAP_URL_SCHEMA` 递增，确保旧状态即使内容未变也重建。`validateGenerationComplete` 仅对带新字段的 generation 强制检查 `sitemap-cn.xml` 与全部编号叶子，旧 generation 仍可恢复、保留与 GC。

**Step 6: 验证 GREEN**

```bash
cd cc-site/sync
node --test test/publish-indexes.test.mjs
```

Expected: 全部通过。

**Step 7: 提交**

```bash
git add cc-site/sync/publish-indexes.mjs cc-site/sync/test/publish-indexes.test.mjs
git commit -m "feat(cc): publish stable domestic sitemap shards"
```

### Task 4: Nginx 与部署事务暴露稳定文件

**Files:**
- Modify: `cc-site/sync/test/deployment.test.mjs`
- Modify: `cc-site/sync/nginx-content-mirror.conf`
- Modify: `cc-site/sync/install-remote.sh`

**Step 1: 写 Nginx RED 测试**

断言：

- `location = /sitemap-cn.xml` 精确 alias 到 `public/current/sitemap-cn.xml`；
- 仅 `/sitemap-cn-[0-9]{4}.xml` alias 到 current 对应文件；
- 路径后缀、大小写变体、编码/穿越不能命中；
- 两个 location 都有 `application/xml` 与 600 秒缓存；
- 不覆盖 `/auth/wechat/`。

**Step 2: 写 installer RED 测试**

远端 harness 的 fake service 生成 CN 索引和 `0001`；installer 必须以 Nginx 用户验证可读，并在 reload 后通过 127.0.0.1 HTTPS 精确字节 smoke 两个稳定地址。错误状态或错误字节必须回滚。

**Step 3: 验证 RED**

```bash
cd cc-site/sync
node --test test/deployment.test.mjs
```

Expected: 新稳定路由与 smoke 断言失败。

**Step 4: 最小 Nginx 实现**

添加精确 index location 与严格四位分片 regex location，alias 只落 `public/current` 固定文件名。

**Step 5: 最小 installer 实现**

在激活 timer 前验证 `sitemap-cn.xml` 与第一个叶子可读，并用 `smoke_exact` 校验线上字节。

**Step 6: 验证 GREEN**

```bash
cd cc-site/sync
node --test test/deployment.test.mjs
bash -n install-remote.sh
```

Expected: 全部通过。

**Step 7: 提交**

```bash
git add cc-site/sync/nginx-content-mirror.conf \
  cc-site/sync/install-remote.sh cc-site/sync/test/deployment.test.mjs
git commit -m "feat(cc): expose stable domestic sitemaps"
```

### Task 5: 文档与最终 URL 生成规则

**Files:**
- Modify: `cc-site/README.md`
- Modify: `cc-site/sync/README.md`
- Modify: `docs/operations.md`
- Modify: `docs/cc-search-engine-submission-runbook.md`

**Step 1: 更新所有权和发布边界**

记录 `sitemap-cn.xml`/叶子归同步器 generation 管理，人工 `deploy.sh` 不写这些文件。

**Step 2: 更新四家提交规则**

- 360：`https://ai-feeds.cc/sitemap-cn.xml`
- 搜狗：获邀后提交 `https://ai-feeds.cc/sitemap-cn.xml`
- 神马：`https://ai-feeds.cc/sitemap-cn.xml`
- 百度：逐个提交 `sitemap-static.xml` 与生产 `sitemap-cn-NNNN.xml`；不得提交 index。

**Step 3: 更新生产验收命令**

加入 CN index XML、所有子项 200、每片 URL 数/bytes、索引 `lastmod`、同域与重复 URL 检查。

**Step 4: 检查并提交**

```bash
git diff --check
git add cc-site/README.md cc-site/sync/README.md docs/operations.md \
  docs/cc-search-engine-submission-runbook.md
git commit -m "docs(cc): document final search submission URLs"
```

### Task 6: 完整验证与本地合版

**Files:**
- No new files unless verification finds a defect.

**Step 1: 静态检查**

```bash
for file in cc-site/sync/*.mjs; do node --check "$file"; done
bash -n cc-site/sync/deploy-to-cc.sh
bash -n cc-site/sync/install-remote.sh
git diff --check
```

**Step 2: 完整同步器测试**

```bash
cd cc-site/sync
npm test
```

Expected: 0 failure。

**Step 3: Worker 回归**

```bash
cd worker
npm test
npx tsc --noEmit
```

Expected: 0 failure，TypeScript 编译成功。

**Step 4: Linux/glibc helper smoke**

用本机 Docker 运行 `deployment-linux-fs.py probe/move/remove`，Expected: 0 failure。

**Step 5: 合入 main**

先备份 `main` 工作树中与 merge 目标重名的未跟踪计划文件，保留 SHA-256；然后在 `/Users/roxor/brain/30-projects/aifeeds` 执行非破坏性 merge。不得删除其他用户文件。

```bash
git merge --no-ff feat/cc-content-mirror
```

合并结果再次执行 sitemap/deployment 定向测试。

### Task 7: 生产迁移、部署与验收

**Files:**
- No source edits unless rollout reveals a defect.

**Step 1: D1 只读预检**

检查 migration 表、`cc_item_*` 表/索引是否存在及候选 URL 最大长度；不输出任何 secret。

**Step 2: 依次应用 migration**

仅对尚未应用的 `029 → 030 → 031` 执行远端 migration，并用 `PRAGMA` 验证最终结构。

**Step 3: 配置 Worker secret 并部署**

从 `.secrets/aifeeds-prod.env` 通过标准输入写 `CC_SYNC_SECRET`，不进入 argv/日志；先保持 `CC_MIRROR_ENABLED` 关闭。部署 Worker 后检查 `/api/cc-sync/health` 的鉴权行为。

**Step 4: 部署静态根文件与同步器**

```bash
./cc-site/deploy.sh
./cc-site/sync/deploy-to-cc.sh prod
```

安装器自身必须通过完整 payload tests、Nginx transaction、127.0.0.1 精确字节 smoke 后才提交 timer。

**Step 5: 分批 backfill 与抽查**

按既有 source policy 顺序运行后台 backfill；每批记录 live/review/deny/pending，国内来源命中必须为 0，发现应拦未拦立即停止。所有批次完成前不打开自动增量。

**Step 6: 开启增量**

回填与抽查通过后把 `CC_MIRROR_ENABLED=1` 作为 Worker secret，再部署 Worker；观察新事件、同步 timer 与删除闭环。

**Step 7: 生产 sitemap 验收**

确认：

- `/sitemap-cn.xml` 200、XML 合法、所有 child 有 `lastmod`；
- 所有 `/sitemap-cn-NNNN.xml` 200、每片 `<=10000` URL 且 `<10MB`；
- 内容 URL 全为 `.cc`、抽样页面 200、自 canonical、无自动跳转；
- 四个验证文件仍为预期内容；
- `robots.txt` 与通用 `/sitemap.xml` 正常。

**Step 8: 输出最终提交清单**

从生产 `sitemap-cn.xml` 读取实际叶子数量，向用户提供：

- 360、搜狗、神马各自唯一索引 URL；
- 百度需要逐个填写的完整稳定叶子 URL 列表及 `sitemap-static.xml`；
- 每个平台的菜单位置、权限前提和点击顺序。

