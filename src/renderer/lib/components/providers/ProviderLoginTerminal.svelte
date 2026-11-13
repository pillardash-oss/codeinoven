<script lang="ts">
  import { loadTerminalFontFamily } from '$lib/app-typography'
  import type { Terminal } from 'ghostty-web'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { TerminalCursorController } from '$lib/terminal/cursor-visibility'
  import { patchSelectionCopy } from '$lib/terminal/selection-copy'
  import { registerTerminalHost } from '$lib/terminal/host-registry'
  import { loadGhosttyWeb } from '$lib/terminal/runtime'
  import { terminalThemeFromTokens } from '$lib/terminal/theme'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    /** Stable id used for pty:createCommand / pty:data / pty:exit channels. */
    terminalId: string
    command: string
    args: string[]
    /** Kill the process after this many ms of complete silence (used for hung updates). */
    idleTimeoutMs?: number
    environment?: Record<string, string>
    cancelled?: boolean
    startingLabel?: string
    /** Invoked once the login process exits, with what it printed. */
    onExit: (exitCode: number, output: string) => void
  }

  let {
    terminalId,
    command,
    args,
    idleTimeoutMs,
    environment,
    onExit,
    cancelled = false,
    startingLabel = 'Starting terminal…'
  }: Props = $props()

  let error = $state('')
  let started = $state(false)
  let destroyed = false
  /** Tail of what the process printed, so a failure can report the CLI's reason. */
  let printed = ''
  const PRINTED_LIMIT = 8_000

  let term: Terminal | undefined
  const unsubs: Array<() => void> = []

  async function init(container: HTMLDivElement): Promise<void> {
    try {
      const ghosttyWeb = await loadGhosttyWeb()
      const ghostty = await ghosttyWeb.Ghostty.load()
      if (destroyed || cancelled) return
      await patchSelectionCopy()
      if (destroyed || cancelled) return
      const fontFamily = await loadTerminalFontFamily()
      if (destroyed || cancelled) return
      const terminal = new ghosttyWeb.Terminal({
        ghostty,
        cursorBlink: true,
        cursorStyle: 'bar',
        fontSize: 13,
        fontFamily,
        scrollback: 5000,
        smoothScrollDuration: 80,
        theme: terminalThemeFromTokens()
      })
      const fit = new ghosttyWeb.FitAddon()
      terminal.loadAddon(fit)

      const host = document.createElement('div')
      host.className = 'terminal-host'
      container.append(host)
      terminal.open(host)
      fit.observeResize()
      fit.fit()

      // Keep the existing terminal and PTY when its live panel changes documents.
      const syncDocument = (): void => {
        fit.fit()
      }
      container.addEventListener('native-floating-document-change', syncDocument)
      unsubs.push(() =>
        container.removeEventListener('native-floating-document-change', syncDocument)
      )

      // Only render the caret while this terminal actually holds focus.
      const cursorVisibility = new TerminalCursorController(terminal)
      const onFocusIn = (): void => cursorVisibility.focus()
      const onFocusOut = (): void => cursorVisibility.blur()
      host.addEventListener('focusin', onFocusIn)
      host.addEventListener('focusout', onFocusOut)

      // Expose the live terminal to the shared context menu (Copy / Paste /
      // Select All) through the host registry.
      const unregisterHost = registerTerminalHost(host, {
        term: terminal,
        write: (data) => {
          window.api.send('pty:write', terminalId, data)
        }
      })

      term = terminal

      unsubs.push(
        () => {
          host.removeEventListener('focusin', onFocusIn)
          host.removeEventListener('focusout', onFocusOut)
          unregisterHost()
        },
        subscribe(`pty:data:${terminalId}`, (data) => {
          const chunk = data as string
          printed = (printed + chunk).slice(-PRINTED_LIMIT)
          terminal.write(chunk, () => {
            if (!destroyed) window.api.send('pty:ack', terminalId, chunk.length)
          })
        }),
        subscribe(`pty:exit:${terminalId}`, (exitCode) => {
          const code = typeof exitCode === 'number' ? exitCode : 0
          terminal.write('\r\n\x1b[90m[process exited]\x1b[0m\r\n')
          onExit(code, printed)
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

      terminal.write('Starting process...\r\n')
      if (destroyed || cancelled) return
      await invoke(
        'pty:createCommand',
        terminalId,
        command,
        args,
        terminal.cols,
        terminal.rows,
        idleTimeoutMs,
        environment
      )
      if (destroyed || cancelled) {
        await invoke('pty:destroy', terminalId)
        return
      }
      started = true
    } catch (initError) {
      if (!destroyed) {
        error = initError instanceof Error ? initError.message : 'The terminal failed to start.'
        onExit(1, error)
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
  data-floating-document
>
  <div class="h-full w-full" {@attach terminalAttachment}></div>
  {#if cancelled}
    <div class="absolute inset-0 flex items-center justify-center bg-app text-xs text-muted">
      Process stopped.
    </div>
  {:else if !started && !error}
    <div class="absolute inset-0 flex items-center justify-center bg-app text-xs text-muted">
      {startingLabel}
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
