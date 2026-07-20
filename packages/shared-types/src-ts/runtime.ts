// GeoForge 运行时配置协议。
import { z } from 'zod'

// --- Config ---

export const permissionRuleSchema = z.object({
  toolPattern: z.string(),
  decision: z.enum(['always_allow', 'always_deny', 'always_ask']),
  priority: z.number().default(0),
  description: z.string().default(''),
})

export const hookConfigSchema = z.object({
  eventType: z.string(),
  commandType: z.string().default('command'),
  command: z.string(),
  matcher: z.record(z.string(), z.string()).prefault({}),
  priority: z.number().default(0),
  description: z.string().default(''),
  timeoutSeconds: z.number().default(30),
})

export const runtimeSubAgentConfigSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  role: z.string(),
  summary: z.string(),
  delegationMode: z.enum(['as_tool', 'parallel_batch', 'handoff']).default('as_tool'),
  parallelSafe: z.boolean().default(false),
  systemPrompt: z.string().nullable().default(null),
  model: z.string().nullable().default(null),
  tools: z.array(z.string()).default([]),
  maxTurns: z.number().int().positive().max(100).default(12),
  timeoutMs: z.number().int().positive().max(2_147_483_647).default(120_000),
})

export const subAgentInvocationSchema = z.object({
  objective: z.string().trim().min(1),
  expectedDeliverables: z.array(z.string().trim().min(1)).min(1),
  contextRefs: z.array(z.string().trim().min(1)),
  constraints: z.array(z.string().trim().min(1)),
}).strict()

export const agentBatchTaskSchema = subAgentInvocationSchema.extend({
  taskId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
}).strict()

export const agentBatchInvocationSchema = z.object({
  tasks: z.array(agentBatchTaskSchema).min(1).max(4),
}).strict()

const deliveryArtifactIdSchema = z.string()
  .trim()
  .regex(/^artifact_[a-zA-Z0-9_-]+$/u, '必须是当前运行真实生成的 artifact_<id>')
  .describe('当前 run 的平台 Artifact ID，必须来自工具结果 artifacts[].artifactId；不能填写 valueRefs[].refId')

export const supervisorDeliverySchema = z.object({
  markdown: z.string().trim().min(1).describe('直接展示给用户的最终中文 Markdown 正文'),
  summary: z.string().trim().min(1).describe('最终交付的单段简要摘要'),
  artifactIds: z.array(deliveryArtifactIdSchema)
    .describe('本次交付引用的真实平台 Artifact ID；没有 Artifact 时必须为空数组'),
  warnings: z.array(z.string().trim().min(1)).describe('需要用户注意的真实限制或警告'),
}).strict()

export const subAgentEvidenceSchema = z.object({
  claim: z.string().trim().min(1).describe('由当前工具结果支持的可核验结论'),
  source: z.string().trim().min(1)
    .describe('证据来源，可填写工具名、valueRefs[].refId 或 artifacts[].artifactId'),
}).strict()

export const subAgentDeliverySchema = z.object({
  status: z.enum(['completed', 'failed']),
  summary: z.string().trim().min(1).describe('返回主智能体的任务结论'),
  evidence: z.array(subAgentEvidenceSchema).describe('支持任务结论的证据清单'),
  artifactIds: z.array(deliveryArtifactIdSchema)
    .describe('子智能体引用的真实平台 Artifact ID；没有 Artifact 时必须为空数组'),
  warnings: z.array(z.string().trim().min(1)).describe('任务限制或非致命警告'),
  error: z.string().trim().min(1).nullable().describe('status=failed 时的错误；completed 时必须为 null'),
}).strict()

export const agentBatchTaskResultSchema = z.object({
  taskId: z.string().trim().min(1),
  agentId: z.string().trim().min(1),
  status: z.enum(['completed', 'failed']),
  delivery: subAgentDeliverySchema.nullable(),
  error: z.string().trim().min(1).nullable(),
  durationMs: z.number().nonnegative(),
}).strict()

