# `refactor/architecture-completion` 当前分支代码审查与修复报告

日期：2026-08-04
审查分支：`refactor/architecture-completion`
对比基线：`main` / `1756c30cd05085135a81011d177bf71bcb95d0b9`
审查范围：分支上 7 个提交、121 个已提交变更文件，以及本次审查产生的未提交修复

## 结论

本分支的重构方向总体正确：数据库、对象存储、WS 契约、Desktop 投影和发布能力开始形成清楚边界。但审查前的版本仍不适合直接合并，原因不是代码风格，而是存在会导致文件不可见、数据引用失效、发布制品无法启动或签名失去意义的实际缺陷。

本轮已修复确认问题，没有增加宽泛 CI 门禁，没有用 fallback 隐藏错误，也没有修改 Python 科学算法。修复后的核心结论是：

- PostgreSQL 是上传文件生命周期的唯一业务事实源；物理 metadata 只是可重建投影。
- 文件版本晋升、气象数据索引和 session 最新指针均具有明确事务边界。
- Thread 永久清理先提交数据库事实，再清理物理投影；气象数据集作为独立 CAS 引用不会随来源 Thread 被误回收。
- Runtime Service 保持仓库相对运行布局，可执行锁定安装；SBOM、manifest 和运行时 capability 使用同一版本常量。
- 已签名制品只能由部署侧可信公钥验证，制品不能自带并自证信任根。
- Desktop 增量投影、虚拟列表、固定 Contents 面板和能力握手的本轮回归已修复。

## 审查方法

采用 3 个并行只读审查面，再由主任务统一复核和落地：

1. Server / PostgreSQL / 文件与气象生命周期。
2. Desktop / 对话投影 / 虚拟列表 / 运行时握手。
3. Runtime Service / npm 与 uv 锁定安装 / SBOM / 签名边界。

所有结论都以具体调用链、事务顺序或可复现测试为依据；未发现证据的推测没有进入修复范围。

## 已确认并修复的问题

| ID | 严重度 | 问题 | 修复结果 |
| --- | --- | --- | --- |
| F-01 | High | 启动完整性检查只按裸 SHA256 路径读取对象，但上传对象保留 `.nc`、`.tif` 等扩展名，正常上传会被误判为损坏 | 上传和气象引用改按 DB 中的精确相对路径、大小和 SHA256 校验；裸 CAS 引用继续按 hash 校验 |
| F-02 | High | 同一 `threadId + sourceKey` 的并发上传可能互相退役，最终出现 0 个 ready 版本 | `promoteReadyAndRetire` 在单事务内锁 Thread、退役旧版本并晋升当前版本；迁移 010 归一化历史重复 ready 后建立部分唯一索引 |
| F-03 | High | 气象 dataset 插入和 session 最新指针分两次写；第二步失败会留下指向已补偿删除文件的 ready dataset | dataset 与 session 指针合并为一个数据库事务；事务失败后才补偿已发布文件 |
| F-04 | High | 永久清理 Thread 先删物理文件、后删 DB；DB 失败时可恢复 Thread 已失去附件 | 改为 DB-first；数据库失败时不触碰 payload 或物理 metadata，并有行为测试锁定顺序 |
| F-05 | High | 气象数据可在 Session 内跨 Thread 使用，但来源 Thread purge 后文件账本被级联删除，CAS 又可能被 GC | ready 气象 dataset 的 hash 成为独立 GC 引用；启动时按 dataset 精确路径校验，Thread 可安全变为 `null` |
| F-06 | High | Agent 上下文仍从物理 metadata 列文件，可能把 DB pending/failed/deleted 上传注入模型 | ContextManager 改读 DB-backed `fileLifecycle.list`；`PlatformPersistenceFacade.fileLifecycle` 改为必需注入，移除 runtimeFiles fallback |
| F-07 | High | 迁移 009 只建空表，旧 runtime metadata 会从业务列表中静默消失 | 增加显式迁移命令：默认 dry-run，校验 Thread 归属、路径、大小和 SHA256；`--confirm` 才事务写 DB 并归档旧幂等索引；启动不自动 fallback |
| F-08 | High | Runtime Service 把 Server、Worker、迁移放在与 Supervisor 约定不一致的目录，且 package/lock 不在同一安装根 | 制品恢复 `apps/server`、`apps/worker`、`packages/*`、`infra/migrations` 和 `scripts/*` 运行布局；生成窄 workspace package/lock |
| F-09 | High | `--out . --force` 可递归删除仓库，任意已有目录也可被覆盖 | 拒绝仓库根及祖先、符号链接；已有目录必须含本脚本专用 ownership marker 才允许 `--force` |
| F-10 | High | Ed25519 公钥与签名一起放在制品内，攻击者可替换内容后使用自己的密钥重签 | 签名只保存 key fingerprint；验证签名制品必须显式提供部署侧 `--trusted-public-key`，攻击者公钥和缺失公钥都失败 |
| F-11 | High | npm lock v3 大多数 entry 没有 `name` 字段，旧 SBOM 漏掉绝大多数运行依赖且混入 Desktop/Console | 从锁文件解析 Server/Supervisor 的生产依赖闭包并由 verifier 精确比对；生产安装不包含 Electron、Vitest、Vite 或 tsx |
| F-12 | Medium | manifest 使用 `+runtime-service`，API capability 默认报告 `+workspace`，形成两个 releaseId 事实 | API 优先读取显式环境值，其次严格读取部署根 manifest；只有 manifest 确实不存在时才使用开发 workspace ID |
| F-13 | Medium | `run:start` 在启动后台任务后才建立 WS 订阅，极快运行可能丢失首批 item/event | `StartRunService` 在 `startDetached` 前执行必需的 `beforeLaunch` 观察边界，并测试调用顺序 |
| F-14 | Medium | 对话投影为把 assistant preamble 移到 tool 前而直接 splice 已排序索引，后续二分插入会错位 | 内部 `orderedIds` 永远保持基础比较器顺序；preamble 规则只在快照物化时稳定投影 |
| F-15 | Medium | WorkspaceShell 拆分后，永久 Contents 面板错误出现关闭按钮 | WorkspaceShell 使用纯装配 helper，Contents 固定不可关闭；装配级测试验证 `onClose === undefined` |
| F-16 | Medium | 虚拟时间线丢失行间距，并把 overscan 第一项当成首个可见项 | Virtualizer 显式设置 16px gap；高亮依据 viewport 与虚拟列表的实际偏移选择首个可见项 |
| F-17 | Medium | Desktop 用每次 status 都递增的 supervisor sequence 缓存 capability，导致每 5 秒重复握手 | 改按 API `pid + startedAt + restartCount` 缓存；API restart 后重握手，失败不会污染新身份缓存 |
| F-18 | Medium | 新拆出的 `packages/db/dist` 没进入统一开发前置构建，干净工作区可能无法启动 Server | 开发启动器和 Server dev/test 生命周期显式先构建 DB workspace |
| F-19 | Medium | 架构清单只比较 WS 命令数量，相同数量但不同集合仍会被接受 | 生成器改为比较排序后的完整命令集合，并报告双方缺项 |

