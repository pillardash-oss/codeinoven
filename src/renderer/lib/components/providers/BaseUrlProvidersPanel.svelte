<script lang="ts">
  import { onMount } from 'svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import {
    AlertTriangle,
    ListFilter,
    Loader2,
    Pencil,
    Plus,
    RefreshCw,
    Server,
    Trash2,
    X
  } from '@lucide/svelte'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import Modal from '../ui/Modal.svelte'
  import type { BaseUrlProvider, ProviderConnectionInfo } from '$shared/types'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import BaseUrlProviderEditor from './BaseUrlProviderEditor.svelte'

  interface Props {
    providers: ProviderConnectionInfo[]
  }

  /** Harnesses whose drivers can consume custom base-URL providers (per the manifest). */
  let { providers }: Props = $props()

  let editorOpen = $state(false)
  let editingProvider = $state<BaseUrlProvider | null>(null)
  let editorError = $state('')
  /** The full linked group (one record per harness) queued for deletion. */
  let deleteTarget = $state<BaseUrlProvider[] | null>(null)

  let baseUrlHarnesses = $derived(
    providers.filter(
      (provider) => provider.supportsCustomProviders && provider.integration === 'ready'
    )
  )

  /** Harnesses selectable in the filter — only harnesses that already have at
   *  least one custom base-URL provider. */
  let filterHarnesses = $derived.by(() => {
    const seen: Record<string, true> = {}
    const byId: Array<{ id: string; name: string }> = []
    for (const provider of baseUrlProviderStore.providers) {
      if (!seen[provider.harnessId]) {
        seen[provider.harnessId] = true
        byId.push({ id: provider.harnessId, name: providerName(provider.harnessId) })
      }
    }
    return byId.sort((left, right) => left.name.localeCompare(right.name))
  })

  /** Multi-select harness filter; empty selection means "all harnesses". */
  let selectedHarnesses = new SvelteSet<string>()

  /** Providers sharing an id are the same logical provider linked across
   *  harnesses — collapse them into one row backed by every member record. */
  let groupedProviders = $derived.by(() => {
    const groups = new SvelteMap<string, BaseUrlProvider[]>()
    for (const candidate of baseUrlProviderStore.providers) {
      const group = groups.get(candidate.id)
      if (group) group.push(candidate)
      else groups.set(candidate.id, [candidate])
    }
    // Most recently updated first — adding or editing one at the bottom of a
    // long list is easy to miss, and a saved edit should resurface it too.
    return [...groups.values()].sort(
      (left, right) =>
        Math.max(...right.map((provider) => provider.updatedAt)) -
        Math.max(...left.map((provider) => provider.updatedAt))
    )
  })

  /** A group is shown when any of its linked harnesses match the active filter. */
  let filteredGroups = $derived(
    selectedHarnesses.size === 0
      ? groupedProviders
      : groupedProviders.filter((group) =>
          group.some((provider) => selectedHarnesses.has(provider.harnessId))
        )
  )

  let harnessFilterActive = $derived(selectedHarnesses.size > 0)

  /** Harness the Add-provider modal defaults to: the filtered harness when the
   *  user narrowed the list, otherwise the first base-URL harness. */
  let defaultCreateHarnessId = $derived.by(() => {
    if (selectedHarnesses.size > 0) return [...selectedHarnesses][0]
    return baseUrlHarnesses[0]?.id ?? DEFAULT_HARNESS
  })

  function toggleHarnessFilter(id: string): void {
    if (selectedHarnesses.has(id)) selectedHarnesses.delete(id)
    else selectedHarnesses.add(id)
  }

  function clearHarnessFilter(): void {
    selectedHarnesses.clear()
  }

  function providerName(id: string): string {
    return providers.find((provider) => provider.id === id)?.name ?? id
  }

  function openCreate(): void {
    editingProvider = null
    editorError = ''
    editorOpen = true
  }

  function openEdit(group: BaseUrlProvider[]): void {
    editingProvider = group[0] ?? null
    editorError = ''
    editorOpen = true
  }

  function closeEditor(): void {
    editorOpen = false
    editingProvider = null
  }

  function handleSaved(): void {
    closeEditor()
  }

  /** Removes every harness-linked record in the group. Stops at the first
   *  failure so the error is visible instead of silently partial. */
  async function removeProvider(): Promise<void> {
    if (!deleteTarget) return
    editorError = ''
    try {
      for (const provider of deleteTarget) {
        await baseUrlProviderStore.remove(provider.harnessId, provider.id)
      }
      deleteTarget = null
    } catch (removeError) {
      editorError =
        removeError instanceof Error ? removeError.message : 'Failed to delete provider.'
    }
  }

  onMount(() => {
    void baseUrlProviderStore.load()
  })
