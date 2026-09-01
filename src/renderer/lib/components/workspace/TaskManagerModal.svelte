<script lang="ts">
  import {
    BatteryCharging,
    BatteryMedium,
    Cpu,
    ExternalLink,
    MemoryStick,
    Plug,
    RefreshCw,
    SquareTerminal,
    Thermometer,
    Trash2,
    X
  } from '@lucide/svelte'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import Modal from '$lib/components/ui/Modal.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { getProjectIcon, loadProjectIcons } from '$lib/project-icons'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import type { Project, TaskManagerProcess, TaskManagerSnapshot } from '$shared/types'

  interface Props {
    open: boolean
    onClose: () => void
  }

  let { open, onClose }: Props = $props()

  let processes = $state<TaskManagerProcess[]>([])
  let power = $state<TaskManagerSnapshot['power']>({ source: 'ac', thermalState: 'unknown' })
  let sampledAt = $state(0)
  /** True only during the initial open-time snapshot or an explicit refresh. */
  let checking = $state(false)
  let error = $state('')
  let selected = new SvelteSet<number>()
  let ending = $state(false)
  let forceEndTargets = $state<readonly TaskManagerProcess[]>([])
  let forceEnding = $state(false)
  let projectIconsRequest: Promise<void> | null = null
  const projectsById = new SvelteMap<string, Project>()
  const projectIconUrls = new SvelteMap<string, string>()

  const activeProjectId = $derived(workspaceState.activeProject?.id ?? null)
  const selectedProcesses = $derived(processes.filter((process) => selected.has(process.pid)))

  async function load(): Promise<void> {
    if (checking) return
    checking = true
    error = ''
    try {
      const snapshot = await invoke('taskManager:list')
      processes = snapshot.processes
      power = snapshot.power
      sampledAt = snapshot.sampledAt
      pruneSelection()
      void ensureProjectIcons(snapshot.processes)
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Processes could not be loaded.'
    } finally {
      checking = false
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
    if (!open) return
    // Run outside the effect's synchronous tracking window. Calling load()
    // directly here would subscribe this effect to `checking`, causing every
    // completed request to immediately start another one.
    queueMicrotask(() => {
      if (open) void load()
    })
  })

  function processName(command: string): string {
    const executable = command.trim().split(/\s+/u)[0] ?? command
    return executable.split(/[\\/]/u).at(-1) || 'Process'
  }

  function harnessIdFor(command: string): string | undefined {
    const executable = command
      .trim()
      .split(/\s+/u)[0]
      ?.replace(/^['"]|['"]$/gu, '')
    const name = executable
      ?.split(/[\\/]/u)
      .at(-1)
      ?.replace(/\.exe$/iu, '')
    return getAgentIcon(name)?.id
  }

  function projectIconFor(process: TaskManagerProcess): string | undefined {
    return process.projectId ? projectIconUrls.get(process.projectId) : undefined
  }

  function handleProjectIconError(event: Event, projectId: string | null): void {
    const image = event.currentTarget
    if (!(image instanceof HTMLImageElement) || image.dataset.iconFallbackApplied) return
    image.dataset.iconFallbackApplied = 'true'
    const project = projectId ? projectsById.get(projectId) : undefined
    const fallback = project ? getProjectIcon(project, undefined) : null
    if (fallback) image.src = fallback
  }

  async function ensureProjectIcons(nextProcesses: readonly TaskManagerProcess[]): Promise<void> {
    if (projectIconsRequest) await projectIconsRequest
    const missingIds = new Set(
      nextProcesses.flatMap((process) =>
        process.projectId && !projectIconUrls.has(process.projectId) ? [process.projectId] : []
      )
    )
    if (missingIds.size === 0) return

    const request = (async () => {
      const projects = (await invoke('project:list')).filter((project) =>
        missingIds.has(project.id)
      )
      const storedIcons = await loadProjectIcons(projects)
      for (const project of projects) {
        projectsById.set(project.id, project)
        const iconUrl = getProjectIcon(project, storedIcons.get(project.id))
        if (iconUrl) projectIconUrls.set(project.id, iconUrl)
      }
    })()
    projectIconsRequest = request
    try {
      await request
    } catch {
      // Project icon loading is best-effort; the terminal fallback remains.
    } finally {
      if (projectIconsRequest === request) projectIconsRequest = null
    }
  }

  function formatDuration(startedAt: number): string {
    const seconds = Math.max(0, Math.floor((sampledAt - startedAt) / 1000))
    const hours = Math.floor(seconds / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60
    if (hours > 0) return `${hours}h ${minutes}m`
    if (minutes > 0) return `${minutes}m ${secs}s`
    return `${secs}s`
  }

  function formatMemory(bytes: number | null): string {
    if (bytes === null) return 'Unavailable'
    const mebibytes = bytes / 1024 / 1024
    if (mebibytes < 1024) return `${mebibytes.toFixed(mebibytes < 10 ? 1 : 0)} MB`
    return `${(mebibytes / 1024).toFixed(1)} GB`
  }

  function formatCpu(percent: number | null): string {
    if (percent === null) return 'Unavailable'
    return `${percent.toFixed(percent < 10 ? 1 : 0)}%`
  }

  function thermalLabel(): string {
    const state = power.thermalState
    return `${state.slice(0, 1).toUpperCase()}${state.slice(1)} thermal pressure`
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

<Modal {open} title="Task Manager" {onClose} size="xl" fill contentClass="p-0">
  <div class="flex h-full flex-col overflow-hidden">
    {#if error}
      <div class="shrink-0 border-b border-border px-5 py-2" role="alert">
        <p class="truncate text-xs text-danger">{error}</p>
      </div>
    {/if}

    {#if !checking}
      <div
        class="flex min-h-9 shrink-0 items-center gap-3 border-b border-border bg-raised px-5 text-[10px] text-muted tabular-nums"
      >
        {#if power.thermalState !== 'unknown' && power.thermalState !== 'nominal'}
          <span
            class="inline-flex items-center gap-1.5 text-danger"
            title="Current macOS thermal pressure"
          >
            <Thermometer size={13} />
            {thermalLabel()}
          </span>
        {/if}
        <span class="ml-auto text-dimmed">Updates only when opened or refreshed</span>
      </div>
    {/if}

    <div class="min-h-0 flex-1 overflow-y-auto">
      {#if checking}
        <div class="flex h-full flex-col items-center justify-center gap-3" aria-live="polite">
          <span
            class="task-manager-spinner h-5 w-5 shrink-0 rounded-full border-2 border-transparent"
            style="border-top-color: var(--color-primary); border-right-color: var(--color-primary);"
            role="status"
            aria-label="Checking running processes"
          ></span>
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
            {@const harnessId = harnessIdFor(process.command)}
            {@const projectIcon = projectIconFor(process)}
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
                {#if harnessId}
                  <AgentIcon agentId={harnessId} size={16} />
                {:else if projectIcon}
                  <img
                    src={projectIcon}
                    alt=""
                    class="h-4 w-4 rounded-sm object-contain grayscale"
                    onerror={(event) => handleProjectIconError(event, process.projectId)}
                  />
                {:else}
                  <SquareTerminal size={15} />
                {/if}
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
                  <span
                    class="inline-flex items-center gap-1 text-muted"
                    title={process.resourceScope === 'tree'
                      ? 'CPU used by this process and its descendants'
                      : 'CPU used by this process'}
                  >
                    <Cpu size={11} />
                    {formatCpu(process.cpuPercent)}
                  </span>
                  <span
                    class="inline-flex items-center gap-1 text-muted"
                    title={process.resourceScope === 'tree'
                      ? 'Memory used by this process and its descendants'
                      : 'Memory used by this process'}
                  >
                    <MemoryStick size={11} />
                    {formatMemory(process.memoryBytes)}
                  </span>
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
      <div class="flex min-w-0 flex-1 items-center gap-2">
        {#if power.source === 'battery'}
          <BatteryMedium
            size={14}
            class="shrink-0 text-muted"
            title="On battery"
            aria-label="On battery"
          />
        {:else}
          <BatteryCharging
            size={14}
            class="shrink-0 text-success"
            title="Plugged in"
            aria-label="Plugged in"
          />
        {/if}
        <p class="min-w-0 truncate text-xs text-dimmed tabular-nums">
          {#if selected.size > 0}
            {selected.size} of {processes.length} selected
          {:else}
            {processes.length} running
          {/if}
        </p>
      </div>
      <div class="flex shrink-0 items-center gap-1.5">
        <button
          type="button"
          class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 text-xs font-medium text-muted transition-[width] hover:bg-overlay hover:text-foreground disabled:opacity-50"
          disabled={checking}
          title="Refresh running processes"
          aria-label="Refresh running processes"
          onclick={() => void load()}
        >
          {#if checking}
            <span
              class="task-manager-spinner h-3.5 w-3.5 shrink-0 rounded-full border-2 border-transparent"
              style="border-top-color: currentColor; border-right-color: currentColor;"
              aria-hidden="true"
            ></span>
            Refresh
          {:else}
            <RefreshCw size={13} />
            Refresh
          {/if}
        </button>
        {#if selected.size > 0}
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border bg-elevated px-2.5 text-xs font-medium text-muted transition-colors hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
            disabled={ending || forceEnding}
            title="Gracefully stop the selected processes"
            onclick={() => void endSelected()}
          >
            {#if ending}
              <span
                class="task-manager-spinner h-3.5 w-3.5 shrink-0 rounded-full border-2 border-transparent"
                style="border-top-color: currentColor; border-right-color: currentColor;"
                aria-hidden="true"
              ></span>
            {:else}
              <X size={14} />
            {/if}
            End
          </button>
          <button
            type="button"
            class="inline-flex h-8 items-center gap-1.5 rounded-lg bg-danger px-2.5 text-xs font-semibold text-on-primary transition-colors hover:bg-danger/90 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={ending || forceEnding}
            title="Force kill the selected processes"
            onclick={requestForceEnd}
          >
            <Trash2 size={14} />
            Force end
          </button>
        {/if}
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
        <span
          class="task-manager-spinner h-3.5 w-3.5 shrink-0 rounded-full border-2 border-transparent"
          style="border-top-color: currentColor; border-right-color: currentColor;"
          aria-hidden="true"
        ></span>
      {:else}
        <Trash2 size={14} />
      {/if}
      Force end
    </button>
  {/snippet}
</Modal>

<style>
  .task-manager-spinner {
    animation: task-manager-spin 650ms linear infinite;
  }

  @keyframes task-manager-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
