// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - 运维后台构建配置
//
//   文件:       vite.config.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const target = env.OPS_GATEWAY_URL || 'http://127.0.0.1:8020'
  return {
    base: '/operations/',
    plugins: react(),
    server: {
      host: env.OPS_WEB_HOST || '127.0.0.1',
      port: Number(env.OPS_WEB_PORT || 8022),
      strictPort: true,
      proxy: {
        '/ops': { target, changeOrigin: true, ws: true },
      },
    },
    build: {
      outDir: 'dist',
      emptyOutDir: true,
      sourcemap: false,
    },
  }
})
