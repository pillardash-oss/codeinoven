<script lang="ts">
  import CioActions from '@codeinoven/icons/CioActions.svelte'
  import CioArrowLeft from '@codeinoven/icons/CioArrowLeft.svelte'
  import CioClipboardPaste from '@codeinoven/icons/CioClipboardPaste.svelte'
  import CioClose from '@codeinoven/icons/CioClose.svelte'
  import CioCopy from '@codeinoven/icons/CioCopy.svelte'
  import CioPlus from '@codeinoven/icons/CioPlus.svelte'
  import CioRefresh from '@codeinoven/icons/CioRefresh.svelte'
  import CioServer from '@codeinoven/icons/CioServer.svelte'
  import CioSpinner from '@codeinoven/icons/CioSpinner.svelte'
  import { customVendorIcons } from '$lib/stores/custom-vendor-icons.svelte'
  import { MAX_CUSTOM_VENDOR_ICON_BYTES, isCustomVendorIconType } from '$shared/custom-vendor-icon'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { toast } from 'svelte-sonner'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { copyText, notifyClipboard } from '$lib/copy-text'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { findFirstTextField, findPanelPrimaryAction } from '$lib/modal-primary-action.svelte'
  import { APP_SLUG } from '$shared/brand'
  import DockableModal from '../ui/DockableModal.svelte'
  import DockRow from '../ui/DockRow.svelte'
  import EnumSelect from '../ui/EnumSelect.svelte'
  import Switch from '../ui/Switch.svelte'
  import UsageWindowList from '../shared/UsageWindowList.svelte'
  import { creditsLabel } from '$lib/format/usage'
  import {
    PROVIDER_USAGE_FORMATS,
    providerUsageFormatEndpoint
  } from '$shared/provider-usage-format'
  import HarnessToggleGroup from '../shared/HarnessToggleGroup.svelte'
  import {
    parseModelClipboard,
    parseProviderClipboard,
    serializeModelClipboard
  } from '$shared/provider-clipboard'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import type {
    BaseUrlProvider,
    BaseUrlProviderCopyClipboardRequest,
    BaseUrlProviderCreateRequest,
    BaseUrlProviderModel,
    BaseUrlProviderUpdateRequest,
    BaseUrlProviderUsageFormat,
    BaseUrlProviderUsagePreview,
    DiscoveredBaseUrlModel,
    ProviderConnectionInfo,
    ThinkingLevel
  } from '$shared/types'

  interface Props {
    /** Provider being edited, or null for create mode. Mounted conditionally. */
    provider: BaseUrlProvider | null
    /** Harness options shown in the create-mode Harness picker. */
    harnesses: ProviderConnectionInfo[]
    /** Harness pre-selected for create mode. */
    defaultHarnessId: string
    onClose: () => void
    /** Invoked with the persisted provider after a successful save. */
    onSaved: (provider: BaseUrlProvider) => void
    /** Shown as a footer "Back" button when set   lets a caller that opened
     *  this editor from its own modal (e.g. Add provider) return there
     *  instead of closing everything. */
    onBack?: () => void
  }

  interface ModelDraft {
    id: string
    name: string
    contextWindow: string
    maxOutputTokens: string
    reasoning: boolean
    defaultThinkingLevel: ThinkingLevel | ''
    vision: boolean
  }

  interface ProviderDraft {
    id: string | null
    /** Harnesses this provider is linked to. Saving applies the shared fields
     *  below to every one of them, creating/removing per-harness records as
     *  the selection changes. */
    harnessIds: string[]
    npm: string
    name: string
    baseURL: string
    apiKey: string
    removeApiKey: boolean
    headers: string
    /** Optional usage route (e.g. /status or /usage) or absolute URL. */
    usagePath: string
    /** Response format of the usage route; empty means auto-detect. */
    usageFormat: BaseUrlProviderUsageFormat | ''
    /** Optional model-list route (defaults to /models when empty). */
    modelsPath: string
    models: ModelDraft[]
    enabled: boolean
  }

  const NPM_OPTIONS = [
    { value: '@ai-sdk/openai-compatible', label: 'OpenAI-compatible (/v1/chat/completions)' },
    { value: '@ai-sdk/openai', label: 'OpenAI (/v1/responses)' },
    { value: '@ai-sdk/anthropic', label: 'Anthropic (/v1/messages)' }
  ] as const

  const THINKING_LEVELS: ThinkingLevel[] = [
    'minimal',
    'low',
    'medium',
    'high',
    'xhigh',
    'max',
    'ultra'
  ]

  /** The main-process provider service persists at most 128 models per provider. */
  const MAX_DISCOVERED_MODELS_TO_SAVE = 128

  /** Mirror of the service's SAFE_MODEL_ID: ids routinely include slashes/at-signs
   *  (LM Studio `org/model`, HF `org/model@precision`)   anything else would
   *  make the whole save fail main-process validation, so it is skipped here. */
  const SAFE_DISCOVERED_MODEL_ID = /^[a-zA-Z0-9@][a-zA-Z0-9._:/@+-]*$/u

  interface QuickPreset {
    name: string
    baseURL: string
    modelId: string
    modelName: string
    npm: (typeof NPM_OPTIONS)[number]['value']
  }

  /** Local OpenAI-compatible servers, pre-filled so connecting is one click. */
  const QUICK_PRESETS: QuickPreset[] = [
    {
      name: 'Ollama',
      baseURL: 'http://localhost:11434/v1',
      modelId: 'llama3.1',
      modelName: 'Llama 3.1',
      npm: '@ai-sdk/openai-compatible'
    },
    {
      name: 'LM Studio',
      baseURL: 'http://localhost:1234/v1',
      modelId: 'local-model',
      modelName: 'Local Model',
      npm: '@ai-sdk/openai-compatible'
    },
    {
      name: 'llama.cpp',
      baseURL: 'http://localhost:8080/v1',
      modelId: 'local-model',
      modelName: 'Local Model',
      npm: '@ai-sdk/openai-compatible'
    }
  ]

  let { provider, harnesses, defaultHarnessId, onClose, onSaved, onBack }: Props = $props()

  /**
   * Owns the panel's remembered placement, shared with the dock row below so a
   * minimized editor reopens on the edge the user left it on.
   */
  const PANEL_STORAGE_KEY = `${APP_SLUG}.baseUrlProviderPanel.v1`

  /**
   * Whether the panel is collapsed into its dock chip.
   *
   * Docking is what makes this editor usable while the app stays in reach: the
   * user can minimize it and watch the provider appear in the model picker, or
   * copy a base URL from a document, instead of being held inside a blocking
   * dialog. The draft lives here, so the panel stays mounted while docked and
   * nothing typed is lost by collapsing it.
   */
  let docked = $state(false)
  let iconDataUrl = $state<string | undefined>()
  let readingIcon = $state(false)
  let submitting = $state(false)
  let iconUploadDisabled = $derived(readingIcon || baseUrlProviderStore.saving || submitting)
  let iconPreview = $derived(iconDataUrl ?? customVendorIcons.get(provider?.id))

  async function chooseIcon(event: Event): Promise<void> {
    const input = event.currentTarget
    if (!(input instanceof HTMLInputElement)) return
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    readingIcon = true
    try {
      if (!isCustomVendorIconType(file.type) || file.size > MAX_CUSTOM_VENDOR_ICON_BYTES) {
        throw new Error('Choose an SVG, PNG, JPEG, WebP or GIF of at most 256 KiB.')
      }
      const data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () =>
          typeof reader.result === 'string'
            ? resolve(reader.result)
            : reject(new Error('Cannot read image.'))
        reader.onerror = () => reject(new Error('Cannot read image.'))
        reader.readAsDataURL(file)
      })
      const image = new Image()
      image.src = data
      await image.decode()
      if (image.naturalWidth > 2048 || image.naturalHeight > 2048) {
        throw new Error('Choose an icon no larger than 2048 × 2048.')
      }
      iconDataUrl = data
    } catch (error) {
      reportError(error, 'Failed to read vendor icon.')
    } finally {
      readingIcon = false
    }
  }

  /**
   * The app's modal focus rule: the first field the user would type into, else
   * the primary action. `ui/Modal.svelte` applied this on open, so the panel
   * claims it explicitly rather than letting the switch to `DockableModal`
   * quietly drop it.
   */
  function claimPanelInitialFocus(panel: HTMLElement): boolean {
    const field = findFirstTextField(panel)
    if (field) {
      field.focus()
      return true
    }
    const action = findPanelPrimaryAction(panel)
    if (!action) return false
    action.focus()
    return true
  }

  /**
   * Harnesses whose driver consumes custom base-URL providers. When the prop
   * is empty (e.g. the panel mounted before provider discovery finished), fall
   * back to the live provider store so the section is never blank.
   */
  let availableHarnesses = $derived.by(() => {
    const fromProp = harnesses.filter(
      (harness) => harness.supportsCustomProviders && harness.integration === 'ready'
    )
    if (fromProp.length > 0) return fromProp
    return providerStore.providers.filter(
      (provider) => provider.supportsCustomProviders && provider.integration === 'ready'
    )
  })

  /** Every persisted record sharing this provider's id   one per linked
   *  harness. Empty in create mode. Fields are kept in sync across the group,
   *  so any member's values are representative of the whole group. */
  let linkedProviders = $derived(
    provider ? baseUrlProviderStore.providers.filter((p) => p.id === provider.id) : []
  )

  let draft = $state<ProviderDraft>(createDraft())

  /**
   * What the dock chip says. The panel keeps the draft alive while it is
   * collapsed, so the chip names the provider the user is working on instead of
   * letting a bare "base URL provider" chip lose track of which of several
   * drafts is docked.
   */
  const dockStatus = $derived(draft.name.trim() || 'Untitled provider')
  const dockRestoreLabel = $derived(`Show the base URL provider form (${dockStatus})`)
  const dockDismissLabel = $derived(`Close the base URL provider form (${dockStatus})`)
  let apiKeyConfigured = $derived(
    linkedProviders.some((p) => p.apiKeyConfigured === true || p.apiKeyRef !== undefined)
  )
  /** Newly-checked harnesses can't inherit a key they never had   the vault
   *  only exposes ciphertext, so main can't silently copy it across. */
  let addingHarnessWithoutKey = $derived(
    apiKeyConfigured &&
      !draft.apiKey &&
      draft.harnessIds.some((id) => !linkedProviders.some((p) => p.harnessId === id))
  )

  /** Models found at `${baseURL}/models`, offered as one-click adds when the
   *  draft has none of its own yet. Cached in main for 24h; `force` bypasses that. */
  let discoveredModels = $state<DiscoveredBaseUrlModel[]>([])
  let discoveringModels = $state(false)
  let discoverError = $state('')

  /** Result of the last usage-route Test, shown inline under the format picker. */
  let usagePreview = $state<BaseUrlProviderUsagePreview | null>(null)
  let testingUsage = $state(false)
  const activeUsageFormat = $derived<BaseUrlProviderUsageFormat>(draft.usageFormat || 'auto')
  const usageFormatHint = $derived(
    PROVIDER_USAGE_FORMATS.find((option) => option.value === activeUsageFormat)?.hint ?? ''
  )
  const usageFormatOptions = PROVIDER_USAGE_FORMATS.map((option) => ({
    id: option.value,
    label: option.label,
    hint: option.hint
  }))

  /**
   * Picking a format fills in the route that format knows how to read, so the
   * user can pick and test without having to recall an endpoint. A route the
   * user typed by hand is never clobbered   only an empty field, or one still
   * holding the previous format's own default, is replaced.
   */
  function applyUsageFormat(format: BaseUrlProviderUsageFormat): void {
    const previousEndpoint = providerUsageFormatEndpoint(activeUsageFormat)
    const current = draft.usagePath.trim()
    draft.usageFormat = format
    if (!current || current === previousEndpoint) {
      draft.usagePath = providerUsageFormatEndpoint(format) ?? ''
    }
    usagePreview = null
  }

  /** Read the usage route as configured in the draft, before saving. */
  async function testUsage(): Promise<void> {
    const usagePath = draft.usagePath.trim()
    if (!usagePath) {
      toast.error('Pick a response format or enter a usage endpoint first.')
      return
    }
    if (!draft.baseURL.trim()) {
      toast.error('Enter the provider base URL first.')
      return
    }
    testingUsage = true
    usagePreview = null
    try {
      const headers = parseHeaders(draft.headers)
      usagePreview = await baseUrlProviderStore.previewUsage({
        baseURL: draft.baseURL.trim(),
        usagePath,
        ...(draft.id ? { id: draft.id, harnessId: draft.harnessIds[0] } : {}),
        ...(draft.usageFormat ? { usageFormat: draft.usageFormat } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        ...(headers ? { headers } : {})
      })
    } catch (usageError) {
      reportError(usageError, 'Usage preview failed.')
    } finally {
      testingUsage = false
    }
  }

  async function discoverModels(force = false): Promise<void> {
    if (!draft.baseURL.trim()) return
    discoveringModels = true
    discoverError = ''
    try {
      discoveredModels = await baseUrlProviderStore.fetchModels({
        baseURL: draft.baseURL.trim(),
        ...(draft.id ? { id: draft.id, harnessId: draft.harnessIds[0] } : {}),
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        ...(parseHeaders(draft.headers) ? { headers: parseHeaders(draft.headers) } : {}),
        ...(draft.modelsPath.trim() ? { modelsPath: draft.modelsPath.trim() } : {}),
        force
      })
    } catch (fetchError) {
      discoverError =
        fetchError instanceof Error ? fetchError.message : 'Failed to fetch model list.'
    } finally {
      discoveringModels = false
    }
  }

  /** Persisted model rows for the provider, ready to hand to the save flow.
   *  When the user defined no models of their own, every model discovered from
   *  `${baseURL}/models` becomes a provider model so the provider is usable the
   *  moment it is saved   the picker cache already overlays saved providers. */
  async function resolveModelsToSave(
    headers: Record<string, string> | undefined
  ): Promise<Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }>> {
    if (draft.models.length > 0) return buildModels()
    const baseURL = draft.baseURL.trim()
    if (!baseURL) return []
    let models = discoveredModels
    if (models.length === 0) {
      // Fresh discovery (never the 24h cache) so a just-saved provider never
      // inherits a stale list from an earlier base-URL probe.
      try {
        models = await baseUrlProviderStore.fetchModels({
          baseURL,
          ...(draft.id ? { id: draft.id, harnessId: draft.harnessIds[0] } : {}),
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
          ...(headers ? { headers } : {}),
          ...(draft.modelsPath.trim() ? { modelsPath: draft.modelsPath.trim() } : {}),
          force: true
        })
        discoveredModels = models
      } catch {
        // Unreachable endpoint   save proceeds with no models; the picker
        // still shows the provider and the editor keeps its error surfaced.
        return []
      }
    }
    return models
      .filter((model) => SAFE_DISCOVERED_MODEL_ID.test(model.id))
      .slice(0, MAX_DISCOVERED_MODELS_TO_SAVE)
      .map((model) => ({
        id: model.id,
        name: (model.name || model.id).slice(0, 256),
        // Most current models can reason; an endpoint that doesn't expose a
        // reasoning flag isn't evidence the model can't. Off-by-default just
        // hid the thinking controls for models that support them.
        reasoning: true,
        ...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
      }))
  }

  function addDiscoveredModel(model: DiscoveredBaseUrlModel): void {
    if (draft.models.some((m) => m.id === model.id)) return
    draft.models = [
      ...draft.models,
      {
        ...emptyModelDraft(),
        id: model.id,
        name: model.name,
        reasoning: true,
        contextWindow: model.contextWindow ? String(model.contextWindow) : ''
      }
    ]
  }

  /** Auto-search once a base URL is typed and the draft has no models of its
   *  own yet   debounced so it doesn't refire on every keystroke. */
  $effect(() => {
    const baseURL = draft.baseURL.trim()
    if (draft.models.length > 0 || !baseURL || discoveredModels.length > 0) return
    const timer = setTimeout(() => void discoverModels(false), 500)
    return () => clearTimeout(timer)
  })

  /** Seed the draft from the edited provider's linked group, or start blank
   * for create mode. The component is mounted per-edit, so the initial prop
   * value is authoritative. */
  function createDraft(): ProviderDraft {
    if (provider) {
      return {
        id: provider.id,
        harnessIds: linkedProviders.map((p) => p.harnessId),
        npm: provider.npm,
        name: provider.name,
        baseURL: provider.baseURL,
        apiKey: '',
        removeApiKey: false,
        headers: provider.headers
          ? Object.entries(provider.headers)
              .map(([key, value]) => `${key}: ${value}`)
              .join('\n')
          : '',
        usagePath: provider.usagePath ?? '',
        usageFormat: provider.usageFormat ?? 'auto',
        modelsPath: provider.modelsPath ?? '',
        models: provider.models.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow?.toString() ?? '',
          maxOutputTokens: model.maxOutputTokens?.toString() ?? '',
          reasoning: model.reasoning,
          defaultThinkingLevel: model.defaultThinkingLevel ?? '',
          vision: model.vision ?? true
        })),
        enabled: provider.enabled
      }
    }
    return emptyDraft()
  }

  function emptyModelDraft(): ModelDraft {
    return {
      id: '',
      name: '',
      contextWindow: '',
      maxOutputTokens: '',
      reasoning: false,
      defaultThinkingLevel: '',
      vision: true
    }
  }

  function emptyDraft(): ProviderDraft {
    return {
      id: null,
      harnessIds: [
        availableHarnesses.some((harness) => harness.id === defaultHarnessId)
          ? defaultHarnessId
          : (availableHarnesses[0]?.id ?? DEFAULT_HARNESS)
      ],
      npm: NPM_OPTIONS[0].value,
      name: '',
      baseURL: '',
      apiKey: '',
      removeApiKey: false,
      headers: '',
      usagePath: '',
      usageFormat: 'auto',
      modelsPath: '',
      models: [],
      enabled: true
    }
  }

  /** Toggle a harness in or out of the linked set. At least one must stay selected. */
  function toggleHarness(id: string): void {
    if (draft.harnessIds.includes(id)) {
      if (draft.harnessIds.length === 1) return
      draft.harnessIds = draft.harnessIds.filter((harnessId) => harnessId !== id)
    } else {
      draft.harnessIds = [...draft.harnessIds, id]
    }
  }

  function applyPreset(preset: QuickPreset): void {
    const harnessIds = draft.harnessIds
    draft = emptyDraft()
    draft.harnessIds = harnessIds
    draft.name = preset.name
    draft.baseURL = preset.baseURL
    draft.npm = preset.npm
    draft.models = [
      {
        id: preset.modelId,
        name: preset.modelName,
        contextWindow: '',
        maxOutputTokens: '',
        reasoning: false,
        defaultThinkingLevel: '',
        vision: true
      }
    ]
  }

  function addModel(): void {
    draft.models = [...draft.models, emptyModelDraft()]
  }

  function removeModel(index: number): void {
    draft.models = draft.models.filter((_, i) => i !== index)
  }

  function parseHeaders(value: string): Record<string, string> | undefined {
    const headers: Record<string, string> = {}
    for (const rawLine of value.split('\n')) {
      const line = rawLine.trim()
      if (!line) continue
      const separator = line.indexOf(':')
      if (separator < 1) throw new Error(`Header must use Name: Value   ${line}`)
      const name = line.slice(0, separator).trim()
      const headerValue = line.slice(separator + 1).trim()
      if (!name || !headerValue) throw new Error(`Header must include a name and value   ${line}`)
      headers[name] = headerValue
    }
    return Object.keys(headers).length > 0 ? headers : undefined
  }

  function buildModels(): Array<Omit<BaseUrlProviderModel, 'id' | 'providerId'> & { id?: string }> {
    return draft.models.map((model) => {
      const id = model.id.trim() || model.name.trim()
      if (!id) throw new Error('Every model needs an ID or name.')
      return {
        id,
        name: model.name.trim() || id,
        reasoning: model.reasoning,
        vision: model.vision,
        ...(model.contextWindow.trim()
          ? { contextWindow: Number.parseInt(model.contextWindow, 10) }
          : {}),
        ...(model.maxOutputTokens.trim()
          ? { maxOutputTokens: Number.parseInt(model.maxOutputTokens, 10) }
          : {}),
        ...(model.defaultThinkingLevel
          ? { defaultThinkingLevel: model.defaultThinkingLevel as ThinkingLevel }
          : {})
      }
    })
  }

  /**
   * Applies the draft to every selected harness: updates records already
   * linked, deletes ones the user unchecked, and creates new ones for
   * newly-checked harnesses   all sharing the same provider id so they stay
   * linked. A brand-new provider seeds the id from its first created record.
   */
  async function save(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    if (readingIcon || submitting) return
    if (draft.harnessIds.length === 0) {
      toast.error('Select at least one harness.')
      return
    }
    const wasEditing = draft.id !== null
    submitting = true
    try {
      const headers = parseHeaders(draft.headers)
      const models = await resolveModelsToSave(headers)
      const currentHarnessIds = baseUrlProviderStore.providers
        .filter((candidate) => candidate.id === draft.id)
        .map((candidate) => candidate.harnessId)
      const toKeep = draft.harnessIds.filter((id) => currentHarnessIds.includes(id))
      const toRemove = currentHarnessIds.filter((id) => !draft.harnessIds.includes(id))
      const toAdd = draft.harnessIds.filter((id) => !currentHarnessIds.includes(id))

      let groupId = draft.id ?? undefined
      let saved: BaseUrlProvider | undefined

      if (groupId) {
        const patch: BaseUrlProviderUpdateRequest = {
          npm: draft.npm,
          name: draft.name.trim(),
          baseURL: draft.baseURL.trim(),
          models,
          enabled: draft.enabled,
          usagePath: draft.usagePath.trim(),
          usageFormat: draft.usageFormat,
          modelsPath: draft.modelsPath.trim(),
          ...(headers === undefined ? {} : { headers }),
          ...(draft.removeApiKey ? { removeApiKey: true } : {}),
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {})
        }
        for (const harnessId of toKeep) {
          saved = await baseUrlProviderStore.update(harnessId, groupId, patch)
        }
        for (const harnessId of toRemove) {
          await baseUrlProviderStore.remove(harnessId, groupId)
        }
      }

      for (const harnessId of toAdd) {
        const input: BaseUrlProviderCreateRequest = {
          harnessId,
          npm: draft.npm,
          name: draft.name.trim(),
          baseURL: draft.baseURL.trim(),
          models,
          enabled: draft.enabled,
          ...(draft.usagePath.trim() ? { usagePath: draft.usagePath.trim() } : {}),
          ...(draft.usageFormat ? { usageFormat: draft.usageFormat } : {}),
          ...(draft.modelsPath.trim() ? { modelsPath: draft.modelsPath.trim() } : {}),
          ...(headers === undefined ? {} : { headers }),
          ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
          ...(groupId ? { id: groupId } : {})
        }
        saved = await baseUrlProviderStore.create(input)
        groupId = saved.id
        draft.id = saved.id
      }

      if (!saved) throw new Error('No harness selected to save.')
      if (iconDataUrl) await customVendorIcons.save(saved.id, iconDataUrl)
      toast.success(wasEditing ? 'Provider updated.' : 'Provider created.')
      onSaved(saved)
    } catch (saveError) {
      reportError(saveError, 'Failed to save provider.')
    } finally {
      submitting = false
    }
  }

  function copyModelDraft(model: ModelDraft): void {
    void copyText(serializeModelClipboard(model), `Copied “${model.name || model.id}”.`).catch(
      (copyError) => reportError(copyError, 'Clipboard copy failed.')
    )
  }

  async function pasteModelFromClipboard(): Promise<void> {
    try {
      const text = await invoke('clipboard:readText')
      const model = parseModelClipboard(text)
      draft.models = [...draft.models, modelToDraft(model)]
      toast.success(`Added “${model.name || model.id}” from clipboard.`)
    } catch (pasteError) {
      reportError(pasteError, 'Clipboard paste failed.')
    }
  }

  /** Copy the whole provider, resolving the vaulted API key in main for saved providers.
   *  For a multi-harness link, the first selected harness's stored key is used. */
  async function copyProviderDraft(): Promise<void> {
    try {
      const request: BaseUrlProviderCopyClipboardRequest = {
        harnessId: draft.harnessIds[0],
        ...(draft.id ? { id: draft.id } : {}),
        npm: draft.npm,
        name: draft.name,
        baseURL: draft.baseURL,
        ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
        headers: draft.headers,
        usagePath: draft.usagePath,
        usageFormat: draft.usageFormat,
        modelsPath: draft.modelsPath,
        models: draft.models,
        enabled: draft.enabled
      }
      await invoke('baseUrlProviders:copyProviderToClipboard', request)
      notifyClipboard(`Copied “${draft.name || 'provider'}”.`)
    } catch (copyError) {
      reportError(copyError, 'Clipboard copy failed.')
    }
  }

  /** Overwrite the draft from a copied provider, keeping the current form's harnesses. */
  async function pasteProviderFromClipboard(): Promise<void> {
    try {
      const text = await invoke('clipboard:readText')
      const provider = parseProviderClipboard(text)
      draft = {
        ...draft,
        npm: provider.npm,
        name: provider.name,
        baseURL: provider.baseURL,
        apiKey: provider.apiKey,
        removeApiKey: false,
        headers: provider.headers,
        ...(provider.usagePath ? { usagePath: provider.usagePath } : {}),
        usageFormat: provider.usageFormat ?? '',
        ...(provider.modelsPath ? { modelsPath: provider.modelsPath } : {}),
        models: provider.models.map(modelToDraft),
        enabled: provider.enabled
      }
      toast.success(`Pasted “${provider.name}”.`)
    } catch (pasteError) {
      reportError(pasteError, 'Clipboard paste failed.')
    }
  }

  function modelToDraft(model: {
    id: string
    name: string
    contextWindow: string
    maxOutputTokens: string
    reasoning: boolean
    defaultThinkingLevel: ThinkingLevel | ''
    vision: boolean
  }): ModelDraft {
    return {
      id: model.id,
      name: model.name,
      contextWindow: model.contextWindow,
      maxOutputTokens: model.maxOutputTokens,
      reasoning: model.reasoning,
      defaultThinkingLevel: model.defaultThinkingLevel,
      vision: model.vision
    }
  }
