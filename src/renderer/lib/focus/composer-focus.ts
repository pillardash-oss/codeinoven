/**
 * Guard window around thread switches.
 *
 * Switching to a thread must always leave keyboard focus in the chat
 * composer — never in an open sidebar tool (terminal, action terminal,
 * panels). A user who wants the sidebar focused clicks on it directly.
 *
 * Sidebar surfaces re-attach asynchronously around a thread switch (terminal
 * panel attachments re-run when the thread binding changes), and their
 * programmatic focus calls would otherwise race with — and win over — the
 * composer focus. Opening this window on every thread open lets those focus
 * calls yield for a short time. Direct user interaction (clicking the
 * terminal) is native focus and is never affected.
 */

/** How long programmatic sidebar focus grabs yield after a thread switch.
 *  Only needs to cover the async terminal attach round-trip. */
const COMPOSER_FOCUS_WINDOW_MS = 1500

let windowEndsAt = 0

/** Open the guard window. Call whenever a thread is opened or switched to. */
export function openComposerFocusWindow(): void {
  windowEndsAt = Date.now() + COMPOSER_FOCUS_WINDOW_MS
}

/** Whether a thread was just switched to, so automatic focus grabs in the
 *  sidebar must yield to the chat composer. */
export function composerOwnsKeyboardFocus(): boolean {
  return Date.now() < windowEndsAt
}
