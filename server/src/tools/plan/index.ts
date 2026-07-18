import manifest from "./manifest.json" with { type: "json" };
import { enterPlanModeTool, requestClarificationTool, reviseAgentWorkflowTool, submitAgentWorkflowTool } from "./planTools.js";
const provider = { manifest, tools: () => [requestClarificationTool, enterPlanModeTool, submitAgentWorkflowTool, reviseAgentWorkflowTool] };
export default provider;
