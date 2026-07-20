# `.cc` 索引发布安全重构实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 `.cc` 归档与 sitemap 在只读站点根、进程崩溃和并发请求下仍以完整一致的一代原子发布。

**Architecture:** 所有生成内容写入 `${CC_SYNC_STATE_DIR}/public/generations/<uuid>/`，目录内包含 `ai-news/`、`sitemaps/`、`sitemap.xml` 和 `manifest.json`。全部文件及目录 fsync 后，发布器以受控相对符号链接 `generations/<uuid>` 单次原子替换 `public/current`；Nginx Task 10 只通过 `public/current/...` 暴露动态公开文件。持久 journal 记录 prepared/current/previous，恢复和 GC 仅处理经过安全名称、真实目录及固定父链校验的 generation，并至少保留 current 与 previous。

**Tech Stack:** Node.js 18 ESM、`node:fs/promises`、Node test runner、Bash、Nginx alias。

---

### Task 1: 用失败测试固定只读 siteRoot 与 generation 布局

**Files:**
- Modify: `cc-site/sync/test/publish-indexes.test.mjs`
- Modify: `cc-site/sync/publish-indexes.mjs`

**Steps:**

1. 写测试：`siteRoot` 根和祖先不可写，只有 `siteRoot/i` 与 `stateDir` 可写时仍能发布；发布后 `siteRoot` 除原文件外不新增 `ai-news` 或 stage。
2. 写测试：`public/current` 必须是仅指向 `generations/<UUID>` 的相对 symlink，拒绝绝对路径、`..`、外部 symlink 和不安全 generation 名。
3. 运行定向测试，确认旧实现失败。
4. 把归档、分片和根 sitemap 全部迁入 stateDir generation；siteRoot 只用于固定链与 `sitemap-static.xml` 检查。
5. 运行定向测试，确认通过。

### Task 2: 实现 journal、原子切换、恢复和双代保留

**Files:**
- Modify: `cc-site/sync/test/publish-indexes.test.mjs`
- Create: `cc-site/sync/test/fixtures/publish-and-pause.mjs`
- Modify: `cc-site/sync/publish-indexes.mjs`

**Steps:**

1. 写真实子进程测试：初始代发布后，子进程构建下一代并分别在 prepared、current swap 后暂停；父进程发送 `SIGKILL`。
2. 重启发布器，断言 `current` 始终解析到完整代，journal 被恢复，孤立 stage 被清理，current 与 previous 均保留，其他安全孤儿才被 GC。
3. 运行测试确认旧实现失败。
4. 实现 durable journal、generation stage→immutable rename、相对 symlink 临时项→`current` 原子 rename、目录 fsync、启动恢复和保守 GC。
5. 在切换前后校验 generation 真实目录身份；绝不跟随或删除未固定的 replacement symlink。
6. 运行发布器测试确认通过。

### Task 3: 收紧调用入口、README 与 sitemap 时间语义

**Files:**
- Modify: `cc-site/sync/publish-indexes.mjs`
- Modify: `cc-site/sync/sync.mjs`
- Modify: `cc-site/sync/test/sync.test.mjs`
- Modify: `cc-site/README.md`
- Modify: `docs/plans/2026-07-20-cc-content-mirror-implementation.md`

**Steps:**

1. 移除 `publish-indexes.mjs` 独立 CLI，使发布只经已持有 `acquireSyncLock` 的 `runSync` 调用。
2. 增加并发测试，证明第二个同步进程不能进入发布阶段。
3. 文档更新为 Task 10 Nginx alias `public/current/ai-news/`、`public/current/sitemaps/`、`public/current/sitemap.xml`，systemd 不再开放 `siteRoot/ai-news`。
4. item sitemap 不再把 `published_at` 冒充修改时间；state 无镜像修改时间字段时省略 `lastmod`，归档 lastmod 仅使用真实 generation 时间。

### Task 4: 加固静态部署脚本并冻结验证文件

**Files:**
- Modify: `cc-site/deploy.sh`
- Modify: `cc-site/sync/test/publish-indexes.test.mjs`

**Steps:**

1. 写脚本静态测试：远端块含 `set -euo pipefail`、唯一 `mktemp -d`、trap、逐文件 `sudo install -o www -g www -m 0644`。
2. 写 smoke 测试：`curl --fail --max-time` 严格要求 200；四个验证文件用固定 SHA-256 和字节数校验；任何失败不能到达成功输出。
3. 重写脚本并运行 `bash -n`。
4. 确认四个验证文件工作树内容和固定 SHA 未改变。

### Task 5: 补齐合规页脚与移动导航

**Files:**
- Modify: `cc-site/sync/publish-indexes.mjs`
- Modify: `cc-site/cc-prompts/index.html`
- Modify: `cc-site/cc-prompts/best-practices.html`
- Modify: `cc-site/cc-prompts/common-workflows.html`
- Modify: `cc-site/cc-prompts/how-anthropic-teams-use-claude-code.html`
- Modify: `cc-site/style.css`
- Modify: `cc-site/sync/test/publish-indexes.test.mjs`

**Steps:**

1. 写失败测试，要求归档页及四个 prompts 页面同时包含 ICP、公安备案、公安图标、支持邮箱和隐私/条款/联系链接。
2. 给归档 renderer 和四页加入同一固定合规页脚。
3. 调整移动端导航断点，避免首页导航在窄屏拥挤。
4. 跑定向测试确认通过。

### Task 6: 完整验收并提交

**Files:**
- Verify all modified files.

**Steps:**

1. 运行 `node --test cc-site/sync/test/publish-indexes.test.mjs`。
2. 运行 `node --test cc-site/sync/test/*.test.mjs`。
3. 运行 `bash -n cc-site/deploy.sh`。
4. 运行 `node --check cc-site/sync/publish-indexes.mjs` 和 `node --check cc-site/sync/sync.mjs`。
5. 运行 `xmllint --noout cc-site/sitemap-static.xml` 与 `git diff --check`。
6. 检查验证文件 SHA/字节数、只读 siteRoot 夹具和 worktree 状态。
7. 提交 `fix(cc): 原子发布只读站点索引` 并回报 SHA 与验证结果。
