<script lang="ts">
  import CioBook from '@pillardash-oss/cio-icon/CioBook.svelte'
  import CioPencil from '@pillardash-oss/cio-icon/CioPencil.svelte'
  import CioServer from '@pillardash-oss/cio-icon/CioServer.svelte'
  import CioTrash from '@pillardash-oss/cio-icon/CioTrash.svelte'
  import type { AgentCapabilityEntry } from '$shared/types'
  import { originLabel } from './sources-panel-helpers'

  interface Props {
    entry: AgentCapabilityEntry
    /** Which capability list owns this row, so the glyph matches the tab. */
    kind: 'mcp' | 'skill'
    onEdit: (entry: AgentCapabilityEntry) => void
    onDelete: (entry: AgentCapabilityEntry) => void
  }

  let { entry, kind, onEdit, onDelete }: Props = $props()
</script>

<div class="group border-b border-border px-4 py-3 transition-colors hover:bg-elevated">
  <div class="flex items-start gap-3">
    <span class="flex h-8 w-8 shrink-0 items-center justify-center bg-raised text-muted">
      {#if kind === 'mcp'}
        <CioServer size={15} />
      {:else}
        <CioBook size={15} />
      {/if}
    </span>
    <div class="min-w-0 flex-1">
      <div class="flex flex-wrap items-center gap-2">
        <button
          type="button"
          class="truncate cursor-pointer text-xs font-semibold text-foreground hover:text-primary"
          title={`Edit ${entry.name}`}
          onclick={() => onEdit(entry)}
        >
          {entry.name}
        </button>
        <span
          class="border border-border bg-raised px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-muted uppercase"
        >
          {originLabel(entry)}
        </span>
        {#if !entry.enabled}
          <span
            class="border border-danger/30 bg-danger/10 px-1.5 py-0.5 text-[0.5625rem] font-semibold tracking-wide text-danger uppercase"
          >
            Disabled
          </span>
        {/if}
      </div>
      {#if entry.description}
        <p class="mt-1 line-clamp-2 text-[0.625rem] leading-relaxed text-dimmed">
          {entry.description}
        </p>
      {/if}
      {#if entry.detail}
        <p class="mt-1 truncate font-mono text-[0.625rem] text-dimmed" title={entry.detail}>
          {entry.detail}
        </p>
      {/if}
    </div>
    <div class="flex shrink-0 items-center gap-1">
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center text-dimmed hover:bg-elevated hover:text-foreground"
        aria-label="Edit {entry.name}"
        title="Edit {entry.name}"
        onclick={() => onEdit(entry)}
      >
        <CioPencil size={13} />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center text-dimmed hover:bg-danger/10 hover:text-danger"
        aria-label="Delete {entry.name}"
        title="Delete {entry.name}"
        onclick={() => onDelete(entry)}
      >
        <CioTrash size={13} />
      </button>
    </div>
  </div>
</div>
