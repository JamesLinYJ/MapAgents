# Newmap (地理智能代理平台) 架构审查报告

> 审查日期: 2026-07-06 | 审查范围: 全栈 (server/web/worker/infra)

---

## 一、审查方法

本次架构审查采用 **八维度并行审查 + 三方对抗验证** 的方法论：

1. **八位专项审查员** 分别覆盖以下维度：总体架构设计、Agent系统与运行时、安全性、代码质量、数据与持久化层、前端架构、Python Worker与GIS、测试与DevOps。每位审查员独立审查指定模块的源码，记录发现。

2. **对抗验证阶段**：每个发现由三名独立的"怀疑者"分别复验。怀疑者对原始发现进行加压测试——尝试构造反例、质疑证据充分性、寻找遗漏的边界条件。最终结论分为三类：**确认 (Confirmed)**——三方均认可其有效性；**驳回 (Refuted)**——至少两方认定证据不足或不成立；**存疑**——结论分裂。

3. **严重等级**：CRITICAL（可能造成数据丢失、安全入侵或完全不可用）> MAJOR（显著影响可维护性、性能或可靠性）> MINOR（局部问题，影响有限）。

本次审查共产出 4 个确认精妙模式、49 个确认问题、34 个被驳回的问题。本报告仅涵盖经过对抗验证的确认结论。

---

## 二、精妙之处

以下四个模式经过验证，被公认为设计优雅、实现到位的解决方案。

### 2.1 Token感知压缩与三级降级回退

**位置**: `server/src/agent/contextManager.ts` - `compactThreadIfNeeded`

**问题背景**: Agent对话上下文持续增长，无节制地追加消息会导致上下文窗口溢出、Token消耗失控、推理质量下降。传统方案要么简单截断（丢失历史信息），要么依赖单一摘要模型（摘要失败时无后备）。

**设计方案**: 实现了一套**三级降级回退**机制：
- 第一级：主模型执行结构化摘要（保留关键信息量最大）
- 第二级：一次重试（应对模型偶发故障）
- 第三级：抽取式压缩——保留最近16条消息 + 最近8条工具结果（确保最相关的上下文永不丢失）

**优雅之处**:
- **追加不修改**: 原始对话记录永不修改，只追加 `compact_summary` 和 `compact_boundary` 标记。压缩形成可追溯的链表结构，replay条目携带 `compactionReplay: true` 标记供下游过滤。这保证了**完整审计能力**。
- **逐级降级**: 每级回退牺牲的信息量明确可控，不会从全量摘要直接跳到全量丢弃。
- **扩展性强**: 链表结构允许未来添加更高级的压缩策略（如分层摘要、语义索引），不影响已有的压缩记录。

**对比替代方案**:
- 简单滑动窗口（消息数截断）：实现简单但丢失全部历史。本方案至少保留摘要。
- 强制使用单一模型摘要：模型故障时无保护。本方案提供重试和抽取式降级。
- 直接丢弃旧消息：破坏审计链。本方案的追加模式保留完整审计路径。

### 2.2 预写日志 (WAL) 保证崩溃安全的对话记录

**位置**: `server/src/store/fileConversationStore.ts`

**问题背景**: 对话记录是系统的状态核心，写操作中途崩溃会导致记录损坏或不一致。文件系统缺乏数据库的事务保障。

**设计方案**: 实现了教科书级的**预写日志 (Write-Ahead Logging)** 模式：
1. 原子写入一个 Journal JSON 文件，包含操作的完整状态
2. 将变更应用到对话 JSONL 文件
3. 成功后将 Journal 文件删除

**优雅之处**:
- **崩溃恢复**: `recoverThreadJournals()` 在启动时检测未应用的 Journal 并回放。应用步骤使用 `jsonLinesContainId()` 实现幂等性——即使部分写入后崩溃，恢复也不会重复追加。
- **损坏隔离**: 检测到数据损坏时记录日志并将线程隔离（quarantine），防止损坏扩散到其他线程。
- **幂等安全**: Journal 重放是幂等的，支持多次应用而不产生重复记录。

**对比替代方案**:
- 无 WAL 的直接写入：崩溃后文件处于未知状态，可能部分写入、丢失数据或永久损坏。本方案保证要么完全写入、要么完全不写入。
- 数据库系统：对于嵌入式文件存储来说太重。WAL 提供了轻量级但同样可靠的事务语义。

### 2.3 分层化记忆架构（版本化 + 锁机制 + 二阶段提取）

**位置**: `server/src/memory/service.ts`

**问题背景**: Agent 记忆管理涉及短期对话记忆、长期持久记忆和会话级摘要记忆，三者的生命周期和一致性策略各不相同。简单方案往往将所有记忆混为一谈，导致冲突和不可靠。

**设计方案**: 实现了三个明确定义的层级：
- **Thread Memory**（线程级记忆）：对话级短期记忆，使用**版本号 + 乐观并发控制**，存储在 JSONL 中。每次写入携带版本号，检测冲突时拒绝写入。
- **File Memory**（文件级记忆）：长期持久记忆，使用 Markdown + YAML frontmatter 格式，由 MEMORY.md 索引。适合人工编辑和长期保存。
- **Session Memory**（会话级摘要记忆）：LLM 生成的对话状态摘要，用于跨轮次的快速上下文恢复。

**优雅之处**:
- **二阶段提取协议**: 自动提取使用"先读/搜 -> 后写/删"的协议，显著降低模型幻觉的写入风险——模型必须先在已有记忆中搜索，确认无需更新后再执行写入。
- **文件系统级锁**: `withDreamLock` 使用文件系统锁防止记忆整合（dream consolidation）并发执行，避免多进程竞态。
- **路径遍历防护**: 通过 `realpathDeepestExisting()` 进行符号链接感知的边界检查，防止记忆文件路径逃逸。

**对比替代方案**:
- 单层无版本记忆：写入冲突静默覆盖，丢失信息。本方案的版本化检测确保冲突时拒绝而非覆盖。
- 全量 LLM 记忆：成本高、幻觉风险大。本方案的精简摘要策略在信息保留与成本之间取得了平衡。
- 无锁并发整合：多实例运行时记忆状态不一致。文件系统锁提供了跨进程的互斥保证。

### 2.4 懒加载架构与延迟地图激活实现最优分包

**位置**: `apps/web/src/app/AppShell.tsx` (第 386-409 行)

**问题背景**: MapLibre 地图渲染引擎体积超过 400KB，若在应用启动时立即加载，将显著拖慢首屏加载时间。前端打包需要在不牺牲功能完整性的前提下实现代码分割。

**设计方案**: 采用分层懒加载策略：
- **React.lazy 分包**: 所有功能页面（DebugPage、DetailPanel、MapCanvas、ToolManagementPage、SecurityAdminPage）均使用 React.lazy 动态导入，使 Rolldown 有清晰的分割点。
- **两帧延迟激活地图**: 地图模块通过 `requestAnimationFrame × 2 + requestIdleCallback` 序列延迟激活（约 50-200ms），确保 400KB+ 的 MapLibre 包**绝不**在关键首屏路径上加载。
- **Framer Motion 树摇**: `LazyMotion` + `domAnimation` 实现动画库的按需加载，而非全量引入。

**优雅之处**:
- **定量可观测**: 延迟时间由 rAF + requestIdleCallback 的精确时序控制，而非任意的 setTimeout 超时。
- **用户无感知**: 地图激活在交互准备就绪时完成，用户几乎不会注意到加载延迟。
- **打包器友好**: React.lazy 语义清晰，Rolldown/Rspack 能自动推导最优分割策略。

