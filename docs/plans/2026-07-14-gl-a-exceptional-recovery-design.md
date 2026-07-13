# GL-a 可审计异常恢复设计

## 背景与结论

GL-a 操作在 `mutation_started` 阶段发现生产机缺少 `/usr/sbin/logrotate`。前向安装器已经创建并
记录了 site backup、若干 runtime candidates、一个尚未发布的 rotation-state candidate 和一个空的
allocated rotation anchor；生产 site 本身仍是原始配置。旧版不可变 rollback helper 随后把
rollback journal 写成 `rollback_failed(failed_from=prepared)`。

安装 `logrotate` 后再次运行同一不可变 helper 仍然失败。无网络 Docker 复现和 `bash -x` 证明失败点
是 `persist_rotation_state_identity`：rotation-state 已经在 candidate 路径完成初始化，但 live 路径尚
不存在、snapshot 仍为 `null`。旧 helper 只允许 `runtime_removed/nginx_reloaded/logs_archived` 从这种
形态恢复，因此 `prepared` 必然 fail closed。生产只读审计也确认 journal 记录的 inode 当前仍位于
operation-bound candidate 路径，原 inode 没有丢失或被未知对象替换。

不能直接替换旧 helper：source/rollback journals 已绑定旧 helper SHA。也不能伪装旧 helper 成功、手工
改 journal phase，或简单删除 journals；这些做法都会削弱或伪造证据链。

## 目标与非目标

目标：

- 修复未来 helper 对“已初始化、尚未发布的 rotation-state candidate”的正常恢复能力。
- 为当前已绑定旧 helper 的操作提供显式授权、单独记录执行器 SHA、可重入且 fail-closed 的兼容恢复。
- 复用现有 rollback CAS、cleanup plan、terminal pair 和 commit marker，不另写一套低保证删除脚本。
- 保留原 source/rollback journals 的历史链，并让最终记录清楚区分“事务绑定 helper”和“实际恢复执行器”。
- 只有当前操作绑定的 inode/hash 可以被清理；site、Nginx、Worker、Pages、DNS、证书和数据均不在范围内。

非目标：

- 不通过 feature branch 发布生产业务代码。
- 不把 RUM 观察重新变成代码交付阻塞项。
- 不启用全局 `logrotate.timer`。
- 不自动执行生产恢复；隔离验证完成后仍需对精确命令单独审批。

## 方案选择

采用“现有 helper 的显式 exceptional compatibility mode”。新版 helper 仍以自身 SHA 作为普通路径的
唯一执行权威；只有额外传入一份严格格式的 operation-specific authority 时，才允许它恢复一个绑定
旧 helper SHA 的事务。terminal journals 中的 `rollback_helper_sha256` 继续表示前向事务绑定的 helper，
另外的 authority/receipt 永久记录实际 recovery executor SHA，避免冒充旧 helper。

未采用两种替代方案：

1. 直接绕过 self-SHA 或令新版 helper 假报旧 SHA：实现快，但审计记录会错误归因。
2. 手工移动/删除 candidates 和 journals：不能复用已有 CAS、崩溃恢复和 terminal pair，重入风险更高。

## 正常恢复修复

`persist_rotation_state_identity` 在 live rotation-state 缺失、identity 非空时增加一个窄分支。只有同时满足
以下条件才接受 candidate：

- candidate 是 operation-bound 精确路径、非 symlink，目录 dev/inode/uid/gid/mode 与 journal 一致；
- provenance 文件的 dev/inode/genesis hash 与 journal 一致；
- checker 来自已记录的 live/candidate runtime artifact，精确匹配 hash 与 inode；
- `rotation-verify-initialized` 对 candidate 成功，返回 committed genesis snapshot；
- journal snapshot 原为 `null`，anchor 为 `allocated`，runtime inventory 尚未 sealed；
- resume phase 仅为 `none` 或 `prepared`，source origin 仅为允许创建该 candidate 的前向阶段。

