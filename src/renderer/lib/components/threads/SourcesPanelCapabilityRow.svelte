<script lang="ts">
  import { BookOpen, Pencil, Server, Trash2 } from '@lucide/svelte'
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
    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted">
      {#if kind === 'mcp'}
        <Server size={15} />
      {:else}
        <BookOpen size={15} />
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
        <span class="rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted">
          {originLabel(entry)}
        </span>
        {#if !entry.enabled}
          <span class="rounded-md bg-danger/10 px-1.5 py-0.5 text-[0.625rem] text-danger">
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
        class="flex h-7 w-7 items-center justify-center rounded-lg text-dimmed hover:bg-elevated hover:text-foreground"
        aria-label="Edit {entry.name}"
        title="Edit {entry.name}"
        onclick={() => onEdit(entry)}
      >
        <Pencil size={13} />
      </button>
      <button
        type="button"
        class="flex h-7 w-7 items-center justify-center rounded-lg text-dimmed hover:bg-danger/10 hover:text-danger"
        aria-label="Delete {entry.name}"
        title="Delete {entry.name}"
        onclick={() => onDelete(entry)}
      >
        <Trash2 size={13} />
      </button>
    </div>
  </div>
</div>
