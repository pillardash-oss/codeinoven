<script lang="ts">
  import { appPanelHost } from '$lib/app-panel-portal'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'

  /**
   * The single, always-mounted home for the app's global panels.
   *
   * Notifications and sticky notes are the app's own panels, not a project's or
   * the browser's, so they must survive a view switch. Mounted once here, the
   * panel's root element is moved by the app panel portal into whichever rail's
   * body slot is on screen (`appPanelSlot`), which keeps this component instance
   * alive instead of letting each rail rebuild it. See `app-panel-portal.ts`.
   */
  type AppPanelKind = 'notifications' | 'sticky-notes'

  const activePanel = $derived.by((): AppPanelKind | null => {
    const kind = contextSidebarState.sidebarActiveTab?.kind
    return kind === 'notifications' || kind === 'sticky-notes' ? kind : null
  })
</script>

<!-- The hidden fallback is the panel's home while no rail is on screen; the
     host element inside it is what the portal moves, so the panel never
     unmounts on its way between rails. -->
<div class="hidden">
  <div class="h-full min-h-0" {@attach appPanelHost}>
    {#if activePanel === 'notifications'}
      {#await import('$lib/components/notifications/NotificationPanel.svelte') then { default: NotificationPanel }}
        <NotificationPanel />
      {/await}
    {:else if activePanel === 'sticky-notes'}
      {#await import('$lib/components/notes/StickyNotesPanel.svelte') then { default: StickyNotesPanel }}
        <StickyNotesPanel />
      {/await}
    {/if}
  </div>
</div>
