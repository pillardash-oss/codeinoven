<script lang="ts">
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import CioChat from '@pdslng/cio-icon/CioChat.svelte'
  import CioFolder from '@pdslng/cio-icon/CioFolder.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioSparkles from '@pdslng/cio-icon/CioSparkles.svelte'
  import CioThreads from '@pdslng/cio-icon/CioThreads.svelte'
  import { onMount, type Component } from 'svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { formatDateTimeCompact } from '$shared/date-time-format'
  import type { ArchiveEntry, ArchiveTab } from '$shared/archives'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import EmptyState from '../ui/EmptyState.svelte'

  const tabs: Array<{ id: ArchiveTab; label: string; plural: string; icon: Component }> = [
    { id: 'projects', label: 'Projects', plural: 'projects', icon: CioFolder },
    { id: 'threads', label: 'Threads', plural: 'project threads', icon: CioThreads },
    { id: 'chats', label: 'Chats', plural: 'chats', icon: CioChat },
    { id: 'assistants', label: 'Assistants', plural: 'assistants', icon: CioSparkles }
  ]

  /** One fetch stays a screenful; the loader asks for one row more than it shows. */
  const PAGE_SIZE = 50

  let tab = $state<ArchiveTab>('projects')
  let entries = $state.raw<ArchiveEntry[]>([])
  let loading = $state(false)
  let busy = $state(false)
  let hasMore = $state(false)
  let error = $state('')
  let pendingDelete = $state<ArchiveEntry | null>(null)
  let generation = 0

  const active = $derived(tabs.find((item) => item.id === tab) ?? tabs[0])

  async function load(selected = tab, append = false): Promise<void> {
    const request = ++generation
    const offset = append ? entries.length : 0
    if (!append) tab = selected
    loading = true
    error = ''
    try {
      const rows = await invoke('archive:list', selected, offset)
      if (request !== generation) return
      entries = append ? [...entries, ...rows.slice(0, PAGE_SIZE)] : rows.slice(0, PAGE_SIZE)
      hasMore = rows.length > PAGE_SIZE
    } catch (cause) {
      if (request === generation)
        error = cause instanceof Error ? cause.message : 'Could not load archives'
    } finally {
      if (request === generation) loading = false
    }
  }

  async function restore(entry: ArchiveEntry): Promise<void> {
    busy = true
    error = ''
    try {
      await invoke('archive:set', entry.kind, entry.id, false)
      await load(tab)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not restore this item'
    } finally {
      busy = false
    }
  }

  async function remove(): Promise<void> {
    const entry = pendingDelete
    if (!entry) return
    busy = true
    error = ''
    try {
      if (entry.kind === 'project') await invoke('project:delete', entry.id)
      else if (entry.kind === 'assistant') await invoke('assistant:delete', entry.id)
      else if (entry.projectId) await invoke('thread:delete', entry.projectId, entry.id)
      pendingDelete = null
      await load(tab)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not delete this item'
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void load(tab)
    return subscribe('archive:changed', () => {
      void load(tab)
    })
  })
</script>

<div class="p-6 pb-24">
  <div class="mb-6">
    <h1 class="text-xl font-bold tracking-tight">Archives</h1>
    <p class="mt-0.5 text-sm text-muted">
      Archived work stays out of the sidebar, search results and new indexing, and nothing runs out
      of sight. Restore an item to bring it back, or delete it for good.
    </p>
  </div>

  <div class="mb-4 flex items-center justify-between gap-3">
    <div
      class="flex w-max items-center gap-0.5 border bg-elevated p-0.5"
      role="tablist"
      aria-label="Archive categories"
    >
      {#each tabs as item (item.id)}
        <button
          type="button"
          role="tab"
          aria-selected={tab === item.id}
          class="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors {tab ===
          item.id
            ? 'bg-surface text-foreground'
            : 'text-muted hover:text-foreground'}"
          title={`View archived ${item.plural}`}
          disabled={busy}
          onclick={() => void load(item.id)}
        >
          {item.label}
        </button>
      {/each}
    </div>
    {#if entries.length > 0}
      <span class="shrink-0 text-xs tabular-nums text-dimmed">
        {entries.length}{hasMore ? '+' : ''} archived
      </span>
    {/if}
  </div>

  {#if error}
    <p class="mb-4 bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
  {/if}

  <section class="border bg-surface" aria-label={`Archived ${active.plural}`}>
    {#if loading && entries.length === 0}
      <div class="flex items-center gap-2 px-4 py-3 text-xs text-muted">
        <CioSpinner size={14} class="animate-spin" /> Loading archives...
      </div>
    {:else if entries.length === 0}
      <EmptyState
        icon={CioArchive}
        title="Nothing archived"
        description={`Archived ${active.plural} land here. Archive one from its menu to clear your workspace without losing it.`}
      />
    {:else}
      <div class="divide-y">
        {#each entries as entry (entry.kind + entry.id)}
          {@const Icon =
            entry.kind === 'project'
              ? CioFolder
              : entry.kind === 'assistant'
                ? CioSparkles
                : entry.projectId === 'inbox'
                  ? CioChat
                  : CioThreads}
          <div class="flex items-center gap-4 p-4">
            <div class="bg-primary/10 p-2 text-primary"><Icon size={18} /></div>
            <div class="min-w-0 flex-1">
              <p class="truncate text-sm font-semibold text-foreground" title={entry.name}>
                {entry.name}
              </p>
              <p class="mt-0.5 truncate text-xs text-muted">
                {#if entry.ownerName}{entry.ownerName} ·
                {/if}Archived
                {formatDateTimeCompact(entry.archivedAt)}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                class="flex h-8 items-center gap-1.5 px-3 text-xs font-medium text-dimmed transition-colors hover:bg-elevated hover:text-danger disabled:opacity-50"
                title={`Delete ${entry.name} and its stored conversations`}
                aria-label={`Delete ${entry.name} permanently`}
                disabled={busy}
                onclick={() => {
                  pendingDelete = entry
                }}
              >
                Delete
              </button>
              <button
                type="button"
                class="flex h-8 items-center gap-1.5 border bg-elevated px-3 text-xs font-medium transition-colors hover:bg-overlay disabled:opacity-50"
                title={`Restore ${entry.name} to your workspace`}
                aria-label={`Unarchive ${entry.name}`}
                disabled={busy}
                onclick={() => void restore(entry)}
              >
                Unarchive
              </button>
            </div>
          </div>
        {/each}
      </div>
      {#if hasMore}
        <button
          type="button"
          class="flex w-full items-center justify-center gap-1.5 border-t px-4 py-2.5 text-xs font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-50"
          title={`Load more archived ${active.plural}`}
          aria-label={`Load more archived ${active.plural}`}
          disabled={loading || busy}
          onclick={() => void load(tab, true)}
        >
          {#if loading}<CioSpinner size={13} class="animate-spin" />{/if}
          Load more
        </button>
      {/if}
    {/if}
  </section>
</div>

<ConfirmDialog
  open={pendingDelete !== null}
  title="Delete archived item?"
  confirmLabel="Delete permanently"
  {busy}
  onCancel={() => {
    if (!busy) pendingDelete = null
  }}
  onConfirm={remove}
>
  <p>Delete "{pendingDelete?.name}" and its stored conversations? This cannot be undone.</p>
  {#if pendingDelete?.kind === 'project'}<p>The project folder on disk will be kept.</p>{/if}
</ConfirmDialog>
