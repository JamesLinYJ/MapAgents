# Codex 风格 Agents SDK 运行时基础实施记录

- 日期：2026-08-18
- 对应计划：[`codex-agents-sdk-runtime-refactor-plan.md`](./codex-agents-sdk-runtime-refactor-plan.md)
- 实施范围：WP-00 至 WP-04
- 当前 SDK：`@openai/agents@0.16.1`

## 已完成

1. 修正 Agent 运行时所有权规则：Newmap 持有持久 Run/Turn/Runner segment 控制面，Agents SDK Runner 持有单个 segment 内的模型、工具、handoff 与 Agent-as-tool 微循环。
2. 将所有生产 `RunState` 操作收口到 `agent-runtime/sdk/AgentsSdkBridge.ts`；业务代码不再读取 `_originalInput`、`generatedItems` 或 SDK 序列化 JSON 的内部属性。
3. checkpoint 现在保存严格的平台代理 envelope：公开 SDK 序列化字符串保持 opaque，并与 SDK/schema 版本、运行配置、ToolPlan、World revision、input cursor 和 segment ID 一起校验。
4. steering 使用公开 `RunState.addInput()` 和显式 segment rotation；每次模型请求先捕获不可变 StepContext，checkpoint 不再依赖私有字段或时序探测。
5. `CanonicalAgentsSession` 只负责 SDK replay history。canonical transcript 只由公开 stream event、平台工具 ledger 和 executor 终态提交产生，禁止从 Session 反向推导平台事实。
6. 工具终态只在公开 SDK terminal 已被观察、且同一 durable checkpoint 已包含结果后，才从 recovery ledger 中清除。
7. 旧活动 checkpoint 不满足 v6 envelope 契约时由迁移显式失败封口；不做跨版本 best-effort 恢复。
8. 固定并校验经过契约测试的 Agents SDK 0.16.1，保持 DeepSeek、MCP、Sandbox、审批、handoff、Agent-as-tool、steering 和恢复链路回归。

## 已验证

- Server：137 个测试文件通过；790 个测试通过，4 个环境集成测试按既有条件跳过。
- 全工作区 TypeScript 构建通过。
- 依赖契约测试通过。
- 发布管线测试通过。
- `git diff --check` 通过。

## 仍需后续 Work Package

本记录不表示完整 RFC 已一次完成。Domain Journal、GeoWorldState、持久 Input Mailbox 重构、ToolPlan/Effect Committer、统一审批与 Sandbox policy、Context rollover、Plugin/Hook 和 durable child Run 仍按原计划分阶段实施。

WP-04 已删除 `_originalInput` 临时兼容。若活动模型请求期间出现新输入，当前 segment 在公开边界结束，输入通过 `RunState.addInput()` 写入可恢复状态，再启动下一 segment；不会修改 SDK 私有状态，也不会用 Session 镜像充当事实源。
