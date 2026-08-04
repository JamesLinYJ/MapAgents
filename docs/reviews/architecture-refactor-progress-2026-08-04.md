# Newmap 架构重构进度报告

日期：2026-08-04
分支：`refactor/architecture-completion`

本报告记录当前分支对整体架构审查建议的落地情况。目标是让 Desktop、Node API、Worker、数据库和对象存储的边界清楚、可测试、可发布；不增加与业务无关的门禁，不用 fallback 或静默兼容掩盖真实失败。

## 结论

本分支已经完成文件/结果事实源、WS/桌面传输契约、运行启动边界、对话投影和发布能力握手等范围，并完成回归验证。Worker 的子进程执行、生命周期和安全边界已核验，但没有修改 Python 算法包。整体审查建议仍有明确未完成项，下面用 `[x]` 表示已完成、`[ ]` 表示未完成或仅部分完成。

## 状态总览

| 状态 | 范围 | 当前结论 |
| --- | --- | --- |
| [x] | 数据库/文件生命周期事实源 | 已落地 `pending → ready → deleted`、幂等上传、补偿删除和对象引用回收；Drizzle schema/connection 已归入 `packages/db`，并有连接工厂回归测试 |
| [x] | 工具结果提交与 Run 启动应用边界 | 已落地 `ToolResultCommitService`、`ToolExecutionPolicy`、`StartRunService` |
| [x] | Desktop/Server WS、IPC 和 HTTP 传输契约 | 已集中共享 schema，并对响应执行运行时校验 |
| [x] | 共享契约回归测试 | 已覆盖 WS command 一对一映射、交付 artifact 引用和 Worker catalog schema hash |
| [x] | HTTP 模型适配器边界测试 | 已覆盖 Anthropic、Gemini、Ollama 的请求路径、认证头和响应映射；不触发真实外部网络 |
| [x] | 对话投影和实时列表性能 | 已落地共享投影索引、live overlay 合并和虚拟列表 |
| [x] | 默认模型首问冷 DNS | 已在 API 监听前完成已配置默认 provider 的 transport 预热 |
| [x] | Worker 执行边界 | 已核验子进程、超时/取消/关闭回收、nonce/concurrency lease、HMAC 和路径沙箱；未修改科学算法源码 |
| [x] | Runtime Service 制品与协议握手 | 已生成可校验 manifest，并在 Desktop 启动时检查 API/Desktop 协议兼容性 |
| [ ] | Python `ReaderFacade`、reader/service 算法整理 | 未做，按用户要求暂不修改 |
| [ ] | Python Worker/科学算法内部结构性重构 | Worker Web 层已有模块化入口和执行边界；算法内部 `ReaderFacade`/service 拆分按用户要求暂缓 |
| [x] | 真实 PostgreSQL/PostGIS/Testcontainers 集成回归 | 已增加显式 `npm run test:postgis`，真实 `postgis/postgis:16-3.5` 容器执行全部迁移、schema 兼容性、空间图层导入/筛选/计数/删除回归 |
| [ ] | 多实例共享限流后端 | 当前仍是单进程内存限流；本轮只修正可信 socket peer 的客户端 IP 取值，未引入 Redis/Postgres 计数后端 |
| [ ] | Worker HTTP 重试/退避策略 | 当前 Worker 调用保持单次请求并显式上抛错误；需要先定义幂等性和按工具分类的重试策略，暂未加入自动重试 |
| [ ] | 真实后端 E2E（run stream + approval） | Electron 用例已存在，但真实后端场景需要 `GEO_AGENT_PLATFORM_E2E_REAL=1` 和本机服务，当前未在本轮环境执行 |
| [ ] | Desktop `AppShell` 全量按面板拆分、地图视觉回归 | 仅完成对话投影/传输边界，未完成完整 UI 拆分和视觉基线 |
| [ ] | 生产发布签名、SBOM、锁定 Python 运行环境的安装冒烟 | 已实现 SPDX SBOM、Ed25519 显式签名/校验和 Worker `uv.lock`，但真实生产密钥发布与锁定 Python 环境安装冒烟仍需在发布主机执行 |
| [x] | 自动生成 Provider/WS/Worker/Desktop 架构清单 | `npm run generate:architecture-manifest` 读取真实 registry/catalog/schema，生成 `docs/architecture/architecture-manifest.json` 并校验 WS 注册数量一致 |

## 本轮已完成

### 1. 数据库和文件事实源

