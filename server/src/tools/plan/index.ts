import manifest from "./manifest.json" with { type: "json" };
import { parseToolManifest } from "../../framework/schema.js";
import { enterPlanModeTool, requestClarificationTool, reviseAgentWorkflowTool, submitAgentWorkflowTool } from "./planTools.js";
const provider = { manifest: parseToolManifest(manifest), tools: () => [requestClarificationTool, enterPlanModeTool, submitAgentWorkflowTool, reviseAgentWorkflowTool] };
export default provider;
