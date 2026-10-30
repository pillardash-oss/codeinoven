<script lang="ts">
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioPlay from '@pdslng/cio-icon/CioPlay.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioStop from '@pdslng/cio-icon/CioStop.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import SettingsDisclosure from '../../shared/SettingsDisclosure.svelte'
  import SettingsStatusBadge from '../../shared/SettingsStatusBadge.svelte'
  import {
    describeLlamaServerCommand,
    llamaCppModelLabel,
    type LlamaCppServerEntry
  } from '$shared/llama-cpp'
  import type { LlamaCppServerStatus } from './llama-cpp-controller.svelte'

  interface Props {
    entry: LlamaCppServerEntry
    executable: string
    status: LlamaCppServerStatus
    logLines: string[]
    loadedModel: string
    notice: string
    expanded: boolean
    onToggle: () => void
    onStart: () => void
    onStop: () => void
    onEdit: () => void
    onDelete: () => void
  }

  let {
    entry,
    executable,
    status,
    logLines,
    loadedModel,
    notice,
    expanded,
    onToggle,
    onStart,
    onStop,
    onEdit,
    onDelete
  }: Props = $props()

  const command = $derived(describeLlamaServerCommand(entry, executable))
  const busy = $derived(status === 'starting' || status === 'running')

  const badge = $derived(
    status === 'running'
      ? { label: 'Running', classes: 'border-success/40 bg-success/10 text-success' }
      : status === 'starting'
        ? { label: 'Starting', classes: 'border-warning/40 bg-warning/10 text-warning' }
        : status === 'failed'
          ? { label: 'Failed', classes: 'border-danger/40 bg-danger/10 text-danger' }
          : { label: 'Stopped', classes: 'border-border text-muted' }
  )

  /**
   * Keep the newest line in view while output streams in, without pinning the
   * scroll position when the user has scrolled back to read something. An
   * attachment watches the tail's own text, so no state is assigned here.
   */
  function followLog(node: HTMLPreElement): () => void {
    const sync = (): void => {
      if (node.scrollHeight - node.scrollTop - node.clientHeight < 40) {
        node.scrollTop = node.scrollHeight
      }
    }
    const observer = new MutationObserver(sync)
    observer.observe(node, { childList: true, characterData: true, subtree: true })
    sync()
    return () => observer.disconnect()
  }
</script>

<div class="border bg-surface {expanded ? 'border-l-[3px] border-l-primary' : ''}">
  <div class="flex flex-wrap items-start justify-between gap-3 p-4">
    <div class="flex min-w-0 items-start gap-2">
      <SettingsDisclosure
        {expanded}
        title={`${expanded ? 'Hide' : 'Show'} ${entry.name} log`}
        onclick={onToggle}
      />
      <div class="min-w-0">
        <div class="flex flex-wrap items-center gap-2">
          <p class="truncate text-sm font-semibold">{entry.name}</p>
          <SettingsStatusBadge label={badge.label} classes={badge.classes}>
            {#if status === 'starting'}
              <CioSpinner size={11} class="animate-spin" />
            {/if}
          </SettingsStatusBadge>
        </div>
        <p class="mt-0.5 truncate text-xs text-muted" title={llamaCppModelLabel(entry)}>
          {llamaCppModelLabel(entry)}
        </p>
        <p class="mt-0.5 font-mono text-[0.6875rem] text-dimmed">
          {entry.host}:{entry.port}
        </p>
        {#if loadedModel}
          <p class="mt-1 truncate font-mono text-[0.6875rem] text-success" title={loadedModel}>
            {loadedModel}
          </p>
        {/if}
      </div>
    </div>

    <div class="flex shrink-0 items-center gap-2">
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center border text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        title="Edit server"
        aria-label={`Edit ${entry.name}`}
        onclick={onEdit}
        disabled={busy}
      >
        <CioPencil size={13} />
      </button>
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center border text-dimmed transition-colors hover:bg-danger/10 hover:text-danger"
        title="Remove server"
        aria-label={`Remove ${entry.name}`}
        onclick={onDelete}
      >
        <CioTrash size={13} />
      </button>
      {#if status === 'running' || status === 'starting'}
        <button
          type="button"
          class="flex items-center gap-1.5 border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-elevated"
          onclick={onStop}
        >
          <CioStop size={12} />
          Stop
        </button>
      {:else}
        <button
          type="button"
          class="flex items-center gap-1.5 border bg-primary px-3 py-1.5 text-xs font-medium text-on-primary transition-opacity disabled:opacity-50"
          onclick={onStart}
        >
          <CioPlay size={12} />
          Start
        </button>
      {/if}
    </div>
  </div>

  {#if status === 'failed' && notice}
    <div class="mx-4 mb-3 border border-danger/40 bg-danger/10 px-3 py-2">
      <p class="text-xs font-medium text-danger">The server could not start</p>
      <pre
        class="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words font-mono text-[0.6875rem] leading-relaxed text-danger/90">{notice}</pre>
    </div>
  {/if}

  {#if expanded}
    <div class="border-t p-4">
      <p class="mb-2 truncate font-mono text-[0.6875rem] text-dimmed" title={command}>{command}</p>
      <pre
        {@attach followLog}
        class="max-h-64 min-h-24 overflow-auto whitespace-pre-wrap break-words border bg-app px-3 py-2 font-mono text-[0.6875rem] leading-relaxed text-muted">{logLines.length >
        0
          ? logLines.join('\n')
          : 'No output yet. Start the server to see its log here.'}</pre>
    </div>
  {/if}
</div>
