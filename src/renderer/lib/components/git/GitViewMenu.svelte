<script lang="ts">
  import { Check, ChevronDown, GitBranch } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { GitPanelTabId } from '$lib/stores/git-panel-view.svelte'

  interface Props {
    /** The views this panel can show, in the order the menu lists them. */
    tabs: Array<{
      id: GitPanelTabId
      label: string
      icon: typeof GitBranch
      count: number | null
    }>
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
  sideways hides views behind a gesture, so the row keeps the view you are in and
  nothing else.

  The trigger reads exactly like the branch picker beside it: muted until it is
  hovered or open. Two controls on the same row that both describe "where you
  are" cannot be one loud and one quiet, and a bright label plus a primary-tinted
  count made this the only highlighted thing on the row.
-->
<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-7 min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground data-[state=open]:bg-elevated data-[state=open]:text-foreground"
    title={`View: ${activeLabel || 'none'}. Switch view`}
    aria-label={`Switch view, currently ${activeLabel || 'none'}`}
  >
    {#if activeEntry}
      {@const ActiveIcon = activeEntry.icon}
      <ActiveIcon size={11} class="shrink-0" />
    {/if}
    <span class="max-w-[14ch] truncate">{activeLabel}</span>
    {#if activeCount !== null}
      <span class="shrink-0 rounded-sm bg-elevated px-1 text-[0.5rem] font-semibold tabular-nums">
        {activeCount}
      </span>
    {/if}
    <ChevronDown size={10} class="shrink-0 text-dimmed" />
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
          {@const TabIcon = tab.icon}
          <DropdownMenu.RadioItem value={tab.id} class={itemClass}>
            <TabIcon size={12} class="shrink-0 text-dimmed" />
            <span class="min-w-0 flex-1 truncate">{tab.label}</span>
            {#if tab.count !== null}
              <span
                class="shrink-0 rounded-sm bg-app px-1 text-[0.5rem] font-semibold tabular-nums text-dimmed"
              >
                {tab.count}
              </span>
            {/if}
            <Check
              size={12}
              class={['shrink-0', tab.id === activeTab ? 'text-primary' : 'invisible']}
              aria-hidden="true"
            />
          </DropdownMenu.RadioItem>
        {/each}
      </DropdownMenu.RadioGroup>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>