</script>

<section class="space-y-4">
  <div class="flex items-start justify-between">
    <div>
      <p class="text-xs text-muted">
        Add custom OpenAI-compatible providers by base URL. Models are ready in the picker as soon
        as you save.
      </p>
    </div>
    <button
      class="flex h-8 shrink-0 items-center gap-1.5 rounded-lg border bg-elevated px-2.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
      title="Refresh base URL providers"
      disabled={baseUrlProviderStore.loading}
      onclick={() => void baseUrlProviderStore.load()}
    >
      <RefreshCw size={13} class={baseUrlProviderStore.loading ? 'animate-spin' : ''} /> Refresh
    </button>
  </div>

  {#if baseUrlProviderStore.error}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">
      {baseUrlProviderStore.error}
    </p>
  {/if}

  <div>
    <div class="mb-2 flex items-center justify-between">
      <div>
        <h3 class="text-sm font-semibold">Custom providers</h3>
        <p class="text-[11px] text-dimmed">API keys stay in secure storage.</p>
      </div>
      <button
        class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-medium text-on-primary hover:bg-primary-hover"
        title="Add base URL provider"
        onclick={openCreate}
      >
        <Plus size={13} /> Add provider
      </button>
    </div>

    {#if filterHarnesses.length > 1}
      <div
        class="mb-2 flex flex-wrap items-center gap-1"
        role="group"
        aria-label="Filter by harness"
      >
        <button
          type="button"
          class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {!harnessFilterActive
            ? 'border-primary bg-primary text-on-primary'
            : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
          aria-pressed={!harnessFilterActive}
          title="Show providers for all harnesses"
          onclick={clearHarnessFilter}
        >
          <ListFilter size={11} class="shrink-0" />
          All
        </button>
        {#each filterHarnesses as harness (harness.id)}
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg border px-2.5 text-[11px] font-medium transition-colors {selectedHarnesses.has(
              harness.id
            )
              ? 'border-primary bg-primary text-on-primary'
              : 'bg-elevated text-muted hover:bg-overlay hover:text-foreground'}"
            aria-pressed={selectedHarnesses.has(harness.id)}
            title={`Filter providers by ${harness.name}`}
            onclick={() => toggleHarnessFilter(harness.id)}
          >
            <AgentIcon agentId={harness.id} label={harness.name} size={14} />
            <span class="truncate">{harness.name}</span>
          </button>
        {/each}
        {#if harnessFilterActive}
          <button
            type="button"
            class="flex h-7 items-center gap-1 rounded-lg border bg-elevated px-2 text-[11px] font-medium text-muted hover:bg-overlay hover:text-foreground"
            title="Clear harness filter"
            onclick={clearHarnessFilter}
          >
            <X size={11} /> Clear
          </button>
        {/if}
      </div>
    {/if}

    {#if baseUrlProviderStore.loading && baseUrlProviderStore.providers.length === 0}
      <div class="rounded-xl border border-dashed p-6 text-center">
        <Loader2 size={17} class="mx-auto animate-spin text-dimmed" />
      </div>
    {:else if baseUrlProviderStore.providers.length === 0}
      <div class="rounded-xl border border-dashed p-5 text-center">
        <Server size={17} class="mx-auto mb-1.5 text-dimmed" />
        <p class="text-xs text-muted">No custom base URL providers yet.</p>
        <button class="mt-2 text-xs font-medium text-primary hover:underline" onclick={openCreate}>
          Add the first provider
        </button>
      </div>
    {:else if filteredGroups.length === 0}
      <div class="rounded-xl border border-dashed p-5 text-center">
        <ListFilter size={17} class="mx-auto mb-1.5 text-dimmed" />
        <p class="text-xs text-muted">No providers match the selected harnesses.</p>
        <button
          class="mt-2 text-xs font-medium text-primary hover:underline"
          onclick={clearHarnessFilter}
        >
          Show all providers
        </button>
      </div>
    {:else}
      <div class="overflow-hidden rounded-xl border bg-surface">
        {#each filteredGroups as group (group[0].id)}
          {@const provider = group[0]}
          <div
            class="grid grid-cols-[minmax(0,1fr)_minmax(8rem,0.6fr)_auto] items-center gap-3 border-b px-3 py-2.5 last:border-b-0"
          >
            <div class="min-w-0">
              <div class="flex items-center gap-2">
                <p class="truncate text-xs font-semibold">{provider.name}</p>
                <span
                  class="rounded-full px-1.5 py-0.5 text-[10px] font-medium {provider.enabled
                    ? 'bg-success/10 text-success'
                    : 'bg-raised text-dimmed'}"
                >
                  {provider.enabled ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div class="mt-0.5 flex flex-wrap items-center gap-x-1 gap-y-0.5">
                {#each group as member (member.harnessId)}
                  <span
                    class="flex items-center gap-1 rounded-full bg-raised px-1.5 py-0.5 text-[10px] text-dimmed"
                    title={providerName(member.harnessId)}
                  >
                    <AgentIcon
                      agentId={member.harnessId}
                      label={providerName(member.harnessId)}
                      size={14}
                    />
                    {providerName(member.harnessId)}
                  </span>
                {/each}
                <span class="text-[10px] text-dimmed">
                  · {provider.models.length}
                  {provider.models.length === 1 ? 'model' : 'models'}
                </span>
              </div>
            </div>
            <p class="truncate font-mono text-[10px] text-dimmed" title={provider.baseURL}>
              {provider.baseURL}
            </p>
            <div class="flex items-center gap-1">
              <button
                class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-overlay hover:text-foreground"
                aria-label="Edit {provider.name}"
                title="Edit {provider.name}"
                onclick={() => openEdit(group)}
              >
                <Pencil size={13} />
              </button>
              <button
                class="flex h-7 w-7 items-center justify-center rounded-lg text-muted hover:bg-danger/10 hover:text-danger"
                aria-label="Delete {provider.name}"
                title="Delete {provider.name}"
                onclick={() => (deleteTarget = group)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</section>

{#if editorOpen}
  <BaseUrlProviderEditor
    provider={editingProvider}
    harnesses={baseUrlHarnesses}
    defaultHarnessId={defaultCreateHarnessId}
    onClose={closeEditor}
    onSaved={handleSaved}
  />
{/if}

<Modal
  open={deleteTarget !== null}
  title="Delete base URL provider"
  onClose={() => (deleteTarget = null)}
>
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
      disabled={baseUrlProviderStore.saving}
      onclick={() => void removeProvider()}
    >
      {#if baseUrlProviderStore.saving}<Loader2 size={13} class="animate-spin" />{:else}<Trash2
          size={13}
        />{/if}
      Delete provider
    </button>
  {/snippet}

  {#if editorError}
    <p class="rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{editorError}</p>
  {/if}
  <div class="flex gap-2 text-sm text-muted">
    <AlertTriangle size={16} class="mt-0.5 shrink-0 text-warning" />
    <p>
      Delete <strong class="text-foreground">{deleteTarget?.[0]?.name}</strong>?
      {#if deleteTarget && deleteTarget.length > 1}
        It's linked to {deleteTarget.length} harnesses ({deleteTarget
          .map((p) => providerName(p.harnessId))
          .join(', ')}) — all of them will be removed. Its
      {:else}
        Its
      {/if}
      API key will be removed from secure storage and the provider will disappear from the model picker.
    </p>
  </div>
</Modal>
