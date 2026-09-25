<script lang="ts">
  import { Minimize2, Plus, X } from '@lucide/svelte'
  import { browserTabIndicatorSlotClass } from '$lib/stores/browser-tab-status'
  import { trafficLightInsetStyle } from '$lib/stores/traffic-light.svelte'
  import type { Snippet } from 'svelte'
  import Modal from '$lib/components/ui/Modal.svelte'

  interface Props {
    /** Tabs in the strip. `indicatorCount` is how many live indicators the tab
     *  shows in place of the dialog's own `icon`: 0 keeps the icon, and anything
     *  above 0 is the caller's promise that `tabIndicator` draws that many. */
    tabs: { id: string; title: string; indicatorCount?: number }[]
    activeTabId: string | null
    /** Label for the create button. Required only when `onNew` is set; a
     *  surface whose tabs are sections of one panel passes neither. */
    newLabel?: string
    minimizeLabel: string
    /** Leading glyph for a tab that shows no indicator. Omit for a surface
     *  whose tabs are plain sections and carry no icon. */
    icon?: Snippet
    /** Per-tab overlay painted over the tab's own icon slot, used for the
     *  browser's live audio and capture indicators. Callers whose tabs never
     *  carry an indicator leave it, and `indicatorCount`, unset. */
    tabIndicator?: Snippet<[{ id: string; title: string }]>
    /** Create a tab. Omit to hide the create button, for a surface whose tabs
     *  are sections of one panel rather than open instances. */
    onNew?: () => void
    onMinimize: () => void
    onSelect: (id: string) => void
    /** Close a tab. Omit to hide the per-tab close button, for a surface whose
     *  tabs are sections of one panel and cannot be dismissed. */
    onCloseTab?: (id: string) => void
    children: Snippet
    /** This surface displays the browser's native view inside itself.
     *
     *  Only the full screen browser sets it. Every other surface here (the
     *  terminal, the pull request reader) paints over the workspace and must
     *  keep the native view detached; the browser surface would blank itself if
     *  it did, because the view it suppresses is the page it is showing. */
    hostsBrowserView?: boolean
  }

  let {
    tabs,
    activeTabId,
    newLabel,
    minimizeLabel,
    icon,
    tabIndicator,
    onNew,
    onMinimize,
    onSelect,
    onCloseTab,
    children,
    hostsBrowserView = false
  }: Props = $props()

  let stripElement = $state<HTMLDivElement>()

  /** The dialog is named after the tab it is showing, which is also the label
   *  on the strip, so the surface reads the same to a screen reader. */
  let dialogTitle = $derived(
    tabs.find((tab) => tab.id === activeTabId)?.title ?? 'Full screen panel'
  )

  // Keep the active tab visible: whenever the active tab changes, scroll it
  // into view inside the strip so a newly opened or newly focused tab is
  // never hidden beyond the strip's scroll edge.
  $effect(() => {
    if (!activeTabId || !stripElement) return
    const activeButton = stripElement.querySelector<HTMLButtonElement>('[data-active="true"]')
    activeButton?.scrollIntoView({ inline: 'nearest', block: 'nearest' })
  })
</script>