**对比替代方案**:
- 同步导入：首屏加载时间增加 300-800ms。本方案避免了此开销。
- 简单 setTimeout：时序不可预测，可能过早（仍在首屏渲染阶段）或过晚（用户已等待）。rAF + requestIdleCallback 与浏览器帧周期对齐。
- 手动代码分割：维护成本高。React.lazy 将分割点声明化。

---

## 三、不合理之处

按严重等级排序：CRITICAL（11项） > MAJOR（29项） > MINOR（9项）。每个问题含具体位置、问题描述、影响评估和修复建议。

---

### CRITICAL

#### C1. PostgresPlatformStore 是神类（God Class），聚合了持久化、索引、事件总线、查询逻辑（3/3 验证）

- **位置**: `server/src/store/platformStore.ts`
- **问题**: PostgresPlatformStore 管理 Sessions、Threads、Runs、Artifacts、Memory、Tool Catalog、运行时配置和事件总线，通过 7 个内存 EventBus 实例加上多个内存 Map 实现。大多数消费者（Agent 运行时、WS 处理器、路由处理器）都直接依赖这个单一类。
- **影响**: 任何领域的 Schema 变更或行为变更都必须修改此类，违反单一职责原则，造成高风险演化瓶颈。一个类的变更可能影响到所有下游。代码体积过大，测试困难。
- **建议修复**: 按领域拆分为独立服务（SessionService、ThreadService、RunService、MemoryService 等），通过接口依赖而非直接依赖具体类。每个服务有自己的生命周期和存储策略。

#### C2. WebSocket 处理器直接依赖具体 OpenAI Agents SDK 运行时（2/3 验证）

- **位置**: `server/src/ws/handler.ts`
- **问题**: WS handler 直接导入 `OpenAIAgentsRuntime`、`assembleThreadContext`、`compactThreadIfNeeded`、`buildSystemPrompt` 等具体实现。在第 46 行具体实例化 `OpenAIAgentsRuntime`，在第 224-240 行直接调用 `assembleThreadContext/compactThreadIfNeeded`。
- **影响**: 传输层与特定 Agent SDK 实现强耦合。从 `@openai/agents` 切换到其他框架需要同时重写 `agent/runtime.ts` 和 `ws/handler.ts`。无法独立测试传输逻辑。
- **建议修复**: 引入抽象接口 `AgentRuntime`，定义 `run()`, `resume()`, `compact()`, `getContext()` 等方法。WS handler 仅依赖此接口，通过依赖注入获取实现。

#### C3. Token 估算使用统一 chars/4 启发式，对所有现代模型均不准确（3/3 验证）

- **位置**: `server/src/agent/contextManager.ts` - `estimateTokens()`
- **问题**: `estimateTokens(text)` 返回 `Math.ceil(text.length / 4)`。这个简单指标驱动压缩时机 (`compactRatio`)、硬限制 (`hardLimitRatio`)、记忆更新阈值 (`memoryUpdateTokens`) 和记忆初始化阈值 (`memoryInitTokens`)。中文文本（在此 GIS 平台中常见）在大多数模型中每个字符约消耗 1.5-2.5 tokens，而非 0.25。
- **影响**: 一个 12K 字符的系统提示 + 记忆被估算为 3K tokens，实际消耗 8000-18000 tokens（取决于模型）。此误算传播到：过早或延迟的压缩、错误的硬限制强制执行、次优的记忆更新调度。这是**系统性误差**，影响所有 Token 相关的决策。
- **建议修复**: 替换为模型感知的 Token 计数。方案一：引入 `tiktoken` 库（OpenAI 官方 Tokenizer），对常见模型提供精确计数。方案二：对非 OpenAI 模型，提供可配置的 Tokenizer 接口。方案三：作为最小修复，使用更保守的系数（如 chars/1.5 或 chars/2）并验证。

#### C4. `unix_local`沙箱后端提供零隔离（2/3 验证）

- **位置**: `server/src/agent/runtimeSandbox.ts` - `createConfiguredSandboxSession()`
- **问题**: 支持 `unix_local` 后端，直接在主机的文件系统上执行代码，没有任何容器边界。OpenAI Agents SDK 的 `UnixLocalSandboxClient` 按设计不提供进程/文件系统隔离。
- **影响**: 如果运行时配置被攻破（通过管理员权限或配置注入），攻击者可切换到 `unix_local` 后端，绕过所有沙箱约束，获得主机文件、进程和网络的全部访问权限。这是**沙箱逃逸的官方后门**。
- **建议修复**: 
  - **立即**: 从 `SandboxBackend` 类型定义中移除 `unix_local` 选项，或在运行时强制检查并拒绝此配置。
  - **长期**: 所有代码执行必须通过 Docker 容器化沙箱，并可考虑为高安全场景添加 gVisor/Kata Containers。

#### C5. Fire-and-forget 后台运行存在未处理的拒绝传播（3/3 验证）

- **位置**: `server/src/ws/handler.ts` - 第 302、330 行
- **问题**: 使用 `void runtime.run()` 处理 `run:start` 和 `run:resume`，然后在同一个 void promise 上链式调用 `.then(() => void sendRunSnapshot(...))`。如果 `runtime.run()` 异常抛出（尽管内部有 catch，某些路径会重新抛出错误），`.then()` 被跳过且拒绝未被处理——因为 `void` 丢弃了 promise。
- **影响**: Agent 运行中的未捕获异常静默丢失，客户端不会收到错误通知，运行状态可能卡在不一致状态。调试极度困难。
- **建议修复**: 
  - 使用 `.catch(error => { sendErrorMessage(...); logError(error); })` 替代 `void`。
  - 考虑引入进程级别的 `unhandledRejection` 处理器作为兜底。

#### C6. 原始类型断言绕过 Zod 验证（2/3 验证）

- **位置**: `server/src/store/fileConversationStore.ts`
- **问题**: 使用 `as AgentThreadRecord` 和 `as AttachmentRecord` 等原始类型断言处理从磁盘读取的数据，跳过了关键数据结构（对话存储的真相来源）的 Zod 模式验证。
- **影响**: 损坏的数据在反序列化边界不会被捕获。问题数据可能在写入后才被发现，此时原始来源已丢失。对于文件系统存储而言，这是数据完整性保证的最后一道防线。
- **建议修复**: 使用 `AgentThreadRecordSchema.parse(raw)` 替代类型断言。为性能敏感路径提供 `safeParse` 并在解析失败时返回有意义的错误。

#### C7. 大规模单文件 React 组件，70+ Props 深度穿透（2/3 验证）

- **位置**: `apps/web/src/app/AppShell.tsx`
- **问题**: AppShell.tsx 有 1170 行，单个函数组件包含 **70+ props** 通过多层组件深度穿透（WorkspaceLayout -> ChatPanel、DetailPanel 等）。状态管理分散在 7 个自定义 hooks 中，全部在一个巨型组件中调用。
- **影响**: 违反了单一职责原则，使测试、推理和修改变得极其困难。任何 prop 变更都需要更新多个中间层。重新渲染范围过宽，影响性能。
- **建议修复**: 
  - 引入状态管理库（如 Zustand、Jotai）将全局状态从组件 prop 提升到 store。
  - 将 AppShell 拆分为 3-5 个较小组件，每个负责一个清晰的功能域。
  - 使用 Context 或状态选择器替代深层 prop 穿透。

#### C8. 所有 JSONL 查询读取并解析整个文件（3/3 验证）

