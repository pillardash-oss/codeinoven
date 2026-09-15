import type { Terminal } from 'ghostty-web'

/**
 * Registry binding a rendered terminal host element to its live `Terminal`
 * instance and PTY write channel. The shared context menu is a global document
 * listener: it sees only DOM elements, so it resolves the terminal to act on
 * through this registry instead of reaching into the session manager.
 */

export interface TerminalHostEntry {
  term: Terminal
  /** Write raw data to the terminal's PTY (bracketed paste goes through here). */
  write: (data: string) => void
}

const entries = new Map<HTMLElement, TerminalHostEntry>()

/** Register one terminal host. Returns a disposer that removes the entry. */
export function registerTerminalHost(host: HTMLElement, entry: TerminalHostEntry): () => void {
  entries.set(host, entry)
  return () => {
    entries.delete(host)
  }
}

/** Resolve the live terminal bound to `host`, if any. */
export function terminalEntryForHost(host: HTMLElement): TerminalHostEntry | undefined {
  return entries.get(host)
}
