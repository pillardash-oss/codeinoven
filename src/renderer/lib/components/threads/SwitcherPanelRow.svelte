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
    /** The owning project's icon, drawn after the panel's own icon. */
    projectIconUrl?: string | null
    /** Container glyph used when the project is a hidden one (Chats, Assistant)
     *  with no icon of its own. */
    projectGlyph?: Component | null
  }

  let {
    tab,
    selected = false,
    showBadge = true,
    projectIconUrl = null,
    projectGlyph = null
  }: Props = $props()

  /**
   * One panel tab in the Ctrl+Tab switcher: a terminal, a file, or a
   * thread-browser tab.
   *
   * It reads like the thread and browser rows beside it, but leads with the
   * panel's own icon followed by the icon of the project the tab belongs to, so
   * the strip and the project are both obvious at a glance, and carries a text
   * badge on the right naming that strip. Together they let a user tell a
   * terminal from a file from a browser tab, and whose they are, without opening
   * any of them.
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
    <span class="flex shrink-0 items-center gap-1" aria-hidden="true">
      <span class="flex h-3.5 w-3.5 items-center justify-center text-muted">
        <PanelIcon size={13} />
      </span>
      {#if projectIconUrl}
        <img src={projectIconUrl} alt="" class="h-3.5 w-3.5 object-contain" />
      {:else if projectGlyph}
        {@const ProjectGlyph = projectGlyph}
        <span class="flex h-3.5 w-3.5 items-center justify-center text-muted">
          <ProjectGlyph size={12} />
        </span>
      {/if}
    </span>
    <span class="min-w-0 flex-1 truncate text-[0.75rem] text-foreground">{tab.title}</span>
    {#if showBadge}
      <StatusPill><span class={selected ? 'text-accent' : undefined}>{mark.badge}</span></StatusPill
      >
    {/if}
  </span>
</div>
