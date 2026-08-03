// +-------------------------------------------------------------------------
//
//   地理智能平台 - 模型与账号配置页
//
//   文件:       ModelSettingsPage.tsx
//
//   日期:       2026年07月31日
//   作者:       JamesLinYJ
//   协助:       OpenAI Codex:GPT-5.6 Sol
// --------------------------------------------------------------------------

import type { ModelProviderDescriptor } from '@geo-agent-platform/shared-types'
import {
  Check,
  CircleUserRound,
  Cpu,
  Route,
  ShieldCheck,
  Sparkles,
} from 'lucide-react'

import type { DesktopAuthMode } from '../../app/useWorkspaceBootstrap'
import {
  agentRuntimeCapabilitySummary,
  providerUnavailableLabel,
  supportsAgentSdkLiveSupervisor,
} from '../../shared/providerCapabilities'

export interface ModelSettingsPageProps {
  authMode: DesktopAuthMode
  canAccessAccount: boolean
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  onProviderChange: (provider: string) => void
  onModelChange: (model: string) => void
  onOpenAccount: () => void
}

export function ModelSettingsPage({
  authMode,
  canAccessAccount,
  provider,
  model,
  providers,
  onProviderChange,
  onModelChange,
  onOpenAccount,
}: ModelSettingsPageProps) {
  const selectedProvider = providers.find(item => item.provider === provider)
  const selectedModel = model || selectedProvider?.defaultModel || ''
  const models = uniqueModels(selectedProvider)

  return (
    <main className="model-settings">
      <header className="model-settings__hero">
        <div className="model-settings__hero-icon" aria-hidden="true">
          <Sparkles size={25} />
        </div>
        <div>
          <span className="model-settings__eyebrow">运行偏好</span>
          <h1>模型与账号</h1>
          <p>在应用内选择模型路由与具体模型。账号是可选扩展，不影响本机工作台启动。</p>
        </div>
        <div className="model-settings__summary">
          <span><i /> 当前路由</span>
          <strong>{selectedProvider?.displayName ?? provider}</strong>
          <small>{selectedModel || '等待服务返回默认模型'}</small>
        </div>
      </header>

      <section className="model-settings__section" aria-labelledby="model-route-title">
        <div className="model-settings__section-heading">
          <div>
            <span className="model-settings__eyebrow">01 · 路由</span>
            <h2 id="model-route-title">选择模型服务</h2>
            <p>默认优先使用已配置的 DeepSeek；不可用的服务会保留展示，但不能被误选。</p>
          </div>
          <Route size={22} aria-hidden="true" />
        </div>

        <div className="model-settings__provider-grid">
          {providers.map(item => {
            const available = supportsAgentSdkLiveSupervisor(item)
            const active = item.provider === provider
            return (
              <button
                key={item.provider}
                type="button"
                className={[
                  'model-settings__provider',
                  active ? 'is-active' : '',
                  available ? '' : 'is-disabled',
                ].filter(Boolean).join(' ')}
                disabled={!available}
                aria-pressed={active}
                onClick={() => onProviderChange(item.provider)}
              >
                <span className="model-settings__provider-icon" aria-hidden="true">
                  <Cpu size={18} />
                </span>
                <span className="model-settings__provider-copy">
                  <strong>{item.displayName}</strong>
                  <small>{agentRuntimeCapabilitySummary(item)}</small>
                </span>
                <span className="model-settings__provider-state">
                  {active ? <Check size={16} aria-hidden="true" /> : providerUnavailableLabel(item) || '可用'}
                </span>
              </button>
            )
          })}
          {providers.length === 0 ? (
            <div className="model-settings__empty">正在等待本机服务返回模型目录。</div>
          ) : null}
        </div>
      </section>

      <section className="model-settings__section" aria-labelledby="model-choice-title">
        <div className="model-settings__section-heading">
          <div>
            <span className="model-settings__eyebrow">02 · 模型</span>
            <h2 id="model-choice-title">选择具体模型</h2>
            <p>只展示当前服务声明的模型，避免输入不存在的名称后才在运行阶段失败。</p>
          </div>
          <Sparkles size={22} aria-hidden="true" />
        </div>

        <div className="model-settings__model-list">
          {models.map(item => {
            const active = item === selectedModel
            return (
              <button
                key={item}
                type="button"
                className={active ? 'is-active' : ''}
                aria-pressed={active}
                onClick={() => onModelChange(item)}
              >
                <span>
                  <strong>{item}</strong>
                  <small>{item === selectedProvider?.defaultModel ? '默认模型' : '可用模型'}</small>
                </span>
                {active ? <Check size={17} aria-hidden="true" /> : null}
              </button>
            )
          })}
          {models.length === 0 ? (
            <div className="model-settings__empty">当前路由没有声明可用模型。</div>
          ) : null}
        </div>
      </section>

      <section className="model-settings__identity" aria-labelledby="identity-title">
        <span className="model-settings__identity-icon" aria-hidden="true">
          {authMode === 'local_auto' ? <ShieldCheck size={22} /> : <CircleUserRound size={22} />}
        </span>
        <div>
          <span className="model-settings__eyebrow">03 · 身份</span>
          <h2 id="identity-title">
            {authMode === 'local_auto' ? '本机身份由应用托管' : '正在使用扩展账号模式'}
          </h2>
          <p>
            {authMode === 'local_auto'
              ? '启动时自动建立受保护的本机会话；无需注册或输入账号。'
              : '账号能力用于多人协作与远程权限，不是本机分析的启动前提。'}
          </p>
        </div>
        {canAccessAccount ? (
          <button type="button" onClick={onOpenAccount}>打开账号中心</button>
        ) : null}
      </section>
    </main>
  )
}

function uniqueModels(provider: ModelProviderDescriptor | undefined): string[] {
  if (!provider) return []
  return [...new Set([
    provider.defaultModel,
    ...provider.availableModels,
  ].filter((value): value is string => Boolean(value?.trim())))]
}

