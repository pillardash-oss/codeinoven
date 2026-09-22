<script lang="ts">
  import type { Attachment } from 'svelte/attachments'
  import { terminalSessions, type TerminalSession } from '$lib/terminal/sessions'

  interface Props {
    terminalId: string
    projectId: string
    threadId: string
    script: string
    variables: Record<string, string>
    scopeBucketId?: string
    /** True while the run should be executing. A finished or stopped run must
     *  never respawn its script just because its terminal re-attached. */
    live: boolean
  }

  let { terminalId, projectId, threadId, script, variables, scopeBucketId, live }: Props = $props()
  let error = $state<string | null>(null)

  const attachTerminal: Attachment<HTMLDivElement> = (container) => {
    // No focus request: action terminals must never pull keyboard focus from
    // the chat composer. Opening the Actions panel (with an expanded run) or
    // starting a run only shows the terminal; a user who wants to interact
    // with it clicks on it.
    let cancelled = false
    void terminalSessions.getOrCreateAction(terminalId).then(async (session: TerminalSession) => {
      if (cancelled) return
      try {
        await terminalSessions.attachAction(
          session,
          container,
          projectId,
          threadId,
          script,
          variables,
          scopeBucketId,
          live
        )
      } catch (reason) {
        if (!cancelled) error = reason instanceof Error ? reason.message : String(reason)
      }
    })
    return () => {
      cancelled = true
    }
  }
</script>

<div class="relative h-full min-h-32 overflow-x-auto overflow-y-hidden bg-terminal-background">
  <div class="h-full min-h-32 w-full py-1 pl-2" {@attach attachTerminal}></div>
  {#if error}
    <div
      class="absolute inset-0 flex items-center justify-center bg-app p-4 text-center text-xs text-danger"
    >
      {error}
    </div>
  {/if}
</div>

<style>
  div :global(.terminal-host) {
    height: 100%;
    /* Action terminals run a fixed wide grid (ACTION_COLS); the host grows to
       the canvas so the scrollable pane reveals long lines instead of clipping
       them. */
    width: max-content;
    min-width: calc(100% + 15px);
    overflow: hidden;
    outline: none;
    padding: 4px 0;
  }
  div :global(.terminal-host textarea) {
    caret-color: transparent;
  }
</style>
