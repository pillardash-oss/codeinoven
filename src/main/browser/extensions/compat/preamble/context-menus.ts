/**
 * The context menu tree an extension builds, recorded so the app can render it.
 *
 * WHY THIS MODULE EXISTS
 * `contextMenus` is compiled out of this runtime, and a stub that drops `create`
 * leaves an extension's own menu unrenderable while an `onClicked` that cannot store
 * a listener can never be clicked. The tree has to be a record the app can act on:
 * it is read out of the mailbox, rendered in the native context menu, and the chosen
 * item comes back over the bridge as a click on the real event below.
 *
 * The tree itself lives in this module rather than in `mailbox.ts` because the two
 * modules own halves of it: this one writes it, and the mailbox serializes it into the
 * one payload the app reads. `contextMenuItems`, `contextMenuClicked` and `menuSeq` are
 * therefore exported from here and imported there, the same way the notification queue
 * is exported from `notifications.ts`.
 */
import { roots, state } from './context.ts'
import { makeRealEvent } from './events.ts'
import type { RealEvent } from './events.ts'
import { scheduleMailbox } from './mailbox.ts'

// ── contextMenus, for real ──────────────────────────────────────────────────
// A stub that drops `create` leaves an extension's own menu unrenderable, and
// one whose `onClicked` cannot store a listener can never be clicked. The tree
// is recorded here, read back by the app, rendered in the native context menu,
// and the chosen item comes back as a click on the same real event.

/** One menu item, in the shape `create` recorded it and the app renders it. */
export interface ContextMenuItem {
  /** The id `create` answered with, or the one generated for it here. */
  id: string
  /** What `create` answered with, so a click carries back what was compared against. */
  rawId: unknown
  parentId: string | null
  title: string
  type: string
  contexts: string[]
  enabled: boolean
  checked: boolean
  documentUrlPatterns: string[]
  targetUrlPatterns: string[]
}

/** The tree this life built, by the id `create` answered with. */
export const contextMenuItems = new Map<string, ContextMenuItem>()

/** The event a click on one of those items arrives on. */
export const contextMenuClicked: RealEvent = makeRealEvent()

/** Bumped on every change to the tree, so the app acts only on what it has not seen. */
export let menuSeq = 0

/**
 * The options object `create` and `update` read.
 *
 * Every field is `unknown`: the extension's own JavaScript supplies them, and each one
 * is narrowed below at the point it is used.
 */
interface ContextMenuProperties {
  id?: unknown
  parentId?: unknown
  title?: unknown
  type?: unknown
  contexts?: unknown
  enabled?: unknown
  checked?: unknown
  documentUrlPatterns?: unknown
  targetUrlPatterns?: unknown
}

export function normalizeContexts(value: unknown): string[] {
  if (typeof value === 'string' && value) return [value]
  if (Array.isArray(value)) {
    const list = (value as unknown[]).filter(
      (entry) => typeof entry === 'string' && entry
    ) as string[]
    if (list.length > 0) return list
  }
  return ['page']
}

export function invokeMenuCallback(callback: unknown): void {
  if (typeof callback !== 'function') return
  try {
    callback()
  } catch (error) {
    state.errors.push('menu-callback: ' + String(error))
  }
}

/** The counter behind the id of an item created without one. */
export let generatedMenuId = 0

export const contextMenusApi = {
  create(properties: unknown, callback: unknown): string {
    const props = (
      properties && typeof properties === 'object' ? properties : {}
    ) as ContextMenuProperties
    const hasId = props.id !== undefined && props.id !== null && props.id !== ''
    const id = hasId ? String(props.id) : 'cio-menu-' + (generatedMenuId += 1)
    try {
      contextMenuItems.set(id, {
        id,
        // The value `create` answered with, so a click carries back exactly
        // what the extension compared against.
        rawId: hasId ? props.id : id,
        parentId:
          props.parentId === undefined || props.parentId === null ? null : String(props.parentId),
        title: typeof props.title === 'string' ? props.title : '',
        type:
          ['normal', 'separator', 'checkbox', 'radio'].indexOf(String(props.type)) === -1
            ? 'normal'
            : String(props.type),
        contexts: normalizeContexts(props.contexts),
        enabled: props.enabled !== false,
        checked: props.checked === true,
        documentUrlPatterns: Array.isArray(props.documentUrlPatterns)
          ? props.documentUrlPatterns.map(String)
          : [],
        targetUrlPatterns: Array.isArray(props.targetUrlPatterns)
          ? props.targetUrlPatterns.map(String)
          : []
      })
      menuSeq += 1
      scheduleMailbox()
    } catch (error) {
      state.errors.push('menu-create: ' + String(error))
    }
    invokeMenuCallback(callback)
    return id
  },
  update(id: unknown, properties: unknown, callback: unknown): void {
    try {
      const existing = contextMenuItems.get(String(id))
      if (existing) {
        const props = (
          properties && typeof properties === 'object' ? properties : {}
        ) as ContextMenuProperties
        if (typeof props.title === 'string') existing.title = props.title
        if (props.enabled !== undefined) existing.enabled = props.enabled !== false
        if (props.checked !== undefined) existing.checked = props.checked === true
        if (props.type !== undefined) existing.type = String(props.type)
        if (props.contexts !== undefined) existing.contexts = normalizeContexts(props.contexts)
        if (props.parentId !== undefined) {
          existing.parentId = props.parentId === null ? null : String(props.parentId)
        }
        menuSeq += 1
        scheduleMailbox()
      }
    } catch (error) {
      state.errors.push('menu-update: ' + String(error))
    }
    invokeMenuCallback(callback)
  },
  remove(id: unknown, callback: unknown): void {
    try {
      if (contextMenuItems.delete(String(id))) {
        menuSeq += 1
        scheduleMailbox()
      }
    } catch (error) {
      state.errors.push('menu-remove: ' + String(error))
    }
    invokeMenuCallback(callback)
  },
  removeAll(callback: unknown): void {
    try {
      if (contextMenuItems.size > 0) {
        contextMenuItems.clear()
        menuSeq += 1
        scheduleMailbox()
      }
    } catch (error) {
      state.errors.push('menu-remove-all: ' + String(error))
    }
    invokeMenuCallback(callback)
  },
  onClicked: contextMenuClicked,
  onShown: makeRealEvent(),
  onHidden: makeRealEvent()
}

/** Install the tree above on every root this runtime exposes. */
export function installContextMenus(): void {
  for (const root of roots) {
    try {
      Object.defineProperty(root, 'contextMenus', {
        value: contextMenusApi,
        configurable: true,
        writable: true
      })
    } catch (error) {
      state.errors.push('contextMenus: ' + String(error))
    }
  }
  state.contextMenus = 'installed'
}
