<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import {
    BookOpen,
    Brain,
    Globe2,
    Image as ImageIcon,
    Loader2,
    Search,
    Server,
    SquareTerminal
  } from '@lucide/svelte'
  import { isImageMime, fileUrlToPath } from '$lib/mime'
  import { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import type {
    AgentSource,
    FileAgentSource,
    FileCitationAgentSource,
    SectionAgentSource
  } from '$lib/agent-sources'
  import MediaPreview from '../chats/MediaPreview.svelte'
  import { revealFileInAppTree, revealCitationFile } from '$lib/reveal-file'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { sectionNavigationState } from '$lib/stores/section-navigation.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { faviconState } from '$lib/stores/favicons.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { modelKey } from '$lib/model-keys'
  import type {
    AgentCapabilityEntry,
    AgentContextCapabilities,
    AgentRunningProcess,
    AgentArtifact,
    MemoryEntry
  } from '$shared/types'
  import { INBOX_PROJECT_ID } from '$shared/types'
  import UtilityEditorModal, {
    type UtilityEditorTarget
  } from '../settings/UtilityEditorModal.svelte'
  import Modal from '../ui/Modal.svelte'
  import SourcesPanelHeader from './SourcesPanelHeader.svelte'
  import SourcesPanelStatus from './SourcesPanelStatus.svelte'
  import SourcesPanelEmptyState from './SourcesPanelEmptyState.svelte'
  import SourcesPanelSourceRow from './SourcesPanelSourceRow.svelte'
  import SourcesPanelCapabilityRow from './SourcesPanelCapabilityRow.svelte'
  import SourcesPanelProcessRow from './SourcesPanelProcessRow.svelte'
  import SourcesPanelArtifactRow from './SourcesPanelArtifactRow.svelte'
  import SourcesPanelMemoryRow from './SourcesPanelMemoryRow.svelte'
  import {
    isImageSource,
    sourceFilterLabel,
    type ContextSection,
    type OriginFilter,
    type SourceFilter,
    type SourcesSection
  } from './sources-panel-helpers'

  interface Props {
    sources: AgentSource[]
    projectId?: string
    threadId?: string
  }

  const MINIMUM_REFRESH_FEEDBACK_MS = 500

  let { sources, projectId, threadId }: Props = $props()
  let section = $state<SourcesSection>('sources')
  let contextSection = $state<ContextSection>('mcps')
  let originFilter = $state<OriginFilter>('all')
  let sourceFilter = $state<SourceFilter>('all')
  let searchQuery = $state('')
  let previewSource = $state<FileAgentSource | null>(null)
  let imageUrls = new FileBlobUrlManager()
  let capabilities = $state<AgentContextCapabilities | null>(null)
  let capabilitiesLoading = $state(false)
  let capabilitiesError = $state('')
  let editorOpen = $state(false)
  let editorTarget = $state<UtilityEditorTarget | null>(null)
  let deleteTarget = $state<AgentCapabilityEntry | null>(null)
  let deleting = $state(false)
  let deleteError = $state('')
  let processes = $state<AgentRunningProcess[]>([])
  let processesLoading = $state(false)
  let processesRefreshing = $state(false)
  let processesError = $state('')
  let stoppingPids = $state(new Set<number>())
  let stoppingAll = $state(false)
  let artifacts = $state<AgentArtifact[]>([])
  let artifactsLoading = $state(false)
  let artifactsError = $state('')
  let previewArtifact = $state<AgentArtifact | null>(null)
  let memory = $state<MemoryEntry[]>([])
  let memoryLoading = $state(false)
  let memoryError = $state('')

  function preloadMedia(nextSources: AgentSource[], nextArtifacts: AgentArtifact[]): void {
    for (const source of nextSources) {
      if (
        (source.kind === 'attachment' || source.kind === 'generated-image') &&
        isImageMime(source.mime) &&
        source.url.startsWith('file://')
      ) {
        void imageUrls.load(source.url, source.mime)
      }
    }
    for (const artifact of nextArtifacts) {
      if (isImageMime(artifact.mime) && artifact.url.startsWith('file://')) {
        void imageUrls.load(artifact.url, artifact.mime)
      }
    }
    const webUrls = nextSources
      .filter((source): source is Extract<AgentSource, { kind: 'web' }> => source.kind === 'web')
      .map((source) => source.url as string)
    faviconState.ensureResolved(webUrls)
  }

  onMount(() => {
    preloadMedia(sources, artifacts)
    void loadCapabilities()
    void loadProcesses()
    void loadArtifacts()
    void loadMemory()
    const unsubscribeProcesses = subscribe(
      'agent:processesChanged',
      (changedProjectId, changedThreadId) => {
        if (changedProjectId === projectId && changedThreadId === threadId) void loadProcesses()
      }
    )
    const unsubscribeAgent = subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as { type?: unknown } | undefined
      if (event?.type === 'message.completed' || event?.type === 'session.idle') {
        void loadArtifacts()
      }
    })
    return () => {
      unsubscribeProcesses()
      unsubscribeAgent()
    }
  })

  onDestroy(() => imageUrls.destroy())

  const attachmentCount = $derived(sources.filter((source) => source.kind === 'attachment').length)
  const webCount = $derived(sources.filter((source) => source.kind === 'web').length)
  const imageCount = $derived(sources.filter((source) => source.kind === 'generated-image').length)
  const citationCount = $derived(sources.filter((source) => source.kind === 'file-citation').length)
  const sectionCount = $derived(sources.filter((source) => source.kind === 'section').length)
  const artifactCount = $derived(artifacts.length)
  const memoryCount = $derived(memory.length)

  const filteredSources = $derived(
    sourceFilter === 'all' ? sources : sources.filter((source) => source.kind === sourceFilter)
  )

  function toggleSourceFilter(kind: SourceFilter): void {
    sourceFilter = sourceFilter === kind ? 'all' : kind
  }

  const availableMcps = $derived(capabilities?.mcp ?? [])
  const availableSkills = $derived(capabilities?.skill ?? [])

  function originMatches(entry: AgentCapabilityEntry): boolean {
    return originFilter === 'all' || entry.origin === originFilter
  }

  function searchMatches(entry: AgentCapabilityEntry): boolean {
    const needle = searchQuery.trim().toLowerCase()
    if (!needle) return true
    return [entry.name, entry.description ?? '', entry.detail ?? ''].some((value) =>
      value.toLowerCase().includes(needle)
    )
  }

  const filteredMcps = $derived(availableMcps.filter(originMatches).filter(searchMatches))
  const filteredSkills = $derived(availableSkills.filter(originMatches).filter(searchMatches))

  async function loadCapabilities(): Promise<void> {
    capabilitiesLoading = true
    capabilitiesError = ''
    try {
      capabilities = await invoke('agent:listContextCapabilities', projectId ?? '', threadId ?? '')
    } catch (loadError) {
      capabilitiesError =
        loadError instanceof Error
          ? loadError.message
          : 'The available capabilities could not be loaded.'
    } finally {
      capabilitiesLoading = false
    }
  }

  async function loadProcesses(): Promise<void> {
    if (!projectId || !threadId) {
      processes = []
      return
    }
    processesLoading = true
    processesError = ''
    try {
      processes = await invoke('agent:listProcesses', projectId, threadId)
    } catch (loadError) {
      processesError =
        loadError instanceof Error ? loadError.message : 'Running processes could not be loaded.'
    } finally {
      processesLoading = false
    }
  }

  async function refreshProcesses(): Promise<void> {
    if (processesRefreshing || processesLoading) return
    processesRefreshing = true
    const startedAt = Date.now()
    try {
      await loadProcesses()
    } finally {
      const remainingFeedbackMs = MINIMUM_REFRESH_FEEDBACK_MS - (Date.now() - startedAt)
      if (remainingFeedbackMs > 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, remainingFeedbackMs))
      }
      processesRefreshing = false
    }
  }

  async function loadArtifacts(): Promise<void> {
    if (!projectId || !threadId) {
      artifacts = []
      return
    }
    artifactsLoading = true
    artifactsError = ''
    try {
      artifacts = await invoke('agent:listArtifacts', projectId, threadId)
      preloadMedia(sources, artifacts)
    } catch (loadError) {
      artifactsError =
        loadError instanceof Error ? loadError.message : 'Generated artifacts could not be loaded.'
    } finally {
      artifactsLoading = false
    }
  }

  async function loadMemory(): Promise<void> {
    if (!projectId || !threadId) {
      memory = []
      return
    }
    memoryLoading = true
    memoryError = ''
    try {
      const [thread, entries] = await Promise.all([
        invoke('thread:get', projectId, threadId),
        projectId === INBOX_PROJECT_ID
          ? Promise.all([
              invoke('memory:getEntries'),
              invoke('memory:getEntries', INBOX_PROJECT_ID),
              invoke('memory:getEntries', INBOX_PROJECT_ID, threadId)
            ]).then(([globalEntries, chatEntries, threadEntries]) => [
              ...globalEntries.filter((entry) => entry.scope === 'global'),
              ...chatEntries,
              ...threadEntries
            ])
          : Promise.all([
              invoke('memory:getEntries'),
              invoke('memory:getEntries', projectId),
              invoke('memory:getEntries', projectId, threadId)
            ]).then(([globalEntries, projectEntries, threadEntries]) => [
              ...globalEntries,
              ...projectEntries,
              ...threadEntries
            ])
      ])
      const activeModelKey =
        thread?.settings?.harnessId && thread.settings.providerId && thread.settings.modelId
          ? modelKey(thread.settings.harnessId, thread.settings.providerId, thread.settings.modelId)
          : undefined
      memory = [
        ...new Map(
          entries
            .filter(
              (entry) =>
                entry.enabled &&
                (entry.category !== 'models' ||
                  Boolean(activeModelKey && entry.modelKeys?.includes(activeModelKey)))
            )
            .map((entry) => [entry.id, entry])
        ).values()
      ].sort((a, b) => b.updatedAt - a.updatedAt)
    } catch (loadError) {
      memoryError =
        loadError instanceof Error ? loadError.message : 'Active memory could not be loaded.'
    } finally {
      memoryLoading = false
    }
  }

  function openArtifact(artifact: AgentArtifact): void {
    previewArtifact = artifact
  }

  function revealArtifact(artifact: AgentArtifact): void {
    void invoke('shell:revealPath', artifact.path)
  }

  function openActiveFacts(): void {
    if (projectId && threadId) contextSidebarState.openMemory(projectId, threadId, 'active')
  }

  async function stopProcess(pid: number): Promise<void> {
    if (!projectId || !threadId || stoppingPids.has(pid)) return
    stoppingPids.add(pid)
    processesError = ''
    try {
      await invoke('agent:killProcess', projectId, threadId, pid)
      await loadProcesses()
    } catch (stopError) {
      processesError =
        stopError instanceof Error ? stopError.message : `Process ${pid} could not be stopped.`
    } finally {
      stoppingPids.delete(pid)
    }
  }

  async function stopAllProcesses(): Promise<void> {
    if (!projectId || !threadId || stoppingAll) return
    stoppingAll = true
    processesError = ''
    try {
      await invoke('agent:killThreadProcesses', projectId, threadId)
      processes = []
    } catch (stopError) {
      processesError =
        stopError instanceof Error ? stopError.message : 'Running processes could not be stopped.'
    } finally {
      stoppingAll = false
    }
  }

  const threadProcesses = $derived(processes.filter((process) => process.scope === 'thread'))
  const appProcesses = $derived(processes.filter((process) => process.scope === 'app'))

  function openEditor(entry: AgentCapabilityEntry): void {
    editorTarget = { kind: 'native', entry }
    editorOpen = true
  }

  function openUtilitiesSettings(): void {
    workspaceState.navigateToSettings?.('utilities')
  }

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return
    deleting = true
    deleteError = ''
    try {
      if (deleteTarget.kind === 'skill') {
        await invoke('capabilities:deleteSkill', deleteTarget.source)
      } else {
        await invoke('capabilities:deleteMcp', deleteTarget.source)
      }
      deleteTarget = null
      void loadCapabilities()
    } catch (deleteErr) {
      deleteError =
        deleteErr instanceof Error ? deleteErr.message : 'The capability could not be deleted.'
    } finally {
      deleting = false
    }
  }

  function handleCitationClick(source: FileCitationAgentSource): void {
    const projectId = workspaceState.activeProject?.id
    if (!projectId) return
    void revealCitationFile(projectId, source.path, source.line)
  }

  function handleSectionClick(source: SectionAgentSource): void {
    if (!projectId || !threadId) return
    sectionNavigationState.request({
      projectId,
      threadId,
      messageId: source.messageId,
      section: source.section
    })
  }

  function openFileInViewer(source: FileAgentSource): void {
    if (isImageSource(source)) {
      previewSource = source
      return
    }
    const project = workspaceState.activeProject
    if (!project?.id || !project.path) return
    const absPath = source.url.startsWith('file://') ? fileUrlToPath(source.url) : source.url
    void revealFileInAppTree(project.id, absPath)
  }

  function openWebUrl(url: string): void {
    void openInBrowser(url)
  }
