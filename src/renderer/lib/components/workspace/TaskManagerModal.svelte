<script lang="ts">
  import { ExternalLink, Loader2, Plug, RefreshCw, SquareTerminal, Trash2, X } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { SvelteSet } from 'svelte/reactivity'
  import type { TaskManagerProcess } from '$shared/types'

  interface Props {
    open: boolean
    onClose: () => void
  }

  let { open, onClose }: Props = $props()

  let processes = $state<TaskManagerProcess[]>([])
  /** True during a user-triggered refresh or the first load; drives the refresh
   *  spinner and the "Checking running processes…" state. Quiet 5s background
   *  polls do not set this so a populated modal never flashes a loading state. */
  let checking = $state(false)
  let error = $state('')
  let selected = new SvelteSet<number>()
  let ending = $state(false)
  let forceEndTargets = $state<readonly TaskManagerProcess[]>([])
  let forceEnding = $state(false)

  const activeProjectId = $derived(workspaceState.activeProject?.id ?? null)
  const selectedProcesses = $derived(processes.filter((process) => selected.has(process.pid)))

  async function load(): Promise<void> {
    if (checking) return
    checking = true
    error = ''
    try {
      processes = await invoke('taskManager:list')
      pruneSelection()
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Processes could not be loaded.'
    } finally {
      checking = false
    }
  }

  /** Silent refresh used by the 5s cadence: updates the list without toggling
   *  the spinner so a populated modal never flashes a loading state. */
  async function refreshQuietly(): Promise<void> {
    try {
      processes = await invoke('taskManager:list')
      pruneSelection()
    } catch {
      // Swallow background poll errors; the last good snapshot stays visible.
    }
  }

  /** Drop any selected pid that no longer exists after a refresh. */
  function pruneSelection(): void {
    const alive = new Set(processes.map((process) => process.pid))
    for (const pid of [...selected]) {
      if (!alive.has(pid)) selected.delete(pid)
    }
  }

  // Initial load on open.
  $effect(() => {
    if (open) void load()
  })

  // Keep the process list live: quiet reload every 5s and re-render durations
  // on the same cadence so the modal stays current without being noisy.
  let now = $state(0)
  $effect(() => {
    if (!open) return
    now = Date.now()
    const timer = setInterval(() => {
      now = Date.now()
      void refreshQuietly()
    }, 5_000)
    return () => clearInterval(timer)
  })

  function processName(command: string): string {
    const executable = command.trim().split(/\s+/u)[0] ?? command
    return executable.split(/[\\/]/u).at(-1) || 'Process'
  }

  function formatDuration(startedAt: number): string {
    const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${secs}s`
    return `${secs}s`
  }

  function shortPath(cwd: string | null, max = 44): string {
    if (!cwd) return '—'
    if (cwd.length <= max) return cwd
    const tail = cwd.slice(-Math.floor(max * 0.6))
    const head = cwd.slice(0, Math.floor(max * 0.4) - 1)
    return `${head}…${tail}`
  }

  function locationLabel(process: TaskManagerProcess): string {
    if (process.threadTitle && process.projectName) {
      return `${process.projectName} · ${process.threadTitle}`
    }
    if (process.projectName) return process.projectName
    return 'Shared server'
  }

  /**
   * Resolve the project/thread to open a browser or terminal in for a process.
   * Uses the process's owning thread when present and valid; otherwise falls
   * back to the first non-archived thread of the owning project, then to a new
   * thread. App-scoped processes (no owning project) fall back to the active
   * project or the first local project.
   */
  async function resolveTarget(
    process: TaskManagerProcess
  ): Promise<{ projectId: string; threadId: string } | null> {
    let projectId = process.projectId
    if (!projectId) {
      projectId = activeProjectId
    }
    if (!projectId) {
      const projects = await invoke('project:list')
      projectId =
        projects.find((project) => project.source === 'local')?.id ?? projects[0]?.id ?? null
    }
    if (!projectId) return null

    if (process.threadId) {
      const thread = await invoke('thread:get', projectId, process.threadId)
      if (thread && !thread.archived) return { projectId, threadId: thread.id }
    }
    const threads = await invoke('thread:list', projectId)
    const first = threads.find((thread) => !thread.archived)
    if (first) return { projectId, threadId: first.id }

    const created = await invoke('thread:create', {
      projectId,
      providerId: 'pi',
      title: 'Task'
    })
    return { projectId, threadId: created.id }
  }

  async function openInBrowser(process: TaskManagerProcess): Promise<void> {
    if (process.ports.length === 0) return
    error = ''
    try {
      const target = await resolveTarget(process)
      if (!target) {
        error = `No project available to open ${process.pid}.`
        return
      }
      const url = `http://localhost:${process.ports[0]}`
      contextSidebarState.openBrowserForContext(
        url,
        target.projectId,
        target.threadId,
        undefined,
        true
      )
    } catch (openError) {
      error = openError instanceof Error ? openError.message : 'Could not open the process.'
    }
  }

  async function openInTerminal(process: TaskManagerProcess): Promise<void> {
    error = ''
    try {
      const target = await resolveTarget(process)
      if (!target) {
        error = `No project available to open ${process.pid}.`
        return
      }
      contextSidebarState.openNewTerminal(target.projectId, target.threadId)
    } catch (openError) {
      error = openError instanceof Error ? openError.message : 'Could not open the terminal.'
    }
  }

  /** Gracefully end every currently selected process. */
  async function endSelected(): Promise<void> {
    const targets = selectedProcesses
    if (targets.length === 0 || ending) return
    ending = true
    error = ''
    try {
      await Promise.all(
        targets.map((process) => invoke('taskManager:killProcess', process.pid, false))
      )
      selected.clear()
      await load()
    } catch (killError) {
      error =
        killError instanceof Error
          ? killError.message
          : 'One or more processes could not be stopped.'
    } finally {
      ending = false
    }
  }

  /** Force-end every currently selected process (confirmation first). */
  function requestForceEnd(): void {
    if (selectedProcesses.length === 0) return
    forceEndTargets = selectedProcesses
  }

  async function confirmForceEnd(): Promise<void> {
    if (forceEndTargets.length === 0 || forceEnding) return
    forceEnding = true
    error = ''
    try {
      await Promise.all(
        forceEndTargets.map((process) => invoke('taskManager:killProcess', process.pid, true))
      )
      selected.clear()
      forceEndTargets = []
      await load()
    } catch (killError) {
      error =
        killError instanceof Error
          ? killError.message
          : 'One or more processes could not be killed.'
    } finally {
      forceEnding = false
    }
  }
