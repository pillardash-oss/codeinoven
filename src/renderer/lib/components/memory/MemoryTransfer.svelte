<script lang="ts">
  import { invoke } from '$lib/ipc.svelte'
  import type { MemoryExportKind, MemoryImportPreview } from '$shared/types'
  import { Download, Loader2, Upload } from '@lucide/svelte'
  import Modal from '../ui/Modal.svelte'
  import ThreadDropdown from '../shared/ThreadDropdown.svelte'

  interface Props {
    variant: 'settings' | 'sidebar'
    /** The active settings tab — used as the default export scope. */
    scope?: 'projects' | 'chats'
    /** The project this sidebar panel belongs to (kind 'project'). */
    projectId?: string
    /** Called after a successful import so the panel can reload. */
    onImported?: () => void
  }

  let { variant, scope = 'projects', projectId, onImported }: Props = $props()

  /** User override for the transfer scope; falls back to the active settings tab. */
  let userScope = $state<MemoryExportKind | null>(null)
  let transferScope = $derived<MemoryExportKind>(
    userScope ?? (scope === 'chats' ? 'chats' : 'projects')
  )
  let busy = $state(false)
  let error = $state('')
  let message = $state('')
  let preview = $state<MemoryImportPreview | null>(null)
  let applying = $state(false)

  const exportKinds: Array<{ value: MemoryExportKind; label: string }> = [
    { value: 'projects', label: 'Projects' },
    { value: 'chats', label: 'Chats' },
    { value: 'both', label: 'Both' }
  ]

  /** The export kind for the sidebar: a project export, or chats for the inbox. */
  let sidebarKind = $derived<MemoryExportKind>(projectId === 'inbox' ? 'chats' : 'project')

  let activeKind = $derived<MemoryExportKind>(variant === 'settings' ? transferScope : sidebarKind)

  async function exportMemory(): Promise<void> {
    busy = true
    error = ''
    message = ''
    try {
      const kind = variant === 'settings' ? transferScope : sidebarKind
      const path = await invoke(
        'memory:export',
        kind,
        variant === 'sidebar' ? projectId : undefined
      )
      message = path ? `Exported to ${path}` : ''
    } catch (e) {
      error = e instanceof Error ? e.message : 'Memory export failed.'
    } finally {
      busy = false
    }
  }

  async function pickImport(): Promise<void> {
    busy = true
    error = ''
    message = ''
    try {
      preview = await invoke('memory:import')
    } catch (e) {
      error = e instanceof Error ? e.message : 'Memory import failed.'
    } finally {
      busy = false
    }
  }

  async function applyImport(): Promise<void> {
    if (!preview) return
    applying = true
    error = ''
    message = ''
    try {
      const kind = variant === 'settings' ? transferScope : sidebarKind
      const result = await invoke(
        'memory:importApply',
        preview,
        kind,
        variant === 'sidebar' ? projectId : undefined
      )
      message = `Imported ${result.added} new entr${result.added === 1 ? 'y' : 'ies'}, skipped ${result.skipped} duplicate${result.skipped === 1 ? '' : 's'}.`
      preview = null
      onImported?.()
    } catch (e) {
      error = e instanceof Error ? e.message : 'Import failed.'
    } finally {
      applying = false
    }
  }

  const kindLabel = $derived.by(() => {
    switch (activeKind) {
      case 'projects':
        return 'projects'
      case 'chats':
        return 'chats'
      case 'both':
        return 'both'
      case 'project':
        return 'this project'
    }
  })
</script>

{#if variant === 'settings'}
  <section class="rounded-xl border bg-surface p-4" aria-labelledby="memory-transfer-title">
    <div class="mb-3">
      <h2 id="memory-transfer-title" class="text-sm font-semibold text-foreground">
        Transfer memory
      </h2>
      <p class="mt-0.5 text-xs text-muted">
        Export a backup, or import one to merge in memories. Importing never deletes existing
        entries — duplicates are skipped.
      </p>
    </div>

    <div class="mb-3 flex items-center gap-2">
      <div
        class="flex w-max items-center gap-0.5 rounded-lg border bg-elevated p-0.5"
        role="tablist"
        aria-label="Memory transfer scope"
      >
        {#each exportKinds as option (option.value)}
          <button
            class="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium transition-colors {transferScope ===
            option.value
              ? 'bg-surface text-foreground shadow-sm'
              : 'text-muted hover:text-foreground'}"
            role="tab"
            aria-selected={transferScope === option.value}
            title="Transfer {option.label.toLowerCase()} memory"
            onclick={() => (userScope = option.value)}
          >
            {option.label}
          </button>
        {/each}
      </div>
      <span class="text-xs text-dimmed">
        Exports <strong class="text-foreground">{kindLabel}</strong> memory
      </span>
    </div>

    {#if error}
      <p class="mb-2 rounded-lg bg-danger/10 px-3 py-2 text-xs text-danger" role="alert">{error}</p>
    {/if}
    {#if message}
      <p
        class="mb-2 break-all rounded-lg bg-primary/10 px-3 py-2 text-xs text-primary"
        role="status"
      >
        {message}
      </p>
    {/if}

    <div class="flex items-center gap-2">
      <button
        class="flex items-center gap-1.5 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
        type="button"
        disabled={busy}
        title="Export the selected memory scope to a JSON file"
        onclick={() => void exportMemory()}
      >
        {#if busy}
          <Loader2 size={13} class="animate-spin" />
        {:else}
          <Download size={13} />
        {/if}
        Export
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
        type="button"
        disabled={busy}
        title="Import a memory export file and merge its entries"
        onclick={() => void pickImport()}
      >
        <Upload size={13} />
        Import
      </button>
    </div>
  </section>
{:else}
  <ThreadDropdown
    items={[
      {
        label: 'Export memory',
        icon: Download,
        disabled: busy,
        onClick: () => void exportMemory()
      },
      {
        label: 'Import memory',
        icon: Upload,
        disabled: busy,
        onClick: () => void pickImport()
      }
    ]}
    title="Memory transfer"
    ariaLabel="Export or import this project's memory"
  />
  {#if error}
    <p class="mt-2 text-xs text-danger" role="alert">{error}</p>
  {:else if message}
    <p class="mt-2 text-xs text-primary" role="status">{message}</p>
  {/if}
{/if}

{#if preview}
  <Modal
    title="Import memory"
    size="md"
    open={true}
    onClose={() => {
      if (!applying) preview = null
    }}
  >
    <div class="space-y-3 text-sm text-muted">
      <p>
        The file contains <strong class="text-foreground"
          >{preview.entryCount} entr{preview.entryCount === 1 ? 'y' : 'ies'}</strong
        >{preview.kind === 'project' ? ' for a project' : ` exported for ${preview.kind}`}
        . It will be merged into <strong class="text-foreground">{kindLabel}</strong> memory.
      </p>
      <p class="text-xs text-dimmed">
        Entries that already exist (same scope and content) are skipped. No existing memory is
        removed.
      </p>
    </div>
    {#snippet footer()}
      <button
        class="rounded-lg border bg-elevated px-3 py-1.5 text-xs font-medium hover:bg-overlay disabled:opacity-50"
        type="button"
        disabled={applying}
        title="Cancel the import"
        onclick={() => (preview = null)}
      >
        Cancel
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary hover:opacity-90 disabled:opacity-50"
        type="button"
        disabled={applying}
        title="Merge the imported memory entries"
        onclick={() => void applyImport()}
      >
        {#if applying}
          <Loader2 size={13} class="animate-spin" />
        {:else}
          <Upload size={13} />
        {/if}
        Import
      </button>
    {/snippet}
  </Modal>
{/if}
