# Newmap 全系统安全审查报告

日期：2026-07-01  
范围：`C:\Projects\Newmap` 单代理全仓代码审查、运行时接口抽样验证、依赖审计、部署配置审查。  
说明：已使用 Codex Security / code-audit / security-best-practices skills。由于本轮没有明确授权 subagents，本报告不是多代理穷尽式扫描；它是单代理全仓安全审查，结论以可验证代码证据和有限动态验证为准。

## 结论摘要

当前最需要优先修的是服务端控制面边界：WebSocket `/ws` 没有身份认证、没有 Origin 校验，却暴露了运行、工具执行、运行时配置、Speech 授权、文件、图层、记忆和线程管理等高权限命令。更严重的是 `tool:run` 直接调用工具注册表，绕过了 Agent SDK 工具审批边界。对象级授权也没有建立，`threadId`、`artifactId`、`datasetId`、`layerKey` 基本是裸资源选择器。

这些问题不是前端隐藏按钮或 UI 判断能修的，必须在服务端建立统一认证、会话主体、资源归属校验、命令授权和工具审批执行边界。

## Findings

### Critical 1. 未鉴权且未校验 Origin 的 WebSocket 控制面暴露系统高权限能力

证据：
- `server/src/main.ts:67-68` 全局启用默认 `cors()`，没有配置可信 origin。
- `server/src/ws/handler.ts:59-61` 直接创建 `new WebSocketServer({ server, path: '/ws' })` 并接受连接，没有 auth、cookie/session、Origin 校验或 CSRF 风格握手。
- `server/src/ws/protocol.ts:13-33` 允许 `run:start`、`tool:run`、`runtime-config:update`、`speech:authorization`、`memory:write/delete`、`file:delete`、`layer:update/delete`、`thread:delete/purge` 等命令。
- 动态验证：用伪造 `Origin: https://evil.example` 连接 `ws://127.0.0.1:8000/ws` 后，`system:get` 成功返回 provider 状态和本地 `conversationStoreRoot`；`tool:list` 成功返回 45 个工具，包含 `write_file`、`edit_file`、`meteorological_report`、`text_to_speech`。

影响：
- 任意能访问 API 端口的网页或客户端都可以读运行时状态、获取短期 Speech 授权、启动模型运行、枚举工具、删除文件/图层、修改运行时配置。
- 如果用户浏览恶意网页且本地服务运行，浏览器 WebSocket 可被跨站驱动；因为服务端不校验 Origin，前端同源策略不能替服务端兜底。

根因修复：
- 建立统一服务端认证层，同时覆盖 HTTP 和 WS。WS 握手阶段必须验证登录态/会话 token，并校验可信 Origin。
- 为每个 WS 命令定义服务端权限策略，不要把协议枚举等同于授权。
- `speech:authorization`、`runtime-config:update`、`tool-catalog:*`、`memory:*`、`file:delete`、`layer:update/delete` 等命令默认要求已认证主体和明确权限。
- 开发调试模式可以保留免登录，但必须绑定 loopback、显式 `DEV_AUTH_DISABLED=true`，并在生产构建中默认关闭。

### Critical 2. `tool:run` 绕过 Agent 工具审批边界，可直接执行破坏性工具

证据：
- Agent 路径有审批判断：`server/src/agent/agentsToolBridge.ts:44-50` 的 `needsApproval` 会根据 `requiresApproval`、`isDestructive` 和审批工具集合决定是否需要审批。
- `server/src/tools/developer/writeFile/definition.ts:15-24` 标记 `write_file` 为 `isDestructive: true`、`requiresApproval: true`。
- `server/src/tools/developer/editFile/definition.ts:15-24` 标记 `edit_file` 为 `isDestructive: true`、`requiresApproval: true`。
- 但 WS 路径 `server/src/ws/handler.ts:383-384` 对 `tool:run` 直接进入 `executeTool`，`server/src/ws/handler.ts:493-504` 调用 `registry.execute(toolName, args, context)`，没有检查 `requiresApproval`、`isDestructive` 或已批准 decision。

影响：
- 只要能访问 WS，就可以绕过计划/审批 UI 与 Agent SDK 审批机制，直接调用已启用工具。
- 当前动态枚举确认 `write_file`、`edit_file` 已暴露，风险包括宿主允许根目录内的源码/运行时文件被写入、编辑或破坏。

根因修复：
- 将审批 enforcement 下沉到服务端工具执行入口，而不是只放在 Agent SDK bridge。
- `ToolRegistry.execute` 或一个统一 `ToolExecutionPolicy` 必须接收 caller、channel、runId、decisionId，并拒绝未审批的 destructive / approval-required 工具。
- `tool:run` 只能执行只读工具，或要求一个服务端签发、一次性、绑定工具名与参数摘要的批准令牌。
- DebugPage 的直接工具运行能力应作为受限开发权限，不应复用生产 WS 控制面。

### High 3. 缺少对象级授权，资源 ID 成为裸访问令牌

