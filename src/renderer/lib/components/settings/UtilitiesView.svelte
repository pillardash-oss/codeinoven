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
  import { providerStore } from '$lib/stores/providers.svelte'
  import Switch from '../ui/Switch.svelte'
  import ToolsView from './ToolsView.svelte'
  import UtilityEditorModal, { type UtilityEditorTarget } from './UtilityEditorModal.svelte'
  import type {
    AgentCapabilityEntry,
    UtilityBundleInstallRequest,
    UtilityDefinition,
    UtilityKind
  } from '$shared/types'

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
      ...utility.harnessBindings.map((binding) => binding.harnessId)
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
        ...(capabilities ? [...nativeRows(capabilities.skill), ...nativeRows(capabilities.mcp)] : [])
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

  let availableTags = $derived(
    Array.from(new Set(tabRows().flatMap((row) => row.tags))).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    )
  )

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
    if (tag === 'App') return 'App-managed'
    if (tag === 'Global') return 'Global'
    if (tag === 'Project') return 'Project'
    return harnessName(tag)
  }

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
  })
</script>

<div class="mx-auto max-w-5xl p-6 pb-24">
  <div class="mb-5 flex flex-wrap items-center justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Utilities</h1>
      <p class="mt-0.5 max-w-2xl text-sm text-muted">{TAB_BLURB[activeTab]}</p>
    </div>
    <div class="flex flex-wrap items-center gap-2">
      {#if activeTab !== 'tools'}
        <button
          class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
          disabled={loading}
          title="Refresh the utility catalog"
          onclick={() => void load()}
        >
          <RefreshCw size={13} class={loading ? 'animate-spin' : ''} /> Refresh
        </button>
      {/if}
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-medium text-on-primary hover:bg-primary-hover"
        title="Add a skill, MCP server, or other utility"
        onclick={openCreate}
      >
        <Plus size={13} /> Add utility
      </button>
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
  </div>

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
      <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}

    <div class="mb-3 grid gap-2 sm:grid-cols-[minmax(0,1fr)_10rem]">
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
                : 'all utilities'}"
          bind:value={query}
        />
      </label>
      <span class="flex items-center justify-end text-xs text-muted">
        {filteredRows.length}
        {filteredRows.length === 1 ? 'entry' : 'entries'}
      </span>
    </div>

    {#if availableTags.length}
      <div class="mb-4 flex flex-wrap gap-1.5" role="group" aria-label="Filter by scope or harness">
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
            {#if tag === 'App' || tag === 'Global' || tag === 'Project'}
              <span>{scopeTagLabel(tag)}</span>
            {:else}
              <AgentIcon agentId={tag} label={scopeTagLabel(tag)} size={14} />
              {scopeTagLabel(tag)}
            {/if}
          </button>
        {/each}
      </div>
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
                    {#if tag === 'App' || tag === 'Global' || tag === 'Project'}
                      <span>{scopeTagLabel(tag)}</span>
                    {:else}
                      <AgentIcon agentId={tag} label={scopeTagLabel(tag)} size={14} />
                      {scopeTagLabel(tag)}
                    {/if}
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
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-foreground"
                aria-label="Edit {row.name}"
                title="Edit {row.name}"
                onclick={() => openEdit(row)}
              >
                <Pencil size={14} />
              </button>
              {#if !row.appOwned}
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
  {:else}
    <ToolsView embedded />
  {/if}
</div>

<UtilityEditorModal
  open={editorOpen}
  target={editorTarget}
  onClose={() => (editorOpen = false)}
  onSaved={replaceUtility}
  onChanged={() => void load()}
/>

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
