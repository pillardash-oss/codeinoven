<script lang="ts">
  import { onMount } from 'svelte'
  import {
    AlertTriangle,
    KeyRound,
    ListFilter,
    Loader2,
    MonitorUp,
    Pencil,
    Plus,
    Puzzle,
    RefreshCw,
    Search,
    Trash2,
    Wrench
  } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import { invoke } from '$lib/ipc.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import Switch from '../ui/Switch.svelte'
  import ToolsView from './ToolsView.svelte'
  import CuaBridgeSettings from './CuaBridgeSettings.svelte'
  import UtilityEditorModal, { type UtilityEditorTarget } from './UtilityEditorModal.svelte'
  import type { UtilityDefinition, UtilityKind, UtilityScope } from '$shared/types'

  let utilities = $state<UtilityDefinition[]>([])
  let secureStorageAvailable = $state(true)
  let loading = $state(true)
  let error = $state('')
  let query = $state('')
  let activeTab = $state<'utilities' | 'computer-use' | 'tools'>('utilities')
  let kindFilter = $state<UtilityKind | 'all'>('all')
  let harnessFilter = $state('all')
  let editorOpen = $state(false)
  let editorTarget = $state<UtilityEditorTarget | null>(null)

  let harnesses = $derived(
    Array.from(
      new Set(utilities.flatMap((utility) => utility.harnessBindings.map((item) => item.harnessId)))
    ).sort()
  )

  function kindLabel(kind: UtilityKind): string {
    const kinds: Array<{ id: UtilityKind; label: string }> = [
      { id: 'mcp', label: 'MCP' },
      { id: 'skill', label: 'Skill' },
      { id: 'web_search', label: 'Web search' },
      { id: 'web_fetch', label: 'Web fetch' },
      { id: 'computer_use', label: 'Computer use' },
      { id: 'provider', label: 'Provider' },
      { id: 'image_descriptor', label: 'Image descriptor' }
    ]
    return kinds.find((item) => item.id === kind)?.label ?? kind
  }

  function harnessName(harnessId: string): string {
    return (
      providerStore.providers.find((provider) => provider.id === harnessId)?.name ??
      getAgentIcon(harnessId)?.name ??
      harnessId
    )
  }

  function scopeLabel(scope: UtilityScope): string {
    if (scope.level === 'global') return 'Global'
    if (scope.level === 'project') return `Project · ${scope.projectId}`
    return `Thread · ${scope.threadId}`
  }

  let filteredUtilities = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    return utilities.filter((utility) => {
      if (kindFilter !== 'all' && utility.kind !== kindFilter) return false
      if (
        harnessFilter !== 'all' &&
        !utility.harnessBindings.some((binding) => binding.harnessId === harnessFilter)
      ) {
        return false
      }
      if (!needle) return true
      return [
        utility.name,
        utility.description,
        kindLabel(utility.kind),
        ...utility.harnessBindings.map((binding) => binding.harnessId)
      ].some((value) => value.toLowerCase().includes(needle))
    })
  })

  function replaceUtility(updated: UtilityDefinition): void {
    utilities = utilities.some((utility) => utility.id === updated.id)
      ? utilities.map((utility) => (utility.id === updated.id ? updated : utility))
      : [...utilities, updated]
  }

  function openCreate(): void {
    editorTarget = { kind: 'registry', utility: null }
    editorOpen = true
  }

  function openEdit(utility: UtilityDefinition): void {
    editorTarget = { kind: 'registry', utility }
    editorOpen = true
  }

  async function loadUtilities(): Promise<void> {
    loading = true
    error = ''
    try {
      const catalog = await invoke('utilities:list')
      utilities = catalog.utilities
      secureStorageAvailable = catalog.secureStorageAvailable
    } catch (loadError) {
      error =
        loadError instanceof Error ? loadError.message : 'The utility catalog could not be loaded.'
    } finally {
      loading = false
    }
  }

  async function toggleEnabled(utility: UtilityDefinition): Promise<void> {
    error = ''
    try {
      replaceUtility(await invoke('utilities:update', utility.id, { enabled: !utility.enabled }))
    } catch (updateError) {
      error =
        updateError instanceof Error ? updateError.message : 'The utility could not be updated.'
    }
  }

  async function deleteUtility(utility: UtilityDefinition): Promise<void> {
    error = ''
    try {
      if (await invoke('utilities:delete', utility.id)) {
        utilities = utilities.filter((item) => item.id !== utility.id)
      }
    } catch (deleteError) {
      error =
        deleteError instanceof Error ? deleteError.message : 'The utility could not be deleted.'
    }
  }

  let deleteTarget = $state<UtilityDefinition | null>(null)
  let deleting = $state(false)

  async function confirmDelete(): Promise<void> {
    if (!deleteTarget) return
    deleting = true
    try {
      await deleteUtility(deleteTarget)
      deleteTarget = null
    } finally {
      deleting = false
    }
  }

  onMount(() => {
    void loadUtilities()
    void providerStore.init()
  })
