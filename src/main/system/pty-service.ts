import type { WebContents } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { existsSync, realpathSync, statSync } from 'fs'
import { homedir } from 'os'
import { basename, isAbsolute, relative, resolve } from 'path'
import * as pty from 'node-pty'
import { APP_NAME } from '../../lib/brand'
import { Logger } from './logger'
import { dailyLogRelativePath, PTY_EVENTS_LOG_FILE } from './log-paths'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { ProjectManager } from '../../lib/engines/project-manager'
import type { Database } from '../database/database'
import type { StorageEngine } from '../storage/storage-engine'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { scopeRootProvider, type ScopeRootResolver } from '../workspaces/scope-root-resolver'

export interface PtyRemoteLaunch {
  ovenId: string
  executable: string
  args: string[]
  environment: Record<string, string>
  localCwd: string
  remoteCwd: string
  dispose: () => Promise<void>
}
export interface PtyRemoteLaunchHook {
  (
    projectId: string,
    threadId: string,
    directory?: string,
    script?: string,
    variables?: Record<string, string>
  ): Promise<PtyRemoteLaunch | null>
}

interface PtySession {
  id: string
  projectId: string
  cwd: string
  shell: string
  remote?: boolean
  ovenId?: string
  createdAt: number
  process: pty.IPty
  /** When set, the session is killed after this long with zero output or input. */
  idleTimeoutMs?: number
  lastActivityAt: number
}

/** How often the watchdog sweeps for idle sessions. */
const IDLE_WATCHDOG_INTERVAL_MS = 5_000

const ALLOWED_COMMANDS = new Set([
  'opencode',
  'claude',
  'codex',
  'cline',
  'pi',
  'agy',
  'muse',
  'npm',
  'bun',
  'brew',
  'winget',
  'rm',
  'git',
  'wsl',
  'sh',
  'cmd',
  'powershell'
])

const ACCOUNT_ENVIRONMENT_KEYS = new Set([
  'PI_CODING_AGENT_DIR',
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR'
])

function normalizedCommandName(command: string): string {
  return basename(command)
    .replace(/\.(?:exe|cmd|bat|ps1)$/iu, '')
    .toLowerCase()
}

function safeCommandEnvironment(environment?: Record<string, string>): Record<string, string> {
  if (!environment) return {}
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key, value]) =>
        ACCOUNT_ENVIRONMENT_KEYS.has(key) &&
        typeof value === 'string' &&
        value.length > 0 &&
        value.length <= 4_096 &&
        !value.includes('\0')
    )
  )
}

/** Called when the user types into a project terminal, so concurrent agent
 *  turns can exclude the user's own shell-driven edits from their cards. */
export interface PtyUserInputHook {
  (projectId: string, projectPath: string): void
}

export interface PtyTrackedProcess {
  scopeId?: string
  projectId?: string
  threadId?: string
  pid: number
  command: string
  cwd: string
}

function buildShellEnv(): Record<string, string> {
  const harnessEnv = buildProcessEnvironment()
  const env = Object.fromEntries(
    Object.entries(harnessEnv).filter((entry): entry is [string, string] => entry[1] !== undefined)
  )
  return {
    ...env,
    COLORTERM: 'truecolor',
    TERM_PROGRAM: APP_NAME
  }
}

/**
 * Resolve the working directory for a terminal that was explicitly opened at a
 * folder from the file tree. `directory` is a project-relative path ('' is the
 * root itself); the resolved real path must exist, be a directory, and stay
 * inside `baseCwd`, so a crafted path can never spawn a shell outside the
 * project or the active scope's checkout.
 */
function resolveStartingDirectory(baseCwd: string, directory: string): string {
  if (directory.includes('\0')) {
    throw new Error('Terminal directory is invalid')
  }
  let real: string
  try {
    real = realpathSync(resolve(baseCwd, directory))
  } catch {
    throw new Error('Terminal directory is unavailable')
  }
  let isDirectory: boolean
  try {
    isDirectory = statSync(real).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    throw new Error('Terminal path is not a directory')
  }
  const root = realpathSync(baseCwd)
  const contained = relative(root, real)
  if (contained.startsWith('..') || isAbsolute(contained)) {
    throw new Error('Terminal directory is outside the project')
  }
  return real
}