export const agentBatchDeliverySchema = z.object({
  status: z.enum(['completed', 'partial_failure', 'failed']),
  tasks: z.array(agentBatchTaskResultSchema).min(1),
}).strict()

export const supervisorRuntimeConfigSchema = z.object({
  name: z.string().default('geo_agent_supervisor'),
  systemPrompt: z.string().default(''),
  approvalInterruptTools: z.array(z.string()).default([]),
  permissionRules: z.array(permissionRuleSchema).default([]),
})

export const runtimeUiConfigSchema = z.object({
  transcriptMaxEntries: z.number().default(40),
  showInternalReasoningLabels: z.boolean().default(true),
  eventGroupingWindowMs: z.number().default(1500),
})

export const runtimeCatalogConfigSchema = z.object({
  allowEmptyCatalog: z.boolean().default(true),
  adminEnabled: z.boolean().default(true),
})

export const runtimeContextConfigSchema = z.object({
  memoryFilePaths: z.array(z.string()).default([]),
  historyRunLimit: z.number().default(4),
  eventWindow: z.number().default(24),
  toolCallWindow: z.number().default(8),
  artifactWindow: z.number().default(6),
  warningWindow: z.number().default(6),
  promptMaxChars: z.number().default(12000),
  contextEntryWindow: z.number().default(18),
  memoryFileCharLimit: z.number().default(4000),
  memoryEnabled: z.boolean().default(true),
  memoryBaseDir: z.string().default('~/.geoforge/projects'),
  privateMemoryDir: z.string().nullable().default(null),
  teamMemoryDir: z.string().nullable().default(null),
  memoryEntrypointName: z.string().default('MEMORY.md'),
  instructionEntrypointName: z.string().default('AGENTS.md'),
  instructionMemoryEnabled: z.boolean().default(false),
  memoryMaxIndexLines: z.number().int().positive().default(200),
  memoryMaxIndexBytes: z.number().int().positive().default(25000),
  memoryMaxFiles: z.number().int().positive().default(200),
  memoryRelevantLimit: z.number().int().positive().default(5),
  memoryAutoExtractEnabled: z.boolean().default(true),
  memoryAutoDreamEnabled: z.boolean().default(true),
  memoryAutoDreamMinIntervalMs: z.number().int().positive().default(21_600_000),
  memoryAutoDreamMinFiles: z.number().int().positive().default(3),
  teamMemoryEnabled: z.boolean().default(true),
  sessionMemoryEnabled: z.boolean().default(true),
  sessionMemoryInitTokens: z.number().int().positive().default(10000),
  sessionMemoryUpdateTokens: z.number().int().positive().default(5000),
  sessionMemoryToolCallThreshold: z.number().int().positive().default(3),
  contextWindowTokens: z.number().int().positive().default(128000),
  warningRatio: z.number().min(0.1).max(0.95).default(0.7),
  compactRatio: z.number().min(0.2).max(0.98).default(0.8),
  hardLimitRatio: z.number().min(0.3).max(0.99).default(0.9),
  preserveRecentTurns: z.number().int().positive().default(6),
  inlineToolResultMaxChars: z.number().int().positive().default(12000),
  memoryInitTokens: z.number().int().positive().default(12000),
  memoryUpdateTokens: z.number().int().positive().default(8000),
  summaryProvider: z.string().nullable().default(null),
  summaryModel: z.string().nullable().default(null),
})

export const runtimeGeosearchConfigSchema = z.object({
  provider: z.string().default('nominatim'),
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('https://nominatim.openstreetmap.org'),
  userAgent: z.string().default('geo-agent-platform/0.1'),
  timeoutMs: z.number().default(2500),
  maxCandidates: z.number().default(5),
})

