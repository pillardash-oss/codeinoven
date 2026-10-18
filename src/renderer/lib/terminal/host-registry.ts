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
let fontRevision = 0

/** Repaint existing canvas terminals only after their selected font is ready. */
export function syncTerminalFonts(fontFamily: string): void {
  const revision = ++fontRevision
  if (entries.size === 0) return
  void document.fonts
    .load(`13px ${fontFamily.split(',')[0]}`)
    .catch(() => [])
    .then(() => {
      if (revision !== fontRevision) return
      const pending = entries.values()
      const applyBatch = (): void => {
        if (revision !== fontRevision) return
        for (let count = 0; count < 4; count++) {
          const next = pending.next()
          if (next.done) return
          if (next.value.term.options.fontFamily !== fontFamily) {
            next.value.term.options.fontFamily = fontFamily
          }
        }
        requestAnimationFrame(applyBatch)
      }
      applyBatch()
    })
}

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
