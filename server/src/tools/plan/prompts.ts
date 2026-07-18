// +-------------------------------------------------------------------------
//
//   地理智能平台 - 计划模式工具提示词
//
//   文件:       prompts.ts
//
//   日期:       2026年06月25日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

// 计划正文通过结构化智能体工作流进入审批和 run state，不写本地计划文件。

export const ENTER_PLAN_MODE_DESCRIPTION = '进入只读探索模式，只允许查询和分析操作，不能修改数据。'

export const REQUEST_CLARIFICATION_DESCRIPTION = '计划模式中请求用户补充目标、范围、数据或输出要求。'

export const REQUEST_CLARIFICATION_PROMPT = `计划模式的本轮对话无法形成可审批计划时，必须使用本工具请求用户补充信息。

使用场景：
- 用户只发送寒暄、测试语句或笼统要求，当前没有可规划目标。
- 用户要求生成计划，但没有说明任务目标。
- 缺少必要范围、数据源、地点、变量、输出格式或审批边界。

使用本工具后，本轮应停止并等待用户补充；不要编造默认目标，不要用普通正文冒充澄清状态。
不要用本工具询问“计划是否可以”，计划审批必须通过 submit_agent_workflow。`

export const ENTER_PLAN_MODE_PROMPT = `在复杂执行前进入只读计划模式，让用户先审阅计划，再批准任何写入或副作用动作。

使用场景：
- 任务包含多个步骤，或存在多个合理实现路线。
- 后续可能调用写文件、导出、导入、生成报告或其他有副作用的工具。
- 需要先检查 GIS 图层、气象数据、源码文件、历史运行或 artifact，才能确定执行方案。
- 用户审批能避免返工或误操作。

进入计划模式后：
- 只能做读取、检查、查询和分析。
- 重要发现用普通 assistant 正文说明，不要塞进“思考过程”。
- todo_write 只能在计划获批后使用，不能在计划模式中使用。
- 缺少目标、范围、数据或输出要求时，必须调用 request_clarification 等待用户补充。
- 计划准备好后，必须调用 submit_agent_workflow，提交结构化智能体工作流供用户审批。
- 计划模式的本轮只能以 request_clarification 或 submit_agent_workflow 结束。`

export const SUBMIT_AGENT_WORKFLOW_DESCRIPTION = '提交结构化智能体工作流并请求用户批准；批准后在同一运行中开始执行。'

export const SUBMIT_AGENT_WORKFLOW_PROMPT = `只在只读计划模式已经形成完整执行计划、需要用户审阅时使用本工具。

智能体工作流使用结构化参数，不写本地计划文件：
- workflow.goal 是面向用户的目标。
- workflow.steps 描述步骤、依赖关系、执行能力和负责人。
- 每个步骤必须包含 stepId、title、kind、toolName、reason、dependsOn；已知参数写入 args。
- 可以并行的步骤使用相同依赖；必须串行的步骤显式依赖前一步。
- 自动化流程作为一个原子步骤执行，kind 使用 automation，toolName 使用 execute_automation。
- 子智能体协作步骤使用 kind: agent，并将其工具名写入 toolName。

不要在以下情况使用：
- 只是简单查询，不需要实现或副作用操作。
- 只想用普通文本询问“这样可以吗”。
- 没有可审批计划，却想继续执行写入或导出动作。`

export const REVISE_AGENT_WORKFLOW_DESCRIPTION = '根据新证据、工具失败或用户引导修订当前智能体工作流。'

export const REVISE_AGENT_WORKFLOW_PROMPT = `当前智能体工作流已经开始执行，但新证据、工具失败或用户中途引导改变了后续路径时使用本工具。

- 必须说明 changeReason，并提交完整的新目标与步骤图。
- 已完成且执行契约未改变的步骤会保留；修改过的步骤会重新进入待执行状态。
- 不得删除仍被其它步骤依赖的步骤，也不得形成循环依赖。
- 调整工作流不是掩盖失败；失败原因必须保留在步骤状态中，并在新路径中明确处理。
- 仅措辞变化且执行路径不变时不要修订。`
