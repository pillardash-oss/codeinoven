<script lang="ts">
  import { ExternalLink, Loader2, Plug, SquareTerminal, Trash2, X } from '@lucide/svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
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
  let loading = $state(false)
  let error = $state('')
  let stopping = new SvelteSet<number>()
  let resolving = new SvelteSet<number>()
  let forceKillTarget = $state<TaskManagerProcess | null>(null)
  let forceKilling = $state(false)

  const activeProjectId = $derived(workspaceState.activeProject?.id ?? null)

  async function load(): Promise<void> {
    if (loading) return
    loading = true
    error = ''
    try {
      processes = await invoke('taskManager:list')
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Processes could not be loaded.'
    } finally {
      loading = false
    }
  }

  $effect(() => {
    if (open) void load()
  })

  $effect(() => {
    if (!open) return
    return subscribe('taskManager:processesChanged', () => {
      void load()
    })
  })

  // Keep durations ticking while the modal is open; mutating `now` re-renders
  // the list without touching the process registry.
  let now = $state(0)
  $effect(() => {
    if (!open) return
    now = Date.now()
    const timer = setInterval(() => {
      now = Date.now()
    }, 1_000)
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
    if (resolving.has(process.pid) || process.ports.length === 0) return
    resolving.add(process.pid)
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
    } finally {
      resolving.delete(process.pid)
    }
  }

  async function openInTerminal(process: TaskManagerProcess): Promise<void> {
    if (resolving.has(process.pid)) return
    resolving.add(process.pid)
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
    } finally {
      resolving.delete(process.pid)
    }
  }

  async function killProcess(process: TaskManagerProcess, force: boolean): Promise<void> {
    if (stopping.has(process.pid)) return
    stopping.add(process.pid)
    error = ''
    try {
      await invoke('taskManager:killProcess', process.pid, force)
    } catch (killError) {
      error =
        killError instanceof Error
          ? killError.message
          : `Process ${process.pid} could not be stopped.`
    } finally {
      stopping.delete(process.pid)
      void load()
    }
  }

  async function confirmForceKill(): Promise<void> {
    const process = forceKillTarget
    if (!process || forceKilling) return
    forceKilling = true
    try {
      await killProcess(process, true)
      forceKillTarget = null
    } finally {
      forceKilling = false
    }
  }
</script>

<Modal {open} title="Task Manager" {onClose} size="xl" contentClass="overflow-y-auto p-0">
  <div class="flex items-center gap-2 border-b px-5 py-3">
    <button
      type="button"
      class="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50"
      disabled={loading}
      title="Refresh running processes"
      onclick={() => void load()}
    >
      {#if loading}
        <Loader2 size={13} class="animate-spin" />
      {:else}
        <Plug size={13} />
      {/if}
      Refresh
    </button>
    {#if error}
      <p class="min-w-0 flex-1 truncate text-xs text-danger" role="alert">{error}</p>
    {:else if processes.length > 0}
      <p class="ml-auto text-xs text-dimmed tabular-nums">
        {processes.length} process{processes.length !== 1 ? 'es' : ''}
      </p>
    {/if}
  </div>

  {#if loading && processes.length === 0}
    <div class="flex h-48 items-center justify-center">
      <p class="text-xs text-dimmed">Checking running processes…</p>
    </div>
  {:else if processes.length === 0}
    <div class="flex h-48 items-center justify-center px-8 text-center">
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
        <li class="px-5 py-3 transition-colors hover:bg-elevated">
          <div class="flex items-start gap-3">
            <span
              class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-primary"
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
                disabled={process.ports.length === 0 || resolving.has(process.pid)}
                title={process.ports.length > 0 ? 'Open in in-app browser' : 'No port detected'}
                aria-label={`Open ${processName(process.command)} in the in-app browser`}
                onclick={() => void openInBrowser(process)}
              >
                {#if resolving.has(process.pid)}
                  <Loader2 size={13} class="animate-spin" />
                {:else}
                  <ExternalLink size={13} />
                {/if}
              </button>
              <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-40"
                disabled={resolving.has(process.pid)}
                title="Open path in in-app terminal"
                aria-label={`Open ${processName(process.command)} path in the in-app terminal`}
                onclick={() => void openInTerminal(process)}
              >
                <SquareTerminal size={13} />
              </button>
              <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-danger disabled:opacity-40"
                disabled={stopping.has(process.pid)}
                title="Stop gracefully"
                aria-label={`Stop ${processName(process.command)} gracefully`}
                onclick={() => void killProcess(process, false)}
              >
                {#if stopping.has(process.pid)}
                  <Loader2 size={13} class="animate-spin" />
                {:else}
                  <X size={13} />
                {/if}
              </button>
              <button
                type="button"
                class="flex h-7 w-7 items-center justify-center rounded-lg text-muted transition-colors hover:bg-overlay hover:text-danger disabled:opacity-40"
                disabled={stopping.has(process.pid)}
                title="Force kill"
                aria-label={`Force kill ${processName(process.command)}`}
                onclick={() => (forceKillTarget = process)}
              >
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</Modal>

<Modal
  open={forceKillTarget !== null}
  title="Force kill process?"
  onClose={() => {
    if (!forceKilling) forceKillTarget = null
  }}
  closeOnBackdrop={!forceKilling}
>
  <div class="space-y-4">
    <p class="text-sm leading-relaxed text-muted">
      Force-kill
      <span class="font-medium text-foreground"
        >{forceKillTarget ? processName(forceKillTarget.command) : ''}</span
      >
      (PID {forceKillTarget?.pid})? This immediately terminates the process without allowing it to
      clean up, and may lose unsaved work or corrupt its output.
    </p>
  </div>
  {#snippet footer()}
    <button
      type="button"
      class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elevated px-3 text-sm font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:opacity-50"
      disabled={forceKilling}
      title="Cancel"
      onclick={() => (forceKillTarget = null)}
    >
      Cancel
    </button>
    <button
      type="button"
      data-modal-primary
      class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-3 text-sm font-semibold text-on-primary transition-colors hover:bg-danger/90 disabled:opacity-50"
      disabled={forceKilling}
      title="Force kill the process"
      onclick={() => void confirmForceKill()}
    >
      {#if forceKilling}
        <Loader2 size={14} class="animate-spin" />
      {:else}
        <Trash2 size={14} />
      {/if}
      Force kill
    </button>
  {/snippet}
</Modal>
