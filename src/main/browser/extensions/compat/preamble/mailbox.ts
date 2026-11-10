/**
 * The state the app reads back, and the single mailbox it reads it from.
 *
 * A worker that goes idle is released and restarted by the next message, and the new
 * life's sequence starts over with none of the previous action state. The generation
 * is what lets the app tell a fresh life from a stale sequence and reset its own
 * mirror instead of treating the first snapshot as old.
 *
 * WHY THIS IS ONE MODULE
 * Every concern that keeps state the app mirrors writes into this payload, so the
 * payload lives here and the owners hand their records in: the menu tree from
 * `context-menus.ts`, the notification queue from `notifications.ts`, the side panel
 * records from `side-panel.ts`. One debounced write follows every change, and the
 * bridge page reads the key back.
 */
import { chromeApi, state } from './context.ts'
import { contextMenuItems, menuSeq } from './context-menus.ts'
import { notificationQueue } from './notifications.ts'
import { sidePanelBehavior, sidePanelOptionRecords, sidePanelRequests } from './side-panel.ts'

/** The action state the app mirrors: a global patch and one per tab id. */
export interface ActionState {
  global: Record<string, unknown>
  tabs: Record<string, unknown>
}

/** One popup the extension asked this runtime to open for its action. */
export interface ActionPopupRequest {
  seq: number
  tabId: number
  kind: string
  [field: string]: unknown
}

export const actionState: ActionState = { global: {}, tabs: {} }

/**
 * The popups the extension asked for, waiting for the app to open one.
 *
 * The array is shared, and the asker pushes into it (`bridge.ts`, from the routing
 * helpers that know the tab); the cap is applied there, at the push.
 */
export const actionPopupRequests: ActionPopupRequest[] = []

/** A identifier that only has to differ between worker lives. */
export function makeGeneration(): string {
  try {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return globalThis.crypto.randomUUID()
    }
  } catch {
    // No randomUUID in this worker: the timestamp fallback below is enough for an
    // identifier that only has to differ between worker lives.
  }
  return String(Date.now()) + '-' + Math.random().toString(36).slice(2)
}

/**
 * The storage area the mailbox is written to.
 *
 * Session storage is the one that survives a worker release without persisting into
 * the extension's saved data; local is the fallback for a runtime that has no
 * session area.
 */
/** The one member of a storage area this module calls. */
interface MailboxArea {
  set: (values: Record<string, unknown>) => unknown
}

let mailboxArea: MailboxArea | null | undefined

/**
 * The area the mailbox is written to, resolved once on first use.
 *
 * Resolved lazily and not at module evaluation, because a preamble loads in documents
 * that have no runtime at all: the entry checks for one before calling anything, and a
 * top-level read here would report a `mailbox-area` error on a page that has no
 * extension APIs, which is exactly the noise this file's own rules forbid.
 */
function mailboxStorage(): MailboxArea | null {
  if (mailboxArea !== undefined) return mailboxArea
  mailboxArea = resolveMailboxArea()
  return mailboxArea
}

function resolveMailboxArea(): MailboxArea | null {
  try {
    const storage = chromeApi.storage
    if (!storage) return null
    const areas = storage as { session?: unknown; local?: unknown }
    const session = areas.session as Partial<MailboxArea> | undefined
    const local = areas.local as Partial<MailboxArea> | undefined
    if (session && typeof session.set === 'function') return session as MailboxArea
    if (local && typeof local.set === 'function') return local as MailboxArea
  } catch (error) {
    state.errors.push('mailbox-area: ' + String(error))
  }
  return null
}

let mailboxTimer: ReturnType<typeof setTimeout> | null = null

/** Write everything the app mirrors into the one key its bridge page reads. */
export function writeMailbox(): void {
  const storage = mailboxStorage()
  if (!storage) return
  try {
    state.mailboxSeq = (Number(state.mailboxSeq) || 0) + 1
    const payload = {
      generation: state.generation,
      seq: state.mailboxSeq,
      at: Date.now(),
      actions: actionState,
      menus: Array.from(contextMenuItems.values()),
      menuSeq,
      // The notifications this life has asked the app to raise. Main acts on the
      // entries newer than the last sequence it saw, the same way it does menus.
      notifications: notificationQueue,
      // What the extension wants a side panel to be, and when it asked for one.
      sidePanel: {
        behavior: sidePanelBehavior,
        options: sidePanelOptionRecords,
        requests: sidePanelRequests
      },
      actionPopups: actionPopupRequests,
      bridgeCommands: state.bridgeCommands || 0,
      commandLog: state.commandLog || [],
      eventDispatch: state.eventDispatch || {},
      errors: state.errors.slice(-20)
    }
    const returned = storage.set({ __cioMailbox: JSON.parse(JSON.stringify(payload)) })
    if (returned && typeof (returned as { catch?: unknown }).catch === 'function') {
      ;(returned as Promise<unknown>).catch(() => {})
    }
  } catch (error) {
    state.errors.push('mailbox: ' + String(error))
  }
}

/**
 * Ask for one mailbox write.
 *
 * Debounced, because a single extension action can touch several records in a row and
 * the app only ever reads the last one.
 */
export function scheduleMailbox(): void {
  if (mailboxTimer) return
  mailboxTimer = setTimeout(() => {
    mailboxTimer = null
    writeMailbox()
  }, 80)
}

/** Stamp this worker life and start mirroring its state. */
export function installMailbox(): void {
  state.generation = makeGeneration()
  // Resolved here, inside the install, so a runtime without a storage area records
  // its one error as part of installing rather than as a module side effect.
  mailboxStorage()
}
