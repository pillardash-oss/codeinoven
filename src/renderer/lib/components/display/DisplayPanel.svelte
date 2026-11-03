<script lang="ts">
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import { onMount } from 'svelte'
  import PanelTabStrip from '$lib/components/workspace/PanelTabStrip.svelte'
  import { displayPanel } from '$lib/stores/display-panel.svelte'
  import type { DisplaySourceDescriptor } from '$shared/ipc/display'
  import DisplaySourcePicker from './DisplaySourcePicker.svelte'
  import DisplayStage from './DisplayStage.svelte'

  /**
   * The display panel.
   *
   * A viewer for the things an agent is driving that the desktop cannot show: an
   * Android emulator running without a window, a booted iOS Simulator, or the
   * screen. Each target is a tab, and only the tab on screen captures, so leaving
   * the panel open with four targets costs one running capture.
   *
   * The panel is mounted by the context dock, which means it is mounted exactly
   * while it is the active dock tab: mounting is what turns capture on, and
   * unmounting turns it back off without closing the tabs the user opened.
   */

  const tabs = $derived(displayPanel.tabs.map((tab) => ({ id: tab.id, title: tab.label })))
  const activeTab = $derived(displayPanel.activeTab)
  /** The picker owns the body until a target is open, or while the user is adding one. */
  let picking = $state(false)
  const showsPicker = $derived(picking || !displayPanel.hasTabs)

  onMount(() => {
    displayPanel.setPanelVisible(true)
    // Discovery is read-only and costs one child process per kind, so it runs
    // when the panel is first looked at and on an explicit refresh, never on a
    // timer.
    void displayPanel.refreshAll()
    return () => displayPanel.setPanelVisible(false)
  })

  function selectSource(source: DisplaySourceDescriptor): void {
    displayPanel.openSource(source)
    picking = false
  }

  function showPicker(): void {
    picking = true
    void displayPanel.refreshAll()
  }

  function refreshTargets(): void {
    void displayPanel.refreshAll()
  }
</script>

{#snippet addTarget()}
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    aria-label="Choose a display target"
    title="Choose a display target"
    onclick={showPicker}
  >
    <CioDisplay size={14} />
  </button>
{/snippet}

{#snippet refreshTargetsButton()}
  <button
    type="button"
    class="flex h-7 w-7 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    aria-label="List display targets again"
    title="List display targets again"
    onclick={refreshTargets}
  >
    <CioRefresh size={14} />
  </button>
{/snippet}

<div class="flex h-full min-h-0 flex-col" data-panel-kind="display">
  {#if displayPanel.hasTabs}
    <PanelTabStrip
      {tabs}
      activeTabId={displayPanel.activeTabId}
      newLabel="Choose a display target"
      actions={addTarget}
      trailing={refreshTargetsButton}
      onSelect={(id) => displayPanel.setActive(id)}
      onNew={showPicker}
      onCloseTab={(id) => displayPanel.closeTab(id)}
    />
  {/if}

  <div class="min-h-0 flex-1">
    {#if showsPicker}
      <DisplaySourcePicker
        onSelect={selectSource}
        onClose={displayPanel.hasTabs ? () => (picking = false) : undefined}
      />
    {:else if activeTab}
      {#key activeTab.id}
        <DisplayStage tab={activeTab} />
      {/key}
    {/if}
  </div>
</div>