export const runtimePoiConfigSchema = z.object({
  provider: z.string().default('overpass'),
  enabled: z.boolean().default(true),
  baseUrl: z.string().default('https://overpass-api.de/api/interpreter'),
  userAgent: z.string().default('geo-agent-platform/0.1'),
  timeoutMs: z.number().default(8000),
  maxResults: z.number().default(200),
})

// 气象区域配置——不再硬编码杭州。杭州只保留为默认配置数据。
export const meteorologicalRegionSchema = z.object({
  id: z.string(),
  label: z.string(),
  aliases: z.array(z.string()).default([]),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  crs: z.string().default('EPSG:4326'),
  timezone: z.string().default('Asia/Shanghai'),
  defaultNowcastWindowMinutes: z.number().default(180),
})

export type MeteorologicalRegion = z.infer<typeof meteorologicalRegionSchema>

export const runtimeNowcastConfigSchema = z.object({
  meteorologicalRegions: z.array(meteorologicalRegionSchema).default([]),
  defaultMeteorologicalRegionId: z.string().default('hangzhou'),
  forecastHorizonMinutes: z.number().default(180),
  pointBufferMeters: z.number().default(1000),
  districtLayerKey: z.string().nullable().default(null),
  districtNameField: z.string().nullable().default(null),
  rainLevelThresholds: z.record(z.string(), z.number()).default({ none: 0.1, light: 2.5, moderate: 8.0, heavy: 16.0 }),
  candidateLimit: z.number().default(12),
})

export const runtimePlanningConfigSchema = z.object({
  maxPlanRepairRounds: z.number().default(2),
  externalSourcePriority: z.array(z.string()).default(['catalog', 'external_poi', 'geosearch']),
})

export const runtimeSandboxConfigSchema = z.object({
  backend: z.enum(['docker', 'unix_local']).default('docker'),
  dockerImage: z.string().default('node:22-bookworm-slim'),
})

export const runtimeMcpTransportSchema = z.enum(['streamable_http', 'sse', 'stdio'])
export const runtimeMcpExecutionModeSchema = z.enum(['function_tools', 'hosted'])
export const runtimeMcpApprovalSchema = z.enum(['always', 'never'])

export const runtimeMcpServerConfigSchema = z.object({
  enabled: z.boolean().default(true),
  name: z.string().min(1),
  description: z.string().default(''),
  transport: runtimeMcpTransportSchema.default('streamable_http'),
  executionMode: runtimeMcpExecutionModeSchema.default('function_tools'),
  url: z.string().nullable().default(null),
  connectorId: z.string().nullable().default(null),
  command: z.string().nullable().default(null),
  args: z.array(z.string()).default([]),
  cwd: z.string().nullable().default(null),
  env: z.record(z.string(), z.string()).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  authorizationEnv: z.string().nullable().default(null),
  allowedTools: z.array(z.string()).default([]),
  blockedTools: z.array(z.string()).default([]),
  includeServerInToolNames: z.boolean().default(true),
  convertSchemasToStrict: z.boolean().default(true),
  cacheToolsList: z.boolean().default(true),
  useStructuredContent: z.boolean().default(true),
  approval: runtimeMcpApprovalSchema.default('always'),
  timeoutMs: z.number().int().positive().default(20_000),
}).superRefine((server, context) => {
  if (server.executionMode === 'hosted') {
    if (server.transport !== 'streamable_http') {
      context.addIssue({
        code: 'custom',
        path: ['transport'],
        message: 'Hosted MCP 只支持 streamable_http。',
      })
    }
    if (!server.url && !server.connectorId) {
      context.addIssue({
        code: 'custom',
        path: ['url'],
        message: 'Hosted MCP 必须配置 url 或 connectorId。',
      })
    }
  } else if (server.transport === 'stdio') {
    if (!server.command?.trim()) {
      context.addIssue({
        code: 'custom',
        path: ['command'],
        message: 'stdio MCP 必须配置 command。',
      })
    }
  } else if (!server.url?.trim()) {
    context.addIssue({
      code: 'custom',
      path: ['url'],
      message: 'HTTP/SSE MCP 必须配置 url。',
    })
  }
})

