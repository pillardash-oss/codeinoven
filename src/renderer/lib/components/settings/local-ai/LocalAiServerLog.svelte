<script lang="ts">
  import { loadTerminalFontFamily } from '$lib/app-typography'
  import type { Terminal } from 'ghostty-web'
  import { subscribe } from '$lib/ipc.svelte'
  import { registerTerminalHost } from '$lib/terminal/host-registry'
  import { loadGhosttyWeb } from '$lib/terminal/runtime'
  import { terminalThemeFromTokens } from '$lib/terminal/theme'
  import { localAiPtyId } from '$shared/llama-cpp'
  import type { Attachment } from 'svelte/attachments'

  interface Props {
    entryId: string
    /** Lines the card already folded, so a remount continues the same log
     *  instead of starting blank. */
    history: string[]
    /** Shown until the row prints its first byte. */
    emptyLabel: string
  }

  let { entryId, history, emptyLabel }: Props = $props()

  let empty = $state(true)

  /**
   * A real terminal, because a server's output is a terminal's job.
   *
   * A model download redraws one line with carriage returns, colours its own
   * failures and moves the cursor around; a flat text block shows all of that as
   * a scroll of near-identical lines. The engine writes to a PTY the main process
   * owns, and its log file is followed onto the same channel when the app did not
   * start it, so this surface only ever reads: it never writes to the process and
   * never forwards a resize the engine did not ask for.
   */
  function attachLog(node: HTMLDivElement): () => void {
    let disposed = false
    let term: Terminal | undefined
    const unsubs: Array<() => void> = []
    /** Output that arrives while the terminal runtime loads. */
    const buffered: string[] = []
    let streaming = false
    empty = history.length === 0

    const write = (data: string): void => {
      if (data.length === 0) return
      empty = false
      term?.write(data)
    }

    const start = async (): Promise<void> => {
      const terminalId = localAiPtyId(entryId)
      // Subscribe first: a fetch that is already redrawing its bar must not lose
      // the lines it printed while the emulator was still loading.
      unsubs.push(
        subscribe(`pty:data:${terminalId}`, (data) => {
          if (typeof data !== 'string') return
          if (streaming) write(data)
          else buffered.push(data)
        })
      )
      try {
        const ghosttyWeb = await loadGhosttyWeb()
        if (disposed) return
        const ghostty = await ghosttyWeb.Ghostty.load()
        if (disposed) return
        const fontFamily = await loadTerminalFontFamily()
        if (disposed) return
        const terminal = new ghosttyWeb.Terminal({
          ghostty,
          cursorBlink: false,
          fontSize: 12,
          fontFamily,
          scrollback: 2000,
          theme: terminalThemeFromTokens()
        })
        const fit = new ghosttyWeb.FitAddon()
        terminal.loadAddon(fit)
        terminal.open(node)
        fit.observeResize()
        fit.fit()
        term = terminal
        unsubs.push(
          () => fit.dispose(),
          registerTerminalHost(node, {
            term: terminal,
            // Reading a server's log never types into it.
            write: () => undefined
          })
        )
        streaming = true
        if (history.length > 0) write(`${history.join('\r\n')}\r\n`)
        for (const chunk of buffered.splice(0)) write(chunk)
      } catch {
        // A runtime that cannot load leaves the empty state in place; the row's
        // own notice already says what the server did.
      }
    }

    void start()
    return () => {
      disposed = true
      for (const unsubscribe of unsubs) unsubscribe()
      term?.dispose()
      term = undefined
    }
  }

  const terminalAttachment: Attachment<HTMLDivElement> = (node) => attachLog(node)
</script>

<div class="relative h-64 overflow-hidden border bg-raised">
  <div class="local-ai-log h-full w-full" {@attach terminalAttachment}></div>
  {#if empty}
    <p
      class="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center text-[0.6875rem] text-dimmed"
    >
      {emptyLabel}
    </p>
  {/if}
</div>

<style>
  .local-ai-log :global(.terminal-host) {
    height: 100%;
    width: 100%;
    overflow: hidden;
    padding: 6px 8px;
    outline: none;
  }

  .local-ai-log :global(.terminal-host textarea) {
    caret-color: transparent;
  }
</style>