helper 将验证得到的 snapshot 通过现有 journal CAS 持久化，然后由现有 runtime cleanup plan 删除
provenance、state directory、allocated anchor 和其他 operation-owned candidates。任何身份不匹配、未知
残留、snapshot 漂移或并发变化都保持 fail closed。

## Exceptional authority 与 receipt

兼容恢复调用保留原九个参数，并可选增加第十个 authority 文件。普通调用仍必须是九个参数。authority
输入位于 root-only staging 目录，必须是 regular file、非 symlink、`root:root 0600`，并使用精确字段：

- schema、gate、phase 和 operation id；
- G0 commit、source/rollback journal 的规范路径与恢复前 SHA；
- transaction-bound rollback helper SHA；
- recovery executor SHA（必须等于当前 `$0` 的 SHA，且必须不同于事务 helper）；
- defect code `initialized_rotation_candidate_prepublication`；
- operator、独立 rollback owner、批准时间和批准证据 SHA。

helper 在任何 journal/runtime mutation 前完成 authority、source、rollback、site base 与执行器自校验，并将
authority 用 no-replace + fsync 固化到 backup root。已存在时只能接受完全相同 bytes/inode authority，
不允许覆盖。

成功生成原有 terminal source journal、terminal rollback journal 和 rollback commit marker 后，再原子写入
deterministic receipt。receipt 绑定 authority SHA、恢复前两个 journal SHA、事务 helper SHA、实际执行器
SHA，以及三个 terminal 文件 SHA。重入时 terminal pair 已完成但 receipt 尚未落盘，helper 必须先补齐同一
receipt 再报告成功。authority 存在而 receipt/terminal pair 不完整时，新 installer 继续 NO-GO。

## 数据流与失败处理

1. 本地 clean G0 生成新版 helper、authority 模板、manifest 与证据目录。
2. 隔离 runbook 在生产只读复核 source/rollback SHA、所有候选 inode/hash、site base、Nginx 和全局 timer。
3. 用户批准精确命令后，将包复制到新的 root-only `/run` 目录。
4. 新版 helper 验证 exceptional authority，自身 SHA 与事务绑定 SHA 分离记录。
5. helper 验证 initialized candidate，CAS 写入 snapshot，执行现有 site/runtime cleanup 状态机。
6. helper 写 terminal pair、commit marker、exceptional receipt；runbook 再做只读终态复核。
7. 任一步失败立即停止；不运行 installer、不创建新 operation、不推进 staging/main。
8. 全部终态验证通过后，重新执行完整 G0，并用新的 operation id 重跑 GL-a。

authority 在 mutation 前已持久化，所以异常退出后不会失去“谁被授权执行”的证据。cleanup 继续使用已有
tombstone/cursor/CAS；未知 takeover、同 bytes 不同 inode、journal predecessor 漂移、Nginx/HTTP 探针失败
或 terminal receipt 不一致均阻止成功。

## 测试与验收

独立 Docker contract 不改变已冻结的 135 场 GL-a matrix 数量：

- 缺少 `/usr/sbin/logrotate` 时在任何 backup/candidate/journal mutation 前以确定性错误退出。
- 制造“预检后 logrotate 消失”的 initialized-candidate 状态；新版普通 helper 能自动回滚。
- 用带测试注释的 staged legacy helper 绑定不同 SHA，并通过 fixture-only fault hook 留出与生产一致的
  `rollback_failed(prepared)`；新版 helper 无 authority、authority 字段错误、SHA 错误时全部拒绝且零 mutation。
- 正确 authority 时清理全部 operation-owned candidates，保留 backup，写 terminal pair、marker、authority
  和 receipt；第二次执行幂等成功。
- 在 authority 固化、snapshot CAS、cleanup cursor、terminal pair 和 receipt publication 周围注入 crash，
  每个重入点都只能收敛或 fail closed。
- 完成 shell syntax、135 matrix、相关 Python/Node 测试以及全 G0；随后才准备生产命令审批。

