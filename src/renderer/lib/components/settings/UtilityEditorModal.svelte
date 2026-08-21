<script lang="ts">
  import { onMount } from 'svelte'
  import {
    Boxes,
    ChevronLeft,
    Loader2,
    Server,
    Sparkles,
    Trash2,
    Upload,
    BookOpen
  } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { getProjectIcon, loadProjectIcons } from '$lib/project-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import type { ScopeProject } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import ProjectSelect from '../shared/ProjectSelect.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import ThreadSelect from '../shared/ThreadSelect.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import type {
    AgentCapabilityEntry,
    HarnessUtilityBinding,
    NativeMcpContent,
    Project,
    Thread,
    ThreadSettings,
    UtilityActivation,
    UtilityConfigMap,
    UtilityCredentialInput,
    UtilityBundleInstallRequest,
    UtilityDefinition,
    UtilityDefinitionInput,
    UtilityDefinitionPatch,
    UtilityKind,
    UtilitySetupReport,
    UtilityScope,
    WebToolProviderId
  } from '$shared/types'
  import { ALL_HARNESSES_BINDING_ID, isOrchestrationChildThread } from '$shared/types'

  type ScopeLevel = UtilityScope['level']
  type BindingStrategy = HarnessUtilityBinding['strategy']

  /** What the shared editor is editing. */
  export type UtilityEditorTarget =
    | { kind: 'registry'; utility: UtilityDefinition | null }
    | { kind: 'native'; entry: AgentCapabilityEntry }

  interface BindingDraft {
    harnessId: string
    strategy: BindingStrategy
    nativeCapability: string
    transportName: string
  }

  interface UtilityDraft {
    id: string | null
    kind: UtilityKind
    name: string
    description: string
    enabled: boolean
    activation: UtilityActivation
    scopeLevel: ScopeLevel
    projectId: string
    threadId: string
    transport: 'stdio' | 'http' | 'sse'
    command: string
    args: string
    url: string
    environment: string
    instructions: string
    supportingFiles: string
    endpoint: string
    headers: string
    provider: WebToolProviderId
    backend: string
    providerId: string
    defaultModel: string
    descriptorHarnessId: string
    descriptorProviderId: string
    descriptorModelId: string
    bindings: BindingDraft[]
  }

  interface Props {
    open: boolean
    target: UtilityEditorTarget | null
    onClose: () => void
    /** Fired after a registry create/update completes. */
    onSaved?: (utility: UtilityDefinition) => void
    /** Fired after any successful mutation so the caller can reload. */
    onChanged?: () => void
  }

  let { open, target, onClose, onSaved, onChanged }: Props = $props()

  const createChoices: Array<{
    id: 'skill' | 'mcp' | 'plugin'
    title: string
    description: string
    icon: typeof BookOpen
  }> = [
    {
      id: 'skill',
      title: 'Skill',
      description: 'Paste SKILL.md instructions an agent can load on demand.',
      icon: BookOpen
    },
    {
      id: 'mcp',
      title: 'MCP server',
      description: 'Connect an MCP server over stdio, HTTP, or SSE directly.',
      icon: Server
    },
    {
      id: 'plugin',
      title: 'Plugin bundle',
      description: 'Import a JSON manifest that installs several capabilities atomically.',
      icon: Boxes
    }
  ]

  const skillPlaceholder = `---
name: my-skill
description: What this skill helps with
---

# Instructions

Write the skill…`

  let saving = $state(false)
  let editorError = $state('')
  let setupPreset = $state<null | string>(null)
  let pluginManifest = $state('')
  let deleteTarget = $state<UtilityEditorTarget | null>(null)
  let draft = $state<UtilityDraft>(emptyDraft())
  let credentialId = $state('')
  let credentialLabel = $state('')
  let credentialValue = $state('')
  let credentialRequired = $state(false)
  let credentialEnvironmentVariable = $state('')
  let projects = $state<Project[]>([])
  let threads = $state<Thread[]>([])
  let projectIconUrls = $state<Record<string, string>>({})
  let secureStorageAvailable = $state(true)
  let loadingNative = $state(false)
  let utilities = $state<UtilityDefinition[]>([])
  let agentRequest = $state('')
  let agentReport = $state<UtilitySetupReport | null>(null)
  let agentProjectId = $state('')
  let agentSettings = $state<ThreadSettings | null>(null)
  let agentProviders = $derived(
    agentProjectId
      ? (providerCatalog.cached(agentProjectId) ?? providerCatalog.allCached())
      : providerCatalog.allCached()
  )

  /** How long the editor's project/thread/icon context stays reusable across opens. */
  const EDITOR_CONTEXT_TTL_MS = 15_000
  interface EditorContextCache {
    projects: Project[]
    threads: Thread[]
    projectIconUrls: Record<string, string>
    fetchedAt: number
  }
  let editorContextCache: EditorContextCache | null = null

  async function cachedEditorContext(): Promise<EditorContextCache> {
    const cached = editorContextCache
    if (cached && Date.now() - cached.fetchedAt < EDITOR_CONTEXT_TTL_MS) return cached
    const [nextProjects, nextThreads] = await Promise.all([
      invoke('project:list'),
      invoke('thread:listAll')
    ])
    const projects = nextProjects.filter((project) => !project.hidden)
    const threads = nextThreads
    const projectIconUrls = Object.fromEntries(await loadProjectIcons(projects))
    editorContextCache = { projects, threads, projectIconUrls, fetchedAt: Date.now() }
    return editorContextCache
  }

  let isNative = $derived(target?.kind === 'native')
  let nativeEntry = $derived(target?.kind === 'native' ? target.entry : null)
  let editingRegistry = $derived(target?.kind === 'registry' ? target.utility : null)
  let isAppOwned = $derived(target?.kind === 'registry' && target.utility?.appOwned === true)

  /** Installed, supported harnesses the editor may bind a capability to.
   *  Follows the model picker's protocol: the provider catalog (persisted
   *  snapshot + background refresh, never a cold Harnesses-page probe) decides
   *  which harnesses exist, while `providerStore` supplies canonical names and
   *  drops harnesses whose installed version is unsupported. Probing status is
   *  only ever additive — a confirmed `available` harness stays listed. */
  let availableHarnesses = $derived.by((): Array<{ id: string; name: string }> => {
    const catalogIds = new Set(providerCatalog.allCached().map((catalog) => catalog.harnessId))
    return providerStore.providers
      .filter((provider) => !providerStore.isUnsupported(provider.id))
      .filter(
        (provider) =>
          provider.status === 'available' ||
          provider.status === 'checking' ||
          catalogIds.has(provider.id)
      )
      .map((provider) => ({ id: provider.id, name: provider.name }))
  })
  let scopedThreads = $derived(
    threads.filter(
      (thread) =>
        thread.projectId === draft.projectId &&
        !thread.archived &&
        !isOrchestrationChildThread(thread)
    )
  )
  let projectOptions = $derived.by((): ScopeProject[] => {
    const options = projects.map((project) => ({
      id: project.id,
      name: project.name,
      iconUrl: getProjectIcon(project, projectIconUrls[project.id]),
      color: project.color ?? pickColorForSeed(project.id)
    }))
    if (draft.projectId && !options.some((project) => project.id === draft.projectId)) {
      options.unshift({
        id: draft.projectId,
        name: 'Unavailable project',
        iconUrl: null,
        color: pickColorForSeed(draft.projectId)
      })
    }
    return options
  })
  let selectedScopeProject = $derived(
    projectOptions.find((project) => project.id === draft.projectId) ?? null
  )
  let editedUtility = $derived(
    draft.id ? utilities.find((utility) => utility.id === draft.id) : undefined
  )

  let title = $derived.by(() => {
    if (isNative) return `Edit ${nativeEntry?.name ?? 'capability'}`
    if (draft.id) return 'Edit utility'
    if (setupPreset === 'agent') return 'Agent-assisted Utility Setup'
    if (setupPreset) return 'Configure capability'
    return 'Add capability'
  })

  function emptyDraft(): UtilityDraft {
    return {
      id: null,
      kind: 'mcp',
      name: '',
      description: '',
      enabled: true,
      activation: 'on_demand',
      scopeLevel: 'global',
      projectId: '',
      threadId: '',
      transport: 'stdio',
      command: '',
      args: '',
      url: '',
      environment: '',
      instructions: '',
      supportingFiles: '',
      endpoint: '',
      headers: '',
      provider: 'custom',
      backend: '',
      providerId: '',
      defaultModel: '',
      descriptorHarnessId: '',
      descriptorProviderId: '',
      descriptorModelId: '',
      bindings: []
    }
  }

  function resetCredential(): void {
    credentialId = ''
    credentialLabel = ''
    credentialValue = ''
    credentialRequired = false
    credentialEnvironmentVariable = ''
  }

  function skillDocument(name: string, description: string, instructions: string): string {
    if (instructions.trimStart().startsWith('---')) return instructions
    return `---
name: ${name}
description: ${description || 'Describe when an agent should use this skill.'}
---

${instructions}`
  }

  function skillMetadata(markdown: string): { name: string; description: string } {
    const match = markdown.match(/^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/u)
    if (!match?.[1]) {
      throw new Error('SKILL.md must begin with frontmatter containing name and description.')
    }
    const fields: Record<string, string> = {}
    for (const line of match[1].split('\n')) {
      const separator = line.indexOf(':')
      if (separator <= 0) continue
      fields[line.slice(0, separator).trim().toLowerCase()] = line.slice(separator + 1).trim()
    }
    const name = fields['name'] ?? ''
    const description = fields['description'] ?? ''
    if (!name) throw new Error('SKILL.md frontmatter requires a name.')
    if (!description) throw new Error('SKILL.md frontmatter requires a description.')
    return { name, description }
  }

  function allHarnessBinding(
    strategy: BindingStrategy,
    nativeCapability: string,
    transportName: string
  ): BindingDraft[] {
    return [
      {
        harnessId: ALL_HARNESSES_BINDING_ID,
        strategy,
        nativeCapability,
        transportName
      }
    ]
  }

  function newBinding(harnessId: string): BindingDraft {
    return {
      harnessId,
      strategy:
        draft.kind === 'skill' ? 'skill' : draft.kind === 'image_descriptor' ? 'native' : 'mcp',
      nativeCapability:
        draft.kind === 'web_search' || draft.kind === 'web_fetch'
          ? draft.kind
          : draft.kind === 'image_descriptor'
            ? 'image_descriptor'
            : '',
      transportName:
        draft.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/gu, '-')
          .replace(/^-|-$/gu, '') || 'utility'
    }
  }

  function selectAllHarnesses(): void {
    draft.bindings = [newBinding(ALL_HARNESSES_BINDING_ID)]
  }

  function toggleHarness(harnessId: string): void {
    const existing = draft.bindings.find((binding) => binding.harnessId === harnessId)
    if (existing) {
      draft.bindings = draft.bindings.filter((binding) => binding.harnessId !== harnessId)
      return
    }
    draft.bindings = [
      ...draft.bindings.filter((binding) => binding.harnessId !== ALL_HARNESSES_BINDING_ID),
      newBinding(harnessId)
    ]
  }

  function setScopeLevel(level: ScopeLevel): void {
    draft.scopeLevel = level
    if (level === 'global') {
      draft.projectId = ''
      draft.threadId = ''
    } else if (level === 'project') {
      draft.threadId = ''
    }
  }

  function setScopeProject(projectId: string): void {
    draft.projectId = projectId
    draft.threadId = ''
  }

  function chooseCreate(id: 'skill' | 'mcp' | 'plugin'): void {
    setupPreset = id
    draft = emptyDraft()
    resetCredential()
    editorError = ''
    if (id === 'plugin') {
      setupPreset = 'plugin-bundle'
      return
    }
    if (id === 'skill') {
      draft.kind = 'skill'
      draft.instructions = skillPlaceholder
      draft.bindings = allHarnessBinding('skill', '', 'custom-skill')
    } else {
      draft.kind = 'mcp'
      draft.bindings = allHarnessBinding('mcp', '', 'custom-mcp')
    }
  }

  function parseRecord(value: string, label: string): Record<string, string> | undefined {
    if (!value.trim()) return undefined
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${label} must be a JSON object.`)
    }
    const result: Record<string, string> = {}
    for (const [key, item] of Object.entries(parsed)) {
      if (typeof item !== 'string') throw new Error(`${label} values must be strings.`)
      result[key] = item
    }
    return result
  }

  function buildScope(): UtilityScope {
    if (draft.scopeLevel === 'global') return { level: 'global' }
    if (!draft.projectId.trim()) throw new Error('Project ID is required.')
    if (draft.scopeLevel === 'project') {
      return { level: 'project', projectId: draft.projectId.trim() }
    }
    if (!draft.threadId.trim()) throw new Error('Thread ID is required.')
    return {
      level: 'thread',
      projectId: draft.projectId.trim(),
      threadId: draft.threadId.trim()
    }
  }

  function buildConfig(): UtilityConfigMap[UtilityKind] {
    switch (draft.kind) {
      case 'mcp': {
        const environment = parseRecord(draft.environment, 'Environment')
        const headers = parseRecord(draft.headers, 'Headers')
        return {
          transport: draft.transport,
          ...(draft.command.trim() ? { command: draft.command.trim() } : {}),
          ...(draft.args.trim()
            ? {
                args: draft.args
                  .split('\n')
                  .map((item) => item.trim())
                  .filter(Boolean)
              }
            : {}),
          ...(draft.url.trim() ? { url: draft.url.trim() } : {}),
          ...(environment ? { environment } : {}),
          ...(headers ? { headers } : {})
        }
      }
      case 'skill':
        return { instructions: draft.instructions.trim() }
      case 'web_search':
      case 'web_fetch': {
        const headers = parseRecord(draft.headers, 'Headers')
        return {
          ...(draft.provider !== 'custom' ? { provider: draft.provider } : {}),
          ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
          ...(headers ? { headers } : {})
        }
      }
      case 'computer_use':
        return {
          backend: draft.backend.trim(),
          ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {})
        }
      case 'provider':
        return {
          providerId: draft.providerId.trim(),
          ...(draft.endpoint.trim() ? { endpoint: draft.endpoint.trim() } : {}),
          ...(draft.defaultModel.trim() ? { defaultModel: draft.defaultModel.trim() } : {})
        }
      case 'image_descriptor':
        return {
          harnessId: draft.descriptorHarnessId.trim(),
          providerId: draft.descriptorProviderId.trim(),
          modelId: draft.descriptorModelId.trim()
        }
    }
  }

  function buildBindings(): HarnessUtilityBinding[] {
    const installedIds = new Set(availableHarnesses.map((harness) => harness.id))
    return draft.bindings
      .filter((binding) => binding.harnessId.trim())
      .filter(
        (binding) =>
          draft.id !== null ||
          binding.harnessId === ALL_HARNESSES_BINDING_ID ||
          installedIds.has(binding.harnessId)
      )
      .map((binding) => ({
        harnessId: binding.harnessId.trim(),
        strategy: binding.strategy,
        ...(binding.nativeCapability.trim()
          ? { nativeCapability: binding.nativeCapability.trim() }
          : {}),
        ...(binding.transportName.trim() ? { transportName: binding.transportName.trim() } : {})
      }))
  }

  function buildCredential(): UtilityCredentialInput | null {
    if (!credentialValue) return null
    const webUtility = draft.kind === 'web_search' || draft.kind === 'web_fetch'
    const environmentVariable =
      credentialEnvironmentVariable.trim() || (webUtility ? 'WEB_API_KEY' : '')
    if (!environmentVariable) throw new Error('Environment variable is required for an MCP secret.')
    const id =
      credentialId.trim() ||
      environmentVariable
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '-')
        .replace(/^-|-$/gu, '')
    const label =
      credentialLabel.trim() || (webUtility ? 'Web API key' : `${environmentVariable} secret`)
    return {
      id,
      label,
      value: credentialValue,
      required: credentialRequired,
      environmentVariable
    }
  }

  function openRegistryEdit(utility: UtilityDefinition): void {
    const next = emptyDraft()
    next.id = utility.id
    next.kind = utility.kind
    next.name = utility.name
    next.description = utility.description
    next.enabled = utility.enabled
    next.activation = utility.activation
    next.scopeLevel = utility.scope.level
    next.projectId = utility.scope.level === 'global' ? '' : utility.scope.projectId
    next.threadId = utility.scope.level === 'thread' ? utility.scope.threadId : ''
    next.bindings = utility.harnessBindings.map((binding) => ({
      harnessId: binding.harnessId,
      strategy: binding.strategy,
      nativeCapability: binding.nativeCapability ?? '',
      transportName: binding.transportName ?? ''
    }))
    switch (utility.kind) {
      case 'mcp':
        next.transport = utility.config.transport
        next.command = utility.config.command ?? ''
        next.args = utility.config.args?.join('\n') ?? ''
        next.url = utility.config.url ?? ''
        next.environment = utility.config.environment
          ? JSON.stringify(utility.config.environment, null, 2)
          : ''
        next.headers = utility.config.headers ? JSON.stringify(utility.config.headers, null, 2) : ''
        break
      case 'skill':
        next.instructions = skillDocument(
          utility.name,
          utility.description,
          utility.config.instructions
        )
        next.supportingFiles = utility.config.supportingFiles?.join('\n') ?? ''
        break
      case 'web_search':
      case 'web_fetch':
        next.provider = utility.config.provider ?? 'custom'
        next.endpoint = utility.config.endpoint ?? ''
        next.headers = utility.config.headers ? JSON.stringify(utility.config.headers, null, 2) : ''
        break
      case 'computer_use':
        next.backend = utility.config.backend
        next.endpoint = utility.config.endpoint ?? ''
        break
      case 'provider':
        next.providerId = utility.config.providerId
        next.endpoint = utility.config.endpoint ?? ''
        next.defaultModel = utility.config.defaultModel ?? ''
        break
      case 'image_descriptor':
        next.descriptorHarnessId = utility.config.harnessId
        next.descriptorProviderId = utility.config.providerId
        next.descriptorModelId = utility.config.modelId
        break
    }
    draft = next
    resetCredential()
    const storedCredential = utility.credentials[0]
    if (storedCredential) {
      credentialId = storedCredential.id
      credentialLabel = storedCredential.label
      credentialRequired = storedCredential.required
      credentialEnvironmentVariable = storedCredential.environmentVariable ?? ''
    }
    editorError = ''
    setupPreset = null
  }

  async function openNative(): Promise<void> {
    const entry = nativeEntry
    if (!entry) return
    loadingNative = true
    editorError = ''
    const next = emptyDraft()
    try {
      if (entry.kind === 'skill') {
        const content = await invoke('capabilities:readSkill', entry.source)
        if (!content) throw new Error('The skill file could not be read.')
        next.kind = 'skill'
        next.name = content.name
        next.description = content.description
        next.instructions = content.instructions
      } else {
        const content = await invoke('capabilities:readMcp', entry.source)
        if (!content) throw new Error('The MCP server configuration could not be read.')
        next.kind = 'mcp'
        next.name = content.name
        next.enabled = content.enabled
        next.transport = content.transport
        next.command = content.command ?? ''
        next.args = content.args?.join('\n') ?? ''
        next.url = content.url ?? ''
        next.environment = content.environment ? JSON.stringify(content.environment, null, 2) : ''
        next.headers = content.headers ? JSON.stringify(content.headers, null, 2) : ''
      }
      draft = next
      resetCredential()
      setupPreset = null
    } catch (error) {
      editorError = error instanceof Error ? error.message : 'The capability could not be loaded.'
    } finally {
      loadingNative = false
    }
  }

  async function loadContext(): Promise<void> {
    const catalog = await invoke('utilities:list')
    utilities = catalog.utilities
    secureStorageAvailable = catalog.secureStorageAvailable
    const context = await cachedEditorContext()
    projects = context.projects
    threads = context.threads
    projectIconUrls = context.projectIconUrls
    // Same protocol as the model picker: revalidate the provider catalog in the
    // background so installed harnesses appear without opening the Harnesses
    // page first. The catalog store short-circuits fresh copies (TTL-guarded).
    const projectId = workspaceState.selectedThread?.projectId ?? context.projects[0]?.id
    if (projectId) void providerCatalog.refresh(projectId)
  }

  function initializeTarget(): void {
    if (target?.kind === 'registry') {
      draft = emptyDraft()
      resetCredential()
      setupPreset = null
      pluginManifest = ''
      agentRequest = ''
      agentReport = null
      agentProjectId = ''
      agentSettings = null
      editorError = ''
      if (target.utility) openRegistryEdit(target.utility)
    } else if (target?.kind === 'native') {
      void openNative()
    }
  }

  onMount(() => {
    initializeTarget()
    void loadContext()
    void providerStore.init()
  })

  async function saveRegistryUtility(): Promise<void> {
    const metadata =
      draft.kind === 'skill'
        ? skillMetadata(draft.instructions)
        : { name: draft.name.trim(), description: draft.description.trim() }
    if (!isAppOwned && !metadata.name) throw new Error('Name is required.')
    if (draft.id === null && buildBindings().length === 0) {
      throw new Error('Select at least one installed harness.')
    }
    const common = {
      name: metadata.name,
      description: metadata.description,
      enabled: draft.enabled,
      activation: draft.activation,
      scope: buildScope(),
      config: buildConfig(),
      harnessBindings: buildBindings()
    }
    let saved: UtilityDefinition
    if (draft.id) {
      // The app-owned image descriptor is locked except for the vision model.
      const patch: UtilityDefinitionPatch = isAppOwned ? { config: buildConfig() } : common
      saved = await invoke('utilities:update', draft.id, patch)
      const credential = buildCredential()
      if (credential && !isAppOwned)
        saved = await invoke('utilities:setCredential', saved.id, credential)
    } else {
      const input: UtilityDefinitionInput = { kind: draft.kind, ...common }
      const credential = buildCredential()
      const [installed] = await invoke('utilities:installBundle', {
        name: input.name,
        utilities: [
          {
            definition: input,
            ...(credential ? { credentials: [credential] } : {})
          }
        ]
      })
      if (!installed) throw new Error('The utility was not installed.')
      saved = installed
    }
    onSaved?.(saved)
    onChanged?.()
    onClose()
  }

  async function saveNative(): Promise<void> {
    const entry = nativeEntry
    if (!entry) return
    if (entry.kind === 'skill') {
      if (!draft.instructions.trim()) throw new Error('Skill instructions are required.')
      await invoke('capabilities:updateSkill', entry.source, draft.instructions.trim())
    } else {
      const content: NativeMcpContent = {
        name: draft.name.trim(),
        transport: draft.transport,
        command: draft.command.trim() || undefined,
        args: draft.args
          .split('\n')
          .map((item) => item.trim())
          .filter(Boolean),
        url: draft.url.trim() || undefined,
        environment: parseRecord(draft.environment, 'Environment'),
        headers: parseRecord(draft.headers, 'Headers'),
        enabled: draft.enabled,
        configPath: entry.source.kind === 'mcp' ? entry.source.configPath : ''
      }
      await invoke('capabilities:updateMcp', entry.source, content)
    }
    onChanged?.()
    onClose()
  }

  async function saveUtility(event: SubmitEvent): Promise<void> {
    event.preventDefault()
    saving = true
    editorError = ''
    try {
      if (isNative) {
        await saveNative()
      } else {
        await saveRegistryUtility()
      }
    } catch (saveError) {
      editorError =
        saveError instanceof Error ? saveError.message : 'The capability could not be saved.'
    } finally {
      saving = false
    }
  }

  async function deleteUtility(): Promise<void> {
    if (!deleteTarget) return
    const entry = deleteTarget
    saving = true
    editorError = ''
    try {
      if (entry.kind === 'native') {
        if (entry.entry.kind === 'skill') {
          await invoke('capabilities:deleteSkill', entry.entry.source)
        } else {
          await invoke('capabilities:deleteMcp', entry.entry.source)
        }
      } else {
        const utility = entry.utility
        if (utility) await invoke('utilities:delete', utility.id)
      }
      deleteTarget = null
      onChanged?.()
      onClose()
    } catch (deleteError) {
      editorError =
        deleteError instanceof Error ? deleteError.message : 'The capability could not be deleted.'
    } finally {
      saving = false
    }
  }

  async function removeCredential(utilityId: string, id: string): Promise<void> {
    editorError = ''
    try {
      const updated = await invoke('utilities:removeCredential', utilityId, id)
      utilities = utilities.map((utility) => (utility.id === updated.id ? updated : utility))
      openRegistryEdit(updated)
    } catch (removeError) {
      editorError =
        removeError instanceof Error ? removeError.message : 'The credential could not be removed.'
    }
  }

  async function readPluginFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (file) pluginManifest = await file.text()
  }

  async function importPluginBundle(): Promise<void> {
    saving = true
    editorError = ''
    try {
      const parsed: unknown = JSON.parse(pluginManifest)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('The plugin manifest must be a JSON object.')
      }
      await invoke('utilities:installBundle', parsed as UtilityBundleInstallRequest)
      onChanged?.()
      onClose()
    } catch (installError) {
      editorError =
        installError instanceof Error ? installError.message : 'The plugin could not be installed.'
    } finally {
      saving = false
    }
  }

  function setupAgentThread(): Thread | null {
    const selected = workspaceState.selectedThread
    if (selected?.settings && projects.some((project) => project.id === selected.projectId)) {
      return selected
    }
    return (
      threads
        .filter(
          (thread) => thread.settings && projects.some((project) => project.id === thread.projectId)
        )
        .sort((left, right) => right.lastActivity - left.lastActivity)[0] ?? null
    )
  }

  function beginAgentSetup(): void {
    const thread = setupAgentThread()
    setupPreset = 'agent'
    editorError = ''
    agentProjectId = thread?.projectId ?? ''
    agentSettings = thread?.settings ? { ...thread.settings } : null
    if (!agentSettings) {
      editorError = 'Open a project thread and choose an agent model before starting agent setup.'
    }
  }

  function selectAgentModel(providerId: string, modelId: string, harnessId: string): void {
    if (!agentSettings) return
    agentSettings = { ...agentSettings, harnessId, providerId, modelId }
  }

  function selectAgentThinking(thinkingLevel: ThreadSettings['thinkingLevel']): void {
    if (!agentSettings) return
    agentSettings = { ...agentSettings, thinkingLevel }
  }

  async function runAgentSetup(): Promise<void> {
    const thread = setupAgentThread()
    const settings = agentSettings
    if (!thread || !settings) {
      editorError = 'Open a project thread and choose an agent model before starting agent setup.'
      return
    }
    saving = true
    editorError = ''
    agentReport = null
    try {
      const harnesses = availableHarnesses.map((harness) => harness.id).join(', ')
      agentReport = await invoke(
        'utilities:setupWithAgent',
        thread.projectId,
        crypto.randomUUID(),
        settings,
        [
          agentRequest.trim(),
          `CodeInOven setup context: current projectId=${thread.projectId}; installed harnesses=${harnesses || settings.harnessId}.`
        ].join('\n\n')
      )
      onChanged?.()
    } catch (setupError) {
      editorError =
        setupError instanceof Error
          ? setupError.message
          : 'The utility setup agent could not finish.'
    } finally {
      saving = false
    }
  }
</script>

{#if open}
  <Modal
    open
    {title}
    size="xl"
    {onClose}
    fill={setupPreset === 'agent'}
    contentClass={setupPreset === 'agent' ? 'overflow-hidden p-0' : undefined}
  >
    {#if loadingNative}
      <div class="flex items-center justify-center p-10">
        <Loader2 size={18} class="animate-spin text-dimmed" />
      </div>
    {:else if !isNative && draft.id === null && setupPreset === null}
      <div>
        <div class="mb-5 rounded-xl bg-raised p-4">
          <p class="text-sm font-semibold">What do you want to set up?</p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            CodeInOven wires every harness. Paste a skill, connect an MCP server, or import a plugin
            bundle.
          </p>
        </div>
        <div class="grid gap-2 md:grid-cols-3">
          {#each createChoices as choice (choice.id)}
            <button
              type="button"
              class="group min-h-28 rounded-xl border bg-elevated p-4 text-left transition-colors hover:border-primary hover:bg-overlay focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              onclick={() => chooseCreate(choice.id)}
            >
              <span
                class="flex h-8 w-8 items-center justify-center rounded-lg bg-surface text-muted group-hover:text-foreground"
              >
                <choice.icon size={16} />
              </span>
              <span class="mt-3 block text-sm font-semibold">{choice.title}</span>
              <span class="mt-1 block text-xs leading-relaxed text-muted">
                {choice.description}
              </span>
            </button>
          {/each}
        </div>
        <div
          class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed bg-elevated p-4"
        >
          <div>
            <p class="text-sm font-semibold">Prefer setup by an agent?</p>
            <p class="mt-1 text-xs leading-relaxed text-muted">
              Let a CIO agent build the skill, MCP server, or plugin for the harnesses you use.
            </p>
          </div>
          <button
            type="button"
            class="flex h-9 items-center gap-1.5 rounded-lg border bg-surface px-3 text-xs font-medium text-muted hover:bg-overlay hover:text-foreground"
            title="Set up a utility with a disposable agent session"
            onclick={beginAgentSetup}
          >
            <Sparkles size={14} />
            Setup with agent
          </button>
        </div>
      </div>
    {:else if !isNative && draft.id === null && setupPreset === 'agent'}
      <div class="flex h-full min-h-0 flex-col">
        {#if editorError}
          <p class="mx-6 mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {editorError}
          </p>
        {/if}
        {#if agentReport}
          <div class="min-h-0 flex-1 overflow-y-auto p-6">
            <p class="text-sm font-semibold">Installed</p>
            <div class="mt-2 flex flex-wrap gap-1.5">
              {#each agentReport.installed as utility (utility.id)}
                <span class="rounded-md bg-raised px-2 py-1 text-[11px] font-medium">
                  {utility.name} · {utility.kind}
                </span>
              {/each}
            </div>
            {#if agentReport.summary}
              <p class="mt-3 whitespace-pre-wrap text-xs leading-relaxed text-muted">
                {agentReport.summary}
              </p>
            {/if}
          </div>
        {:else}
          <RichMarkdownEditor
            id="agent-utility-setup-request"
            bind:value={agentRequest}
            placeholder="Set up the official Svelte MCP for Codex and Claude Code globally, or create a deployment skill for this project…"
            ariaLabel="Agent utility setup request"
            disabled={saving}
            containerClass="min-h-0 flex-1"
            class="h-full w-full overflow-y-auto px-3.5 pb-1 pt-3 text-sm leading-5 text-foreground outline-none"
          />
        {/if}
      </div>
    {:else if !isNative && draft.id === null && setupPreset === 'plugin-bundle'}
      <div>
        {#if editorError}
          <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {editorError}
          </p>
        {/if}
        <div class="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
          <div>
            <div class="rounded-xl border border-dashed bg-elevated p-5">
              <Upload size={20} class="mb-3 text-muted" />
              <p class="text-sm font-semibold">Import a plugin manifest</p>
              <p class="mt-1 text-xs leading-relaxed text-muted">
                A plugin bundle can install several MCP servers, skills, and web utilities together.
                Installation is atomic: if one entry is invalid, nothing is added.
              </p>
              <label
                class="mt-4 inline-flex h-9 cursor-pointer items-center rounded-lg border bg-surface px-3 text-xs font-medium hover:bg-overlay"
              >
                Choose JSON file
                <input
                  class="sr-only"
                  type="file"
                  accept=".json,application/json"
                  onchange={readPluginFile}
                />
              </label>
            </div>
            <label class="mt-4 block space-y-1 text-xs font-medium">
              <span>Or paste the manifest</span>
              <textarea
                class="min-h-64 w-full resize-y rounded-xl border bg-raised px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                placeholder={'{\n  "name": "My plugin",\n  "utilities": [\n    { "definition": { ... }, "credentials": [] }\n  ]\n}'}
                bind:value={pluginManifest}></textarea>
            </label>
          </div>
          <aside class="rounded-xl bg-raised p-4">
            <p class="text-xs font-semibold uppercase tracking-wide text-muted">Plugin format</p>
            <ul class="mt-3 space-y-2 text-xs leading-relaxed text-muted">
              <li>One manifest can contain MCP, skill, web search, and web fetch entries.</li>
              <li>Each entry uses the same fields as a single installed capability.</li>
              <li>Secret values are moved into secure storage and never returned to the UI.</li>
              <li>All entries are validated before the registry changes.</li>
            </ul>
          </aside>
        </div>
      </div>
    {:else}
      <form id="utility-editor-form" class="space-y-4" onsubmit={saveUtility}>
        {#if editorError}
          <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {editorError}
          </p>
        {/if}

        {#if isNative && nativeEntry?.kind === 'skill'}
          <p class="rounded-lg bg-raised px-3 py-2 text-[11px] text-muted">
            Editing the skill file at <span class="font-mono"
              >{nativeEntry.source.kind === 'skill' ? nativeEntry.source.path : ''}</span
            >.
          </p>
        {/if}
        {#if isNative && nativeEntry?.kind === 'mcp'}
          <p class="rounded-lg bg-raised px-3 py-2 text-[11px] text-muted">
            Editing the MCP server in
            <span class="font-mono">
              {nativeEntry.source.kind === 'mcp' ? nativeEntry.source.configPath : ''}
            </span>.
          </p>
        {/if}
        {#if isAppOwned}
          <p
            class="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-[11px] text-primary"
          >
            This is a built-in utility: only the vision model can be changed. Everything else is
            managed by the app.
          </p>
        {/if}

        {#if !isNative && !isAppOwned}
          {@render harnessSelector()}
        {/if}

        {#if draft.kind !== 'skill'}
          <div class="grid gap-3 sm:grid-cols-2">
            <label class="space-y-1 text-xs font-medium">
              <span>Name</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary disabled:opacity-50"
                required
                disabled={isAppOwned}
                bind:value={draft.name}
              />
            </label>
            <label class="space-y-1 text-xs font-medium">
              <span>Description</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary disabled:opacity-50"
                disabled={isAppOwned}
                bind:value={draft.description}
              />
            </label>
          </div>
        {/if}

        {#if !isNative && !isAppOwned}
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1 text-xs font-medium">
              <span>Activation</span>
              <select
                class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
                bind:value={draft.activation}
              >
                <option value="on_demand">On demand</option>
                <option value="always">Always available</option>
              </select>
            </label>
            <label class="space-y-1 text-xs font-medium">
              <span>Scope</span>
              <select
                class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
                value={draft.scopeLevel}
                onchange={(event: Event) =>
                  setScopeLevel((event.currentTarget as HTMLSelectElement).value as ScopeLevel)}
              >
                <option value="global">Global</option>
                <option value="project">Project</option>
                <option value="thread">Thread</option>
              </select>
            </label>
          </div>
          {#if draft.scopeLevel !== 'global'}
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1 text-xs font-medium">
                <span>Project</span>
                <ProjectSelect
                  projects={projectOptions}
                  value={draft.projectId}
                  onValueChange={setScopeProject}
                  ariaLabel="Select utility project"
                  placeholder="Select a project"
                  searchPlaceholder="Search projects…"
                  emptyMessage="No projects match this search"
                />
              </label>
              {#if draft.scopeLevel === 'thread'}
                <label class="space-y-1 text-xs font-medium">
                  <span>Thread</span>
                  <ThreadSelect
                    threads={scopedThreads}
                    project={selectedScopeProject}
                    value={draft.threadId}
                    onValueChange={(threadId) => (draft.threadId = threadId)}
                    ariaLabel="Select utility thread"
                    placeholder="Select a thread"
                    searchPlaceholder="Search this project's threads…"
                    emptyMessage={draft.projectId
                      ? 'No threads match this search'
                      : 'Select a project first'}
                    disabled={!draft.projectId}
                  />
                </label>
              {/if}
            </div>
          {/if}
        {/if}

        <fieldset class="space-y-3 rounded-xl border p-3">
          <legend class="px-1 text-xs font-semibold">
            {draft.kind === 'skill'
              ? 'SKILL.md'
              : draft.kind === 'mcp'
                ? 'MCP connection'
                : draft.kind === 'web_search' || draft.kind === 'web_fetch'
                  ? 'Web connection'
                  : draft.kind === 'computer_use'
                    ? 'Computer-use backend'
                    : draft.kind === 'image_descriptor'
                      ? 'Image descriptor model'
                      : 'Provider connection'}
          </legend>
          {#if draft.kind === 'mcp'}
            <label class="block space-y-1 text-xs font-medium">
              <span>Transport</span>
              <select
                class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
                bind:value={draft.transport}
              >
                <option value="stdio">stdio</option>
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </label>
            {#if draft.transport === 'stdio'}
              <label class="block space-y-1 text-xs font-medium">
                <span>Command</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                  bind:value={draft.command}
                />
              </label>
              <label class="block space-y-1 text-xs font-medium">
                <span>Arguments · one per line</span>
                <textarea
                  class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                  bind:value={draft.args}></textarea>
              </label>
            {:else}
              <label class="block space-y-1 text-xs font-medium">
                <span>URL</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                  type="url"
                  bind:value={draft.url}
                />
              </label>
            {/if}
            {#if draft.transport !== 'stdio'}
              <label class="block space-y-1 text-xs font-medium">
                <span>Request headers</span>
                <textarea
                  class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                  placeholder={'{ "Authorization": "Bearer {env:API_TOKEN}" }'}
                  bind:value={draft.headers}></textarea>
              </label>
            {/if}
            {#if isNative || draft.id !== null}
              <label class="block space-y-1 text-xs font-medium">
                <span>Environment</span>
                <textarea
                  class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                  placeholder={'{ "NODE_ENV": "production" }'}
                  bind:value={draft.environment}></textarea>
              </label>
            {/if}
          {:else if draft.kind === 'skill'}
            <RichMarkdownEditor
              id="utility-skill-markdown"
              bind:value={draft.instructions}
              placeholder={skillPlaceholder}
              ariaLabel="Skill Markdown"
              containerClass="rounded-xl border bg-elevated focus-within:border-primary focus-within:ring-1 focus-within:ring-primary"
              class="min-h-72 max-h-96 w-full resize-y overflow-y-auto px-4 py-3 text-sm leading-6 text-foreground outline-none"
            />
            <p class="text-[11px] text-dimmed">
              Write the complete skill file, including frontmatter and instruction sections. The
              frontmatter name and description identify the installed skill.
            </p>
          {:else if draft.kind === 'web_search' || draft.kind === 'web_fetch'}
            <label class="block space-y-1 text-xs font-medium">
              <span>Endpoint</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                type="url"
                bind:value={draft.endpoint}
              />
            </label>
            <label class="block space-y-1 text-xs font-medium">
              <span>Request headers</span>
              <textarea
                class="min-h-16 w-full rounded-lg border bg-elevated px-3 py-2 font-mono text-xs outline-none focus:border-primary"
                placeholder={'{ "Authorization": "Bearer {env:WEB_API_KEY}" }'}
                bind:value={draft.headers}></textarea>
            </label>
          {:else if draft.kind === 'computer_use'}
            <label class="block space-y-1 text-xs font-medium">
              <span>Backend</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                required
                bind:value={draft.backend}
              />
            </label>
            <label class="block space-y-1 text-xs font-medium">
              <span>Endpoint</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                type="url"
                bind:value={draft.endpoint}
              />
            </label>
          {:else if draft.kind === 'image_descriptor'}
            <label class="block space-y-1 text-xs font-medium">
              <span>Harness ID</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                placeholder="opencode"
                bind:value={draft.descriptorHarnessId}
              />
            </label>
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1 text-xs font-medium">
                <span>Provider ID</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                  placeholder="anthropic"
                  bind:value={draft.descriptorProviderId}
                />
              </label>
              <label class="space-y-1 text-xs font-medium">
                <span>Model ID (vision)</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                  placeholder="claude-sonnet-4-5"
                  bind:value={draft.descriptorModelId}
                />
              </label>
            </div>
            <p class="text-[11px] text-dimmed">
              A model from the harness catalog that can see images. Text-only models call this
              utility to describe attached images. Leave the fields empty to let the app pick a
              vision model automatically.
            </p>
          {:else}
            <label class="block space-y-1 text-xs font-medium">
              <span>Provider ID</span>
              <input
                class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                required
                bind:value={draft.providerId}
              />
            </label>
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1 text-xs font-medium">
                <span>Endpoint</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                  type="url"
                  bind:value={draft.endpoint}
                />
              </label>
              <label class="space-y-1 text-xs font-medium">
                <span>Default model</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                  bind:value={draft.defaultModel}
                />
              </label>
            </div>
          {/if}
        </fieldset>

        {#if !isNative && !isAppOwned && (draft.kind === 'web_search' || draft.kind === 'web_fetch' || (draft.kind === 'mcp' && (editedUtility?.credentials.length ?? 0) > 0))}
          <fieldset class="space-y-3 rounded-xl border p-3">
            <legend class="px-1 text-xs font-semibold">
              {draft.kind === 'mcp' ? 'MCP secret' : 'API key'}
            </legend>
            {#if draft.id}
              {@const utility = utilities.find((candidate) => candidate.id === draft.id)}
              {#each utility?.credentials ?? [] as credential (credential.id)}
                <div class="flex items-center justify-between rounded-lg bg-elevated px-2 py-1.5">
                  <div class="min-w-0">
                    <p class="truncate text-xs font-medium">{credential.label}</p>
                    <p class="truncate text-[10px] text-dimmed">
                      Stored securely · {credential.environmentVariable ?? credential.id}
                    </p>
                  </div>
                  <button
                    class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                    type="button"
                    aria-label="Remove {credential.label}"
                    title="Remove {credential.label}"
                    onclick={() => void removeCredential(utility?.id ?? '', credential.id)}
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              {/each}
            {/if}
            <div class="grid gap-2 sm:grid-cols-2">
              <label class="space-y-1 text-xs font-medium">
                <span>Environment variable</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 font-mono text-xs outline-none focus:border-primary"
                  placeholder="API_TOKEN"
                  bind:value={credentialEnvironmentVariable}
                />
              </label>
              <label class="space-y-1 text-xs font-medium">
                <span>Secret value</span>
                <input
                  class="h-9 w-full rounded-lg border bg-elevated px-3 text-sm outline-none focus:border-primary"
                  type="password"
                  autocomplete="off"
                  placeholder={draft.id ? 'Leave blank to keep stored secret' : 'Paste secret'}
                  disabled={!secureStorageAvailable}
                  bind:value={credentialValue}
                />
              </label>
            </div>
            <p class="text-[11px] text-dimmed">
              Saved to encrypted device storage and injected only while this capability is active.
            </p>
          </fieldset>
        {/if}

        {#if !isAppOwned}
          <Switch bind:checked={draft.enabled} label="Enabled" class="font-medium" />
        {/if}
      </form>
    {/if}

    {#snippet footer()}
      <div class="flex w-full items-center justify-between gap-2">
        <div>
          {#if !isNative && draft.id === null && setupPreset !== null}
            <button
              class="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted hover:bg-elevated hover:text-foreground"
              type="button"
              onclick={() => {
                setupPreset = null
                draft = emptyDraft()
                pluginManifest = ''
                agentRequest = ''
                agentReport = null
                agentProjectId = ''
                agentSettings = null
                editorError = ''
              }}
            >
              <ChevronLeft size={14} /> Back
            </button>
          {/if}
        </div>
        <div class="flex items-center gap-2">
          {#if setupPreset === 'agent'}
            <button
              class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
              type="button"
              onclick={onClose}
            >
              {agentReport ? 'Done' : 'Cancel'}
            </button>
            {#if !agentReport}
              {#if agentSettings}
                <ModelPicker
                  providers={agentProviders}
                  projectId={agentProjectId}
                  harnessId={agentSettings.harnessId}
                  providerId={agentSettings.providerId}
                  modelId={agentSettings.modelId}
                  thinkingLevel={agentSettings.thinkingLevel}
                  variant="action"
                  side="top"
                  disabled={saving}
                  onSelect={selectAgentModel}
                  onSelectThinking={selectAgentThinking}
                />
              {/if}
              <button
                class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                type="button"
                disabled={saving || !agentRequest.trim()}
                onclick={() => void runAgentSetup()}
              >
                {#if saving}<Loader2 size={13} class="animate-spin" />{:else}<Sparkles
                    size={13}
                  />{/if}
                {saving ? 'Setting up…' : 'Set up utility'}
              </button>
            {/if}
          {:else if setupPreset === 'plugin-bundle'}
            <button
              class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
              type="button"
              onclick={onClose}
            >
              Cancel
            </button>
            <button
              class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
              type="button"
              disabled={saving || !pluginManifest.trim()}
              onclick={() => void importPluginBundle()}
            >
              {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
              Install plugin
            </button>
          {:else}
            <button
              class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
              type="button"
              onclick={onClose}
            >
              {draft.id !== null || isNative || setupPreset !== null ? 'Cancel' : 'Close'}
            </button>
            {#if (draft.id !== null || isNative) && !isAppOwned}
              <button
                class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
                type="button"
                disabled={saving}
                onclick={() => {
                  if (isNative && nativeEntry) deleteTarget = { kind: 'native', entry: nativeEntry }
                  else if (editingRegistry)
                    deleteTarget = { kind: 'registry', utility: editingRegistry }
                }}
              >
                {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
                Delete
              </button>
            {/if}
            {#if draft.id !== null || isNative || setupPreset !== null}
              <button
                class="flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
                type="submit"
                form="utility-editor-form"
                disabled={saving}
              >
                {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
                {isNative ? 'Save changes' : 'Save utility'}
              </button>
            {/if}
          {/if}
        </div>
      </div>
    {/snippet}
  </Modal>
{/if}

{#snippet harnessSelector()}
  <fieldset class="space-y-3 rounded-xl border p-3">
    <legend class="px-1 text-xs font-semibold">Available to</legend>
    <p class="text-[11px] text-dimmed">
      All is selected by default and automatically includes harnesses added later. Choose individual
      harnesses only when this utility should have limited availability.
    </p>
    <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <button
        type="button"
        class="flex h-10 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors {draft.bindings.some(
          (binding) => binding.harnessId === ALL_HARNESSES_BINDING_ID
        )
          ? 'border-primary bg-primary text-on-primary'
          : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
        aria-pressed={draft.bindings.some(
          (binding) => binding.harnessId === ALL_HARNESSES_BINDING_ID
        )}
        title="Apply to all current and future harnesses"
        onclick={selectAllHarnesses}
      >
        All
      </button>
      {#if availableHarnesses.length}
        {#each availableHarnesses as harness (harness.id)}
          <button
            type="button"
            class="flex h-10 items-center justify-center gap-2 rounded-lg border px-3 text-xs font-medium transition-colors {draft.bindings.some(
              (binding) => binding.harnessId === harness.id
            )
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={draft.bindings.some((binding) => binding.harnessId === harness.id)}
            onclick={() => toggleHarness(harness.id)}
          >
            <AgentIcon agentId={harness.id} label={harness.name} size={16} />
            {harness.name}
          </button>
        {/each}
      {/if}
    </div>
    {#if !availableHarnesses.length}
      <div class="rounded-lg bg-raised px-3 py-2">
        <p class="text-xs text-muted">
          No installed, supported harnesses were detected. All harnesses will still apply when one
          is added later.
        </p>
      </div>
    {/if}
  </fieldset>
{/snippet}

{#if deleteTarget}
  <Modal open title="Delete capability" onClose={() => (deleteTarget = null)}>
    <p class="text-sm text-muted">
      Delete
      <strong class="text-foreground">
        {deleteTarget.kind === 'native' ? deleteTarget.entry.name : deleteTarget.utility?.name}
      </strong>?
      {deleteTarget.kind === 'native'
        ? 'This removes the file on disk. This cannot be undone.'
        : 'Its registry entry and credential references will be removed.'}
    </p>
    {#snippet footer()}
      <button
        class="h-9 rounded-lg border bg-elevated px-3 text-xs font-medium hover:bg-overlay"
        type="button"
        onclick={() => (deleteTarget = null)}
      >
        Cancel
      </button>
      <button
        class="flex h-9 items-center gap-1.5 rounded-lg bg-danger px-3 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
        type="button"
        disabled={saving}
        onclick={() => void deleteUtility()}
      >
        {#if saving}<Loader2 size={13} class="animate-spin" />{/if}
        Delete
      </button>
    {/snippet}
  </Modal>
{/if}