</script>

<DockableModal
  open
  title={provider ? 'Edit base URL provider' : 'Add base URL provider'}
  minimized={docked}
  closable={!baseUrlProviderStore.saving && !submitting}
  onMinimize={() => (docked = true)}
  {onClose}
  storageKey={PANEL_STORAGE_KEY}
  dragLabel="Drag to move the base URL provider panel"
  defaultHeight={640}
  claimInitialFocus={claimPanelInitialFocus}
>
  {#snippet dock()}
    <DockRow storageKey={PANEL_STORAGE_KEY} label="Move docked base URL provider">
      <div class="flex items-center gap-1 border bg-surface p-1.5 shadow-xl">
        <button
          type="button"
          class="flex min-w-0 cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-elevated"
          title={dockRestoreLabel}
          aria-label={dockRestoreLabel}
          onclick={() => (docked = false)}
        >
          <CioServer size={14} class="shrink-0 text-dimmed" aria-hidden="true" />
          <span class="flex min-w-0 flex-col">
            <span class="text-[0.6875rem] leading-tight font-medium text-foreground">
              {provider ? 'Edit base URL provider' : 'Add base URL provider'}
            </span>
            <span class="max-w-40 truncate text-[0.625rem] leading-tight text-muted">
              {dockStatus}
            </span>
          </span>
        </button>
        <span class="h-5 w-px shrink-0 bg-border" aria-hidden="true"></span>
        <button
          type="button"
          class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
          aria-label={dockDismissLabel}
          title={dockDismissLabel}
          disabled={submitting}
          onclick={onClose}
        >
          <CioClose size={14} />
        </button>
      </div>
    </DockRow>
  {/snippet}

  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-3">
      <div class="flex items-center gap-3">
        {#if onBack}
          <button
            class="flex h-9 items-center gap-1.5 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
            type="button"
            data-modal-dismiss
            title="Back to Add provider"
            disabled={submitting}
            onclick={onBack}
          >
            <CioArrowLeft size={13} /> Back
          </button>
        {/if}
        <Switch bind:checked={draft.enabled} label="Enabled" class="font-medium" />
      </div>
      <div class="flex items-center gap-2">
        <button
          class="h-9 border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
          type="button"
          data-modal-dismiss
          disabled={submitting}
          onclick={onClose}
        >
          Cancel
        </button>
        <button
          class="flex h-9 items-center gap-1.5 bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="submit"
          data-modal-primary
          form="base-url-provider-form"
          disabled={baseUrlProviderStore.saving || readingIcon || submitting}
        >
          {#if baseUrlProviderStore.saving || submitting}<CioSpinner
              size={13}
              class="animate-spin"
            />{/if}
          Save provider
        </button>
      </div>
    </div>
  {/snippet}

  <form id="base-url-provider-form" class="space-y-4" onsubmit={save}>
    <fieldset class="space-y-1.5 text-xs font-medium">
      <legend>Harnesses</legend>
      <p class="text-[0.6875rem] font-normal text-dimmed">
        Select every harness that should offer this provider. Saving applies your changes to all of
        them.
      </p>
      <HarnessToggleGroup
        options={availableHarnesses.map((harness) => ({ id: harness.id, name: harness.name }))}
        value={draft.harnessIds}
        disabled={baseUrlProviderStore.saving}
        onToggle={toggleHarness}
      />
      {#if addingHarnessWithoutKey}
        <p class="text-[0.6875rem] text-warning">
          Newly-added harnesses won't get the stored API key re-enter it below to apply it there
          too.
        </p>
      {/if}
    </fieldset>

    <div class="space-y-1.5">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs font-medium">{provider === null ? 'Quick start' : 'Provider'}</span>
        {#if provider === null}
          {#each QUICK_PRESETS as preset (preset.name)}
            <button
              class="flex h-8 items-center gap-1.5 border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
              type="button"
              title="Pre-fill {preset.name} settings"
              onclick={() => applyPreset(preset)}
            >
              {preset.name}
            </button>
          {/each}
        {/if}
        <span class="ml-auto flex items-center gap-1.5">
          <button
            class="flex h-8 items-center gap-1.5 border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
            type="button"
            title="Copy this provider (including API key) to the clipboard"
            onclick={() => void copyProviderDraft()}
          >
            <CioCopy size={12} /> Copy
          </button>
          <button
            class="flex h-8 items-center gap-1.5 border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
            type="button"
            title="Paste a copied provider over this form"
            onclick={() => void pasteProviderFromClipboard()}
          >
            <CioClipboardPaste size={12} /> Paste
          </button>
        </span>
      </div>
    </div>

    <label
      class={[
        'flex items-center gap-3 border bg-surface p-3 transition-colors duration-150 focus-within:border-primary focus-within:bg-elevated',
        iconUploadDisabled
          ? 'cursor-default opacity-60'
          : 'cursor-pointer hover:border-primary/40 hover:bg-elevated'
      ]}
    >
      <span
        class="flex h-12 w-12 shrink-0 items-center justify-center border border-border bg-elevated"
      >
        <VendorIcon name="CodeInOven" imageSrc={iconPreview} size={iconPreview ? 40 : 32} />
      </span>
      <span class="min-w-0 flex-1 space-y-1 text-xs font-medium">
        <span>Vendor icon</span>
        <input
          type="file"
          accept="image/svg+xml,image/png,image/jpeg,image/webp,image/gif"
          class="block w-full cursor-pointer text-xs text-dimmed file:cursor-pointer disabled:cursor-default disabled:file:cursor-default"
          disabled={iconUploadDisabled}
          onchange={(event) => void chooseIcon(event)}
        />
        <span class="block text-dimmed">SVG or image, up to 256 KiB. Saved with this provider.</span
        >
      </span>
    </label>

    <label class="block space-y-1 text-xs font-medium">
      <span>Display name</span>
      <input
        class="h-9 w-full border bg-elevated px-3 text-sm outline-none focus:border-primary"
        placeholder="My AI Provider"
        required
        bind:value={draft.name}
      />
    </label>

    <label class="block space-y-1 text-xs font-medium">
      <span>SDK package</span>
      <select
        class="h-9 w-full border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
        bind:value={draft.npm}
      >
        {#each NPM_OPTIONS as option (option.value)}
          <option value={option.value}>{option.label}</option>
        {/each}
      </select>
    </label>

    <label class="block space-y-1 text-xs font-medium">
      <span>Base URL</span>
      <input
        class="h-9 w-full border bg-elevated px-3 text-sm font-mono outline-none focus:border-primary"
        placeholder="https://api.example.com/v1"
        required
        bind:value={draft.baseURL}
      />
    </label>

    <label class="block space-y-1 text-xs font-medium" for="base-url-provider-api-key">
      <span>{draft.id ? 'API key' : 'API key (optional)'}</span>
      <input
        id="base-url-provider-api-key"
        class="h-9 w-full border bg-elevated px-3 text-sm font-mono outline-none focus:border-primary"
        placeholder={apiKeyConfigured ? 'Stored securely   enter a new key to replace' : 'sk-...'}
        autocomplete="off"
        spellcheck="false"
        disabled={draft.removeApiKey}
        bind:value={draft.apiKey}
      />
    </label>
    {#if draft.id && apiKeyConfigured}
      <div class="space-y-2 bg-raised px-3 py-2">
        <p id="stored-api-key-status" class="text-[0.6875rem] text-muted">
          An API key is stored securely. Leave the field blank to keep it.
        </p>
        <Switch
          checked={draft.removeApiKey}
          activeClass="bg-danger"
          aria-describedby="stored-api-key-status"
          onchange={(checked) => {
            draft.removeApiKey = checked
            if (checked) draft.apiKey = ''
          }}
        >
          <span class="text-[0.6875rem] font-medium {draft.removeApiKey ? 'text-danger' : ''}">
            Remove API key when saving
          </span>
        </Switch>
      </div>
    {:else if draft.id}
      <p class="text-[0.6875rem] text-dimmed">No API key is stored. Enter one to add it.</p>
    {/if}

    <label class="block space-y-1 text-xs font-medium">
      <span>Custom headers · one Name: Value per line</span>
      <textarea
        class="min-h-16 w-full border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
        placeholder="Authorization: Bearer token"
        autocomplete="off"
        spellcheck="false"
        bind:value={draft.headers}></textarea>
    </label>

    <div class="space-y-3 border bg-surface/40 px-3 py-2.5">
      <div class="flex items-center justify-between gap-2">
        <span class="text-xs font-medium">Usage &amp; limits</span>
        <button
          type="button"
          class="flex h-8 shrink-0 items-center gap-1.5 border bg-elevated px-3 text-xs font-medium hover:bg-overlay disabled:opacity-50"
          title="Read the usage endpoint now and show the limits it reports"
          aria-label="Test the usage endpoint"
          disabled={testingUsage || !draft.usagePath.trim() || !draft.baseURL.trim()}
          onclick={() => void testUsage()}
        >
          {#if testingUsage}
            <CioSpinner size={13} class="animate-spin" aria-hidden="true" />
            Testing…
          {:else}
            <CioActions size={13} aria-hidden="true" />
            Test
          {/if}
        </button>
      </div>

      <div class="space-y-1">
        <span class="block text-xs font-medium">Response format</span>
        <EnumSelect
          options={usageFormatOptions}
          value={activeUsageFormat}
          onChange={applyUsageFormat}
          placeholder="Auto-detect"
          ariaLabel="Usage response format"
          title="How CodeInOven reads this usage endpoint"
          class="w-full"
        />
        <p class="text-[0.6875rem] font-normal text-dimmed">{usageFormatHint}</p>
      </div>

      <label class="block space-y-1 text-xs font-medium" for="base-url-provider-usage-path">
        <span>Usage endpoint</span>
        <input
          id="base-url-provider-usage-path"
          class="h-9 w-full border bg-elevated px-3 font-mono text-sm outline-none focus:border-primary"
          placeholder="/status or https://analytics.example.com/usage"
          autocomplete="off"
          spellcheck="false"
          bind:value={draft.usagePath}
        />
        <span class="block text-[0.6875rem] font-normal text-dimmed">
          Picking a format fills in the route it reads. A path is resolved against the base URL; a
          full URL is used as-is. Leave it blank for a provider with no readings to show.
        </span>
      </label>

      {#if usagePreview}
        <div class="border bg-elevated px-2.5 py-2">
          {#if usagePreview.usage && (usagePreview.usage.rateLimits.length > 0 || usagePreview.usage.credits)}
            <UsageWindowList limits={usagePreview.usage.rateLimits} />
            {#if creditsLabel(usagePreview.usage)}
              <p class="mt-1 text-[0.625rem] text-dimmed">{creditsLabel(usagePreview.usage)}</p>
            {/if}
            <p
              class="mt-1.5 truncate text-[0.5625rem] text-dimmed"
              title={usagePreview.usage.source}
            >
              {usagePreview.usage.source}
            </p>
          {:else}
            <p class="text-[0.6875rem] text-muted">
              {usagePreview.message ?? 'No limits to report.'}
            </p>
          {/if}
        </div>
      {/if}
    </div>

    <label class="block space-y-1 text-xs font-medium" for="base-url-provider-models-path">
      <span>Models route (optional)</span>
      <input
        id="base-url-provider-models-path"
        class="h-9 w-full border bg-elevated px-3 font-mono text-sm outline-none focus:border-primary"
        placeholder="/models"
        autocomplete="off"
        spellcheck="false"
        bind:value={draft.modelsPath}
      />
      <span class="block text-[0.6875rem] font-normal text-dimmed">
        Path (relative to the base URL) or full URL that lists this provider's models. Defaults to
        /models when empty; used for model discovery and refresh.
      </span>
    </label>

    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-medium">Models</span>
        <div class="flex items-center gap-1.5">
          <button
            class="flex h-7 items-center gap-1 border bg-elevated px-2 text-[0.6875rem] font-medium hover:bg-overlay disabled:opacity-50"
            type="button"
            title="Fetch available models from {draft.baseURL || 'the base URL'}/models"
            disabled={!draft.baseURL.trim() || discoveringModels}
            onclick={() => void discoverModels(true)}
          >
            {#if discoveringModels}
              <CioSpinner size={11} class="animate-spin" />
            {:else}
              <CioRefresh size={11} />
            {/if}
            Refresh models
          </button>
          <button
            class="flex h-7 items-center gap-1 border bg-elevated px-2 text-[0.6875rem] font-medium hover:bg-overlay"
            type="button"
            title="Paste a copied model from the clipboard"
            onclick={() => void pasteModelFromClipboard()}
          >
            <CioClipboardPaste size={11} /> Paste model
          </button>
          <button
            class="flex h-7 items-center gap-1 border bg-elevated px-2 text-[0.6875rem] font-medium hover:bg-overlay"
            type="button"
            onclick={addModel}
          >
            <CioPlus size={11} /> Add model
          </button>
        </div>
      </div>
      {#if draft.models.length === 0}
        <p class="border border-dashed p-3 text-[0.6875rem] text-dimmed">
          No models added. On save, we will fetch the model list from the /models route and add
          every model found.
        </p>
        {#if discoverError}
          <p class="text-[0.6875rem] text-danger">{discoverError}</p>
        {:else if discoveringModels}
          <p class="flex items-center gap-1.5 text-[0.6875rem] text-dimmed">
            <CioSpinner size={11} class="animate-spin" /> Searching {draft.baseURL}/models…
          </p>
        {:else if discoveredModels.length > 0}
          <div class="space-y-1">
            <p class="text-[0.6875rem] font-medium text-dimmed">
              Found {discoveredModels.length} model{discoveredModels.length === 1 ? '' : 's'} click to
              add
            </p>
            <div class="flex flex-wrap gap-1.5">
              {#each discoveredModels as model (model.id)}
                <button
                  class="border bg-elevated px-2.5 py-1 text-[0.6875rem] font-mono hover:bg-overlay disabled:opacity-40"
                  type="button"
                  disabled={draft.models.some((m) => m.id === model.id)}
                  onclick={() => addDiscoveredModel(model)}
                >
                  {model.name === model.id ? model.id : `${model.name} (${model.id})`}
                </button>
              {/each}
            </div>
          </div>
        {/if}
      {/if}
      {#each draft.models as model, index (index)}
        <div class="border bg-elevated/50 p-3">
          <div class="flex items-center justify-between">
            <span class="text-[0.6875rem] font-medium text-dimmed">Model {index + 1}</span>
            <div class="flex items-center gap-1">
              <button
                class="flex h-6 w-6 items-center justify-center text-muted hover:bg-overlay hover:text-foreground"
                aria-label="Copy model {index + 1} to clipboard"
                title="Copy model {index + 1} to clipboard"
                type="button"
                onclick={() => copyModelDraft(model)}
              >
                <CioCopy size={12} />
              </button>
              <button
                class="flex h-6 w-6 items-center justify-center text-muted hover:bg-danger/10 hover:text-danger"
                aria-label="Remove model {index + 1}"
                title="Remove model {index + 1}"
                type="button"
                onclick={() => removeModel(index)}
              >
                <CioClose size={12} />
              </button>
            </div>
          </div>
          <div class="mt-2 grid grid-cols-2 gap-2">
            <label class="space-y-1 text-[0.6875rem] font-medium">
              <span>Model ID</span>
              <input
                class="h-8 w-full border bg-elevated px-2 text-xs font-mono outline-none focus:border-primary"
                placeholder="my-model"
                bind:value={model.id}
              />
            </label>
            <label class="space-y-1 text-[0.6875rem] font-medium">
              <span>Display name</span>
              <input
                class="h-8 w-full border bg-elevated px-2 text-xs outline-none focus:border-primary"
                placeholder="My Model"
                bind:value={model.name}
              />
            </label>
            <label class="space-y-1 text-[0.6875rem] font-medium">
              <span>Context window</span>
              <input
                class="h-8 w-full border bg-elevated px-2 text-xs font-mono outline-none focus:border-primary"
                placeholder="200000"
                inputmode="numeric"
                bind:value={model.contextWindow}
              />
            </label>
            <label class="space-y-1 text-[0.6875rem] font-medium">
              <span>Max output tokens</span>
              <input
                class="h-8 w-full border bg-elevated px-2 text-xs font-mono outline-none focus:border-primary"
                placeholder="65536"
                inputmode="numeric"
                bind:value={model.maxOutputTokens}
              />
            </label>
          </div>
          <div class="mt-2 flex items-center gap-4">
            <Switch bind:checked={model.vision}>
              <span class="text-[0.6875rem] font-medium">Can see images</span>
            </Switch>
            <Switch bind:checked={model.reasoning}>
              <span class="text-[0.6875rem] font-medium">Supports reasoning</span>
            </Switch>
            <label class="flex items-center gap-1.5 text-[0.6875rem] font-medium">
              <span>Default thinking</span>
              <select
                class="h-7 border bg-elevated px-1.5 text-[0.6875rem] outline-none focus:border-primary"
                bind:value={model.defaultThinkingLevel}
              >
                <option value="">None</option>
                {#each THINKING_LEVELS as level (level)}
                  <option value={level}>{level}</option>
                {/each}
              </select>
            </label>
          </div>
        </div>
      {/each}
    </div>
  </form>
</DockableModal>
