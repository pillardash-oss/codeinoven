import { FitAddon, Ghostty, Terminal, UrlRegexProvider, type ITheme } from 'ghostty-web'
import { CursorShapeDecoder } from './cursor-shape'
import { TerminalCursorController } from './cursor-visibility'
import { setTerminalFocused } from './focus'
import { patchSelectionCopy } from './selection-copy'
import { attachTerminalInputCompat } from './input-compat'
import { attachMouseTracking } from './mouse-tracking'
import { FileLinkProvider } from './path-links'
import { invoke, subscribe } from '$lib/ipc.svelte'

export interface TerminalSession {
  id: string
  term: Terminal
  fitAddon: FitAddon
  host: HTMLDivElement
  exited: boolean
  ptySpawned: boolean
  /** Owning project, resolved once the terminal attaches to a panel. */
  projectId: string | null
  /** Consecutive immediate shell exits since the last healthy (2s) uptime. */
  respawnCount: number
  kind: 'shell' | 'action'
}

const MAX_RESPAWNS = 5
const RESPAWN_BACKOFF_RESET_MS = 2000
const RESIZE_SETTLE_MS = 100

/**
 * Keep the terminal grid fitted to its host, including the final frame of a
 * sidebar resize. ghostty-web's observer drops resize notifications while its
 * previous fit is still settling, which can leave the canvas at an older width
 * when the last notification arrives inside that window.
 */
function observeTerminalResize(host: HTMLDivElement, fitAddon: FitAddon): () => void {
  let settleTimer: ReturnType<typeof setTimeout> | undefined
  const observer = new ResizeObserver(() => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => fitAddon.fit(), RESIZE_SETTLE_MS)
  })
  observer.observe(host)

  return () => {
    observer.disconnect()
    if (settleTimer) clearTimeout(settleTimer)
  }
}

function readThemeColor(styles: CSSStyleDeclaration, token: string): string {
  return styles.getPropertyValue(token).trim()
}

function terminalTheme(): ITheme {
  const styles = getComputedStyle(document.documentElement)
  return {
    background: readThemeColor(styles, '--color-terminal-background'),
    foreground: readThemeColor(styles, '--color-terminal-foreground'),
    cursor: readThemeColor(styles, '--color-terminal-cursor'),
    selectionBackground: readThemeColor(styles, '--color-terminal-selection'),
    black: readThemeColor(styles, '--color-terminal-black'),
    red: readThemeColor(styles, '--color-terminal-red'),
    green: readThemeColor(styles, '--color-terminal-green'),
    yellow: readThemeColor(styles, '--color-terminal-yellow'),
    blue: readThemeColor(styles, '--color-terminal-blue'),
    magenta: readThemeColor(styles, '--color-terminal-magenta'),
    cyan: readThemeColor(styles, '--color-terminal-cyan'),
    white: readThemeColor(styles, '--color-terminal-white'),
    brightBlack: readThemeColor(styles, '--color-terminal-bright-black'),
    brightRed: readThemeColor(styles, '--color-terminal-bright-red'),
    brightGreen: readThemeColor(styles, '--color-terminal-bright-green'),
    brightYellow: readThemeColor(styles, '--color-terminal-bright-yellow'),
    brightBlue: readThemeColor(styles, '--color-terminal-bright-blue'),
    brightMagenta: readThemeColor(styles, '--color-terminal-bright-magenta'),
    brightCyan: readThemeColor(styles, '--color-terminal-bright-cyan'),
    brightWhite: readThemeColor(styles, '--color-terminal-bright-white')
  }
}

/**
 * Keeps Ghostty terminal state and its PTY alive independently of component
 * lifecycles. Each session owns a stable host element that can move between
 * Svelte containers without rebuilding the WASM terminal or losing scrollback.
 *
 * The Ghostty `Terminal` instance is the single source of truth for scrollback:
 * PTY output is written to it continuously (even while the panel is hidden),
 * so reattaching the host later restores the full buffer.
 */
class TerminalSessionManager {
  private sessions = new Map<string, TerminalSession>()
  private pendingSessions = new Map<string, Promise<TerminalSession>>()
  private disposables = new Map<string, Array<() => void>>()
  private runtime: Promise<Ghostty> | undefined

