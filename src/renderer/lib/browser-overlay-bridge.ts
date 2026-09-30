import { toast } from 'svelte-sonner'
import type { ToastT } from 'svelte-sonner'
import type { BrowserViewBounds } from '$shared/ipc-contract'
import {
  TOAST_CARD_WIDTH,
  TOAST_STACK_RIGHT,
  TOAST_STACK_TOP,
  type BrowserStripOverlayChrome,
  type BrowserStripOverlayTab,
  type BrowserStripStoreOffer,
  type ToastOverlayInteractionReport,
  type ToastOverlayKind,
  type ToastOverlayStack,
  type ToastOverlayToast
} from '$shared/browser-overlay'
import MemoryToastComponent from './components/ui/MemoryToast.svelte'
import { logRendererDev } from './system/renderer-logger'
import { openMemoryProposal } from './stores/memory-proposal-open'
import { globalBrowser } from './stores/global-browser.svelte'
import { browserTabLabel } from './stores/global-browser-types'
import { browserBookmarks } from './stores/browser-bookmarks.svelte'
import {
  storeExtensionOffer,
  storeOfferInstallVerb,
  type StoreExtensionOffer
} from './stores/browser-extension-store-offer'
import { browserTabAccent, browserTabIconUrl } from './components/browser/browser-tab-appearance'

/**
 * The app renderer's side of the native browser overlay.
 *
 * svelte-sonner holds the toast stack in this renderer, and the browser store
 * holds the tab strip, and the overlay window that draws either over a browser
 * page cannot see that state. This module is the whole translation in both
 * directions: live state becomes the narrow, serializable projections the
 * overlay renders, and an interaction the overlay reports becomes the handler
 * call the original surface carries.
 *
 * Nothing here wraps a toast call. The stack projection is read off the live
 * state (`toast.getActiveToasts()`), so all 110 call sites across the app,
 * including the `Copy` action every error toast is given and the explicit-id
 * toasts the speech features reuse, arrive in the overlay with no call site
 * changed.
 */

/**
 * How tall a slice of the window's top right corner counts as the stack's
 * territory when asking whether a page covers it.
 *
 * The question is asked before a card is measured, so this is deliberately
 * taller than any card this app builds. Over-reserving only hands the stack to
 * the overlay a little sooner, while under-reserving would let a card poke out
 * from under a page.
 */
const TOAST_CORNER_PROBE_HEIGHT = 160

/** The kinds a toast's type maps to. Anything else draws as a plain card. */
const OVERLAY_KINDS: Readonly<Record<string, ToastOverlayKind>> = {
  success: 'success',
  error: 'error',
  warning: 'warning',
  info: 'info',
  loading: 'loading'
}

/**
 * The corner the toaster occupies in the app window.
 *
 * A page that reaches any of this rectangle would paint over the cards, which is
 * the one condition that puts the stack into the overlay window. The corner is
 * the same in every layout: the toaster is a fixed offset from the window's own
 * right edge, not from the page's.
 */
export function toastCornerBounds(viewportWidth: number): BrowserViewBounds {
  return {
    x: Math.round(viewportWidth) - TOAST_STACK_RIGHT - TOAST_CARD_WIDTH,
    y: TOAST_STACK_TOP,
    width: TOAST_CARD_WIDTH,
    height: TOAST_CORNER_PROBE_HEIGHT
  }
}

type ToastActionHandler = (event: MouseEvent) => void

/** The button of an action, when the toast carries one rather than a component. */
function actionButton(
  value: ToastT['action']
): { label: string; onClick: ToastActionHandler } | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as { label?: unknown; onClick?: unknown }
  if (typeof candidate.label !== 'string' || typeof candidate.onClick !== 'function') return null
  return { label: candidate.label, onClick: candidate.onClick as ToastActionHandler }
}

/** The props the one component toast this app raises is given. */
function memoryProposalProps(
  entry: ToastT
): { message: string; projectId: string; threadId: string } | null {
  if (entry.component !== MemoryToastComponent) return null
  const props = entry.componentProps as Record<string, unknown> | undefined
  const message = props?.['message']
  const projectId = props?.['projectId']
  const threadId = props?.['threadId']
  if (typeof message !== 'string' || !message) return null
  if (typeof projectId !== 'string' || typeof threadId !== 'string') return null
  return { message, projectId, threadId }
}

/**
 * One toast, projected for the overlay.
 *
 * A toast whose text is a component cannot be projected: the overlay would have
 * to render a Svelte component from another renderer's props. The memory
 * proposal is the only toast the app raises that way, and it is projected from
 * its own props instead, with the one button it shows. Any future component
 * toast has nothing the overlay can draw, so it is dropped here rather than
 * drawn empty: it is the one case where a toast would be invisible over a page,
 * and it is visible in the app window in every layout that does not cover the
 * stack's corner.
 */
export function projectToast(entry: ToastT): ToastOverlayToast | null {
  const memory = memoryProposalProps(entry)
  if (memory) {
    return {
      id: entry.id,
      kind: 'default',
      title: memory.message,
      duration: entry.duration,
      closeButton: entry.closeButton,
      dismissible: entry.dismissible,
      action: { label: 'Review Memory' }
    }
  }
  if (typeof entry.title !== 'string' || entry.title.length === 0) return null
  const action = actionButton(entry.action)
  const cancel = actionButton(entry.cancel)
  return {
    id: entry.id,
    kind: OVERLAY_KINDS[entry.type] ?? 'default',
    title: entry.title,
    description: typeof entry.description === 'string' ? entry.description : undefined,
    duration: entry.duration,
    style: entry.style,
    closeButton: entry.closeButton,
    dismissible: entry.dismissible,
    action: action ? { label: action.label } : undefined,
    cancel: cancel ? { label: cancel.label } : undefined
  }
}

