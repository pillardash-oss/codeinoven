<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    BookOpen,
    Boxes,
    Globe2,
    KeyRound,
    LayoutGrid,
    Loader2,
    Pencil,
    Plus,
    Puzzle,
    RefreshCw,
    Search,
    Server,
    Trash2,
    Upload,
    Wrench
  } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { invoke } from '$lib/ipc.svelte'
  import { agentToolsStore } from '$lib/stores/agent-tools.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { publicAssetUrl } from '$lib/static-assets'
  import Switch from '../ui/Switch.svelte'
  import UtilityEditorModal, { type UtilityEditorTarget } from './UtilityEditorModal.svelte'
  import type {
    AgentCapabilityEntry,
    AgentToolDefinition,
    UtilityBundleInstallRequest,
    UtilityDefinition,
    UtilityKind
  } from '$shared/types'
  import { ALL_HARNESSES_BINDING_ID } from '$shared/types'

  interface Props {
    onOpenMarketplace: () => void
  }

  let { onOpenMarketplace }: Props = $props()

  const cioIconUrl = publicAssetUrl('icon.svg')

  type Tab = 'all' | 'skills' | 'mcp' | 'plugins' | 'web' | 'tools'

  type RowItem =
    | {
        id: string
        src: 'registry'
        utility: UtilityDefinition
        name: string
        description: string
        enabled: boolean
        appOwned: boolean
        tags: string[]
      }
    | {
        id: string
        src: 'native'
        entry: AgentCapabilityEntry
        name: string
        description: string
        enabled: boolean
        appOwned: false
        tags: string[]
      }

  interface ToolGroup {
    key: string
    definition: AgentToolDefinition
    harnessIds: string[]
    sentWhen: string[]
  }

  let utilities = $state<UtilityDefinition[]>([])
  let capabilities = $state<{ mcp: AgentCapabilityEntry[]; skill: AgentCapabilityEntry[] } | null>(
    null
  )
  let secureStorageAvailable = $state(true)
  let loading = $state(true)
  let error = $state('')
  let query = $state('')
  let activeTab = $state<Tab>('all')
  let scopeFilter = $state('all')
  let editorOpen = $state(false)
  let editorTarget = $state<UtilityEditorTarget | null>(null)
  let pluginManifest = $state('')

  let tabs: Array<{ id: Tab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'skills', label: 'Skills' },
    { id: 'mcp', label: 'MCP' },
    { id: 'plugins', label: 'Plugins' },
    { id: 'web', label: 'Web & vision' },
    { id: 'tools', label: 'Tools' }
  ]

  const TAB_BLURB: Record<Tab, string> = {
    all: 'Every skill, MCP server, and web utility installed in CodeInOven.',
    skills: 'Skills for every harness plus the shared global layer.',
    mcp: 'MCP servers for every harness plus the shared global layer.',
    plugins: 'Install a plugin bundle that adds capabilities together.',
    web: 'Web search, web fetch, provider, and image-descriptor utilities.',
    tools: 'Inspect stable tool references and the exact schemas exposed to agent models.'
  }

  const isListTab = (tab: Tab): boolean =>
    tab === 'all' || tab === 'skills' || tab === 'mcp' || tab === 'web' || tab === 'tools'

  function harnessName(harnessId: string): string {
    return (
      providerStore.providers.find((provider) => provider.id === harnessId)?.name ??
      getAgentIcon(harnessId)?.name ??
      harnessId
    )
  }

  function kindLabel(kind: UtilityKind): string {
    const kinds: Array<{ id: UtilityKind; label: string }> = [
      { id: 'web_search', label: 'Web search' },
      { id: 'web_fetch', label: 'Web fetch' },
      { id: 'provider', label: 'Provider' },
      { id: 'image_descriptor', label: 'Image descriptor' }
    ]
    return kinds.find((item) => item.id === kind)?.label ?? kind
  }

  function nativeTags(entry: AgentCapabilityEntry): string[] {
    const tags: string[] = []
    if (entry.origin === 'global') tags.push(entry.projectId ? 'Project' : 'Global')
    if (entry.harnessId) tags.push(entry.harnessId)
    return tags
  }

  function registryTags(utility: UtilityDefinition): string[] {
    return [
      'App',
      ...(utility.scope.level === 'global' ? ['Global'] : []),
      ...(utility.scope.level === 'project' ? ['Project'] : []),
      ...utility.harnessBindings.map((binding) =>
        binding.harnessId === ALL_HARNESSES_BINDING_ID ? 'All harnesses' : binding.harnessId
      )
    ]
  }

  function nativeRows(entries: AgentCapabilityEntry[]): RowItem[] {
    return entries.map((entry) => ({
      id: entry.id,
      src: 'native' as const,
      entry,
      name: entry.name,
      description: entry.description ?? '',
      enabled: entry.enabled,
      appOwned: false,
      tags: nativeTags(entry)
    }))
  }

  function registryRows(utilities: UtilityDefinition[]): RowItem[] {
    return utilities.map((utility) => ({
      id: `registry:${utility.id}`,
      src: 'registry' as const,
      utility,
      name: utility.name,
      description: utility.description ?? '',
      enabled: utility.enabled,
      appOwned: Boolean(utility.appOwned),
      tags: registryTags(utility)
    }))
  }

  const WEB_KINDS: Array<UtilityKind> = ['web_search', 'web_fetch', 'provider', 'image_descriptor']

  function tabRows(): RowItem[] {
    if (activeTab === 'all') {
      return [
        ...registryRows(
          utilities.filter(
            (utility) => utility.kind === 'skill' || WEB_KINDS.includes(utility.kind)
          )
        ),
        ...registryRows(utilities.filter((utility) => utility.kind === 'mcp')),
        ...(capabilities
          ? [...nativeRows(capabilities.skill), ...nativeRows(capabilities.mcp)]
          : [])
      ]
    }
    if (activeTab === 'skills') {
      return [
        ...registryRows(utilities.filter((utility) => utility.kind === 'skill')),
        ...(capabilities ? nativeRows(capabilities.skill) : [])
      ]
    }
    if (activeTab === 'mcp') {
      return [
        ...registryRows(utilities.filter((utility) => utility.kind === 'mcp')),
        ...(capabilities ? nativeRows(capabilities.mcp) : [])
      ]
    }
    if (activeTab === 'web') {
      return registryRows(utilities.filter((utility) => WEB_KINDS.includes(utility.kind)))
    }
    return []
  }

  function rowIcon(row: RowItem): typeof BookOpen {
    const kind = row.src === 'registry' ? row.utility.kind : row.entry.kind
    if (kind === 'skill') return BookOpen
    if (kind === 'mcp') return Server
    return Globe2
  }

  function rowKindBadge(row: RowItem): string {
    if (row.src === 'registry') {
      if (row.utility.kind === 'skill') return 'Skill'
      if (row.utility.kind === 'mcp') return 'MCP'
      return kindLabel(row.utility.kind)
    }
    return row.entry.origin === 'global' ? 'Global' : 'Harness'
  }

  let availableTags = $derived.by(() => {
    const tags = Array.from(new Set(tabRows().flatMap((row) => row.tags)))
    tags.sort((a, b) => {
      if (a === 'App') return -1
      if (b === 'App') return 1
      return a.localeCompare(b, undefined, { sensitivity: 'base' })
    })
    return tags
  })

  let filteredRows = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    return tabRows().filter((row) => {
      if (scopeFilter !== 'all' && !row.tags.includes(scopeFilter)) return false
      if (!needle) return true
      return [row.name, row.description, ...row.tags].some((value) =>
        value.toLowerCase().includes(needle)
      )
    })
  })

  function scopeTagLabel(tag: string): string {
    if (tag === 'App') return 'CIO'
    if (tag === 'Global') return 'Global'
    if (tag === 'Project') return 'Project'
    if (tag === 'All harnesses') return 'All harnesses'
    return harnessName(tag)
  }

  // Tools tab — reads from the shared, cached agent tool catalog store so
  // switching tabs never re-triggers a driver probe or drops the filters.
  let toolHarnesses = $derived(agentToolsStore.catalog?.harnesses ?? [])
  let selectedToolHarnessDetails = $derived(
    toolHarnesses.find((harness) => harness.id === agentToolsStore.selectedHarness)
  )

  let toolGroups = $derived.by((): ToolGroup[] => {
    const groups: ToolGroup[] = []
    for (const tool of agentToolsStore.catalog?.tools ?? []) {
      const key = [
        tool.source,
        tool.name,
        tool.transportName ?? '',
        tool.description,
        JSON.stringify(tool.inputSchema)
      ].join(' ')
      const existing = groups.find((group) => group.key === key)
      if (existing) {
        if (!existing.harnessIds.includes(tool.harnessId)) existing.harnessIds.push(tool.harnessId)
        if (!existing.sentWhen.includes(tool.sentWhen)) existing.sentWhen.push(tool.sentWhen)
      } else {
        groups.push({
          key,
          definition: tool,
          harnessIds: [tool.harnessId],
          sentWhen: [tool.sentWhen]
        })
      }
    }
    return groups
  })

  let filteredToolGroups = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    const groups = toolGroups
      .filter(
        (group) =>
          agentToolsStore.selectedSource === 'all' ||
          group.definition.source === agentToolsStore.selectedSource
      )
      .filter(
        (group) =>
          agentToolsStore.selectedHarness === null ||
          group.harnessIds.includes(agentToolsStore.selectedHarness)
      )
    if (!needle) return groups
    return groups.filter((group) =>
      [
        group.definition.name,
        group.definition.transportName ?? '',
        group.definition.description,
        group.definition.source,
        ...group.harnessIds,
        ...group.harnessIds.map(toolHarnessName),
        ...group.sentWhen
      ].some((value) => value.toLowerCase().includes(needle))
    )
  })

  function toolHarnessName(harnessId: string): string {
    return toolHarnesses.find((harness) => harness.id === harnessId)?.name ?? harnessId
  }

  function toolHarnessGroupCount(harnessId: string): number {
    return toolGroups.filter((group) => group.harnessIds.includes(harnessId)).length
  }

  function schemaText(tool: AgentToolDefinition): string {
    return JSON.stringify(tool.inputSchema, null, 2)
  }

  function setToolSource(value: string): void {
    if (value === 'all' || value === 'application' || value === 'harness') {
      agentToolsStore.selectedSource = value
    }
  }

  let resultCount = $derived(
    activeTab === 'tools' ? filteredToolGroups.length : filteredRows.length
  )

  function replaceUtility(updated: UtilityDefinition): void {
    utilities = utilities.some((utility) => utility.id === updated.id)
      ? utilities.map((utility) => (utility.id === updated.id ? updated : utility))
      : [...utilities, updated]
  }

  function openCreate(): void {
    editorTarget = { kind: 'registry', utility: null }
    editorOpen = true
  }

  function openEdit(row: RowItem): void {
    if (row.src === 'registry') {
      editorTarget = { kind: 'registry', utility: row.utility }
    } else {
      editorTarget = { kind: 'native', entry: row.entry }
    }
    editorOpen = true
  }

  async function load(): Promise<void> {
    loading = true
    error = ''
    try {
      const [catalog, capabilitiesCatalog] = await Promise.all([
        invoke('utilities:list'),
        invoke('capabilities:listAll')
      ])
      utilities = catalog.utilities
      secureStorageAvailable = catalog.secureStorageAvailable
      capabilities = capabilitiesCatalog
    } catch (loadError) {
      error =
        loadError instanceof Error ? loadError.message : 'The utility catalog could not be loaded.'
    } finally {
      loading = false
    }
  }

  function refreshActiveTab(): void {
    if (activeTab === 'tools') void agentToolsStore.load(true)
    else void load()
  }

  async function toggleEnabled(row: RowItem): Promise<void> {
    if (row.src !== 'registry') return
    error = ''
    try {
      const updated = await invoke('utilities:update', row.utility.id, {
        enabled: !row.utility.enabled
      })
      utilities = utilities.map((utility) => (utility.id === updated.id ? updated : utility))
    } catch (updateError) {
      error =
        updateError instanceof Error ? updateError.message : 'The utility could not be updated.'
    }
  }

  let deleteTarget = $state<RowItem | null>(null)
  let deleting = $state(false)

  async function confirmDelete(): Promise<void> {
    const row = deleteTarget
    if (!row) return
    deleting = true
    error = ''
    try {
      if (row.src === 'registry') {
        if (await invoke('utilities:delete', row.utility.id)) {
          utilities = utilities.filter((utility) => utility.id !== row.utility.id)
        }
      } else if (row.entry.kind === 'skill') {
        if (await invoke('capabilities:deleteSkill', row.entry.source)) {
          capabilities = capabilities
            ? { ...capabilities, skill: capabilities.skill.filter((e) => e.id !== row.entry.id) }
            : capabilities
        }
      } else {
        if (await invoke('capabilities:deleteMcp', row.entry.source)) {
          capabilities = capabilities
            ? { ...capabilities, mcp: capabilities.mcp.filter((e) => e.id !== row.entry.id) }
            : capabilities
        }
      }
      deleteTarget = null
    } catch (deleteError) {
      error =
        deleteError instanceof Error ? deleteError.message : 'The capability could not be deleted.'
    } finally {
      deleting = false
    }
  }

  async function readPluginFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (file) pluginManifest = await file.text()
  }

  async function importPluginBundle(): Promise<void> {
    error = ''
    try {
      const parsed: unknown = JSON.parse(pluginManifest)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('The plugin manifest must be a JSON object.')
      }
      await invoke('utilities:installBundle', parsed as UtilityBundleInstallRequest)
      pluginManifest = ''
      await load()
    } catch (installError) {
      error =
        installError instanceof Error ? installError.message : 'The plugin could not be installed.'
    }
  }

  onMount(() => {
    void load()
    void providerStore.init()
    void agentToolsStore.load()
  })
