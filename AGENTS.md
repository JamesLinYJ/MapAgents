# AGENTS.md

## 文档定位

本文件是 GeoForge 地理智能平台的**工程标准文档**。它定义代码的组织方式、命名惯例、质量边界和设计约束，供人类开发者和 AI Agent 共同遵从。

本文件不是临时笔记、不是 bug 追踪、不是重构待办清单。它描述"应该怎样"，不描述"当前哪里不符合"。不符合标准的代码是技术债务，技术债务在代码中管理，不在这里。

本文件不是不可质疑的教条。若某条规则与更清晰的事实源、更强的安全边界、更好的可测试性或更成熟的通用组件冲突，应先修正文档，再修正代码。工程标准服务于系统质量，不服务于历史习惯。

阅读顺序：新成员从头读；查规范按目录跳转；AI Agent 应先读取与当前修改相关的章节，涉及跨层改动、安全边界或架构判断时再全文复核。

---

## 目录

0. [架构原则](#零架构原则)
1. [文件结构规范](#一文件结构规范)
2. [TypeScript 规范](#二typescript-规范)
3. [Python 规范](#三python-规范)
4. [React 前端规范](#四react-前端规范)
5. [Node.js 后端规范](#五nodejs-后端规范)
6. [Agent 运行时规范](#六agent-运行时规范)
7. [气象数据规范](#七气象数据规范)
8. [安全规范](#八安全规范)
9. [可观测性规范](#九可观测性规范)
10. [测试规范](#十测试规范)
11. [工具系统规范](#十一工具系统规范)
12. [记忆系统规范](#十二记忆系统规范)
13. [依赖与 Vendor 管理规范](#十三依赖与-vendor-管理规范)

---

## 零、架构原则

GeoForge 的目标不是"能跑"，而是长期可演进、可审计、可测试的地理智能平台。新增或重构代码必须遵守以下优先级：

1. **事实源唯一**：每类状态只能有一个权威事实源。文件型 conversation store 是会话历史事实源；Postgres 是平台索引和权限事实源；Zustand 是浏览器端实时业务状态事实源；TanStack Query 是 HTTP 查询缓存事实源。
2. **边界显式**：HTTP、WS、Worker、文件系统、数据库、模型输出都是信任边界。跨边界必须有 schema、权限、错误模型和测试。
3. **资源所有权清晰**：按 Session、Thread、Run、Artifact、Dataset、Layer、Tool、Config、Audit 等资源拆分模块。任何模块同时拥有三类以上资源的写路径，都需要重新设计。
4. **通用基础设施优先成熟组件**：弹窗、下拉、表格、虚拟列表、表单、查询缓存、WebSocket 重连、日志、指标、队列、限速、文件锁等通用能力优先使用稳定组件，再用 GeoForge 风格封装。
5. **平台核心边界自研**：Agent 运行时状态机、valueRef 流、工具审批、地理/气象领域语义、权限策略和跨语言工具契约属于平台核心，必须可审计、可测试，不外包给隐式黑盒。
6. **硬失败优先于假成功**：schema 漂移、工具失败、权限失败、Worker 失败、索引写失败必须明确失败并暴露中文原因。禁止 fallback 成功文案、兼容旧 payload、catch 后吞错或伪造 artifact。
7. **测试证明架构边界**：重构不是移动文件。每个新边界必须有测试证明：调用方只依赖窄接口、禁止旧路径回流、失败路径真实失败。

---

## 一、文件结构规范

### 1.1 文件头与模块说明

文件头用于说明模块身份，不是质量本身。新建关键边界文件、公共服务、长期维护的领域模块建议使用统一文件头；普通小组件、测试局部 fixture、机械拆分出的 re-export 文件不强制补文件头。不得为了补文件头制造大面积无意义 diff。

```
# +-------------------------------------------------------------------------
#
#   地理智能平台 - 模块中文名称
#
#   文件:       file_name.ext
#
#   日期:       YYYY年MM月DD日
#   作者:       Author Name
# --------------------------------------------------------------------------
```

- Python 文件使用 `#` 注释前缀
- TypeScript / TSX 文件使用 `//` 注释前缀
- 日期记录文件创建日期；若无法可靠判断，允许省略日期行
- 作者字段只在明确有维护归属时填写；没有明确归属时依赖 Git 历史，不伪造作者
- 文件头缺失本身不构成架构问题；职责不清、边界混乱、测试缺失才构成必须修复的问题

### 1.2 文件复杂度预算

文件可维护性不能用固定行数机械判断。GeoForge 使用**职责复杂度预算**：一个文件应当能用一句话说明唯一职责，且主要修改原因应该集中在同一个资源、协议或 UI 面板边界内。

以下信号出现两个以上时，必须优先考虑拆分，而不是继续堆代码：

- **多资源写路径**：同一文件同时修改 Session、Thread、Run、Artifact、Dataset、Layer、Tool、Config、Audit 中三类以上资源
- **多协议边界**：同一文件同时处理 HTTP、WS、Worker、文件系统、数据库、模型输出等多个信任边界
- **多状态机**：同一文件同时维护多个生命周期或交互状态机，例如连接、上传、运行、审批、地图交互混在一起
- **测试定位困难**：为了验证一个小行为必须构造大量无关依赖，或测试只能通过端到端路径间接覆盖
- **导入方向异常**：低层模块导入高层模块，或 UI 组件直接导入 transport/store/runtime 细节
- **重复边界逻辑**：schema 校验、路径解析、鉴权、错误格式、valueRef 解析、artifact 写入在多个文件中重复实现
- **阅读断层明显**：文件内部自然分成多个大段，每段都有独立的数据模型、错误处理和测试场景

拆分原则：

- **按所有权命名**：拆分出的模块名表达唯一职责，如 `WorkerPathSandbox`、`ToolExecutionRoute`、`RunStore`；避免 `*Utils`、`*Helpers` 这类无所有权命名
- **边界先行**：优先抽出信任边界、资源所有权、状态机和通用基础设施，而不是为了缩短文件随机切片
- **接口保持窄**：原模块可以保留 facade 或 re-export，但调用方只能依赖窄接口，不能继续穿透内部实现
- **测试随行**：拆分同时迁移或新增测试，不允许"先拆分，测试以后补"
- **守卫职责，不守卫行数**：`architecture.test.ts` 应检查禁止导入、禁止旧路径回流、命令注册完整性、schema/policy 存在等结构事实；不要用固定行数作为质量门槛

### 1.3 目录组织

目录结构反映架构分层。添加新文件时遵循以下规则：

- **`server/src/agent/`**：Agent 运行时编排——run 生命周期、上下文管理、审批、沙箱。不含工具实现
- **`server/src/framework/`**：工具注册、Provider 加载、环境配置、类型定义。框架级代码，不含业务逻辑
- **`server/src/tools/`**：每个子目录是一个独立的 ToolProvider。工具适配器（薄层），不包含领域算法
- **`server/src/store/`**：持久化门面和文件事实源。`platformStore.ts` 只做 facade，不拥有所有资源写逻辑；Postgres 资源写入放入 `store/postgres/*Store.ts`；会话/线程/运行内存索引放入独立索引模块
- **`server/src/routes/`**：HTTP 路由。一个文件一组相关端点
- **`server/src/ws/`**：WebSocket 控制面。命令必须通过 registry 注册；一个文件一个命令组（如 `memoryCommand.ts`、`toolCommand.ts`），禁止新增大型 switch
- **`server/src/security/`**：认证、授权、限速、CSRF。安全逻辑集中管理
- **`server/src/app/` 或 `server/src/container/`**：应用级依赖装配。只创建 container、store、runtime、registry 和 route/WS 依赖，不写业务逻辑
- **`apps/web/src/app/`**：应用壳层、路由、全局 store 装配、启动流程
- **`apps/web/src/app/stores/`**：Zustand slices。只保存跨功能事实状态和 WebSocket streaming 状态，不放 UI 临时表单字段
- **`apps/web/src/features/`**：功能模块——每个子目录是一个自包含的功能域（含组件、局部状态、类型）
- **`apps/web/src/shared/`**：跨功能共享的组件和工具函数
- **`apps/web/src/api/`**：传输层（HTTP + WebSocket），不含业务逻辑
- **Worker 工具契约**：Worker 内部 API 以 Python Pydantic request/response model 为事实源，`/tools/catalog` 由 `model_json_schema()` 自动生成；Node 只消费 catalog 并校验出站参数，不维护第二份手写 Worker schema
- **`packages/gis-meteorology/`**：科学计算领域逻辑。不含 Web 框架代码
- **`apps/worker/`**：Python Web 层——仅路由和中间件。领域逻辑委托给 `gis_meteorology`

### 1.4 注释规范

注释解释**职责、意图和边界条件**，不重述语法。

**必须写注释的场合**：

- 公共边界类、状态化函数、恢复流程、审批流程和跨语言适配器，需要用简短注释说明角色和边界
- 关键路径源文件中，解释状态所有权、事件语义、审批边界、恢复行为
- 任何非显而易见的逻辑——尤其是运行时状态、fallback 硬边界、测试隔离、UI 状态派生
- 注释长度由复杂度决定，不按固定行数凑格式；如果需要长注释解释才能理解，优先考虑拆分或改名

**不写注释的场合**：

- 不要逐行重述赋值
- 不要在产品 UI 文案中夹杂工程注释
- 不要在函数名已经足够清晰的小型辅助函数上加注释
- 不要把业务或运行时决策藏在代码里而不加注释——这是最需要注释的场景

**术语选择**：优先使用中文领域术语——"运行时配置编辑态"、"fallback 硬边界判定"、"测试数据库地址解析"。中文是平台的一等领域语言，不是翻译层。

---

## 二、TypeScript 规范

### 2.1 编译器严格性

TypeScript 的编译器选项是第一道防线。

- `strict: true`：所有 `tsconfig.json` 必须开启（已强制）
- `noUncheckedIndexedAccess: true`：**必须开启**。所有 `Map.get()`、数组索引、Record 访问必须显式处理 `| undefined`：
  ```typescript
  // 错误：可能返回 undefined 而未经检查
  const session = this.sessions.get(sessionId)
  return session.workspaceId

  // 正确：显式处理缺失情况
  const session = this.sessions.get(sessionId)
  if (!session) throw new StoreNotFoundError(`会话 '${sessionId}' 不存在`)
  return session.workspaceId
  ```
- `noUnusedLocals` 和 `noUnusedParameters`：建议在 CI 中强制，避免死代码累积
- `exactOptionalPropertyTypes`：建议开启，防止 optional 和 `| undefined` 的语义混淆

### 2.2 类型安全

- **禁止 `as any`**：生产源码中不允许出现。对外部数据使用 `unknown` + 类型守卫或 Zod `safeParse`；对确实无法推断的场景使用 `as unknown as SpecificType` 双重断言并附注释说明原因
- **Zod 作为边界校验**：所有外部输入（HTTP body、WS payload、环境变量、文件内容）必须经过 Zod schema 校验后才进入内部逻辑。不允许 `as T` 裸断言跨越信任边界
- **共享类型**：跨包类型定义放在 `packages/shared-types/src-ts/index.ts`，通过 Zod schema 派生 TypeScript 类型。Server 和 Web 各自派生自己的内部类型，只在边界使用共享类型
- **泛型使用**：泛型应该约束类型关系，而非绕过类型检查。如果泛型参数只出现一次且不需要约束关系，考虑是否真的需要泛型

### 2.3 模块系统

- 使用 ESM（`"type": "module"`），不提供 CJS 回退
- 导入路径使用 `.js` 扩展名（Node.js ESM 规范）
- 禁止循环依赖：`architecture.test.ts` 应包含循环依赖检测。如果确实需要双向引用，提取共享接口到独立文件
- 不在 `index.ts` 中做副作用导入——只用于 re-export

### 2.4 依赖注入优于全局单例

全局可变单例破坏测试隔离，阻碍多租户部署。

- **禁止**新增 `export const ... = new ...()` 模块级可变单例
- **要求**：有状态的 Service 类通过构造函数或工厂函数接收依赖：
  ```typescript
  // 正确：显式依赖
  export function createMyService(deps: { store: PlatformStore; registry: ToolRegistry }) {
    return new MyService(deps.store, deps.registry)
  }
  ```
- 现有全局单例（`toolRegistry`）是已知债务。新代码通过依赖注入获取，不新增对全局导出的直接引用
- 测试文件中通过 `beforeEach` 重建或使用工厂函数创建隔离实例

---

## 三、Python 规范

### 3.1 命名约定

- Python 端统一使用 `snake_case`：变量名、函数名、API 参数名
- TypeScript 适配器在语言边界处统一做 `snake_case` ↔ `camelCase` 映射
- 禁止 Python API 参数混合使用两种命名风格——边界映射的责任在调用方

### 3.2 文件组织

Worker（`apps/worker/`）按以下结构组织：

```
worker_app/
  sidecar.py           # FastAPI app 创建 + 生命周期管理
  auth.py              # HMAC 签名验证 + nonce 管理
  routes/
    health.py          # /health
    tools.py           # /tools/{tool_name} — 18 个科学计算端点
  middleware/
    body_limit.py      # 请求体大小限制 (16MB)
    concurrency.py     # asyncio.Semaphore 并发控制
  security/
    path_sandbox.py    # 路径遍历防护 + 空字节检测
    code_scan.py       # 源码安全扫描 (allow_pickle 等危险模式)
```

- Worker 只做路由和中间件。科学计算逻辑全部放在 `packages/gis-meteorology/`
- 单一入口 `sidecar.py` 只负责创建 FastAPI app、装配中间件、注册路由和生命周期；日志、认证、路径沙箱、参数解析、工具分发必须拆到独立模块。是否继续拆分按职责复杂度判断，不按固定行数判断

### 3.3 科学计算包结构

`packages/gis-meteorology/src/gis_meteorology/`：

- **`readers.py`**：栅格读取抽象层。`MeteorologicalReaderFacade` 是唯一的公共入口。所有读取逻辑以 Reader 类的形式注册到 Facade
- **`service.py`**：`MeteorologicalDataService` 是面向工具端的公共 API。它**委托**给 `readers.py`，不能重复实现读取逻辑
- **`nowcast.py`**：临近预报领域服务（序列创建、降水分析、预报文本生成）
- **`radar.py`**：天气雷达 BZ2 解码 + 极坐标到 WGS84 转换
- **`report.py`**：DOCX 报告生成
- **`third_party/`**：第三方算法适配器（详见 13.3 节）

禁止 `service.py` 和 `readers.py` 之间出现以下函数的重复实现：
`_open_xarray_dataset`、`_find_lat_lon_coords`、`_normalize_missing_values`、以及任何栅格数据打开逻辑。`readers.py` 是权威实现，`service.py` 是消费者。

### 3.4 惰性导入

所有重量级库（numpy、xarray、rasterio、geopandas、scipy、matplotlib、cfgrib、netCDF4、h5py、shapely）必须通过模块级 getter 函数惰性导入：

```python
def _np():
    import numpy as np
    return np
```

目的：`import gis_meteorology` 几乎零开销（<10ms），使 Worker 启动和健康检查保持快速。库只在首次实际调用时才加载。

### 3.5 Worker 安全约束

- 路径解析：拒绝绝对路径、`..` 段、空字节注入。`RUNTIME_ROOT` 外的路径一律拒绝
- 临时文件：使用 `tempfile.TemporaryDirectory` 上下文管理器，确保自动清理
- 请求完整性：HMAC bodyHash 将签名绑定到请求体；最大 16MB；nonce 去重缓存（10,000 条，LRU 淘汰）
- 禁止的操作模式：`allow_pickle=True`（numpy 安全风险）、`warnings.filterwarnings`（掩盖问题）、`os.chdir`（工作目录副作用）。CI 中通过 `code_scan.py` 自动扫描

---

## 四、React 前端规范

### 4.1 状态分类

在注释中明确标注每种状态的来源：

- **server query state**：HTTP 查询结果，归 TanStack Query 管理
- **streaming app state**：WS 推送、run、timeline、connection status，归 Zustand 管理
- **workspace state**：workspaceMode、sidebar selection、active thread/run 等跨功能状态，归 Zustand 管理
- **user-edited local state**：输入框、表单编辑态、临时筛选，优先保留在组件本地或 react-hook-form
- **memoized view state**：通过 selector、`useMemo`、`useDeferredValue` 计算的视图状态
- **debug-only diagnostic state**：仅调试页面使用的诊断状态

### 4.2 前端状态事实源

GeoForge 前端使用分层状态，不用单一巨大 Context，也不把所有状态塞进组件 props。

- **Zustand**：跨功能事实状态。按领域拆成 `authStore`、`workspaceStore`、`sessionStore`、`runStore`、`resourceStore`、`uiStore`。组件必须用 selector 精确订阅，禁止一次订阅整个大对象。
- **TanStack Query**：HTTP query/cache。只管理 `auth/me`、后台管理、图层/数据列表等可重新获取的数据；不要承载 WebSocket streaming 状态。
- **React Context**：只用于低频、稳定的 dependency/context，如 theme、i18n、query client、router。高频 run/timeline 状态禁止放 Context。
- **Props**：用于局部、短链路、纯展示组件。一个 prop 穿过 3 层以上且中间层不使用时，应改为 store selector、组件组合或局部 provider。
- **react-hook-form + Zod**：登录、管理后台、工具表单、运行时配置表单的默认方案。

### 4.3 AppShell 与控制器

`AppShell.tsx` 是装配层，不是业务 God Component。它负责 Provider、路由、布局壳和少量启动流程，不持有大段业务状态。

- 控制器 Hook 放在 `app/controllers/`，只做 UI orchestration：把用户动作编排成 store action、query mutation 或 `requestControl`。
- 跨组件事实状态在 Zustand slice 中，不靠 AppShell props 逐层下传。
- 当 AppShell 同时装配多个互不相关的领域控制器，或回调依赖开始跨资源膨胀时，应拆出 `WorkspaceShell`、`ChatShell`、`MapShell` 等中间装配层。
- `resourceController` 这类聚合控制器不得同时管理上传、Artifact、水合、底图和图层。按资源所有权拆成 upload、artifactHydration、layer、basemap 等模块。

### 4.4 性能模式

以下模式是默认行为，不是可选优化：

- **动态导入**：MapLibre、重量级面板（`DebugPage`、`DetailPanel`）使用 `import()` 动态加载，不进入首屏 bundle
- **惰性激活**：地图在 `requestAnimationFrame` + `requestIdleCallback` 后才初始化
- **流处理**：高频事件使用 `useDeferredValue` 避免阻塞 UI；非紧急更新包裹 `startTransition`
- **长列表**：历史对话、日志、属性表、工具目录使用 `@tanstack/react-virtual` 或分页，不手写无限滚动状态机
- **表格**：属性表、安全后台表格、工具目录表格使用 `@tanstack/react-table`，排序、列状态、分页不手写
- **SVG 滤镜**：视觉效果（LiquidGlass）延迟到 `requestIdleCallback`
- **无障碍**：动画效果遵从 `prefers-reduced-motion`；对比度遵从 `prefers-contrast`；数据节省遵从 `Save-Data` header

### 4.5 传输层

`apps/web/src/api/transport.ts` 统一三种通信方式：

| 函数 | 协议 | 用途 | 超时 |
|------|------|------|------|
| `requestJson<T>()` | HTTP | JSON 请求/响应 | 30s |
| `requestFormJson<T>()` | HTTP | FormData 上传 | 120s |
| `requestControl<T>()` | WebSocket | 业务控制命令 | 45s (WS 超时) |

- 三者共享 CSRF token 注入、错误格式化和 Zod schema 校验
- 新增后端功能时按协议语义选择边界：实时控制、运行状态、订阅和短命令使用 `requestControl`；认证、文件上传、blob 下载、健康检查、指标、可分页查询和可缓存查询使用 HTTP。例外必须在调用点或 route/command 注册处说明原因
- API 基地址通过 `deriveApiBaseUrl()` 推断，支持同源部署和跨端口开发两种模式
- 可选的 Zod schema 参数用于校验后端响应，防止 `as T` 掩藏字段缺失或类型变更
- 浏览器端 WebSocket 底层连接使用 PartySocket/ReconnectingWebSocket；GeoForge 自己的 transport 只负责 request id、pending map、CSRF、Zod response validation、push 分发和重连后的 resubscribe
- 禁止组件直接 `new WebSocket()`。所有业务 WS 调用必须通过 `requestControl` 或统一 transport action

---

## 五、Node.js 后端规范

### 5.1 启动与关闭

**启动顺序**（`main.ts` 中规定的权威顺序）：
1. 加载环境变量
2. 禁用外部 Agent tracing
3. 创建 DB 连接池 + PostGIS + Model Registry + 默认 Runtime Config
4. 确保 DB schema（气象表 → 安全表）
5. `store.initialize()` ——从文件系统恢复内存索引
6. 种子图层（如配置了 `SEED_LAYERS_DIR`）
7. 发现并加载 ToolProvider（`discoverAndLoad`）
8. 构建 Hono app + 注册路由 + 中间件
9. 创建 HTTP Server + WebSocket handler
10. 安装生命周期管理器
11. 开始监听

在 `store.initialize()` 完成之前，不得启动 HTTP 监听。

**关闭流程**（`lifecycle.ts` 是唯一协调点）：
1. 设置 `isShuttingDown = true`——除 `/health` 外全部请求返回 503
2. 关闭所有 WebSocket 连接（code 1001）
3. 并发关闭 HTTP Server + WebSocket Server
4. Flush 文件存储（确保所有 JSONL 写入完成）
5. 关闭数据库连接池
6. 超时 10s → force exit(1)

不要在 `lifecycle.ts` 之外添加独立的信号处理器。

### 5.2 存储架构

**双存储模式**：
- **文件系统**（`runtime/conversations/`）：会话、线程、运行历史的**唯一事实源**。JSONL 追加写入，不原地修改
- **PostgreSQL/PostGIS**（Drizzle ORM）：用户、工作区、权限、图层元数据、运行时配置、工具目录、Artifact 搜索索引——即**查询索引**，不含会话历史

**设计约束**：
- Postgres 中不得存储 transcript entry、conversation item、run event——这些只在文件系统中
- 文件型存储的 schema 变更必须通过 bump `STORE_SCHEMA_VERSION` 来标识，不兼容版本必须拒绝启动并给出明确的迁移指南
- 内容寻址对象存储（`runtime/objects/sha256/`）使用 SHA256 哈希寻址，2 字符前缀分片。垃圾回收扫描所有引用后清理未引用对象
- `PostgresPlatformStore` 是 facade，不是 God Object。它可以组合资源 Store，但不得直接承载所有 SQL、所有索引和所有资源生命周期
- Postgres 资源按所有权拆分：`SessionStore`、`ThreadStore`、`RunStore`、`ArtifactStore`、`MeteorologicalDatasetStore`、`LayerStore`、`ToolCatalogStore`、`RuntimeConfigStore`、`AuditStore`
- 普通 CRUD 默认使用 Drizzle schema/query builder。`db.execute(sql...)` 只允许用于 PostGIS、DDL、健康检查或 query builder 无法表达的明确特殊查询，并在代码注释中说明原因
- 跨表写入必须使用事务。例如创建 run、更新 thread/session 指针、写 audit、更新 latest dataset 指针，不能分散成多个无事务写入
- 数据库 schema 必须有外键、唯一约束、索引和级联策略。新增表不能只靠应用层约束维持一致性
- 测试替身必须模拟真实边界。禁止为了旧测试在生产代码里写 `if (db.insert missing)`、`if (security)`、`try fallback` 这类兼容分支

### 5.3 错误处理

- HTTP 错误响应格式：`{ detail: "中文错误描述" }`
- WebSocket 错误响应格式：`{ ok: false, error: { code: "command_failed" | "not_found" | "invalid_request", message: "..." } }`
- 客户端永远只收到**稳定中文消息**。内部错误详情（stack trace、文件路径、SQL 语句）只记录在服务端日志中
- 禁止将原始 `error.message` 直接返回给客户端——它可能包含内部路径或敏感信息
- 500 级别错误统一返回 `"服务处理失败。请查看服务端日志。"`

### 5.4 HTTP 与 WebSocket 分工

- **HTTP 数据面**：承载认证、健康检查、指标、文件上传、blob 下载、可分页查询、可缓存查询和浏览器/代理天然支持更好的请求响应操作
- **WebSocket 控制面**（`/ws`）：承载实时运行控制、订阅、决策响应、流式状态、低延迟命令和需要连接级上下文的业务动作
- HTTP 与 WS 都只是传输层；端点必须是薄层，验证输入后委托给 Service/Store/Runtime，不在 route 或 command 里堆业务逻辑
- 不在 WebSocket 消息中传输大文件——文件引用使用 `contentRef`（SHA256 路径）
- 同一能力不得同时维护 HTTP 和 WS 两套可变事实源。若确实需要两种传输，必须共享同一个 service、schema、权限策略和测试

### 5.5 WebSocket 命令注册表

WS 控制面必须使用命令注册表，而不是单个 `handleMessage()` 大型 switch。

每个命令注册项必须包含：

- `type`：命令类型，必须来自共享协议枚举
- `payloadSchema`：Zod schema，解析后 handler 才能执行
- `responseSchema`：可选但推荐，用于服务端测试和前端协议校验
- `auth`：`required` 或 `optional`，默认 required
- `csrf`：mutating command 必须 true
- `policy`：RBAC 对象、动作和资源解析器；没有 policy 的命令启动失败
- `handler`：只接收解析后的 payload、依赖、连接上下文，不直接读原始 WS message

命令组按资源拆分：`sessionCommands`、`threadCommands`、`runCommands`、`toolCommands`、`memoryCommands`、`fileCommands`、`layerCommands`、`systemCommands`。新增命令必须在对应模块注册，并补 happy path、auth fail、schema fail 测试。

### 5.6 依赖注入

服务端使用显式依赖装配，不新增模块级可变单例。

- `main.ts` 只负责读取 env、创建 container、注册 route/WS、启动生命周期
- route、WS command、runtime、ToolProvider、ModelRegistry、Store 都通过构造参数或 container 获取依赖
- 测试必须能创建隔离 container；不能依赖全局缓存的 env、registry、store
- 现有历史单例只能作为债务逐步收敛，新代码不得继续直接导入它们

---

## 六、Agent 运行时规范

### 6.1 核心原则

- `AgentStateModel` 是单次 run 的执行快照
- `runtime/conversations` 下按 `session/thread/run` 分片的 JSON、JSONL 和 Markdown 是运行历史的**唯一事实源**——Postgres 不保存这些
- `event_msg` 是实时叙事和 UI/SSE 的重放日志
- `context_entry` 和 `compacted` 记录是持久化的会话事实

### 6.2 上下文规则

这些规则是硬约束，不是建议：

1. **禁止自动注入历史**：历史 run 的日志、event、transcript 不得被运行时扫描并静默注入 prompt。之前的 fact 只能通过两种方式进入当前 turn：(a) 显式的 compaction（摘要压缩），(b) 模型主动调用 `list_context_references` 或 `search_thread_context` 等上下文工具

2. **默认不可见**：Supervisor 系统提示词可以声明"存在索引化的历史上下文"，但不能默认注入具体的历史 fact、artifact 名、坐标、图层 key、引用 ID。模型必须通过工具调用才能获取这些信息

3. **当前 run 隔离**：当前 run 产出的数据不得在同一 run 中作为"历史线程上下文"注入

4. **valueRef 是唯一的数据流**：工具产出的标量值、坐标、bbox、变量名、统计数据、时间索引必须通过 `valueRef` 在运行时黑板中流转。后续工具自己解析引用，遇到未知 ref 必须失败——**禁止模型直接复制原始值**

5. **恢复校验**：run 恢复时必须验证三项：runtime config digest、SDK 版本、state schema 版本。任何一项不匹配必须拒绝恢复，不允许静默降级或 best-effort 恢复

6. **硬失败**：Guardrail 触发、模型错误、工具错误、schema 错误必须表面化为具体的 guardrail 原因或错误消息。**禁止隐藏失败**——不允许 fallback 成功文案、合成 artifact、兼容 hack

### 6.3 审批系统

- 工具可以声明 `isDestructive`、`requiresApproval` 或进入 `approvalInterruptTools` 列表
- 审批触发后，运行进入 `waiting_approval` 状态，SDK RunState 被序列化保存
- 用户批准/拒绝后，运行时重新装配、恢复 SDK 状态、校验 callId 存在于 interruptions 中，然后继续执行
- 审批 payload 中的 `consumed` 标记防止重复处理

### 6.4 计划模式

- 计划模式是硬运行时边界——不仅在 prompt 层面，在 `ToolExecutionCoordinator` 层面强制
- 计划模式期间，只允许只读工具和 `exit_plan_mode`。其他一切工具调用被拒绝并给出明确错误
- 计划模式必须通过 `request_clarification` 或 `exit_plan_mode` 退出，否则 run 失败

### 6.5 确定性旁路

对于不需要 LLM 推理的查询（如气象临近预报），运行时可以走确定性工具链旁路。旁路逻辑在 `deterministicNowcastRunner.ts` 中集中管理：

- 旁路触发条件必须明确可审计：谓词集中实现、测试覆盖，禁止散落在 prompt 或 UI 文案中
- 旁路工具链是确定性序列——不经过 LLM 调用；序列可以由配置和工具契约声明，但不能由模型临时拼装
- 旁路失败时不得回退到 LLM——只能返回明确错误或请求更多信息

---

## 七、气象数据规范

### 7.1 双后端原则

气象数据有两个语义层，使用不同的库：

- **xarray** (netCDF4 / cfgrib / h5netcdf)：科学语义层——变量、维度、时间、层级、单位、缺失值、统计量。xarray 是科学事实源
- **rasterio / GDAL**：栅格地图执行层——CRS、边界、子数据集、重投影、降采样、PNG 渲染。rasterio 是地图事实源

不可混淆：不要用 rasterio 获取变量统计，不要用 xarray 做地图重投影。

### 7.2 工具链约定

工具链中传递引用而非原始值：

| 引用类型 | 包含内容 | 使用场景 |
|---------|---------|---------|
| `variable_ref` | 变量名、维度信息 | 后续工具选择分析变量 |
| `time_index_ref` | 时间维度索引 | 时序分析中选择时次 |
| `level_index_ref` | 层级维度索引 | 垂直剖面分析 |
| `bbox_ref` | 边界框坐标 | 空间裁剪 |
| `threshold_ref` | 阈值定义 | 阈值区域提取 |
| `sequence_ref` | 文件序列信息 | 临近预报分析 |
| `nowcast_analysis_ref` | 临近预报分析结果 | 预报文本生成 |
| `forecast_text_ref` | 预报文本 | 报告生成 |
| `nowcast_map_candidate_ref` | 候选时次 | 栅格渲染 |

### 7.3 科学计算 Worker

- Worker 是无状态的——不保存 session/thread/run/配置
- Worker 只接受 `RUNTIME_ROOT` 内的相对文件路径
- Worker 返回 `outputRelativePath`（相对于 `RUNTIME_ROOT` 的路径），Node.js 端负责注册为 Artifact
- 并发控制通过 `asyncio.Semaphore`（默认 2），超时 300s
- Worker 不调用外部 LLM——它只做确定性科学计算

### 7.4 临近预报

- 临近预报算法在 `gis_meteorology.nowcast` 中，不在 Agent prompt 或 registry glue 中
- 预报文本可以使用大模型辅助表达，但**事实必须是确定性的且经过 schema 验证**
- 缺少产品、边界、位置、模型配置，或模型输出无效时，必须失败或请求澄清，**禁止返回编造的预报**
- DOCX 报告必须消费 `interpretation_ref`（由气象解读工具产出）。元数据模板报告或手工复制的长解读文本必须拒绝

### 7.5 第三方适配器

第三方气象算法通过适配器模式集成：

```
third_party/
  {algorithm_name}/
    adapter.py              # GeoForge 适配器（平台代码）
    source/                  # 适配后的第三方代码
      app.py
      ...
```

规则：
- `adapter.py` 是薄层——将 valueRef 转换为算法调用，不包含算法逻辑
- 适配后的第三方代码在 `source/` 中。原始未修改的快照不在 active package tree 中
- 每个适配器在模块 docstring 中记录：来源 URL、版本、许可证、修改摘要

---

## 八、安全规范

### 8.1 防御层次

安全不是单一机制，而是分层防御：

| 层次 | 机制 | 位置 |
|------|------|------|
| 传输 | HTTPS + WSS（生产环境 Nginx 终止 TLS） | `infra/docker/web/nginx.conf` |
| 认证 | Better Auth (email/password + session, 12h 过期) | `server/src/security/authService.ts` |
| 授权 | Casbin RBAC (workspace 级隔离, deny-by-default) | `server/src/security/authorizationService.ts` |
| CSRF | 自定义 header `x-geoforge-csrf`（HMAC 派生 per-session token） | HTTP + WS 消息级 |
| HTTP 限速 | 认证端点 + API 端点双级限速 | `server/src/security/httpRateLimit.ts` |
| WS 限速 | 按消息类型 per-connection | `server/src/security/rateLimiter.ts` |
| WS 认证 | Origin 检查 + Session 验证（在 HTTP upgrade 阶段完成） | `server/src/ws/security.ts` |
| WS 授权 | 每条命令 Casbin 策略检查 | `authorizeWsMessage` 映射 |
| Worker 认证 | HMAC-SHA256 签名协议（60s TTL + nonce 防重放 + bodyHash 防篡改） | `workerAuth.ts` + `sidecar.py` |
| Worker 沙箱 | 路径遍历防护 + 空字节检测 + 临时目录隔离 | `sidecar.py` |
| CORS | 白名单 origin 精确匹配 | `main.ts` |
| 关闭 | SIGTERM 后全部请求返回 503 | `lifecycle.ts` |

### 8.2 认证与授权

- **deny-by-default**：Casbin 策略效果为 `some(where p.eft == allow)`。未显式授权的操作一律拒绝
- **workspace 隔离**：所有资源操作必须验证 workspace 归属。用户不能跨 workspace 访问线程、运行、图层、数据集
- **角色定义**：`platform_admin`（全局）、`workspace_admin`（工作区管理）、`analyst`（分析操作）、`viewer`（只读）
- **直接工具执行**（`tool:run`）：仅管理员可用，且禁止执行破坏性和审批敏感工具

### 8.3 敏感数据处理

- 日志不得包含：user token、session secret、password hash、用户文件绝对路径
- 用户上传文件存储在 content-addressed 路径（SHA256），不暴露原始文件名在日志中
- Worker 请求体哈希绑定防止中间篡改
- Nonce 缓存使用 `hmac.compare_digest` 防时序攻击

---

## 九、可观测性规范

### 9.1 日志

- 服务端使用结构化日志库（pino 或 winston），不使用裸 `console.log/warn/error`
- 日志必须带可定位上下文：请求级日志带 `traceId`，Agent 路径尽量带 `threadId` 和 `runId`，Worker/数据库/启动路径至少带 `component` 和操作名。不要为了满足字段要求伪造空 ID
- 日志级别：`trace`（SDK 事件细节）、`debug`（工具参数和返回值）、`info`（run 开始/完成/审批）、`warn`（可恢复错误）、`error`（不可恢复错误）
- Agent 数据不得发送到外部 tracing 后端——`setTracingDisabled(true)` 是全局开关且必须保持

### 9.2 追踪

- 每个进入系统的请求（HTTP 或 WS）必须生成唯一的 `traceId`
- `traceId` 必须传播到所有下游调用：Agent 运行时 → 工具执行 → Worker HTTP 请求
- Worker 端接收 `traceId` 并在其日志中使用

### 9.3 指标

服务端必须暴露 `GET /metrics` 端点，至少包含：

| 指标 | 类型 | 维度 |
|------|------|------|
| 请求数 | Counter | HTTP route / WS command type |
| 请求延迟 | Histogram | HTTP route / WS command type |
| 活跃 run 数 | Gauge | status (running / waiting_approval) |
| 工具调用数 | Counter | tool name, status (success / failed) |
| Worker 调用延迟 | Histogram | tool name |
| Worker 调用错误率 | Counter | tool name, error type |

---

## 十、测试规范

### 10.1 文件组织

- 测试文件与源文件同目录，使用 `.test.ts` / `.test.tsx` 后缀（Vitest）或 `test_*.py` 前缀（pytest），或放在领域测试目录中并保持命名可追踪
- 测试文件可使用文件头，但不强制。测试质量由场景覆盖、断言清晰和隔离性决定
- 复杂 Fixture、builder、场景级测试前加简短注释块；简单 happy path 不为凑格式写注释

### 10.2 覆盖率期望

每个模块的最低覆盖要求：

| 模块 | 要求 |
|------|------|
| `server/src/agent/` | 每个 public 方法至少一个测试 |
| `server/src/tools/*/` | 每个工具一个契约测试（合法参数→成功；非法参数→清晰错误） |
| `server/src/ws/` | 每个命令类型一个 happy path 测试 + 一个 auth 失败测试 |
| `server/src/routes/` | 每个端点一个 HTTP 状态码测试 |
| `packages/gis-meteorology/` | 每个 public 函数一个 pytest |
| `apps/worker/` | 认证失败、路径遍历拒绝、超时处理各一个测试 |
| `apps/web/src/` | 每个数据模型/状态 Hook 一个测试；关键 UI 组件一个渲染测试 |
| E2E (`tests/e2e/`) | workspace bootstrap、run start→stream→complete、approval flow、mode switching |

### 10.3 架构守卫测试

`server/src/architecture.test.ts` 是自动化架构约束。当本文件新增禁止模式时，同步更新 `architecture.test.ts`：

- 禁止的 import 模式（跨层反向依赖）
- 禁止的代码模式（`as any`、`finalResponse`、`subscribe_messages` 等已废弃的 API）
- Transcript entry kind 的白名单验证
- 文件型 conversation store 的可重放性验证
- 禁止 `PostgresPlatformStore` 重新拥有所有资源写路径或直接维护 session/thread/run Map
- 禁止 `server/src/ws/handler.ts` 出现新增大型 command switch；WS 命令必须通过 registry 注册
- 禁止普通 Store CRUD 使用裸 `db.execute(sql...)`，除非文件位于 PostGIS/DDL/health 明确例外列表
- 禁止生产源码新增模块级可变 singleton
- 禁止前端组件直接 `new WebSocket()` 或绕过统一 transport
- 禁止 Python Worker route 中出现 `if tool_name == ...` 分发链

### 10.4 测试隔离

- 单元测试不依赖数据库或网络——使用 mock/stub
- DB 集成测试使用独立的测试数据库或事务回滚
- Python 测试通过 `monkeypatch` 覆盖 `RUNTIME_ROOT`，使用小规模内联 fixture（2×2 NetCDF）
- 重量级依赖通过 `pytest.importorskip` 做优雅降级

---

## 十一、工具系统规范

### 11.1 ToolProvider 契约

每个工具以 `ToolProvider` 模块的形式进入平台：

- `ToolManifest`：声明 id、name、version、author、language、requires（环境变量依赖）、tools 列表
- `tools()`：返回 `ToolDef[]`——每个 ToolDef 含 name、label、description、parameters（Zod schema）、handler、isReadOnly、isDestructive、tags
- `onInstall(ctx)` / `onUninstall(ctx)`：可选的安装/卸载钩子

跨语言工具必须同时声明 `ToolContractManifest`：

- `providerId`、`toolName`、`version`
- `parametersSchema`、`resultSchema`：JSON Schema 是 TS/Python 之间的中间事实源
- `valueRefInputs`、`valueRefOutputs`
- `readOnly`、`destructive`、`requiresApproval`
- `timeoutSeconds`
- `displaySurfaces`

TypeScript ToolProvider、OpenAI tool schema、Python Worker catalog、Pydantic request/response model 必须由同一契约生成或启动时校验一致。禁止用注释字符串、人肉表格或松散命名约定维持跨语言同步。

### 11.2 加载机制

- **显式 allowlist**：只有 `ENABLED_TOOL_PROVIDERS` 环境变量中列出的 Provider ID 进入运行时。安装到仓库 ≠ 启用
- 依赖缺失的 Provider 自动标记为不可用，在 DebugPage 显示原因——不静默跳过
- Provider ID 必须全局唯一——重复注册抛错误

### 11.3 设计约束

- **薄适配器**：工具 handler 是对领域服务的薄包装。业务算法属于 `packages/gis-meteorology/` 或领域包，不属于 registry glue
- **硬失败**：未知 valueRef、无效参数、缺失依赖、Worker 错误必须直接失败——不允许 fallback 成功文案
- **Artifact 展示面**：工具必须通过 `displaySurfaces` 显式声明 artifact 展示面（`map`、`mini_app`、`download`）。前端不得通过类型名或 artifact 名猜测展示意图
- **参数校验**：每个工具定义在执行前通过 `validate_tool_definition()` 校验。参数经过 Zod schema 验证后传入 handler
- **契约漂移检测**：Node 启动时拉取 Worker `/tools/catalog`，校验工具名、schema hash、timeout、valueRef、只读/破坏性声明。漂移直接失败，不降级为不可用假状态
- **统一错误模型**：工具失败返回稳定分类，如 `invalid_request`、`dependency_missing`、`worker_failed`、`timeout`、`schema_mismatch`。前端展示中文原因，日志记录 traceId 和脱敏上下文

### 11.4 工具 Schema 双模式

`framework/schema.ts` 为每个工具生成两套 Zod schema：

- **Runtime mode**：optional 字段保持 optional——校验工具 handler 契约
- **Agents SDK mode**：optional 字段变为 nullable+optional——满足 OpenAI strict schema 要求（每个属性都必须存在）

Null 值在调用 handler 前自动剥离。

### 11.4.1 Worker 工具注册表

Python Worker 使用 registry dispatch：

- `/tools/catalog` 返回真实注册工具、schema hash、版本、timeout 和 valueRef 声明
- `/tools/{tool_name}` 只做认证、body limit、Pydantic 校验、registry dispatch
- 禁止在路由中写 `if tool_name == ...` 链
- 每个工具一个模块、一个 request model、一个 response model、一组成功/失败测试

### 11.4.2 SDK Skill 目录

OpenAI Agents SDK Skill 是可选扩展能力，不能和 GeoForge 内置工具混成一个事实源。

- Skill 目录的入口文件名必须严格为 `SKILL.md`。`skill.md`、`sKilL.md`、`Skill.md` 都是配置错误，系统必须返回明确中文错误，不得隐式兼容为合法 Skill，也不得继续执行后抛底层异常。
- Skill 目录只能通过运行时配置显式启用。安装到本机目录不等于进入 GeoForge run。
- GeoForge 只负责验证目录、读取 `SKILL.md` 以及可选的 `scripts/`、`references/`、`assets/`，再交给 SDK 的 `skills()` capability。不要把宿主绝对路径、用户主目录或产品旧名写进 prompt、manifest 或日志。
- Skill 是运行时上下文扩展，不是权限绕过入口。Skill 中的脚本和引用文件只进入 sandbox workspace，仍受工具权限、文件沙箱和审批边界约束。

### 11.5 Provider ID 生命周期

当需要重命名 Provider ID 时：

1. 新版本中，旧 ID 被显式拒绝，错误消息包含新 ID 和迁移步骤
2. 一个发布周期后，移除旧 ID 的拒绝代码
3. 旧 ID 在代码中作为**纯字符串**出现，附废弃注释。禁止字符串拼接混淆（如 `['old', 'id'].join('')`）——注释解释废弃原因，代码不应对抗 grep

### 11.6 ValueRef 流

- 工具通过 `result.valueRefs` 产出 `ToolValueRef[]`
- valueRef 包含 `refId`、`label`、`type`、`uri`、`metadata`
- 运行时黑板在 run 状态中维护 valueRef 索引
- 同一 thread 的历史 run 的 valueRef 对后续 run 可见
- 工具解析 valueRef 时遇到未知 refId 必须失败——禁止猜测或跳过

---

## 十二、记忆系统规范

### 12.1 设计原则

- 本文件（`AGENTS.md`）是仓库的指令入口，但 GeoForge 运行时**必须**保持指令加载关闭（`instructionMemoryEnabled` 默认 false）。本文件供开发 Agent 和仓库维护者使用——不是隐藏的产品 prompt 注入
- `MEMORY.md` 只是长期记忆的**索引**——包含短链接/钩子，绝不包含完整记忆正文
- 完整记忆正文存储在独立的 Markdown 话题文件中，使用 Zod 校验的 frontmatter

### 12.2 记忆文件格式

```markdown
---
name: <short-kebab-case-slug>
description: <one-line summary>
type: user | feedback | project | reference
paths: ["optional", "file", "paths"]
---

<记忆正文>

**Why:** <原因>
**How to apply:** <应用方式>
```

- `type` 严格限制为 `user`、`feedback`、`project`、`reference` 四种
- 私有记忆属于用户私有记忆目录。团队记忆属于项目共享记忆目录。敏感个人数据不得写入团队记忆

### 12.3 不应存储的内容

不保存可以通过当前仓库、运行时 store、图层目录或配置推导出的信息：

- 代码结构、文件路径、Git 历史
- 临时任务状态、工具结果日志、Artifact 名称
- 可重建的查询索引

### 12.4 记忆提取

- 自动记忆提取必须在受限的 fork 中运行——只能读/搜/写/删记忆，不能编辑业务源文件或调用 GIS、气象、导出、导入等副作用工具
- 历史 run 日志、event 日志、transcript 文件**不得被运行时扫描并静默注入 prompt**
- 记忆可能过期——如果记忆引用了文件、函数、标志、配置、图层或数据产品，先验证当前状态再使用

---

## 十三、依赖与 Vendor 管理规范

### 13.1 npm 依赖

- 生产依赖只安装实际使用的包。`node_modules` 膨胀直接影响 CI 时间和安全攻击面
- 依赖锁定文件（`package-lock.json`）必须提交。不允许未锁定的版本范围
- 升级涉及安全修复的依赖优先于功能升级
- 不使用 `patch-package` 或类似工具静默修改 npm 包——如需定制，fork 并维护独立的包引用

### 13.2 Python 依赖

- 生产依赖在 `pyproject.toml` 中以精确版本下限声明
- 科学计算库（numpy、xarray、rasterio）的版本升级需要完整的气象工具链回归测试
- Worker 不安装未使用的依赖——它只运行科学计算，不需要 Web 框架之外的能力

### 13.3 Vendored 代码

`vendor/` 目录存放 vendored（源码复制）的第三方代码。

**每个 vendored 包必须包含 `README.md`**，记录：

- 上游来源 URL 和精确版本（git tag 或 commit hash）
- 许可证及合规评估
- Vendoring 原因（为什么不用 npm/pip 依赖）
- 所做的修改（diff 摘要，不是逐行 diff）
- 与上游的同步流程（如何拉取新版本并重新应用修改）

**修改 vendored 代码的原则**：

- 优先使用适配器/包装模式——保持 vendored 源码整洁
- 必须修改时，在代码中用明确的注释标记（`// GEOfORGE-VENDOR-CHANGE: <原因>`）
- 不接受仅为了"风格统一"而做的格式化修改——这会使上游同步变得困难

### 13.4 第三方科学计算代码

`packages/gis-meteorology/third_party/` 中的第三方气象算法：

- `adapter.py` 是平台代码（GeoForge 原创）——将 valueRef 转换为算法调用
- `source/` 包含适配后的第三方代码
- 原始未修改的快照**不在 active package tree 中**——归档到独立参考仓库
- 每个适配器在模块 docstring 中记录：来源、版本、许可证、所做修改的摘要
- 适配器中的安全扫描（`allow_pickle=True` 等）由 `code_scan.py` 自动执行