- 增加 `009_file_object_lifecycle.sql`，以 `platform_file_objects` 记录 `pending → ready → deleted` 生命周期。
- `FileObjectRepository` 负责幂等预留、状态推进、版本退役和引用哈希查询。
- `FileLifecycleService` 统一上传、重试、删除、线程 fork 复制和线程清理；HTTP 路由不再直接决定物理文件状态。
- 气象上传在索引或 session 指针写入失败时执行显式补偿删除，原始错误继续抛出。
- 文件对象哈希已接入完整性检查和对象引用回收查询。
- `packages/db` 提供唯一 schema、连接工厂和事务类型；Server 仅保留兼容导出，连接工厂测试验证惰性连接和池错误观测，不连接真实数据库。
- `npm run test:postgis` 使用 Testcontainers 启动固定 `postgis/postgis:16-3.5`，执行迁移和真实托管图层空间读写；默认 `npm test` 不隐式启动 Docker。

### 2. 工具结果和运行应用边界

- `ToolResultCommitService` 成为 Agents SDK、Debug 和 Automation 共用的单一结果提交边界，统一 GeoJSON artifact、valueRef、工作流状态和幂等提交。
- `ToolExecutionCoordinator` 只协调执行顺序和事件；工具许可规则拆到 `ToolExecutionPolicy`。
- `StartRunService` 统一 session/thread/provider/runtime snapshot/run 创建和后台任务启动，`run:start` WS 命令只做 DTO、授权和订阅。
- Automation 和直接工具执行均注入同一个结果提交服务，生产容器不再依赖动态导入或隐式 fallback。
- 默认模型 transport 的 DNS 预热现在属于服务启动就绪边界：API 监听前等待已配置默认 provider 的预热完成，避免 supervisor 报 healthy 后由第一个问题承担冷解析延迟；未配置 provider 不触发外部网络。

### 3. 跨进程协议

- `packages/shared-types/src/transport.ts` 维护 WS 命令 payload、response、auth、CSRF 和分类契约。
- Server command registry 使用共享契约校验响应；Desktop HTTP、multipart、WS 请求统一通过 typed transport 校验。
- 缺失 response/error 直接报协议错误，不再用默认数据伪造成功。
- `packages/shared-types/src/contracts.test.ts` 固定 WS command registry 与契约一对一，并验证交付 artifact ID 和 Worker catalog hash 的边界失败行为。
- `apps/server/src/model/providers/legacyProviders.test.ts` 对 Anthropic、Gemini、Ollama 使用 stub transport 验证请求和响应映射，不把网络可用性伪装成 provider 测试通过。

### 4. Desktop 对话和发布握手

- 对话 timeline 使用 `conversation-presentation` 的增量投影索引，canonical transcript 与 live overlay 按来源和 transcript identity 合并。
- `useRunState` 保留 run 快照事实，`ConversationTimeline` 使用虚拟列表；Desktop API 模块不再各自声明重复 WS response schema。
- 增加 `/health/capabilities` 能力文档以及 API/Desktop 协议版本握手。该检查只确认运行时确实兼容，不改变业务权限，也不添加额外操作门槛。
- `scripts/create-runtime-service-artifact.mjs` 生成 Node 服务、Worker 源码、锁定 Python 项目、共享 DB/协议/监督器运行包、迁移、服务定义、SPDX SBOM 和 checksum manifest；传入 `--signing-key` 时额外生成 Ed25519 签名，`npm run verify:runtime` 校验所有文件、SBOM 和签名。服务 manifest 中的本地依赖会重写到制品内的固定相对路径，缺输入或覆盖已有输出时显式失败。

### 5. Worker 边界（不改 Python 算法）

- 保持 `packages/gis-meteorology` 算法实现不变。
- 已核验 Worker 子进程隔离、超时/取消/关闭时 terminate→kill→reap、SQLite nonce/concurrency lease、HMAC/replay/body limit/path sandbox 等执行边界。
- Worker 只接收受验证的运行目录对象引用，不持有 Session/Thread/Run 事实。

这部分是“边界核验”，不是 Python 算法或入口重构；对应的未完成项已在上面的状态总览中列出。

### 6. 脚本规范

- 新增 [`scripts/README.md`](../../scripts/README.md)，按开发、构建校验、发布、服务安装、数据维护和 Worker 入口分类。
- 破坏性动作保持显式参数；发布脚本验证输入、写入版本/协议/校验清单；脚本失败返回非零状态。

## 未完成与明确暂缓

