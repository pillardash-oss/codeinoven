<script lang="ts">
  import { onMount } from 'svelte'
  import { Loader2 } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { getProjectIcon, loadProjectIcons } from '$lib/project-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import type { ScopeProject } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import ProjectSelect from '../shared/ProjectSelect.svelte'
  import ThreadSelect from '../shared/ThreadSelect.svelte'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import type {
    AgentCapabilityEntry,
    NativeMcpContent,
    Project,
    Thread,
    ThreadSettings,
    UtilityBundleInstallRequest,
    UtilityDefinition,
    UtilityDefinitionInput,
    UtilityDefinitionPatch,
    UtilitySetupReport
  } from '$shared/types'
  import { isOrchestrationChildThread } from '$shared/types'
  import UtilityEditorModalAgentSetup from './UtilityEditorModalAgentSetup.svelte'
  import UtilityEditorModalConfigFields from './UtilityEditorModalConfigFields.svelte'
  import UtilityEditorModalCreateStep from './UtilityEditorModalCreateStep.svelte'
  import UtilityEditorModalCredentialFields from './UtilityEditorModalCredentialFields.svelte'
  import UtilityEditorModalFooter from './UtilityEditorModalFooter.svelte'
  import UtilityEditorModalHarnessSelector from './UtilityEditorModalHarnessSelector.svelte'
  import UtilityEditorModalPluginBundle from './UtilityEditorModalPluginBundle.svelte'
  import { canToggleUtilityEnabled } from '$shared/utility-ids'
  import {
    allHarnessBinding,
    buildBindings,
    buildConfig,
    buildCredential,
    buildScope,
    effectiveActivation,
    emptyDraft,
    parseRecord,
    setAllHarnessBindings,
    setScopeLevel,
    setScopeProject,
    skillMetadata,
    skillPlaceholder,
    toggleHarnessBinding,
    utilityToDraft,
    type CredentialDraft,
    type ScopeLevel,
    type UtilityDraft
  } from './utility-editor-modal-helpers'

  /** What the shared editor is editing. */
  export type UtilityEditorTarget =
    | { kind: 'registry'; utility: UtilityDefinition | null }
    | { kind: 'native'; entry: AgentCapabilityEntry }

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
  /** An app-owned skill may be switched off, so its editor keeps the switch. */
  let canToggleAvailability = $derived(
    editingRegistry !== null && canToggleUtilityEnabled(editingRegistry)
  )

  /** Installed, supported harnesses the editor may bind a capability to.
   *  Follows the model picker's protocol: the provider catalog (persisted
   *  snapshot + background refresh, never a cold Harnesses-page probe) decides
   *  which harnesses exist, while `providerStore` supplies canonical names and
   *  drops harnesses whose installed version is unsupported. Probing status is
   *  only ever additive   a confirmed `available` harness stays listed. */
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

  function resetCredential(): void {
    credentialId = ''
    credentialLabel = ''
    credentialValue = ''
    credentialRequired = false
    credentialEnvironmentVariable = ''
  }

  function selectAllHarnesses(): void {
    setAllHarnessBindings(draft)
  }

  function toggleHarness(harnessId: string): void {
    toggleHarnessBinding(draft, harnessId)
  }

  function chooseScopeLevel(level: ScopeLevel): void {
    setScopeLevel(draft, level)
  }

  function chooseScopeProject(projectId: string): void {
    setScopeProject(draft, projectId)
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

  function openRegistryEdit(utility: UtilityDefinition): void {
    draft = utilityToDraft(utility)
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
    const installedHarnessIds = availableHarnesses.map((harness) => harness.id)
    if (draft.id === null && buildBindings(draft, installedHarnessIds).length === 0) {
      throw new Error('Select at least one installed harness.')
    }
    const common = {
      name: metadata.name,
      description: metadata.description,
      enabled: draft.enabled,
      activation: effectiveActivation(draft),
      scope: buildScope(draft),
      config: buildConfig(draft),
      harnessBindings: buildBindings(draft, installedHarnessIds)
    }
    let saved: UtilityDefinition
    if (draft.id) {
      // The app-owned image descriptor is locked except for the vision model,
      // and an app-owned skill may also change whether it is enabled.
      const patch: UtilityDefinitionPatch = isAppOwned
        ? {
            config: buildConfig(draft),
            ...(canToggleAvailability ? { enabled: draft.enabled } : {})
          }
        : common
      saved = await invoke('utilities:update', draft.id, patch)
      const credential = buildCredential(draft, credentialDraft())
      if (credential && !isAppOwned)
        saved = await invoke('utilities:setCredential', saved.id, credential)
    } else {
      const input: UtilityDefinitionInput = { kind: draft.kind, ...common }
      const credential = buildCredential(draft, credentialDraft())
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

  function credentialDraft(): CredentialDraft {
    return {
      id: credentialId,
      label: credentialLabel,
      value: credentialValue,
      required: credentialRequired,
      environmentVariable: credentialEnvironmentVariable
    }
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

  function selectAgentModel(
    providerId: string,
    modelId: string,
    harnessId: string,
    accountId?: string
  ): void {
    if (!agentSettings) return
    agentSettings = { ...agentSettings, harnessId, accountId, providerId, modelId }
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

  function resetSetup(): void {
    setupPreset = null
    draft = emptyDraft()
    pluginManifest = ''
    agentRequest = ''
    agentReport = null
    agentProjectId = ''
    agentSettings = null
    editorError = ''
  }

  function requestDelete(): void {
    if (isNative && nativeEntry) deleteTarget = { kind: 'native', entry: nativeEntry }
    else if (editingRegistry) deleteTarget = { kind: 'registry', utility: editingRegistry }
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
      <UtilityEditorModalCreateStep
        onChooseCreate={chooseCreate}
        onBeginAgentSetup={beginAgentSetup}
      />
    {:else if !isNative && draft.id === null && setupPreset === 'agent'}
      <UtilityEditorModalAgentSetup {editorError} {agentReport} bind:agentRequest {saving} />
    {:else if !isNative && draft.id === null && setupPreset === 'plugin-bundle'}
      <UtilityEditorModalPluginBundle
        {editorError}
        bind:pluginManifest
        onReadPluginFile={readPluginFile}
      />
    {:else}
      <form id="utility-editor-form" class="space-y-4" onsubmit={saveUtility}>
        {#if editorError}
          <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {editorError}
          </p>
        {/if}

        {#if isNative && nativeEntry?.kind === 'skill'}
          <p class="rounded-lg bg-raised px-3 py-2 text-[0.6875rem] text-muted">
            Editing the skill file at <span class="font-mono"
              >{nativeEntry.source.kind === 'skill' ? nativeEntry.source.path : ''}</span
            >.
          </p>
        {/if}
        {#if isNative && nativeEntry?.kind === 'mcp'}
          <p class="rounded-lg bg-raised px-3 py-2 text-[0.6875rem] text-muted">
            Editing the MCP server in
            <span class="font-mono">
              {nativeEntry.source.kind === 'mcp' ? nativeEntry.source.configPath : ''}
            </span>.
          </p>
        {/if}
        {#if isAppOwned}
          <p
            class="rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-[0.6875rem] text-primary"
          >
            {canToggleAvailability
              ? 'This is a built-in skill: its commands are yours to rewrite, and you can switch it off when you already have your own.'
              : 'This is a built-in utility: only the vision model can be changed. Everything else is managed by the app.'}
          </p>
        {/if}

        {#if !isNative && !isAppOwned}
          <UtilityEditorModalHarnessSelector
            bindings={draft.bindings}
            {availableHarnesses}
            onSelectAll={selectAllHarnesses}
            onToggleHarness={toggleHarness}
          />
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
                class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary disabled:opacity-50"
                disabled={draft.kind === 'mcp'}
                bind:value={draft.activation}
              >
                <option value="on_demand">On demand</option>
                {#if draft.kind !== 'mcp'}
                  <option value="always">Always available</option>
                {/if}
              </select>
            </label>
            <label class="space-y-1 text-xs font-medium">
              <span>Scope</span>
              <select
                class="h-9 w-full rounded-lg border bg-elevated px-2.5 text-sm outline-none focus:border-primary"
                value={draft.scopeLevel}
                onchange={(event: Event) =>
                  chooseScopeLevel((event.currentTarget as HTMLSelectElement).value as ScopeLevel)}
              >
                <option value="global">Global</option>
                <option value="project">Project</option>
                <option value="thread">Thread</option>
              </select>
            </label>
          </div>
          {#if draft.kind === 'mcp'}
            <p class="text-xs text-muted">
              MCP servers always load on demand and run behind the CodeInOven utility gateway, so
              nothing is written into your harness or project config.
            </p>
          {/if}
          {#if draft.scopeLevel !== 'global'}
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1 text-xs font-medium">
                <span>Project</span>
                <ProjectSelect
                  projects={projectOptions}
                  value={draft.projectId}
                  onValueChange={chooseScopeProject}
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

        <UtilityEditorModalConfigFields bind:draft {isNative} />

        {#if !isNative && !isAppOwned && (draft.kind === 'web_search' || draft.kind === 'web_fetch' || (draft.kind === 'mcp' && (editedUtility?.credentials.length ?? 0) > 0))}
          <UtilityEditorModalCredentialFields
            {draft}
            {utilities}
            {secureStorageAvailable}
            bind:credentialEnvironmentVariable
            bind:credentialValue
            onRemoveCredential={(utilityId, id) => void removeCredential(utilityId, id)}
          />
        {/if}

        {#if !isAppOwned || canToggleAvailability}
          <Switch bind:checked={draft.enabled} label="Enabled" class="font-medium" />
        {/if}
      </form>
    {/if}

    {#snippet footer()}
      <UtilityEditorModalFooter
        {setupPreset}
        {isNative}
        hasDraftId={draft.id !== null}
        {isAppOwned}
        {saving}
        {agentReport}
        {agentSettings}
        {agentProviders}
        {agentProjectId}
        canRunAgentSetup={agentRequest.trim() !== ''}
        canImportPlugin={pluginManifest.trim() !== ''}
        onBack={resetSetup}
        {onClose}
        onRunAgentSetup={() => void runAgentSetup()}
        onImportPlugin={() => void importPluginBundle()}
        onRequestDelete={requestDelete}
        onSelectAgentModel={selectAgentModel}
        onSelectAgentThinking={selectAgentThinking}
      />
    {/snippet}
  </Modal>
{/if}

<ConfirmDialog
  open={deleteTarget !== null}
  title="Delete capability"
  confirmLabel="Delete"
  busy={saving}
  onCancel={() => (deleteTarget = null)}
  onConfirm={deleteUtility}
>
  <p>
    Delete
    <strong class="text-foreground">
      {deleteTarget?.kind === 'native' ? deleteTarget.entry.name : deleteTarget?.utility?.name}
    </strong>?
    {deleteTarget?.kind === 'native'
      ? 'This removes the file on disk. This cannot be undone.'
      : 'Its registry entry and credential references will be removed.'}
  </p>
</ConfirmDialog>