## 关键实现边界

### 文件生命周期

```text
reserve pending (DB)
        ↓
publish CAS + physical metadata
        ↓
transaction: lock thread → retire previous ready → promote current ready
        ↓
best-effort idempotent cleanup of retired physical metadata
```

数据库提交失败时，pending 事实保留并记录错误，调用方得到真实失败；不会返回伪成功。物理清理失败发生在数据库提交之后，重试同一 requestId 会重新执行幂等清理。

### 气象上传

```text
file lifecycle upload
        ↓
transaction: insert dataset + update session.latestMeteorologicalDatasetId
        ↓
update in-memory projection
```

事务失败才删除已发布文件。气象 dataset 自身持有 `fileRelativePath + contentHash + sizeBytes`，因此来源 Thread 被永久清理后仍可作为 Session 资源读取并阻止 CAS 被回收。

### Runtime Service 信任边界

- Builder 负责内容、锁文件、manifest、SBOM 和签名。
- Artifact 内只保存签名与可信公钥指纹，不保存可被 verifier 自动信任的公钥。
- Verifier 的信任根来自部署环境显式提供的公钥。
- 未签名制品可做 checksum/结构校验；生产需要签名时使用 `--require-signature`。

## 数据升级说明

升级已有运行目录时，顺序应为：

1. 备份 PostgreSQL 与 `RUNTIME_ROOT`。
2. 停止 API/Worker 写入。
3. 应用 `009_file_object_lifecycle.sql` 和 `010_file_ready_source_invariant.sql`。
4. 运行 `npm run migrate:file-lifecycle` 查看 dry-run 结果。
5. 确认数量和路径后运行 `npm run migrate:file-lifecycle -- --confirm`。
6. 启动服务，由完整性检查复核 DB ledger 与物理投影。

迁移命令不自动猜测缺失 Thread 的归属，不会把无法证明所有权的 metadata 导入数据库。

## 有意未做与残余风险

1. 没有引入未消费的 outbox 半成品。Thread purge 在 DB 提交后、物理 metadata 清理前若进程崩溃，可能留下不可见的物理投影；不会丢失数据库事实或误删仍被引用的 CAS，但下一次完整性检查会显式报告，需要运维处理。若未来要求自动重试，应单独实现可 claim/retry/ack 的持久 cleanup outbox consumer。
2. 生产签名私钥和部署侧可信公钥不写入仓库；密钥发放、轮换和目标机权限属于部署任务。
3. 本轮没有修改 `packages/gis-meteorology` 的科学算法、ReaderFacade 或算法服务结构。
4. 多实例共享限流、真实后端 Electron approval E2E 等既有未完成项不属于本次分支 diff 修复范围。

## 验证记录

本轮分项验证已通过：

- Server：107 个测试文件、546 个测试通过，另 2 个文件/4 个测试按条件跳过。
- Server build：通过。
- Operations Supervisor：60 个测试通过。
- Conversation projection 定向测试：通过。
- Desktop 定向回归：19 个测试通过；renderer/node typecheck 通过；定向 ESLint 0 error。
- Runtime release core：4 个测试通过。
- 裁剪制品真实执行 `npm ci --omit=dev`：通过；未安装 Electron、Vitest、Vite、tsx。
- Ed25519 验证：正确部署公钥通过；缺少公钥、攻击者公钥均失败。
- `git diff --check`：通过。
- 旧数据迁移命令已完成语法、参数和真实数据库基线检查；当前本机数据库尚未应用 009，因此 dry-run 按设计硬失败并明确要求先迁移 DB。

最终全工作区回归结果以本报告后续更新为准。

## 合并建议

在最终全工作区测试和真实 PostGIS migration 回归完成后可以进入提交整理。建议按以下边界拆分提交，便于审阅和回退：

1. Server 文件/气象一致性与迁移。
2. Desktop 投影、虚拟化和握手回归。
3. Runtime Service 布局、SBOM、签名与 release capability。
4. 开发构建顺序、显式旧数据迁移脚本和审查报告。

当前修复保持未提交状态，未替用户自动合并或推送。
