<script lang="ts">
  import { ovenRootThread } from '$lib/oven-root-target'
  import type { Attachment } from 'svelte/attachments'
  import { DEFAULT_SCOPE_BUCKET_ID } from '$shared/types'
  import {
    terminalSessions,
    type TerminalSession,
    type TerminalSpawnBinding
  } from '$lib/terminal/sessions'

  interface Props {
    terminalId: string
    projectId: string
    threadId: string
    /** Scope bucket whose own shell this panel shows. */
    scopeBucketId?: string
    /** Project-relative folder the shell starts in, set when the terminal was
     *  opened at a specific path from the file tree. */
    directory?: string
  }

  let { terminalId, projectId, threadId, scopeBucketId, directory }: Props = $props()

  /**
   * Every scope owns its own shell. Qualifying the session id by the scope
   * bucket makes a scope switch mount that scope's own terminal instead of
   * leaving one shared shell in whichever worktree it was first started in.
   *
   * Each scoped session is spawned in its own scope and stays there for its
   * whole life, so navigating between scopes only swaps which live shell is on
   * screen. No shell is ever restarted or killed by navigation, and the script
   * a user started in one scope keeps running while they work in another.
   */
  let scopeKey = $derived(scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID)
  /**
   * A remote thread's shell belongs to its Oven as well as its scope, so the
   * session id names both. Switching threads or Ovens mounts that end's own
   * shell instead of leaving one session shared across unrelated hardware.
   */
  let scopedTerminalId = $derived.by(() => {
    const ovenThread = ovenRootThread(projectId)
    const ovenKey = ovenThread ? `${ovenThread.id}:${ovenThread.settings?.ovenId ?? ''}` : 'local'
    return `${terminalId}::${scopeKey}::${ovenKey}`
  })

  /**
   * One spawn binding per scoped session. A thread switch retargets only the
   * binding of the scope currently on screen, so it can never send another
   * scope's shell somewhere else on its next respawn. Plain (non-reactive)
   * map: it is read at respawn time, never rendered.
   */
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const scopeBindings = new Map<string, TerminalSpawnBinding>()

  function bindingFor(
    scopedId: string,
    scope: string,
    thread: string,
    startingDirectory?: string
  ): TerminalSpawnBinding {
    const existing = scopeBindings.get(scopedId)
    if (existing) {
      existing.scopeBucketId = scope
      existing.threadId = thread
      existing.directory = startingDirectory
      return existing
    }
    const binding: TerminalSpawnBinding = {
      threadId: thread,
      scopeBucketId: scope,
      directory: startingDirectory
    }
    scopeBindings.set(scopedId, binding)
    return binding
  }

  let terminalError: string | undefined = $state(undefined)
  let loading = $state(true)
  let retrySequence = $state(0)
  /** Whether the panel has attached before: the first attach counts as a
   *  user-initiated open, later attaches do not. */
  let firstAttach = true
  let lastRetrySequence = 0

  function retry(): void {
    retrySequence += 1
  }

  function attachTerminal(
    currentScopedId: string,
    currentProjectId: string,
    currentScopeKey: string,
    currentThreadId: string,
    currentDirectory: string | undefined,
    retry: number
  ): Attachment<HTMLDivElement> {
    // Focus only when the attach is user-initiated: the first mount (the user
    // opened or selected the terminal tab) or an explicit retry. The session
    // layer also drops focus requests inside the thread-switch guard window.
    const isRetry = retry !== lastRetrySequence
    const focus = firstAttach || isRetry
    firstAttach = false
    lastRetrySequence = retry
    const binding = bindingFor(currentScopedId, currentScopeKey, currentThreadId, currentDirectory)
    return (container) => {
      // A thread switch inside one scope re-runs this attachment with the very
      // same scoped session already in place. Leave it completely untouched:
      // no refit, no repaint of a canvas whose shell never moved. Only refresh
      // its respawn binding so process tracking follows the open thread.
      const live = terminalSessions.getSession(currentScopedId)
      if (!isRetry && live?.ptySpawned && live.host.parentElement === container) {
        live.binding = binding
        live.threadId = currentThreadId
        live.scopeBucketId = currentScopeKey
        live.directory = currentDirectory ?? null
        return
      }
      let cancelled = false
      loading = true
      terminalError = undefined

      void terminalSessions
        .getOrCreate(currentScopedId)
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
  <div tabindex="-1" class="terminal-wrap relative min-h-0 flex-1 overflow-hidden">
    <div
      class="h-full w-full overflow-hidden py-1 pl-2"
      {@attach attachTerminal(
        scopedTerminalId,
        projectId,
        scopeKey,
        threadId,
        directory,
        retrySequence
      )}
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
