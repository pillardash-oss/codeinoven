<script lang="ts">
  import { Check, ChevronDown } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { GitPanelTabId } from '$lib/stores/git-panel-view.svelte'

  interface Props {
    /** The views this panel can show, in the order the menu lists them. */
    tabs: Array<{ id: GitPanelTabId; label: string; count: number | null }>
    activeTab: GitPanelTabId
    onSelect: (id: GitPanelTabId) => void
  }

  let { tabs, activeTab, onSelect }: Props = $props()

  const activeEntry = $derived(tabs.find((tab) => tab.id === activeTab) ?? tabs[0])
  const activeLabel = $derived(activeEntry?.label ?? '')
  const activeCount = $derived(activeEntry?.count ?? null)

  const itemClass =
    'flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated'

  /**
   * A radio group reports its value as a plain string, so the tab list is what
   * decides whether that value names a view this panel actually offers. No cast.
   */
  function handleValueChange(value: string): void {
    const next = tabs.find((tab) => tab.id === value)
    if (next) onSelect(next.id)
  }
</script>

<!--
  The views live behind a dropdown with the view in use as its trigger. Six of
  them never fit one header row at every sidebar width, and a strip that scrolls
  sideways hides views behind a gesture, so the row keeps the count of the view
  you are in and nothing else.
-->
<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-elevated data-[state=open]:bg-elevated"
    title={`View: ${activeLabel || 'none'}. Switch view`}
    aria-label={`Switch view, currently ${activeLabel || 'none'}`}
  >
    <span class="max-w-[14ch] truncate">{activeLabel}</span>
    {#if activeCount !== null}
      <span
        class="shrink-0 rounded-sm bg-primary/15 px-1 text-[0.5rem] font-semibold tabular-nums text-primary"
      >
        {activeCount}
      </span>
    {/if}
    <ChevronDown size={10} class="shrink-0 text-dimmed" aria-hidden="true" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="start"
      sideOffset={4}
      collisionPadding={8}
      class="z-50 w-48 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl"
    >
      <DropdownMenu.RadioGroup value={activeTab} onValueChange={handleValueChange}>
        {#each tabs as tab (tab.id)}
          <DropdownMenu.RadioItem value={tab.id} class={itemClass}>
            <Check
              size={12}
              class={['shrink-0', tab.id === activeTab ? 'text-primary' : 'invisible']}
              aria-hidden="true"
            />
            <span class="min-w-0 flex-1 truncate">{tab.label}</span>
            {#if tab.count !== null}
              <span
                class="shrink-0 rounded-sm bg-app px-1 text-[0.5rem] font-semibold tabular-nums text-dimmed"
              >
                {tab.count}
              </span>
            {/if}
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
