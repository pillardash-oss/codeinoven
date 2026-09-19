<script lang="ts">
  import type { Attachment } from 'svelte/attachments'
  import StalePanelNotice from '$lib/components/ui/StalePanelNotice.svelte'
  import {
    terminalSessions,
    terminalSpawnScopes,
    type TerminalSession,
    type TerminalSpawnBinding
  } from '$lib/terminal/sessions'

  interface Props {
    terminalId: string
    projectId: string
    threadId: string
    /** Scope bucket the shell must run in when it is next spawned. */
    scopeBucketId?: string
  }

  let { terminalId, projectId, threadId, scopeBucketId }: Props = $props()

  /**
   * Scope root the *live shell* was started in, from the session manager: the
   * panel's own `scopeBucketId` prop is what it would spawn in now. While the
   * two differ this panel is showing another thread's checkout, and the notice
   * below says so. Attaching (a panel toggle, a dock move, fullscreen) restarts
   * the shell in the prop's scope, which clears it.
   */
  let spawnedScope = $derived(terminalSpawnScopes.get(terminalId) ?? null)
  let scopeStale = $derived(spawnedScope !== null && spawnedScope !== (scopeBucketId ?? null))

  let terminalError: string | undefined = $state(undefined)
  let loading = $state(true)
  let retrySequence = $state(0)
  /** Whether the panel has attached before: the first attach counts as a
   *  user-initiated open, later attaches do not. */
  let firstAttach = true
  let lastRetrySequence = 0

  /** Where a respawned shell must start. Held in a plain (non-reactive) object
   *  so the attachment below never depends on it: this panel is project-scoped,
   *  so a thread switch may only retarget the *next* respawn. Re-running the
   *  attachment instead would refit the grid and repaint the canvas on every
   *  switch, for a session that never went anywhere. */
  // svelte-ignore state_referenced_locally
  const spawnTarget: TerminalSpawnBinding = { threadId, scopeBucketId }

  $effect(() => {
    spawnTarget.threadId = threadId
    spawnTarget.scopeBucketId = scopeBucketId
  })

  function retry(): void {
    retrySequence += 1
  }

  function attachTerminal(
    currentTerminalId: string,
    currentProjectId: string,
    binding: TerminalSpawnBinding,
    retry: number
  ): Attachment<HTMLDivElement> {
    // Focus only when the attach is user-initiated: the first mount (the user
    // opened or selected the terminal tab) or an explicit retry. The session
    // layer also drops focus requests inside the thread-switch guard window.
    const focus = firstAttach || retry !== lastRetrySequence
    firstAttach = false
    lastRetrySequence = retry
    return (container) => {
      let cancelled = false
      loading = true
      terminalError = undefined

      void terminalSessions
        .getOrCreate(currentTerminalId)
        .then(async (session: TerminalSession) => {
          if (cancelled) return
          await terminalSessions.attach(session, container, currentProjectId, binding, { focus })
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

<div class="flex h-full w-full flex-col overflow-hidden bg-terminal-background">
  <StalePanelNotice stale={scopeStale} />
  <div tabindex="-1" class="terminal-wrap relative min-h-0 flex-1 overflow-hidden">
    <div
      class="h-full w-full overflow-hidden py-1 pl-2"
      {@attach attachTerminal(terminalId, projectId, spawnTarget, retrySequence)}
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
</div>

<style>
  .terminal-wrap :global(.terminal-host) {
    height: 100%;
    /* FitAddon reserves 15px for a DOM scrollbar, but ghostty-web paints its
       scrollbar inside the canvas. Give that reservation back to the fitter so
       the final terminal column reaches the panel edge instead of leaving a
       permanent gutter. The wrapper clips the intentionally oversized host. */
    width: calc(100% + 15px);
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
