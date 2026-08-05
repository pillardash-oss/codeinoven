<script lang="ts">
  import { tick } from 'svelte'
  import { filterActions } from '../../actions'
  import type { ActionCategory, ActionDefinition } from '../../actions'

  interface Props {
    actions: readonly ActionDefinition[]
    query: string
    activeIndex: number
    onSelect: (action: ActionDefinition) => void
  }

  interface IndexedAction {
    action: ActionDefinition
    index: number
  }

  interface ActionGroup {
    category: ActionCategory
    actions: IndexedAction[]
  }

  let { actions, query, activeIndex, onSelect }: Props = $props()

  let visibleActions = $derived(filterActions(actions, query))

  $effect(() => {
    if (activeIndex < 0) return
    void tick().then(() => {
      const el = document.querySelector(`[data-slash-action-index="${activeIndex}"]`)
      if (el instanceof HTMLElement) {
        el.scrollIntoView({ block: 'nearest' })
      }
    })
  })
  let groups = $derived.by(() => {
    const grouped: ActionGroup[] = []

    visibleActions.forEach((action, index) => {
      const group = grouped.find((candidate) => candidate.category === action.category)
      if (group) {
        group.actions.push({ action, index })
      } else {
        grouped.push({ category: action.category, actions: [{ action, index }] })
      }
    })

    return grouped
  })

  function categoryLabel(category: ActionCategory): string {
    if (category === 'mcp') return 'MCP'
    return `${category.charAt(0).toUpperCase()}${category.slice(1)}`
  }

  function selectAction(action: ActionDefinition): void {
    if (!action.disabledReason) onSelect(action)
  }
</script>

<div
  class="absolute bottom-full left-3 right-3 z-40 mb-1 max-h-72 overflow-y-auto rounded-xl border border-border bg-surface p-1.5 shadow-xl"
  role="listbox"
  aria-label="Slash actions"
>
  <div class="flex items-center justify-between px-2 py-1">
    <p class="text-[10px] font-semibold uppercase tracking-wide text-dimmed">
      {query ? `Actions matching “${query}”` : 'Available actions'}
    </p>
    <span class="text-[10px] tabular-nums text-dimmed">{visibleActions.length}</span>
  </div>

  {#if visibleActions.length === 0}
    <p class="px-2 py-3 text-xs text-dimmed">No matching actions</p>
  {:else}
    {#each groups as group (group.category)}
      <div role="group" aria-label={categoryLabel(group.category)}>
        <p class="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-dimmed">
          {categoryLabel(group.category)}
        </p>

        {#each group.actions as entry (entry.action.id)}
          <button
            type="button"
            data-slash-action-index={entry.index}
            class={[
              'flex min-h-10 w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors',
              entry.action.disabledReason
                ? 'cursor-not-allowed text-dimmed opacity-60'
                : entry.index === activeIndex
                  ? 'bg-overlay text-foreground'
                  : 'text-muted hover:bg-elevated hover:text-foreground'
            ]}
            role="option"
            aria-selected={entry.index === activeIndex}
            aria-disabled={Boolean(entry.action.disabledReason)}
            tabindex="-1"
            title={entry.action.disabledReason ?? entry.action.description ?? entry.action.title}
            onpointerdown={(event: PointerEvent) => event.preventDefault()}
            onclick={() => selectAction(entry.action)}
          >
            <span class="min-w-0 flex-1">
              <span class="flex min-w-0 items-center gap-1.5">
                <span class="truncate text-xs font-medium">{entry.action.title}</span>
                <span
                  class="shrink-0 rounded-md border border-border bg-raised px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-dimmed"
                >
                  {categoryLabel(entry.action.category)}
                </span>
                <span
                  class="min-w-0 truncate rounded-md border border-border px-1.5 py-0.5 text-[9px] font-medium text-dimmed"
                >
                  {entry.action.source.label}
                </span>
              </span>

              {#if entry.action.disabledReason}
                <span class="mt-0.5 block truncate text-[10px] text-danger">
                  {entry.action.disabledReason}
                </span>
              {:else if entry.action.description}
                <span class="mt-0.5 block truncate text-[10px] text-dimmed">
                  {entry.action.description}
                </span>
              {/if}
            </span>

            {#if entry.index === activeIndex && !entry.action.disabledReason}
              <span class="shrink-0 text-[10px] font-medium text-dimmed">Enter</span>
            {/if}
          </button>
        {/each}
      </div>
    {/each}
  {/if}
</div>
