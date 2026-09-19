<script lang="ts">
  import { Brain } from '@lucide/svelte'
  import type { MemoryEntry } from '$shared/types'
  import { memoryScopeLabel } from './sources-panel-helpers'

  interface Props {
    entry: MemoryEntry
  }

  let { entry }: Props = $props()
</script>

<article class="border-b border-border px-4 py-3">
  <div class="flex items-center gap-2">
    <Brain size={13} class="shrink-0 text-primary" />
    <p class="min-w-0 flex-1 truncate text-xs font-semibold text-foreground" title={entry.label}>
      {entry.label}
    </p>
    <span class="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted">
      {memoryScopeLabel(entry)}
    </span>
  </div>
  <p class="mt-2 whitespace-pre-wrap text-[0.6875rem] leading-relaxed text-muted">
    {entry.content}
  </p>
</article>
