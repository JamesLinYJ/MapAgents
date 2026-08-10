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

import {
  customProviderConfigSchema,
  type CustomProviderConfig,
  type CustomProviderRecord,
  type ModelProviderDescriptor,
} from '@geo-agent-platform/shared-types'
import {
  Check,
  CircleUserRound,
  Cpu,
  KeyRound,
  Plus,
  Route,
  ServerCog,
  Settings2,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'

import type { DesktopAuthMode } from '../../app/useWorkspaceBootstrap'
import {
  deleteCustomProvider,
  listCustomProviders,
  listProviders,
  saveCustomProvider,
  stageProviderCredential,
} from '../../api/client'
import {
  agentRuntimeCapabilitySummary,
  providerUnavailableLabel,
  supportsAgentSdkLiveSupervisor,
} from '../../shared/providerCapabilities'
import { requireDesktopBridge } from '../../api/transport'
import { useProductIdentity } from '../../app/ProductIdentityContext'

export interface ModelSettingsPageProps {
  authMode: DesktopAuthMode
  canAccessAccount: boolean
  provider: string
  model: string
  providers: ModelProviderDescriptor[]
  onProviderChange: (provider: string) => void
  onModelChange: (model: string) => void
  onOpenAccount: () => void
  canManageProviders?: boolean
  onProviderCatalogChanged?: (providers: ModelProviderDescriptor[]) => void
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
  canManageProviders = false,
  onProviderCatalogChanged,
}: ModelSettingsPageProps) {
  const [customProviders, setCustomProviders] = useState<CustomProviderRecord[]>([])
  const [wizardOpen, setWizardOpen] = useState(false)
  const [draft, setDraft] = useState<CustomProviderDraft>(emptyCustomProviderDraft())
  const [editingProviderId, setEditingProviderId] = useState<string | null>(null)
  const [providerBusy, setProviderBusy] = useState(false)
  const [providerError, setProviderError] = useState<string | null>(null)
  const [providerNotice, setProviderNotice] = useState<string | null>(null)
  const selectedProvider = providers.find(item => item.provider === provider)
  const { productName, openProductSettings } = useProductIdentity()
  const selectedModel = model || selectedProvider?.defaultModel || ''
  const models = uniqueModels(selectedProvider)

  useEffect(() => {
    if (!canManageProviders) return
    void refreshCustomProviders(setCustomProviders).catch(error => {
      setProviderError(formatProviderError(error, '自定义 Provider 目录加载失败。'))
    })
  }, [canManageProviders])

  const openCreateWizard = (): void => {
    setDraft(emptyCustomProviderDraft())
    setEditingProviderId(null)
    setProviderError(null)
    setProviderNotice(null)
    setWizardOpen(true)
  }

  const openEditWizard = (record: CustomProviderRecord): void => {
    setDraft(draftFromRecord(record))
    setEditingProviderId(record.providerId)
    setProviderError(null)
    setProviderNotice(null)
    setWizardOpen(true)
  }

  const updateDraftModel = (
    index: number,
    update: (model: CustomProviderModelDraft) => CustomProviderModelDraft,
  ): void => {
    setDraft(current => ({
      ...current,
      models: current.models.map((model, candidateIndex) => candidateIndex === index ? update(model) : model),
    }))
  }

  const updateDraftModelId = (index: number, modelId: string): void => {
    setDraft(current => {
      const previousModelId = current.models[index]?.modelId ?? ''
      return {
        ...current,
        defaultModel: current.defaultModel === previousModelId ? modelId : current.defaultModel,
        models: current.models.map((model, candidateIndex) => candidateIndex === index
          ? { ...model, modelId }
          : model),
      }
    })
  }

  const removeDraftModel = (index: number): void => {
    setDraft(current => {
      const removed = current.models[index]
      const models = current.models.filter((_, candidateIndex) => candidateIndex !== index)
      return {
        ...current,
        models,
        defaultModel: removed?.modelId === current.defaultModel
          ? models[0]?.modelId ?? ''
          : current.defaultModel,
      }
    })
  }

  const submitCustomProvider = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (providerBusy) return
    setProviderBusy(true)
    setProviderError(null)
    setProviderNotice(null)
    try {
      const config = parseCustomProviderDraft(draft)
      const credential = draft.apiKey.trim()
        ? await stageProviderCredential(draft.apiKey)
        : null
      const saved = await saveCustomProvider(
        config,
        credential?.credentialHandle,
        draft.clearCredential,
      )
      const [nextCustomProviders, nextProviders] = await Promise.all([
        listCustomProviders(),
        listProviders(),
      ])
      setCustomProviders(nextCustomProviders)
      onProviderCatalogChanged?.(nextProviders)
      onProviderChange(saved.provider.providerId)
      onModelChange(saved.provider.defaultModel)
      setDraft(emptyCustomProviderDraft())
      setEditingProviderId(null)
      setWizardOpen(false)
      setProviderNotice(
        `${saved.provider.displayName} 已通过连通性和最小模型调用（${Math.round(saved.validation.latencyMs)} ms）。`,
      )
    } catch (error) {
      setProviderError(formatProviderError(error, '自定义 Provider 保存失败。'))
    } finally {
      setProviderBusy(false)
    }
  }

  const removeCustomProvider = async (record: CustomProviderRecord): Promise<void> => {
    const confirmed = await requireDesktopBridge().dialog.confirm({
      title: '删除自定义 Provider',
      message: `确认删除“${record.displayName}”吗？`,
      detail: '该 Provider 的加密凭据也会一并删除，此操作无法撤销。',
      confirmLabel: '删除 Provider',
      cancelLabel: '取消',
      tone: 'danger',
    })
    if (!confirmed) return
    setProviderBusy(true)
    setProviderError(null)
    try {
      await deleteCustomProvider(record.providerId)
      const [nextCustomProviders, nextProviders] = await Promise.all([
        listCustomProviders(),
        listProviders(),
      ])
      setCustomProviders(nextCustomProviders)
      onProviderCatalogChanged?.(nextProviders)
      if (provider === record.providerId) {
        const fallback = nextProviders.find(item => supportsAgentSdkLiveSupervisor(item))
        if (fallback) onProviderChange(fallback.provider)
      }
      setProviderNotice(`${record.displayName} 已删除，其加密凭据也已一并移除。`)
      if (editingProviderId === record.providerId) {
        setWizardOpen(false)
        setEditingProviderId(null)
      }
    } catch (error) {
      setProviderError(formatProviderError(error, '自定义 Provider 删除失败。'))
    } finally {
      setProviderBusy(false)
    }
  }

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
            const capabilities = selectedProvider?.models.find(model => model.modelId === item)
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
                  <small>{modelCapabilityLabel(
                    item === selectedProvider?.defaultModel,
                    capabilities,
                  )}</small>
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

      {canManageProviders ? (
        <section className="model-settings__section model-settings__custom" aria-labelledby="custom-provider-title">
          <div className="model-settings__section-heading">
            <div>
              <span className="model-settings__eyebrow">03 · 自定义服务</span>
              <h2 id="custom-provider-title">OpenAI-compatible Provider</h2>
              <p>配置任意兼容端点。保存前会校验网络边界、建立连接并执行一次最小模型调用。</p>
            </div>
            <button type="button" className="model-settings__custom-add" onClick={openCreateWizard}>
              <Plus size={15} aria-hidden="true" />添加 Provider
            </button>
          </div>

          {providerNotice ? <p className="model-settings__custom-notice" role="status">{providerNotice}</p> : null}
          {providerError ? <p className="model-settings__custom-error" role="alert">{providerError}</p> : null}

          {customProviders.length ? (
            <div className="model-settings__custom-list">
              {customProviders.map(record => (
                <article key={record.providerId}>
                  <span className="model-settings__provider-icon" aria-hidden="true"><ServerCog size={18} /></span>
                  <div>
                    <strong>{record.displayName}</strong>
                    <small>{record.providerId} · {record.protocol === 'responses' ? 'Responses' : 'Chat Completions'}</small>
                    <code>{record.baseUrl}</code>
                  </div>
                  <span className="model-settings__custom-credential">
                    <KeyRound size={12} aria-hidden="true" />{record.hasApiKey ? '密钥已加密' : '无密钥'}
                  </span>
                  <div className="model-settings__custom-actions">
                    <button type="button" disabled={providerBusy} onClick={() => openEditWizard(record)}>编辑</button>
                    <button
                      type="button"
                      className="is-danger"
                      disabled={providerBusy}
                      onClick={() => { void removeCustomProvider(record) }}
                    >
                      <Trash2 size={13} aria-hidden="true" />删除
                    </button>
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="model-settings__empty">尚未添加自定义 Provider；内置 Provider 不受影响。</div>
          )}

          {wizardOpen ? (
            <form className="model-settings__custom-form" onSubmit={event => { void submitCustomProvider(event) }}>
              <div className="model-settings__custom-form-head">
                <div>
                  <strong>{editingProviderId ? '编辑自定义 Provider' : '添加自定义 Provider'}</strong>
                  <small>API Key 通过独立的一次性凭据入口提交，服务端不会回传明文。</small>
                </div>
                <button type="button" aria-label="关闭 Provider 配置" onClick={() => setWizardOpen(false)}>
                  <X size={16} aria-hidden="true" />
                </button>
              </div>

              <div className="model-settings__custom-fields">
                <label>
                  <span>Provider ID</span>
                  <input
                    value={draft.providerId}
                    required
                    maxLength={64}
                    pattern="[a-z0-9][a-z0-9_-]*"
                    disabled={Boolean(editingProviderId)}
                    placeholder="my-provider"
                    onChange={event => setDraft(current => ({ ...current, providerId: event.target.value }))}
                  />
                </label>
                <label>
                  <span>显示名称</span>
                  <input
                    value={draft.displayName}
                    required
                    maxLength={120}
                    placeholder="My AI Provider"
                    onChange={event => setDraft(current => ({ ...current, displayName: event.target.value }))}
                  />
                </label>
                <label className="is-wide">
                  <span>Base URL</span>
                  <input
                    type="url"
                    value={draft.baseUrl}
                    required
                    placeholder="https://api.provider.com/v1"
                    onChange={event => setDraft(current => ({ ...current, baseUrl: event.target.value }))}
                  />
                </label>
                <label>
                  <span>协议</span>
                  <select
                    value={draft.protocol}
                    onChange={event => setDraft(current => ({
                      ...current,
                      protocol: event.target.value as CustomProviderDraft['protocol'],
                    }))}
                  >
                    <option value="responses">Responses API</option>
                    <option value="chat_completions">Chat Completions</option>
                  </select>
                </label>
                <label>
                  <span>网络边界</span>
                  <select
                    value={draft.networkAccess}
                    onChange={event => setDraft(current => ({
                      ...current,
                      networkAccess: event.target.value as CustomProviderDraft['networkAccess'],
                    }))}
                  >
                    <option value="public">公网 HTTPS</option>
                    <option value="loopback">仅本机回环</option>
                  </select>
                </label>
                <label>
                  <span>工具 Schema</span>
                  <select
                    value={draft.toolSchemaMode}
                    onChange={event => setDraft(current => ({
                      ...current,
                      toolSchemaMode: event.target.value as CustomProviderDraft['toolSchemaMode'],
                    }))}
                  >
                    <option value="compatible">兼容模式</option>
                    <option value="strict">严格模式</option>
                  </select>
                </label>
                <label>
                  <span>API Key（留空则保留）</span>
                  <input
                    type="password"
                    value={draft.apiKey}
                    autoComplete="off"
                    placeholder={editingProviderId ? '已保存则保持不变' : '可选'}
                    onChange={event => setDraft(current => ({
                      ...current,
                      apiKey: event.target.value,
                      clearCredential: false,
                    }))}
                  />
                </label>
              </div>

              <section className="model-settings__custom-models" aria-label="模型能力快照">
                <div className="model-settings__custom-models-head">
                  <div>
                    <strong>模型能力快照</strong>
                    <small>上下文、能力与输入模态按模型独立生效。</small>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDraft(current => ({
                      ...current,
                      models: [...current.models, emptyCustomProviderModelDraft()],
                    }))}
                  >
                    <Plus size={13} aria-hidden="true" />添加模型
                  </button>
                </div>

                {draft.models.map((model, index) => (
                  <article key={index} className="model-settings__custom-model">
                    <div className="model-settings__custom-model-row">
                      <label>
                        <span>模型 ID</span>
                        <input
                          value={model.modelId}
                          required
                          maxLength={200}
                          placeholder="model-1"
                          onChange={event => updateDraftModelId(index, event.target.value)}
                        />
                      </label>
                      <label>
                        <span>上下文窗口</span>
                        <input
                          type="number"
                          min={1024}
                          max={10_000_000}
                          value={model.contextWindowTokens}
                          required
                          onChange={event => updateDraftModel(index, current => ({
                            ...current,
                            contextWindowTokens: event.target.value,
                          }))}
                        />
                      </label>
                      <label className="model-settings__custom-default">
                        <input
                          type="radio"
                          name="custom-provider-default-model"
                          checked={Boolean(model.modelId) && draft.defaultModel === model.modelId}
                          required
                          onChange={() => setDraft(current => ({ ...current, defaultModel: model.modelId }))}
                        />
                        默认模型
                      </label>
                      <button
                        type="button"
                        className="model-settings__custom-model-remove"
                        disabled={draft.models.length === 1}
                        aria-label={`删除模型 ${model.modelId || index + 1}`}
                        onClick={() => removeDraftModel(index)}
                      >
                        <Trash2 size={13} aria-hidden="true" />
                      </button>
                    </div>

                    <div className="model-settings__custom-model-options">
                      <fieldset className="model-settings__custom-modalities">
                        <legend>输入模态</legend>
                        {(['text', 'image', 'audio', 'pdf'] as const).map(modality => (
                          <label key={modality}>
                            <input
                              type="checkbox"
                              checked={model.modalities.includes(modality)}
                              disabled={modality === 'text'}
                              onChange={event => updateDraftModel(index, current => ({
                                ...current,
                                modalities: event.target.checked
                                  ? [...current.modalities, modality]
                                  : current.modalities.filter(item => item !== modality),
                              }))}
                            />
                            {modalityLabel(modality)}
                          </label>
                        ))}
                      </fieldset>

                      <fieldset className="model-settings__custom-modalities">
                        <legend>Agent 能力</legend>
                        {([
                          ['reasoning', '推理'],
                          ['structuredOutput', '结构化输出'],
                          ['toolCalls', '工具调用'],
                        ] as const).map(([capability, label]) => (
                          <label key={capability}>
                            <input
                              type="checkbox"
                              checked={model.capabilities[capability]}
                              onChange={event => updateDraftModel(index, current => ({
                                ...current,
                                capabilities: {
                                  ...current.capabilities,
                                  [capability]: event.target.checked,
                                },
                              }))}
                            />
                            {label}
                          </label>
                        ))}
                      </fieldset>
                    </div>
                  </article>
                ))}
              </section>

              {editingProviderId && customProviders.find(item => item.providerId === editingProviderId)?.hasApiKey ? (
                <label className="model-settings__custom-clear">
                  <input
                    type="checkbox"
                    checked={draft.clearCredential}
                    disabled={Boolean(draft.apiKey)}
                    onChange={event => setDraft(current => ({ ...current, clearCredential: event.target.checked }))}
                  />
                  删除已经保存的 API Key
                </label>
              ) : null}

              <div className="model-settings__custom-submit">
                <span>公网端点必须使用 HTTPS；本机模式只允许 localhost / 回环地址。</span>
                <button type="submit" disabled={providerBusy}>
                  {providerBusy ? '正在测试…' : '测试连接并保存'}
                </button>
              </div>
            </form>
          ) : null}
        </section>
      ) : null}

      <section className="model-settings__identity" aria-labelledby="product-identity-title">
        <span className="model-settings__identity-icon" aria-hidden="true">
          <Settings2 size={22} />
        </span>
        <div>
          <span className="model-settings__eyebrow">{canManageProviders ? '04' : '03'} · 工作台</span>
          <h2 id="product-identity-title">{productName}</h2>
          <p>显示名称保存在当前电脑，不改变安装包、协议、服务名称或已有数据目录。</p>
        </div>
        <button type="button" onClick={openProductSettings}>修改名称与连接</button>
      </section>

      <section className="model-settings__identity" aria-labelledby="identity-title">
        <span className="model-settings__identity-icon" aria-hidden="true">
          {authMode === 'local_auto' ? <ShieldCheck size={22} /> : <CircleUserRound size={22} />}
        </span>
        <div>
          <span className="model-settings__eyebrow">{canManageProviders ? '05' : '04'} · 身份</span>
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

interface CustomProviderDraft {
  providerId: string
  displayName: string
  baseUrl: string
  protocol: CustomProviderConfig['protocol']
  models: CustomProviderModelDraft[]
  defaultModel: string
  toolSchemaMode: CustomProviderConfig['toolSchemaMode']
  networkAccess: CustomProviderConfig['networkAccess']
  apiKey: string
  clearCredential: boolean
}

interface CustomProviderModelDraft {
  modelId: string
  contextWindowTokens: string
  capabilities: CustomProviderConfig['models'][number]['capabilities']
  modalities: CustomProviderConfig['models'][number]['modalities']
}

function emptyCustomProviderDraft(): CustomProviderDraft {
  return {
    providerId: '',
    displayName: '',
    baseUrl: '',
    protocol: 'responses',
    models: [emptyCustomProviderModelDraft()],
    defaultModel: '',
    toolSchemaMode: 'compatible',
    networkAccess: 'public',
    apiKey: '',
    clearCredential: false,
  }
}

function emptyCustomProviderModelDraft(): CustomProviderModelDraft {
  return {
    modelId: '',
    contextWindowTokens: '128000',
    capabilities: { reasoning: true, structuredOutput: true, toolCalls: true },
    modalities: ['text'],
  }
}

function draftFromRecord(record: CustomProviderRecord): CustomProviderDraft {
  return {
    providerId: record.providerId,
    displayName: record.displayName,
    baseUrl: record.baseUrl,
    protocol: record.protocol,
    models: record.models.map(model => ({
      modelId: model.modelId,
      contextWindowTokens: String(model.contextWindowTokens),
      capabilities: { ...model.capabilities },
      modalities: [...model.modalities],
    })),
    defaultModel: record.defaultModel,
    toolSchemaMode: record.toolSchemaMode,
    networkAccess: record.networkAccess,
    apiKey: '',
    clearCredential: false,
  }
}

function parseCustomProviderDraft(draft: CustomProviderDraft): CustomProviderConfig {
  return customProviderConfigSchema.parse({
    providerId: draft.providerId.trim(),
    displayName: draft.displayName.trim(),
    baseUrl: draft.baseUrl.trim(),
    protocol: draft.protocol,
    models: draft.models.map(model => ({
      modelId: model.modelId.trim(),
      contextWindowTokens: Number(model.contextWindowTokens),
      capabilities: model.capabilities,
      modalities: model.modalities,
    })),
    defaultModel: draft.defaultModel.trim(),
    toolSchemaMode: draft.toolSchemaMode,
    networkAccess: draft.networkAccess,
  })
}

async function refreshCustomProviders(
  apply: (providers: CustomProviderRecord[]) => void,
): Promise<void> {
  apply(await listCustomProviders())
}

function modalityLabel(modality: CustomProviderConfig['models'][number]['modalities'][number]): string {
  if (modality === 'text') return '文本'
  if (modality === 'image') return '图片'
  if (modality === 'audio') return '音频'
  return 'PDF'
}

function formatProviderError(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  return fallback
}

function uniqueModels(provider: ModelProviderDescriptor | undefined): string[] {
  if (!provider) return []
  return [...new Set([
    provider.defaultModel,
    ...provider.availableModels,
  ].filter((value): value is string => Boolean(value?.trim())))]
}

function modelCapabilityLabel(
  isDefault: boolean,
  model: ModelProviderDescriptor['models'][number] | undefined,
): string {
  if (!model) return isDefault ? '默认模型' : '可用模型'
  const window = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 })
    .format(model.contextWindowTokens)
  const modalities = model.modalities.map(modalityLabel).join('/')
  return `${isDefault ? '默认模型' : '可用模型'} · ${window} 词元 · ${modalities}`
}
