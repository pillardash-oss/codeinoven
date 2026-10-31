import { powerMonitor } from 'electron'
import { Logger } from '../../system/logger'
import { validateEntityId } from '../../ipc/ipc-validation'
import type { ReapOrphansOptions, ReapOrphansResult } from '../../agents/agent-process-service'
import {
  projectDirectories,
  projectIdForWorkingDirectory
} from '../../agents/process-project-attribution'
import { appServiceRegistry } from '../../system/app-service-registry'
import type { AgentRunningProcess, TaskManagerSnapshot } from '../../../lib/types'
import { DEFAULT_SCOPE_BUCKET_ID } from '../../../lib/types'
import type { SessionInfo } from './chat-engine-types'
import { USER_TERMINAL_SETTLE_MS } from './chat-engine-constants'
import { ChatEngine } from '../chat-engine'
import type { UserTerminalWindow } from '../chat-engine'

/** ChatEngine processes: one concern, moved verbatim from the composition root. */
export class ChatEngineProcesses {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Reap harness processes orphaned by an unclean previous run (crash, force
   * quit, or the shutdown failsafe) before this session spawns any new servers.
   * Only kills processes the app owns   never a user's external harness.
   */
  reapOrphanProcesses(options?: ReapOrphansOptions): Promise<ReapOrphansResult> {
    return this.host.state.agentProcesses.reapOrphans(options)
  }

  /**
   * Reclaim harness processes orphaned by an instance that died while this one
   * stayed up (its shared servers keep their ports and memory otherwise).
   * Ownership must be proven: a sweep repeats for hours, so a journaled pid the
   * OS has recycled must never be signalled on the orphan check alone.
   */
  async sweepOrphanedProcesses(): Promise<void> {
    const now = Date.now()
    if (now - this.host.state.lastOrphanSweepAt < ChatEngine.ORPHAN_SWEEP_INTERVAL_MS) return
    this.host.state.lastOrphanSweepAt = now
    try {
      const reaped = await this.host.state.agentProcesses.reapOrphans({
        requireOwnershipProof: true
      })
      if (reaped.killed.length > 0) {
        Logger.info('Reaped orphaned harness processes of a sibling instance', {
          killed: reaped.killed
        })
      }
    } catch (error) {
      Logger.error('Orphaned harness process sweep failed:', error)
    }
  }

