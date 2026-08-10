<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import {
    BookOpen,
    FileText,
    Globe2,
    Hash,
    Image as ImageIcon,
    Loader2,
    Pencil,
    Search,
    Server,
    SquareTerminal,
    Trash2
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
  import { sectionNavigationState } from '$lib/stores/section-navigation.svelte'
  import { openInBrowser } from '$lib/open-in-browser'
  import { faviconState } from '$lib/stores/favicons.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import type {
    AgentCapabilityEntry,
    AgentCapabilityOrigin,
    AgentContextCapabilities,
    AgentRunningProcess
  } from '$shared/types'
  import UtilityEditorModal, {
    type UtilityEditorTarget
  } from '../settings/UtilityEditorModal.svelte'
  import Modal from '../ui/Modal.svelte'

  interface Props {
    sources: AgentSource[]
    projectId?: string
    threadId?: string
  }

  type SourcesSection = 'sources' | 'mcps' | 'skills' | 'processes'
  type OriginFilter = 'all' | AgentCapabilityOrigin

  let { sources, projectId, threadId }: Props = $props()
  let section = $state<SourcesSection>('sources')
  let originFilter = $state<OriginFilter>('all')
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
  let processesError = $state('')
  let stoppingPids = $state(new Set<number>())
  let stoppingAll = $state(false)

  $effect(() => {
    for (const source of sources) {
      if (
        (source.kind === 'attachment' || source.kind === 'generated-image') &&
        isImageMime(source.mime) &&
        source.url.startsWith('file://')
      ) {
        void imageUrls.load(source.url, source.mime)
      }
    }
    const webUrls = sources
      .filter((source): source is Extract<AgentSource, { kind: 'web' }> => source.kind === 'web')
      .map((source) => source.url as string)
    faviconState.ensureResolved(webUrls)
  })

  onMount(() => {
    void loadCapabilities()
    void loadProcesses()
    return subscribe('agent:processesChanged', (changedProjectId, changedThreadId) => {
      if (changedProjectId === projectId && changedThreadId === threadId) void loadProcesses()
    })
  })

  onDestroy(() => imageUrls.destroy())

  const attachmentCount = $derived(sources.filter((source) => source.kind === 'attachment').length)
  const webCount = $derived(sources.filter((source) => source.kind === 'web').length)
  const imageCount = $derived(sources.filter((source) => source.kind === 'generated-image').length)
  const citationCount = $derived(sources.filter((source) => source.kind === 'file-citation').length)
  const sectionCount = $derived(sources.filter((source) => source.kind === 'section').length)

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

  function processName(command: string): string {
    const executable = command.trim().split(/\s+/u)[0] ?? command
    return executable.split(/[\\/]/u).at(-1) || 'Process'
  }

  function processStartedAt(startedAt: number): string {
    return new Date(startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  }

  function originLabel(entry: AgentCapabilityEntry): string {
    if (entry.origin === 'application') return 'CodeInOven'
    if (entry.origin === 'global') return 'Global'
    return 'Harness'
  }

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

  function isImageSource(source: FileAgentSource): boolean {
    return (
      source.mime.startsWith('image/') ||
      /\.(?:avif|bmp|gif|ico|jpe?g|png|svg|webp)(?:[?#].*)?$/iu.test(source.url)
    )
  }

  function sourceLabel(source: AgentSource): string {
    if (source.kind === 'attachment') return 'Attachment'
    if (source.kind === 'generated-image') return 'Generated image'
    if (source.kind === 'file-citation') return 'File cited'
    if (source.kind === 'section') return 'Section'
    return 'Website'
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
  <header class="shrink-0 border-b border-border px-4 py-3">
    <div class="flex items-baseline justify-between gap-3">
      <div>
        <h2 class="text-sm font-semibold text-foreground">Sources</h2>
        <p class="mt-0.5 text-[11px] text-dimmed">
          {#if section === 'sources'}
            Attachments, researched websites, and generated images.
          {:else if section === 'mcps'}
            MCP servers available to this conversation.
          {:else if section === 'skills'}
            Reusable skills available to this conversation.
          {:else}
            Commands still running for this task.
          {/if}
        </p>
      </div>
      <span class="text-xs font-semibold tabular-nums text-muted">
        {#if section === 'sources'}
          {sources.length}
        {:else if section === 'mcps'}
          {filteredMcps.length}
        {:else if section === 'skills'}
          {filteredSkills.length}
        {:else}
          {processes.length}
        {/if}
      </span>
    </div>

    <div
      class="mt-3 flex w-max items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
      role="tablist"
      aria-label="Sources sections"
    >
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors {section ===
        'sources'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        role="tab"
        aria-selected={section === 'sources'}
        title="View conversation sources"
        onclick={() => (section = 'sources')}
      >
        Sources
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors {section ===
        'mcps'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        role="tab"
        aria-selected={section === 'mcps'}
        title="View MCP servers available to this conversation"
        onclick={() => (section = 'mcps')}
      >
        MCPs
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors {section ===
        'skills'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        role="tab"
        aria-selected={section === 'skills'}
        title="View skills available to this conversation"
        onclick={() => (section = 'skills')}
      >
        Skills
      </button>
      <button
        type="button"
        class="flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-colors {section ===
        'processes'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'}"
        role="tab"
        aria-selected={section === 'processes'}
        title="View commands still running for this task"
        onclick={() => (section = 'processes')}
      >
        Processes
      </button>
    </div>

    {#if section === 'mcps' || section === 'skills'}
      <div
        class="mt-3 flex w-max items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
        role="group"
        aria-label="Filter by origin"
      >
        <button
          type="button"
          class="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors {originFilter ===
          'all'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          aria-pressed={originFilter === 'all'}
          title="Show capabilities from every source"
          onclick={() => (originFilter = 'all')}
        >
          All
        </button>
        <button
          type="button"
          class="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors {originFilter ===
          'application'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          aria-pressed={originFilter === 'application'}
          title="Show CodeInOven-managed capabilities"
          onclick={() => (originFilter = 'application')}
        >
          CodeInOven
        </button>
        <button
          type="button"
          class="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors {originFilter ===
          'global'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          aria-pressed={originFilter === 'global'}
          title="Show global capabilities available to every harness"
          onclick={() => (originFilter = 'global')}
        >
          Global
        </button>
        <button
          type="button"
          class="rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors {originFilter ===
          'harness'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          aria-pressed={originFilter === 'harness'}
          title={`Show capabilities from ${capabilities?.harnessName ?? 'this harness'}`}
          onclick={() => (originFilter = 'harness')}
        >
          {capabilities?.harnessName ?? 'Harness'}
        </button>
      </div>
      <label class="relative mt-3 block">
        <Search
          size={13}
          class="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-dimmed"
        />
        <span class="sr-only">Search {section === 'mcps' ? 'MCP servers' : 'skills'}</span>
        <input
          class="h-8 w-full rounded-lg border bg-elevated pl-8 pr-3 text-xs outline-none placeholder:text-dimmed focus:border-primary"
          type="search"
          placeholder={section === 'mcps' ? 'Search MCP servers' : 'Search skills'}
          bind:value={searchQuery}
        />
      </label>
    {/if}

    {#if section === 'sources' && sources.length > 0}
      <div class="mt-3 flex flex-wrap gap-1.5 text-[10px] text-muted">
        <span class="rounded-md bg-raised px-1.5 py-0.5 tabular-nums">
          {attachmentCount} attachments
        </span>
        <span class="rounded-md bg-raised px-1.5 py-0.5 tabular-nums">{webCount} web</span>
        <span class="rounded-md bg-raised px-1.5 py-0.5 tabular-nums">
          {imageCount} images
        </span>
        {#if citationCount > 0}
          <span class="rounded-md bg-raised px-1.5 py-0.5 tabular-nums">
            {citationCount} cited files
          </span>
        {/if}
        {#if sectionCount > 0}
          <span class="rounded-md bg-raised px-1.5 py-0.5 tabular-nums">
            {sectionCount} sections
          </span>
        {/if}
      </div>
    {/if}

    {#if section === 'processes' && processes.length > 0}
      <button
        type="button"
        class="mt-3 inline-flex h-8 items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2.5 text-xs font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
        disabled={stoppingAll}
        title="Stop all processes running for this task"
        onclick={stopAllProcesses}
      >
        {#if stoppingAll}
          <Loader2 size={13} class="animate-spin" />
        {:else}
          <SquareTerminal size={13} />
        {/if}
        Stop all
      </button>
    {/if}
  </header>

  <div class="min-h-0 flex-1 overflow-y-auto">
    {#if section === 'sources'}
      {#each sources as source (source.id)}
        <div class="group border-b border-border px-4 py-3 transition-colors hover:bg-elevated">
          <div class="flex items-start gap-3">
            {#if source.kind === 'web'}
              {@const favicon = source.url ? faviconState.faviconFor(source.url) : null}
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-raised {favicon
                  ? ''
                  : 'text-muted'}"
              >
                {#if favicon}
                  <img src={favicon} alt="" class="h-5 w-5 rounded-sm object-contain" />
                {:else}
                  <Globe2 size={15} />
                {/if}
              </span>
            {:else if source.kind === 'file-citation'}
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-primary"
              >
                <FileText size={15} />
              </span>
            {:else if source.kind === 'section'}
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-primary"
              >
                <Hash size={15} />
              </span>
            {:else if isImageSource(source)}
              <button
                type="button"
                class="h-8 w-8 shrink-0 cursor-pointer overflow-hidden rounded-lg bg-raised"
                aria-label={`Preview ${source.title}`}
                title={`Preview ${source.title}`}
                onclick={() => (previewSource = source)}
              >
                <img
                  src={imageUrls.getUrl(source.url)}
                  alt=""
                  class="h-full w-full object-cover"
                  onerror={(e: Event) =>
                    void imageUrls.bindImage(
                      source.url,
                      source.mime,
                      e.currentTarget as HTMLImageElement
                    )}
                />
              </button>
            {:else}
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
              >
                <FileText size={15} />
              </span>
            {/if}

            <div class="min-w-0 flex-1">
              <p class="text-[10px] font-semibold uppercase tracking-[0.12em] text-dimmed">
                {sourceLabel(source)}
              </p>
              {#if source.kind === 'web' && source.url}
                {@const url = source.url}
                <button
                  type="button"
                  class="mt-0.5 flex min-w-0 cursor-pointer items-center gap-1 text-left text-xs font-medium text-foreground hover:text-primary"
                  title={`Open ${url} in browser`}
                  onclick={() => openWebUrl(url)}
                >
                  <span class="truncate">{source.title}</span>
                </button>
                <p class="mt-1 truncate text-[10px] text-dimmed" title={url}>
                  {url}
                </p>
              {:else if source.kind === 'web'}
                <p class="mt-0.5 text-xs font-medium text-foreground">{source.title}</p>
              {:else if source.kind === 'file-citation'}
                <button
                  type="button"
                  class="mt-0.5 block max-w-full cursor-pointer truncate text-left text-xs font-medium text-primary hover:text-primary/80"
                  title={`Open ${source.path}${source.line ? ` at line ${source.line}` : ''}`}
                  onclick={() => handleCitationClick(source)}
                >
                  <span class="truncate">{source.path}</span>
                  {#if source.line}
                    <span class="ml-1 text-[10px] text-dimmed tabular-nums">:{source.line}</span>
                  {/if}
                </button>
              {:else if source.kind === 'section'}
                <button
                  type="button"
                  class="mt-0.5 block max-w-full cursor-pointer truncate text-left text-xs font-medium text-primary hover:text-primary/80"
                  title={`Jump to section ${source.section} in this conversation`}
                  onclick={() => handleSectionClick(source)}
                >
                  <span class="truncate">{source.title}</span>
                </button>
              {:else}
                <button
                  type="button"
                  class="mt-0.5 block max-w-full cursor-pointer truncate text-left text-xs font-medium text-foreground hover:text-primary"
                  title={isImageSource(source) ? `Preview ${source.title}` : `Open ${source.title}`}
                  onclick={() => openFileInViewer(source)}
                >
                  {source.title}
                </button>
              {/if}
              {#if source.kind === 'web' && source.detail}
                <p class="mt-1 line-clamp-2 text-[10px] leading-relaxed text-dimmed">
                  {source.detail}
                </p>
              {/if}
            </div>

            {#if source.kind === 'generated-image'}
              <ImageIcon size={13} class="mt-1 shrink-0 text-dimmed" />
            {/if}
          </div>
        </div>
      {:else}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <div class="max-w-64">
            <span
              class="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-dimmed"
            >
              <Globe2 size={18} />
            </span>
            <h2 class="mt-3 text-sm font-semibold text-foreground">No sources yet</h2>
            <p class="mt-1 text-xs leading-relaxed text-dimmed">
              Attach files or ask the agent to research the web. Sources will appear here as they
              are used.
            </p>
          </div>
        </div>
      {/each}
    {:else if section === 'mcps'}
      {#if capabilitiesLoading}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <p class="text-xs text-dimmed">Loading MCP servers…</p>
        </div>
      {:else if capabilitiesError}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <div class="max-w-64">
            <p class="text-xs leading-relaxed text-danger" role="alert">{capabilitiesError}</p>
          </div>
        </div>
      {:else if filteredMcps.length === 0}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <div class="max-w-64">
            <span
              class="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-dimmed"
            >
              <Server size={18} />
            </span>
            <h2 class="mt-3 text-sm font-semibold text-foreground">No MCP servers</h2>
            <p class="mt-1 text-xs leading-relaxed text-dimmed">
              No Model Context Protocol servers match this filter.
            </p>
            <button
              type="button"
              class="mt-3 rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay"
              title="Open utility settings"
              onclick={openUtilitiesSettings}
            >
              Open Utilities
            </button>
          </div>
        </div>
      {:else}
        {#each filteredMcps as entry (entry.id)}
          <div class="group border-b border-border px-4 py-3 transition-colors hover:bg-elevated">
            <div class="flex items-start gap-3">
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
              >
                <Server size={15} />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    class="truncate cursor-pointer text-xs font-semibold text-foreground hover:text-primary"
                    title={`Edit ${entry.name}`}
                    onclick={() => openEditor(entry)}
                  >
                    {entry.name}
                  </button>
                  <span class="rounded-md bg-raised px-1.5 py-0.5 text-[10px] text-muted">
                    {originLabel(entry)}
                  </span>
                  {#if !entry.enabled}
                    <span class="rounded-md bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger">
                      Disabled
                    </span>
                  {/if}
                </div>
                {#if entry.description}
                  <p class="mt-1 line-clamp-2 text-[10px] leading-relaxed text-dimmed">
                    {entry.description}
                  </p>
                {/if}
                {#if entry.detail}
                  <p class="mt-1 truncate font-mono text-[10px] text-dimmed" title={entry.detail}>
                    {entry.detail}
                  </p>
                {/if}
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-lg text-dimmed hover:bg-elevated hover:text-foreground"
                  aria-label="Edit {entry.name}"
                  title="Edit {entry.name}"
                  onclick={() => openEditor(entry)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-lg text-dimmed hover:bg-danger/10 hover:text-danger"
                  aria-label="Delete {entry.name}"
                  title="Delete {entry.name}"
                  onclick={() => (deleteTarget = entry)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          </div>
        {/each}
      {/if}
    {:else if section === 'skills'}
      {#if capabilitiesLoading}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <p class="text-xs text-dimmed">Loading skills…</p>
        </div>
      {:else if capabilitiesError}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <div class="max-w-64">
            <p class="text-xs leading-relaxed text-danger" role="alert">{capabilitiesError}</p>
          </div>
        </div>
      {:else if filteredSkills.length === 0}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <div class="max-w-64">
            <span
              class="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-dimmed"
            >
              <BookOpen size={18} />
            </span>
            <h2 class="mt-3 text-sm font-semibold text-foreground">No skills</h2>
            <p class="mt-1 text-xs leading-relaxed text-dimmed">
              No reusable skills match this filter.
            </p>
            <button
              type="button"
              class="mt-3 rounded-lg border border-border bg-elevated px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-overlay"
              title="Open utility settings"
              onclick={openUtilitiesSettings}
            >
              Open Utilities
            </button>
          </div>
        </div>
      {:else}
        {#each filteredSkills as entry (entry.id)}
          <div class="group border-b border-border px-4 py-3 transition-colors hover:bg-elevated">
            <div class="flex items-start gap-3">
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted"
              >
                <BookOpen size={15} />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    class="truncate cursor-pointer text-xs font-semibold text-foreground hover:text-primary"
                    title={`Edit ${entry.name}`}
                    onclick={() => openEditor(entry)}
                  >
                    {entry.name}
                  </button>
                  <span class="rounded-md bg-raised px-1.5 py-0.5 text-[10px] text-muted">
                    {originLabel(entry)}
                  </span>
                  {#if !entry.enabled}
                    <span class="rounded-md bg-danger/10 px-1.5 py-0.5 text-[10px] text-danger">
                      Disabled
                    </span>
                  {/if}
                </div>
                {#if entry.description}
                  <p class="mt-1 line-clamp-2 text-[10px] leading-relaxed text-dimmed">
                    {entry.description}
                  </p>
                {/if}
                {#if entry.detail}
                  <p class="mt-1 truncate font-mono text-[10px] text-dimmed" title={entry.detail}>
                    {entry.detail}
                  </p>
                {/if}
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-lg text-dimmed hover:bg-elevated hover:text-foreground"
                  aria-label="Edit {entry.name}"
                  title="Edit {entry.name}"
                  onclick={() => openEditor(entry)}
                >
                  <Pencil size={13} />
                </button>
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-lg text-dimmed hover:bg-danger/10 hover:text-danger"
                  aria-label="Delete {entry.name}"
                  title="Delete {entry.name}"
                  onclick={() => (deleteTarget = entry)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
          </div>
        {/each}
      {/if}
    {:else}
      {#if processesLoading && processes.length === 0}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <p class="text-xs text-dimmed">Checking running processes…</p>
        </div>
      {:else if processesError && processes.length === 0}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <p class="max-w-64 text-xs leading-relaxed text-danger" role="alert">
            {processesError}
          </p>
        </div>
      {:else if processes.length === 0}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <div class="max-w-64">
            <span
              class="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-raised text-dimmed"
            >
              <SquareTerminal size={18} />
            </span>
            <h2 class="mt-3 text-sm font-semibold text-foreground">No running processes</h2>
            <p class="mt-1 text-xs leading-relaxed text-dimmed">
              Commands started by the agent will appear here while they are still running.
            </p>
          </div>
        </div>
      {:else}
        {#if processesError}
          <p class="border-b border-border px-4 py-2 text-xs text-danger" role="alert">
            {processesError}
          </p>
        {/if}
        {#each processes as runningProcess (runningProcess.pid)}
          <div class="border-b border-border px-4 py-3 transition-colors hover:bg-elevated">
            <div class="flex items-start gap-3">
              <span
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-primary"
              >
                <SquareTerminal size={15} />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <p class="truncate text-xs font-semibold text-foreground">
                    {processName(runningProcess.command)}
                  </p>
                  <span class="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[10px] text-muted">
                    Running
                  </span>
                </div>
                <p
                  class="mt-1 line-clamp-2 font-mono text-[10px] leading-relaxed text-dimmed"
                  title={runningProcess.command}
                >
                  {runningProcess.command}
                </p>
                <p class="mt-1 text-[10px] text-dimmed tabular-nums">
                  PID {runningProcess.pid} · Started {processStartedAt(runningProcess.startedAt)}
                </p>
              </div>
              <button
                type="button"
                class="flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-danger/30 bg-danger/10 px-2 text-[11px] font-medium text-danger transition-colors hover:bg-danger/15 disabled:opacity-50"
                disabled={stoppingPids.has(runningProcess.pid)}
                aria-label={`Stop ${processName(runningProcess.command)} process ${runningProcess.pid}`}
                title={`Stop process ${runningProcess.pid}`}
                onclick={() => stopProcess(runningProcess.pid)}
              >
                {#if stoppingPids.has(runningProcess.pid)}
                  <Loader2 size={12} class="animate-spin" />
                {/if}
                Stop
              </button>
            </div>
          </div>
        {/each}
      {/if}
    {/if}
  </div>
</div>

<UtilityEditorModal
  open={editorOpen}
  target={editorTarget}
  onClose={() => (editorOpen = false)}
  onChanged={() => void loadCapabilities()}
/>

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