export const runtimeMcpConfigSchema = z.object({
  enabled: z.boolean().default(false),
  connectTimeoutMs: z.number().int().positive().default(10_000),
  closeTimeoutMs: z.number().int().positive().default(2_000),
  servers: z.array(runtimeMcpServerConfigSchema).default([]),
})

export const runtimeSkillConfigSchema = z.object({
  enabled: z.boolean().default(false),
  skillsPath: z.string().default('.agents'),
  skillPaths: z.array(z.string()).default([]),
  skillRoots: z.array(z.string()).default([]),
})

export const runtimeSdkConfigSchema = z.object({
  mcp: runtimeMcpConfigSchema.default({
    enabled: false,
    connectTimeoutMs: 10_000,
    closeTimeoutMs: 2_000,
    servers: [],
  }),
  skills: runtimeSkillConfigSchema.default({
    enabled: false,
    skillsPath: '.agents',
    skillPaths: [],
    skillRoots: [],
  }),
})

export const agentRuntimeConfigSchema = z.object({
  loopTraceLimit: z.number().default(80),
  maxTurns: z.number().default(50),
  maxFunctionToolConcurrency: z.number().int().min(1).max(16).default(4),
  maxParallelSubAgents: z.number().int().min(1).max(4).default(3),
  sandbox: runtimeSandboxConfigSchema.default({ backend: 'docker', dockerImage: 'node:22-bookworm-slim' }),
  sdk: runtimeSdkConfigSchema.default({
    mcp: { enabled: false, connectTimeoutMs: 10_000, closeTimeoutMs: 2_000, servers: [] },
    skills: { enabled: false, skillsPath: '.agents', skillPaths: [], skillRoots: [] },
  }),
  supervisor: supervisorRuntimeConfigSchema.default({
    name: 'geo_agent_supervisor',
    systemPrompt: '',
    approvalInterruptTools: [],
    permissionRules: [],
  }),
  subAgents: z.array(runtimeSubAgentConfigSchema).default([]),
  ui: runtimeUiConfigSchema.default({
    transcriptMaxEntries: 40,
    showInternalReasoningLabels: true,
    eventGroupingWindowMs: 1500,
  }),
  catalog: runtimeCatalogConfigSchema.default({ allowEmptyCatalog: true, adminEnabled: true }),
  planning: runtimePlanningConfigSchema.default({
    maxPlanRepairRounds: 2,
    externalSourcePriority: ['catalog', 'external_poi', 'geosearch'],
  }),
  context: runtimeContextConfigSchema.default({
    memoryFilePaths: [],
    historyRunLimit: 4,
    eventWindow: 24,
    toolCallWindow: 8,
    artifactWindow: 6,
    warningWindow: 6,
    promptMaxChars: 12000,
    contextEntryWindow: 18,
    memoryFileCharLimit: 4000,
    memoryEnabled: true,
    memoryBaseDir: '~/.geoforge/projects',
    privateMemoryDir: null,
    teamMemoryDir: null,
    memoryEntrypointName: 'MEMORY.md',
    instructionEntrypointName: 'AGENTS.md',
    instructionMemoryEnabled: false,
    memoryMaxIndexLines: 200,
    memoryMaxIndexBytes: 25000,
    memoryMaxFiles: 200,
    memoryRelevantLimit: 5,
    memoryAutoExtractEnabled: true,
    memoryAutoDreamEnabled: true,
    memoryAutoDreamMinIntervalMs: 21_600_000,
    memoryAutoDreamMinFiles: 3,
    teamMemoryEnabled: true,
    sessionMemoryEnabled: true,
    sessionMemoryInitTokens: 10000,
    sessionMemoryUpdateTokens: 5000,
    sessionMemoryToolCallThreshold: 3,
    contextWindowTokens: 128000,
    warningRatio: 0.7,
    compactRatio: 0.8,
    hardLimitRatio: 0.9,
    preserveRecentTurns: 6,
    inlineToolResultMaxChars: 12000,
    memoryInitTokens: 12000,
    memoryUpdateTokens: 8000,
    summaryProvider: null,
    summaryModel: null,
  }),
  geosearch: runtimeGeosearchConfigSchema.default({
    provider: 'nominatim',
    enabled: true,
    baseUrl: 'https://nominatim.openstreetmap.org',
    userAgent: 'geo-agent-platform/0.1',
    timeoutMs: 2500,
    maxCandidates: 5,
  }),
  externalPoi: runtimePoiConfigSchema.default({
    provider: 'overpass',
    enabled: true,
    baseUrl: 'https://overpass-api.de/api/interpreter',
    userAgent: 'geo-agent-platform/0.1',
    timeoutMs: 8000,
    maxResults: 200,
  }),
  nowcast: runtimeNowcastConfigSchema.default({
    meteorologicalRegions: [
      { id: 'hangzhou', label: '杭州市', aliases: ['杭州'], timezone: 'Asia/Shanghai', crs: 'EPSG:4326', defaultNowcastWindowMinutes: 180 },
    ],
    defaultMeteorologicalRegionId: 'hangzhou',
    forecastHorizonMinutes: 180,
    pointBufferMeters: 1000,
    districtLayerKey: null,
    districtNameField: null,
    rainLevelThresholds: { none: 0.1, light: 2.5, moderate: 8.0, heavy: 16.0 },
    candidateLimit: 12,
  }),
  hookConfigs: z.array(hookConfigSchema).default([]),
})

