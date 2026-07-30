// +-------------------------------------------------------------------------
//
//   地理智能平台 - 产品身份事实源
//
//   文件:       productIdentity.ts
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

/**
 * 可变产品代号只允许在本模块定义。界面、CLI、导出物和安装包必须引用这些常量，
 * 稳定协议与持久化标识则使用不含代号的技术标识，避免品牌变更破坏已有数据。
 */
export const PRODUCT_CODENAME = 'GeoForge'
export const PRODUCT_CODENAME_UPPER = PRODUCT_CODENAME.toLocaleUpperCase('en-US')
export const PRODUCT_PLATFORM_NAME = `${PRODUCT_CODENAME} 地理智能平台`
export const PRODUCT_DESKTOP_NAME = `${PRODUCT_CODENAME} GIS 工作台`
export const PRODUCT_EXECUTABLE_BASENAME = (
  PRODUCT_CODENAME.replace(/[^A-Za-z0-9._-]/gu, '') || 'GeoAgentPlatform'
)

export const PLATFORM_TECHNICAL_ID = 'geo-agent-platform'
export const PLATFORM_MACHINE_ID = 'geo_agent_platform'
export const PLATFORM_STATE_DIRECTORY_NAME = `.${PLATFORM_MACHINE_ID}`
export const PLATFORM_IPC_CHANNEL_PREFIX = PLATFORM_MACHINE_ID
export const PLATFORM_RENDERER_EVENT_PREFIX = PLATFORM_MACHINE_ID
export const PLATFORM_DESKTOP_PROTOCOL_SCHEME = PLATFORM_TECHNICAL_ID
export const PLATFORM_DESKTOP_RESOURCE_PROTOCOL_SCHEME = `${PLATFORM_TECHNICAL_ID}-resource`
export const PLATFORM_DESKTOP_AUTH_PROTOCOL_SCHEME = 'com.geo-agent-platform.desktop'
export const PLATFORM_DESKTOP_APPLICATION_ID = 'io.geoagentplatform.desktop'
export const PLATFORM_DESKTOP_USER_MODEL_ID = 'GeoAgentPlatform.Desktop'
export const PLATFORM_WORKER_AUTHORIZATION_SCHEME = 'GeoAgentPlatform-Worker'
export const PLATFORM_DESKTOP_APP_ORIGIN = `${PLATFORM_DESKTOP_PROTOCOL_SCHEME}://app`
export const PLATFORM_DESKTOP_AUTH_ORIGIN = `${PLATFORM_DESKTOP_AUTH_PROTOCOL_SCHEME}:/`
export const PLATFORM_DESKTOP_AUTH_CALLBACK_URL = (
  `${PLATFORM_DESKTOP_AUTH_PROTOCOL_SCHEME}://auth/callback`
)