| 项目 | 状态 | 原因 |
| --- | --- | --- |
| Python `ReaderFacade` 及 `packages/gis-meteorology` reader/service 算法整理 | [ ] 暂缓 | 用户明确要求“Python 算法这一块暂时不要改”，当前只改 Worker 执行边界 |
| Python Worker/科学算法内部结构性重构 | [ ] 未完成 | 本轮只改 Worker 配置校验、打包元数据、catalog CLI 和测试；未改 `packages/gis-meteorology` 科学算法实现，`ReaderFacade`/service 拆分仍按用户要求暂缓 |
| 真实 PostgreSQL/PostGIS/Testcontainers 全链路 | [x] 已完成 | `npm run test:postgis` 已在本机 Docker 上通过；默认单元测试不依赖 Docker |
| 多实例共享限流后端 | [ ] 未完成 | `SlidingWindowRateLimiter` 仍为进程内 Map；客户端 IP 已不再信任可伪造请求头，但共享计数后端需要单独的部署决策 |
| Worker HTTP 重试/退避策略 | [ ] 未完成 | `callMeteorologyWorker` 仍保持单次请求并将错误显式上抛；没有在缺少幂等契约时自动重放工具调用 |
| 真实后端 E2E（run stream + approval） | [ ] 未完成 | 真实 Electron 场景受环境变量显式控制，本轮只完成静态/单元/集成验证，未冒充真实后端 E2E 已通过 |
| Desktop `AppShell` 全量拆分、地图视觉回归 | [ ] 未完成 | 本轮只完成对话投影、虚拟列表和 transport 边界 |
| 生产签名、SBOM、锁定 Python 运行环境安装冒烟 | [ ] 部分完成 | 制品已生成 SPDX SBOM，支持显式 Ed25519 签名/校验，并包含 `apps/worker/uv.lock`；生产密钥和目标主机安装需发布环境执行 |
| 自动生成 Provider/WS/Worker/Desktop 架构清单 | [x] 已完成 | `scripts/generate-architecture-manifest.mjs` 读取构建后的 Server registry、Worker catalog、共享 WS 契约和 Desktop command schema |

## 验证记录

已执行并通过：

- `npm run build --workspace @geo-agent-platform/shared-types`
- `npm run test --workspace @geo-agent-platform/shared-types`
- `npm run build --workspace @geo-agent-platform/conversation-presentation`
- `npm run build --workspace geo-agent-server`
- `npm run typecheck --workspace @geo-agent-platform/desktop`
- `npm run test --workspace geo-agent-server`
- `npx vitest run src/model/providers/legacyProviders.test.ts`（Server provider 边界）
- `npm run test --workspace @geo-agent-platform/desktop`
- `npm run lint:desktop`（0 errors；保留既有 warning）
- `npm test`（所有工作区通过：db 1 个文件/2 个测试，shared-types 1 个文件/3 个测试，server 105 个文件/540 个测试通过、2 个文件/4 个测试显式跳过，desktop 97 个文件/357 个测试通过、1 个测试显式跳过）
- `npm run build`
- `npm run check:bundle`（initial JS gzip 101254 bytes，CSS gzip 4425 bytes）
- `npm run lint:terminology`
- `python apps/worker/tests/scan_security.py`
- `python -m pytest apps/worker/tests tests -q`
- `uv lock --check --project apps/worker`（Worker 锁文件一致；本机 `uv sync` 的完整科学依赖安装冒烟仍保留在未完成项）
- `node scripts/create-runtime-service-artifact.mjs --build --out artifacts/runtime-service-verification`（当前制品包含 678 项文件、数据库 schema 版本 9、Worker `pyproject.toml`/`uv.lock`、SPDX SBOM；在临时 `server/` 内执行 `npm install --package-lock-only --ignore-scripts --omit=dev`，确认本地 `file:` 依赖解析到制品内路径；验证后已删除临时目录）
- `node scripts/verify-runtime-service-artifact.mjs` + `uv lock --check --project artifacts/runtime-service-verification/worker`（制品内 Worker 相对路径、checksum、SBOM 和锁文件解析通过；验证后已删除临时目录）
- `npm run test:postgis`（Testcontainers + `postgis/postgis:16-3.5`：2 个真实集成场景通过）
- `npm run generate:architecture-manifest`（Provider 4 个、WS 74 个、Worker catalog 19 个、Desktop menu command 14 个；生成清单）
- `node scripts/create-runtime-service-artifact.mjs --out artifacts/runtime-service-test --force` + `node scripts/verify-runtime-service-artifact.mjs artifacts/runtime-service-test`（678 项文件、75 个 SBOM 包；checksum/SBOM 通过）
- 同一制品使用临时 Ed25519 key 执行 `--signing-key` 并通过 `verify-runtime-service-artifact.mjs` 签名校验；生产密钥仍不写入仓库。

构建、测试、包体预算、Worker 安全扫描和运行服务制品生成均已通过；工作区未产生需要提交的构建制品或临时验证目录。

## 维护原则

1. 先定位事实源和状态边界，再修改调用方；不在 UI、脚本或 fallback 中复制状态。
2. 失败必须可见、可重试或可补偿；不能把未知状态包装成成功。
3. 新增安全检查必须对应真实威胁或数据一致性问题，并通过契约测试证明，不增加无业务依据的门禁。
4. Python 算法变更另开独立任务和验证范围，不与 Worker/Node 架构重构混合提交。
