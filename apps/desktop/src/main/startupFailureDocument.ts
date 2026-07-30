// +-------------------------------------------------------------------------
//
//   地理智能平台 - 桌面启动失败文档
//
//   文件:       startupFailureDocument.ts
//
//   日期:       2026年07月29日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import {
  PRODUCT_CODENAME,
  PRODUCT_DESKTOP_NAME,
} from '@geo-agent-platform/shared-types/product-identity'

export function buildStartupFailureDocument(error: unknown): string {
  const message = escapeHtml(safeStartupMessage(error))
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(PRODUCT_CODENAME)} 启动失败</title>
  <style>
    :root { color-scheme: light; font-family: "Segoe UI Variable", "Microsoft YaHei UI", sans-serif; }
    * { box-sizing: border-box; }
    body { display: grid; min-width: 640px; min-height: 420px; margin: 0; place-items: center; color: #1c2e36; background: linear-gradient(145deg, #e9f2f4, #f8fafb); }
    main { width: min(620px, calc(100vw - 56px)); padding: 30px 34px; border: 1px solid #c4d0d5; border-radius: 12px; background: #fff; box-shadow: 0 18px 50px rgb(31 65 76 / 15%); }
    header { display: flex; align-items: center; gap: 11px; margin-bottom: 28px; }
    .brand { display: grid; width: 36px; height: 36px; place-items: center; border-radius: 8px; color: #fff; background: #087f98; font-weight: 700; }
    header div:last-child { display: grid; gap: 2px; }
    header strong { font-size: 14px; }
    header small, p, li { color: #60747d; }
    h1 { margin: 0; font-size: 22px; font-weight: 650; }
    .error { margin: 16px 0 20px; padding: 12px 14px; border: 1px solid #e1b5b5; border-radius: 7px; color: #842e2e; background: #fff5f5; font: 12px/1.65 Consolas, "Microsoft YaHei UI", monospace; overflow-wrap: anywhere; }
    ul { margin: 0; padding-left: 20px; font-size: 12px; line-height: 1.8; }
    code { padding: 1px 5px; border-radius: 4px; color: #075e72; background: #e6f4f6; }
    footer { margin-top: 22px; padding-top: 14px; border-top: 1px solid #e1e7e9; color: #809097; font-size: 10px; }
  </style>
</head>
<body>
  <main>
    <header>
      <span class="brand" aria-hidden="true">G</span>
      <div><strong>${escapeHtml(PRODUCT_DESKTOP_NAME)}</strong><small>桌面启动诊断</small></div>
    </header>
    <h1>工作台未能完成启动</h1>
    <p>桌面壳没有进入伪成功状态。请先修复以下配置或本机运行时问题，再重新启动。</p>
    <div class="error" role="alert">${message}</div>
    <ul>
      <li>从项目目录运行 <code>.\\dev.ps1 desktop</code>。</li>
      <li>生产安装检查 <code>runtime-manifest.v1.json</code>；开发环境检查 <code>GEO_AGENT_PLATFORM_ROOT</code>。</li>
      <li>确认本机 Supervisor 令牌、服务状态和系统日志。</li>
      <li>关闭本窗口不会停止已经运行的后台服务。</li>
    </ul>
    <footer>错误代码：DESKTOP_STARTUP_FAILED</footer>
  </main>
</body>
</html>`
}

export function safeStartupMessage(error: unknown): string {
  const raw = error instanceof Error && error.message.trim()
    ? error.message
    : '桌面主进程遇到未知启动错误。'
  return raw
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/(authorization|password|secret|token)\s*[=:]\s*[^\s,;]+/giu, '$1=[REDACTED]')
    .trim()
    .slice(0, 800)
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}