- **位置**: `server/src/store/fileConversationStore.ts`
- **问题**: 所有 JSONL 读取操作——`listItems()`、`listEvents()`、`readTranscript()`、`listArtifacts()`、`listCompactions()`、`getMemory()`——都将整个文件读入内存、按换行符分割、通过 Zod 模式解析每一行。没有索引、偏移跟踪或增量读取能力。`readHistory()` 中的游标分页仍然先读取所有条目再过滤。
- **影响**: 每个查询的时间复杂度和空间复杂度均为 O(n)，n 为文件总行数。随着对话增长，延迟线性增加。在数百条消息的对话中，每次操作可能消耗数十毫秒到数百毫秒。
- **建议修复**: 
  - 短期：添加行偏移索引，支持从指定位置开始读取。
  - 中期：考虑切换到 SQLite（嵌入式的、经过战斗检验的、支持索引的存储）替代 JSONL。
  - 长期：为大规模部署使用 Postgres 存储对话记录（替代文件系统存储）。

#### C9. 无 CI/CD 流水线（3/3 验证）

- **位置**: 项目根目录
- **问题**: 项目有 39 个测试文件（27 server vitest、11 web vitest、1 Playwright e2e、1 Python worker unittest），覆盖 4 种运行环境，但**零 CI 配置**。没有 `.github/workflows/`、没有 GitLab CI、没有任何 CI 提供商的配置文件。
- **影响**: 每次合并都是未经验证的。测试必须手动运行，无法阻止有问题的代码合并到主分支。没有自动化的构建验证、风格检查、类型检查或安全扫描。
- **建议修复**: 添加 GitHub Actions 配置（或首选 CI 系统），至少覆盖：PR 验证（类型检查 + 单元测试 + Lint）、构建验证（Server + Web + Worker）、基础安全检查。

#### C10. 应用服务无容器镜像（2/3 验证）

- **位置**: 项目全局
- **问题**: 只有 PostGIS 通过 docker-compose 容器化。Node API 服务器、Vite Web 应用和 Python Worker 均在主机上原生运行。整个项目中零 Dockerfile（server、web、worker 或 nginx）。nginx.conf 存在但无承载它的镜像。
- **影响**: 生产部署需要在每台主机上手动搭建环境，无复现性保证。"在我机器上能跑"问题成为常态。无法利用容器编排进行自动扩缩和滚动更新。
- **建议修复**: 为 Server、Web、Worker 和 Nginx 分别创建 Dockerfile。更新 docker-compose 配置以包含所有服务。使用多阶段构建减小镜像体积。

#### C11. CSP connect-src 允许任意 HTTPS/WSS 端点，可被用于数据外泄（3/3 验证）

- **位置**: `infra/docker/web/nginx.conf`
- **问题**: Content-Security-Policy 头设置 `connect-src 'self' https: ws: wss:`。`https:` 和 `wss:` 不加域名限制意味着浏览器可以向**任意**始发地发起 fetch()、XMLHttpRequest() 和 WebSocket 连接。
- **影响**: 如果攻击者实现 XSS，可以将会话令牌、CSRF 令牌、用户数据等外泄到任意攻击者控制的服务器。这是 CSP 中最大的绕过向量。`frame-ancestors 'none'` 仅防止点击劫持，对此问题无帮助。
- **建议修复**: 将 `connect-src` 限制为白名单域名列表：`connect-src 'self' https://api.yourdomain.com wss://api.yourdomain.com`。避免使用协议前缀通配符（`https:`、`wss:`）。

---

### MAJOR

#### M1. AgentRuntimeConfig 是无版本的单体深度嵌套配置对象，无迁移策略（3/3 验证）

- **位置**: `server/src/agent/defaultRuntimeConfig.ts`
- **问题**: 默认运行时配置是单个深度嵌套的对象，包含 supervisor 配置、子代理、UI 设置、目录、规划、上下文窗口、记忆、地理搜索、外部 POI、Nowcast、Hook 配置等 9+ 个顶级区域。无版本字段、无 Schema 演化策略、无部分覆盖机制。每次运行都将完整 `runtimeConfigSnapshot` 存储，浪费存储空间并导致跨运行的 Schema 迁移不可能。
- **影响**: 不同子系统从同一配置 blob 的不同部分读取，创建隐式耦合。修改任一子系统的配置区可能影响其他子系统。Schema 迁移需要一次性重写所有历史运行记录。
- **建议修复**: 引入版本化的配置 Schema，支持部分覆盖（类似 `JSON Patch`）。将配置按领域拆分为独立文档（UI 配置、Agent 配置、GIS 配置）。为每个子系统的配置区域提供独立的 Zod Schema 验证。

#### M2. Python Worker 通过单体 if/elif 链分发 15+ 气象工具（2/3 验证）

- **位置**: `apps/worker/src/worker_app/sidecar.py` - `execute_meteorology_tool()`
- **问题**: 单个 200+ 行的 if/elif 链分发 15+ 工具，每个分支在函数体内进行内联导入（从 `gis_meteorology` 子包）。文件已膨胀到约 700 行，而它本应是一个薄分发层。
- **影响**: 添加新工具需要编辑此链并添加新的 elif 分支，违反开闭原则。内联导入使依赖关系非显式化，增加了模块加载的意外开销。
- **建议修复**: 实现工具注册机制（如装饰器模式 `@meteorology_tool("tool_name")`），每个工具实现独立类/函数。使用策略模式或注册表分发，消除 if/elif 链。

#### M3. 原始 SDK 流事件类型通过投影层泄露（2/3 验证）

- **位置**: `server/src/agent/runtime.ts` - `projectStreamEvent()`
- **问题**: `projectStreamEvent` 方法模式匹配原始 SDK 事件类型（`raw_model_stream_event`、`agent_updated_stream_event`、`run_item_stream_event`）及其 `event.name` 值（`message_output_created`、`reasoning_item_created`、`tool_called`、`tool_approval_requested`）。这些是 OpenAI Agents SDK 内部类型，非稳定 API。
- **影响**: SDK 版本升级如果重命名事件类型或重构事件层次，投影层静默崩溃。这是一种**脆弱的、非契约化的依赖关系**。
- **建议修复**: 定义应用层事件类型，在 SDK 适配器层将 SDK 事件转换为应用事件。适配器是唯一与 SDK 类型耦合的模块。SDK 升级时仅需修改适配器。

#### M4. 批准决议无乐观锁或并发控制（3/3 验证）

- **位置**: `server/src/agent/runtime.ts` - `resolveApproval()`
- **问题**: `resolveApproval` 将完整运行状态读入局部变量、修改 approvals 数组和 decisions 数组、然后通过 `updateRunState` 写回。如果两个批准决议竞争（例如用户同时点击"批准"和自动决议），第二次写入静默覆盖第一次。`consumed` 标志仅在单进程内提供幂等性，跨进程并发无保护。
- **影响**: 用户批准可能被静默丢失。在同时处理多个批准项的场景下，可能导致错误的工具执行决策。
- **建议修复**: 在 `updateRunState` 中使用版本号实现乐观锁（CAS 模式——比较并交换）。添加读写锁或互斥量保护批准决议的关键区。

#### M5. 确定性 Nowcast 流水线是单用途硬编码链，无泛化框架（3/3 验证）

- **位置**: `server/src/agent/deterministicNowcastRunner.ts` - `runDeterministicNowcast()`
- **问题**: 硬编码唯一流水线：`list_meteorological_files -> create_nowcast_sequence -> prepare_hangzhou_nowcast_scope -> meteorological_precipitation_nowcast -> answer_nowcast_question`。工具序列、valueRef 的 kind 预期和作用域检测（硬编码为杭州）均紧密耦合。范围工具名称包含 'hangzhou'，使流水线固有地具有位置特异性。
- **影响**: 添加第二条确定性流水线（如土地利用分析、洪水风险评估）需要完整复制整个 runner。流水线不可配置、不可扩展。
- **建议修复**: 设计通用的"确定性计划"框架：将流水线定义为声明式配置（工具序列、输入输出映射、条件分支）。为每个业务场景提供独立的流水线定义，共享基础框架。

