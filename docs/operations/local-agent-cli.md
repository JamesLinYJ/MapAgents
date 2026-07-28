# GeoForge 本机 Agent CLI

GeoForge 本机 Agent CLI 是面向已登录服务器操作系统的人工交互入口。它复用主 API 中唯一的 Agent Runner、RunState、工具审批、工作流、审计和 PostgreSQL 会话事实源；CLI 本身不创建第二套 Agent 运行时，也不直接调用模型。

## 启动

Windows 交互界面：

```powershell
.\dev.ps1 agent
```

Windows 一次性任务：

```powershell
.\dev.ps1 agent -AgentPrompt "杭州明天会下雨吗？"
.\dev.ps1 agent -AgentPrompt "先制定计划，再分析杭州强降水风险" -AgentMode plan
.\dev.ps1 agent -AgentPrompt "你好" -Json
.\dev.ps1 agent -Check
```

Linux/macOS：

```bash
./dev.sh agent
./dev.sh agent --prompt "杭州明天会下雨吗？"
./dev.sh agent --mode plan --prompt "比较杭州今天与明天的天气"
./dev.sh agent --check --json
```

入口会启动监督器和 API 所需的固定依赖，再连接 `127.0.0.1` 上的 `/ws`。`--check` 只验证本机授权、数据库、API、工作区和模型能力，不创建 run。

一次性模式退出码：

- `0`：run 已完成；
- `1`：连接、协议、模型、运行或其他真实失败；
- `2`：run 正在等待澄清或审批，JSON 输出包含待处理决定。

## 交互界面

界面采用高信息密度中文布局：

- 顶部使用 GeoForge 深蓝灰主题、青色主焦点、蓝色模型、紫色思考、绿色成功、琥珀色等待和红色失败；状态始终同时显示符号与中文标签，不只依赖颜色；
- 顶部显示服务端实际 Provider、模型、执行模式、本机授权和连接状态；
- 中央持续投影用户消息、思考、工具调用、工具结果、错误和最终回答；已注册工具会明确显示中文名称、公开标识、输入摘要与输出摘要；
- Agent 运行、思考、组织回答、调用工具或子智能体协作时，使用 `@inkjs/ui` 的单一活动指示器展示当前真实阶段和持续时间；完成、等待审批或空闲后立即停止动画；
- 助手正文和思考使用 `markdansi` 渲染 GitHub Flavored Markdown，支持标题、强调、链接、列表、引用、表格、任务列表和代码框，并按当前终端宽度重新排版；
- 终端宽度达到 140 列时，右侧同时显示工作流步骤、子智能体、工具与 Artifact 摘要；
- 底部是多行编辑器，支持中文、粘贴、左右移动、Home/End、Backspace/Delete、`Ctrl+J` 换行和历史召回；
- 鼠标可单击模式、新对话、帮助和审批选项，滚轮浏览对话；鼠标移动追踪保持关闭，终端原生文本选择仍可使用；
- 小于 `80×24` 时停止绘制业务区，只显示稳定尺寸提示。

需要稳定截图、无动画录制或对动态效果敏感时，可设置
`GEOFORGE_REDUCED_MOTION=1`。`CI=true` 与 `TERM=dumb` 也会自动使用带中文标签的静态状态符号；`NO_COLOR` 终端仍保留全部文字和状态语义。

普通字母不会被当作全局快捷键。`q`、`S`、`R` 和 `?` 都可正常输入；只有输入区为空时，`?` 会打开帮助。

常用命令：

```text
/help  /new  /history  /status  /model
/plan  /auto  /reasoning on|off
/resume  /cancel  /tools  /agents  /exit
```

`Ctrl+C` 在运行中取消 run，有文本时清空输入，空闲时连续按两次才分离。分离不会停止 API、Worker、Web 或监督器。

审批默认选中“拒绝”。选择批准后必须再次确认，连接中断时写操作不会自动重放。

## 本机授权边界

CLI 不要求输入现有管理员账号密码，也没有硬编码万能账号。

1. 操作系统 ACL 保护的本机根密钥派生一个固定、保留域名的 Better Auth Agent 服务主体。
2. 每次启动都会重置派生密码、撤销旧会话并建立仅存于当前进程内存的短期会话。
3. 主体的 Better Auth 角色保持普通 `user`；平台身份单独投影为 `platform_admin`。
4. 公共登录和普通 HTTP 认证明确拒绝该主体。只有服务端确认 TCP 对端是 loopback 后，`/ws` 才接受它。
5. 退出时立即登出，并记录本机用户名、主机、进程、run、thread 和结果；密码、Cookie、根密钥与模型密钥不进入日志或审计。

这套授权只允许调用已经注册、带 Zod 契约和 RBAC policy 的 GeoForge WS 命令。它不是 Shell，不接入监督器任意命令，不注册为 Agent Tool 或 Automation 动作。

## 模型与协议

模型列表来自服务端 Provider descriptor。默认不覆盖服务端模型；只有显式 `--model` 且模型位于该 Provider 的 `availableModels` 中时才发送选择。宿主 CLI 的模型名不会被继承，因此 `gpt-5.6-sol` 不会被误传给 DeepSeek；无效模型在创建 run 前用中文硬失败。

控制连接使用带 Better Auth Cookie、可信 Origin 和 CSRF 的 JSONL WebSocket：

- 客户端请求最大 64 KiB；
- 响应缓冲最大 8 MiB；
- 响应和推送均经过 envelope 与业务 Zod schema；
- 断线只重新订阅 canonical run，不重放未确认写入；
- CLI JSON 输出只包含稳定的回答、决定、Artifact 和错误摘要，不输出原始工具参数或工具结果。

## 代码组织

```text
apps/server/src/operations/agent/
  application/   # 会话状态、断线恢复与 run 命令编排
  transport/     # 受约束的 WebSocket JSONL 客户端
  cli/           # 参数、一次性输出与进程入口
  ui/            # Ink 中文界面和 ConversationItem 呈现
packages/conversation-presentation/
  src/           # Web Chat 与 CLI 共用的消息分类、工具配对和公开展示投影
```

主 API 的 Agent SDK Runner 仍位于 `apps/server/src/agent/`。本机 CLI 不导入 `@openai/agents`，不创建应用容器，也不争抢数据库单实例锁。Web 与 CLI 共用业务展示投影，但保留 DOM Markdown 与终端 Markdown 两个最终渲染器。
