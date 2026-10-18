<script lang="ts">
  import CioAlertCircle from 'cio-icon/CioAlertCircle.svelte'
  import CioSpinner from 'cio-icon/CioSpinner.svelte'
  import { appPanelHost } from '$lib/app-panel-portal'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { loadPanelModule, PANEL_KEYS, resetPanelModule } from '$lib/lazy-panel'
  import { logRendererError } from '$lib/system/renderer-logger'

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

  /**
   * Bumped by a Retry to rebuild the `{#key}` and re-run a panel's `{#await}`.
   * The boot warm already fetched these chunks (`app-panel-preload.ts`), so the
   * promise is usually resolved before the panel is ever opened and neither the
   * loading nor the failure state is seen.
   */
  let reloadNonce = $state(0)

  function retry(key: string): void {
    resetPanelModule(key)
    reloadNonce += 1
  }
</script>

{#snippet panelLoading(label: string)}
  <div
    class="flex h-full items-center justify-center gap-2 text-xs text-dimmed"
    role="status"
    aria-label={`Loading ${label}`}
  >
    <CioSpinner size={14} class="animate-spin" aria-hidden="true" />
    Loading {label}
  </div>
{/snippet}

{#snippet panelLoadFailed(key: string, label: string, error: unknown)}
  {logRendererError(`The ${label} panel could not be loaded`, error)}
  <div class="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
    <CioAlertCircle size={18} class="text-warning" aria-hidden="true" />
    <p class="text-xs font-medium text-foreground">{label} could not load</p>
    <p class="max-w-[34ch] text-[0.625rem] leading-relaxed text-muted">
      Loading it was interrupted. Try again.
    </p>
    <button
      class="mt-1 bg-primary px-2 py-1 text-[0.625rem] text-on-primary transition-colors hover:bg-primary-hover"
      title={`Try loading the ${label} panel again`}
      aria-label={`Try loading the ${label} panel again`}
      onclick={() => retry(key)}
    >
      Retry
    </button>
  </div>
{/snippet}

<!-- The hidden fallback is the panel's home while no rail is on screen; the
     host element inside it is what the portal moves, so the panel never
     unmounts on its way between rails. -->
<div class="hidden">
  <div class="h-full min-h-0" {@attach appPanelHost}>
    {#key reloadNonce}
      {#if activePanel === 'notifications'}
        {#await loadPanelModule(PANEL_KEYS.notifications, () => import('$lib/components/notifications/NotificationPanel.svelte'))}
          {@render panelLoading('Notifications')}
        {:then { default: NotificationPanel }}
          <NotificationPanel />
        {:catch error}
          {@render panelLoadFailed(PANEL_KEYS.notifications, 'Notifications', error)}
        {/await}
      {:else if activePanel === 'sticky-notes'}
        {#await loadPanelModule(PANEL_KEYS.stickyNotes, () => import('$lib/components/notes/StickyNotesPanel.svelte'))}
          {@render panelLoading('Sticky notes')}
        {:then { default: StickyNotesPanel }}
          <StickyNotesPanel />
        {:catch error}
          {@render panelLoadFailed(PANEL_KEYS.stickyNotes, 'Sticky notes', error)}
        {/await}
      {/if}
    {/key}
  </div>
</div>
