import type { Terminal } from 'ghostty-web'

interface TerminalInputCompatOptions {
  term: Terminal
  host: HTMLElement
}

/**
 * Zsh/readline bind these sequences by default for word navigation. ghostty-web
 * encodes option/control+arrows as CSI-modified cursor keys (`ESC[1;3D` /
 * `ESC[1;5D`), which vim understands but the shells' line editors do not.
 */
const BACKWARD_WORD_SEQUENCE = '\x1bb'
const FORWARD_WORD_SEQUENCE = '\x1bf'

const BRACKETED_PASTE_START = '\x1b[200~'
const BRACKETED_PASTE_END = '\x1b[201~'

/**
 * Normalize pasted text the way a desktop terminal would: line separators are
 * CR (`\r` is "Enter" in terminal semantics), never LF.
 */
function normalizePastedText(text: string): string {
  return text.replaceAll('\r\n', '\r').replaceAll('\n', '\r')
}

/**
 * Restores two behaviors ghostty-web does not provide out of the box:
 *
 * 1. Multi-line paste: ghostty's element-level paste handler forwards raw text
 *    (no bracketed-paste delimiters), so shells with bracketed paste enabled
 *    execute each pasted line immediately. This routes every paste through the
 *    bracketed-paste wrapping the shell negotiated, exactly like a desktop
 *    terminal, regardless of which internal element holds focus.
 *
 * 2. Option/control+Arrow word hopping: the WASM key encoder emits CSI-modified
 *    cursor sequences (`ESC[1;3D`, `ESC[1;5C`, ...) which work in full-screen
 *    apps (vim) but are unbound in zsh/readline. In plain shell mode those are
 *    translated to the `ESC b` / `ESC f` word-move sequences the line
 *    editors bind by default. Full-screen apps on the alternate screen (vim,
 *    less, tmux panes) keep the encoder's own sequences.
 */
export function attachTerminalInputCompat(
  { term, host }: TerminalInputCompatOptions,
  send: (data: string) => void
): () => void {
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.metaKey) return
    const isWordMove =
      (event.altKey || event.ctrlKey) && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
    if (!isWordMove) return
    // A full-screen app owns the keyboard on the alternate screen (vim, less,
    // htop...). Leave those keys for the app's own (working) bindings; only
    // translate in a plain shell. Application cursor keys (DECCKM, mode 1) are
    // NOT a signal for that: the shell line editors (zsh zle, bash readline)
    // enable them themselves (`smkx`) while editing a prompt, so checking them
    // would suppress word hopping exactly when editing a command line.
    if (term.wasmTerm?.isAlternateScreen()) return
    event.preventDefault()
    event.stopPropagation()
    send(event.key === 'ArrowLeft' ? BACKWARD_WORD_SEQUENCE : FORWARD_WORD_SEQUENCE)
  }
  const onPaste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData('text/plain')
    if (!text) return
    event.preventDefault()
    event.stopPropagation()
    const normalized = normalizePastedText(text)
    const bracketed = term.wasmTerm?.hasBracketedPaste()
    send(bracketed ? `${BRACKETED_PASTE_START}${normalized}${BRACKETED_PASTE_END}` : normalized)
  }

  const options: AddEventListenerOptions = { capture: true }
  host.addEventListener('keydown', onKeydown, options)
  host.addEventListener('paste', onPaste, options)

  return () => {
    host.removeEventListener('keydown', onKeydown, options)
    host.removeEventListener('paste', onPaste, options)
  }
}
