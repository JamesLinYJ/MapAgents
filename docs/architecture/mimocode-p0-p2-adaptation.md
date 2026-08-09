# MiMoCode P0–P2 能力适配规格

## 上游基线

- 上游仓库：`XiaomiMiMo/MiMo-Code`
- 本地参考目录：工作区外层的 `work/MiMo-Code`
- 基线提交：`eef8206d80441117a28b0c208730c9c375c7be04`
- 基线描述：`v0.1.10-17-geef8206d`
- 许可证：MIT；本项目只复用行为契约与交互模式，不复制上游运行时状态机

## 目标与非目标

目标是在不破坏地理智能平台既有事实源、安全边界和 GIS 领域语义的前提下，补齐此前评估中的全部 P0–P2 能力：

1. P0：地理分析 Compose 模式。
2. P0：GIS Skill 目录、可信注册、自动匹配与显式调用。
3. P1：Goal 停止条件、独立验收器以及词元/时间/重试边界。
4. P1：动态子智能体控制与可观测性。
5. P1：自定义模型 Provider 向导。
6. P2：多模态地图输入与模型模态路由。

以下内容明确不在适配范围内：

- 任意 JavaScript workflow 直接在宿主进程执行。
- 跳过审批、RBAC、CSRF、路径沙箱或工具契约的危险模式。
- Agent 自动改写并启用自身工具、Hook、系统提示词或 UI。
- 把子智能体实现成第二套 Runner、手写 turn loop 或不可恢复的后台循环。
- MiMoCode 面向编码任务的 LSP、Git worktree、补丁合入与代码审查流程；本产品是 GIS Agent，现有开发工具仅是管理员默认关闭的维护入口。

## 必须保护的不变量

| 不变量 | 适配要求 |
|---|---|
| 结构化事实源 | Run、Workflow、Goal、子智能体、审批、交付证据继续写入 PostgreSQL；对象存储只保存大载荷与 SDK checkpoint |
| Agent 状态机 | 单次 Run 只使用 OpenAI Agents SDK Runner；子智能体继续使用 `Agent.asTool()` 或 `handoff()` |
| 工作流 | Compose 使用带 Schema 的声明式阶段和现有 Agent Workflow/Automation 执行边界，不加载任意上游 JS |
| 数据流 | 跨工具数据继续只传 `valueRef`；不得把大段坐标、GeoJSON 或宿主路径写进计划 |
| 安全 | 所有写入、删除、外部影响、MCP 和 Skill 脚本继续经过 RBAC、审批、沙箱和审计；内部开发工具默认关闭 |
| 失败语义 | 模型、工具、Schema、Goal 验收和合并失败必须明确失败，不得生成兜底成功结论 |
| 体验事实源 | 桌面端只投影服务端 Run/Workflow/Goal/子智能体状态，不维护第二份执行状态机 |

## P0：地理分析 Compose

### 行为契约

Compose 是一种 Run Profile，而不是新的模型协议。它仍使用 `auto` 执行模式，但运行开始时强制进入规划阶段，并要求工作流覆盖以下阶段：

1. `discover`：确认用户目标、空间/时间范围、已有图层、线程文件和可用数据源。
2. `validate`：核验 CRS、完整性、变量、时间、范围、单位和工具前置条件。
3. `analyze`：执行真实 GIS/气象分析，所有下游输入使用 `valueRef`。
4. `visualize`：按需生成地图、图表或可下载 Artifact；没有展示需求时可以省略。
5. `verify`：使用只读工具或独立子智能体复核关键结论、范围和产物证据。
6. `deliver`：按需生成报告或导出物；最终中文回答仍由 Supervisor 基于事实账本形成。

`discover → validate → analyze → verify` 是最小阶段链。阶段必须通过依赖图形成真实先后关系；不能只改标题冒充阶段完成。可产生副作用的步骤仍由工具自身审批，Compose 不增加总授权开关。

### 验收证据

