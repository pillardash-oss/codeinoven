/**
 * The browser's page context menu, as a native OS popup.
 *
 * Page content is a `WebContentsView`, so a right-click inside it never reaches
 * the application renderer and Electron shows no menu of its own. The menu is
 * therefore built here, in the main process, from the click Electron reports:
 * the link, image, media, selection and editable state of the exact point that
 * was clicked decide which sections appear.
 *
 * This module is deliberately free of Electron runtime values (it only imports
 * types): it turns one `ContextMenuParams` plus a set of action callbacks into a
 * menu template. The service owns the callbacks and pops the returned template,
 * so the shape of the menu is readable and testable on its own.
 */

import type { ContextMenuParams, MenuItemConstructorOptions } from 'electron'
import type { BrowserExtensionMenuRecord } from '../../../lib/ipc/browser'
import type { BrowserContextMenuBoxEntry } from '../../../lib/browser/browser-box-menu'

/** Longest selected phrase echoed in the "Search ... for" item. */
const MAX_LABEL_TEXT_LENGTH = 32

/**
 * Everything the menu can do, supplied by `BrowserService` so this module never
 * reaches into the service itself.
 *
 * Each entry is a distinct intent rather than a generic "run this", because the
 * caller   not the menu   decides which of them a given click may reach.
 */
export interface BrowserContextMenuActions {
  goBack(): void
  goForward(): void
  reload(): void
  hardReload(): void
  savePage(): void
  print(): void
  /** View the source of the address the tab is currently showing. */
  viewSource(): void
  /** Copy the tab's current address to the clipboard. */
  copyPageAddress(): void
  /** Inspect the element at a point in the page. */
  inspectElement(x: number, y: number): void
  selectAll(): void

  /** Open a link in a new tab. Only called for a navigable http(s) address. */
  openLinkInNewTab(url: string): void
  /** Open a link in a new tab in the selected named box. */
  openLinkInBox(url: string, boxId: string): void
  /** Open an ephemeral peek at a navigable link under the cursor. */
  openPeekWindow?(url: string): void
  /** Save a link's target through the download manager. */
  saveLinkAs(url: string): void

  /** Open an image, video or audio source in a new tab. */
  openMediaInNewTab(url: string): void
  /** Save an image, video or audio source through the download manager. */
  saveMediaAs(url: string): void
  /** Copy the image under the cursor to the clipboard. */
  copyImage(x: number, y: number): void
  /** Copy an arbitrary address (a link, image, media source) to the clipboard. */
  copyAddress(url: string): void
  /** Copy arbitrary text (a link's label) to the clipboard. */
  copyText(text: string): void

  /** Search the web for the selected phrase. */
  searchFor(text: string): void

  undo(): void
  redo(): void
  cut(): void
  copy(): void
  paste(): void
  pasteAndMatchStyle(): void
  deleteSelection(): void
  replaceMisspelling(word: string): void
}

/** Live facts about the tab a menu is being built for. */
export interface BrowserContextMenuContext {
  canGoBack: boolean
  canGoForward: boolean
  /** Display name of the active search engine, for the search item's label. */
  searchEngineName: string
  boxes: BrowserContextMenuBoxEntry[]
}