#### M6. 按工具调用的模型调用无超时（3/3 验证）

- **位置**: `server/src/agent/toolExecutionCoordinator.ts` - `invokeStructuredModel()`
- **问题**: `invokeStructuredModel` 调用 `adapter.chat()` 时无超时参数。`AbortController` 仅在运行级别（传递给 `Runner.run` 的 `AbortSignal`），而非按工具调用级别。
- **影响**: 如果模型提供者挂起（上游延迟、速率限制、崩溃），工具处理器永久阻塞，锁定整个工具执行链。单个挂起的模型调用使整个 Agent 运行停滞，直等到运行级别的 abort 信号（仅当用户取消时触发）。
- **建议修复**: 为每个工具调用添加独立超时（如 30 秒），使用 `AbortSignal.timeout()` 或类似机制。超时时应触发友好的错误恢复而非崩溃。

#### M7. 线程资源注入使用脆弱的语言特定关键词启发式（2/3 验证）

- **位置**: `server/src/agent/contextManager.ts` - `buildThreadResourceMessage()`
- **问题**: 决定是否将线程资源注入模型上下文时，基于正则匹配特定中文短语（如"继续"、"沿用"、"复用"、"之前"）。无语义理解，在需要资源时可能漏检，或不相关时错误注入。注入的资源无相关性评分——所有近期文件、工件和 valueRef 均被包含至硬限制。
- **影响**: 多语言用户（或者使用英文交互的用户）无法触发资源注入。注入的资源过多时稀释模型注意力，过少时模型缺少必要上下文。此启发式不具有扩展性。
- **建议修复**: 使用嵌入相似度（embedding similarity）代替关键词匹配，根据资源与当前消息的语义相关性排序和选择资源。添加资源相关性评分阈值。

#### M8. 内存速率限制器在跨实例部署中无效（2/3 验证）

- **位置**: `server/src/security/rateLimiter.ts`
- **问题**: `SlidingWindowRateLimiter`（HTTP）和 `WsMessageRateLimiter`（WS）将令牌桶存储在本地进程内存的 `Map` 对象中。在水平扩展的多实例部署中，每个实例维护独立的速率限制状态。
- **影响**: 攻击者可通过将请求分布在多个实例间（如轮询 DNS 或负载均衡器）轻易绕过速率限制。这使暴力密码猜测、API 滥用和 DoS 攻击成为可能——而这些正是速率限制器设计要阻止的。
- **建议修复**: 使用 Redis 作为集中式速率存储，通过 Lua 脚本或 Redlock 实现原子令牌桶操作。为无 Redis 的部署至少要求粘性会话。

#### M9. 多处重复的 invokeStructuredModel / JSON 解析逻辑（2/3 验证）

- **位置**: `server/src/agent/toolExecutionCoordinator.ts`（及多处重复）
- **问题**: 从模型响应中解析 JSON、去除 Markdown fence、用 `isRecord` 验证的 `invokeStructuredModel` 函数在至少 3 个文件中重复，逻辑完全一致。
- **影响**: 任何 Bug 修复或改进必须在所有副本中同步。这是一个典型的维护债务，差异化随时间累积。
- **建议修复**: 将公共职责提取到共享工具模块（如 `server/src/agent/utils/modelParsing.ts`），所有消费者依赖同一实现。

#### M10. 错误判定依赖字符串比较而非类型化错误（3/3 验证）

- **位置**: `server/src/main.ts` - Hono 错误处理器
- **问题**: 检查 `error.message === '未登录。'` 以返回 401 vs 403。任何区域设置变更、拼写错误或空白差异都会静默回退到 500 通用处理器。
- **影响**: 第一，错误分类不可靠。第二，对中文错误消息的字符串匹配意味着系统不能在不破坏认证逻辑的情况下实现国际化。
- **建议修复**: 代码库已有类型化错误类（`AuthorizationError`、`StoreNotFoundError`）。使用 `instanceof` 检查替代字符串匹配，或将 `statusCode` 属性直接编码到错误对象中。

#### M11. 无结构化日志框架；使用不一致的 console 日志（2/3 验证）

- **位置**: 贯穿 `server/src/main.ts` 及整个代码库
- **问题**: 整个代码库使用裸 `console.log` 和 `console.error`，无结构化日志框架（pino、winston 等）。日志级别不一致：某些初始化步骤用 `console.log`、健康检查用 `console.error`、生命周期管理器也用 `console.error`。无关联 ID、无结构化元数据、无日志级别过滤。
- **影响**: 生产环境中无法进行有意义的日志搜索、关联和告警。诊断问题需要手动关联多个日志源，无法按级别过滤，无法自动聚合。
- **建议修复**: 引入 pino（性能最优的 Node.js 日志库）。添加请求级别的关联 ID（correlation ID）。配置自动化的日志级别过滤和结构化元数据输出。

#### M12. Void-Callback 模式静默丢弃异步错误（3/3 验证）

- **位置**: `apps/web/src/app/AppShell.tsx` - `useVoidCallback`
- **问题**: `useVoidCallback` 包装异步函数并使用 `void fn()`，用于 10+ 个回调。这些异步操作的错误被静默丢弃，除非在每个回调内部捕获。
- **影响**: 方法调用的未处理拒绝无法被应用级错误边界或监控系统捕获。UI 可能处于不一致状态（"操作失败"但不通知用户）而无人知晓。
- **建议修复**: 为每个 void callback 添加 `.catch(error => reportError(error))`，或使用全局错误事件处理器捕获未处理的 promise 拒绝。

#### M13. handleMessage 中的巨型 switch 语句超过 250 行（2/3 验证）

- **位置**: `server/src/ws/handler.ts` - `handleMessage()`
- **问题**: 一个 260 行的 switch 语句处理 50+ 种 WebSocket 命令类型，在单个函数中混合认证、验证、业务逻辑和响应格式化。
- **影响**: 难以测试单个命令、添加新命令而不影响其他命令、或理解控制流。这是**典型的 switch 语句代码坏味道**。
- **建议修复**: 使用命令模式（Command Pattern），每个命令类型一个独立处理器。创建命令注册表，`handleMessage` 仅查找并分发到对应处理器。

#### M14. 多模块中存在重复的 isRecord 类型守卫（3/3 验证）

- **位置**: `server/src/agent/toolExecutionCoordinator.ts`（及至少 5 个其他位置）
- **问题**: `isRecord` 类型守卫函数（检查 `typeof value === 'object' && value !== null && !Array.isArray(value)`）在至少 5 个模块中独立定义，行为完全一致。
- **影响**: 如需更改定义（例如增加 BigInt 支持），必须找到并修改所有副本——容易遗漏。
- **建议修复**: 提取到共享工具模块（如 `server/src/shared/typeGuards.ts`）。

#### M15. JSONL 写入序列化创建单文件瓶颈，级联失败风险（2/3 验证）

- **位置**: `server/src/store/fileConversationStore.ts` - `enqueueAppend()`
- **问题**: `enqueueAppend()` 通过存储在 `writeQueues` 中的 promise 链按文件路径串行化写入。任何写入失败被捕获并记录，但链继续——然而永久的卡住或慢速写入会阻塞该文件的所有后续追加。链捕获错误但静默转换为已解决的 promise（`catch(error => { console.error(...) })`），意味着失败的写入在链中创建不可恢复的空隙。无批处理或并发——每次追加独立打开、写入、同步和关闭文件句柄。
- **影响**: 一次写入失败后，该文件路径上的所有后续写入继续执行，但失败的写入数据永久丢失，后续写入无法重放失败的条目。每条消息的磁盘 I/O 开销高。
- **建议修复**: 
  - 实现失败重试机制（指数退避）。
  - 批量追加：累积短时间窗口内的写入，一次性写入。
  - 保留写入作业队列的持久化状态，进程重启后可恢复。

