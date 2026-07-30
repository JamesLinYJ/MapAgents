# 🔍 GeoForge 地理智能平台 — 全面架构审查报告

**审查日期**: 2026-07-23  
**项目版本**: v0.1.0  
**审查范围**: 全栈 (server, web, worker, gis-meteorology, infra)  
**审查维度**: 架构设计 · 安全性 · 代码质量 · 测试与可观测性  
**审查方法**: 4 个专项 Agent 并行审查 + 主会话结构分析  
**发现总数**: 70+ 个具体发现  

---

## 目录

1. [总体健康评估](#一总体健康评估)
2. [系统架构全景](#二系统架构全景)
3. [分层架构详解](#三分层架构详解)
4. [技术栈矩阵](#四技术栈矩阵)
5. [启动与依赖拓扑](#五启动与依赖拓扑)
6. [数据架构](#六数据架构)
7. [通信架构](#七通信架构)
8. [工具系统架构](#八工具系统架构)
9. [Agent 运行时架构](#九agent-运行时架构)
10. [安全纵深防御](#十安全纵深防御)
11. [前端架构](#十一前端架构)
12. [科学计算架构](#十二科学计算架构)
13. [部署架构](#十三部署架构)
14. [测试与可观测性](#十四测试与可观测性)
15. [审查发现汇总](#十五审查发现汇总)
16. [优先行动计划](#十六优先行动计划)

---

## 一、总体健康评估

### 综合评分: ⭐⭐⭐⭐ (8/10)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         GeoForge 平台健康度                             │
├──────────────┬───────────┬──────────────────────────────────────────┤
│ 架构设计      │  ████████░ │ 8/10  分层清晰，资源拆分到位；Facade 过宽  │
│ 安全性        │  ████████░ │ 8/10  纵深防御体系完整；缺分布式限流       │
│ 代码质量      │  ████████░ │ 8/10  零 as any/console.log；惰性导入违规 │
│ 测试覆盖      │  █████░░░░ │ 5/10  后端 77 文件；科学计算包零测试      │
│ 可观测性      │  █████████ │ 9/10  结构化日志+traceId+17 族指标        │
│ 架构守卫      │  █████████ │ 10/10 1277 行自动化架构测试 (工业级)      │
└──────────────┴───────────┴──────────────────────────────────────────┘
```

### 项目身份

| 属性 | 值 |
|------|-----|
| **项目名称** | GeoForge (geo-agent-platform) |
| **项目类型** | Monorepo — 地理智能平台 |
| **语言混合** | TypeScript (主), Python (科学计算), SQL (PostGIS) |
| **仓库结构** | 4 npm workspaces + 2 Python packages |
| **架构风格** | 五平面架构 + Agent-Driven + 事件驱动 |
| **核心框架** | Hono + React 19 + FastAPI + OpenAI Agents SDK |

---

## 二、系统架构全景

### 2.1 五平面架构

GeoForge 按能力平面划分，而不是按技术名词随意分层：

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           GeoForge 五平面架构                                 │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                        体验平面 (Experience)                           │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │ │
│  │  │ Web 工作台│  │ 地图面板  │  │ 对话面板  │  │ 管理后台  │  │ 分享页  │ │ │
│  │  │ React 19 │  │ MapLibre │  │ Chat UI  │  │ Admin UI │  │ Share   │ │ │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │ │
│  └───────┼─────────────┼─────────────┼─────────────┼─────────────┼───────┘ │
│          │             │             │             │             │          │
│          ▼             ▼             ▼             ▼             ▼          │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                       编排平面 (Orchestration)                         │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │ │
│  │  │ Session  │  │ Thread   │  │ Run      │  │ Workflow/Automation  │  │ │
│  │  │ 生命周期  │  │ 上下文    │  │ 状态机    │  │ 定时任务 + JobQueue  │  │ │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┬───────────┘  │ │
│  └───────┼─────────────┼─────────────┼───────────────────┼──────────────┘ │
│          │             │             │                   │                │
│          ▼             ▼             ▼                   ▼                │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                        执行平面 (Execution)                            │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────────┐  │ │
│  │  │ Agent    │  │ Tool     │  │ Python   │  │ 确定性旁路             │  │ │
│  │  │ Runtime  │  │ Provider │  │ Worker   │  │ (临近预报)            │  │ │
│  │  └────┬─────┘  └────┬─────┘  └────┬─────┘  └──────────┬───────────┘  │ │
│  └───────┼─────────────┼─────────────┼───────────────────┼──────────────┘ │
│          │             │             │                   │                │
│          ▼             ▼             ▼                   ▼                │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                        数据平面 (Data)                                 │ │
│  │  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                │ │
│  │  │ PostgreSQL   │  │ 内容寻址      │  │ 外部数据源    │                │ │
│  │  │ + PostGIS    │  │ 文件存储      │  │ (地图/气象)   │                │ │
│  │  │ (结构化事实)  │  │ (大对象/载荷) │  │              │                │ │
│  │  └──────────────┘  └──────────────┘  └──────────────┘                │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐ │
│  │                       治理平面 (Governance) — 横切所有层                │ │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │ │
│  │  │ 身份认证  │  │ RBAC授权  │  │ 审计日志  │  │ 限速控制  │  │ CSRF   │ │ │
│  │  │ Better   │  │ Casbin   │  │ Audit    │  │ Rate     │  │ HMAC   │ │ │
│  │  │ Auth     │  │          │  │ Store    │  │ Limiter  │  │ Token  │ │ │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘  └─────────┘ │ │
│  └───────────────────────────────────────────────────────────────────────┘ │
│                                                                             │
│  依赖方向: 体验 → 编排 → 执行 → 数据    (治理横切所有层)                     │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.2 仓库拓扑 (Monorepo)

```
geo-agent-platform/  (root)
│
├── 📦 server/                          # Node.js API + WebSocket 服务
│   └── src/
│       ├── agent/      (30+ 文件)       # Agent 运行时编排
│       ├── app/        (container.ts)   # 依赖装配 (组合根)
│       ├── automations/(10+ 文件)       # 自动化工作流引擎
│       ├── db/         (3 文件)         # PostgreSQL 连接 + Schema
│       ├── framework/  (8 文件)         # 工具注册、加载、类型、校验
│       ├── gis/        (managedLayers/) # PostGIS 图层管理
│       ├── map/        (5 文件)         # 地图瓦片网关
│       ├── memory/     (5 文件)         # 记忆系统服务
│       ├── model/      (3 文件)         # LLM 适配器注册表
│       ├── observability/(4 文件)       # 日志 + 指标 + Trace
│       ├── operations/ (3 文件)         # 本机运维控制台
│       ├── routes/     (7 文件)         # HTTP 路由
│       ├── security/   (11 文件)        # 认证/授权/限速/CSRF
│       ├── speech/     (1 文件)         # Azure 语音服务
│       ├── store/      (40+ 文件)       # 持久化仓储 (Postgres + 文件)
│       ├── tools/      (17 目录)        # 工具提供者
│       ├── usage/      (2 文件)         # 用量统计
│       ├── utils/      (3 文件)         # 通用工具
│       └── ws/         (26 文件)        # WebSocket 控制面
│
├── 📦 apps/web/                         # React 前端
│   └── src/
│       ├── api/        (10 文件)        # HTTP+WS 传输层
│       ├── app/
│       │   ├── stores/ (8 Zustand slices)
│       │   └── controllers/ (10 hooks)
│       ├── features/   (10 功能域)
│       │   ├── auth/                    # 认证
│       │   ├── chat/                    # 对话
│       │   ├── composer/               # 输入框
│       │   ├── conversation/           # 对话列表
│       │   ├── debug/                  # 调试面板
│       │   ├── inspector/              # 属性检查器
│       │   ├── layers/                 # 图层管理
│       │   ├── map/                    # 地图渲染
│       │   ├── settings/              # 设置
│       │   └── tools/                  # 工具面板 (含自动化工作室)
│       ├── shared/    (通用组件/工具)
│       └── ws/        (WebSocket 客户端)
│
├── 📦 apps/worker/                      # Python 科学计算 Worker
│   └── src/worker_app/
│       ├── sidecar.py                   # FastAPI 入口
│       ├── app_factory.py              # 应用装配
│       ├── auth.py                      # HMAC 签名验证
│       ├── tool_registry.py            # 工具注册表
│       ├── tool_routes.py              # /tools/{tool_name} 路由
│       ├── tool_contracts.py           # Pydantic 契约
│       ├── path_sandbox.py             # 路径沙箱
│       ├── logging.py                  # 结构化日志
│       ├── nowcast_bridge.py           # 临近预报桥接
│       ├── request_args.py             # 参数解析
│       └── tools/                      # 内置科学工具
│
├── 📦 packages/gis-meteorology/         # Python 科学计算领域包
│   └── src/gis_meteorology/
│       ├── readers.py   (栅格读取抽象)
│       ├── service.py   (数据服务)
│       ├── nowcast.py   (临近预报)
│       ├── radar.py     (雷达解码)
│       ├── report.py    (DOCX 报告)
│       └── third_party/ (3 个气象算法适配器)
│
├── 📦 packages/shared-types/            # 跨包共享类型 (Zod → TS)
│   └── src-ts/
│       ├── core.ts, conversation.ts, runtime.ts
│       ├── platform.ts, resources.ts
│       ├── transport.ts, worker.ts
│       └── index.ts (统一导出)
│
├── 📦 packages/operations-supervisor/   # 本机进程监督 TUI
│
├── 📁 infra/                            # 基础设施配置
│   ├── compose/     (Docker Compose)
│   ├── docker/web/  (Nginx 配置)
│   ├── migrations/  (SQL 迁移)
│   └── seeds/layers/(GeoJSON 图层种子)
│
├── 📁 deploy/                           # 部署配置
│   ├── env/        (环境变量模板)
│   ├── systemd/    (Linux 服务单元)
│   └── windows/    (Windows 服务)
│
├── 📁 tests/                            # E2E + Python 集成测试
│   ├── e2e/        (Playwright)
│   └── conftest.py
│
├── 📁 vendor/                           # Vendored 第三方代码
│
├── 📁 scripts/                          # 构建/运维脚本
├── 📁 demo/                             # Tool Provider 示例
└── 📁 docs/                             # 文档
```

---

## 三、分层架构详解

### 3.1 治理平面 (Governance)

```
┌─────────────────────────────────────────────────────────────────────┐
│                         治理平面 — 安全纵深                            │
│                                                                     │
│  请求流入                                                            │
│     │                                                               │
│     ▼                                                               │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────┐               │
│  │  Nginx   │───▶│ CORS 白名单   │───▶│ HTTP 限速     │               │
│  │ TLS 终止 │    │ (精确匹配)    │    │ Auth:10/min   │               │
│  └──────────┘    └──────────────┘    │ API:120/min   │               │
│                                      └──────┬───────┘               │
│                                             │                       │
│                    ┌────────────────────────┼──────────────┐        │
│                    │                        ▼              │        │
│                    │  ┌──────────────────────────────┐     │        │
│                    │  │  Better Auth (认证)          │     │        │
│                    │  │  • email/password + session  │     │        │
│                    │  │  • 12h 过期 + 1h 续期       │     │        │
│                    │  │  • 控制台凭据 (root secret)  │     │        │
│                    │  └──────────────┬───────────────┘     │        │
│                    │                 │                     │        │
│                    │                 ▼                     │        │
│                    │  ┌──────────────────────────────┐     │        │
│                    │  │  Casbin RBAC (授权)          │     │        │
│                    │  │  • deny-by-default            │     │        │
│                    │  │  • workspace 级隔离           │     │        │
│                    │  │  • 角色: admin/analyst/viewer │     │        │
│                    │  └──────────────┬───────────────┘     │        │
│                    │                 │                     │        │
│                    │                 ▼                     │        │
│                    │  ┌──────────────────────────────┐     │        │
│                    │  │  CSRF 防护                    │     │        │
│                    │  │  • HMAC(secret, "csrf:"+sid) │     │        │
│                    │  │  • x-geoforge-csrf header    │     │        │
│                    │  │  • HTTP + WS 双重校验         │     │        │
│                    │  └──────────────┬───────────────┘     │        │
│                    │                 │                     │        │
│                    │                 ▼                     │        │
│                    │  ┌──────────────────────────────┐     │        │
│                    │  │  AuditStore (审计)            │     │        │
│                    │  │  • 所有授权决策被记录          │     │        │
│                    │  └──────────────────────────────┘     │        │
│                    └────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.2 编排平面 (Orchestration)

```
┌─────────────────────────────────────────────────────────────────────┐
│                      编排平面 — 任务生命周期                            │
│                                                                     │
│   用户意图                                                            │
│     │                                                               │
│     ▼                                                               │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │                    Session (会话)                          │      │
│  │  • 工作区隔离     • 最新线程指针     • 配额上下文          │      │
│  └────────────────────────┬─────────────────────────────────┘      │
│                           │                                        │
│                           ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │                    Thread (线程)                           │      │
│  │  • 对话上下文     • 记忆版本     • 压缩记录               │      │
│  │  • 最新助手摘要   • ValueRef 索引 • 文件引用              │      │
│  └────────────────────────┬─────────────────────────────────┘      │
│                           │                                        │
│                           ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │                    Run (运行)                              │      │
│  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐     │      │
│  │  │ pending │─▶│ running │─▶│ waiting │─▶│completed│     │      │
│  │  │         │  │         │  │_approval│  │ /failed │     │      │
│  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘     │      │
│  │  • AgentStateModel 执行快照                                │      │
│  │  • ToolValueRef 黑板 (valueRef 流)                        │      │
│  │  • SDK Checkpoint 持久化 (恢复用)                          │      │
│  │  • Transcript Entry + Conversation Item (审计事实)         │      │
│  └────────────────────────┬─────────────────────────────────┘      │
│                           │                                        │
│                           ▼                                        │
│  ┌──────────────────────────────────────────────────────────┐      │
│  │               Automation / Workflow (自动化)               │      │
│  │  • 确定性工具链 (临近预报旁路)                              │      │
│  │  • 定时触发 (ScheduledTask)                               │      │
│  │  • 条件工作流 (Automation Graph DAG)                      │      │
│  └──────────────────────────────────────────────────────────┘      │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.3 执行平面 (Execution)

```
┌─────────────────────────────────────────────────────────────────────┐
│                     执行平面 — Agent 运行时                           │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │                   OpenAIAgentsRuntime                         │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌──────────────────────┐  │  │
│  │  │ Context     │  │ Tool        │  │ Approval            │  │  │
│  │  │ Manager     │  │ Execution   │  │ System               │  │  │
│  │  │             │  │ Coordinator │  │                      │  │  │
│  │  │ 上下文窗口   │  │             │  │ 工具审批 → 中断运行   │  │  │
│  │  │ 管理        │  │ Plan Mode   │  │ → 恢复 SDK 状态      │  │  │
│  │  │ Compaction  │  │ 硬边界       │  │ → 继续执行           │  │  │
│  │  └──────┬──────┘  └──────┬──────┘  └──────────┬───────────┘  │  │
│  └─────────┼───────────────┼─────────────────────┼──────────────┘  │
│            │               │                     │                 │
│            ▼               ▼                     ▼                 │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Sub-Agent 子系统                           │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │   │
│  │  │ Handoff  │  │ Parallel │  │ Sandbox  │  │ Guardrail│    │   │
│  │  │ Agent    │  │ SubAgent │  │ (文件隔离)│  │ (输出护栏)│    │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   ToolProvider 体系 (17 个提供者)              │   │
│  │                                                               │   │
│  │  TypeScript (内置)          跨语言 (TS ↔ Python Worker)       │   │
│  │  ┌──────────┐ ┌──────────┐  ┌──────────┐ ┌──────────────┐   │   │
│  │  │ chart    │ │ geocode  │  │meteorology│ │spatialAnalysis│  │   │
│  │  │ developer│ │ layer*   │  │(nowcast,  │ │(第三方算法)   │   │   │
│  │  │ mapExport│ │ media    │  │ radar,    │ └──────────────┘   │   │
│  │  │ memory   │ │ plan     │  │ dataset)  │                    │   │
│  │  │ routing  │ │ spatial  │  └──────────┘                    │   │
│  │  │ publicW  │ │ autoExec │                                   │   │
│  │  │ eather   │ │          │                                   │   │
│  │  └──────────┘ └──────────┘                                   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                   Python Worker (科学计算)                     │   │
│  │                                                               │   │
│  │  FastAPI sidecar ← HMAC 认证 ← Node.js 调用                   │   │
│  │  │                                                            │   │
│  │  ├── /health              健康检查 (+ 库导入验证)              │   │
│  │  ├── /tools/catalog       工具目录 (Pydantic → JSON Schema)   │   │
│  │  └── /tools/{tool_name}   科学计算端点 (18 个)                │   │
│  │       │                                                       │   │
│  │       └── WorkerToolRegistry.dispatch(tool_name, params)      │   │
│  │            │                                                  │   │
│  │            └── gis_meteorology 领域服务                        │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### 3.4 数据平面 (Data)

```
┌─────────────────────────────────────────────────────────────────────┐
│                    数据平面 — 双事实源架构                             │
│                                                                     │
│  ┌───────────────────────────────┐  ┌─────────────────────────────┐ │
│  │  PostgreSQL + PostGIS         │  │  内容寻址文件存储             │ │
│  │  (结构化事实源)                │  │  (大对象 / 载荷)             │ │
│  │                               │  │                              │ │
│  │  ┌─────────────────────────┐  │  │  runtime/objects/sha256/     │ │
│  │  │ Drizzle ORM (查询构建器) │  │  │  ├── a1/                    │ │
│  │  │ + db.execute(sql...)    │  │  │  │   └── a1b2c3... (SHA256) │ │
│  │  │   (仅 PostGIS/DDL)      │  │  │  └── b2/                    │ │
│  │  └─────────────────────────┘  │  │      └── b2c3d4...          │ │
│  │                               │  │                              │ │
│  │  核心表:                       │  │  存储内容:                    │ │
│  │  ├── auth_user / auth_session │  │  ├── 用户上传                 │ │
│  │  ├── platform_users           │  │  ├── Artifact 二进制          │ │
│  │  ├── platform_workspaces      │  │  ├── SDK checkpoint 载荷      │ │
│  │  ├── platform_sessions        │  │  ├── Markdown 记忆正文        │ │
│  │  ├── platform_threads         │  │  └── 附件引用                 │ │
│  │  ├── platform_runs            │  │                              │ │
│  │  ├── platform_conversation_   │  │  GC: 扫描所有引用后清理       │ │
│  │  │   entries                  │  │  未引用对象                   │ │
│  │  ├── platform_artifacts       │  │                              │ │
│  │  ├── platform_map_layers      │  └─────────────────────────────┘ │
│  │  ├── platform_map_scenes      │                                  │
│  │  ├── platform_meteorological_ │                                  │
│  │  │   datasets / jobs          │                                  │
│  │  ├── platform_automation_*    │                                  │
│  │  ├── platform_rbac_policies   │                                  │
│  │  └── platform_audit_events    │                                  │
│  │                               │                                  │
│  │  索引策略:                     │                                  │
│  │  • 外键 + 唯一约束 + 级联     │                                  │
│  │  • PostGIS 空间索引 (GIST)    │                                  │
│  │  • 2 字符前缀哈希分片          │                                  │
│  └───────────────────────────────┘                                  │
│                                                                     │
│  PostgreSQL 会话建议锁 (pg_advisory_lock)                            │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │  单写实例边界: 进程断开 → 数据库自动释放锁                     │   │
│  │  禁止使用 PID 文件或 lock 文件判断实例所有权                   │   │
│  └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 四、技术栈矩阵

```
┌──────────────────────────────────────────────────────────────────────┐
│                         技术栈全景图                                    │
├─────────────┬──────────────────────────────────────────────────────────┤
│             │                                                          │
│  体验平面    │  React 19 · Vite 8 · Tailwind CSS 4 · Framer Motion 12  │
│  (前端)     │  MapLibre GL · TanStack Query/Router/Virtual            │
│             │  Zustand (8 slices) · react-hook-form + Zod             │
│             │  PartySocket (WS 重连) · @tanstack/react-table          │
│             │                                                          │
├─────────────┼──────────────────────────────────────────────────────────┤
│             │                                                          │
│  服务端      │  Node.js 22+ · TypeScript 5.8 · Hono 4 (HTTP)          │
│  (API+WS)   │  ws 8 (WebSocket) · Drizzle ORM (PostgreSQL)            │
│             │  OpenAI Agents SDK 0.13 · Better Auth · Casbin 6        │
│             │  Pino (结构化日志) · prom-client (指标)                  │
│             │  Zod (边界校验) · node-fetch                             │
│             │                                                          │
├─────────────┼──────────────────────────────────────────────────────────┤
│             │                                                          │
│  Worker      │  Python 3.12 · FastAPI · uvicorn                       │
│  (科学计算)   │  numpy · xarray · rasterio/GDAL · geopandas            │
│             │  scipy · matplotlib · cfgrib · netCDF4 · h5py           │
│             │  shapely · openpyxl · Pydantic 2                         │
│             │  HMAC-SHA256 (Worker 认证)                               │
│             │                                                          │
├─────────────┼──────────────────────────────────────────────────────────┤
│             │                                                          │
│  基础设施    │  PostgreSQL 16 + PostGIS 3 · Martin (矢量瓦片)          │
│             │  Nginx (TLS 终止 + 反向代理) · Docker Compose            │
│             │  Windows 11 / Linux (双平台) · PowerShell / Bash         │
│             │                                                          │
├─────────────┼──────────────────────────────────────────────────────────┤
│             │                                                          │
│  开发工具    │  Vitest 4 (单元测试) · Playwright (E2E) · pytest        │
│             │  ESLint 9 (flat config) · Prettier · TypeScript strict   │
│             │  concurrently (进程管理) · operations-supervisor (TUI)   │
│             │                                                          │
└─────────────┴──────────────────────────────────────────────────────────┘
```

---

## 五、启动与依赖拓扑

### 5.1 服务端启动序列

```
┌──────────────────────────────────────────────────────────────────────┐
│                   main.ts 启动序列 (AGENTS.md §5.1 权威顺序)           │
│                                                                      │
│  Step 1  ──▶ 加载环境变量 (dotenv + Zod envSchema)                    │
│  Step 2  ──▶ 禁用外部 Agent tracing                                  │
│  Step 3  ──▶ 创建 DB 连接池 → acquire() pg_advisory_lock             │
│  Step 4  ──▶ ensureMeteorologicalTables(db)                          │
│             ▶ ensureSecurityTables(db)                                │
│             ▶ ensureModelResultCacheTable(db)                         │
│  Step 5  ──▶ store.initialize() — 从 PostgreSQL 加载会话/线程/运行索引 │
│  Step 6  ──▶ seedLayersFromDirectory() (如配置 SEED_LAYERS_DIR)       │
│  Step 7  ──▶ discoverAndLoad() — 发现并加载 ToolProvider              │
│             ▶ validateWorkerContracts() — 校验 TS ↔ Python 工具契约   │
│  Step 8  ──▶ 构建 Hono app + 注册 7 组路由 + 中间件                    │
│  Step 9  ──▶ createServer() + createWsHandler()                      │
│  Step 10 ──▶ installLifecycleManager() (SIGTERM 处理)                 │
│  Step 11 ──▶ server.listen(API_PORT, API_HOST)                       │
│                                                                      │
│  ⚠️ 约束: store.initialize() 完成前不得启动 HTTP 监听                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.2 AppContainer 依赖装配图

```
┌──────────────────────────────────────────────────────────────────────┐
│                createAppContainer() — 组合根 (263 行)                  │
│                                                                      │
│  env ─────────────────────────────────────────────┐                  │
│  projectRoot ──────────────────────────────────┐  │                  │
│                                                │  │                  │
│  ┌──────────────────┐                          │  │                  │
│  │ Database (Drizzle)│◀── DATABASE_URL ─────────┤  │                  │
│  └────────┬─────────┘                          │  │                  │
│           │                                    │  │                  │
│     ┌─────┼─────────────────────────────┐      │  │                  │
│     │     ▼                             ▼      ▼  ▼                  │
│     │  ┌────────────┐  ┌────────────────────┐  ┌────────────────┐   │
│     │  │ Instance   │  │ PlatformPersistence│  │ ManagedLayer   │   │
│     │  │ Lock       │  │ Facade (组合 8 Store)│  │ Service        │   │
│     │  └────────────┘  └────────┬───────────┘  └───────┬────────┘   │
│     │                           │                      │            │
│     │              ┌────────────┼──────────────┐       │            │
│     │              ▼            ▼              ▼       │            │
│     │  ┌──────────────┐ ┌────────────┐ ┌────────────┐ │            │
│     │  │ Identity     │ │ AuditStore │ │ MapStore   │ │            │
│     │  │ Service      │ │            │ │ (3 仓储)    │ │            │
│     │  └──────┬───────┘ └─────┬──────┘ └────────────┘ │            │
│     │         │               │                        │            │
│     │  ┌──────┴───────────────┴────────────────────────┼────┐       │
│     │  │              SecurityServices                  │    │       │
│     │  │  auth: BetterAuthService                      │    │       │
│     │  │  authorization: AuthorizationService(db,audit)│    │       │
│     │  │  admin: SecurityAdminService                  │    │       │
│     │  └──────────────────┬────────────────────────────┘    │       │
│     │                     │                                 │       │
│     │  ┌──────────────────┴────────────────────────────┐   │       │
│     │  │          Core Runtime Services                 │   │       │
│     │  │  ToolRegistry  ModelAdapterRegistry            │   │       │
│     │  │  ModelCompletionService  OpenAIAgentsRuntime   │   │       │
│     │  │  RunTaskManager  UsageStatsService             │   │       │
│     │  └──────────────────┬────────────────────────────┘   │       │
│     │                     │                                 │       │
│     │  ┌──────────────────┴────────────────────────────┐   │       │
│     │  │          Automation Services                   │   │       │
│     │  │  AutomationRegistry  AutomationCompiler        │   │       │
│     │  │  AutomationDefinitionService                   │   │       │
│     │  │  ScheduledTaskService  JobQueueService         │   │       │
│     │  │  AutomationRunner  AutomationInvocationService │   │       │
│     │  └───────────────────────────────────────────────┘   │       │
│     └──────────────────────────────────────────────────────┘       │
│                                                                      │
│  返回值: AppContainer { 20+ services }                               │
└──────────────────────────────────────────────────────────────────────┘
```

### 5.3 Service 间调用图

```
                         ┌──────────────┐
                         │   main.ts    │
                         │ (入口+装配)   │
                         └──────┬───────┘
                                │
              ┌─────────────────┼─────────────────┐
              │                 │                 │
              ▼                 ▼                 ▼
     ┌────────────┐   ┌────────────┐   ┌────────────────┐
     │HTTP Routes │   │ WS Handler │   │ Lifecycle Mgr  │
     │(7 组)       │   │ (registry) │   │ (SIGTERM→503)  │
     └─────┬──────┘   └─────┬──────┘   └────────────────┘
           │                │
           │         ┌──────┴──────┐
           │         │ 26 Command  │
           │         │ Definitions │
           │         └──────┬──────┘
           │                │
           ▼                ▼
     ┌────────────────────────────────────┐
     │         AppContainer               │
     │  ┌──────────┐  ┌────────────────┐  │
     │  │ Security │  │ Store Facade   │  │
     │  │ Services │  │ (8 资源 Store) │  │
     │  └──────────┘  └───────┬────────┘  │
     │  ┌──────────┐          │           │
     │  │ Agent    │◀─────────┘           │
     │  │ Runtime  │                      │
     │  └────┬─────┘                      │
     │       │                            │
     │  ┌────┴─────────────────────┐      │
     │  │ ToolRegistry + Providers │      │
     │  │  ┌──────┐ ┌───────────┐  │      │
     │  │  │ TS   │ │ Worker    │  │      │
     │  │  │ Tools│ │ Client    │──┼──────┼──▶ Python Worker
     │  │  └──────┘ └───────────┘  │      │     (FastAPI)
     │  └──────────────────────────┘      │
     │  ┌──────────────────────────┐      │
     │  │ Automation Services      │      │
     │  │ (Scheduler + Runner)     │      │
     │  └──────────────────────────┘      │
     └────────────────────────────────────┘
```

---

## 六、数据架构

### 6.1 PostgreSQL Schema 核心表

```
┌──────────────────────────────────────────────────────────────────────┐
│                     PostgreSQL 核心表关系图                            │
│                                                                      │
│  ┌──────────────┐       ┌──────────────────┐                        │
│  │  auth_user   │       │  auth_session    │                        │
│  │  ─────────── │       │  ─────────────── │                        │
│  │  id (PK)     │◀──────│  user_id (FK)    │                        │
│  │  email       │       │  token           │                        │
│  │  name        │       │  expires_at      │                        │
│  └──────┬───────┘       └──────────────────┘                        │
│         │                                                           │
│         ▼                                                           │
│  ┌──────────────────┐                                               │
│  │  platform_users  │                                               │
│  │  ─────────────── │                                               │
│  │  user_id (PK/FK) │──────▶ auth_user.id                           │
│  │  display_name    │                                               │
│  └────────┬─────────┘                                               │
│           │                                                         │
│           ▼                                                         │
│  ┌──────────────────────┐       ┌──────────────────────┐           │
│  │  platform_memberships│       │  platform_workspaces │           │
│  │  ─────────────────── │       │  ─────────────────── │           │
│  │  user_id (FK)        │──────▶│  workspace_id (PK)   │           │
│  │  workspace_id (FK)   │       │  name                │           │
│  │  role                │       │  created_by (FK)     │           │
│  └──────────────────────┘       └──────────┬───────────┘           │
│                                            │                        │
│              ┌─────────────────────────────┼─────────────┐         │
│              │                             │             │         │
│              ▼                             ▼             ▼         │
│  ┌──────────────────┐  ┌──────────────────────┐  ┌──────────────┐ │
│  │platform_sessions │  │  platform_threads    │  │ platform_    │ │
│  │────────────────  │  │  ─────────────────── │  │ map_layers   │ │
│  │ session_id (PK)  │  │  thread_id (PK)      │  │              │ │
│  │ workspace_id(FK) │  │  session_id (FK) ────│──▶ sessions   │ │
│  │ latest_thread_id │  │  latest_run_id (FK)  │  └──────────────┘ │
│  └────────┬─────────┘  └──────────┬───────────┘                   │
│           │                       │                                │
│           │                       ▼                                │
│           │  ┌──────────────────────────────────────┐              │
│           │  │         platform_runs                │              │
│           │  │  ────────────────────────────────    │              │
│           │  │  run_id (PK)    thread_id (FK)       │              │
│           │  │  status         agent_state_model    │              │
│           │  │  sdk_checkpoint_digest               │              │
│           │  └──────────┬───────────────────────────┘              │
│           │             │                                          │
│           │             ▼                                          │
│           │  ┌──────────────────────────────────────┐              │
│           │  │  platform_conversation_entries       │              │
│           │  │  ─────────────────────────────────── │              │
│           │  │  entry_id (PK)  run_id (FK)         │              │
│           │  │  entry_kind     body                 │              │
│           │  │  (message/tool_call/tool_result/...) │              │
│           │  └──────────────────────────────────────┘              │
│           │                                                        │
│           ▼                                                        │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │platform_artifacts│  │platform_automation│  │platform_rbac_    │  │
│  │                  │  │_definitions       │  │policies          │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
│                                                                      │
│  PostGIS 扩展表:                                                     │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │platform_map_     │  │platform_map_     │  │platform_meteoro- │  │
│  │scenes + layers   │  │scene_layers      │  │logical_datasets  │  │
│  │(geometry columns)│  │(关联表)           │  │+ jobs            │  │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘  │
└──────────────────────────────────────────────────────────────────────┘
```

### 6.2 存储仓储拆分 (40+ 文件)

```
server/src/store/
│
├── platformPersistenceFacade.ts   # 组合 Facade (委托 8 个子 Store)
│
├── postgres/                      # PostgreSQL 仓储 (结构化事实)
│   ├── sessionRepository.ts       # Session CRUD
│   ├── threadRepository.ts        # Thread 门面 (组合 4 个子仓储)
│   ├── threadLifecycleRepository.ts  # Thread 生命周期 (事务化)
│   ├── threadMemoryRepository.ts  # 记忆版本
│   ├── threadCompactionRepository.ts # 压缩记录
│   ├── conversationTranscriptRepository.ts # Transcript Entry
│   ├── runRepository.ts           # Run 门面 (组合 3 个子仓储)
│   ├── runStateRepository.ts      # Run 状态 (事务化)
│   ├── runCheckpointRepository.ts # SDK Checkpoint
│   ├── runRecordRepository.ts     # Run 记录
│   ├── runInputRepository.ts      # Run 输入
│   ├── objectReferenceRepository.ts # 内容寻址引用
│   ├── artifactMetadataRepository.ts # Artifact 元数据
│   ├── artifactPublicationRepository.ts # Artifact 发布 (事务化)
│   ├── artifactMapProjectionRepository.ts # 地图投影
│   ├── mapStore.ts                # 地图门面
│   ├── mapSceneRepository.ts      # 场景
│   ├── mapLayerRepository.ts      # 图层
│   ├── mapFeatureRepository.ts    # 要素 (PostGIS)
│   ├── meteorologicalStore.ts     # 气象门面
│   ├── meteorologicalDatasetRepository.ts  # 数据集
│   ├── meteorologicalJobRepository.ts      # 处理任务
│   ├── automationStore.ts         # 自动化门面
│   ├── automationDefinitionRepository.ts  # 定义
│   ├── automationRunRepository.ts # 运行
│   ├── scheduledTaskRepository.ts # 定时任务
│   ├── platformUserRepository.ts  # 用户
│   ├── workspaceRepository.ts     # 工作区
│   ├── membershipRepository.ts    # 成员
│   ├── rbacPolicyReader.ts        # RBAC 策略
│   ├── authSessionRepository.ts   # Auth Session
│   ├── auditStore.ts              # 审计事件
│   ├── localAccountRepository.ts  # 本机账户
│   ├── runtimeConfigRepository.ts # 运行时配置
│   ├── toolCatalogRepository.ts   # 工具目录
│   ├── conversationPersistencePorts.ts # 持久化端口接口 (14 个)
│   ├── conversationPersistence.ts # 持久化装配
│   ├── conversationSnapshotRepository.ts # 快照
│   ├── conversationRowMappers.ts  # 行映射器
│   └── eventOutboxRepository.ts  # 事件发件箱
│
├── sessionStore.ts                # Session 内存索引
├── threadStore.ts                 # Thread 内存索引
├── runStore.ts                    # Run 内存索引
├── artifactStore.ts               # Artifact 读取门面
├── conversationPayloadStore.ts    # 文件载荷存储
├── contentAddressedObjectStore.ts # SHA256 对象存储
├── conversationObjectGarbageCollector.ts # GC
├── durableJsonlStore.ts           # JSONL 持久化
├── durableFileIo.ts               # 文件 IO 工具
├── fileStore.ts                   # Runtime 文件操作
├── conversationProjectionIndex.ts # 内存投影 (可重建)
├── storeErrors.ts                 # 错误类型
├── runtimePorts.ts                # Agent 运行时端口接口
├── eventBus.ts                    # 内部事件总线
├── runMutationQueue.ts            # Run 变更队列
├── threadMutationQueue.ts         # Thread 变更队列
└── conversationEncoding.ts        # 对话编解码
```

---

## 七、通信架构

### 7.1 HTTP 路由表

```
┌──────────────────────────────────────────────────────────────────────┐
│                        HTTP 路由表 (Hono)                              │
├────────┬─────────────────────────────┬────────┬─────────────────────┤
│ 方法    │ 路径                         │ 认证    │ 用途                │
├────────┼─────────────────────────────┼────────┼─────────────────────┤
│ GET    │ /health                     │ 无     │ 健康检查 + 就绪探测   │
│ GET    │ /metrics                    │ 无     │ Prometheus 指标      │
│ GET    │ /api/share/:token           │ 限速   │ 公开分享页           │
│ *      │ /api/auth/*                 │ 限速   │ Better Auth 认证     │
│ GET    │ /api/v1/admin/users         │ Auth   │ 管理: 用户列表       │
│ PATCH  │ /api/v1/admin/users/:id     │ Auth   │ 管理: 编辑用户       │
│ POST   │ /api/v1/admin/workspaces    │ Auth   │ 管理: 创建工作区     │
│ POST   │ /api/v1/admin/memberships   │ Auth   │ 管理: 添加成员       │
│ DELETE │ /api/v1/admin/memberships   │ Auth   │ 管理: 移除成员       │
│ POST   │ /api/v1/files/upload        │ Auth   │ 文件上传 (FormData)  │
│ GET    │ /api/v1/files/:ref          │ Auth   │ 文件下载             │
│ GET    │ /api/v1/layers              │ Auth   │ 图层列表             │
│ POST   │ /api/v1/layers/import       │ Auth   │ 图层导入             │
│ GET    │ /api/v1/artifacts/:id       │ Auth   │ Artifact 获取        │
│ GET    │ /api/v1/map/tiles/:z/:x/:y  │ Auth   │ 地图瓦片             │
│ GET    │ /api/v1/meteorology/datasets│ Auth   │ 气象数据集列表       │
│ POST   │ /api/v1/meteorology/datasets│ Auth   │ 创建气象数据集       │
│ GET    │ /api/v1/meteorology/jobs/:id│ Auth   │ 气象任务状态         │
└────────┴─────────────────────────────┴────────┴─────────────────────┘
```

### 7.2 WebSocket 命令注册表

```
┌──────────────────────────────────────────────────────────────────────┐
│                  WebSocket 控制面 — 26 命令文件                         │
│                                                                      │
│  /ws (upgrade: Origin 检查 + Session 验证)                            │
│  │                                                                   │
│  ├── 会话命令 (sessionCommands.ts)                                    │
│  │   └── workspace:bootstrap, session:status                         │
│  │                                                                   │
│  ├── 线程命令 (threadCommands.ts)                                     │
│  │   └── thread:create, thread:list, thread:delete, thread:restore  │
│  │                                                                   │
│  ├── 运行命令 (runCommands.ts)                                        │
│  │   └── run:create, run:cancel, run:retry, run:approve, run:reject │
│  │                                                                   │
│  ├── 上下文命令 (threadContextCommands.ts)                             │
│  │   └── thread:search, thread:list_context_refs                    │
│  │                                                                   │
│  ├── 工具命令 (toolCommand.ts)                                        │
│  │   └── tool:execute, tool:catalog                                 │
│  │                                                                   │
│  ├── 记忆命令 (memoryCommand.ts)                                      │
│  │   └── memory:search, memory:write, memory:delete                 │
│  │                                                                   │
│  ├── 地图命令 (mapCommands.ts)                                        │
│  │   └── map:scene:*, map:layer:*, map:feature:*                    │
│  │                                                                   │
│  ├── 自动化命令 (automationCommands.ts)                               │
│  │   └── automation:list, automation:trigger                        │
│  │                                                                   │
│  ├── 决策命令 (decisionCommand.ts)                                    │
│  │   └── decision:submit                                            │
│  │                                                                   │
│  ├── 核心命令 (coreCommands.ts)                                       │
│  │   └── subscribe, unsubscribe, keepalive                          │
│  │                                                                   │
│  ├── 控制命令 (controlCommands.ts)                                    │
│  │   └── control:*                                                  │
│  │                                                                   │
│  ├── 使用量 (usageCommands.ts)                                        │
│  ├── 工作区 (workspaceCommands.ts)                                    │
│  ├── 模型选择 (modelSelectors.ts)                                     │
│  ├── 运行时配置 (runtimeConfig.ts)                                    │
│  └── 安全性 (security.ts → registerWsAuthorizationPolicies)          │
│                                                                      │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ 每条命令注册项必须包含:                                        │   │
│  │ • type (共享协议枚举)                                          │   │
│  │ • payloadSchema (Zod .strict())                              │   │
│  │ • auth: required | optional                                  │   │
│  │ • csrf: boolean (变更命令=true)                               │   │
│  │ • policy: { object, action, resourceResolver }               │   │
│  │ • handler(parsedPayload, deps, connContext)                  │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  Startup Guard: commandsWithoutAuthorization() → throw Error         │
└──────────────────────────────────────────────────────────────────────┘
```

### 7.3 传输层协议分工

```
┌──────────────────────────────────────────────────────────────────────┐
│                    传输层协议分工 (AGENTS.md §5.4)                      │
│                                                                      │
│  ┌─────────────────────────┐    ┌──────────────────────────────┐    │
│  │  HTTP 数据面             │    │  WebSocket 控制面             │    │
│  │                         │    │                              │    │
│  │  ✓ 认证 (auth/*)        │    │  ✓ 实时运行控制              │    │
│  │  ✓ 健康检查             │    │  ✓ 流式状态推送              │    │
│  │  ✓ 文件上传/下载        │    │  ✓ 审批交互                  │    │
│  │  ✓ 可分页查询           │    │  ✓ 订阅管理                  │    │
│  │  ✓ 可缓存查询           │    │  ✓ 短命令 (低延迟)           │    │
│  │  ✓ Blob 下载            │    │  ✓ 连接级上下文              │    │
│  │  ✓ 指标暴露             │    │                              │    │
│  │                         │    │  ✗ 不传输大文件             │    │
│  │  requestJson<T>()       │    │    (使用 contentRef SHA256)  │    │
│  │  requestFormJson<T>()   │    │                              │    │
│  │  超时: 30s / 120s       │    │  requestControl<T>()         │    │
│  │                         │    │  超时: 45s (WS 超时)         │    │
│  └─────────────────────────┘    └──────────────────────────────┘    │
│                                                                      │
│  共享层: CSRF 令牌注入 · 错误格式化 · Zod Schema 校验                  │
│  禁止: 组件直接 new WebSocket() — 必须通过统一 transport              │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 八、工具系统架构

### 8.1 ToolProvider 注册与执行流

```
┌──────────────────────────────────────────────────────────────────────┐
│                    工具系统 — 从注册到执行                              │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 1. 发现 (discoverAndLoad)                                    │    │
│  │    • 扫描 server/src/tools/*/manifest.json                   │    │
│  │    • ENABLED_TOOL_PROVIDERS 环境变量 allowlist                │    │
│  │    • 依赖缺失 → 标记不可用 (DebugPage 显示原因)               │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 2. 注册 (ToolRegistry)                                       │    │
│  │    • Provider ID 全局唯一 → 重复抛错                          │    │
│  │    • tools() → ToolDef[] (name, schema, handler, tags)       │    │
│  │    • 跨语言工具: ToolContractManifest (JSON Schema 中介)     │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 3. 契约校验 (validateWorkerContracts)                         │    │
│  │    • 启动时拉取 Worker /tools/catalog                         │    │
│  │    • 校验: 工具名 · schema hash · timeout · valueRef         │    │
│  │    • 漂移 → 直接失败 (不降级为不可用)                          │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 4. 执行 (ToolExecutionCoordinator)                            │    │
│  │    • Plan Mode: 仅允许只读工具 + enter_plan_mode              │    │
│  │    • 工具调用 → validate_tool_definition()                    │    │
│  │    • 参数 → Zod schema 校验 → handler(params)                 │    │
│  │    • 结果 → valueRef 写入黑板                                  │    │
│  │    • 失败 → 硬失败 (不 fallback 成功文案)                      │    │
│  └──────────────────────────┬──────────────────────────────────┘    │
│                             │                                       │
│                             ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 5. 持久化 (resultPersistence)                                 │    │
│  │    • displaySurfaces 声明显式 → 前端展示意图                   │    │
│  │    • Artifact 注册 → 地图/map_app/download                    │    │
│  │    • 审计: tool_executions 指标 + traceId 日志                 │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### 8.2 工具目录 (17 个 Provider)

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      17 个 ToolProvider 目录                               │
├────────────────────┬──────────┬──────────┬──────────┬───────────────────┤
│ Provider           │ 工具数   │ 语言     │ 类型     │ 关键能力           │
├────────────────────┼──────────┼──────────┼──────────┼───────────────────┤
│ meteorology        │ 18       │ TS→Py   │ 科学计算  │ 栅格读取/雷达/预报  │
│ spatial            │ 6        │ TS      │ GIS      │ 空间查询/缓冲区     │
│ spatialAnalysis    │ 3        │ TS→Py   │ 科学计算  │ 第三方气象算法      │
│ layerList          │ 2        │ TS      │ GIS      │ 图层目录            │
│ layerQuery         │ 3        │ TS      │ GIS      │ 要素查询            │
│ layerCreate        │ 2        │ TS      │ GIS      │ 图层创建            │
│ mapExport          │ 2        │ TS      │ 地图     │ PNG/PDF 导出        │
│ geocode            │ 2        │ TS→外部 │ 地理编码  │ 地址↔坐标          │
│ publicWeather      │ 3        │ TS→外部 │ 气象     │ Open-Meteo API     │
│ chart              │ 1        │ TS      │ 可视化    │ ECharts 图表        │
│ media              │ 2        │ TS      │ 媒体     │ 图片/视频处理       │
│ memory             │ 3        │ TS      │ 记忆     │ 搜索/写入/删除      │
│ plan               │ 2        │ TS      │ 规划     │ 计划模式入口        │
│ developer          │ 4        │ TS      │ 开发     │ 调试/诊断           │
│ routing            │ 2        │ TS      │ 导航     │ 路径规划            │
│ automationExecution│ 1        │ TS      │ 自动化    │ 触发自动化工作流    │
│ scheduledWakeUp    │ 1        │ TS      │ 定时     │ 定时唤醒            │
└────────────────────┴──────────┴──────────┴──────────┴───────────────────┘
```

### 8.3 ValueRef 黑板流

```
┌──────────────────────────────────────────────────────────────────────┐
│                    ValueRef 黑板 — 数据引用流                          │
│                                                                      │
│  Tool A 产出                              Tool B 消费                │
│  ┌──────────────────┐                    ┌──────────────────┐       │
│  │ result.valueRefs │                    │ params.valueRef  │       │
│  │ = [{             │                    │ = "ref_abc123"   │       │
│  │   refId: "r1",   │──▶ 运行时黑板 ──▶  │                  │       │
│  │   type: "bbox",  │    (Run 状态中)     │ 解析 → 获取bbox  │       │
│  │   uri: "...",    │                    │ → 空间裁剪       │       │
│  │   metadata: {...}│                    │                  │       │
│  │ }]               │                    │ 未知 ref → 失败  │       │
│  └──────────────────┘                    └──────────────────┘       │
│                                                                      │
│  引用类型:                                                            │
│  ┌──────────────────┬────────────────────────────────────────────┐  │
│  │ variable_ref     │ 变量名、维度信息                            │  │
│  │ time_index_ref   │ 时间维度索引 (时序分析选时次)               │  │
│  │ level_index_ref  │ 层级维度索引 (垂直剖面)                     │  │
│  │ bbox_ref         │ 边界框坐标 (空间裁剪)                       │  │
│  │ threshold_ref    │ 阈值定义 (阈值区域提取)                     │  │
│  │ sequence_ref     │ 文件序列信息 (临近预报)                     │  │
│  │ nowcast_analysis_ref│ 临近预报分析结果                         │  │
│  │ forecast_text_ref│ 预报文本 (报告生成)                         │  │
│  │ nowcast_map_candidate_ref│ 候选时次 (栅格渲染)                 │  │
│  └──────────────────┴────────────────────────────────────────────┘  │
│                                                                      │
│  规则:                                                                │
│  • 同一 Thread 的历史 Run 的 valueRef 对后续 Run 可见                 │
│  • 模型不得直接复制原始值 — 必须通过工具解析 ref                       │
│  • 遇到未知 refId → 硬失败 (禁止猜测或跳过)                           │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 九、Agent 运行时架构

### 9.1 运行时核心状态机

```
┌──────────────────────────────────────────────────────────────────────┐
│                    Agent Run 状态机                                    │
│                                                                      │
│                         ┌──────────┐                                 │
│                         │ pending  │                                 │
│                         └────┬─────┘                                 │
│                              │ runTaskManager.queueRun()             │
│                              ▼                                       │
│                         ┌──────────┐                                 │
│                    ┌───▶│ running  │◀──┐                             │
│                    │    └────┬─────┘   │                             │
│                    │         │         │                             │
│                    │         │ 工具触发审批                           │
│                    │         ▼         │                             │
│                    │    ┌────────────┐ │                             │
│                    │    │ waiting_   │ │                             │
│                    │    │ approval   │─┘ (用户拒绝 → 继续)           │
│                    │    └─────┬──────┘                               │
│                    │          │ 用户批准                              │
│                    │          ▼                                      │
│                    │    ┌────────────┐                               │
│                    │    │ running    │ (恢复 SDK 状态)               │
│                    │    │ (continued)│                               │
│                    │    └─────┬──────┘                               │
│                    │          │                                      │
│                    │          ▼                                      │
│                    │    ┌──────────┐     ┌──────────┐               │
│                    └────│completed │     │  failed  │               │
│                         └──────────┘     └──────────┘               │
│                                                                      │
│  恢复校验 (3 项检查):                                                 │
│  1. Runtime config digest 匹配                                       │
│  2. SDK 版本匹配                                                      │
│  3. State schema 版本匹配                                            │
│  任何不匹配 → 拒绝恢复 (禁止静默降级)                                  │
└──────────────────────────────────────────────────────────────────────┘
```

### 9.2 上下文管理规则

```
┌──────────────────────────────────────────────────────────────────────┐
│              上下文管理 — AGENTS.md §6.2 硬约束                         │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │ 规则 1: 禁止自动注入历史                                      │    │
│  │ 历史 Run 的日志/event/transcript 不得被运行时扫描并静默注入    │    │
│  │ 只能通过: (a) 显式 Compaction (b) 模型主动调用上下文工具       │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ 规则 2: 默认不可见                                            │    │
│  │ Supervisor 系统提示词可声明"存在索引化历史上下文"              │    │
│  │ 但不能默认注入具体的历史 fact/artifact/坐标/图层 key           │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ 规则 3: 当前 Run 隔离                                          │    │
│  │ 当前 Run 产出的数据不得在同一 Run 中作为"历史线程上下文"注入   │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ 规则 4: valueRef 是唯一的数据流                                │    │
│  │ 工具产出值必须通过 valueRef 流转。模型禁止直接复制原始值       │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ 规则 5: 恢复校验                                              │    │
│  │ config digest + SDK 版本 + state schema → 全部匹配            │    │
│  ├─────────────────────────────────────────────────────────────┤    │
│  │ 规则 6: 硬失败                                                │    │
│  │ Guardrail/模型错误/工具错误/schema 错误 → 明确失败原因         │    │
│  │ 禁止: fallback 成功文案 · 合成 artifact · 兼容 hack           │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### 9.3 Plan Mode 边界

```
┌──────────────────────────────────────────────────────────────────────┐
│                     Plan Mode — 硬运行时边界                           │
│                                                                      │
│  进入 plan mode                                                       │
│       │                                                              │
│       ▼                                                              │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  ToolExecutionCoordinator 强制限制                            │    │
│  │                                                               │    │
│  │  ✅ 允许:                                                     │    │
│  │    • 所有只读工具 (isReadOnly: true)                          │    │
│  │    • enter_plan_mode                                         │    │
│  │    • request_clarification                                   │    │
│  │    • submit_agent_workflow                                   │    │
│  │                                                               │    │
│  │  ❌ 拒绝:                                                     │    │
│  │    • 一切其他工具调用 → 明确错误                               │    │
│  └─────────────────────────────────────────────────────────────┘    │
│       │                                                              │
│       ▼                                                              │
│  必须通过 request_clarification 或 submit_agent_workflow 结束         │
│  submit_agent_workflow 仅在用户批准后才退出 plan mode 执行步骤         │
│  否则 Run 失败                                                        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 十、安全纵深防御

### 10.1 防御层次

```
┌──────────────────────────────────────────────────────────────────────┐
│                    安全纵深防御 — 8 层体系                              │
│                                                                      │
│   ┌────────────────────────────────────────────────────────────────┐ │
│   │  Layer 1: 传输安全                                              │ │
│   │  HTTPS + WSS (生产 Nginx 终止 TLS)                              │ │
│   │  ═══════════════════════════════════════════                    │ │
│   │  Layer 2: 认证 (Better Auth)                                    │ │
│   │  email/password + session token · 12h 过期 · 1h 续期            │ │
│   │  ═══════════════════════════════════════════                    │ │
│   │  Layer 3: 授权 (Casbin RBAC)                                    │ │
│   │  deny-by-default · workspace 隔离 · 4 角色                      │ │
│   │  ═══════════════════════════════════════════                    │ │
│   │  Layer 4: CSRF 防护                                             │ │
│   │  x-geoforge-csrf header (HMAC 派生会话级令牌)                   │ │
│   │  ═══════════════════════════════════════════                    │ │
│   │  Layer 5: 限速控制                                              │ │
│   │  HTTP 双级 (Auth 10/min + API 120/min)                          │ │
│   │  WS per-connection per-command                                  │ │
│   │  ═══════════════════════════════════════════                    │ │
│   │  Layer 6: 输入校验                                              │ │
│   │  Zod .strict() (TS) + Pydantic extra="forbid" (Python)          │ │
│   │  ═══════════════════════════════════════════                    │ │
│   │  Layer 7: Worker 认证 + 沙箱                                    │ │
│   │  HMAC-SHA256 (60s TTL + nonce 防重放 + bodyHash 防篡改)         │ │
│   │  路径遍历防护 · 空字节检测 · 临时目录隔离                        │ │
│   │  ═══════════════════════════════════════════                    │ │
│   │  Layer 8: 日志脱敏 + 优雅关闭                                    │ │
│   │  29 路径模式 · key 名检测 · token/secret 正则 · SIGTERM→503     │ │
│   └────────────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

### 10.2 Worker HMAC 认证协议

```
┌──────────────────────────────────────────────────────────────────────┐
│                Worker HMAC-SHA256 认证协议                             │
│                                                                      │
│  Node.js (调用方)                         Python Worker (验证方)      │
│  ┌──────────────────┐                    ┌──────────────────┐       │
│  │ 1. 生成 nonce    │                    │                  │       │
│  │    (UUID v4)     │                    │                  │       │
│  │ 2. 计算 bodyHash │                    │                  │       │
│  │    SHA256(body)  │                    │                  │       │
│  │ 3. 构造 payload: │                    │                  │       │
│  │    nonce +       │                    │                  │       │
│  │    timestamp +   │──── HTTP POST ──▶  │                  │       │
│  │    toolName +    │                    │ 4. 校验 TTL     │       │
│  │    bodyHash      │                    │    (60s ± 30s)  │       │
│  │ 4. 签名:         │                    │ 5. 校验 nonce   │       │
│  │    HMAC-SHA256   │                    │    (防重放缓存)  │       │
│  │    (secret,      │                    │ 6. 校验 bodyHash│       │
│  │     payload)     │                    │ 7. 校验签名     │       │
│  │                  │                    │    hmac.compare │       │
│  │                  │◀── 200/403 ────────│    _digest()    │       │
│  └──────────────────┘                    └──────────────────┘       │
│                                                                      │
│  安全特性:                                                            │
│  • hmac.compare_digest 防时序攻击                                     │
│  • nonce 缓存 10,000 条 · LRU 淘汰                                   │
│  • bodyHash 绑定签名到请求体 (防篡改)                                  │
│  • 工具名绑定 (防跨工具令牌重用)                                       │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 十一、前端架构

### 11.1 组件树与数据流

```
┌──────────────────────────────────────────────────────────────────────┐
│                    前端架构 — 组件树 + 数据流                           │
│                                                                      │
│  index.html                                                           │
│  └── AppLoader.tsx (启动引导: CSRF 令牌 + Auth 检查)                   │
│       └── QueryProvider.tsx (TanStack Query)                          │
│            └── AppShell.tsx (889 行 — 装配层)                          │
│                 │                                                    │
│                 ├── 路由 (react-router-dom)                            │
│                 │   ├── / → WorkspaceShell                            │
│                 │   │   ├── Sidebar (会话/线程列表)                    │
│                 │   │   ├── MapPanel (MapLibre GL 地图)               │
│                 │   │   ├── ChatPanel (对话面板)                       │
│                 │   │   │   ├── Composer (输入框)                     │
│                 │   │   │   └── ConversationTimeline (消息列表)       │
│                 │   │   ├── Inspector (属性检查器)                     │
│                 │   │   └── LayerManager (图层管理)                   │
│                 │   └── /debug → DebugPage (调试面板)                  │
│                 │                                                    │
│                 └── 状态层 (Zustand 8 Slices)                          │
│                     ├── authStore        (认证状态)                   │
│                     ├── workspaceStore   (工作区导航)                  │
│                     ├── sessionStore     (会话指针)                    │
│                     ├── runStore         (运行状态 + streaming)        │
│                     ├── resourceStore    (图层/底图/上传)              │
│                     ├── uiStore          (UI 临时状态)                │
│                     ├── connectionStore  (WS 连接)                    │
│                     └── modelConnectionStore (模型连接状态)            │
│                                                                      │
│  数据获取:                                                            │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐   │
│  │ TanStack Query   │  │ Zustand          │  │ react-hook-form  │   │
│  │ (HTTP 查询缓存)   │  │ (实时 streaming) │  │ + Zod            │   │
│  │                  │  │                  │  │ (表单状态)        │   │
│  │ auth/me          │  │ run events       │  │ login form       │   │
│  │ layer list       │  │ timeline status  │  │ admin forms      │   │
│  │ dataset list     │  │ connection state │  │ tool forms       │   │
│  │ admin resources  │  │ workspace mode   │  │ runtime config   │   │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘   │
│                                                                      │
│  性能模式 (默认行为):                                                  │
│  • MapLibre + DebugPage → import() 动态加载                           │
│  • 地图 → rAF + requestIdleCallback 后才初始化                        │
│  • 高频事件 → useDeferredValue 避免阻塞                                │
│  • 长列表 → @tanstack/react-virtual                                  │
│  • 表格 → @tanstack/react-table                                      │
│  • SVG 滤镜 → requestIdleCallback                                    │
│  • 动画遵从 prefers-reduced-motion                                    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 十二、科学计算架构

### 12.1 双后端原则

```
┌──────────────────────────────────────────────────────────────────────┐
│               气象数据双后端原则 (AGENTS.md §7.1)                       │
│                                                                      │
│  ┌─────────────────────────────┐  ┌─────────────────────────────┐   │
│  │  xarray + netCDF4/cfgrib    │  │  rasterio + GDAL            │   │
│  │  ───────────────────────    │  │  ───────────────────────    │   │
│  │  科学语义层                  │  │  栅格地图执行层              │   │
│  │                             │  │                             │   │
│  │  ✓ 变量名/维度/时间/层级     │  │  ✓ CRS/边界/子数据集        │   │
│  │  ✓ 单位/缺失值/统计量       │  │  ✓ 重投影/降采样            │   │
│  │  ✓ 科学事实源               │  │  ✓ PNG 渲染                 │   │
│  │                             │  │  ✓ 地图事实源               │   │
│  │                             │  │                             │   │
│  │  ✗ 不要做地图重投影          │  │  ✗ 不要获取变量统计          │   │
│  └─────────────────────────────┘  └─────────────────────────────┘   │
│                                                                      │
│  库加载策略 (§3.4): 所有重量级库惰性导入                                │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ def _np():      import numpy as np;      return np           │   │
│  │ def _xr():      import xarray as xr;     return xr           │   │
│  │ def _rasterio():import rasterio;          return rasterio    │   │
│  │ def _gp():      import geopandas as gpd; return gpd          │   │
│  │ def _scipy():   import scipy;            return scipy        │   │
│  │ def _plt():     import matplotlib.pyplot as plt; return plt  │   │
│  │                                                              │   │
│  │ 目的: import gis_meteorology < 10ms                          │   │
│  │ 库只在首次实际调用时才加载                                     │   │
│  └──────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 十三、部署架构

```
┌──────────────────────────────────────────────────────────────────────┐
│                        部署架构                                       │
│                                                                      │
│  生产部署 (Linux)                  开发环境 (Windows / Linux)         │
│  ┌──────────────────┐             ┌──────────────────────────────┐  │
│  │  Nginx (TLS 终止) │             │  dev.ps1 / dev.sh             │  │
│  │  ─────────────── │             │  ──────────────────────────── │  │
│  │  → /api/* → :8010│             │  concurrently 启动:           │  │
│  │  → /ws   → :8010 │             │  ├── PostGIS (Docker)         │  │
│  │  → /*    → :5173 │             │  ├── Server   :8010           │  │
│  └────────┬─────────┘             │  ├── Web      :5173           │  │
│           │                       │  ├── Worker   :8012           │  │
│     ┌─────┼─────────────────┐     │  └── Supervisor TUI           │  │
│     │     │                 │     └──────────────────────────────┘  │
│     ▼     ▼                 ▼                                       │
│  ┌────────┐ ┌────────┐ ┌────────┐                                   │
│  │ Node.js│ │ React  │ │ Python │                                   │
│  │ :8010  │ │ :5173  │ │ :8012  │                                   │
│  └───┬────┘ └────────┘ └───┬────┘                                   │
│      │                     │                                        │
│      ▼                     │                                        │
│  ┌──────────────┐          │                                        │
│  │ PostgreSQL   │          │                                        │
│  │ + PostGIS    │◄─────────┘ (gis_meteorology reads)               │
│  │ + Martin     │                                                   │
│  │ (矢量瓦片)    │                                                   │
│  └──────────────┘                                                   │
│                                                                      │
│  Docker Compose (仅 PostGIS):                                        │
│  infra/compose/docker-compose.dev.yml                                │
│  infra/compose/docker-compose.prod.yml                               │
│                                                                      │
│  本机运维 TUI (§9.4):                                                 │
│  • 进程状态唯一事实源 = 监督后台内存状态                                │
│  • TUI 不注册为 Agent Tool / HTTP/WS 控制面                           │
│  • 退出 TUI ≠ 停止服务 · 停止全部 = 危险操作 + 确认                    │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 十四、测试与可观测性

### 14.1 测试分布

```
┌──────────────────────────────────────────────────────────────────────┐
│                        测试覆盖矩阵                                    │
├─────────────────────┬──────────┬──────────┬─────────────────────────┤
│ 模块                 │ 测试文件  │ 覆盖状态  │ 备注                    │
├─────────────────────┼──────────┼──────────┼─────────────────────────┤
│ server/src/agent/   │ 16       │ ████░░ 70%│ 11 子模块未测试          │
│ server/src/store/   │ 16       │ ████░░ 65%│ 仓储单测充足;缺集成测试   │
│ server/src/security/│ 6        │ █████░ 85%│ 缺 rateLimiter 测试      │
│ server/src/tools/   │ 7        │ ████░░ 70%│ 契约校验覆盖好            │
│ server/src/ws/      │ 3        │ ███░░░ 50%│ 仅集成测试;缺命令单测     │
│ server/src/routes/  │ 3        │ ███░░░ 43%│ 4/7 路由未测试            │
│ server/src/automations/│ 7     │ █████░ 90%│ 覆盖完整                  │
│ server/src/其他      │ 12       │ ████░░ 60%│ model/map/gis/memory     │
│ apps/web/src/       │ 5        │ █░░░░░ 10%│ 仅 5 个快照测试           │
│ apps/worker/tests/  │ 5        │ ████░░ 60%│ auth + 科学链测试好       │
│ packages/gis-       │ 0        │ ░░░░░░ 0% │ ⚠️ 零测试                │
│ meteorology/        │          │          │                          │
│ tests/e2e/          │ 2        │ ██░░░░ 30%│ 缺 run 生命周期/审批      │
├─────────────────────┼──────────┼──────────┼─────────────────────────┤
│ 总计                 │ ~80      │ ████░░ 55%│                          │
└─────────────────────┴──────────┴──────────┴─────────────────────────┘
```

### 14.2 可观测性堆栈

```
┌──────────────────────────────────────────────────────────────────────┐
│                    可观测性三柱                                        │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Logging (Pino 结构化日志)                                    │    │
│  │  ─────────────────────────────────────────────────────────── │    │
│  │  • AsyncLocalStorage → traceId 自动生成 (12 字符)             │    │
│  │  • traceId 传播: HTTP → WS → Worker (x-geoforge-trace-id)    │    │
│  │  • 日志级别: trace / debug / info / warn / error             │    │
│  │  • 脱敏: 29 路径模式 + key 名检测 + Bearer/Basic/sk- 正则    │    │
│  │  • 30+ 文件使用 logger (零 console.log)                      │    │
│  │  • crashDump() · audit() · summary() 辅助函数               │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Metrics (Prometheus — 17 族指标)                             │    │
│  │  ─────────────────────────────────────────────────────────── │    │
│  │  HTTP:   请求计数 (method/path/status) + 延迟直方图           │    │
│  │  WS:     活跃连接 (Gauge) + 消息计数 (type/direction)        │    │
│  │  Tools:  执行计数 (tool/status/language) + 延迟直方图         │    │
│  │  Worker: 请求计数 + 延迟直方图                                │    │
│  │  Automation: 运行计数 + 节点执行计数 + 延迟直方图              │    │
│  │  JSONL:  队列深度 + flush 延迟 + 损坏计数                    │    │
│  │  Lock:   实例锁持有状态                                       │    │
│  │  Mutation: 队列深度 + 失败计数                                │    │
│  │  Rate Limit: 命中计数 (scope/action)                         │    │
│  │  GET /metrics → OpenMetrics 格式                              │    │
│  └─────────────────────────────────────────────────────────────┘    │
│                                                                      │
│  ┌─────────────────────────────────────────────────────────────┐    │
│  │  Tracing (Agent Tracing)                                      │    │
│  │  ─────────────────────────────────────────────────────────── │    │
│  │  • setTracingDisabled(true) — 全局开关 (禁止外部导出)          │    │
│  │  • LocalAgentTracing — 仅本地结构化处理                        │    │
│  │  • Agent 数据不得发送到外部 tracing 后端                       │    │
│  │  • 不记录模型正文或工具输入输出                                 │    │
│  └─────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────┘
```

### 14.3 架构守卫测试 (1277 行)

`server/src/architecture.test.ts` 作为"活规范"持续验证 40+ 条结构不变量：

```
┌──────────────────────────────────────────────────────────────────────┐
│           架构守卫测试 — 验证的结构不变量 (部分列表)                     │
├──────────────────────────────────────────────────────────────────────┤
│  ✅ 共享协议 schema 模块化 (7 个领域文件)                              │
│  ✅ Drizzle schema ↔ SQL baseline FK 对齐 (15 个 FK)                  │
│  ✅ 旧模式移除 (finalResponse / message_frame / as any)               │
│  ✅ 旧产品名 + Windows 绝对路径禁止                                    │
│  ✅ Windows 开发栈绑定 loopback (127.0.0.1)                           │
│  ✅ 远程终端依赖已移除 (node-pty / @xterm / pm2)                      │
│  ✅ PlatformPersistenceFacade 是 Facade 非 God Object                  │
│  ✅ 跨资源操作包裹在事务中 (4 个生命周期方法)                           │
│  ✅ 窄持久化端口注入 (14 个接口)                                       │
│  ✅ 资源所有权拆分 (conversation / map / layer / feature)             │
│  ✅ 自动化按 definition/schedule/run 拆分                             │
│  ✅ Artifact 发布是显式跨资源事务                                      │
│  ✅ 气象数据集/任务分离仓储                                            │
│  ✅ 废弃 JSONL 文件已移除 (5 个路径)                                   │
│  ✅ PostgreSQL 建议锁 (非 lockfile)                                    │
│  ✅ WS handler 无 switch — 全注册表驱动                                │
│  ✅ WS 授权挂载在命令注册表                                            │
│  ✅ ToolRegistry 在组合根中构建 (非全局单例)                           │
│  ✅ AppContainer 是唯一装配点 (main.ts 不构建大型服务)                  │
│  ✅ Env 仅在组合根中读取 (12 个文件验证)                               │
│  ✅ 气象路由委托给 Store                                               │
│  ✅ 工具定义 DSL 分离                                                  │
│  ✅ 临近预报区划无关 (无硬编码杭州)                                     │
│  ✅ 安全管理员在注入服务后                                              │
│  ✅ BetterAuth 委托给事务化身份服务                                    │
│  ✅ 全生产代码强制结构化日志 (零 console.log)                          │
│  ✅ Worker sidecar 薄层 (23 个 token 验证)                             │
│  ✅ Agent 运行时通过 runtimePorts 接口访问存储                          │
│  ✅ 短临预报编排在通用 Automation 边界                                 │
│  ✅ 对话从 PostgreSQL 重放                                             │
│  ✅ 线程投影重建 · Run 索引分页                                        │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 十五、审查发现汇总

### 15.1 按严重性排列

```
┌──────┬──────────────────────────────────────────────────────────────────┐
│ 严重  │ 发现                                                              │
├──────┼──────────────────────────────────────────────────────────────────┤
│      │                                                                    │
│  🔴  │ C1. gis-meteorology 科学计算包零测试                               │
│      │     packages/gis-meteorology/ — 7 核心模块 + 3 适配器, 无测试文件  │
│      │     AGENTS.md §10: "每个 public 函数一个 pytest"                   │
│      │                                                                    │
├──────┼──────────────────────────────────────────────────────────────────┤
│      │                                                                    │
│      │ H1. PlatformPersistenceFacade 拥有 8+ 资源类型                      │
│      │     server/src/store/platformPersistenceFacade.ts (571 行)         │
│      │     AGENTS.md §0 规则 3: "三类以上资源的写路径需要重新设计"         │
│      │                                                                    │
│      │ H2. Agent 运行时 11 子模块未测试                                     │
│      │     runtimeApprovals / runtimeSandbox / runtimeOutputGuardrails    │
│      │     subAgentToolFactory / handoffAgentFactory / etc.              │
│      │                                                                    │
│      │ H3. 前端测试覆盖极薄 (仅 5 文件)                                     │
│      │     apps/web/src/__tests__/ — AppShell (889行) 等核心未测试         │
│      │                                                                    │
│      │ H4. Session Cookie 属性未显式固定                                   │
│      │     server/src/security/authService.ts:82-85                       │
│      │     应显式设置 secure/httpOnly/sameSite                             │
│      │                                                                    │
│      │ H5. 路由处理器 4/7 未测试                                            │
│      │     artifacts / files / layers / map routes                        │
│      │                                                                    │
│      │ H6. App 容器 (组合根) 未测试                                         │
│      │     server/src/app/container.ts:263 行, 无测试                      │
│      │                                                                    │
│      │ H7. 无数据库集成测试                                                  │
│      │     server/src/store/postgres/ — 仅 1 个集成测试                    │
│      │                                                                    │
│      │ H8. E2E 测试缺 Run 生命周期 + 审批流程                                │
│      │     tests/e2e/ — 仅 2 文件 8 测试                                   │
│      │                                                                    │
│  🟠  ├──────────────────────────────────────────────────────────────────┤
│      │                                                                    │
│      │ M1. WS 客户端模块级可变单例                                          │
│      │     apps/web/src/ws/client.ts:200                                  │
│      │     AGENTS.md §2.4: "禁止新增模块级可变单例"                         │
│      │                                                                    │
│      │ M2. 前端 3 处单例/可变状态                                            │
│      │     defaultRendererRegistry / currentAuth / QueryClient            │
│      │                                                                    │
│      │ M3. 无账户锁定机制                                                    │
│      │     server/src/security/authService.ts — 仅依赖限流防暴力破解        │
│      │                                                                    │
│      │ M4. 限流器仅内存实现 — 多实例下失效                                    │
│      │     server/src/security/rateLimiter.ts:2 — 注释已标注              │
│      │                                                                    │
│      │ M5. WS 消息无显式大小限制                                             │
│      │     server/src/ws/handler.ts:53 — 缺 maxPayload                    │
│      │                                                                    │
│      │ M6. service.py 与 readers.py 函数重复 (3 个)                         │
│      │     AGENTS.md §3.3 明确禁止                                         │
│      │                                                                    │
│      │ M7. Python 惰性导入违规 (5 处)                                       │
│      │     radar.py / service.py / 3 adapter.py                           │
│      │     AGENTS.md §3.4: 重量级库必须惰性加载                              │
│      │                                                                    │
│      │ M8. getEnv() 模块级单例                                              │
│      │     server/src/framework/env.ts:100-111                            │
│      │                                                                    │
│      │ M9. AppShell.tsx 装配 10+ 控制器 (889 行)                            │
│      │     AGENTS.md §4.3: 应拆出中间装配层                                 │
│      │                                                                    │
│      │ M10. WS handler 直接实例化 RuntimeFileStore                           │
│      │      server/src/ws/handler.ts:33 — 应通过 DI                       │
│      │                                                                    │
│      │ M11. runtime.ts (1205行) + service.py (1480行) 超复杂度预算          │
│      │      AGENTS.md §1.2: 多个复杂度信号触发                               │
│      │                                                                    │
│  🟡  ├──────────────────────────────────────────────────────────────────┤
│      │                                                                    │
│      │ L1. MapTileGateway file:// URL 暴露                                 │
│      │ L2. 5 Worker Python 文件缺文件头                                     │
│      │ L3. 2 renderer 文件有重复文件头                                      │
│      │ L4. Web app 未使用 .js 扩展名导入                                    │
│      │ L5. Admin API 返回 404 而非 403                                     │
│      │ L6. Auth 限流 10/min 可能过于严格                                    │
│      │ L7. Nonce 缓存溢出理论风险 (10K/60s 远超实际负载)                    │
│      │ L8. 路径沙箱 symlink 边界情况                                        │
│      │ L9. Worker 健康检查每次导入所有科学包                                 │
│      │ L10. 默认 TRUSTED_ORIGINS 含 localhost                              │
│      │ L11. Prometheus 指标 18 个模块级 new() (行业惯例, 可接受)             │
│      │ L12. runStore/threadStore 跨模块导入对话/文件工具                    │
│      │ L13. ESM 命名不一致 (Bundler vs NodeNext)                            │
│      │ L14. E2E globalSetup 硬编码凭据                                      │
│      │ L15. 无压力/性能测试                                                  │
│      │                                                                    │
└──────┴──────────────────────────────────────────────────────────────────┘
```

### 15.2 架构亮点 (值得肯定的设计决策)

```
┌──────────────────────────────────────────────────────────────────────┐
│                         架构亮点 Top 10                                │
│                                                                      │
│  1. 🛡️ 自动化架构守卫 (1277 行 living spec)                            │
│     架构测试持续验证 40+ 条结构不变量 — 工业级质量实践                  │
│                                                                      │
│  2. 🏗️ 五平面分层 + 显式依赖方向                                        │
│     治理/编排/执行/数据/体验 — 每层有明确的接口和 schema                │
│                                                                      │
│  3. 🔒 纵深防御安全体系 (8 层)                                          │
│     TLS → Auth → RBAC → CSRF → Rate → Validate → Sandbox → Log      │
│                                                                      │
│  4. 📦 资源所有权严格拆分                                                │
│     Session/Thread/Run/Artifact/Dataset/Layer/Tool/Config/Audit      │
│     各归其 Store, 跨资源写包裹在事务中                                  │
│                                                                      │
│  5. 🔌 窄持久化端口                                                     │
│     Agent 运行时通过 runtimePorts 接口访问存储, 不直接导入 Facade       │
│                                                                      │
│  6. 🚫 零 as any · 零 console.log                                      │
│     全生产代码强制 Zod/Pydantic 边界校验 + Pino 结构化日志              │
│                                                                      │
│  7. 🎛️ WS 命令注册表 + 启动时授权守卫                                    │
│     无 switch 语句 · 每个命令必须声明 auth 策略 · 缺失→启动失败         │
│                                                                      │
│  8. 🔄 Worker HMAC 双向认证协议                                         │
│     60s TTL + nonce 防重放 + bodyHash 防篡改 + hmac.compare_digest   │
│                                                                      │
│  9. 📊 17 族 Prometheus 指标 + traceId 全链路传播                       │
│     HTTP/WS/Tools/Worker/Automation/JSONL/Mutation/RateLimit         │
│                                                                      │
│  10. 🧪 ToolRegistry 从全局单例迁移到组合根                               │
│      架构测试验证 — 已解决的已知债务                                    │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

---

## 十六、优先行动计划

### Phase 1 — 立即 (1-2 周)

```
┌────┬───────────────────────────────────────────────────────────────────┐
│ #  │ 行动                                              │ 类型           │
├────┼───────────────────────────────────────────────────┼────────────────┤
│ 1  │ 为 gis_meteorology/readers.py + service.py       │ 测试           │
│    │ 添加 pytest (使用小内联 NetCDF fixture)            │                │
│ 2  │ Session cookie 显式设置 secure/httpOnly/sameSite  │ 安全           │
│ 3  │ 删除 service.py 中 3 个重复函数, 委托给 readers.py│ 代码质量        │
│ 4  │ 修复 Python 惰性导入 (radar.py, service.py,      │ 代码质量        │
│    │ 3 adapter.py)                                    │                │
│ 5  │ 为 routes/artifacts, files, layers, map          │ 测试           │
│    │ 添加 HTTP 状态码测试                               │                │
└────┴───────────────────────────────────────────────────┴────────────────┘
```

### Phase 2 — 短期 (2-4 周)

```
┌────┬───────────────────────────────────────────────────────────────────┐
│ 6  │ 为 11 个 agent 子模块添加单元测试                  │ 测试           │
│ 7  │ 添加 Run 生命周期 + 审批流程 E2E 测试              │ 测试           │
│ 8  │ 添加账户锁定机制 (N 次失败后临时锁定)               │ 安全           │
│ 9  │ 为 WS 消息添加 maxPayload 限制                     │ 安全           │
│ 10 │ 将 wsClient 单例改为工厂函数 + DI                  │ 架构           │
│ 11 │ 为 postgres/ 仓储添加数据库集成测试                 │ 测试           │
└────┴───────────────────────────────────────────────────┴────────────────┘
```

### Phase 3 — 中期 (1-2 月)

```
┌────┬───────────────────────────────────────────────────────────────────┐
│ 12 │ 拆分 PlatformPersistenceFacade — 缩小为组合 API     │ 架构           │
│ 13 │ 拆分 AppShell.tsx 为 ChatShell/MapShell/           │ 架构           │
│    │ WorkspaceShell                                    │                │
│ 14 │ 替换内存限流器为 Redis 分布式实现                    │ 安全           │
│ 15 │ 扩展前端测试覆盖 (AppShell, hooks, 交互测试)        │ 测试           │
│ 16 │ 修复 ESM .js 扩展名 (web app)                      │ 代码质量        │
│ 17 │ 拆分 runtime.ts (1205行) + service.py (1480行)     │ 代码质量        │
└────┴───────────────────────────────────────────────────┴────────────────┘
```

---

## 附录: 审查团队与方法

| Agent | 角色 | 聚焦领域 | 产出 |
|-------|------|---------|------|
| **Explore Agent 1** | 架构审查 | 系统分层、依赖方向、资源所有权、模块边界、单例检测 | 12 个架构发现 |
| **Explore Agent 2** | 安全审查 | 认证、授权、CSRF、限流、WS 安全、Worker 安全、日志脱敏、SQL 注入 | 21 个安全发现 |
| **Explore Agent 3** | 代码质量审查 | `as any`、`console.log`、单例、文件头、ESM、惰性导入、重复代码、复杂度 | 12 个代码质量发现 |
| **Explore Agent 4** | 测试与可观测性 | 测试覆盖(TS/Python/E2E)、架构守卫、日志合规、指标 | 30+ 测试/可观测性发现 |
| **主会话** | 结构分析 | Glob、Grep、文件统计、架构测试内容审查 | 补充 5 个发现 |

**数据采集**: 100+ 文件读取 · 50+ 次 grep 搜索 · 4 个并行 Agent · 总计 ~400K tokens 审查消耗

---

> 📄 报告生成日期: 2026-07-23  
> 📁 项目: GeoForge (geo-agent-platform) v0.1.0  
> 🔗 规范文件: [AGENTS.md](AGENTS.md) (58KB, 13 章节)  
> 🧪 架构守卫: [architecture.test.ts](server/src/architecture.test.ts) (1277 行, 40+ 不变量)