</script>

<div class="mx-auto max-w-5xl p-6 pb-24">
  <div class="mb-5 flex items-start justify-between gap-4">
    <div>
      <h1 class="text-xl font-bold tracking-tight">Utilities</h1>
      <p class="mt-0.5 max-w-2xl text-sm text-muted">
        {activeTab === 'utilities'
          ? 'Add capabilities that harnesses can use on demand.'
          : activeTab === 'computer-use'
            ? 'Install and connect desktop automation for every harness.'
            : 'Inspect stable tool references and the exact schemas exposed to agent models.'}
      </p>
    </div>
    <div class="flex shrink-0 items-center gap-2">
      {#if activeTab === 'utilities'}
        <button
          class="flex h-8 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
          disabled={loading}
          title="Refresh utility catalog"
          onclick={() => void loadUtilities()}
        >
          <RefreshCw size={13} class={loading ? 'animate-spin' : ''} /> Refresh
        </button>
        <button
          class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-medium text-on-primary hover:bg-primary-hover"
          title="Add a utility"
          onclick={openCreate}
        >
          <Plus size={13} /> Add utility
        </button>
      {/if}
      <div
        class="flex items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
        role="tablist"
        aria-label="Utilities sections"
      >
        <button
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {activeTab ===
          'utilities'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          role="tab"
          aria-selected={activeTab === 'utilities'}
          title="Manage installed capabilities"
          onclick={() => (activeTab = 'utilities')}
        >
          <Puzzle size={13} />
          Utilities
        </button>
        <button
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {activeTab ===
          'computer-use'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          role="tab"
          aria-selected={activeTab === 'computer-use'}
          title="Install and configure computer use"
          onclick={() => (activeTab = 'computer-use')}
        >
          <MonitorUp size={13} />
          Computer use
        </button>
        <button
          class="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors {activeTab ===
          'tools'
            ? 'bg-surface text-foreground shadow-sm'
            : 'text-muted hover:text-foreground'}"
          role="tab"
          aria-selected={activeTab === 'tools'}
          title="Inspect the agent tool catalog and schemas"
          onclick={() => (activeTab = 'tools')}
        >
          <Wrench size={13} />
          Tools
        </button>
      </div>
    </div>
  </div>

  {#if activeTab === 'utilities'}
    {#if !secureStorageAvailable}
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
          placeholder="Search utilities"
          bind:value={query}
        />
      </label>
      <select
        class="h-9 rounded-lg border bg-elevated px-2.5 text-xs font-medium outline-none focus:border-primary"
        aria-label="Filter utilities by kind"
        bind:value={kindFilter}
      >
        <option value="all">All kinds</option>
        <option value="mcp">MCP</option>
        <option value="skill">Skill</option>
        <option value="web_search">Web search</option>
        <option value="web_fetch">Web fetch</option>
        <option value="computer_use">Computer use</option>
        <option value="provider">Provider</option>
        <option value="image_descriptor">Image descriptor</option>
      </select>
    </div>

    {#if harnesses.length}
      <div
        class="mb-4 flex flex-wrap gap-1.5"
        role="group"
        aria-label="Filter utilities by harness"
      >
        <button
          type="button"
          class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {harnessFilter ===
          'all'
            ? 'border-primary bg-primary text-on-primary'
            : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
          aria-pressed={harnessFilter === 'all'}
          onclick={() => (harnessFilter = 'all')}
        >
          <ListFilter size={11} class="shrink-0" />
          All harnesses
        </button>
        {#each harnesses as harnessId (harnessId)}
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {harnessFilter ===
            harnessId
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={harnessFilter === harnessId}
            onclick={() => (harnessFilter = harnessId)}
          >
            <AgentIcon agentId={harnessId} label={harnessName(harnessId)} size={14} />
            {harnessName(harnessId)}
          </button>
        {/each}
      </div>
    {/if}

    <div class="mb-2 flex items-center justify-between text-xs text-muted">
      <span
        >{filteredUtilities.length} {filteredUtilities.length === 1 ? 'utility' : 'utilities'}</span
      >
      <span>Resolved by harness, scope, and activation.</span>
    </div>

    {#if loading && utilities.length === 0}
      <div class="rounded-xl border border-dashed p-8 text-center">
        <Loader2 size={18} class="mx-auto mb-2 animate-spin text-dimmed" />
        <p class="text-xs text-dimmed">Loading utilities…</p>
      </div>
    {:else if filteredUtilities.length === 0}
      <div class="rounded-xl border border-dashed p-8 text-center">
        <Puzzle size={18} class="mx-auto mb-2 text-dimmed" />
        <p class="text-sm font-medium">No matching utilities</p>
        <p class="mt-1 text-xs text-dimmed">Add a capability or change the filters.</p>
      </div>
    {:else}
      <div class="divide-y rounded-xl border bg-surface">
        {#each filteredUtilities as utility (utility.id)}
          <div class="flex items-start gap-3 p-4">
            <div
              class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-elevated text-muted"
            >
              <Puzzle size={15} />
            </div>
            <div class="min-w-0 flex-1">
              <div class="flex flex-wrap items-center gap-2">
                <p class="text-sm font-semibold">{utility.name}</p>
                <span
                  class="rounded-md bg-elevated px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted"
                >
                  {kindLabel(utility.kind)}
                </span>
                {#if utility.appOwned}
                  <span
                    class="rounded-md border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary"
                    title="Built into the app and always available; it cannot be deleted"
                  >
                    Built-in
                  </span>
                {/if}
                <span class="text-[11px] text-dimmed">
                  {utility.activation === 'always' ? 'Always available' : 'On demand'}
                </span>
              </div>
              {#if utility.description}
                <p class="mt-1 text-xs leading-relaxed text-muted">{utility.description}</p>
              {/if}
              <div class="mt-2 flex flex-wrap items-center gap-1.5 text-[11px] text-dimmed">
                <span>{scopeLabel(utility.scope)}</span>
                {#if utility.harnessBindings.length}
                  {#each utility.harnessBindings as binding (binding.harnessId)}
                    <span
                      class="flex h-6 items-center gap-1.5 rounded-md border bg-elevated px-2 text-[10px] font-medium text-muted"
                    >
                      <AgentIcon
                        agentId={binding.harnessId}
                        label={harnessName(binding.harnessId)}
                        size={14}
                      />
                      {harnessName(binding.harnessId)}
                    </span>
                  {/each}
                {:else}
                  <span>No harness bindings</span>
                {/if}
                {#if utility.credentials.length}
                  <span class="flex items-center gap-1">
                    <KeyRound size={11} />
                    {utility.credentials.length}
                    {utility.credentials.length === 1 ? 'credential' : 'credentials'}
                  </span>
                {/if}
                {#if utility.kind === 'image_descriptor'}
                  {#if utility.config.harnessId || utility.config.providerId || utility.config.modelId}
                    <span class="flex items-center gap-1">
                      Vision model: {utility.config.harnessId} / {utility.config.providerId} /
                      {utility.config.modelId}
                    </span>
                  {:else}
                    <span class="flex items-center gap-1">Vision model: auto (app picks)</span>
                  {/if}
                {/if}
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1">
              {#if !utility.appOwned}
                <Switch
                  checked={utility.enabled}
                  onchange={() => void toggleEnabled(utility)}
                  aria-label="{utility.enabled ? 'Disable' : 'Enable'} {utility.name}"
                  title="{utility.enabled ? 'Disable' : 'Enable'} {utility.name}"
                />
              {/if}
              <button
                class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-elevated hover:text-foreground"
                aria-label="Edit {utility.name}"
                title="Edit {utility.name}"
                onclick={() => openEdit(utility)}
              >
                <Pencil size={14} />
              </button>
              {#if !utility.appOwned}
                <button
                  class="flex h-8 w-8 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                  aria-label="Delete {utility.name}"
                  title="Delete {utility.name}"
                  onclick={() => (deleteTarget = utility)}
                >
                  <Trash2 size={14} />
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {:else if activeTab === 'computer-use'}
    <CuaBridgeSettings />
  {:else}
    <ToolsView embedded />
  {/if}
</div>

<UtilityEditorModal
  open={editorOpen}
  target={editorTarget}
  onClose={() => (editorOpen = false)}
  onSaved={replaceUtility}
  onChanged={() => void loadUtilities()}
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
          Delete <strong class="text-foreground">{deleteTarget.name}</strong>? Its registry entry
          and credential references will be removed.
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
          Delete utility
        </button>
      </div>
    </div>
  </div>
{/if}