</script>

{#snippet tagChip(tag: string)}
  {#if tag === 'App'}
    <span
      class="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm"
      title="CodeInOven"
    >
      <img class="h-full w-full object-contain" src={cioIconUrl} alt="" />
    </span>
    <span>{scopeTagLabel(tag)}</span>
  {:else if tag === 'Global' || tag === 'Project' || tag === 'All harnesses'}
    <span>{scopeTagLabel(tag)}</span>
  {:else}
    <AgentIcon agentId={tag} label={scopeTagLabel(tag)} size={14} />
    <span>{scopeTagLabel(tag)}</span>
  {/if}
{/snippet}

<div class="mx-auto max-w-5xl p-6 pb-24">
  <!-- Row 1 — page title and tabs, fixed. Never shifts with the active tab. -->
  <div class="flex flex-wrap items-center justify-between gap-4">
    <h1 class="text-xl font-bold tracking-tight">Utilities</h1>
    <div
      class="flex flex-wrap items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
      role="tablist"
      aria-label="Utilities sections"
    >
      {#each tabs as tab (tab.id)}
        <button
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {activeTab ===
          tab.id
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          role="tab"
          aria-selected={activeTab === tab.id}
          title="{tab.label} utilities"
          onclick={() => (activeTab = tab.id)}
        >
          {#if tab.id === 'all'}
            <LayoutGrid size={13} />
          {:else if tab.id === 'skills'}
            <BookOpen size={13} />
          {:else if tab.id === 'mcp'}
            <Server size={13} />
          {:else if tab.id === 'plugins'}
            <Boxes size={13} />
          {:else if tab.id === 'web'}
            <Globe2 size={13} />
          {:else}
            <Wrench size={13} />
          {/if}
          {tab.label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Row 2 — description, under the title/tabs row. -->
  <p class="mt-1 min-h-4 text-sm text-muted">{TAB_BLURB[activeTab]}</p>

  <!-- Row 3 — catalog actions stay stable across every tab. -->
  <div class="mt-4 flex flex-wrap items-center justify-between gap-2">
    <div class="flex flex-wrap gap-2">
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-medium text-on-primary hover:bg-primary-hover"
        title="Add a skill, MCP server, or other utility"
        onclick={openCreate}
      >
        <Plus size={13} /> Add utility
      </button>
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
        disabled={activeTab === 'tools'
          ? agentToolsStore.loading || agentToolsStore.refreshing
          : loading}
        title="Refresh utilities"
        onclick={refreshActiveTab}
      >
        <RefreshCw
          size={13}
          class={(
            activeTab === 'tools' ? agentToolsStore.loading || agentToolsStore.refreshing : loading
          )
            ? 'animate-spin'
            : ''}
        /> Refresh
      </button>
    </div>
    {#if activeTab === 'all' || activeTab === 'skills'}
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay"
        title="Open the skills marketplace"
        onclick={onOpenMarketplace}
      >
        <Search size={13} /> Skills marketplace
      </button>
    {/if}
  </div>

  {#if isListTab(activeTab)}
    <!-- Row 4 — search and entry count: one row, same position for every list tab. -->
    <div class="mt-4 grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
      <label class="relative block">
        <Search
          size={14}
          class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dimmed"
        />
        <span class="sr-only">Search utilities</span>
        <input
          class="h-9 w-full rounded-lg border bg-surface pl-9 pr-3 text-sm outline-none focus:border-primary"
          type="search"
          placeholder="Search {activeTab === 'skills'
            ? 'skills'
            : activeTab === 'mcp'
              ? 'MCP servers'
              : activeTab === 'web'
                ? 'web & vision utilities'
                : activeTab === 'tools'
                  ? 'names, sources, and descriptions'
                  : 'all utilities'}"
          bind:value={query}
        />
      </label>
      <span class="flex items-center justify-end whitespace-nowrap text-xs text-muted">
        {resultCount}
        {resultCount === 1
          ? activeTab === 'tools'
            ? 'tool'
            : 'entry'
          : activeTab === 'tools'
            ? 'tools'
            : 'entries'}
      </span>
    </div>

    <!-- Row 5 — filter chips: scope/harness tags for utility tabs, source + harness for Tools. Same row for every list tab. -->
    <div class="mt-4 flex flex-wrap items-center gap-1.5" role="group" aria-label="Filters">
      {#if activeTab === 'tools'}
        <select
          class="h-7 rounded-lg border bg-elevated px-2 text-[11px] font-medium outline-none focus:border-primary"
          aria-label="Filter tools by source"
          value={agentToolsStore.selectedSource}
          onchange={(event: Event) =>
            setToolSource((event.currentTarget as HTMLSelectElement).value)}
        >
          <option value="all">All sources</option>
          <option value="application">Application</option>
          <option value="harness">Harnesses</option>
        </select>
        {#if toolHarnesses.length && agentToolsStore.selectedSource !== 'application'}
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {agentToolsStore.selectedHarness ===
            null
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={agentToolsStore.selectedHarness === null}
            onclick={() => (agentToolsStore.selectedHarness = null)}
          >
            All
            <span class="tabular-nums opacity-70">{toolGroups.length}</span>
          </button>
          {#each toolHarnesses as harness (harness.id)}
            <button
              type="button"
              class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {agentToolsStore.selectedHarness ===
              harness.id
                ? 'border-primary bg-primary text-on-primary'
                : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
              aria-pressed={agentToolsStore.selectedHarness === harness.id}
              title={harness.detail}
              onclick={() => (agentToolsStore.selectedHarness = harness.id)}
            >
              <AgentIcon agentId={harness.id} label={harness.name} size={14} />
              {harness.name}
              <span class="tabular-nums opacity-70">{toolHarnessGroupCount(harness.id)}</span>
            </button>
          {/each}
        {/if}
      {:else}
        <button
          type="button"
          class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {scopeFilter ===
          'all'
            ? 'border-primary bg-primary text-on-primary'
            : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
          aria-pressed={scopeFilter === 'all'}
          onclick={() => (scopeFilter = 'all')}
        >
          All
        </button>
        {#each availableTags as tag (tag)}
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {scopeFilter ===
            tag
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={scopeFilter === tag}
            onclick={() => (scopeFilter = tag)}
          >
            {@render tagChip(tag)}
          </button>
        {/each}
      {/if}
    </div>
  {/if}

  <!-- Row 6 — tab content. -->
  <div class="mt-4">
    {#if activeTab === 'all' || activeTab === 'skills' || activeTab === 'mcp' || activeTab === 'web'}
      {#if (activeTab === 'all' || activeTab === 'skills' || activeTab === 'mcp') && !secureStorageAvailable}
        <div
          class="mb-4 flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning"
        >
          <AlertTriangle size={14} class="mt-0.5 shrink-0" />
          <span>Secure storage is unavailable. Credentials cannot be saved on this device.</span>
        </div>
      {/if}
      {#if error}
        <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {error}
        </p>
      {/if}

      {#if loading && tabRows().length === 0}
        <div class="rounded-xl border border-dashed p-8 text-center">
          <Loader2 size={18} class="mx-auto mb-2 animate-spin text-dimmed" />
          <p class="text-xs text-dimmed">Loading…</p>
        </div>
      {:else if filteredRows.length === 0}
        <div class="rounded-xl border border-dashed p-8 text-center">
          <Puzzle size={18} class="mx-auto mb-2 text-dimmed" />
          <p class="text-sm font-medium">No matching entries</p>
          <p class="mt-1 text-xs text-dimmed">Add a utility or change the filters.</p>
        </div>
      {:else}
        <div class="divide-y rounded-xl border bg-surface">
          {#each filteredRows as row (row.id)}
            {@const Icon = rowIcon(row)}
            <div class="flex items-start gap-3 p-4">
              <div
                class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted"
              >
                <Icon size={15} />
              </div>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <p class="text-sm font-semibold">{row.name}</p>
                  <span
                    class="rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted"
                  >
                    {rowKindBadge(row)}
                  </span>
                  {#if row.appOwned}
                    <span
                      class="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary"
                      title="Built into the app and always available; it cannot be deleted"
                    >
                      Built-in
                    </span>
                  {/if}
                  {#if row.src === 'registry'}
                    <span class="text-[11px] text-dimmed">
                      {row.utility.activation === 'always' ? 'Always available' : 'On demand'}
                    </span>
                  {/if}
                </div>
                {#if row.description}
                  <p class="mt-1 text-xs leading-relaxed text-muted">{row.description}</p>
                {/if}
                {#if row.src === 'native' && row.entry.detail}
                  <p class="mt-1 truncate font-mono text-[10px] text-dimmed">{row.entry.detail}</p>
                {/if}
                <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-dimmed">
                  {#each row.tags as tag (tag)}
                    <span
                      class="flex h-6 items-center gap-1.5 rounded-md border bg-elevated px-2 text-[10px] font-medium text-muted"
                    >
                      {@render tagChip(tag)}
                    </span>
                  {/each}
                  {#if row.src === 'registry' && row.utility.credentials.length}
                    <span class="flex items-center gap-1">
                      <KeyRound size={11} />
                      {row.utility.credentials.length}
                      {row.utility.credentials.length === 1 ? 'credential' : 'credentials'}
                    </span>
                  {/if}
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                {#if row.src === 'registry' && !row.appOwned}
                  <Switch
                    checked={row.enabled}
                    onchange={() => void toggleEnabled(row)}
                    aria-label="{row.enabled ? 'Disable' : 'Enable'} {row.name}"
                    title="{row.enabled ? 'Disable' : 'Enable'} {row.name}"
                  />
                {/if}
                {#if !row.appOwned}
                  <button
                    class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-foreground"
                    aria-label="Edit {row.name}"
                    title="Edit {row.name}"
                    onclick={() => openEdit(row)}
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                    aria-label="Delete {row.name}"
                    title="Delete {row.name}"
                    onclick={() => (deleteTarget = row)}
                  >
                    <Trash2 size={14} />
                  </button>
                {/if}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    {:else if activeTab === 'plugins'}
      <div class="rounded-xl border bg-surface p-5">
        <div class="rounded-xl border border-dashed bg-elevated p-5">
          <Boxes size={20} class="mb-3 text-muted" />
          <p class="text-sm font-semibold">Import a plugin bundle</p>
          <p class="mt-1 text-xs leading-relaxed text-muted">
            A plugin bundle can install several MCP servers, skills, and web utilities together.
            Installation is atomic: if one entry is invalid, nothing is added. The installed
            capabilities appear on their respective tabs.
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
        {#if error}
          <p class="mt-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
            {error}
          </p>
        {/if}
        <label class="mt-4 block space-y-1 text-xs font-medium">
          <span>Or paste the manifest</span>
          <textarea
            class="min-h-64 w-full resize-y rounded-xl border bg-raised px-3 py-2 font-mono text-xs outline-none focus:border-primary"
            placeholder={'{\n  "name": "My plugin",\n  "utilities": [\n    { "definition": { ... }, "credentials": [] }\n  ]\n}'}
            bind:value={pluginManifest}></textarea>
        </label>
        <button
          class="mt-3 flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          type="button"
          disabled={!pluginManifest.trim()}
          onclick={() => void importPluginBundle()}
        >
          <Upload size={13} /> Install bundle
        </button>
      </div>
    {:else if activeTab === 'tools'}
      {#if agentToolsStore.catalog?.notices.length}
        <div class="mb-4 space-y-2">
          {#each agentToolsStore.catalog.notices as notice (notice)}
            <p class="rounded-lg border bg-elevated px-3 py-2 text-xs text-muted">
              {notice}
            </p>
          {/each}
        </div>
      {/if}
      {#if agentToolsStore.error}
        <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
          {agentToolsStore.error}
        </p>
      {/if}

      {#if agentToolsStore.loading && !agentToolsStore.catalog}
        <div class="rounded-xl border border-dashed p-8 text-center">
          <RefreshCw size={18} class="mx-auto mb-2 animate-spin text-dimmed" />
          <p class="text-xs text-dimmed">Loading agent tools…</p>
        </div>
      {:else if filteredToolGroups.length}
        <div class="space-y-2">
          {#each filteredToolGroups as group (group.key)}
            {@const tool = group.definition}
            <details class="group rounded-xl border bg-surface">
              <summary
                class="flex cursor-pointer list-none items-start gap-3 p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              >
                <span
                  class="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted"
                >
                  <Wrench size={14} />
                </span>
                <span class="min-w-0 flex-1">
                  <span class="flex flex-wrap items-center gap-2">
                    <span class="font-mono text-sm font-semibold">{tool.name}</span>
                    <span
                      class="rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted"
                    >
                      {tool.source}
                    </span>
                    {#each group.harnessIds as harnessId (harnessId)}
                      <span
                        class="flex h-6 items-center gap-1.5 rounded-md border bg-elevated px-2 text-[10px] font-medium text-muted"
                      >
                        <AgentIcon
                          agentId={harnessId}
                          label={toolHarnessName(harnessId)}
                          size={14}
                        />
                        {toolHarnessName(harnessId)}
                      </span>
                    {/each}
                  </span>
                  {#if tool.transportName}
                    <span class="mt-1 block text-[11px] text-dimmed">
                      Wire name: <span class="font-mono">{tool.transportName}</span>
                    </span>
                  {/if}
                  <span class="mt-1 block text-xs leading-relaxed text-muted">
                    {tool.description || 'No description supplied by the harness.'}
                  </span>
                  <span class="mt-1 block text-[11px] text-dimmed">
                    Sent when: {group.sentWhen.join(' · ')}
                  </span>
                </span>
              </summary>
              <div class="border-t p-4">
                <p class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">
                  Input / parameter schema
                </p>
                <pre
                  class="max-h-128 overflow-auto rounded-lg bg-raised p-3 font-mono text-[11px] leading-relaxed text-foreground"><code
                    >{schemaText(tool)}</code
                  ></pre>
              </div>
            </details>
          {/each}
        </div>
      {:else}
        <div class="rounded-xl border border-dashed p-8 text-center">
          <Wrench size={18} class="mx-auto mb-2 text-dimmed" />
          <p class="text-sm font-medium">
            {selectedToolHarnessDetails?.status === 'unsupported' ||
            selectedToolHarnessDetails?.status === 'unavailable'
              ? `${selectedToolHarnessDetails.name} schemas unavailable`
              : 'No matching tools'}
          </p>
          <p class="mt-1 text-xs text-dimmed">
            {selectedToolHarnessDetails?.detail ??
              'Clear the search or open a configured thread to load harness tools.'}
          </p>
        </div>
      {/if}
    {/if}
  </div>
</div>

{#if editorOpen}
  <UtilityEditorModal
    open
    target={editorTarget}
    onClose={() => (editorOpen = false)}
    onSaved={replaceUtility}
    onChanged={() => void load()}
  />
{/if}

{#if deleteTarget}
  <div class="fixed inset-0 z-50 flex items-center justify-center">
    <button
      class="absolute inset-0 bg-overlay/70 backdrop-blur-[1px]"
      aria-label="Close modal"
      onclick={() => (deleteTarget = null)}
    ></button>
    <div
      class="relative mx-6 max-h-[calc(100vh-3rem)] w-full max-w-md overflow-hidden rounded-2xl border bg-surface shadow-xl"
    >
      <div class="flex shrink-0 items-center justify-between border-b px-6 py-4">
        <h2 class="text-base font-semibold">Delete utility</h2>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto p-6">
        <p class="text-sm text-muted">
          Delete <strong class="text-foreground">{deleteTarget.name}</strong>? Its files or registry
          entry will be removed.
        </p>
      </div>
      <div class="flex shrink-0 items-center justify-end gap-2 border-t bg-surface px-6 py-4">
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
      </div>
    </div>
  </div>
{/if}