- 桌面输入模式可选择“地理分析 Compose”。
- `run:start` 保存 `geospatial_compose` Profile，并可在恢复、澄清续跑和快照中保持。
- Compose Run 初始处于计划阶段；普通 Auto/Plan 行为不变。
- 缺少最小阶段、阶段顺序错误或验证步骤不可核验时，工作流提交被稳定中文错误拒绝。
- 工作流侧栏显示阶段、步骤、负责人、进度和失败原因。
- 单元测试覆盖 Profile 传输、初始化、工作流校验和普通模式回归。

## P0：GIS Skill 产品层

### 目标设计

- Skill 内容仍由严格 `SKILL.md` 入口和 SDK sandbox 快照加载。
- 新增服务端 Skill Registry，保存名称、版本、来源、摘要、别名、领域标签、能力要求、内容摘要哈希和信任状态。
- 匹配顺序为：显式 `/skill-name`、精确名称/别名、确定性的词项相关度。低置信度候选只展示，不自动加载。
- 桌面端提供目录、搜索、启用/禁用、版本与来源查看；配置目录不再是唯一用户入口。
- 首批内置领域 Skill：CRS 审计、空间数据质量、制图交付、遥感栅格检查、气象数据检查、分析报告。

### 验收证据

- 同名冲突、大小写错误、符号链接越界、摘要哈希变化和未信任来源均有明确诊断。
- 自动匹配结果可解释并有阈值测试；不确定匹配不会静默注入。
- Skill 无法扩大工具权限，也不能在没有 sandbox backend 时执行脚本。

## P1：Goal 独立验收

- Goal 是 Run/Thread 级持久事实，包含条件、验收标准、最大复验次数、截止时间、最大词元预算和当前状态。
- 工作 Agent 尝试结束时，由独立模型只读取 canonical transcript、工具账本、Artifact 引用和 Workflow 状态，输出结构化 `satisfied | incomplete | impossible` 判定与证据。
- `incomplete` 只在预算内重新进入 Runner；`impossible` 必须有可验证阻塞证据；达到边界后真实失败。
- Judge 不能调用工具、写文件或复用工作 Agent 的主观总结作为唯一证据。

## P1：动态子智能体控制

- 控制面支持列出、查看、追问、取消单个子智能体；创建仍通过主 Runner 的 SDK Agent 工具边界完成。
- 子智能体状态增加最近活动时间、进度、卡顿状态、当前步骤和结果引用。
- 用户控制命令通过 WS 注册表、Zod、CSRF、RBAC 和审计；取消单个子智能体不能误取消整个 Run。
- 桌面工作流面板可展开只读事件与交付证据，不保存第二份 transcript。

## P1：自定义 Provider

- Provider 配置进入受保护的服务端配置仓储；Renderer 不接触 API Key 明文。
- 支持任意 OpenAI-compatible Base URL、模型清单、上下文窗口、工具 Schema 模式和图片/音频/PDF 模态声明。
- 保存前执行 SSRF 防护、连通性测试和最小模型调用；OAuth/凭证导入使用独立授权边界。
- 静态 DeepSeek、Anthropic、Gemini、Ollama Adapter 继续作为内置实现，自定义 Provider 通过注册表接入，不能扩展中央 switch。

## P2：多模态地图输入

- Renderer 粘贴图片时只把 Blob 交给 Electron Main；Main 通过既有文件句柄/上传边界创建线程资源，Renderer 不读取绝对路径。
- 服务端根据 Provider 模态能力选择视觉模型；不支持图片的模型只收到受授权的资源引用，不接收 Base64 大载荷。
- 地图截图可附带当前视口、CRS、可见图层和时间范围的结构化上下文，图片本身不能覆盖系统指令。

## 交付顺序与完成判定

每项能力按“共享 Schema → 服务端事实与策略 → WS/IPC 边界 → 桌面投影 → 单元/架构/集成测试”完成。某项只有 UI、只有配置字段、只有提示词或只有未接入 Vendor 代码时，均视为未完成。

最终完成审计必须逐项证明上述六类能力的真实用户链路、失败路径、恢复路径、安全边界和普通模式回归；不能用单个构建成功代替范围验收。
