# Codex 风格 Agents SDK 运行时基础实施记录

- 日期：2026-08-18
- 对应计划：[`codex-agents-sdk-runtime-refactor-plan.md`](./codex-agents-sdk-runtime-refactor-plan.md)
- 实施范围：WP-00、WP-01 与 SDK 防腐边界基础
- 当前 SDK：`@openai/agents@0.16.1`

## 已完成

1. 修正 Agent 运行时所有权规则：Newmap 持有持久 Run/Turn/Runner segment 控制面，Agents SDK Runner 持有单个 segment 内的模型、工具、handoff 与 Agent-as-tool 微循环。
2. 将 SDK checkpoint 作为 opaque 恢复载荷保存；工具终态改为从公开 `RunState.history` 获取，不再解析 `generatedItems` 等内部 JSON 布局。
3. 将活动 Runner steering 所需的唯一 SDK 内部字段接触收口到 `agentsSdkStateBoundary.ts`，并用架构测试禁止其它模块回流。
4. 固定并校验经过契约测试的 Agents SDK 版本，恢复时继续拒绝跨 SDK 版本和运行配置摘要不一致的 checkpoint。
5. 增加 SDK 边界、steering 幂等、checkpoint、版本和架构守卫测试。
6. 升级依赖与锁文件到 Agents SDK 0.16.1，并保持 DeepSeek、MCP、Sandbox、审批、handoff、Agent-as-tool、并发和恢复链路回归。
7. 调整 Dependency Review：仓库未启用 Dependency Graph/SBOM 时给出明确警告并跳过，不把仓库设置缺失伪装成代码失败；能力可用时仍执行高危依赖门禁。

## 已验证

- Server：137 个测试文件通过；790 个测试通过，4 个环境集成测试按既有条件跳过。
- 全工作区 TypeScript 构建通过。
- 依赖契约测试通过。
- 发布管线测试通过。
- `git diff --check` 通过。

## 仍需后续 Work Package

本记录不表示完整 RFC 已一次完成。Domain Journal、GeoWorldState、持久 Input Mailbox 重构、ToolPlan/Effect Committer、统一审批与 Sandbox policy、Context rollover、Plugin/Hook 和 durable child Run 仍按原计划分阶段实施。

`_originalInput` 当前只允许存在于单一防腐边界。原因是 Agents SDK 0.16.1 的公开 `RunState.addInput()` 在当前同一模型请求的 `callModelInputFilter` 时点无法同时满足“立即模型可见”和“写入当前可恢复 RunState”。后续 Runner segment 化完成后应删除这项临时兼容。