/** The whole stack, as the overlay receives it. */
export function projectStack(
  toasts: readonly ToastT[],
  theme: 'light' | 'dark'
): ToastOverlayStack {
  const projected: ToastOverlayToast[] = []
  for (const entry of toasts) {
    const card = projectToast(entry)
    if (card) projected.push(card)
  }
  return { toasts: projected, theme }
}

/**
 * The floating tab strip, projected for the overlay.
 *
 * One flat list, pinned tabs first and the rest in the store's own order. The
 * floating panel exists to switch tabs, so a row carries what a user picks a tab
 * by   its icon, its name and the page's live state   and nothing the docked
 * panel's own tools need: no group headers, no search, no notes, no per-tab
 * menus. Those live in the docked strip, which is where they stay available.
 *
 * `icon` prefers the tab's own custom icon over the page's favicon, exactly as
 * the docked row does, so a tab the user dressed looks the same in both.
 */
export function projectStripTabs(): BrowserStripOverlayTab[] {
  const ordered = [...globalBrowser.pinnedTabs, ...globalBrowser.tabs.filter((tab) => !tab.pinned)]
  return ordered.map((tab) => {
    const runtime = globalBrowser.runtimeFor(tab.id)
    return {
      id: tab.id,
      label: browserTabLabel(tab),
      url: tab.url,
      icon: browserTabIconUrl(tab, globalBrowser.tabIconUrl(tab.id)) ?? tab.favicon,
      accent: browserTabAccent(tab),
      active: globalBrowser.activeTabId === tab.id,
      loading: runtime.loading,
      pinned: tab.pinned,
      hibernated: tab.hibernated,
      audible: runtime.audible,
      muted: runtime.muted
    }
  })
}

/**
 * The address row above the strip, projected for the overlay.
 *
 * The docked panel reads the same store values, so the row the overlay draws and
 * the row the app window draws say the same thing down to the bookmark star. The
 * page on screen is the active tab, which is the tab the strip's rows mark too.
 */
export function projectStripChrome(): BrowserStripOverlayChrome {
  const tab = globalBrowser.activeTab
  const address = tab?.url ?? ''
  const runtime = tab ? globalBrowser.runtimeFor(tab.id) : null
  const offer = storeExtensionOffer()
  return {
    url: address,
    secure: address.startsWith('https:'),
    loading: runtime?.loading ?? false,
    canGoBack: runtime?.canGoBack ?? false,
    canGoForward: runtime?.canGoForward ?? false,
    bookmarked: address !== '' && browserBookmarks.isBookmarked(address),
    storeOffer: offer ? storeOfferChrome(offer) : null
  }
}

/**
 * The store page's chip, as the overlay draws it.
 *
 * It answers for this one offer, never for the browser: installs queue, so another
 * extension downloading behind this page leaves the chip a door rather than a
 * spinner.
 */
function storeOfferChrome(offer: StoreExtensionOffer): BrowserStripStoreOffer {
  if (offer.installed) {
    return {
      title: `${offer.name ?? 'This extension'} is installed. Open the extensions panel.`,
      installed: true,
      installing: false
    }
  }
  const verb = storeOfferInstallVerb(offer)
  return {
    title: verb
      ? `${verb} ${offer.name ?? 'the extension'}`
      : `Install ${offer.name ?? 'this extension'} in ${offer.boxName}`,
    installed: false,
    installing: offer.install !== null
  }
}

/**
 * Run what the user did to a card the overlay drew.
 *
 * The overlay holds no handlers, so every interaction is looked up against the
 * live toast here. A report naming a toast that has already gone is answered by
 * doing nothing, which is what keeps the overlay's own dismissal from turning
 * into a loop: the overlay dismisses the card it drew, reports it, and this
 * finds the toast already dropped.
 */
export function handleToastOverlayInteraction(report: ToastOverlayInteractionReport): void {
  const live = toast.getActiveToasts().find((entry) => entry.id === report.id)
  if (!live) {
    // The overlay draws from a projection and holds no handlers, so a press on a
    // card this window has already dropped is the one case where a control that
    // was on screen goes nowhere. Only a press is logged: dismissals and
    // auto-closes cross the boundary by design and would only be noise.
    if (report.interaction === 'action' || report.interaction === 'cancel') {
      logRendererDev(
        `The toast overlay reported a ${report.interaction} on card ${String(report.id)}, which is no longer on the stack`
      )
    }
    return
  }
  if (report.interaction === 'action' || report.interaction === 'cancel') {
    const memory = report.interaction === 'action' ? memoryProposalProps(live) : null
    if (memory) {
      void openMemoryProposal(memory.projectId, memory.threadId).catch(() => {})
      toast.dismiss(report.id)
      return
    }
    const button = actionButton(report.interaction === 'action' ? live.action : live.cancel)
    // A real event, so a handler that cancels the dismissal the way svelte-sonner
    // allows (`event.preventDefault()`) keeps the toast on screen here too.
    const click = new MouseEvent('click', { bubbles: true, cancelable: true })
    button?.onClick(click)
    if (!click.defaultPrevented) toast.dismiss(report.id)
    return
  }
  if (report.interaction === 'dismiss') live.onDismiss?.(live)
  else live.onAutoClose?.(live)
  toast.dismiss(report.id)
}