证据：
- 没有全局认证中间件：`server/src/main.ts:67-74` 直接挂载文件、图层、artifact、地图和气象路由。
- 默认会话固定：`server/src/store/platformStore.ts:37-39` 使用 `__default__`，`server/src/store/platformStore.ts:103-113` 会自动创建默认 session。
- 线程读取只按 ID：`server/src/ws/handler.ts:121-147` 可 list/get/history 任意传入的 session/thread。
- Artifact 下载只按 `artifactId`：`server/src/routes/artifacts.ts:20-29` 返回 metadata，`server/src/routes/artifacts.ts:32-47` 返回文件内容，没有 session/run ownership 检查。
- 气象数据列表在无过滤时返回全部：`server/src/routes/meteorology.ts:98-102` 接收可选 session/thread，`server/src/routes/meteorology.ts:229-235` 无过滤直接列出最近数据集。
- 气象报告只按 `datasetId`：`server/src/routes/meteorology.ts:150-169` 对任意 dataset 创建 report job。
- 图层操作只按 `layerKey`：`server/src/ws/handler.ts:432-440` 更新/删除图层；`server/src/gis/postgis.ts:181-215` 更新 metadata 或删除 metadata 并 `DROP TABLE`。

影响：
- 不同用户或不同会话之间无法隔离；知道或猜到资源 ID 即可读、删、替换或生成任务。
- 默认 session 会把多人/多浏览器使用压到同一命名空间，扩大误删和越权影响面。

根因修复：
- 引入 Principal / Account / Session 关系：每个 session、thread、artifact、dataset、layer 都必须绑定 owner 或 tenant。
- Store 和 repository 方法签名应接收 `principalId` 或 `authorizationScope`，在 SQL / 内存索引层完成归属过滤。
- Artifact、dataset、layer 的下载、替换、删除、报告任务都必须校验资源属于当前主体或显式 share token。
- 默认 session 只能用于本地单用户开发；生产应按用户创建 session。

### High 4. 上传和科学计算入口缺少体积、复杂度、并发与 Worker 访问控制

证据：
- 通用上传：`server/src/routes/files.ts:19-25` 直接 `formData()` 并保存。
- 文件落盘：`server/src/store/fileStore.ts:73-83` 使用 `file.arrayBuffer()` 一次性读入内存。
- 气象上传：`server/src/routes/meteorology.ts:105-118` 只校验扩展名后保存。
- 图层导入：`server/src/routes/layers.ts:50-64` 使用 `formData()`、`file.text()`、`JSON.parse(...)`，没有文件大小、Feature 数、坐标深度或属性数量上限。
- nginx 只有请求速率限制：`infra/docker/web/nginx.conf:24-30`，没有 `client_max_body_size`。
- Python worker：`apps/worker/src/worker_app/sidecar.py:44-54` 暴露 `/tools/{tool_name}`，没有鉴权；`package.json:18` 的开发脚本以 `--host 0.0.0.0` 启动 worker。

影响：
- 大 NetCDF/GRIB/GeoJSON 或畸形 GeoJSON 可造成 API 内存、CPU、PostGIS 或 worker 长时间占用。
- 如果 worker 端口暴露到局域网或容器网络外部，攻击者可绕过 Node API 直接触发重计算。

根因修复：
- nginx/API 双层限制：`client_max_body_size`、Hono body limit、每路由 max bytes、文件数量限制。
- 上传采用流式写入和先验大小检查，避免 `arrayBuffer()` / `file.text()` 对大文件全量进内存。
- GeoJSON 导入加入 Feature 数、坐标点数、属性字段数、嵌套深度、bbox 范围和 SRID 校验。
- Worker 绑定内网地址，增加 API-to-worker 的共享密钥或 mTLS，限制每工具并发、超时和队列长度。

### Medium 5. 运行时元数据、绝对路径和内部错误对未授权客户端可见

证据：
- `server/src/ws/handler.ts:406-415` 的 `system:get` 返回 `conversationStoreRoot`、provider descriptors、tool provider 状态和 PostGIS 错误。
- `apps/worker/src/worker_app/sidecar.py:466-478` 的 `/health` 返回 `runtimeRoot` 绝对路径。
- WS 错误通过 `formatError(error)` 直接返回：`server/src/ws/handler.ts:77-80`。

影响：
- 泄露本地路径、provider 配置状态、工具面和服务错误，降低后续攻击成本。
- 与未鉴权 WS 组合后，攻击者可以快速枚举系统能力和部署结构。

根因修复：
- 健康检查只返回稳定状态码和粗粒度状态；绝对路径、provider 细节和内部异常仅写入服务端日志。
- Debug-only diagnostics 需要认证和管理员权限。
- 面向客户端错误使用固定错误码、requestId 和脱敏 message。

### Medium 6. 依赖审计存在 9 个漏洞，包含 4 个 high

证据：
- 执行 `npm audit --workspaces --json --registry=https://registry.npmjs.org`，结果：critical 0、high 4、moderate 3、low 2。
- 直接依赖位置：
  - `server/package.json:19` `hono: ^4.7.0`
  - `apps/web/package.json:22` `react-router-dom: ^7.14.0`
  - `apps/web/package.json:40` `vite: ^8.0.4`
  - `server/package.json:20` 和 `apps/web/package.json:18` `microsoft-cognitiveservices-speech-sdk: ^1.50.0`