  /** Return the live session for `id`, creating its Ghostty terminal if needed. */
  async getOrCreate(id: string): Promise<TerminalSession> {
    const existing = this.sessions.get(id)
    if (existing && (!existing.exited || existing.kind === 'action')) return existing
    if (existing?.exited) this.teardown(id)

    const pending = this.pendingSessions.get(id)
    if (pending) return pending

    const creation = this.create(id)
    this.pendingSessions.set(id, creation)
    try {
      return await creation
    } finally {
      if (this.pendingSessions.get(id) === creation) {
        this.pendingSessions.delete(id)
      }
    }
  }

  async getOrCreateAction(id: string): Promise<TerminalSession> {
    const session = await this.getOrCreate(id)
    session.kind = 'action'
    return session
  }

  getSession(id: string): TerminalSession | undefined {
    return this.sessions.get(id)
  }

  /** Move a live session into the visible panel and ensure its shell is running. */
  async attach(
    session: TerminalSession,
    container: HTMLDivElement,
    projectId: string,
    threadId: string,
    scopeBucketId?: string
  ): Promise<void> {
    if (session.host.parentElement !== container) {
      container.replaceChildren(session.host)
    }
    session.fitAddon.fit()
    await this.ensurePty(session, projectId, threadId, scopeBucketId)
    session.term.focus()
  }

  async attachAction(
    session: TerminalSession,
    container: HTMLDivElement,
    projectId: string,
    threadId: string,
    script: string,
    variables: Record<string, string>,
    scopeBucketId?: string
  ): Promise<void> {
    if (session.host.parentElement !== container) container.replaceChildren(session.host)
    session.fitAddon.fit()
    if (!session.ptySpawned) {
      session.projectId = projectId
      session.ptySpawned = true
      try {
        await invoke(
          'pty:createAction',
          session.id,
          projectId,
          threadId,
          script,
          variables,
          session.term.cols,
          session.term.rows,
          scopeBucketId
        )
      } catch (error) {
        session.ptySpawned = false
        throw error
      }
    }
    session.term.focus()
  }

  private getRuntime(): Promise<Ghostty> {
    if (!this.runtime) {
      this.runtime = Ghostty.load().catch((error: unknown) => {
        this.runtime = undefined
        throw error
      })
    }
    return this.runtime
  }

  /** Spawn the shell PTY after the terminal has been attached and sized. The
   *  scope bucket resolves the shell's working directory: a managed worktree
   *  scope starts the shell inside its checkout instead of the project root. */
  private async ensurePty(
    session: TerminalSession,
    projectId: string,
    threadId: string,
    scopeBucketId?: string
  ): Promise<void> {
    if (session.ptySpawned) return
    session.projectId = projectId
    session.ptySpawned = true
    try {
      await invoke(
        'pty:create',
        session.id,
        projectId,
        threadId,
        session.term.cols,
        session.term.rows,
        scopeBucketId
      )
    } catch (error) {
      session.ptySpawned = false
      throw error
    }
  }

  private async create(id: string): Promise<TerminalSession> {
    const ghostty = await this.getRuntime()
    patchSelectionCopy()
    const term = new Terminal({
      ghostty,
      cursorBlink: true,
      cursorStyle: 'bar',
      fontSize: 13,
      fontFamily:
        "'JetBrainsMono Nerd Font Mono', 'JetBrainsMono Nerd Font', ui-monospace, 'SFMono-Regular', Menlo, Monaco, 'Cascadia Code', 'Ubuntu Mono', monospace",
      scrollback: 5000,
      smoothScrollDuration: 80,
      theme: terminalTheme()
    })
    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)

    const host = document.createElement('div')
    host.className = 'terminal-host'
    term.open(host)

    // Reflect terminal focus to the app's shortcut routing. On non-mac platforms
    // Ctrl+W must keep its shell delete-word behavior while the terminal is
    // focused, so both the main process and the renderer fallback need to know.
    // Focus also drives the caret: it only renders while the terminal is focused,
    // and DECSCUSR blink state is re-applied on focus regain.
    const cursorVisibility = new TerminalCursorController(term)
    const onFocusIn = (): void => {
      cursorVisibility.focus()
      setTerminalFocused(true)
    }
    const onFocusOut = (): void => {
      cursorVisibility.blur()
      setTerminalFocused(false)
    }
    host.addEventListener('focusin', onFocusIn)
    host.addEventListener('focusout', onFocusOut)
    const cleanupFocus = (): void => {
      host.removeEventListener('focusin', onFocusIn)
      host.removeEventListener('focusout', onFocusOut)
    }