</script>

<div class="flex h-full min-h-0 flex-col">
  <SourcesPanelHeader
    bind:section
    bind:contextSection
    bind:originFilter
    bind:sourceFilter
    bind:searchQuery
    sourceCount={sources.length}
    visibleSourceCount={filteredSources.length}
    {attachmentCount}
    {webCount}
    {imageCount}
    {citationCount}
    {sectionCount}
    {artifactCount}
    {memoryCount}
    processCount={processes.length}
    mcpCount={filteredMcps.length}
    skillCount={filteredSkills.length}
    harnessName={capabilities?.harnessName}
    {processesRefreshing}
    {processesLoading}
    {stoppingAll}
    onToggleSourceFilter={toggleSourceFilter}
    onRefreshProcesses={refreshProcesses}
    onStopAllProcesses={stopAllProcesses}
    onMemoryRequested={() => void loadMemory()}
  />

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if section === 'sources'}
      {#if filteredSources.length === 0 && sources.length === 0}
        <SourcesPanelEmptyState
          title="No sources yet"
          description="Attach files or ask the agent to research the web. Sources will appear here as they are used."
        >
          {#snippet icon()}<Globe2 size={18} />{/snippet}
        </SourcesPanelEmptyState>
      {:else if filteredSources.length === 0}
        <SourcesPanelEmptyState
          title={`No ${sourceFilterLabel(sourceFilter)} sources`}
          description="Nothing in this conversation matches the active filter."
        >
          {#snippet icon()}<Search size={18} />{/snippet}
          <button
            type="button"
            class="mt-3 rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay"
            title="Clear the active source filter"
            onclick={() => (sourceFilter = 'all')}
          >
            Show all sources
          </button>
        </SourcesPanelEmptyState>
      {:else}
        {#each filteredSources as source (source.id)}
          <SourcesPanelSourceRow
            {source}
            {imageUrls}
            onPreviewImage={(next) => (previewSource = next)}
            onOpenSource={openFileInViewer}
            onOpenWeb={openWebUrl}
            onOpenCitation={handleCitationClick}
            onOpenSection={handleSectionClick}
          />
        {/each}
      {/if}
    {:else if section === 'contexts' && contextSection === 'mcps'}
      {#if capabilitiesLoading}
        <SourcesPanelStatus message="Loading MCP servers…" />
      {:else if capabilitiesError}
        <SourcesPanelStatus message={capabilitiesError} tone="danger" alert />
      {:else if filteredMcps.length === 0}
        <SourcesPanelEmptyState
          title="No MCP servers"
          description="No Model Context Protocol servers match this filter."
        >
          {#snippet icon()}<Server size={18} />{/snippet}
          <button
            type="button"
            class="mt-3 rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay"
            title="Open utility settings"
            onclick={openUtilitiesSettings}
          >
            Open Utilities
          </button>
        </SourcesPanelEmptyState>
      {:else}
        {#each filteredMcps as entry (entry.id)}
          <SourcesPanelCapabilityRow
            {entry}
            kind="mcp"
            onEdit={openEditor}
            onDelete={(next) => (deleteTarget = next)}
          />
        {/each}
      {/if}
    {:else if section === 'contexts' && contextSection === 'skills'}
      {#if capabilitiesLoading}
        <SourcesPanelStatus message="Loading skills…" />
      {:else if capabilitiesError}
        <SourcesPanelStatus message={capabilitiesError} tone="danger" alert />
      {:else if filteredSkills.length === 0}
        <SourcesPanelEmptyState
          title="No skills"
          description="No reusable skills match this filter."
        >
          {#snippet icon()}<BookOpen size={18} />{/snippet}
          <button
            type="button"
            class="mt-3 rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay"
            title="Open utility settings"
            onclick={openUtilitiesSettings}
          >
            Open Utilities
          </button>
        </SourcesPanelEmptyState>
      {:else}
        {#each filteredSkills as entry (entry.id)}
          <SourcesPanelCapabilityRow
            {entry}
            kind="skill"
            onEdit={openEditor}
            onDelete={(next) => (deleteTarget = next)}
          />
        {/each}
      {/if}
    {:else if section === 'artifacts'}
      {#if artifactsLoading && artifacts.length === 0}
        <SourcesPanelStatus message="Loading generated artifacts…" />
      {:else if artifactsError && artifacts.length === 0}
        <SourcesPanelStatus message={artifactsError} tone="danger" alert />
      {:else if artifacts.length === 0}
        <SourcesPanelEmptyState
          title="No generated artifacts"
          description="Images produced during this conversation will appear here, even when the agent does not mention their saved path."
        >
          {#snippet icon()}<ImageIcon size={18} />{/snippet}
        </SourcesPanelEmptyState>
      {:else}
        {#if artifactsError}
          <p class="border-b border-border px-4 py-2 text-xs text-danger" role="alert">
            {artifactsError}
          </p>
        {/if}
        {#each artifacts as artifact (artifact.id)}
          <SourcesPanelArtifactRow
            {artifact}
            {imageUrls}
            onPreview={openArtifact}
            onReveal={revealArtifact}
          />
        {/each}
      {/if}
    {:else if section === 'contexts' && contextSection === 'memory'}
      {#if memoryLoading && memory.length === 0}
        <SourcesPanelStatus message="Loading active memory…" />
      {:else if memoryError && memory.length === 0}
        <SourcesPanelStatus message={memoryError} tone="danger" alert />
      {:else if memory.length === 0}
        <SourcesPanelEmptyState
          title="No memory"
          description="Enabled memory entries for this conversation will appear here."
        >
          {#snippet icon()}<Brain size={18} />{/snippet}
          {#if projectId && threadId}
            <button
              type="button"
              class="mt-3 rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay"
              title="Open active memory"
              onclick={openActiveFacts}
            >
              Open Memory
            </button>
          {/if}
        </SourcesPanelEmptyState>
      {:else}
        {#if memoryError}
          <p class="border-b border-border px-4 py-2 text-xs text-danger" role="alert">
            {memoryError}
          </p>
        {/if}
        <div class="border-b border-border px-4 py-2">
          <button
            type="button"
            class="rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay"
            title="Manage active memory"
            onclick={openActiveFacts}
          >
            Manage Memory
          </button>
        </div>
        {#each memory as entry (entry.id)}
          <SourcesPanelMemoryRow {entry} />
        {/each}
      {/if}
    {:else}
      {#if processesLoading && processes.length === 0}
        <SourcesPanelStatus message="Checking running processes…" />
      {:else if processesError && processes.length === 0}
        <SourcesPanelStatus message={processesError} tone="danger" alert />
      {:else if processes.length === 0}
        <SourcesPanelEmptyState
          title="No running processes"
          description="Commands started by the agent will appear here while they are still running."
        >
          {#snippet icon()}<SquareTerminal size={18} />{/snippet}
        </SourcesPanelEmptyState>
      {:else}
        {#if processesError}
          <p class="border-b border-border px-4 py-2 text-xs text-danger" role="alert">
            {processesError}
          </p>
        {/if}
        {#each threadProcesses as runningProcess (runningProcess.pid)}
          <SourcesPanelProcessRow
            process={runningProcess}
            variant="thread"
            stopping={stoppingPids.has(runningProcess.pid)}
            onStop={stopProcess}
          />
        {/each}

        {#if appProcesses.length > 0}
          <div class="border-b border-border bg-elevated/60 px-4 py-3">
            <div class="flex items-center gap-2">
              <Globe2 size={13} class="shrink-0 text-dimmed" />
              <p class="text-[0.6875rem] font-semibold text-foreground">App-wide processes</p>
            </div>
            <p class="mt-1 text-[0.625rem] leading-relaxed text-dimmed">
              These processes run under a shared server used by every thread, so they are not tied
              to this conversation. Stopping one affects all threads using the app.
            </p>
          </div>
          {#each appProcesses as runningProcess (runningProcess.pid)}
            <SourcesPanelProcessRow
              process={runningProcess}
              variant="app"
              stopping={stoppingPids.has(runningProcess.pid)}
              onStop={stopProcess}
            />
          {/each}
        {/if}
      {/if}
    {/if}
  </div>
</div>

{#if editorOpen}
  <UtilityEditorModal
    open
    target={editorTarget}
    onClose={() => (editorOpen = false)}
    onChanged={() => void loadCapabilities()}
  />
{/if}

{#if deleteTarget}
  <Modal open onClose={() => (deleteTarget = null)} title="Delete capability">
    <p class="text-sm text-muted">
      Delete <strong class="text-foreground">{deleteTarget.name}</strong>?
      {deleteTarget.source.kind === 'skill'
        ? 'This removes the skill folder on disk. This cannot be undone.'
        : 'This removes the MCP server from its configuration file.'}
    </p>
    {#if deleteError}
      <p class="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
        {deleteError}
      </p>
    {/if}
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
        disabled={deleting}
        onclick={() => void confirmDelete()}
      >
        {#if deleting}<Loader2 size={13} class="animate-spin" />{/if}
        Delete
      </button>
    {/snippet}
  </Modal>
{/if}

{#if previewSource}
  <MediaPreview
    src={imageUrls.getUrl(previewSource.url)}
    filename={previewSource.title}
    mime={previewSource.mime}
    onClose={() => (previewSource = null)}
  />
{/if}

{#if previewArtifact}
  <MediaPreview
    src={imageUrls.getUrl(previewArtifact.url)}
    filename={previewArtifact.filename}
    mime={previewArtifact.mime}
    onClose={() => (previewArtifact = null)}
  />
{/if}