</script>

<Modal {open} title="Task Manager" {onClose} size="xl" contentClass="h-[min(72vh,44rem)] p-0">
  <div class="flex h-full flex-col overflow-hidden">
    {#if error}
      <div class="shrink-0 border-b border-border px-5 py-2" role="alert">
        <p class="truncate text-xs text-danger">{error}</p>
      </div>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if checking}
        <div class="flex h-full flex-col items-center justify-center gap-3" aria-live="polite">
          <Loader2 size={22} class="animate-spin text-primary" />
          <p class="text-xs text-dimmed">Checking running processes…</p>
        </div>
      {:else if processes.length === 0}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <div class="max-w-64">
            <Plug size={20} class="mx-auto text-muted" />
            <p class="mt-3 text-sm font-semibold text-foreground">No running processes</p>
            <p class="mt-1 text-xs leading-relaxed text-dimmed">
              Processes started by the app will appear here while they are running.
            </p>
          </div>
        </div>
      {:else}
        <ul class="divide-y divide-border">
          {#each processes as process (process.pid)}
            <li
              class="flex items-start gap-3 px-5 py-3 transition-colors {selected.has(process.pid)
                ? 'bg-elevated'
                : 'hover:bg-elevated'}"
            >
              <Switch
                checked={selected.has(process.pid)}
                onchange={(value) => {
                  if (value) selected.add(process.pid)
                  else selected.delete(process.pid)
                }}
                aria-label={`Select ${processName(process.command)} (PID ${process.pid})`}
                title={`Select ${processName(process.command)}`}
                class="mt-1 shrink-0"
              />
              <span
                class="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-primary"
              >
                <SquareTerminal size={15} />
              </span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <p class="truncate text-sm font-semibold text-foreground">
                    {processName(process.command)}
                  </p>
                  {#if process.ports.length > 0}
                    <span
                      class="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary"
                    >
                      :{process.ports[0]}
                      {#if process.ports.length > 1}
                        <span class="text-dimmed">+{process.ports.length - 1}</span>
                      {/if}
                    </span>
                  {/if}
                  <span
                    class="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[10px] text-muted {process.scope ===
                    'app'
                      ? 'uppercase tracking-wide'
                      : ''}"
                  >
                    {process.scope === 'app' ? 'Shared' : 'Running'}
                  </span>
                </div>
                <p class="mt-1 truncate font-mono text-[10px] text-dimmed" title={process.command}>
                  {process.command}
                </p>
                <div
                  class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-dimmed tabular-nums"
                >
                  <span>PID {process.pid}</span>
                  <span>{formatDuration(process.startedAt)}</span>
                  <span class="min-w-0 truncate" title={process.cwd ?? undefined}>
                    {shortPath(process.cwd)}
                  </span>
                  <span class="shrink-0">{locationLabel(process)}</span>
                </div>
              </div>
              <div class="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={process.ports.length === 0}
                  title={process.ports.length > 0 ? 'Open in in-app browser' : 'No port detected'}
                  aria-label={`Open ${processName(process.command)} in the in-app browser`}
                  onclick={() => void openInBrowser(process)}
                >
                  <ExternalLink size={13} />
                </button>
                <button
                  type="button"
                  class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-foreground"
                  title="Open path in in-app terminal"
                  aria-label={`Open ${processName(process.command)} path in the in-app terminal`}
                  onclick={() => void openInTerminal(process)}
                >
                  <SquareTerminal size={13} />
                </button>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-4">
      <p class="min-w-0 flex-1 truncate text-xs text-dimmed tabular-nums">
        {#if selected.size > 0}
          {selected.size} of {processes.length} selected
        {:else}
          {processes.length} running
        {/if}
      </p>
      <div class="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50"
          disabled={checking}
          title="Refresh running processes"
          onclick={() => void load()}
        >
          {#if checking}
            <Loader2 size={14} class="animate-spin" />
          {:else}
            <RefreshCw size={14} />
          {/if}
          Refresh
        </button>
        <button
          type="button"
          class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
          disabled={selected.size === 0 || ending || forceEnding}
          title="Gracefully stop the selected processes"
          onclick={() => void endSelected()}
        >
          {#if ending}
            <Loader2 size={14} class="animate-spin" />
          {:else}
            <X size={14} />
          {/if}
          End
        </button>
        <button
          type="button"
          class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-2.5 text-xs font-semibold text-on-primary transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-40"
          disabled={selected.size === 0 || ending || forceEnding}
          title="Force kill the selected processes"
          onclick={requestForceEnd}
        >
          <Trash2 size={14} />
          Force end
        </button>
      </div>
    </div>
  {/snippet}
</Modal>

<Modal
  open={forceEndTargets.length > 0}
  title="Force end processes?"
  onClose={() => {
    if (!forceEnding) forceEndTargets = []
  }}
  closeOnBackdrop={!forceEnding}
>
  <div class="space-y-4">
    <p class="text-sm leading-relaxed text-muted">
      Force-end <span class="font-medium text-foreground">{forceEndTargets.length}</span> selected
      process{forceEndTargets.length !== 1 ? 'es' : ''}? This immediately terminates them without
      allowing them to clean up, and may lose unsaved work or corrupt their output.
    </p>
  </div>
  {#snippet footer()}
    <button
      type="button"
      class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elevated px-3 text-sm font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50"
      disabled={forceEnding}
      title="Cancel"
      onclick={() => (forceEndTargets = [])}
    >
      Cancel
    </button>
    <button
      type="button"
      data-modal-primary
      class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-sm font-semibold text-on-primary transition-colors hover:bg-danger/90 disabled:opacity-50"
      disabled={forceEnding}
      title="Force kill the selected processes"
      onclick={() => void confirmForceEnd()}
    >
      {#if forceEnding}
        <Loader2 size={14} class="animate-spin" />
      {:else}
        <Trash2 size={14} />
      {/if}
      Force end
    </button>
  {/snippet}
</Modal>