/** Resolve the user's preferred shell: $SHELL → zsh → bash. */
function resolveShell(): string {
  const preferred = process.env['SHELL']
  if (preferred && existsSync(preferred)) return preferred
  if (existsSync('/bin/zsh')) return '/bin/zsh'
  if (existsSync('/bin/bash')) return '/bin/bash'
  return '/bin/sh'
}

/** Match the login-shell behavior users expect from a desktop terminal. */
function resolveShellArgs(shell: string): string[] {
  switch (basename(shell)) {
    case 'bash':
    case 'dash':
    case 'fish':
    case 'ksh':
    case 'sh':
    case 'zsh':
      return ['-l']
    default:
      return []
  }
}

/**
 * PtyService manages pseudo-terminal sessions for provider CLIs and shells.
 * Each session is keyed by an id and streams output to the renderer over IPC.
 *
 * Channels:
 *  - renderer → main: pty:create, pty:write, pty:resize, pty:destroy
 *  - main → renderer: pty:data:<id>, pty:exit:<id>
 */
export class PtyService {
  private sessions = new Map<string, PtySession>()
  private idleWatchdog: ReturnType<typeof setInterval> | null = null
  private sender: WebContents | null = null
  private projectManager: ProjectManager
  private scopeRoots

  constructor(
    private storage: StorageEngine,
    _database: Database,
    scopeResolver?: ScopeRootResolver,
    private readonly trackProcess?: (process: PtyTrackedProcess) => void,
    private readonly onUserInput?: PtyUserInputHook,
    private readonly remoteLaunch?: PtyRemoteLaunchHook
  ) {
    this.projectManager = new ProjectManager(_database)
    this.scopeRoots = scopeResolver ? scopeRootProvider(scopeResolver) : undefined
  }

  attach(sender: WebContents): void {
    this.sender = sender
  }

  detach(): void {
    this.sender = null
  }

  register(): void {
    this.ensureIdleWatchdog()
    ipcMain.handle(
      'pty:create',
      (
        _,
        id: string,
        projectId: string,
        threadId: string,
        cols: number,
        rows: number,
        scopeBucketId?: string,
        directory?: string
      ) => this.create(id, projectId, threadId, cols, rows, scopeBucketId, directory)
    )
    ipcMain.handle(
      'pty:createCommand',
      (
        _,
        id: string,
        command: string,
        args: string[],
        cols: number,
        rows: number,
        idleTimeoutMs?: number,
        environment?: Record<string, string>
      ) => this.createCommand(id, command, args, cols, rows, idleTimeoutMs, environment)
    )
    ipcMain.handle(
      'pty:createAction',
      (
        _,
        id: string,
        projectId: string,
        threadId: string,
        script: string,
        variables: Record<string, string>,
        cols: number,
        rows: number,
        scopeBucketId?: string
      ) => this.createAction(id, projectId, threadId, script, variables, cols, rows, scopeBucketId)
    )
    ipcMain.on('pty:write', (_, id: string, data: string) => this.write(id, data))
    ipcMain.on('pty:resize', (_, id: string, cols: number, rows: number) =>
      this.resize(id, cols, rows)
    )
    ipcMain.handle('pty:destroy', (_, id: string) => this.destroy(id))
  }

  /** Reattach instead of respawning when a live PTY already runs under `id`.
   *  Only the renderer can lose track of a running process (a dev hot reload
   *  rebuilds its session map while the main side keeps the PTY alive), and
   *  a same-id create used to destroy the old PTY first, killing a running
   *  server or action the user never asked to stop. The new renderer session
   *  subscribes to `pty:data:<id>` on its own, so streaming simply resumes. */
  private reuseLiveSession(id: string): { id: string; pid: number } | null {
    const session = this.sessions.get(id)
    if (!session) return null
    Logger.info(
      `[pty] Session ${id} is still live (pid ${session.process.pid}); reattaching instead of respawning`
    )
    void this.recordEvent({
      type: 'reattach',
      terminalId: id,
      pid: session.process.pid,
      timestamp: Date.now()
    })
    return { id, pid: session.process.pid }
  }