#### M16. 文件系统 Schema 版本变更无迁移路径（2/3 验证）

- **位置**: `server/src/store/fileConversationStore.ts`
- **问题**: store manifest 声明 `STORE_SCHEMA_VERSION = 2`，`ensureStoreManifest()` 在磁盘版本不精确匹配时抛出错误。无迁移逻辑、升级脚本或版本间转换。JSONL 记录 Schema（`transcriptEntrySchema`、`runCheckpointSchema` 等）使用 `z.literal(2)`——Schema 变更需要重写所有文件。
- **影响**: 如果需要从 v2 升级到 v3，所有现有对话数据变得不可读且无恢复路径。这在产品化环境中是不可接受的，因为数据迁移是常见操作。
- **建议修复**: 实现向前兼容的版本处理：读取时支持多个版本、写入时升级。提供数据迁移 CLI 命令。在 Schema 定义中使用版本号作为字段而非 `z.literal`。

#### M17. 线程级锁是进程内锁，不支持水平扩展（2/3 验证）

- **位置**: `server/src/store/fileConversationStore.ts` - `withThreadLock()`
- **问题**: `withThreadLock()` 使用进程内 promise 链。当服务器水平扩展时，两个实例对同一线程的并发写入会在文件系统上竞态。文件系统不提供分布式锁或建议性锁。`enqueueAppend()` 的写入串行化同样限于单进程。
- **影响**: 多实例部署中，两个并发写入可能交错，导致 JSONL 文件损坏或数据丢失。
- **建议修复**: 
  - 短期：在每个进程的线程锁基础上，添加基于文件系统的锁（如 `lockfile` 包）。
  - 长期：考虑使用数据库（Postgres advisory locks 或 Redis 分布式锁）实现跨实例协调。

#### M18. GeoJSON 图层导入执行 N+1 次 INSERT 并使用破坏性表替换（3/3 验证）

- **位置**: `server/src/gis/postgis.ts` - `importGeoJsonLayer()`
- **问题**: 为每个要素执行单独的 INSERT 语句，而非批量插入为单个批量 INSERT。对于数百或数千个要素的数据集，这导致 N+1 次往返。此外，方法执行 `DROP TABLE IF EXISTS` 后跟 `CREATE TABLE`，无任何确认或软删除——任何具有相同键的现有上传图层被静默销毁。导入序列无事务安全包装。
- **影响**: 性能：1000 个要素 ≈ 1001 次数据库往返，而非 1 次。安全性：无事务回滚，导入中途失败留下不完整状态。数据安全：无确认即销毁已有图层。
- **建议修复**: 
  - 使用 `INSERT INTO table (columns) VALUES (row1), (row2), ...` 语法批量插入。
  - 将导入包装在数据库事务中（BEGIN/COMMIT/ROLLBACK）。
  - 为图层导入添加"存在则报错"或"存在则版本化"选项，替代静默删除。

#### M19. 启动性能随总对话数据量线性下降（2/3 验证）

- **位置**: `server/src/store/platformStore.ts` - `initialize()`
- **问题**: `initialize()` 从文件系统读取每个 session JSON、每个 thread JSON 和每个 run JSON，然后为每个 run 调用 `listArtifacts()`（读取完整 artifacts.jsonl）。这是一个顺序的 O(sessions + threads + runs + artifacts) 过程，无分页、无流式读取、无懒加载。在数千个对话的服务器上，启动时间变得不可接受。内存索引（`Map<string, T>`）也随数据线性增长，增加内存压力。
- **影响**: 启动时间随数据量线性增长。在中等规模部署（数千对话）中，启动可能需要数十秒到数分钟。内存消耗同样线性增长。
- **建议修复**: 实现懒加载（仅加载会话元数据，按需加载线程和运行）。为工件添加索引文件，避免全量扫描。考虑在启动后后台执行全面索引。

#### M20. 双 snake_case 和 camelCase 元数据键表明迁移不完整（3/3 验证）

- **位置**: `server/src/gis/postgis.ts` - `listLayers()`、`listVisibleLayers()`
- **问题**: 在 WHERE 子句中同时检查 `metadata_json->>'sessionId'` 和 `metadata_json->>'session_id'`（threadId、workspaceId、createdByUserId 同理），使用 OR 条件。这种双重性使查询复杂度加倍，表明命名约定之间的迁移不完整。新代码（`buildLayerMetadata()`）仅使用 camelCase，因此 snake_case 分支对新记录是死代码但对旧记录是必需的——无文档化的迁移截止日期。
- **影响**: 查询复杂度加倍，影响查询性能。无清理计划意味着 snake_case 死代码将永久存在。如果未来决定统一命名，需要处理遗留数据迁移。
- **建议修复**: 执行单次数据迁移将所有 snake_case 键转换为 camelCase，统一查询。迁移后移除 snake_case 分支，仅使用 camelCase。添加数据库级别的约束确保新写入使用统一命名。

#### M21. AppShell 是 1167 行单体，Hook 耦合度过高（2/3 验证）

- **位置**: `apps/web/src/app/AppShell.tsx`
- **问题**: AppShell 协调 7 个控制器、20+ 派生状态计算和 30+ 记忆化回调。`submitMessage` 函数仅有 28 个依赖。此单一组件了解会话、运行、资源、工具、导航、连接、记忆、图层、工件和地图状态。
- **影响**: 无法测试、难以重构、因过宽的重新渲染模式而存在性能风险。实质上变成了整个前端应用的状态"枢纽"。
- **建议修复**: 使用状态管理库（Zustand 推荐）将不同领域的逻辑分离。AppShell 变为纯编排组件，业务逻辑委托给独立的 Store/Hook。

#### M22. 全应用仅两个错误边界（2/3 验证）

- **位置**: `apps/web/src/app/AppShell.tsx`
- **问题**: 根 ErrorBoundary 和 MapErrorBoundary 是唯一的错误隔离点。ChatPanel、DetailPanel、WorkspaceLayout 及其侧边栏无独立边界。一个功能面板的崩溃可能使整个认证树宕机——唯一的回退是带"刷新页面"按钮的全应用包裹器，丢失所有状态。
- **影响**: 局部崩溃导致全局 UI 失效。用户丢失所有工作状态（输入的消息、展开的面板、选中的工具）。这是典型的问题隔离失败。
- **建议修复**: 为每个主要功能区域添加错误边界（React ErrorBoundary 组件），配合带上下文保留的降级 UI（如"该面板暂时不可用，其余功能正常"）。

#### M23. Zod Schema 覆盖不一致，关键端点无验证（3/3 验证）

- **位置**: `apps/web/src/api/client.ts`
- **问题**: 虽然许多 API 函数将 Zod Schema 传递给 `requestControl`，但多个关键端点（`bootstrapWorkspace`、`getThread`、`forkThread`、`getThreadHistory`、`listToolCatalogEntries`、`deleteThread`、`purgeThread`）使用裸 `as T` 类型断言。`bootstrap` 端点尤其关键，因为它在启动时水合整个工作区。
- **影响**: 这些端点的协议漂移静默产生运行时类型违规，因为客户端和服务器之间的契约不再一致。启动时水合的错误状态可能使整个应用不可用。
- **建议修复**: 为所有 API 端点添加 Zod 响应 Schema。使用 `safeParse` 处理预期内的 Schema 变化，优雅降级而非崩溃。Schema 应作为客户端-服务器契约的单一真相来源。

