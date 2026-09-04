<script lang="ts">
  import { FitAddon, Ghostty, Terminal, type ITheme } from 'ghostty-web'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { TerminalCursorController } from '$lib/terminal/cursor-visibility'
  import { patchSelectionCopy } from '$lib/terminal/selection-copy'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    /** Stable id used for pty:createCommand / pty:data / pty:exit channels. */
    terminalId: string
    command: string
    args: string[]
    /** Invoked once the login process exits. */
    onExit: (exitCode: number) => void
  }

  let { terminalId, command, args, onExit }: Props = $props()

  let error = $state('')
  let started = $state(false)
  let destroyed = false

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

  let term: Terminal | undefined
  const unsubs: Array<() => void> = []

  async function init(container: HTMLDivElement): Promise<void> {
    try {
      const ghostty = await Ghostty.load()
      if (destroyed) return
      patchSelectionCopy()
      const terminal = new Terminal({
        ghostty,
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 13,
        fontFamily:
          "'JetBrains Mono Variable', 'JetBrainsMono Nerd Font Mono', 'JetBrainsMono Nerd Font', ui-monospace, 'SFMono-Regular', Menlo, Monaco, 'Cascadia Code', 'Ubuntu Mono', monospace",
        scrollback: 5000,
        smoothScrollDuration: 80,
        theme: terminalTheme()
      })
      const fit = new FitAddon()
      terminal.loadAddon(fit)

      const host = document.createElement('div')
      host.className = 'terminal-host'
      terminal.open(host)
      container.replaceChildren(host)
      fit.observeResize()
      fit.fit()

      // Only render the caret while this terminal actually holds focus.
      const cursorVisibility = new TerminalCursorController(terminal)
      const onFocusIn = (): void => cursorVisibility.focus()
      const onFocusOut = (): void => cursorVisibility.blur()
      host.addEventListener('focusin', onFocusIn)
      host.addEventListener('focusout', onFocusOut)

      term = terminal

      unsubs.push(
        () => {
          host.removeEventListener('focusin', onFocusIn)
          host.removeEventListener('focusout', onFocusOut)
        },
        subscribe(`pty:data:${terminalId}`, (data) => {
          terminal.write(data as string)
        }),
        subscribe(`pty:exit:${terminalId}`, (exitCode) => {
          const code = typeof exitCode === 'number' ? exitCode : 0
          terminal.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
          onExit(code)
        })
      )

      const inputDisposable = terminal.onData((data) => {
        window.api.send('pty:write', terminalId, data)
      })
      unsubs.push(() => inputDisposable.dispose())

      const resizeDisposable = terminal.onResize(({ cols, rows }) => {
        if (started) window.api.send('pty:resize', terminalId, cols, rows)
      })
      unsubs.push(() => resizeDisposable.dispose())

      await invoke('pty:createCommand', terminalId, command, args, terminal.cols, terminal.rows)
      started = true
      terminal.focus()
    } catch (initError) {
      if (!destroyed) {
        error =
          initError instanceof Error ? initError.message : 'The login terminal failed to start.'
      }
    }
  }

  const terminalAttachment: Attachment<HTMLDivElement> = (node) => {
    void init(node)
    return () => {
      destroyed = true
      for (const unsub of unsubs) unsub()
      term?.dispose()
      term = undefined
      void invoke('pty:destroy', terminalId)
    }
  }
</script>

<div
  tabindex="-1"
  class="login-host relative h-full w-full overflow-hidden bg-app"
  {@attach terminalAttachment}
>
  {#if !started && !error}
    <div class="absolute inset-0 flex items-center justify-center bg-app text-xs text-muted">
      Starting sign-in…
    </div>
  {:else if error}
    <div class="absolute inset-0 flex items-center justify-center bg-app p-6">
      <p class="max-w-md text-center text-xs text-danger">{error}</p>
    </div>
  {/if}
</div>

<style>
  .login-host :global(.terminal-host) {
    height: 100%;
    width: 100%;
    overflow: hidden;
    outline: none;
    padding: 4px 0;
  }

  .login-host :global(.terminal-host textarea) {
    caret-color: transparent;
  }
</style>
