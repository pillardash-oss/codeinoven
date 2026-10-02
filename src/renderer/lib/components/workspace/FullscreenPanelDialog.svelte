<script lang="ts">
  import { Minimize2 } from '@lucide/svelte'
  import type { Snippet } from 'svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import PanelTabStrip from './PanelTabStrip.svelte'

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
    /** Per-tab leading glyph, drawn instead of `icon` for a tab that shows no
     *  indicator. The thread browser uses it to wear each tab's own favicon;
     *  a surface whose tabs share one glyph keeps `icon`. */
    tabIcon?: Snippet<[{ id: string; title: string }]>
    /** Per-tab overlay painted over the tab's own icon slot, used for the
     *  browser's live audio and capture indicators. Callers whose tabs never
     *  carry an indicator leave it, and `indicatorCount`, unset. */
    tabIndicator?: Snippet<[{ id: string; title: string }]>
    /** Extra controls in the same top-right strip, before create/minimize. */
    actions?: Snippet
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
    /** Paint the dimmed scrim behind this surface. On by default, and always
     *  off when `hostsBrowserView` is set, because there the scrim can never be
     *  seen.
     *
     *  Off for any surface whose body is a full-window child that keeps
     *  repainting: the browser's page, the terminal's renderer. The opaque body
     *  already hides the scrim, and its full-window `backdrop-blur` composites
     *  under that child on every frame, which starves the GPU and makes the
     *  content tear under load. */
    scrim?: boolean
  }

  let {
    tabs,
    activeTabId,
    newLabel,
    minimizeLabel,
    icon,
    tabIcon,
    tabIndicator,
    actions,
    onNew,
    onMinimize,
    onSelect,
    onCloseTab,
    children,
    hostsBrowserView = false,
    scrim = true
  }: Props = $props()

  /** The dialog is named after the tab it is showing, which is also the label
   *  on the strip, so the surface reads the same to a screen reader. */
  let dialogTitle = $derived(
    tabs.find((tab) => tab.id === activeTabId)?.title ?? 'Full screen panel'
  )

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
  scrim={scrim && !hostsBrowserView}
  blocksBrowserView={!hostsBrowserView}
>
  <PanelTabStrip
    {tabs}
    {activeTabId}
    trailingLabel={minimizeLabel}
    onTrailingAction={onMinimize}
    onSelect={onSelect}
    {newLabel}
    {icon}
    {tabIcon}
    {tabIndicator}
    {actions}
    {onNew}
    {onCloseTab}
    titlebar
  >
    {#snippet trailingIcon()}
      <Minimize2 size={14} />
    {/snippet}
  </PanelTabStrip>
  {@render children()}
</Modal>
