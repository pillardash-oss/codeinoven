<script lang="ts">
  import CioBrowser from '$lib/components/icons/cio/CioBrowser.svelte'
  import CioFile from '$lib/components/icons/cio/CioFile.svelte'
  import CioTerminal from '$lib/components/icons/cio/CioTerminal.svelte'
  import StatusPill from '$lib/components/ui/StatusPill.svelte'
  import type { SwitcherPanelTab } from './thread-switcher-entries'
  import type { Component } from 'svelte'

  interface Props {
    tab: SwitcherPanelTab
    selected?: boolean
    showBadge?: boolean
  }

  let { tab, selected = false, showBadge = true }: Props = $props()

  /**
   * One panel tab in the Ctrl+Tab switcher: a terminal, a file, or a
   * thread-browser tab.
   *
   * It reads like the thread and browser rows beside it, but leads with the
   * panel's own icon so the strip a row belongs to is obvious at a glance, and
   * carries a text badge on the right naming that strip. The two together are
   * what let a user tell a terminal from a file from a browser tab without
   * opening any of them.
   */
  const PANEL_MARKS: Record<SwitcherPanelTab['kind'], { icon: Component; badge: string }> = {
    terminal: { icon: CioTerminal, badge: 'Terminal' },
    files: { icon: CioFile, badge: 'File' },
    browser: { icon: CioBrowser, badge: 'Browser' }
  }

  const mark = $derived(PANEL_MARKS[tab.kind])
  const PanelIcon = $derived(mark.icon)
</script>

<div
  class="flex h-9 w-full flex-col justify-center px-2.5 py-1.5 text-left transition-colors {selected
    ? 'bg-selected'
    : ''}"
>
  <span class="flex w-full min-w-0 items-center gap-2">
    <span
      class="flex h-3.5 w-3.5 shrink-0 items-center justify-center text-muted"
      aria-hidden="true"
    >
      <PanelIcon size={13} />
    </span>
    <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">{tab.title}</span>
    {#if showBadge}
      <StatusPill><span class={selected ? 'text-accent' : undefined}>{mark.badge}</span></StatusPill
      >
    {/if}
  </span>
</div>
