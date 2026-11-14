<script lang="ts">
  import { loadTerminalFontFamily } from '$lib/app-typography'
  import type { Terminal } from 'ghostty-web'
  import { subscribe } from '$lib/ipc.svelte'
  import { registerTerminalHost } from '$lib/terminal/host-registry'
  import { loadGhostty, loadGhosttyWeb } from '$lib/terminal/runtime'
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
  let failure = $state('')

  /**
   * A real terminal, because a server's output is a terminal's job.
   *
   * A model download redraws one line with carriage returns, colours its own
   * failures and moves the cursor around; a flat text block shows all of that as
   * a scroll of near-identical lines. The engine writes to a PTY the main process
   * owns, and its log file is followed onto the same channel when the app did not
   * start it, so this surface only ever reads: it never writes to the process and
   * never forwards a resize the engine did not ask for.
   *
   * `history` and `emptyLabel` are read only after the first await. A server that
   * is downloading redraws its bar many times a second, and this card's log lines
   * change with it; reading that prop while the attachment runs would tie the
   * attachment to it and rebuild the emulator on every redraw, which is what made
   * the log flicker and then go blank.
   */
  function attachLog(node: HTMLDivElement): () => void {
    let disposed = false
    let term: Terminal | undefined
    const unsubs: Array<() => void> = []
    /** Output that arrives while the terminal runtime loads. */
    const buffered: string[] = []
    let streaming = false

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
        const ghostty = await loadGhostty()
        if (disposed) return
        const ghosttyWeb = await loadGhosttyWeb()
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
        // Past the first await the props are read outside any reactive context,
        // so the folded history only ever seeds the view.
        if (history.length > 0) write(`${history.join('\r\n')}\r\n`)
        for (const chunk of buffered.splice(0)) write(chunk)
      } catch (error) {
        if (disposed) return
        failure = error instanceof Error ? error.message : 'The log terminal could not start.'
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
  {#if empty && !failure}
    <p
      class="pointer-events-none absolute inset-0 flex items-center justify-center px-3 text-center text-[0.6875rem] text-dimmed"
    >
      {emptyLabel}
    </p>
  {/if}
  {#if failure}
    <p
      class="absolute inset-0 flex items-center justify-center px-3 text-center text-[0.6875rem] text-danger"
    >
      {failure}
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