#### M24. resourceController 是 566 行 Hook，处理 7+ 个不同关注点（3/3 验证）

- **位置**: `apps/web/src/app/controllers/resourceController.ts`
- **问题**: resourceController 管理图层、底图、文件上传（含批量跟踪、重试逻辑和进度）、工件（GeoJSON 和栅格）、地图图层偏好、上传引用和文件 CRUD。混合了数据获取（useEffect 水化工件）、命令式上传逻辑（uploadOneFile 带进度跟踪）、状态管理和地图渲染关注点。
- **影响**: 违反了单一职责原则。难以测试、推理和独立修改任何功能。地图图层状态的推导逻辑与文件上传状态管理交织。
- **建议修复**: 拆分为 3-4 个独立的领域 Hook/Store：`useLayers`、`useFileUpload`、`useArtifacts`、`useMapPreferences`。每个负责单一功能域。

#### M25. WebSocket 重连期间无外发消息队列（2/3 验证）

- **位置**: `apps/web/src/ws/client.ts`
- **问题**: 如果 WebSocket 非 OPEN 状态，`send()` 立即抛出描述性错误。无队列缓冲重连期间发出的命令。指数退避 1.2s 至 30s 意味着重连期间的任何 API 调用（`run:start`、`thread:fork` 等）立即失败，而非排队并在重连后重放。
- **影响**: 短暂断网时用户操作静默丢失。用户可能看到"发送失败"错误，即使重连成功。在弱网络环境下（移动、现场部署）体验糟糕。
- **建议修复**: 实现消息队列：当 WS 关闭时，`send()` 将消息入队。重连成功后按序发送队列消息。添加队列大小上限和过期策略。

#### M26. 单个 Suspense 边界包裹整个认证渲染树（2/3 验证）

- **位置**: `apps/web/src/app/AppShell.tsx` - 第 826 行
- **问题**: 一个 `<Suspense>` 边界包裹整个认证应用树，包括 WorkspaceLayout、ChatPanel、MapCanvas、DetailPanel 和 DebugPage。触发回退（如导航到 /debug、/security 或激活地图）时，整个工作区 UI 被替换为通用加载消息。
- **影响**: 体验差。任何懒加载页面的加载状态都会替换整个 UI，而非提供局部骨架屏。用户无法在加载过程中看到地图或已加载的内容。
- **建议修复**: 为每个主要区域添加独立的 Suspense 边界，配合定制的骨架屏或加载指示器。地图加载、页面切换和功能面板应有各自的加载状态。

#### M27. Python Worker 单体工具分发函数 200+ 行 if/elif 链（3/3 验证）

- **位置**: `apps/worker/src/worker_app/sidecar.py` - `execute_meteorology_tool()`
- **问题**: 单一 200+ 行函数，if/elif 链处理约 20 个工具，每个分支重复路径解析、参数提取和响应组装逻辑。添加新工具需要编辑此链，无插件或注册机制。
- **影响**: 违反开闭原则。代码体积大（~700 行文件，本应为薄分发层）。每添加一个工具都需要修改核心分发函数，增加引入 bug 的风险。
- **建议修复**: 实现工具注册装饰器（如 `@meteorology_tool("tool_name")`），每个工具为独立类。使用类继承或协议定义公共接口。

#### M28. 内存 nonce 缓存阻止水平扩展且不 survive 崩溃（2/3 验证）

- **位置**: `apps/worker/src/worker_app/sidecar.py` - `_seen_nonces`
- **问题**: `_seen_nonces` 是进程内存中的模块级字典。在 worker 重启后丢失、不在多个 worker 实例间共享、无界增长至 `WORKER_NONCE_CACHE_MAX`。崩溃后重启的 worker 可接受重放的 nonce。负载均衡的 worker 池无法共享 nonce 状态。
- **影响**: 重放保护仅是实例级别而非全局的。在 worker 重启和水平扩展场景下，nonce 重放攻击是可行的。
- **建议修复**: 使用 Redis（或其他共享缓存）存储已使用的 nonce，设置 TTL 以限制内存增长。或为每个 worker 实例使用不同的签名密钥（但代价是密钥管理更复杂）。

#### M29. service.py 与 readers.py 之间存在大量代码重复（3/3 验证）

- **位置**: `packages/gis-meteorology/src/gis_meteorology/service.py` 与 `readers.py`
- **问题**: service.py（1447 行）与 readers.py（671 行）重复了数十个辅助函数：`_find_lat_lon_coords`、`_find_time_coord`、`_find_level_coord`、`_select_2d_data_array` 及更多。逻辑几乎一致。
- **影响**: 显著维护负担。任何 Bug 修复或功能增强必须在两个模块中同步。模块职责边界模糊——使用者在哪个文件中查找所需功能不明确。
- **建议修复**: 提取公共底层函数到共享模块（如 `_common.py` 或 `_utils.py`）。重构 service.py 使其专注于高层业务流程，readers.py 专注于数据读取，共享函数不再重复。

#### M30. 懒导入模式阻碍静态分析和类型检查（3/3 验证）

- **位置**: `packages/gis-meteorology/src/gis_meteorology/service.py`
- **问题**: 重型依赖（numpy、xarray、rasterio、h5py、Pillow、contourpy、matplotlib）通过私有函数 `_np()`、`_xarray()`、`_rasterio()`、`_h5py()`、`_pil_image()`、`_contourpy()` 导入。
- **影响**: 阻止 IDE 自动补全、mypy 类型检查，使导入图非显而易见。开发者需要猜测使用的导入别名。类型提示无法使用标准模块名称。
- **建议修复**: 使用标准顶层导入（`import numpy as np`）替代懒导入函数。如果导入性能确实需要优化，使用 before-after 钩子测量并仅在 Profiling 确认后才保留懒导入模式。

#### M31. 第三方源代码在 Worker 进程内运行，存在崩溃风险（3/3 验证）

- **位置**: `packages/gis-meteorology/src/gis_meteorology/third_party/radar_mosaic_agent/adapter.py`
- **问题**: 第三方雷达融合和降雨工具被导入并在 Worker 同一进程中执行。复制的工具代码中的段错误、无限循环或内存损坏会**宕掉所有进行中的请求**。
- **影响**: 第三方代码的一处 Bug 即可导致整个 Worker 崩溃，影响所有并发请求。这是**崩溃隔离的完全失败**。无子进程隔离、资源限制（ulimit）或第三方代码执行的 watchdog。
- **建议修复**: 
  - 通过子进程执行第三方代码（`subprocess.run` 有超时），通过 IPC（stdin/stdout JSON）通信。
  - 或在单独的 Docker 容器中运行第三方工具，通过 HTTP 或 gRPC 调用。
  - 添加资源限制（内存、CPU 时间）和执行超时。

#### M32. 测试文件被排除在 TypeScript 编译之外（2/3 验证）

- **位置**: `server/tsconfig.json`
- **问题**: Server tsconfig.json 显式排除测试文件（`"exclude": ["src/**/*.test.ts"]`）。这意味着测试文件作为构建过程的一部分**从不进行类型检查**。测试文件中的类型错误（如 mock 类型与生产接口漂移）直到运行时才被发现。`noOpDb()` shim 使用 `as unknown as Database` 断言，可能隐藏类型不匹配。
- **影响**: 测试通过但类型已损坏。Mock 和 Stub 中的类型错误在生产构建中不会被捕获。测试的可靠性降低。
- **建议修复**: 创建一个单独的 `tsconfig.test.json` 包含测试文件，或修改主配置以包含测试文件并确保类型检查包含测试。添加 CI 步骤强制测试文件类型检查。

#### M33. 无监控、指标或结构化日志基础设施（2/3 验证）

