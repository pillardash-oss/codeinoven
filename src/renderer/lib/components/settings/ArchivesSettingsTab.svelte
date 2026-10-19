<script lang="ts">
  import { onMount } from 'svelte'
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import type { ArchiveEntry, ArchiveTab } from '$shared/archives'
  import ConfirmDialog from '../ui/ConfirmDialog.svelte'
  import EmptyState from '../ui/EmptyState.svelte'

  const tabs: { id: ArchiveTab; label: string }[] = [
    { id: 'projects', label: 'Projects' },
    { id: 'threads', label: 'Threads' },
    { id: 'chats', label: 'Chats' },
    { id: 'assistants', label: 'Assistants' }
  ]
  let tab = $state<ArchiveTab>('projects')
  let entries = $state.raw<ArchiveEntry[]>([])
  let offset = $state(0)
  let hasMore = $state(false)
  let loading = $state(false)
  let busy = $state(false)
  let error = $state('')
  let pendingDelete = $state<ArchiveEntry | null>(null)
  let generation = 0

  async function load(selected = tab, nextOffset = 0): Promise<void> {
    const request = ++generation
    tab = selected
    offset = nextOffset
    loading = true
    error = ''
    try {
      const rows = await invoke('archive:list', selected, nextOffset)
      if (request !== generation) return
      entries = rows.slice(0, 50)
      hasMore = rows.length > 50
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
      await load()
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
      await load()
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not delete this item'
    } finally {
      busy = false
    }
  }

  onMount(() => {
    void load()
    return subscribe('archive:changed', () => {
      void load()
    })
  })
</script>

<div class="space-y-5">
  <div>
    <h1 class="text-xl font-bold tracking-tight">Archives</h1>
    <p class="mt-1 text-sm text-muted">Restore archived work or delete it permanently.</p>
  </div>
  <nav class="flex gap-1 border-b border-border" aria-label="Archive categories">
    {#each tabs as item (item.id)}
      <button
        type="button"
        aria-current={tab === item.id ? 'page' : undefined}
        class={[
          'border-b-2 px-3 py-2 text-sm',
          tab === item.id
            ? 'border-primary text-foreground'
            : 'border-transparent text-muted hover:bg-elevated'
        ]}
        disabled={busy}
        onclick={() => void load(item.id)}>{item.label}</button
      >
    {/each}
  </nav>
  {#if error}<p role="alert" class="text-sm text-danger">{error}</p>{/if}
  {#if loading}
    <p role="status" class="py-6 text-sm text-muted">Loading archives...</p>
  {:else if entries.length === 0}
    <EmptyState
      icon={CioArchive}
      title="No archived {tab}"
      description="Items you archive will appear here."
    />
  {:else}
    <div class="divide-y divide-border border border-border">
      {#each entries as entry (entry.id)}
        <div class="flex items-center gap-3 p-3">
          <CioArchive size={16} class="shrink-0 text-muted" />
          <div class="min-w-0 flex-1">
            <p class="truncate text-sm font-medium" title={entry.name}>{entry.name}</p>
            <p class="text-xs text-muted">
              {#if entry.ownerName}{entry.ownerName} ·
              {/if}Archived {new Date(entry.archivedAt).toLocaleDateString()}
            </p>
          </div>
          <button
            type="button"
            class="px-3 py-2 text-sm text-danger hover:bg-danger/10"
            disabled={busy}
            onclick={() => {
              pendingDelete = entry
            }}>Delete</button
          >
          <button
            type="button"
            class="border border-border bg-elevated px-3 py-2 text-sm hover:bg-overlay"
            disabled={busy}
            onclick={() => void restore(entry)}>Unarchive</button
          >
        </div>
      {/each}
    </div>
  {/if}
  {#if offset > 0 || hasMore}
    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="border border-border px-3 py-2 text-sm"
        disabled={offset === 0 || loading || busy}
        onclick={() => void load(tab, Math.max(0, offset - 50))}>Previous</button
      >
      <button
        type="button"
        class="border border-border px-3 py-2 text-sm"
        disabled={!hasMore || loading || busy}
        onclick={() => void load(tab, offset + 50)}>Next</button
      >
    </div>
  {/if}
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
  {#if error}<p role="alert" class="text-danger">{error}</p>{/if}
</ConfirmDialog>
