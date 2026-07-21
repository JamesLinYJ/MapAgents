// +-------------------------------------------------------------------------
//
//   GeoForge 地理智能平台 - Terminal Broker 最小环境入口
//
//   文件:       terminalBrokerEntry.ts
//
//   日期:       2026年07月21日
//   作者:       OpenAI Codex
// --------------------------------------------------------------------------

import { sanitizeBrokerProcessEnvironment } from './brokerEnvironment.js'

// Broker 在加载 PTY、日志和运行时模块前先删除非白名单环境变量。生产服务仍应
// 从 systemd/WinSW 层只注入白名单；此处是进程内的第二道防线。
sanitizeBrokerProcessEnvironment(process.env)
await import('./terminalBrokerRuntime.js')
