# GeoForge 运维后台部署与值守手册

## 边界

`/operations/` 是单主机运维控制面，只接受 `platform_admin`。Ops Gateway、Terminal Broker 和 Process Compose 是三个独立常驻进程；主 API、Web 或 Worker 重启不会中断运维页面。终端只供人工管理员使用，不注册为 Agent Tool，也不进入 Automation Flow。

固定服务 ID 只有 `web`、`api`、`worker`、`infra`。`infra` 独占 PostGIS、Martin 和 TiTiler 的 Docker Compose 生命周期；Gateway 与 Broker 不属于页面可停服务。

四份 Process Compose 配置都通过显式 `shutdown.command` 调用对应的 `stop-infra` 脚本。不能只向日志跟随进程发送信号，否则 Windows 上可能出现监督器显示已停止、Docker 容器仍在运行的双重事实。

## 构建与数据库

1. 在项目根目录执行 `npm ci` 和 `npm run build`。共享协议包会先生成正式 ESM 与声明文件，生产进程不直接执行 TypeScript 源码。
2. 在目标数据库执行 `infra/migrations/003_operations_terminal.sql`。迁移只新增终端会话、密文分块和一次性访问授权表。
3. 运行固定版本安装器：Windows 使用 `scripts/install-process-compose.ps1` 与 `scripts/install-winsw.ps1`；Linux 使用 `scripts/install-process-compose.sh`。安装器按 `vendor/operations/checksums.json` 校验官方发布包 SHA256，版本不匹配即失败。

## 密钥与文件权限

- Process Compose 令牌、Gateway 环境、Broker 环境和 keyring 必须位于部署配置指定的位置，不能依赖源码中的机器路径。
- Gateway 环境包含数据库、Better Auth、恢复窗口、Broker HMAC、Process Compose 和 keyring 配置，但不得包含模型 API Key。
- Broker 环境只能包含 `deploy/env/terminal-broker.env.example` 列出的变量。运行入口会再次删除数据库、会话、模型和令牌变量。
- keyring 格式为 `{"version":1,"keys":[{"id":"2026-01","status":"active","keyBase64":"<32-byte-base64>"}]}`。Linux 权限必须为 `0600`；Windows 仅授予 Gateway 服务账户和本机管理员读取。
- Broker spool 仅授予 Broker 写入、Gateway 读取和删除。Broker 服务账户不得加入 Administrators 或 Docker 组，不得获得服务控制 ACL。

轮换主密钥时，先把新 key 加入 keyring 并标记 `active`，旧 key 改为 `retired`，再将 `OPS_ACTIVE_KEY_ID` 切到新 id 并重启 Gateway。启动时会认证解包并重包装尚在保留期内的会话数据密钥；确认完成前不能删除旧 key。

## Windows / WinSW 2.12

1. 将三个示例环境分别复制到受 ACL 保护的位置并替换占位值。三个服务使用三个不同本地账户。
2. 运行 `scripts/prepare-winsw-services.ps1`，按需传入 `-ServiceRoot` 和三个环境文件路径。脚本会为每个服务生成同名、同目录的 `GeoForge*.exe` 与 `GeoForge*.xml`；这是 WinSW v2 的加载约定。
3. 在提升权限的终端中分别运行：

   ```powershell
   .\scripts\install-winsw-service.ps1 -Service ProcessCompose -CredentialPrompt
   .\scripts\install-winsw-service.ps1 -Service OpsGateway -CredentialPrompt
   .\scripts\install-winsw-service.ps1 -Service TerminalBroker -CredentialPrompt
   ```

   `/p` 会要求输入服务账户与密码。脚本拒绝静默注册，并在注册后拒绝 LocalSystem、LocalService 或 NetworkService。
4. Process Compose 账户需要项目读取、runtime 写入和 Docker 生命周期权限；Gateway 账户需要数据库、静态构建、对象存储、keyring 与监督器令牌；Broker 账户只需要工作区与私有 spool。
5. 验证三个账户和 ACL 后再手动启动服务。Gateway 只依赖 Process Compose；Broker 故障不会拖停 Gateway。

## Linux / systemd

创建 `geoforge`、`geoforge-ops`、`geoforge-terminal` 三个不可登录账户。只把 `geoforge` 加入运行 Docker 所需的组。把 `deploy/systemd/` 中的模板复制到 `/etc/systemd/system/`，替换 `@@GEOFORGE_ROOT@@`，并把三个环境文件放到模板指定的 `/etc/geoforge/` 路径。完成目录权限后执行 `systemctl daemon-reload`，依次启用 Process Compose、Broker 和 Gateway。

Broker unit 使用 `NoNewPrivileges`、`PrivateDevices`、`ProtectSystem=strict` 等约束；不要为了方便把其账户加入 Docker 组或授予 `systemctl` 权限。

## 反向代理与恢复窗口

同一个 HTTPS Origin 反代 `/operations/*`、`/ops/*` 与两个 WebSocket 路径。`OPS_PUBLIC_BASE_URL` 和所有 `OPS_ALLOWED_ORIGINS` 在生产环境必须是 HTTPS；Gateway、Broker 与 Process Compose 的内部监听必须保持回环地址。参考配置位于 `infra/docker/web/nginx.conf`。

管理员正常登录后得到 15 分钟 HttpOnly、Secure、SameSite=Strict 恢复会话。数据库短暂故障时，只有尚未过期且此前已验证的管理员能执行固定基础设施恢复动作；冷启动时数据库不可用会硬失败，不存在永久应急账号。

敏感运维请求使用 Better Auth 的权威数据库会话读取并禁用 cookie cache。只有官方会话 API 报告读取失败且独立连接健康探测确认数据库不可达时，Gateway 才接受恢复会话；schema、约束和程序错误继续硬失败，不能伪装成数据库离线。

创建终端、服务写操作和访问他人记录都需要 15 分钟二次密码验证。他人记录还要求 10–500 字原因，并签发只能使用一次、5 分钟有效的授权。回放与 `.cast` 导出均为 `Cache-Control: no-store`。

## 验收与日常检查

- `dev.ps1 status` / `dev.sh status` 的服务事实来自 Process Compose，不再读取 PID 或自建日志文件。
- Windows 开发入口通过隐藏的前台监督器进程承载 Process Compose，Linux 入口通过 `nohup` 承载；两者都以 `/live` 为启动成功判据，不使用版本不支持的 detached 参数，也不写 PID 文件。
- Process Compose 启动统一禁用其内置 dotenv 加载；开发入口装配后的进程环境或生产服务环境文件是唯一环境事实源，避免探针端口与子进程端口分叉。
- 开发入口把 `RUNTIME_ROOT`、监督器日志、令牌、配置目录和运维存储路径统一解析为基于项目根目录的绝对运行时路径；配置文件仍可使用相对路径，但不会再因 npm workspace 或 Docker Compose 的工作目录不同而指向另一份数据。
- Worker 通过平台专用入口脚本启动，由 PowerShell/Bash 以参数数组调用 `WORKER_PYTHON`，避免把带空格的解释器路径交给 Process Compose 的命令字符串再次解析。
- `/ops/health` 只证明 Gateway 存活；进入后台后同时检查四个固定服务、Broker 可用性和数据库状态。
- 终端录制只包含 PTY 输出和 resize，不保存键盘输入。任何 keyring 缺失、GCM 认证失败、spool 写入失败或 512 MiB 上限都会立即终止会话。
- Broker 重启后消失的 PTY 必须显示 `orphaned`；不得把旧画面描述为已恢复的进程。
- 默认保留 7 天。清理先事务删除数据库引用，再由统一对象 GC 删除无引用密文。