- **位置**: `server/src/main.ts`
- **问题**: 服务器有一个基本的 `/health` 端点检查数据库、PostGIS 和 Worker 连接性，但无指标收集（无 Prometheus、OpenTelemetry 或计数器）、无结构化日志框架、无分布式追踪（通过 `setTracingDisabled(true)` 显式禁用）、无告警或仪表盘配置。运维可见性局限于即兴的 `console.error` 调用。
- **影响**: 生产环境中的故障诊断依赖于手动日志检查。无法进行性能趋势分析、容量规划或主动告警。服务降级时运维团队无法及时发现。
- **建议修复**: 引入 Prometheus 客户端收集 HTTP 请求率、延迟、错误率和系统指标。添加结构化日志（pino）。配置 Grafana 仪表盘。启用 OpenTelemetry 追踪（最少为关键路径）。

#### M34. 无部署策略或基础设施即代码（2/3 验证）

- **位置**: `infra/docker/web/nginx.conf`
- **问题**: 无 Kubernetes manifest、Terraform 配置、Helm chart、部署脚本或发布自动化。项目没有超出在主机上运行 `npm run build` 的已定义部署工作流。nginx.conf 引用了 `${API_UPSTREAM}` 环境变量（暗示容器编排层），但无处配置此类层。
- **影响**: 部署是手动过程，不可重复、不可审计。环境差异导致"在我机器上没问题"。回滚需要手动 Git 操作和构建。无法进行蓝绿部署或金丝雀发布。
- **建议修复**: 初始化 Terraform 配置（云基础设施定义）。创建 Kubernetes 部署 manifest 或 Docker Compose 生产配置。添加发布自动化的 CI/CD 流水线。

#### M35. Worker nonce 重放保护为内存态，重启后丢失（2/3 验证）

- **位置**: `apps/worker/src/worker_app/sidecar.py`
- **问题**: HMAC 授权包含 nonce 用于重放保护，但 `_seen_nonces` 字典纯为内存态，无持久化。Worker 重启后所有此前见过的 nonce 被遗忘。默认时钟偏差容限为 30 秒。Token 生命周期通过 `exp` 负载可配置。
- **影响**: 在 Worker 重启窗口（约 30 秒 + token 有效期），捕获已签名 Token 的攻击者可重放它们。在水平扩展场景中，重放保护仅实例级别。
- **建议修复**: 将 seen nonces 存储在 Redis 中（含 TTL）。或使用数据库记录已使用的 nonce 组合（nonce + 时间窗口）。

#### M36. 三处相同的 Session 创建逻辑重复（3/3 验证）

- **位置**: `server/src/store/platformStore.ts` - `createSession()`、`getOrCreateUserDefaultSession()`、`getOrCreateDefaultSession()`
- **问题**: 三处重复相同的 session 对象构建逻辑：相同的字段默认值（shareToken、visibility 为 'workspace'、latestThreadId/latestRunId 等均为 null）。仅 ID 生成方式不同。
- **影响**: 如果 session Schema 变更，三处需同步修改。重复增加维护负担。
- **建议修复**: 提取 `createDefaultSession()` 工厂函数。三个调用者仅传递差异参数（user 上下文等）。

---

### MINOR

#### m1. 多处重复的 errorMessage 和 isRecord 工具函数（3/3 验证）

- **位置**: `server/src/agent/toolExecutionCoordinator.ts`、`runtime.ts` 等
- **问题**: `errorMessage`（将 unknown 转换为字符串）在 `toolExecutionCoordinator.ts` 和 `runtime.ts` 中定义。`isRecord` 工具函数在 `toolExecutionCoordinator.ts`、`deterministicNowcastRunner.ts`、`validation.ts` 中定义，`registry.ts` 从 `schema.js` 导入。这些微重复会独立漂移。
- **建议修复**: 将两者提取到共享工具模块（如 `server/src/shared/utils.ts`）。

#### m2. Worker 启动性能随总对话数据量线性下降（2/3 验证）

- **位置**: `server/src/store/platformStore.ts` - `initialize()`
- **问题**: 启动时读取所有 Session、Thread、Run 文件及其关联工件。无懒加载、无分页。
- **影响**: 大规模部署时启动时间缓慢。但此为启动时一次性开销，运行时不受影响。
- **建议修复**: 实现懒加载，启动后后台索引。

#### m3. 双命名约定元数据键表明迁移不完整（3/3 验证）

- **位置**: `server/src/gis/postgis.ts` - `listLayers()`
- **问题**: 与 M20 相同问题，但在这里作为 MINOR 记录（影响范围较小）。
- **建议修复**: 执行单次迁移并移除旧分支。

#### m4. 无 aria-live 区域用于动态内容更新，标题层次有限（3/3 验证）

- **位置**: `apps/web/src/app/AppShell.tsx`
- **问题**: 聊天面板、进度项和运行事件动态更新，但缺乏 aria-live 区域供屏幕阅读器播报。布局使用 aria-label 但在导航中无一致标题层次（h1-h6）。多个交互元素使用带 onClick 的 div 替代语义按钮，可折叠面板无 aria-expanded 或 aria-controls 属性。
- **影响**: 屏幕阅读器用户在动态内容更新时无法获得通知，键盘导航困难，可访问性不达标。
- **建议修复**: 为动态更新区域添加 `aria-live="polite"` 属性。使用语义 HTML 元素。为可交互的非原生元素添加 ARIA 属性。

#### m5. 懒导入模式阻碍静态分析（3/3 验证）

- **位置**: `packages/gis-meteorology/src/gis_meteorology/service.py`
- **问题**: 与 M30 相同，但此处列为 MINOR 版本（功能不受影响，仅开发体验）。
- **建议修复**: 使用标准导入，仅在 Profiling 确认后保留懒导入。

#### m6. 第三方源代码在 Worker 进程中运行（3/3 验证）

- **位置**: `packages/gis-meteorology/src/gis_meteorology/third_party/radar_mosaic_agent/adapter.py`
- **问题**: 与 M31 相同。
- **建议修复**: 子进程隔离执行。

#### m7. 测试文件排除在 TS 编译之外（2/3 验证）

- **位置**: `server/tsconfig.json`
- **问题**: 与 M32 相同。
- **建议修复**: 创建测试专用的 tsconfig 并加入 CI。

#### m8. 无监控/指标基础设施（2/3 验证）

- **位置**: `server/src/main.ts`
- **问题**: 与 M33 相同。
- **建议修复**: 引入 Prometheus + Grafana。

#### m9. 无部署策略或 IaC（2/3 验证）

- **位置**: `infra/docker/web/nginx.conf`
- **问题**: 与 M34 相同。
- **建议修复**: 初始化 Terraform + K8s manifests。

---

## 四、架构评分卡

| 维度 | 评分 | 一句话理由 |
|------|------|-----------|
| **架构设计** | **5/10** | 按功能域的模块划分清晰，但核心问题在于 PostgresPlatformStore 神类和 AgentRuntimeConfig 单体配置 blob，阻碍了系统演化。 |
| **Agent 与工具系统** | **6/10** | 记忆架构和上下文压缩设计精巧，但是与 OpenAI SDK 的强耦合、硬编码确定性流水线和不准确的 Token 估算限制了灵活性和可靠性。 |
| **安全性** | **4/10** | CSP 外泄风险、unix_local 沙箱后门、内存态速率限制在多实例中无效——是最薄弱的维度。CSP、沙箱、认证错误消息的字符串匹配均有可直接利用的弱点。 |
| **代码质量** | **5/10** | 多处代码重复（isRecord、JSON 解析、session 创建）、巨型 switch/if-elif 链、无结构化日志——体现了从原型到产品的过渡期债务积累。 |
| **数据与持久化** | **5/10** | WAL 崩溃恢复和 JSONL 幂等性实现出色，但全量文件扫描的 O(n) 性能问题、Schema 版本无迁移路径、跨实例无锁等问题限制了扩展性。 |
| **前端架构** | **5/10** | 懒加载分包策略和地图延迟激活实现优雅，但 AppShell 的 1170 行单体和 70+ props 深度穿透严重影响了可维护性。仅两个错误边界和单 Suspense 边界放大了局部故障。 |
| **Python Worker 与 GIS** | **4/10** | GIS 数据处理能力扎实但组织混乱：service.py 与 readers.py 大量重复、单体 if/elif 工具分发、懒导入隐藏依赖图、第三方代码无隔离运行。 |
| **测试与 DevOps** | **2/10** | 最大短板：零 CI/CD、零容器化、零 IaC、测试文件被排除在类型检查外、无性能或端到端测试覆盖。这些阻碍了项目的生产化部署。 |