  /** Running subprocesses owned exclusively by the requested thread. */
  listProcesses(projectId: string, threadId: string): Promise<AgentRunningProcess[]> {
    return this.host.state.agentProcesses.list(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  }

  /**
   * Whether any live agent process is owned by threads in the project  
   * optionally narrowed to one scope bucket   used by worktree lifecycle
   * preflights so removals never strand running agents.
   */
  async hasActiveProcessesInScope(projectId: string, scopeBucketId?: string): Promise<boolean> {
    projectId = validateEntityId(projectId, 'Project ID')
    const threads = await this.host.threadManager.listThreads(projectId)
    let inspected = false
    for (const thread of threads) {
      if (thread.archived) continue
      if (
        scopeBucketId !== undefined &&
        (thread.scopeBucketId ?? DEFAULT_SCOPE_BUCKET_ID) !== scopeBucketId
      ) {
        continue
      }
      const processes = await this.host.state.agentProcesses.list(projectId, thread.id, !inspected)
      inspected = true
      if (processes.length > 0) return true
    }
    return false
  }

  /** Kill one app-owned process by pid for a thread. */
  killProcess(projectId: string, threadId: string, pid: number): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new TypeError('Process ID must be a positive integer')
    }
    return this.host.state.agentProcesses.killProcess(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID'),
      pid
    )
  }

  /** Kill every process owned by a thread, including app-scoped pooled shares. */
  killThreadProcesses(projectId: string, threadId: string): Promise<void> {
    return this.host.state.agentProcesses.killThread(
      validateEntityId(projectId, 'Project ID'),
      validateEntityId(threadId, 'Thread ID')
    )
  }

  /** App-wide process list for the task manager (all projects and app scope). */
  async listTaskManagerProcesses(): Promise<TaskManagerSnapshot> {
    const processes = await this.host.state.agentProcesses.listAll()
    const services = appServiceRegistry.list()
    const projectNames = new Map<string, string>()
    const threadTitles = new Map<string, string>()
    // A row with no session owner can still belong to a project: its working
    // directory names the project whose files it is working in. That is how a
    // re-parented daemon (the adb fork-server) and an app-wide shared runtime
    // keep their project once their session, or their session marker, is gone,
    // instead of listing under the app-wide node with a project path showing
    // underneath.
    const directories = await projectDirectories(
      await this.host.state.projectManager.listProjects()
    )
    const attributedProjectIds = new Map<number, string>()
    for (const process of processes) {
      if (process.projectId || !process.cwd) continue
      const projectId = await projectIdForWorkingDirectory(process.cwd, directories)
      if (projectId) attributedProjectIds.set(process.pid, projectId)
    }
    const ownerProjectId = (row: { pid: number; projectId: string | null }): string | null =>
      row.projectId ?? attributedProjectIds.get(row.pid) ?? null
    // One resolution pass across both lists, so a project or thread that owns a
    // process and a service is read from the database once.
    const resolveOwner = async (projectId: string | null, threadId: string | null) => {
      if (projectId && !projectNames.has(projectId)) {
        const project = await this.host.state.projectManager.getProject(projectId)
        projectNames.set(projectId, project?.name ?? projectId)
      }
      if (projectId && threadId && !threadTitles.has(threadId)) {
        const thread = await this.host.threadManager.getThread(projectId, threadId)
        threadTitles.set(threadId, thread?.title ?? threadId)
      }
    }
    for (const process of processes) await resolveOwner(ownerProjectId(process), process.threadId)
    for (const service of services) await resolveOwner(service.projectId, service.threadId)
    const resolvedProcesses = processes.map((process) => {
      const projectId = ownerProjectId(process)
      return {
        ...process,
        ...(projectId ? { projectId, projectName: projectNames.get(projectId) ?? null } : {}),
        ...(process.threadId ? { threadTitle: threadTitles.get(process.threadId) ?? null } : {})
      }
    })
    const resolvedServices = services.map((service) => ({
      ...service,
      ...(service.projectId ? { projectName: projectNames.get(service.projectId) ?? null } : {}),
      ...(service.threadId ? { threadTitle: threadTitles.get(service.threadId) ?? null } : {})
    }))
    // A service backed by its own process is invisible to the process list: it
    // is the app's child, so no harness tree reaches it. Attaching its OS
    // metrics here is what lets an owner node total everything under it, and
    // what makes the service readable as more than a name and a pid.
    const servicePids = resolvedServices.flatMap((service) =>
      service.pid === null ? [] : [service.pid]
    )
    const serviceResources = await this.host.state.agentProcesses.processResources(servicePids)
    const servicesWithResources = resolvedServices.map((service) => ({
      ...service,
      cpuPercent:
        service.pid === null ? null : (serviceResources.get(service.pid)?.cpuPercent ?? null),
      memoryBytes:
        service.pid === null ? null : (serviceResources.get(service.pid)?.memoryBytes ?? null)
    }))
    return {
      processes: resolvedProcesses,
      services: servicesWithResources,
      power: {
        source: powerMonitor.isOnBatteryPower() ? 'battery' : 'ac',
        thermalState:
          process.platform === 'darwin' ? powerMonitor.getCurrentThermalState() : 'unknown'
      },
      sampledAt: Date.now()
    }
  }

  /** Kill an app-owned process by pid for the task manager (graceful or force). */
  killTaskManagerProcess(pid: number, force: boolean): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
      throw new TypeError('Process ID must be a positive integer')
    }
    // A pid the task manager shows can be a terminal's own shell. Ending it is
    // the same intent as closing that terminal, so the session is announced as
    // a deliberate stop first: without that the renderer reads the exit as a
    // crashed shell and restarts it, and the process the user just ended is
    // back before the list refreshes.
    this.host.state.ptyStopAnnouncer?.(pid)
    return this.host.state.agentProcesses.killProcessGlobal(pid, force)
  }

  /**
   * Register how a task-manager kill announces a terminal's deliberate stop.
   */
  setPtyStopAnnouncer(announcer: ((pid: number) => boolean) | null): void {
    this.host.state.ptyStopAnnouncer = announcer
  }

  /** Stop one registered app service through the action it registered with. */
  stopTaskManagerService(id: string): Promise<void> {
    return appServiceRegistry.stop(id)
  }

  /** Register a PTY-backed terminal or action and its descendants with the
   * same process tracker used by agent harnesses. */
  trackPtyProcess(
    scopeId: string | undefined,
    projectId: string | undefined,
    threadId: string | undefined,
    pid: number,
    command: string,
    cwd: string
  ): void {
    if (scopeId && projectId && threadId) {
      this.host.state.agentProcesses.claimSession(scopeId, projectId, threadId)
    }
    this.host.state.agentProcesses.watchProcess(scopeId, pid, command, cwd)
  }

  /**
   * The user typed in an in-app project terminal. While activity keeps
   * arriving (and for a short settle window after the last keystroke) a
   * fingerprint window stays open so any files their commands mutate are
   * recognized as user edits and excluded from concurrent agent turns.
   */
  recordUserTerminalInput(projectId: string, projectPath: string): void {
    // Command-backed terminals (harness logins/updates) carry no project id;
    // there is no checkpoint to attribute their shell commands to.
    if (!projectId) return
    // The window is scoped to the terminal's own worktree root, not just the
    // project: a terminal running in one scope worktree must never affect
    // attribution of a turn (or another terminal) in a different root.
    let roots = this.host.state.userTerminalWindows.get(projectId)
    if (!roots) {
      roots = new Map()
      this.host.state.userTerminalWindows.set(projectId, roots)
    }
    const windowKey = projectPath
    const existing = roots.get(windowKey)
    if (existing) {
      existing.lastInput = Date.now()
      clearTimeout(existing.timer)
      existing.timer = setTimeout(() => {
        const current = this.host.state.userTerminalWindows.get(projectId)?.get(windowKey)
        if (current?.timer !== existing.timer) return
        const roots = this.host.state.userTerminalWindows.get(projectId)
        if (!roots) return
        roots.delete(windowKey)
        if (roots.size === 0) this.host.state.userTerminalWindows.delete(projectId)
      }, USER_TERMINAL_SETTLE_MS)
      return
    }
    const fingerprint = this.host.checkpointManager
      .fingerprint(projectId, projectPath)
      .catch((error) => {
        Logger.error('user-terminal fingerprint failed:', error)
        return null
      })
    const window: UserTerminalWindow = {
      fingerprint,
      // Resolved from the same fingerprint: the tracker real-paths the cwd, so
      // this is the canonical worktree root the window applies to. A failed
      // baseline also resolves to null, which excludes the window everywhere.
      projectRoot: fingerprint.then((baseline) => baseline?.projectRoot ?? null),
      lastInput: Date.now(),
      timer: setTimeout(() => undefined, 0)
    }
    window.timer = setTimeout(() => {
      const current = this.host.state.userTerminalWindows.get(projectId)?.get(windowKey)
      if (current?.timer !== window.timer) return
      const roots = this.host.state.userTerminalWindows.get(projectId)
      if (!roots) return
      roots.delete(windowKey)
      if (roots.size === 0) this.host.state.userTerminalWindows.delete(projectId)
    }, USER_TERMINAL_SETTLE_MS)
    roots.set(windowKey, window)
  }

  /** The open user-terminal windows for this session's project. Root
   *  matching happens per window when its fingerprint resolves: a window
   *  rooted in another scope's worktree never applies to this session. */
  matchingUserTerminalWindows(session: SessionInfo): UserTerminalWindow[] {
    const roots = this.host.state.userTerminalWindows.get(session.projectId)
    if (!roots) return []
    return [...roots.values()]
  }

  /**
   * Paths the user's in-app terminal commands moved during this turn, in the
   * turn's own worktree. Computed by diffing each matching terminal window's
   * baseline against a fresh fingerprint, so a turn that never ran a shell
   * tool still excludes the user's shell edits from its final checkpoint.
   */
  async userTerminalChangedPaths(session: SessionInfo): Promise<Set<string>> {
    // Only scan when an active turn overlaps actual user-terminal activity.
    if (!session.activeTurnId) return new Set()
    if (!this.host.state.userTerminalWindows.get(session.projectId)?.size) return new Set()
    const after = await this.host.checkpointManager
      .fingerprint(session.projectId, session.projectPath)
      .catch((error) => {
        Logger.error('user-terminal completion scan failed:', error)
        return null
      })
    if (!after) return new Set()
    const changed = new Set<string>()
    for (const entry of this.matchingUserTerminalWindows(session)) {
      const [userStart, windowRoot] = await Promise.all([entry.fingerprint, entry.projectRoot])
      // Only windows rooted in the turn's worktree apply (see
      // closeUnboundedToolWindow); anything else cannot be compared safely.
      if (!userStart || !windowRoot || windowRoot !== after.projectRoot) continue
      for (const path of this.host.checkpointManager.diffFingerprints(
        session.projectId,
        userStart,
        after
      )) {
        changed.add(path)
      }
    }
    return changed
  }

  /** Merge in-app editor saves with terminal-window paths for completion exclusion. */
  withUserTerminalPaths(
    userTouchedPaths: ReadonlySet<string> | undefined,
    userTerminalPaths: ReadonlySet<string>
  ): Set<string> | undefined {
    if (userTerminalPaths.size === 0)
      return userTouchedPaths ? new Set(userTouchedPaths) : undefined
    const merged = new Set(userTouchedPaths ?? [])
    for (const path of userTerminalPaths) merged.add(path)
    return merged
  }
}
