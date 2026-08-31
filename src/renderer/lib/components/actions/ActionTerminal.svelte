<script lang="ts">
  import type { Attachment } from 'svelte/attachments'
  import { terminalSessions, type TerminalSession } from '$lib/terminal/sessions'

  interface Props {
    terminalId: string
    projectId: string
    script: string
    variables: Record<string, string>
  }

  let { terminalId, projectId, script, variables }: Props = $props()
  let error = $state<string | null>(null)

  const attachTerminal: Attachment<HTMLDivElement> = (container) => {
    let cancelled = false
    void terminalSessions.getOrCreateAction(terminalId).then(async (session: TerminalSession) => {
      if (cancelled) return
      try {
        await terminalSessions.attachAction(session, container, projectId, script, variables)
      } catch (reason) {
        if (!cancelled) error = reason instanceof Error ? reason.message : String(reason)
      }
    })
    return () => {
      cancelled = true
    }
  }
</script>

<div class="relative h-full min-h-32 overflow-hidden bg-terminal-background">
  <div class="h-full min-h-32 w-full overflow-hidden py-1 pl-2" {@attach attachTerminal}></div>
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
    width: calc(100% + 15px);
    overflow: hidden;
    outline: none;
    padding: 4px 0;
  }
  div :global(.terminal-host textarea) {
    caret-color: transparent;
  }
</style>