    const session: TerminalSession = {
      id,
      term,
      fitAddon,
      host,
      exited: false,
      ptySpawned: false,
      projectId: null,
      respawnCount: 0,
      kind: 'shell'
    }
    this.sessions.set(id, session)

    // Plain-text web URLs use Ghostty's modifier-click provider. The provider
    // delegates to window.open; the main process routes that popup through the
    // validated external-browser boundary in both dev and packaged builds.
    term.registerLinkProvider(new UrlRegexProvider(term))

    // File/directory paths echoed by tooling are clickable links only once they
    // are confirmed to exist in the owning project; cmd/ctrl+click reveals them
    // in the OS file manager. (ghostty-web ships no file-path provider.)
    term.registerLinkProvider(new FileLinkProvider(term, { getProjectId: () => session.projectId }))

    const subs: Array<() => void> = []
    const cursorShape = new CursorShapeDecoder()
    subs.push(cleanupFocus, observeTerminalResize(host, fitAddon))

    // PTY output → terminal buffer. Always active so the buffer stays current
    // even while the panel is hidden or the component is unmounted. DECSCUSR
    // cursor shape changes (e.g. Neovim normal/insert mode) are applied to the
    // renderer as they stream in.
    subs.push(
      subscribe(`pty:data:${id}`, (data) => {
        const text = data as string
        term.write(text)
        const shape = cursorShape.push(text)
        if (shape && term.renderer) {
          term.renderer.setCursorStyle(shape.style)
          cursorVisibility.updateBlink(shape.blinking)
        }
      })
    )

    // Restart the shell after it exits (Ctrl-D / `exit` / crash), like a
    // desktop terminal. The live Ghostty buffer and this session are reused —
    // only the PTY is respawned. A broken shell that exits immediately is
    // backoff-guarded so we don't respawn forever.
    let respawnTimer: ReturnType<typeof setTimeout> | undefined
    const respawn = async (): Promise<void> => {
      if (!session.projectId) {
        session.exited = true
        return
      }
      if (session.respawnCount >= MAX_RESPAWNS) {
        session.exited = true
        return
      }
      session.respawnCount += 1
      session.ptySpawned = false
      try {
        await this.ensurePty(session, session.projectId)
        session.exited = false
        // A shell that survives this window is healthy, so reset the guard.
        respawnTimer = setTimeout(() => {
          session.respawnCount = 0
        }, RESPAWN_BACKOFF_RESET_MS)
      } catch {
        session.exited = true
      }
    }

    subs.push(
      subscribe(`pty:exit:${id}`, () => {
        term.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
        session.exited = true
        if (session.kind === 'shell') void respawn()
      })
    )
    subs.push(() => {
      if (respawnTimer) clearTimeout(respawnTimer)
    })

    // Terminal input → PTY
    const inputDisposable = term.onData((data) => {
      window.api.send('pty:write', id, data)
    })
    subs.push(() => inputDisposable.dispose())

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      if (session.ptySpawned) {
        window.api.send('pty:resize', id, cols, rows)
      }
    })
    subs.push(() => resizeDisposable.dispose())

    // Forward mouse events to the PTY while a program owns mouse tracking
    // (nvim, htop, tmux...). ghostty-web never does this on its own.
    subs.push(
      attachMouseTracking({ term, host }, (data) => {
        window.api.send('pty:write', id, data)
      })
    )

    // Multi-line paste (bracketed-paste aware, CR-normalized) and option/control
    // +Arrow word hopping for the shell. ghostty-web's built-in handling is
    // missing both.
    subs.push(
      attachTerminalInputCompat({ term, host }, (data) => {
        window.api.send('pty:write', id, data)
      })
    )

    this.disposables.set(id, subs)
    return session
  }

  private teardown(id: string): void {
    const subs = this.disposables.get(id)
    if (subs) {
      for (const unsub of subs) unsub()
      this.disposables.delete(id)
    }
    const session = this.sessions.get(id)
    if (session) {
      session.term.dispose()
      this.sessions.delete(id)
    }
    // The focused terminal is gone — make sure the app no longer thinks a
    // terminal is focused so non-mac Ctrl+W resumes closing surfaces.
    setTerminalFocused(false)
  }
}

export const terminalSessions = new TerminalSessionManager()