- 审计摘要中的 high 包括 Hono CORS 相关漏洞、React Router 反序列化/RCE/DoS 类风险、Vite Windows dev server 文件访问风险。

影响：
- 依赖问题与本仓现有 CORS/WS/开发服务暴露问题会叠加，尤其是 Hono CORS 与 Vite Windows dev server 类漏洞。

根因修复：
- 优先升级 `hono`、`react-router-dom/react-router`、`vite` 到修复版本，并重新生成 lockfile。
- 对 Azure Speech SDK 的 `uuid` 审计项需要确认微软 SDK 是否已有安全版本；不要按 npm audit 建议盲目降级到旧 SDK。
- CI 增加官方 registry 的 audit job；当前默认 npmmirror 不支持 audit API，会导致审计失效。

### Medium 7. 生产 nginx 语音权限与 CSP 策略不匹配

证据：
- `infra/docker/web/nginx.conf:20` 设置 `Permissions-Policy "camera=(), microphone=(), geolocation=()"`，会禁用当前计划接入的麦克风语音输入。
- `infra/docker/web/nginx.conf:21` 的 `connect-src 'self' https: ws: wss:` 过宽，没有按实际 Azure Speech / API / WS 域名收敛。

影响：
- 生产环境语音输入会被浏览器策略阻断。
- 连接策略过宽，降低 CSP 对外连行为的约束能力。

根因修复：
- 若启用语音，改为 `microphone=(self)`；继续禁用 camera/geolocation。
- `connect-src` 显式列出 API、WS、Azure Speech 需要的 endpoint，不使用泛化 `https:` / `wss:`。

### Low 8. 第三方原始快照中保留浏览器 API key 输入和 localStorage 持久化模式

证据：
- `packages/gis-meteorology/src/gis_meteorology/third_party/short_term_forecast/source/templates/index.html` 包含 API key 输入和 localStorage 保存逻辑。
- `packages/gis-meteorology/src/gis_meteorology/third_party/short_term_forecast/source/app.py` 接收 `api_key` 并转发给 DeepSeek。

影响：
- 当前看起来是 third_party 原始源码快照，不是主产品路由；直接风险较低。
- 但如果后续被误启动、打包或复用，会违背“前端不暴露长期 key”的安全边界。

根因修复：
- 明确将该目录标记为非运行时参考代码，排除生产包和工具加载。
- 如果要复用，删除浏览器 key 输入/localStorage 模式，改成服务端凭据或短期授权。

### Low 9. 本地开发 PostGIS 使用固定弱口令并对宿主端口发布

证据：
- `infra/compose/docker-compose.dev.yml:16-21` 使用 `POSTGRES_USER=geo_agent`、`POSTGRES_PASSWORD=geo_agent`，并发布 `${POSTGIS_PORT:-55432}:5432`。

影响：
- 本地开发机如果处在不可信网络，PostGIS 可能被局域网访问。

根因修复：
- dev compose 默认绑定 `127.0.0.1:55432:5432`。
- 通过 `.env` 生成随机开发密码，文档中明确不要暴露到公网或共享网络。

## 已观察到的正向控制

- 产物文件读取使用 `resolveRuntimePath` 限制在 runtime 根目录内：`server/src/routes/artifacts.ts:60-64`。
- 气象 worker 的路径参数在业务层有相对路径和 runtime 根目录限制。
- 前端没有发现主要产品代码中直接使用 `dangerouslySetInnerHTML` 的 XSS 高危模式。
- 模型/工具 schema 已大量使用 Zod 或显式校验，这是继续建设服务端授权策略的良好基础。

## 建议修复顺序

1. 立即给 HTTP + WS 加统一认证、可信 Origin 校验和命令级授权。
2. 立即修 `tool:run` 审批绕过，把 destructive/approval-required 工具拦在统一服务端执行策略中。
3. 建立对象级授权：session/thread/artifact/dataset/layer 绑定主体，所有读写删都校验归属。
4. 加上传大小、复杂度、worker 鉴权、并发和超时限制。
5. 升级高危依赖，并修正 npm audit 使用官方 registry 的 CI 检查。
6. 调整 nginx Permissions-Policy / CSP，使语音功能可用且外连范围最小化。
7. 清理 third_party 中可能误用的浏览器 key 模式，收紧 dev compose 网络暴露。

## 验证记录

- 已运行 Codex Security preflight；因未授权 subagents，标记为单代理审查。
- 已运行 secret 模式扫描；未发现长期云服务 key 被 git 跟踪。注意：本地 `.env` 被 `.gitignore` 忽略，不应提交。
- 已运行动态 WS 验证，确认伪造 Origin 可以调用 `system:get` 和 `tool:list`。
- 已运行 `npm audit --workspaces --json --registry=https://registry.npmjs.org`，确认 9 个依赖漏洞。
