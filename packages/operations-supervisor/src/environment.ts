// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 受监督服务环境隔离
//
//   文件:       environment.ts
//
//   日期:       2026年07月22日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import type { OperationsServiceId } from '@geo-agent-platform/shared-types/operations'

const COMMON_NAMES = new Set([
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SYSTEMROOT', 'ComSpec', 'COMSPEC', 'WINDIR',
  'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA',
  'SHELL', 'TERM', 'COLORTERM', 'NO_COLOR', 'FORCE_COLOR', 'NODE_OPTIONS', 'NODE_ENV',
  'GEOFORGE_ROOT', 'RUNTIME_ROOT', 'PYTHONIOENCODING', 'PYTHONUTF8',
])

const PREFIXES: Record<OperationsServiceId, readonly string[]> = {
  infra: ['POSTGRES_', 'POSTGIS_', 'MARTIN_', 'TITILER_', 'COMPOSE_', 'DOCKER_', 'RUNTIME_'],
  worker: ['WORKER_', 'PYTHON', 'GDAL_', 'PROJ_', 'RUNTIME_', 'POSTGIS_', 'DATA_'],
  api: [
    'API_', 'APP_', 'WEB_', 'WORKER_', 'DATABASE_', 'POSTGRES_', 'POSTGIS_', 'MARTIN_',
    'TITILER_', 'BETTER_AUTH_', 'CSRF_', 'TRUSTED_', 'OPENAI_', 'DEEPSEEK_', 'MODEL_',
    'GATEWAY_', 'AMAP_', 'ENABLED_', 'DEVELOPER_', 'SEED_', 'SCHEDULED_', 'RUNTIME_',
    'OTEL_', 'LOG_',
  ],
  web: ['VITE_', 'WEB_DEV_', 'WEB_STATIC_', 'API_PROXY_', 'NODE_ENV'],
}

const FORBIDDEN_PREFIXES = [
  'GEOFORGE_SUPERVISOR_',
  'GEOFORGE_LOCAL_ROOT_',
]

export function environmentForService(
  serviceId: OperationsServiceId,
  source: NodeJS.ProcessEnv,
  additions: Record<string, string>,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || FORBIDDEN_PREFIXES.some(prefix => name.startsWith(prefix))) continue
    if (COMMON_NAMES.has(name) || PREFIXES[serviceId].some(prefix => name.startsWith(prefix))) {
      result[name] = value
    }
  }
  for (const [name, value] of Object.entries(additions)) result[name] = value
  return result
}

/**
 * concurrently 会把父进程环境先合并到 command.env。对不在白名单中的键显式写入
 * undefined，使 Node spawn 真正删除这些键，而不是让执行适配器绕过隔离边界。
 */
export function environmentForConcurrently(
  parent: NodeJS.ProcessEnv,
  allowed: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...allowed }
  for (const name of Object.keys(parent)) {
    if (!(name in allowed)) result[name] = undefined
  }
  return result
}

export function secretValues(source: NodeJS.ProcessEnv): string[] {
  return [...new Set(Object.entries(source)
    .filter(([name, value]) => Boolean(value) && value!.length >= 8 && /(KEY|SECRET|TOKEN|PASSWORD)/iu.test(name))
    .filter(([name]) => !name.startsWith('GEOFORGE_MANAGED_MARKER'))
    .map(([, value]) => value!))]
    .sort((left, right) => right.length - left.length)
}
