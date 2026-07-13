// +-------------------------------------------------------------------------
//
//   地理智能平台 - Web API 公共门面
//
//   文件:       client.ts
// --------------------------------------------------------------------------

// 业务实现按资源所有权分散在独立模块；该文件仅维护稳定导入入口，避免页面
// 同时了解认证、会话、运行、文件、工具和 Workflow 的传输细节。

export * from './authApi'
export * from './conversationApi'
export * from './memoryApi'
export * from './resourceApi'
export * from './runApi'
export * from './toolApi'
export * from './workflowApi'

export type { ResponseSchema, SchemaParseError } from './transport'
export {
  apiBaseUrl,
  deriveApiBaseUrl,
  formatApiErrorMessage,
  formatSchemaValidationError,
  setAuthContext,
} from './transport'
