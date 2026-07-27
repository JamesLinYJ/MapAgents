# geo-agent-platform

中文优先的 GIS Agent 平台。Node/TypeScript Server 承载 Agent 运行时、WebSocket 控制面和 HTTP 数据面；Python Worker 只承载 `gis_meteorology` 科学计算；React + MapLibre 提供工作台。

## 架构

- `apps/server/`：Hono HTTP 数据面、`/ws` WebSocket 控制面、Agent runtime、ToolProvider 注册与 PostgreSQL 会话事实
- `apps/web/`：React 工作台；业务控制和实时状态统一走 `/ws`
- `apps/worker/`：无状态 Python 科学计算 Worker，不保存 session/thread/run
- `PostgreSQL/PostGIS`：用户、权限、Session、Thread、Run、Transcript、Workflow、Artifact 元数据、运行配置、工具目录与空间数据的结构化事实源
- `runtime/objects/sha256/`：上传内容、Artifact 二进制、SDK checkpoint 和 Markdown 记忆正文等大载荷的内容寻址存储；数据库保存引用与生命周期
- `runtime/conversations/`：只保存附件审计和 Agent 诊断载荷，不保存 Session、Run 或 Transcript 的第二份结构化事实
- `runtime/uploads/files/`：通用线程文件的本地索引，文件正文统一引用内容寻址对象

HTTP 只保留 `/health`、文件/图层上传替换、artifact 元数据/GeoJSON/下载和底图资源。会话、线程、运行、工具、配置、文件目录和图层目录命令统一使用 `/ws`。

## 气象工具

气象分析从通用线程文件开始，后续工具只消费当前 run 中的 `valueRef`。Worker 只接受共享 `RUNTIME_ROOT` 内的相对文件引用，拒绝绝对路径和越界路径。

完整工具链覆盖数据检查、模型解读、栅格渲染、统计、阈值区域、等值线、DOCX 报告，以及短时临近预报序列检查、降水分析、问题回答、预报文本和栅格渲染。

## 本地开发

### Windows 一键启动

首次运行先复制 `.env.example` 为 `.env` 并执行 `npm install`。之后双击 `start-dev.cmd`，脚本会自动启动 Docker Desktop、PostGIS、气象计算 Worker、Node API/WebSocket 和 Vite Web，并在全部健康后打开浏览器。

```powershell
.\dev.ps1 start -OpenBrowser
.\dev.ps1 restart -Service api
.\dev.ps1 status
.\dev.ps1 logs -Service api -Tail 100
.\dev.ps1 agent
.\dev.ps1 agent -AgentPrompt "杭州明天会下雨吗？"
.\dev.ps1 agent -Check
.\dev.ps1 restart
.\dev.ps1 stop
```

也可以使用 `npm run dev:windows`、`npm run dev:windows:status` 和 `npm run dev:windows:stop`。双击 `stop-dev.cmd` 可完整停止开发环境。Windows TUI 只通过 Docker 启停 PostGIS，Worker、API 和 Web 都是宿主机后台进程，日志位于 `runtime/logs/`。

`agent` 会打开无需输入平台账号密码的本机 Agent 终端。它使用操作系统 ACL 保护的本机根密钥建立短期、仅 loopback 可用的保留服务主体，并复用主 API 的 Agent Runner、工作流、审批和会话事实源。使用说明见 [GeoForge 本机 Agent CLI](docs/operations/local-agent-cli.md)。

### Bash / macOS / Linux

```bash
cp .env.example .env
npm install
./dev.sh
./dev.sh agent
./dev.sh agent --prompt "杭州明天会下雨吗？"
```

所有环境仅使用 Docker 运行 PostGIS；Python Worker、Node Server 与 Web 均直接运行在宿主机或宿主机进程管理器中。本地开发 PostGIS 默认映射到宿主机 `55432`，避免与已安装的本地 PostgreSQL 冲突。`./dev.sh` 会按 PostGIS → Python Worker → Node Server → Web 的顺序启动它们。也可以分别运行：

```bash
make docker-up
make dev-worker
make dev-server
make dev-web
```

主要配置为 `API_HOST`、`API_PORT`、`WORKER_URL`、`DATABASE_URL`、`RUNTIME_ROOT`、`ENABLED_TOOL_PROVIDERS` 和 `DEVELOPER_TOOL_ALLOWED_ROOTS`。安装到仓库的 Provider 不会自动启用。`geo-platform-developer-tools` 只用于维护 GeoForge GIS/气象 Agent，必须显式配置允许访问的绝对根目录；缺失时 Provider 会在 DebugPage 显示不可用原因。

开发数据结构变更后使用 `npm run reset:conversations` 显式清空旧会话、上传、artifact 与对象文件。该命令保留 PostGIS 图层、工具目录和运行配置，不做旧 payload 兼容回填。

## 验证

```bash
npm run build
npm test
npm run lint:web
npm run test:e2e
pytest -q
```

`infra/compose/docker-compose.prod.yml` 也只编排 PostGIS。生产环境应在宿主机进程管理器中启动 Worker、Node Server 与 Web，并让 Web 入口同时代理 `/api/*` 和带 Upgrade 头的 `/ws`。