<!--
  A full screen surface is a `Modal` with `placement="fullscreen"`, so it shares
  the portal, the `z-60` layer, Cmd/Ctrl+W, and the browser-view suppression with
  every other modal, and it draws its own tab strip instead of the canonical
  header (`chrome={false}`).

  `trapFocus` is off on purpose. bits-ui's Dialog (bits-ui 2.19,
  `bits/utilities/focus-scope/focus-scope.svelte.js`) traps focus with a
  CAPTURE-phase `focusin` listener on the document that re-focuses the last
  element inside the content whenever focus lands outside it, and it reads
  `trapFocus` only when the scope mounts, so the trap cannot be released
  while the surface stays open.

  These surfaces deliberately carry floating panels above them: the pull
  request reader hosts the create-pull-request sheet, whose `layer="top"`
  contract (`src/renderer/lib/components/ui/DockableModal.svelte`) exists so
  it paints above a full screen surface. With the trap on, that panel was
  drawn on top but could never take focus, which means no caret, no typing
  and no drag-select inside it.

  The trade is deliberate and is the honest cost: Tab now moves past the
  surface's own controls into whatever follows in the document instead of
  wrapping inside it. That is accepted because the surface covers the window
  (nothing behind it is reachable by pointer), the browser surface's native
  view never routes its keystrokes through this DOM anyway, and a panel that
  cannot be typed into above a full screen reader is the worse bug.

  Escape belongs to the surface's owner too, so it minimizes rather than
  dismissing (`escapeCloses={false}`).

  The strip is not fixed to open instances. A surface whose tabs are sections of
  one panel omits `onNew`, `onCloseTab` and `icon`, and the strip then reads as a
  section switcher instead of a tab bar: the assistant routine panel is exactly
  that case.
-->
<Modal
  open
  title={dialogTitle}
  onClose={onMinimize}
  placement="fullscreen"
  chrome={false}
  panelClass="bg-app"
  trapFocus={false}
  escapeCloses={false}
  blocksBrowserView={!hostsBrowserView}
>
  <div
    class="titlebar-drag flex h-10 shrink-0 items-center gap-2 border-b border-border pr-3"
    style={trafficLightInsetStyle()}
  >
    <div bind:this={stripElement} class="titlebar-no-drag flex min-w-0 flex-1 overflow-x-auto">
      <div class="ml-auto flex min-w-max items-center gap-1">
        {#each tabs as tab (tab.id)}
          {@const indicatorCount = tabIndicator ? (tab.indicatorCount ?? 0) : 0}
          <div class="titlebar-no-drag relative flex shrink-0 items-center">
            <button
              type="button"
              data-active={tab.id === activeTabId ? 'true' : undefined}
              class="group flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-[0.6875rem] font-medium transition-colors {tab.id ===
              activeTabId
                ? 'bg-elevated text-foreground'
                : 'text-dimmed hover:bg-elevated hover:text-foreground'}"
              aria-current={tab.id === activeTabId ? 'page' : undefined}
              title={tab.title}
              onclick={() => onSelect(tab.id)}
            >
              {#if indicatorCount > 0}
                <span
                  class="shrink-0 {browserTabIndicatorSlotClass(indicatorCount)}"
                  aria-hidden="true"
                ></span>
              {:else if icon}
                {@render icon()}
              {/if}
              <span class="max-w-40 truncate">{tab.title}</span>
            </button>
            {#if onCloseTab}
              <button
                type="button"
                class="mr-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded text-dimmed opacity-70 transition-colors hover:bg-raised hover:text-foreground group-hover:opacity-100"
                aria-label={`Close ${tab.title}`}
                title={`Close ${tab.title}`}
                onclick={() => onCloseTab(tab.id)}
              >
                <X size={10} />
              </button>
            {/if}
            {#if indicatorCount > 0 && tabIndicator}
              <!-- Painted over the tab's own icon slot, as a sibling of the
                   tab button, because a button cannot nest a button. The slot
                   reserved above keeps a favicon's width for one indicator
                   and widens for two, so the row can never reach the title. -->
              <div
                class="absolute left-1.5 top-1/2 z-10 flex -translate-y-1/2 items-center gap-0.5"
              >
                {@render tabIndicator({ id: tab.id, title: tab.title })}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
    {#if onNew}
      <button
        type="button"
        class="titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        aria-label={newLabel}
        title={newLabel}
        onclick={onNew}
      >
        <Plus size={14} />
      </button>
    {/if}
    <button
      type="button"
      class="titlebar-no-drag flex h-7 w-7 shrink-0 items-center justify-center rounded text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      aria-label={minimizeLabel}
      title={minimizeLabel}
      onclick={onMinimize}
    >
      <Minimize2 size={14} />
    </button>
  </div>
  {@render children()}
</Modal>