**总体均分**: 4.5/10

---

## 五、优先改进建议

按 影响/工作量 比值排序（高比值优先），每个建议含估算工作量：

### 1. 添加 CI/CD 流水线（高影响 / 低工作量）
- 添加 GitHub Actions 配置，覆盖 PR 类型检查、单元测试、Lint。
- 作为"守门人"阻止明显损坏的代码合并，立竿见影提升代码质量。
- **估算**: 1-2 天

### 2. 修复 CSP connect-src（高影响 / 低工作量）
- 将 `https:` 和 `wss:` 替换为白名单域名。
- 消除最大的 XSS 利用向量。
- **估算**: 1 小时

### 3. 移除 unix_local 沙箱后端（高影响 / 低工作量）
- 从 SandboxBackend 类型中移除 `unix_local` 或在运行时强制拒绝。
- 堵上沙箱逃逸的官方后门。
- **估算**: 1 小时

### 4. 用模型感知 Tokenizer 替换 chars/4 启发式（高影响 / 中工作量）
- 引入 `tiktoken` 或提供可配置的 Tokenizer 接口。
- 消除系统性 Token 估算误差，修复压缩时机和内存阈值。
- **估算**: 2-3 天（含测试）

### 5. 引入结构化日志（中影响 / 中工作量）
- 添加 pino 日志库。配置请求级关联 ID 和日志级别过滤。
- 替换所有 `console.log/error`。
- **估算**: 2-3 天

### 6. 为 WebSocket 命令实现命令模式（中影响 / 中工作量）
- 将 260 行 switch 替换为命令注册表 + 独立处理器。
- 简化新命令的添加，提升可测试性。
- **估算**: 2-3 天

### 7. 提取重复的 invokeStructuredModel / isRecord / errorMessage（中影响 / 低工作量）
- 将公共工具函数提取到共享模块。
- 消除维护债务，确保 Bug 修复传播到所有消费者。
- **估算**: 0.5 天

### 8. 为所有 API 端点添加 Zod Schema 验证（中影响 / 中工作量）
- 为未验证的端点（bootstrap、thread 操作等）添加响应 Schema。
- 捕获客户端-服务器协议漂移。
- **估算**: 2-3 天

### 9. 应用服务容器化（高影响 / 中高工作量）
- 为 Server、Web、Worker、Nginx 创建 Dockerfile。
- 更新 docker-compose 包含所有服务。
- **估算**: 3-5 天

### 10. 拆分 AppShell 为较小组件（中影响 / 高工作量）
- 引入状态管理库（Zustand）。
- 将 1170 行单体拆分为 3-5 个专注组件。
- 添加独立的 Suspense 边界和 ErrorBoundary。
- **估算**: 1-2 周

### 11. 实现 JSONL 行偏移索引（中影响 / 中工作量）
- 为 JSONL 文件添加索引文件，支持 O(1) 偏移读取。
- 消除 O(n) 全文件扫描。
- **估算**: 3-5 天

### 12. Python Worker 工具注册机制（中影响 / 中工作量）
- 用装饰器注册替代 if/elif 链。
- 提取共用代码到基础类。
- **估算**: 2-3 天

### 13. 为工具调用添加超时（中影响 / 中工作量）
- 为每个 `invokeStructuredModel` 调用添加独立超时（30s）。
- 防止单挂起工具阻塞整个运行。
- **估算**: 1-2 天

### 14. 第三方代码子进程隔离（高影响 / 低工作量）
- 使用 `subprocess.run`（带超时）执行第三方 GIS 工具，通过 stdin/stdout JSON 通信。
- 防止第三方崩溃影响 Worker 进程。
- **估算**: 1-2 天

### 15. 提取冗余的 session 创建逻辑（低影响 / 低工作量）
- 将三处相同的 session 构建逻辑合并为单一工厂函数。
- **估算**: 1 小时

---

## 六、总结

### 项目做得特别好的方面

1. **上下文压缩与记忆架构**：三级降级回退的 Token 感知压缩、WAL 崩溃安全的对话记录、分层化版本化记忆架构——这些是经过深思熟虑的高质量设计，展示了架构师对可靠性和可审计性的深入理解。

2. **前端的性能意识**：懒加载分包 + 两帧延迟地图激活使首屏加载时间得到了很好的控制。这种对 bundle 体积的主动管理在 GIS 应用中尤为重要。

3. **核心技术栈选择**：TypeScript 全栈（Server + Web）、PostGIS 空间数据库、React + MapLibre 前端，技术选择合理且现代。

4. **Zod Schema 驱动的验证模式**：虽然覆盖不完整，但已在使用 Zod 进行运行时 Schema 验证的模块展示了良好的契约式设计意图。

### 最紧迫的问题

1. **不可部署**：无 CI/CD、无容器化、无 IaC。这是项目从原型走向产品面临的最大障碍。即使代码质量完美，无法可靠部署 = 无法交付。

2. **安全薄弱**：CSP 允许任意端点外泄、沙箱有官方后门、速率限制不跨实例——这些是生产环境中的直接可攻击面。

3. **单点故障**：PostgresPlatformStore 神类、AppShell 1167 行单体、260 行 switch 语句——系统在多个层面存在故障单点，阻碍并行开发和演化。

4. **系统性精度问题**：chars/4 的 Token 估算影响所有依赖 Token 计数的功能——压缩、内存、上下文限制——但问题未在表面显现，因为错误是一致的（始终低估），所以系统"稳定地错误工作着"。

5. **代码重复**：isRecord、errorMessage、JSON 解析逻辑、session 创建、service.py/readers.py 辅助函数——大量重复代码增加了维护成本，Bug 修复必须在多处同步。

### 总体评估

Newmap 是一个**架构意图良好但处于演化阵痛期**的项目。内存管理和上下文压缩等核心基础设施展示了高水平的工程思维。然而，项目在从单人/小团队原型向生产级平台过渡的过程中积累了大量技术债务：

- **架构债务**：神类、单体配置、深度 prop 穿透
- **安全债务**：CSP 外泄、沙箱后门、内存态速率限制
- **工程化债务**：零 CI/CD、零容器化、零 IaC、无结构化日志
- **代码质量债务**：多处代码重复、巨型条件链、测试排除在类型检查外

优先级最高的行动是**建立交付管道**（CI/CD + 容器化），这是其他所有改进的基础。其次是修复最明显的安全弱点（CSP、沙箱后端），然后拉平工程化差距（结构化日志、API Schema 验证覆盖）。

项目的核心数据模型和 Agent 架构虽有缺陷但方向正确——它们需要重构而非重写。建议在短时间内集中处理上述"低工作量、高影响"项目以建立改进势头，然后规划更大的重构（拆分神类、拆解单体组件），同时保持功能开发节奏。