  private async reuseOvenSession(
    id: string,
    remote: PtyRemoteLaunch | null | undefined
  ): Promise<{ id: string; pid: number } | null> {
    const session = this.sessions.get(id)
    if (!session) return null
    if (remote) await remote.dispose()
    if (session.ovenId !== remote?.ovenId || (remote && session.cwd !== remote.remoteCwd))
      throw new Error('This terminal belongs to another Oven or directory. Open a new terminal.')
    return this.reuseLiveSession(id)
  }

  private async create(
    id: string,
    projectId: string,
    threadId: string,
    cols: number,
    rows: number,
    scopeBucketId?: string,
    directory?: string
  ): Promise<{ id: string; pid: number }> {
    const remote = await this.remoteLaunch?.(projectId, threadId, directory)
    const reused = await this.reuseOvenSession(id, remote)
    if (reused) return reused
    if (remote) return this.createRemote(id, projectId, threadId, cols, rows, remote)

    const project = await this.projectManager.getProject(projectId)
    if (!project || project.hidden || project.source !== 'local' || !project.path) {
      throw new Error(`Terminal sessions require a local ${APP_NAME} project`)
    }

    // Resolve the terminal root through the scope when one is supplied; a
    // managed scope's worktree is captured here and kept for the session
    // lifetime, even if the UI later switches scope. An explicit starting
    // directory (the file tree's "Open in terminal") is resolved against that
    // root and must stay inside it.
    const baseCwd =
      scopeBucketId && this.scopeRoots
        ? await this.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
        : project.path
    if (!baseCwd || !existsSync(baseCwd)) {
      throw new Error(`Project directory is unavailable`)
    }
    const cwd = directory === undefined ? baseCwd : resolveStartingDirectory(baseCwd, directory)

    const shell = resolveShell()
    const createdAt = Date.now()

    const proc = pty.spawn(shell, resolveShellArgs(shell), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: buildShellEnv()
    })
    this.trackProcess?.({
      scopeId: `pty:${id}`,
      projectId,
      threadId,
      pid: proc.pid,
      command: shell,
      cwd
    })