export type PermissionRuleEntry = z.infer<typeof permissionRuleSchema>
export type HookConfigEntry = z.infer<typeof hookConfigSchema>
export type RuntimeSubAgentConfig = z.infer<typeof runtimeSubAgentConfigSchema>
export type SubAgentInvocation = z.infer<typeof subAgentInvocationSchema>
export type AgentBatchTask = z.infer<typeof agentBatchTaskSchema>
export type AgentBatchInvocation = z.infer<typeof agentBatchInvocationSchema>
export type SupervisorDelivery = z.infer<typeof supervisorDeliverySchema>
export type SubAgentEvidence = z.infer<typeof subAgentEvidenceSchema>
export type SubAgentDelivery = z.infer<typeof subAgentDeliverySchema>
export type AgentBatchTaskResult = z.infer<typeof agentBatchTaskResultSchema>
export type AgentBatchDelivery = z.infer<typeof agentBatchDeliverySchema>
export type SupervisorRuntimeConfig = z.infer<typeof supervisorRuntimeConfigSchema>
export type RuntimeUiConfig = z.infer<typeof runtimeUiConfigSchema>
export type RuntimeCatalogConfig = z.infer<typeof runtimeCatalogConfigSchema>
export type RuntimeContextConfig = z.infer<typeof runtimeContextConfigSchema>
export type RuntimeGeosearchConfig = z.infer<typeof runtimeGeosearchConfigSchema>
export type RuntimePoiConfig = z.infer<typeof runtimePoiConfigSchema>
export type RuntimeNowcastConfig = z.infer<typeof runtimeNowcastConfigSchema>
export type RuntimePlanningConfig = z.infer<typeof runtimePlanningConfigSchema>
export type RuntimeSandboxConfig = z.infer<typeof runtimeSandboxConfigSchema>
export type RuntimeMcpServerConfig = z.infer<typeof runtimeMcpServerConfigSchema>
export type RuntimeMcpConfig = z.infer<typeof runtimeMcpConfigSchema>
export type RuntimeSkillConfig = z.infer<typeof runtimeSkillConfigSchema>
export type RuntimeSdkConfig = z.infer<typeof runtimeSdkConfigSchema>
export type AgentRuntimeConfig = z.infer<typeof agentRuntimeConfigSchema>
