<script lang="ts">
  import { onMount } from 'svelte'
  import { RefreshCw, Search, Wrench } from '@lucide/svelte'
  import { invoke } from '$lib/ipc.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import type { AgentToolCatalog, AgentToolDefinition, Thread } from '$shared/types'

  interface Props {
    /** Render without the page wrapper and heading — for the Tools tab of the Utilities page. */
    embedded?: boolean
  }

  let { embedded = false }: Props = $props()

  let catalog = $state<AgentToolCatalog | null>(null)
  let loading = $state(false)
  let error = $state('')
  let query = $state('')
  let selectedHarness = $state<string | null>(null)
  let selectedSource = $state<'all' | 'application' | 'harness'>('all')

  interface ToolGroup {
    key: string
    definition: AgentToolDefinition
    harnessIds: string[]
    sentWhen: string[]
  }

  let harnesses = $derived(catalog?.harnesses ?? [])
  let selectedHarnessDetails = $derived(harnesses.find((harness) => harness.id === selectedHarness))

  let toolGroups = $derived.by((): ToolGroup[] => {
    const groups: ToolGroup[] = []
    for (const tool of catalog?.tools ?? []) {
      const key = [
        tool.source,
        tool.name,
        tool.transportName ?? '',
        tool.description,
        JSON.stringify(tool.inputSchema)
      ].join('\u0000')
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
    const normalized = query.trim().toLowerCase()
    const groups = toolGroups
      .filter((group) => selectedSource === 'all' || group.definition.source === selectedSource)
      .filter((group) => selectedHarness === null || group.harnessIds.includes(selectedHarness))
    if (!normalized) return groups
    return groups.filter((group) =>
      [
        group.definition.name,
        group.definition.transportName ?? '',
        group.definition.description,
        group.definition.source,
        ...group.harnessIds,
        ...group.harnessIds.map(harnessName),
        ...group.sentWhen
      ].some((value) => value.toLowerCase().includes(normalized))
    )
  })

  function harnessName(harnessId: string): string {
    return harnesses.find((harness) => harness.id === harnessId)?.name ?? harnessId
  }

  function harnessGroupCount(harnessId: string): number {
    return toolGroups.filter((group) => group.harnessIds.includes(harnessId)).length
  }

  function schemaText(tool: AgentToolDefinition): string {
    return JSON.stringify(tool.inputSchema, null, 2)
  }

  function selectHarness(harnessId: string): void {
    selectedHarness = harnessId
  }

  function setSource(value: string): void {
    if (value === 'all' || value === 'application' || value === 'harness') {
      selectedSource = value
    }
  }

  async function loadCatalogThread(): Promise<Thread | null> {
    const selected = workspaceState.selectedThread
    const reference = selected
      ? { projectId: selected.projectId, threadId: selected.id }
      : rendererRecovery.selectedThread
    if (!reference) return null

    return (await invoke('thread:get', reference.projectId, reference.threadId)) ?? selected ?? null
  }

  async function loadTools(): Promise<void> {
    loading = true
    error = ''
    try {
      const thread = await loadCatalogThread()
      const settings = thread?.settings
      catalog = await (thread && settings?.harnessId && settings.providerId && settings.modelId
        ? invoke(
            'agent:listTools',
            thread.projectId,
            settings.harnessId,
            settings.providerId,
            settings.modelId
          )
        : invoke('agent:listTools'))
      if (
        selectedHarness !== null &&
        !catalog.tools.some((tool) => tool.harnessId === selectedHarness)
      ) {
        selectedHarness = null
      }
    } catch (loadError) {
      error =
        loadError instanceof Error
          ? loadError.message
          : 'The agent tool catalog could not be loaded.'
    } finally {
      loading = false
    }
  }

  onMount(() => {
    void loadTools()
  })
</script>

<div class={embedded ? 'min-w-0' : 'mx-auto max-w-4xl p-6 pb-24'}>
  <div class="mb-5 flex items-center justify-end gap-4">
    <button
      class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
      disabled={loading}
      title="Refresh agent tool catalog"
      onclick={() => void loadTools()}
    >
      <RefreshCw size={13} class={loading ? 'animate-spin' : ''} />
      Refresh
    </button>
  </div>

  {#if catalog?.notices.length}
    <div class="mb-4 space-y-2">
      {#each catalog.notices as notice (notice)}
        <p class="rounded-lg border bg-elevated px-3 py-2 text-xs text-muted">
          {notice}
        </p>
      {/each}
    </div>
  {/if}

  {#if error}
    <p class="mb-4 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {error}
    </p>
  {/if}

  <!-- Source + harness filters -->
  <div class="mb-4 flex flex-wrap items-center gap-2">
    <select
      class="h-8 rounded-lg border bg-elevated px-2 text-xs font-medium outline-none focus:border-primary"
      aria-label="Filter tools by source"
      value={selectedSource}
      onchange={(event: Event) => setSource((event.currentTarget as HTMLSelectElement).value)}
    >
      <option value="all">All sources</option>
      <option value="application">Application</option>
      <option value="harness">Harnesses</option>
    </select>
    {#if harnesses.length && selectedSource !== 'application'}
      <div
        class="flex flex-wrap items-center gap-2"
        role="group"
        aria-label="Filter tools by harness"
      >
        <button
          type="button"
          class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary {selectedHarness ===
          null
            ? 'border-primary bg-primary text-on-primary'
            : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
          aria-pressed={selectedHarness === null}
          onclick={() => (selectedHarness = null)}
        >
          All
          <span class="tabular-nums opacity-70">{toolGroups.length}</span>
        </button>
        {#each harnesses as harness (harness.id)}
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary {selectedHarness ===
            harness.id
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={selectedHarness === harness.id}
            title={harness.detail}
            onclick={() => selectHarness(harness.id)}
          >
            <AgentIcon agentId={harness.id} label={harness.name} size={14} />
            {harness.name}
            <span class="tabular-nums opacity-70">{harnessGroupCount(harness.id)}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  <label class="relative mb-4 block">
    <Search
      size={14}
      class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-dimmed"
    />
    <span class="sr-only">Search tools</span>
    <input
      class="h-9 w-full rounded-lg border bg-surface pl-9 pr-3 text-sm outline-none focus:border-primary"
      type="search"
      placeholder="Search names, sources, and descriptions"
      bind:value={query}
    />
  </label>

  <div class="mb-2 flex items-center justify-between text-xs text-muted">
    <span>
      {filteredToolGroups.length}
      {filteredToolGroups.length === 1 ? 'tool' : 'tools'}
    </span>
    <span>Expand a tool to inspect its exact JSON structure</span>
  </div>

  {#if loading && !catalog}
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
                    <AgentIcon agentId={harnessId} label={harnessName(harnessId)} size={14} />
                    {harnessName(harnessId)}
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
        {selectedHarnessDetails?.status === 'unsupported' ||
        selectedHarnessDetails?.status === 'unavailable'
          ? `${selectedHarnessDetails.name} schemas unavailable`
          : 'No matching tools'}
      </p>
      <p class="mt-1 text-xs text-dimmed">
        {selectedHarnessDetails?.detail ??
          'Clear the search or open a configured thread to load harness tools.'}
      </p>
    </div>
  {/if}
</div>
