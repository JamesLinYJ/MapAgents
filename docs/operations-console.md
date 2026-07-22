# GeoForge 本地运维台

GeoForge 的服务器本机运维入口由 TypeScript 监督后台和 Ink 中文 TUI 组成。它只面向能够登录主机并读取受 ACL 保护密钥的人工运维人员，不提供远程 Shell、网页终端、Agent Tool 或 Automation 动作。

## 使用方式

Windows：

```powershell
.\dev.ps1                     # 启动全部服务并进入 TUI
.\dev.ps1 console             # 只连接 TUI，不改变服务状态
.\dev.ps1 start api           # 无交互启动 API 及缺失依赖
.\dev.ps1 stop worker         # 反向停止仍依赖 Worker 的服务
.\dev.ps1 restart infra       # 按依赖顺序重启原先运行的服务
.\dev.ps1 status -Json
.\dev.ps1 logs api -Tail 200 -FollowLogs
.\dev.ps1 shutdown            # 停止全部并关闭监督器
```

Linux：

```bash
./dev.sh
./dev.sh console
./dev.sh start api
./dev.sh status --json
./dev.sh logs api --tail 200 --follow
./dev.sh shutdown
```

在 TUI 中，`q` 和 Ctrl+C 只分离，后台服务继续运行。大写 `Q` 会进入“停止全部并退出”确认，必须完整输入“停止全部”。

开发环境的监督目录使用单进程 `tsx` 入口，由监督状态机统一负责退出、重启和日志；直接运行
`npm run dev --workspace server` 时仍保留文件监听，适合不经过监督器的局部开发。

## 事实源与边界

- `@geo-agent-platform/operations-supervisor` 保存四个固定服务的实时状态：`infra`、`worker`、`api`、`web`。
- `concurrently` 只启动命令并提供输出与进程终止能力；依赖、健康、重启、指标、日志与 IPC 都由 GeoForge 监督器负责。
- 客户端通过 Windows named pipe 或 Linux Unix socket 使用令牌认证的 JSONL 协议。首帧校验协议版本与令牌，单帧最大 64 KiB。
- 写操作携带 `operationId` 并在监督器内串行执行。连接中断后可查询结果，客户端不会自动重放写请求。
- CPU 与内存汇总启动进程的完整后代树；基础设施指标来自固定 Compose 项目中的真实容器。无法采集时显示“未知”和原因。
- 日志在进入内存缓冲、IPC 和结构化监督日志前统一脱敏；每个服务最多保留 10,000 行、8 MiB。

## 本机账户最高权限

账户页面不要求先知道现有平台管理员密码。授权根是 `GEOFORGE_LOCAL_ROOT_SECRET_FILE` 指向的本机密钥：

- 开发环境首次使用时生成，并在 Windows 上关闭 ACL 继承、仅授予当前用户；Linux 权限固定为 `0600`。
- 生产环境不自动生成，缺失或权限过宽时硬失败。
- 密钥派生不可公开登录、没有平台投影的 Better Auth Console 服务主体。每次账户写操作建立独立短期会话，调用官方 Admin API，完成后立即登出。
- 密钥轮换会派生新主体；旧主体通过官方 Admin API 清理。
- Console 主体不能通过公共认证路由登录、不会出现在普通账户列表，也不能成为账户操作目标。
- GeoForge `platform_admin` 关系继续由事务化 RBAC 仓储维护，并保留最后一个可用管理员保护与失败补偿。

数据库不可用时，账户和审计页会显示真实故障；服务、日志和主机指标仍然可用，可用于恢复基础设施。

## 生产部署

生产构建必须先执行：

```text
npm ci
npm run build
```

Linux 使用 [deploy/systemd/geoforge-supervisor.service](../deploy/systemd/geoforge-supervisor.service)，替换 `@@GEOFORGE_ROOT@@` 后安装为 `geoforge-supervisor.service`。服务使用 `KillMode=control-group`，并由 `geoforge-ops` 组控制本机密钥访问。

Windows 使用固定版本并校验 SHA256 的 WinSW。复制 [deploy/env/supervisor.env.example](../deploy/env/supervisor.env.example)，完成生产值与 ACL 后运行：

```powershell
.\scripts\prepare-winsw-services.ps1 -SupervisorEnvironmentFile C:\ProgramData\GeoForge\supervisor.env
.\scripts\install-winsw-service.ps1 -Service Supervisor -CredentialPrompt
```

WinSW 服务名为 `GeoForgeSupervisor`。生产服务账户不得使用 LocalSystem、LocalService 或 NetworkService。
