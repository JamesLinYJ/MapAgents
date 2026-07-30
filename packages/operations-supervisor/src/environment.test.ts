// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 受监督环境隔离测试
//
//   文件:       environment.test.ts
//
//   日期:       2026年07月22日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import { spawnSync } from 'node:child_process'

import { describe, expect, it } from 'vitest'

import { environmentForConcurrently, environmentForService, secretValues } from './environment.js'

describe('service environment isolation', () => {
  it('never passes supervisor or local-root secrets to child services', () => {
    const result = environmentForService('api', {
      PATH: 'test-path',
      API_PORT: '8000',
      OPENAI_API_KEY: 'provider-secret',
      OPEN_METEO_TIMEOUT_MS: '10000',
      GEOFORGE_SUPERVISOR_TOKEN: 'supervisor-secret',
      GEOFORGE_LOCAL_ROOT_SECRET: 'root-secret',
      NODE_OPTIONS: '--require malicious-hook.js',
      WEB_DEV_PORT: '5173',
      UNRELATED_SECRET: 'unrelated-secret',
    }, { GEOFORGE_ROOT: 'C:\\project' })

    expect(result).toMatchObject({
      PATH: 'test-path',
      API_PORT: '8000',
      OPENAI_API_KEY: 'provider-secret',
      OPEN_METEO_TIMEOUT_MS: '10000',
    })
    expect(result).not.toHaveProperty('GEOFORGE_SUPERVISOR_TOKEN')
    expect(result).not.toHaveProperty('GEOFORGE_LOCAL_ROOT_SECRET')
    expect(result).not.toHaveProperty('NODE_OPTIONS')
    expect(result).not.toHaveProperty('WEB_DEV_PORT')
    expect(result).not.toHaveProperty('UNRELATED_SECRET')
  })

  it('passes every fixed input required by the native infrastructure launcher', () => {
    const result = environmentForService('infra', {
      DATABASE_URL: 'postgresql://geo_agent:secret@127.0.0.1:55432/geo_agent',
      POSTGIS_PORT: '55432',
      POSTGRES_BIN_DIR: 'C:\\Program Files\\PostgreSQL\\18\\bin',
      POSTGRES_DATA_DIR: 'C:\\runtime\\postgresql',
      ProgramFiles: 'C:\\Program Files',
      GEOFORGE_SUPERVISOR_TOKEN: 'must-not-leak',
    }, {
      GEOFORGE_ROOT: 'C:\\project',
      RUNTIME_ROOT: 'C:\\runtime',
    })

    expect(result).toMatchObject({
      DATABASE_URL: 'postgresql://geo_agent:secret@127.0.0.1:55432/geo_agent',
      POSTGIS_PORT: '55432',
      POSTGRES_BIN_DIR: 'C:\\Program Files\\PostgreSQL\\18\\bin',
      POSTGRES_DATA_DIR: 'C:\\runtime\\postgresql',
      ProgramFiles: 'C:\\Program Files',
      GEOFORGE_ROOT: 'C:\\project',
      RUNTIME_ROOT: 'C:\\runtime',
    })
    expect(result).not.toHaveProperty('GEOFORGE_SUPERVISOR_TOKEN')
  })

  it('passes the complete fixed API runtime configuration surface', () => {
    const apiEnvironmentNames = [
      'API_PORT',
      'API_HOST',
      'DATABASE_URL',
      'RUNTIME_ROOT',
      'APP_BASE_URL',
      'BETTER_AUTH_URL',
      'BETTER_AUTH_SECRET',
      'BETTER_AUTH_ALLOW_SIGN_UP',
      'BETTER_AUTH_REQUIRE_EMAIL_VERIFICATION',
      'BETTER_AUTH_MIN_PASSWORD_LENGTH',
      'CSRF_HEADER_NAME',
      'BOOTSTRAP_ADMIN_EMAIL',
      'TRUSTED_ORIGINS',
      'SEED_LAYERS_DIR',
      'MAX_FILE_UPLOAD_BYTES',
      'MAX_GEOJSON_UPLOAD_BYTES',
      'MAX_METEOROLOGY_UPLOAD_BYTES',
      'MAX_GEOJSON_FEATURES',
      'MAX_GEOJSON_COORDINATES',
      'MAP_TILE_TIMEOUT_MS',
      'DEFAULT_MODEL_PROVIDER',
      'DEFAULT_MODEL_NAME',
      'DEEPSEEK_BASE_URL',
      'DEEPSEEK_API_KEY',
      'DEEPSEEK_MODEL',
      'DEEPSEEK_SUBAGENT_MODEL',
      'DEEPSEEK_TOOL_SCHEMA_MODE',
      'DEEPSEEK_RESULT_CACHE_ENABLED',
      'DEEPSEEK_RESULT_CACHE_TTL_SECONDS',
      'DEEPSEEK_RESULT_CACHE_MAX_BYTES',
      'USAGE_DAILY_TOTAL_TOKEN_LIMIT',
      'USAGE_MONTHLY_TOTAL_TOKEN_LIMIT',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'ANTHROPIC_VERSION',
      'GEMINI_BASE_URL',
      'GEMINI_API_KEY',
      'GEMINI_MODEL',
      'OLLAMA_BASE_URL',
      'OLLAMA_MODEL',
      'WORKER_URL',
      'WORKER_SHARED_SECRET',
      'WORKER_MAX_CONCURRENCY',
      'WORKER_REQUEST_TIMEOUT_MS',
      'AZURE_SPEECH_KEY',
      'AZURE_SPEECH_REGION',
      'AZURE_SPEECH_ENDPOINT',
      'AZURE_SPEECH_DEFAULT_LANGUAGE',
      'AZURE_SPEECH_SUPPORTED_LANGUAGES',
      'AZURE_SPEECH_DEFAULT_VOICE',
      'SANDBOX_BACKEND',
      'ENABLED_TOOL_PROVIDERS',
      'DEVELOPER_TOOL_ALLOWED_ROOTS',
      'OPEN_METEO_FORECAST_BASE_URL',
      'OPEN_METEO_GEOCODING_BASE_URL',
      'OPEN_METEO_AIR_QUALITY_BASE_URL',
      'OPEN_METEO_TIMEOUT_MS',
      'VALHALLA_BASE_URL',
      'ROUTING_TIMEOUT_MS',
      'TIANDITU_API_KEY',
      'GEOFORGE_MEMORY_BASE_DIR',
      'RIPGREP_PATH',
      'RG_PATH',
    ] as const
    const source = Object.fromEntries(apiEnvironmentNames.map(name => [name, `value-for-${name}`]))

    const result = environmentForService('api', source, {})

    expect(Object.keys(result).sort()).toEqual([...apiEnvironmentNames].sort())
  })

  it('collects known secret values longest-first for exact redaction', () => {
    expect(secretValues({ API_KEY: 'abcdefgh', LONG_PASSWORD: 'abcdefghijklmnop', SHORT_TOKEN: 'x' }))
      .toEqual(['abcdefghijklmnop', 'abcdefgh'])
  })

  it('masks parent-only values when concurrently merges its inherited environment', () => {
    const parent = { PATH: process.env.PATH, GEOFORGE_SUPERVISOR_TOKEN: 'must-not-leak' }
    const allowed = { PATH: process.env.PATH, API_PORT: '8000' }
    const adapterEnvironment = environmentForConcurrently(parent, allowed)
    const merged = { ...parent, ...adapterEnvironment }
    const child = spawnSync(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify({token:process.env.GEOFORGE_SUPERVISOR_TOKEN ?? null,port:process.env.API_PORT}))',
    ], { env: merged, encoding: 'utf8' })

    expect(child.status).toBe(0)
    expect(JSON.parse(child.stdout)).toEqual({ token: null, port: '8000' })
  })
})
