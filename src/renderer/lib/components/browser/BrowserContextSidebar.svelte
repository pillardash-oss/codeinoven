<script lang="ts">
  import ContextSidebar from '$lib/components/layout/ContextSidebar.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { globalBrowser } from '$lib/stores/global-browser.svelte'
  import { GLOBAL_BROWSER_PROJECT_ID } from '$shared/ipc-contract'

  interface Props {
    onClose: () => void
  }

  let { onClose }: Props = $props()

  /**
   * The browser view's right rail.
   *
   * It is the application's own right sidebar, the same `ContextSidebar` shell
   * every workspace thread docks its panels into, and its panel is the
   * application's own Notes panel. A browser tab's note is the same note feature
   * a thread's note is; only the subject differs, so nothing here re-implements
   * notes, their editor or their storage.
   */

  const activeTab = $derived(globalBrowser.activeTab)

  // The note is docked by the store the moment a tab becomes active and while
  // this rail is shown, so nothing here creates it; this only reads the one the
  // store owns.
  const noteTab = $derived(
    activeTab ? contextSidebarState.noteTabFor(GLOBAL_BROWSER_PROJECT_ID, activeTab.id) : null
  )

  const tabs = $derived(noteTab ? [noteTab] : [])
</script>

{#snippet railContent()}
  {#if noteTab}
    {#await import('$lib/components/threads/ThreadNotePanel.svelte') then { default: ThreadNotePanel }}
      <ThreadNotePanel tab={noteTab} />
    {/await}
  {/if}
{/snippet}

<div class="min-h-0 min-w-0 shrink-0" style:width="{contextSidebarState.width}px">
  <ContextSidebar
    {tabs}
    activeTabId={noteTab?.id ?? null}
    width={contextSidebarState.width}
    height={contextSidebarState.terminalHeight}
    placement="right"
    content={railContent}
    onSelect={() => {}}
    {onClose}
    onWidthChange={(width) => contextSidebarState.setWidth(width)}
    onHeightChange={(height) => contextSidebarState.setTerminalHeight(height)}
    onTerminalPlacementChange={() => {}}
  />
</div>