    proc.onData((data) => {
      sendToRenderer(this.sender, `pty:data:${id}`, data)
    })

    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id)
      sendToRenderer(this.sender, `pty:exit:${id}`, exitCode)
      void this.recordEvent({
        type: 'exit',
        terminalId: id,
        projectId,
        cwd,
        shell,
        pid: proc.pid,
        exitCode,
        timestamp: Date.now()
      })
    })

    this.sessions.set(id, {
      id,
      process: proc,
      projectId,
      cwd,
      shell,
      createdAt,
      lastActivityAt: createdAt
    })
    await this.recordEvent({
      type: 'create',
      terminalId: id,
      projectId,
      cwd,
      shell,
      pid: proc.pid,
      source: 'user_terminal',
      timestamp: createdAt
    })
    return { id, pid: proc.pid }
  }

  private async createRemote(
    id: string,
    projectId: string,
    threadId: string,
    cols: number,
    rows: number,
    launch: PtyRemoteLaunch
  ): Promise<{ id: string; pid: number }> {
    let proc: pty.IPty
    try {
      proc = pty.spawn(launch.executable, launch.args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: launch.localCwd,
        env: { ...launch.environment, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
      })
    } catch (error) {
      await launch.dispose()
      throw error
    }
    const createdAt = Date.now()
    this.trackProcess?.({
      scopeId: `pty:${id}`,
      projectId,
      threadId,
      pid: proc.pid,
      command: 'ssh',
      cwd: launch.remoteCwd
    })
    proc.onData((data) => {
      const session = this.sessions.get(id)
      if (session) session.lastActivityAt = Date.now()
      sendToRenderer(this.sender, `pty:data:${id}`, data)
    })
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id)
      sendToRenderer(this.sender, `pty:exit:${id}`, exitCode)
      void launch.dispose().catch(() => Logger.dev('Oven terminal credential cleanup failed'))
      void this.recordEvent({
        type: 'exit',
        terminalId: id,
        projectId,
        cwd: launch.remoteCwd,
        shell: 'ssh',
        pid: proc.pid,
        exitCode,
        timestamp: Date.now()
      })
    })
    this.sessions.set(id, {
      id,
      projectId,
      process: proc,
      cwd: launch.remoteCwd,
      shell: 'ssh',
      remote: true,
      ovenId: launch.ovenId,
      createdAt,
      lastActivityAt: createdAt
    })
    await this.recordEvent({
      type: 'create',
      terminalId: id,
      projectId,
      cwd: launch.remoteCwd,
      shell: 'ssh',
      pid: proc.pid,
      source: 'oven_terminal',
      timestamp: createdAt
    })
    return { id, pid: proc.pid }
  }

  private async recordEvent(event: Record<string, unknown>): Promise<void> {
    try {
      await this.storage.appendRaw(
        dailyLogRelativePath(PTY_EVENTS_LOG_FILE),
        `${JSON.stringify(event)}\n`
      )
    } catch (error) {
      Logger.error('PTY provenance write failed:', error)
    }
  }

  /**
   * Spawn a single command in its own PTY, rooted at the user's home directory.
   * Used for in-UI harness login flows (`opencode auth login --provider …`),
   * harness self-updates (`opencode upgrade`), and documented uninstall
   * handoffs (`npm uninstall -g …`). Only known harness binaries and the
   * package managers/tools used by handoffs are accepted.
   */
  private async createCommand(
    id: string,
    command: string,
    args: string[],
    cols: number,
    rows: number,
    idleTimeoutMs?: number,
    environment?: Record<string, string>
  ): Promise<{ id: string; pid: number }> {
    if (!ALLOWED_COMMANDS.has(normalizedCommandName(command))) {
      throw new Error(`Refusing to start unknown harness command: ${command}`)
    }

    const reused = this.reuseLiveSession(id)
    if (reused) return reused

    const cwd = homedir()
    const createdAt = Date.now()

    const proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...buildShellEnv(), ...safeCommandEnvironment(environment) }
    })
    this.trackProcess?.({
      pid: proc.pid,
      command: [command, ...args].join(' '),
      cwd
    })

    proc.onData((data) => {
      const session = this.sessions.get(id)
      if (session) session.lastActivityAt = Date.now()
      sendToRenderer(this.sender, `pty:data:${id}`, data)
    })

    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id)
      sendToRenderer(this.sender, `pty:exit:${id}`, exitCode)
      void this.recordEvent({
        type: 'exit',
        terminalId: id,
        cwd,
        shell: command,
        pid: proc.pid,
        exitCode,
        timestamp: Date.now()
      })
    })

    this.sessions.set(id, {
      id,
      process: proc,
      projectId: '',
      cwd,
      shell: command,
      createdAt,
      idleTimeoutMs: idleTimeoutMs && idleTimeoutMs > 0 ? idleTimeoutMs : undefined,
      lastActivityAt: createdAt
    })
    await this.recordEvent({
      type: 'create',
      terminalId: id,
      cwd,
      shell: command,
      pid: proc.pid,
      source: 'provider_login',
      timestamp: createdAt
    })
    return { id, pid: proc.pid }
  }

  /**
   * Kill single-command sessions (harness self-updates, logins) that have been
   * completely silent   no output and no input   past their idle timeout, so a
   * hung update never pins the terminal until the app is restarted.
   */
  private ensureIdleWatchdog(): void {
    if (this.idleWatchdog) return
    this.idleWatchdog = setInterval(() => {
      const now = Date.now()
      for (const session of this.sessions.values()) {
        if (!session.idleTimeoutMs) continue
        if (now - session.lastActivityAt < session.idleTimeoutMs) continue
        Logger.info(
          `[pty] Session ${session.id} (${session.shell}) idle for ${Math.round(
            (now - session.lastActivityAt) / 1000
          )}s   killing hung process`
        )
        session.process.write(
          `\r\n\x1b[33m[${APP_NAME}] No activity for ${Math.round(
            session.idleTimeoutMs / 1000
          )}s   the process appears hung and was stopped automatically.\x1b[0m\r\n`
        )
        // Give the notice a moment to flush before the PTY goes away.
        setTimeout(() => this.destroy(session.id), 300)
      }
    }, IDLE_WATCHDOG_INTERVAL_MS)
    // Never keep the Electron main process alive just for the watchdog.
    this.idleWatchdog.unref()
  }

  private async createAction(
    id: string,
    projectId: string,
    threadId: string,
    script: string,
    variables: Record<string, string>,
    cols: number,
    rows: number,
    scopeBucketId?: string
  ): Promise<{ id: string; pid: number }> {
    const remote = await this.remoteLaunch?.(projectId, threadId, undefined, script, variables)
    const reused = await this.reuseOvenSession(id, remote)
    if (reused) return reused
    if (remote) return this.createRemote(id, projectId, threadId, cols, rows, remote)

    const project = await this.projectManager.getProject(projectId)
    if (!project || project.hidden || project.source !== 'local' || !project.path) {
      throw new Error(`Actions require a local ${APP_NAME} project`)
    }
    if (!script.trim() || script.length > 100_000) throw new Error('Action script is invalid')
    const safeVariables = Object.fromEntries(
      Object.entries(variables).filter(
        ([name, value]) => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) && typeof value === 'string'
      )
    )

    // Resolve the action root through the active thread's scope when one is
    // supplied, so scripts run inside the checked-out worktree instead of the
    // main project directory   matching interactive terminal behavior.
    const cwd =
      scopeBucketId && this.scopeRoots
        ? await this.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
        : project.path
    if (!cwd || !existsSync(cwd)) {
      throw new Error(`Project directory is unavailable`)
    }

    const shell = resolveShell()
    const createdAt = Date.now()
    const proc = pty.spawn(shell, ['-lc', script], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: { ...buildShellEnv(), ...safeVariables }
    })
    this.trackProcess?.({
      scopeId: `pty:${id}`,
      projectId,
      threadId,
      pid: proc.pid,
      command: script,
      cwd
    })
    proc.onData((data) => sendToRenderer(this.sender, `pty:data:${id}`, data))
    proc.onExit(({ exitCode }) => {
      this.sessions.delete(id)
      sendToRenderer(this.sender, `pty:exit:${id}`, exitCode)
      void this.recordEvent({
        type: 'exit',
        terminalId: id,
        projectId,
        cwd,
        shell,
        pid: proc.pid,
        exitCode,
        timestamp: Date.now()
      })
    })
    this.sessions.set(id, {
      id,
      process: proc,
      projectId,
      cwd,
      shell,
      createdAt,
      lastActivityAt: createdAt
    })
    await this.recordEvent({
      type: 'create',
      terminalId: id,
      projectId,
      cwd,
      shell,
      pid: proc.pid,
      source: 'project_action',
      timestamp: createdAt
    })
    return { id, pid: proc.pid }
  }

  private write(id: string, data: string): void {
    const session = this.sessions.get(id)
    if (!session) return
    if (session.idleTimeoutMs) session.lastActivityAt = Date.now()
    // The keystroke reaches the PTY first, always: the user-activity hook below
    // is best-effort and must never be able to swallow terminal input.
    session.process.write(data)
    // Any user keystroke (including pastes) keeps the user-activity window
    // open so their commands' file writes are never claimed by an agent turn.
    // Command sessions (harness logins/updates) carry no project, so there is
    // nothing to attribute and the hook is skipped entirely.
    if (data.length > 0 && this.onUserInput && session.projectId && !session.remote) {
      try {
        this.onUserInput(session.projectId, session.cwd)
      } catch (error) {
        Logger.error('user-input activity hook failed:', error)
      }
    }
  }

  private resize(id: string, cols: number, rows: number): void {
    try {
      this.sessions.get(id)?.process.resize(cols, rows)
    } catch {
      // Ignore resize errors on dead sessions
    }
  }

  private destroy(id: string): void {
    const session = this.sessions.get(id)
    if (session) {
      try {
        session.process.kill()
      } catch {
        // Process may already be dead
      }
      this.sessions.delete(id)
    }
  }

  destroyAll(): void {
    this.sender = null
    if (this.idleWatchdog) {
      clearInterval(this.idleWatchdog)
      this.idleWatchdog = null
    }
    for (const id of this.sessions.keys()) {
      this.destroy(id)
    }
  }

  /** Number of live terminal sessions   any of which a forced restart would kill. */
  activeSessionCount(): number {
    return this.sessions.size
  }
}
