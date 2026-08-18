<script lang="ts">
  import type { Attachment } from 'svelte/attachments'
  import { terminalSessions, type TerminalSession } from '$lib/terminal/sessions'

  interface Props {
    terminalId: string
    projectId: string
  }

  let { terminalId, projectId }: Props = $props()

  let terminalError: string | undefined = $state(undefined)
  let loading = $state(true)
  let retrySequence = $state(0)

  function retry(): void {
    retrySequence += 1
  }

  function attachTerminal(
    currentTerminalId: string,
    currentProjectId: string,
    retry: number
  ): Attachment<HTMLDivElement> {
    void retry
    return (container) => {
      let cancelled = false
      loading = true
      terminalError = undefined

      void terminalSessions
        .getOrCreate(currentTerminalId)
        .then(async (session: TerminalSession) => {
          if (cancelled) return
          await terminalSessions.attach(session, container, currentProjectId)
          if (!cancelled) loading = false
        })
        .catch((error: unknown) => {
          if (cancelled) return
          loading = false
          terminalError = error instanceof Error ? error.message : String(error)
        })

      // The terminal and PTY belong to the session manager, so detaching this
      // panel only cancels its pending UI work. Scrollback survives dock moves.
      return () => {
        cancelled = true
      }
    }
  }
</script>

<div
  tabindex="-1"
  class="terminal-wrap relative h-full w-full overflow-hidden bg-terminal-background"
>
  <div
    class="h-full w-full px-2 py-1"
    {@attach attachTerminal(terminalId, projectId, retrySequence)}
  ></div>
  {#if loading}
    <div class="absolute inset-0 flex items-center justify-center bg-app text-xs text-muted">
      Loading terminal…
    </div>
  {:else if terminalError}
    <div class="absolute inset-0 flex items-center justify-center bg-app p-6">
      <div class="max-w-md text-center">
        <p class="text-sm font-semibold text-foreground">Terminal could not start</p>
        <p class="mt-2 text-xs text-muted">{terminalError}</p>
        <button
          type="button"
          class="mt-4 h-8 border border-border-strong bg-elevated px-3 text-xs font-semibold text-foreground hover:bg-overlay"
          onclick={retry}
        >
          Retry
        </button>
      </div>
    </div>
  {/if}
</div>

<style>
  .terminal-wrap :global(.terminal-host) {
    height: 100%;
    width: 100%;
    overflow: hidden;
    outline: none;
    padding: 4px 0;
  }

  /* The terminal renders its own cursor on canvas. ghostty-web keeps a hidden
     native textarea for keyboard input positioned at the host's top-left; on
     focus it can flash a stray browser caret there. Suppress it so only the
     terminal's canvas cursor is ever visible, and keep the wrapper from ever
     becoming a caret/focus target itself. */
  .terminal-wrap :global(.terminal-host textarea) {
    caret-color: transparent;
  }
</style>