/** Only an http(s) address can be opened, saved or viewed as a page. */
function isNavigableAddress(url: string): boolean {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** Clip a value for a menu label, so a long URL or phrase cannot dominate it. */
function clip(value: string, max: number): string {
  const trimmed = value.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed
}

/**
 * The page-level actions, shared by the right-click menu and the toolbar's
 * page menu so both offer the same commands.
 *
 * `includeSelectAll` is false for the right-click menu on an editable field,
 * whose editing section already carries a properly-gated Select All, so the
 * item never appears twice.
 */
export function buildBrowserPageMenuItems(
  context: BrowserContextMenuContext,
  actions: BrowserContextMenuActions,
  includeSelectAll = true
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = [
    { label: 'Back', enabled: context.canGoBack, click: () => actions.goBack() },
    { label: 'Forward', enabled: context.canGoForward, click: () => actions.goForward() },
    { type: 'separator' },
    { label: 'Reload', click: () => actions.reload() },
    { label: 'Hard Reload', click: () => actions.hardReload() },
    { type: 'separator' },
    { label: 'Save Page As…', click: () => actions.savePage() },
    { label: 'Print…', click: () => actions.print() },
    { label: 'View Page Source', click: () => actions.viewSource() },
    { type: 'separator' },
    { label: 'Copy Page Address', click: () => actions.copyPageAddress() }
  ]
  if (includeSelectAll) items.push({ label: 'Select All', click: () => actions.selectAll() })
  return items
}

/** The editing actions for an editable field or text area. */
function buildEditingItems(
  params: ContextMenuParams,
  actions: BrowserContextMenuActions
): MenuItemConstructorOptions[] {
  const flags = params.editFlags
  return [
    { label: 'Undo', enabled: flags.canUndo, click: () => actions.undo() },
    { label: 'Redo', enabled: flags.canRedo, click: () => actions.redo() },
    { type: 'separator' },
    { label: 'Cut', enabled: flags.canCut, click: () => actions.cut() },
    { label: 'Copy', enabled: flags.canCopy, click: () => actions.copy() },
    { label: 'Paste', enabled: flags.canPaste, click: () => actions.paste() },
    {
      label: 'Paste and Match Style',
      enabled: flags.canPaste,
      click: () => actions.pasteAndMatchStyle()
    },
    { label: 'Delete', enabled: flags.canDelete, click: () => actions.deleteSelection() },
    { type: 'separator' },
    { label: 'Select All', enabled: flags.canSelectAll, click: () => actions.selectAll() }
  ]
}

/** The spelling suggestions for a misspelled word under the cursor. */
function buildSpellingItems(
  params: ContextMenuParams,
  actions: BrowserContextMenuActions
): MenuItemConstructorOptions[] {
  const suggestions = params.dictionarySuggestions.slice(0, 5)
  if (suggestions.length === 0) return []
  return [
    ...suggestions.map((word) => ({
      label: word,
      click: () => actions.replaceMisspelling(word)
    })),
    { type: 'separator' as const }
  ]
}

/** The actions for a link, headed by opening it. */
function buildLinkItems(
  params: ContextMenuParams,
  context: BrowserContextMenuContext,
  actions: BrowserContextMenuActions
): MenuItemConstructorOptions[] {
  const url = params.linkURL
  const navigable = isNavigableAddress(url)
  const items: MenuItemConstructorOptions[] = []
  if (navigable) {
    items.push({ label: 'Open Link in New Tab', click: () => actions.openLinkInNewTab(url) })
    if (context.boxes.length > 0) {
      items.push({
        label: 'Open Link in Box',
        submenu: context.boxes.map((box) => ({
          label: box.name,
          click: () => actions.openLinkInBox(url, box.id)
        }))
      })
    }
    if (actions.openPeekWindow)
      items.push({ label: 'Take a Peek', click: () => actions.openPeekWindow?.(url) })
  }
  if (params.linkText.trim()) {
    items.push({ label: 'Copy Link Text', click: () => actions.copyText(params.linkText) })
  }
  items.push({ label: 'Copy Link Address', click: () => actions.copyAddress(url) })
  if (navigable) {
    items.push({ label: 'Save Link As…', click: () => actions.saveLinkAs(url) })
  }
  return items
}

/** The actions for an image under the cursor. */
function buildImageItems(
  params: ContextMenuParams,
  actions: BrowserContextMenuActions
): MenuItemConstructorOptions[] {
  const url = params.srcURL
  const items: MenuItemConstructorOptions[] = []
  if (isNavigableAddress(url)) {
    items.push({
      label: 'Open Image in New Tab',
      click: () => actions.openMediaInNewTab(url)
    })
  }
  items.push({ label: 'Copy Image', click: () => actions.copyImage(params.x, params.y) })
  if (url) {
    items.push({ label: 'Copy Image Address', click: () => actions.copyAddress(url) })
  }
  if (isNavigableAddress(url)) {
    items.push({ label: 'Save Image As…', click: () => actions.saveMediaAs(url) })
  }
  return items
}

/** The actions for a video or audio element under the cursor. */
function buildMediaItems(
  params: ContextMenuParams,
  actions: BrowserContextMenuActions
): MenuItemConstructorOptions[] {
  const url = params.srcURL
  const noun = params.mediaType === 'video' ? 'Video' : 'Audio'
  const items: MenuItemConstructorOptions[] = []
  if (isNavigableAddress(url)) {
    items.push({
      label: `Open ${noun} in New Tab`,
      click: () => actions.openMediaInNewTab(url)
    })
  }
  if (url) {
    items.push({ label: `Copy ${noun} Address`, click: () => actions.copyAddress(url) })
  }
  if (isNavigableAddress(url)) {
    items.push({ label: `Save ${noun} As…`, click: () => actions.saveMediaAs(url) })
  }
  return items
}

/**
 * Build the full right-click menu for one point in a page.
 *
 * Sections are emitted in the order a user expects from a browser: spelling and
 * editing first for a field, then the thing under the cursor (link, image or
 * media), then a plain selection, then the page itself. An empty section
 * contributes nothing, so the menu is exactly as long as the click warrants.
 */
export function buildBrowserContextMenuItems(
  params: ContextMenuParams,
  context: BrowserContextMenuContext,
  actions: BrowserContextMenuActions,
  extensionItems: MenuItemConstructorOptions[] = []
): MenuItemConstructorOptions[] {
  const items: MenuItemConstructorOptions[] = []
  const push = (section: MenuItemConstructorOptions[]): void => {
    if (section.length === 0) return
    if (items.length > 0) items.push({ type: 'separator' })
    items.push(...section)
  }

  if (params.misspelledWord) push(buildSpellingItems(params, actions))
  if (params.isEditable) push(buildEditingItems(params, actions))
  if (params.linkURL) push(buildLinkItems(params, context, actions))
  if (params.mediaType === 'image' && params.srcURL) push(buildImageItems(params, actions))
  if ((params.mediaType === 'video' || params.mediaType === 'audio') && params.srcURL) {
    push(buildMediaItems(params, actions))
  }
  if (!params.isEditable && params.selectionText.trim()) {
    const selected = clip(params.selectionText, MAX_LABEL_TEXT_LENGTH)
    push([
      { label: 'Copy', click: () => actions.copy() },
      {
        label: `Search ${context.searchEngineName} for "${selected}"`,
        click: () => actions.searchFor(params.selectionText)
      }
    ])
  }

  if (items.length > 0) items.push({ type: 'separator' })
  items.push(...buildBrowserPageMenuItems(context, actions, !params.isEditable))
  // An extension's items sit last but before the app's own inspection, the way a
  // browser puts contributed items below its built-ins. Nothing changes for a
  // page no extension contributed to.
  if (extensionItems.length > 0) {
    items.push({ type: 'separator' })
    items.push(...extensionItems)
  }
  items.push({ type: 'separator' })
  items.push({
    label: 'Inspect Element',
    click: () => actions.inspectElement(params.x, params.y)
  })
  return items
}

/** One extension's recorded tree, with the id a click has to come back to. */
export interface BrowserExtensionMenuSection {
  extensionId: string
  items: BrowserExtensionMenuRecord[]
}

/**
 * Which `chrome.contextMenus` contexts one click belongs to, most specific first.
 *
 * `page` is the base case, not a fallback: it is what a click on nothing in
 * particular is, which is why it is only reported when nothing else is.
 */
export function extensionClickContexts(params: ContextMenuParams): string[] {
  const contexts: string[] = []
  if (params.isEditable) contexts.push('editable')
  if (params.selectionText.trim()) contexts.push('selection')
  if (params.linkURL) contexts.push('link')
  if (params.mediaType === 'image' && params.srcURL) contexts.push('image')
  if (params.mediaType === 'video') contexts.push('video')
  if (params.mediaType === 'audio') contexts.push('audio')
  if (contexts.length === 0) contexts.push('page')
  return contexts
}

/**
 * The recorded menus of every extension as native items.
 *
 * An item is kept when the click is in one of its contexts (`all` always fits);
 * a parent becomes a submenu, a separator is a separator, and a checkbox or
 * radio carries its recorded state. A `parentId` cycle is broken rather than
 * followed, and an item whose parent is missing becomes a root, so nothing an
 * extension recorded can make the menu unbuildable.
 */
export function buildExtensionMenuItems(
  sections: BrowserExtensionMenuSection[],
  contexts: string[],
  onSelect: (section: BrowserExtensionMenuSection, item: BrowserExtensionMenuRecord) => void
): MenuItemConstructorOptions[] {
  const output: MenuItemConstructorOptions[] = []
  for (const section of sections) {
    const ids = new Set(section.items.map((item) => item.id))
    const childrenOf = (parentId: string | null): BrowserExtensionMenuRecord[] =>
      section.items.filter((item) => item.parentId === parentId)
    const matches = (item: BrowserExtensionMenuRecord): boolean =>
      item.contexts.length === 0 ||
      item.contexts.includes('all') ||
      item.contexts.some((context) => contexts.includes(context))
    const render = (
      item: BrowserExtensionMenuRecord,
      seen: Set<string>
    ): MenuItemConstructorOptions | null => {
      if (!matches(item) || seen.has(item.id)) return null
      const next = new Set(seen)
      next.add(item.id)
      if (item.type === 'separator') return { type: 'separator' }
      const label = item.title || ' '
      const children = childrenOf(item.id)
        .map((child) => render(child, next))
        .filter((child): child is MenuItemConstructorOptions => child !== null)
      if (children.length > 0) return { label, enabled: item.enabled, submenu: children }
      if (item.type === 'checkbox' || item.type === 'radio') {
        return {
          label,
          type: item.type,
          checked: item.checked,
          enabled: item.enabled,
          click: () => onSelect(section, item)
        }
      }
      return { label, enabled: item.enabled, click: () => onSelect(section, item) }
    }
    const roots = section.items.filter((item) => item.parentId === null || !ids.has(item.parentId))
    for (const item of roots) {
      const rendered = render(item, new Set())
      if (rendered) output.push(rendered)
    }
  }
  return output
}
