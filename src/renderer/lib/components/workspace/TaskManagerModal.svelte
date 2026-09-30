<script lang="ts">
  import {
    ArrowDownUp,
    BatteryCharging,
    BatteryMedium,
    Cog,
    Cpu,
    Check,
    ChevronDown,
    GlobeCode,
    MemoryStick,
    MessagesSquare,
    Network,
    Plug,
    RefreshCw,
    Search,
    Server,
    SquareTerminal,
    Thermometer,
    Trash2,
    X
  } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { Attachment } from 'svelte/attachments'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import ConfirmDialog from '$lib/components/ui/ConfirmDialog.svelte'
  import Modal from '$lib/components/ui/Modal.svelte'
  import ProjectSwitch from '$lib/components/shared/ProjectSwitch.svelte'
  import Switch from '$lib/components/ui/Switch.svelte'
  import TaskManagerNode from './TaskManagerNode.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { getProjectIcon, loadProjectIcons } from '$lib/project-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import { generateInitialsIconSvg } from '$lib/project-svg-icons'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { formatDurationSeconds } from '$lib/format/duration'
  import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
  import { appQuitState } from '$lib/stores/app-quit.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { SvelteMap, SvelteSet } from 'svelte/reactivity'
  import type {
    TaskManagerProcess,
    TaskManagerService,
    TaskManagerServiceKind,
    TaskManagerSnapshot
  } from '$shared/types'
  import { APP_NAME } from '$shared/brand'
  import { posixBasename } from '$shared/paths'

  interface Props {
    open: boolean
    onClose: () => void
  }

  type TaskSortMode = 'memory' | 'cpu' | 'name'

  const SORT_MODE_LABELS: Record<TaskSortMode, string> = {
    memory: 'RAM',
    cpu: 'CPU',
    name: 'Name'
  }

  const SORT_MODE_DESCRIPTIONS: Record<TaskSortMode, string> = {
    memory: 'Sort by RAM usage, highest first',
    cpu: 'Sort by CPU usage, highest first',
    name: 'Sort by name, alphabetically'
  }

  const SORT_MODES: readonly TaskSortMode[] = ['memory', 'cpu', 'name']

  /** Identity of one foldable owner node: a project, or a thread inside one. */
  interface OwnerIdentity {
    /** Stable tree key: `project:<id>` or `thread:<id>`. */
    id: string
    kind: 'project' | 'thread'
    label: string
    /** Project a thread node belongs to; null for a project node. */
    projectName: string | null
    projectId: string | null
  }

  /** One foldable owner node and everything the app runs for it. */
  interface OwnerGroup extends OwnerIdentity {
    processes: TaskManagerProcess[]
    services: TaskManagerService[]
    pids: number[]
    memoryBytes: number
    cpuPercent: number
  }

  let { open, onClose }: Props = $props()

  let processes = $state<TaskManagerProcess[]>([])
  let services = $state<TaskManagerService[]>([])
  let power = $state<TaskManagerSnapshot['power']>({ source: 'ac', thermalState: 'unknown' })
  let sampledAt = $state(0)
  /** True only during the initial open-time snapshot or an explicit refresh. */
  let checking = $state(false)
  /** True only while a background 5s poll is in flight. */
  let polling = $state(false)
  let error = $state('')
  /** Sort mode for the list; memory (highest first) is the default. */
  let sortMode = $state<TaskSortMode>('memory')
  /** Project filter for project-owned processes; null shows everything. */
  let filterProjectId = $state<string | null>(null)
  /** True while the toolbar holds the search field instead of the stats row. */
  let searchOpen = $state(false)
  /** Raw query text; matching is case-insensitive and token by token. */
  let searchQuery = $state('')
  let selected = new SvelteSet<number>()
  /** Tree nodes folded away, keyed by node id (`app`, `project:<id>`, `thread:<id>`). */
  let collapsed = new SvelteSet<string>()
  let ending = $state(false)
  let forceEndTargets = $state<readonly TaskManagerProcess[]>([])
  let forceEnding = $state(false)
  /** Service awaiting stop confirmation; null when no dialog is open. */
  let stopTarget = $state<TaskManagerService | null>(null)
  let stopping = $state(false)
  let projectIconsRequest: Promise<void> | null = null
  const projectColors = new SvelteMap<string, string>()
  const projectIconUrls = new SvelteMap<string, string>()

  const selectedProcesses = $derived(processes.filter((process) => selected.has(process.pid)))

  /**
   * App-scoped processes (ASR, LAMA server, …) have no owning project, so a
   * project filter can never exclude them; they always stay visible.
   */
  const visibleProcesses = $derived.by(() => {
    const filtered = filterProjectId
      ? processes.filter((process) => !process.projectId || process.projectId === filterProjectId)
      : processes
    return filtered.toSorted(compareFor(sortMode))
  })

  /**
   * App-owned runtimes that have no tracked OS process row, so they would
   * otherwise be absent: loopback servers and the MCP servers a turn started.
   * App-scoped services carry no project, so a project filter never hides them.
   */
  const visibleServices = $derived.by(() => {
    const filtered = filterProjectId
      ? services.filter((service) => !service.projectId || service.projectId === filterProjectId)
      : services
    return filtered.toSorted((left, right) =>
      left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
    )
  })

  /** Query tokens. Every token must appear in one of a row's searchable fields,
   *  so "adb milogs" narrows to an adb row whose path or owner says milogs. */
  const searchTokens = $derived(
    searchQuery
      .trim()
      .toLowerCase()
      .split(/\s+/u)
      .filter((token) => token.length > 0)
  )

  /**
   * The visible rows narrowed by the search. Search composes with the filters
   * above it instead of replacing them: an active project filter and a query
   * both apply, so the field can only ever hide rows the current view already
   * shows. Nothing outside the rendered tree reads these lists.
   */
  const searchedProcesses = $derived.by(() => {
    const tokens = searchTokens
    if (tokens.length === 0) return visibleProcesses
    return visibleProcesses.filter((process) => matchesTokens(tokens, processSearchText(process)))
  })

  const searchedServices = $derived.by(() => {
    const tokens = searchTokens
    if (tokens.length === 0) return visibleServices
    return visibleServices.filter((service) => matchesTokens(tokens, serviceSearchText(service)))
  })

  /** Everything a process row can be found by: app name, pid, ports, path, and
   *  the project and thread it belongs to. */
  function processSearchText(process: TaskManagerProcess): string {
    return [
      processName(process.command),
      String(process.pid),
      process.ports.join(' '),
      process.cwd ?? '',
      process.projectName ?? '',
      process.threadTitle ?? ''
    ]
      .join('\n')
      .toLowerCase()
  }

  /** What a service row can be found by: name, pid, port, detail (its URL,
   *  command, or folder), and the project and thread it belongs to. */
  function serviceSearchText(service: TaskManagerService): string {
    return [
      service.name,
      service.pid !== null ? String(service.pid) : '',
      service.port !== null ? String(service.port) : '',
      service.detail ?? '',
      service.projectName ?? '',
      service.threadTitle ?? ''
    ]
      .join('\n')
      .toLowerCase()
  }

  function matchesTokens(tokens: readonly string[], text: string): boolean {
    return tokens.every((token) => text.includes(token))
  }

  /**
   * Aggregate resource use for a set of rows. A harness root already reports the
   * totals for its whole tree while its descendants are also listed as their own
   * rows, so summing every row would count them twice. Only the top-most rows
   * (whose parent is not itself in the set) are summed, counting each once.
   */
  function aggregateResources(rows: readonly TaskManagerProcess[]): {
    memoryBytes: number
    cpuPercent: number
  } {
    const pids = new Set(rows.map((row) => row.pid))
    let memoryBytes = 0
    let cpuPercent = 0
    for (const row of rows) {
      if (pids.has(row.parentPid)) continue
      memoryBytes += row.memoryBytes ?? 0
      cpuPercent += row.cpuPercent ?? 0
    }
    return { memoryBytes, cpuPercent }
  }

  /**
   * The owner node a runtime belongs to: its thread when it has one (a routine
   * run), otherwise its project. App-scoped runtimes have neither and return
   * null, so they list under the app node instead.
   */
  function ownerOf(
    projectId: string | null,
    threadId: string | null,
    threadTitle: string | null | undefined,
    projectName: string | null | undefined
  ): OwnerIdentity | null {
    if (!projectId && !threadId) return null
    const isThread = Boolean(threadId)
    return {
      id: isThread ? `thread:${threadId}` : `project:${projectId}`,
      kind: isThread ? 'thread' : 'project',
      label: isThread ? (threadTitle ?? 'Untitled thread') : (projectName ?? 'Untitled project'),
      projectName: projectName ?? null,
      projectId: projectId ?? null
    }
  }

  /** Fetch or create the node for one owner, so all of its runtimes share it. */
  function ensureOwnerGroup(
    groups: SvelteMap<string, OwnerGroup>,
    owner: OwnerIdentity
  ): OwnerGroup {
    const existing = groups.get(owner.id)
    if (existing) return existing
    const group: OwnerGroup = {
      ...owner,
      processes: [],
      services: [],
      pids: [],
      memoryBytes: 0,
      cpuPercent: 0
    }
    groups.set(owner.id, group)
    return group
  }

  /**
   * Visible runtimes grouped by their owner, after the search has narrowed
   * them. Each node holds both the processes and the services that owner
   * started, so a project's whole footprint reads as one branch. App-scoped
   * runtimes have no owner and are excluded here.
   */
  const ownerGroups = $derived.by(() => {
    const groups = new SvelteMap<string, OwnerGroup>()
    for (const process of searchedProcesses) {
      const owner = ownerOf(
        process.projectId,
        process.threadId,
        process.threadTitle,
        process.projectName
      )
      if (!owner) continue
      ensureOwnerGroup(groups, owner).processes.push(process)
    }
    for (const service of searchedServices) {
      const owner = ownerOf(
        service.projectId,
        service.threadId,
        service.threadTitle,
        service.projectName
      )
      if (!owner) continue
      ensureOwnerGroup(groups, owner).services.push(service)
    }
    const list = [...groups.values()]
    for (const group of list) {
      group.pids = group.processes.map((process) => process.pid)
      const totals = aggregateResources(group.processes)
      group.memoryBytes = totals.memoryBytes
      group.cpuPercent = totals.cpuPercent
    }
    return list.toSorted(compareGroups)
  })

  /** App-scoped processes the app owns directly, with no project or thread. */
  const appScopedProcesses = $derived(
    searchedProcesses.filter((process) => !process.projectId && !process.threadId)
  )

  /** App-owned services that belong to no project or thread (the config part). */
  const appOwnedServices = $derived(
    searchedServices.filter((service) => !service.projectId && !service.threadId)
  )

  const appOwnedPids = $derived(appScopedProcesses.map((process) => process.pid))

  const appOwnedTotals = $derived(aggregateResources(appScopedProcesses))

  function compareGroups(a: OwnerGroup, b: OwnerGroup): number {
    if (sortMode === 'name') {
      return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
    }
    if (sortMode === 'cpu') return b.cpuPercent - a.cpuPercent
    return b.memoryBytes - a.memoryBytes
  }

  function isCollapsed(key: string): boolean {
    return collapsed.has(key)
  }

  function toggleCollapsed(key: string): void {
    if (collapsed.has(key)) collapsed.delete(key)
    else collapsed.add(key)
  }

  function allSelected(pids: readonly number[]): boolean {
    return pids.length > 0 && pids.every((pid) => selected.has(pid))
  }

  /** Select every pid not yet selected; clear them all once every one is set. */
  function toggleGroup(pids: readonly number[]): void {
    if (allSelected(pids)) {
      for (const pid of pids) selected.delete(pid)
      return
    }
    for (const pid of pids) selected.add(pid)
  }

  const SERVICE_KIND_LABELS: Record<TaskManagerServiceKind, string> = {
    server: 'Server',
    mcp: 'MCP',
    gateway: 'Gateway',
    worker: 'Worker'
  }

  function compareFor(
    mode: TaskSortMode
  ): (a: TaskManagerProcess, b: TaskManagerProcess) => number {
    if (mode === 'cpu') {
      return (a, b) => (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0)
    }
    if (mode === 'name') {
      return (a, b) =>
        processName(a.command).localeCompare(processName(b.command), undefined, {
          sensitivity: 'base'
        })
    }
    return (a, b) => (b.memoryBytes ?? 0) - (a.memoryBytes ?? 0)
  }

  function toggleSelected(process: TaskManagerProcess): void {
    if (selected.has(process.pid)) selected.delete(process.pid)
    else selected.add(process.pid)
  }

  /** Aggregate use across every managed process, counting a harness tree once. */
  const processTotals = $derived(aggregateResources(processes))
  const totalRamBytes = $derived(processTotals.memoryBytes)
  const totalCpuPercent = $derived(processTotals.cpuPercent)

  async function load(): Promise<void> {
    if (checking) return
    checking = true
    error = ''
    try {
      const snapshot = await invoke('taskManager:list')
      processes = snapshot.processes
      services = snapshot.services
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

  /** Silent background refresh; avoids flashing the loading UI on each tick. */
  async function poll(): Promise<void> {
    if (polling || checking) return
    polling = true
    try {
      const snapshot = await invoke('taskManager:list')
      processes = snapshot.processes
      services = snapshot.services
      power = snapshot.power
      sampledAt = snapshot.sampledAt
      pruneSelection()
      void ensureProjectIcons(snapshot.processes)
    } catch {
      // Background poll failed   keep showing the last snapshot, don't spam errors.
    } finally {
      polling = false
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

  // Auto-refresh every 5 seconds while the modal stays open. The snapshot
  // resolves project and thread names through the database, so it stops on the
  // quit signal: the main process closes that database while the window is
  // still open.
  $effect(() => {
    if (!open || appQuitState.quitting) return
    const timer = setInterval(() => void poll(), 5000)
    return () => clearInterval(timer)
  })

  function processName(command: string): string {
    const executable = command.trim().split(/\s+/u)[0] ?? command
    return posixBasename(executable) || 'Process'
  }

  function harnessIdFor(command: string): string | undefined {
    const executable = command
      .trim()
      .split(/\s+/u)[0]
      ?.replace(/^['"]|['"]$/gu, '')
    const name = posixBasename(executable ?? '').replace(/\.exe$/iu, '')
    return getAgentIcon(name)?.id
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
        const iconUrl = getProjectIcon(project, storedIcons.get(project.id))
        if (iconUrl) projectIconUrls.set(project.id, iconUrl)
        projectColors.set(project.id, project.color ?? pickColorForSeed(project.id))
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

  /** Process uptime at the current snapshot, cascading w/d/h/m/s like every
   *  other duration surface instead of piling up hours (`72h 15m`). */
  function formatDuration(startedAt: number): string {
    return formatDurationSeconds((sampledAt - startedAt) / 1000)
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

  function setFilterProject(projectId: string | null): void {
    filterProjectId = projectId
    if (projectId) void ensureProjectIcons(processes)
  }

  /**
   * Reveal or hide the toolbar search. Hiding always clears the query, so a
   * filter can never stay armed behind a field that is no longer on screen.
   */
  function toggleSearch(): void {
    searchOpen = !searchOpen
    if (!searchOpen) searchQuery = ''
  }

  /** The field takes focus (with any previous text selected) the instant the
   *  toolbar swaps to it, so the button press is one step instead of two. */
  const focusSearchInput: Attachment<HTMLInputElement> = (element) => {
    element.focus()
    element.select()
  }

  function thermalLabel(): string {
    const state = power.thermalState
    return `${state.slice(0, 1).toUpperCase()}${state.slice(1)} thermal pressure`
  }

  function shortPath(cwd: string | null, max = 44): string {
    if (!cwd) return ' '
    if (cwd.length <= max) return cwd
    const tail = cwd.slice(-Math.floor(max * 0.6))
    const head = cwd.slice(0, Math.floor(max * 0.4) - 1)
    return `${head}…${tail}`
  }

  /**
   * Resolve the project/thread to open a browser or terminal in for a process.
   * Uses the process's owning thread when present and valid; otherwise falls
   * back to the first non-archived thread of the owning project, then to a new
   * thread. App-scoped processes (no owning project) are not navigable.
   */
  async function resolveTarget(
    process: TaskManagerProcess
  ): Promise<{ projectId: string; threadId: string } | null> {
    const projectId = process.projectId
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

  /**
   * Open a process's listening port in the browser of the conversation that
   * owns it.
   *
   * The app lands on the owning thread first. A tab belongs to a conversation,
   * and the reveal that opens the browser dock only reaches the conversation
   * that is on screen, so opening a page for a process in another project, chat,
   * or routine run without moving first created a tab nobody could see. Landing
   * first is also what makes the browser belong to the right owner: a run of a
   * routine shares the routine's browser, a chat owns its own.
   */
  async function openInBrowser(process: TaskManagerProcess): Promise<void> {
    if (process.ports.length === 0) return
    error = ''
    try {
      const target = await resolveTarget(process)
      if (!target) {
        error = `No project available to open ${process.pid}.`
        return
      }
      const [thread, project] = await Promise.all([
        invoke('thread:get', target.projectId, target.threadId),
        invoke('project:get', target.projectId)
      ])
      if (thread && project) {
        workspaceState.openThreadInOwningView(thread, project)
      }
      contextSidebarState.openBrowserForContext(
        `http://localhost:${process.ports[0]}`,
        target.projectId,
        target.threadId,
        undefined,
        true
      )
      onClose()
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

  /**
   * Navigate to the project/thread that owns a process: focus its thread in the
   * workspace and close the modal. Falls back to the first non-archived thread
   * of the owning project, then creates a new thread if none exist. Processes
   * with no owning project are not navigable.
   */
  async function navigateToProcess(process: TaskManagerProcess): Promise<void> {
    if (!process.projectId) return
    error = ''
    try {
      const target = await resolveTarget(process)
      if (!target) {
        error = `No project available to open ${process.pid}.`
        return
      }
      const [thread, project] = await Promise.all([
        invoke('thread:get', target.projectId, target.threadId),
        invoke('project:get', target.projectId)
      ])
      if (thread && project) {
        // Landing in the view that owns the thread is the point of the action:
        // a process can belong to a chat or an assistant task, and selecting it
        // without moving left the user on a view that could not show it.
        workspaceState.openThreadInOwningView(thread, project)
      }
      onClose()
    } catch (navigateError) {
      error = navigateError instanceof Error ? navigateError.message : 'Could not open the process.'
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

  /** Stopping a service ends a loopback server or MCP child, so confirm first. */
  function requestStopService(service: TaskManagerService): void {
    if (!service.stoppable || stopping) return
    stopTarget = service
  }

  async function confirmStopService(): Promise<void> {
    const target = stopTarget
    if (!target || stopping) return
    stopping = true
    error = ''
    try {
      await invoke('taskManager:stopService', target.id)
      stopTarget = null
      await load()
    } catch (stopError) {
      error = stopError instanceof Error ? stopError.message : 'The service could not be stopped.'
    } finally {
      stopping = false
    }
  }
</script>

<Modal
  {open}
  title="Task Manager"
  {onClose}
  size="xl"
  fill
  contentClass="p-0"
  onEscapeKeydown={(event) => {
    // Escape backs out of the search first; only an Escape with the field
    // already closed dismisses the whole surface.
    if (!searchOpen) return
    event.preventDefault()
    toggleSearch()
  }}
>
  <div class="flex h-full flex-col overflow-hidden">
    {#if error}
      <div class="shrink-0 border-b border-border px-5 py-2" role="alert">
        <p class="truncate text-xs text-danger">{error}</p>
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
      {:else if searchedServices.length === 0 && searchedProcesses.length === 0}
        <div class="flex h-full items-center justify-center px-8 text-center">
          <div class="max-w-64">
            <Plug size={20} class="mx-auto text-muted" />
            {#if searchTokens.length > 0}
              <p class="mt-3 text-sm font-semibold text-foreground">No matches</p>
              <p class="mt-1 text-xs leading-relaxed text-dimmed">
                Nothing matches "{searchQuery.trim()}". Search by pid, port, path, thread title, or
                app name.
              </p>
            {:else}
              <p class="mt-3 text-sm font-semibold text-foreground">Nothing is running</p>
              <p class="mt-1 text-xs leading-relaxed text-dimmed">
                {filterProjectId
                  ? 'No processes or services match the current filter. Shared runtimes always stay visible.'
                  : 'Processes and services the app starts will appear here while they are running.'}
              </p>
            {/if}
          </div>
        </div>
      {:else}
        {#snippet projectIconTile(
          projectId: string,
          label: string,
          boxClass: string,
          iconClass: string
        )}
          {@const color = projectColors.get(projectId) ?? pickColorForSeed(projectId)}
          {@const iconUrl = projectIconUrls.get(projectId) ?? generateInitialsIconSvg(label, color)}
          <span
            class="flex shrink-0 items-center justify-center overflow-hidden border {boxClass}"
            style:border-color={`color-mix(in srgb, ${color} 45%, transparent)`}
            style:background-color={`color-mix(in srgb, ${color} 14%, var(--color-raised))`}
          >
            <img
              src={iconUrl}
              alt=""
              class="{iconClass} object-contain"
              onerror={(event) => {
                const image = event.currentTarget
                if (!(image instanceof HTMLImageElement) || image.dataset.iconFallbackApplied)
                  return
                image.dataset.iconFallbackApplied = 'true'
                image.src = generateInitialsIconSvg(label, color)
              }}
            />
          </span>
        {/snippet}

        {#snippet serviceRow(service: TaskManagerService)}
          <li class="flex items-start gap-3 px-5 py-3">
            <span
              class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-primary"
            >
              {#if service.kind === 'mcp'}
                <Plug size={15} />
              {:else if service.kind === 'gateway'}
                <Network size={15} />
              {:else if service.kind === 'worker'}
                <Cog size={15} />
              {:else}
                <Server size={15} />
              {/if}
            </span>
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2">
                <p class="truncate text-sm font-semibold text-foreground">{service.name}</p>
                {#if service.port !== null}
                  <span
                    class="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-primary"
                  >
                    :{service.port}
                  </span>
                {/if}
                <span
                  class="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] tracking-wide text-muted uppercase"
                >
                  {SERVICE_KIND_LABELS[service.kind]}
                </span>
              </div>
              {#if service.detail}
                <p
                  class="mt-1 truncate font-mono text-[0.625rem] text-dimmed"
                  title={service.detail}
                >
                  {service.detail}
                </p>
              {/if}
              <div
                class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.625rem] text-dimmed tabular-nums"
              >
                {#if service.pid !== null}
                  <span>PID {service.pid}</span>
                {/if}
                <span>{formatDuration(service.startedAt)}</span>
              </div>
            </div>
            <div class="mt-0.5 flex shrink-0 items-center gap-1">
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-muted transition-colors hover:border-border hover:bg-overlay hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!service.stoppable || stopping}
                title={service.stoppable
                  ? `Stop ${service.name}`
                  : 'This runtime is owned by the app for its whole session'}
                aria-label={`Stop ${service.name}`}
                onclick={() => requestStopService(service)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </li>
        {/snippet}

        {#snippet processRow(process: TaskManagerProcess)}
          {@const harnessId = harnessIdFor(process.command)}
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
            <button
              type="button"
              class="flex min-w-0 flex-1 cursor-pointer items-start gap-3 text-left"
              title={`Select ${processName(process.command)} (PID ${process.pid})`}
              aria-pressed={selected.has(process.pid)}
              onclick={() => toggleSelected(process)}
            >
              {#if harnessId}
                <span
                  class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-primary"
                >
                  <AgentIcon agentId={harnessId} size={16} />
                </span>
              {:else if process.projectId}
                {@render projectIconTile(
                  process.projectId,
                  process.projectName ?? processName(process.command),
                  'mt-0.5 h-8 w-8 rounded-lg',
                  'h-4 w-4'
                )}
              {:else}
                <span
                  class="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-raised text-primary"
                >
                  <SquareTerminal size={15} />
                </span>
              {/if}
              <div class="min-w-0 flex-1">
                <div class="flex items-center gap-2">
                  <p class="truncate text-sm font-semibold text-foreground">
                    {processName(process.command)}
                  </p>
                  {#if process.ports.length > 0}
                    <span
                      class="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 font-mono text-[0.625rem] text-primary"
                    >
                      :{process.ports[0]}
                      {#if process.ports.length > 1}
                        <span class="text-dimmed">+{process.ports.length - 1}</span>
                      {/if}
                    </span>
                  {/if}
                  <span
                    class="shrink-0 rounded-md bg-raised px-1.5 py-0.5 text-[0.625rem] text-muted {process.scope ===
                    'app'
                      ? 'uppercase tracking-wide'
                      : ''}"
                  >
                    {process.scope === 'app' ? 'Shared' : 'Running'}
                  </span>
                </div>
                <p
                  class="mt-1 truncate font-mono text-[0.625rem] text-dimmed"
                  title={process.command}
                >
                  {process.command}
                </p>
                <div
                  class="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.625rem] text-dimmed tabular-nums"
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
                </div>
              </div>
            </button>
            <div class="mt-0.5 flex shrink-0 items-center gap-1">
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-muted transition-colors hover:border-border hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                disabled={process.ports.length === 0 || !process.projectId}
                title={process.ports.length === 0
                  ? 'No port detected'
                  : process.projectId
                    ? 'Open in thread browser'
                    : 'No project associated with this process'}
                aria-label={`Open ${processName(process.command)} in the thread browser`}
                onclick={() => void openInBrowser(process)}
              >
                <GlobeCode size={15} />
              </button>
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-muted transition-colors hover:border-border hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!process.projectId}
                title={process.projectId
                  ? 'Open path in in-app terminal'
                  : 'No project associated with this process'}
                aria-label={`Open ${processName(process.command)} path in the in-app terminal`}
                onclick={() => void openInTerminal(process)}
              >
                <SquareTerminal size={15} />
              </button>
              <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-lg border border-transparent text-muted transition-colors hover:border-border hover:bg-overlay hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
                disabled={!process.threadId}
                title={process.threadId
                  ? `Open the thread responsible for ${processName(process.command)}`
                  : 'No thread associated with this process'}
                aria-label={`Open the thread responsible for ${processName(process.command)}`}
                onclick={() => void navigateToProcess(process)}
              >
                <MessagesSquare size={15} />
              </button>
            </div>
          </li>
        {/snippet}

        {#if appScopedProcesses.length > 0 || appOwnedServices.length > 0}
          <TaskManagerNode
            label={APP_NAME}
            expanded={!isCollapsed('app')}
            ontoggle={() => toggleCollapsed('app')}
            count={appScopedProcesses.length + appOwnedServices.length}
            memoryLabel={formatMemory(appOwnedTotals.memoryBytes)}
            cpuLabel={formatCpu(appOwnedTotals.cpuPercent)}
            switchChecked={allSelected(appOwnedPids)}
            switchLabel={appOwnedPids.length > 0
              ? `Select every app-owned process under ${APP_NAME}`
              : 'No processes to select'}
            onswitch={appOwnedPids.length > 0 ? () => toggleGroup(appOwnedPids) : undefined}
          >
            {#snippet icon()}
              <VendorIcon id="codeinoven" name={APP_NAME} size={18} class="shrink-0" />
            {/snippet}

            <!-- The app node holds only what the app owns for its whole run:
            the config-rooted services and the app-scoped processes such as the
            shared model server. Projects and routines are never nested here. -->
            <ul class="divide-y divide-border">
              {#each appScopedProcesses as process (process.pid)}
                {@render processRow(process)}
              {/each}
              {#each appOwnedServices as service (service.id)}
                {@render serviceRow(service)}
              {/each}
            </ul>
          </TaskManagerNode>
        {/if}

        {#each ownerGroups as group (group.id)}
          <TaskManagerNode
            label={group.label}
            hint={group.kind === 'thread' ? group.projectName : null}
            expanded={!isCollapsed(group.id)}
            ontoggle={() => toggleCollapsed(group.id)}
            count={group.processes.length + group.services.length}
            memoryLabel={formatMemory(group.memoryBytes)}
            cpuLabel={formatCpu(group.cpuPercent)}
            switchChecked={allSelected(group.pids)}
            switchLabel={`Select every process under ${group.label}`}
            onswitch={group.pids.length > 0 ? () => toggleGroup(group.pids) : undefined}
          >
            {#snippet icon()}
              <!-- A group is an owner   a project, or a thread inside one   so it
              carries the icon and colour of the project it belongs to. The
              harness mark stays on the process rows, where it identifies the
              run itself rather than the project. -->
              {@render projectIconTile(
                group.projectId ?? group.id,
                group.projectName ?? group.label,
                'h-6 w-6 rounded-md',
                'h-4 w-4'
              )}
            {/snippet}
            <ul class="divide-y divide-border">
              {#each group.processes as process (process.pid)}
                {@render processRow(process)}
              {/each}
              {#each group.services as service (service.id)}
                {@render serviceRow(service)}
              {/each}
            </ul>
          </TaskManagerNode>
        {/each}
      {/if}
    </div>
  </div>

  {#snippet footer()}
    <div class="flex w-full items-center justify-between gap-4">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        {#if searchOpen}
          <!-- The field replaces the stats and filters to its left: a query is
          the only control that matters while it is being typed, and this slot
          is exactly the space they occupied. The filter stays applied   only
          its control is off screen. -->
          <div
            class="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md border border-border bg-elevated px-2"
          >
            <Search size={12} class="shrink-0 text-dimmed" aria-hidden="true" />
            <input
              {@attach focusSearchInput}
              bind:value={searchQuery}
              type="search"
              class="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-dimmed"
              placeholder="Search by pid, port, path, thread, or app name"
              title="Search by pid, port, path, thread title, or app name"
              aria-label="Search running processes and services"
            />
          </div>
        {:else}
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
          {#if power.thermalState !== 'unknown' && power.thermalState !== 'nominal'}
            <span
              class="inline-flex shrink-0 items-center gap-1 text-danger"
              title="Current macOS thermal pressure   {thermalLabel()}"
              aria-label="Current macOS thermal pressure   {thermalLabel()}"
            >
              <Thermometer size={14} />
            </span>
          {/if}
          <p class="min-w-0 truncate text-xs text-dimmed tabular-nums">
            {#if selected.size > 0}
              {selected.size} of {processes.length} selected
            {:else}
              {processes.length} processes · {services.length} services
            {/if}
          </p>
          <span
            class="inline-flex shrink-0 items-center gap-1 text-xs text-dimmed tabular-nums"
            title="Total memory used by listed processes"
            aria-label="Total memory used by listed processes"
          >
            <MemoryStick size={13} aria-hidden="true" />
            {formatMemory(totalRamBytes)}
          </span>
          <span
            class="inline-flex shrink-0 items-center gap-1 text-xs text-dimmed tabular-nums"
            title="Total CPU usage of listed processes"
            aria-label="Total CPU usage of listed processes"
          >
            <Cpu size={13} aria-hidden="true" />
            {formatCpu(totalCpuPercent)}
          </span>
          <span class="h-4 w-px shrink-0 bg-border" aria-hidden="true"></span>
          <ProjectSwitch
            projects={scopeState.projects}
            activeProjectId={filterProjectId}
            onSwitch={(projectId) => setFilterProject(projectId)}
            ariaLabel="Filter processes by project"
            placeholder="All projects"
            searchPlaceholder="Search projects…"
            emptyMessage="No matching projects"
            class="h-7 shrink-0"
            compact
            align="start"
          />
          {#if filterProjectId}
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-elevated text-dimmed transition-colors hover:bg-overlay hover:text-foreground"
              title="Clear the project filter"
              aria-label="Clear the project filter"
              onclick={() => setFilterProject(null)}
            >
              <X size={12} />
            </button>
          {/if}
          <DropdownMenu.Root>
            <DropdownMenu.Trigger
              class="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-elevated px-2 text-[0.625rem] font-medium text-dimmed transition-colors hover:bg-overlay hover:text-foreground data-[state=open]:bg-overlay data-[state=open]:text-foreground"
              title="Choose sort mode"
              aria-label="Choose sort mode"
            >
              <ArrowDownUp size={12} />
              {SORT_MODE_LABELS[sortMode]}
              <ChevronDown size={11} class="text-dimmed" />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                side="top"
                align="start"
                sideOffset={6}
                collisionPadding={8}
                class="z-60 w-36 overflow-hidden rounded-xl border bg-surface p-1 shadow-lg"
              >
                {#each SORT_MODES as mode (mode)}
                  <DropdownMenu.Item
                    class="flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-[0.6875rem] outline-none transition-colors hover:bg-elevated focus:bg-elevated max-md:py-2.5 {mode ===
                    sortMode
                      ? 'text-foreground'
                      : 'text-muted'}"
                    title={SORT_MODE_DESCRIPTIONS[mode]}
                    aria-label={SORT_MODE_DESCRIPTIONS[mode]}
                    onSelect={() => (sortMode = mode)}
                  >
                    <Check
                      size={12}
                      class={mode === sortMode ? 'text-primary' : 'opacity-0'}
                      aria-hidden="true"
                    />
                    {SORT_MODE_LABELS[mode]}
                  </DropdownMenu.Item>
                {/each}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        {/if}
        <button
          type="button"
          class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border transition-colors {searchOpen
            ? 'bg-overlay text-foreground'
            : 'bg-elevated text-dimmed hover:bg-overlay hover:text-foreground'}"
          aria-pressed={searchOpen}
          title={searchOpen
            ? 'Close search and clear the query'
            : 'Search running processes by pid, port, path, thread, or app name'}
          aria-label={searchOpen
            ? 'Close search and clear the query'
            : 'Search running processes by pid, port, path, thread, or app name'}
          onclick={toggleSearch}
        >
          {#if searchOpen}
            <X size={13} />
          {:else}
            <Search size={13} />
          {/if}
        </button>
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

<ConfirmDialog
  open={stopTarget !== null}
  title="Stop service?"
  confirmLabel="Stop service"
  busy={stopping}
  onCancel={() => {
    if (!stopping) stopTarget = null
  }}
  onConfirm={confirmStopService}
>
  {#if stopTarget}
    <p>
      Stop <span class="font-medium text-foreground">{stopTarget.name}</span>?
    </p>
    {#if stopTarget.detail}
      <p class="truncate font-mono text-xs text-dimmed" title={stopTarget.detail}>
        {stopTarget.detail}
      </p>
    {/if}
    <p>Anything using it loses this runtime until it starts again.</p>
  {/if}
</ConfirmDialog>

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
