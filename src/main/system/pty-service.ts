import { pathIsAccessible } from '../../lib/utils'
import { PtyOutputBuffer } from './pty-output-buffer'
import { stopPtyProcesses } from './pty-process-stop'
import type { WebContents } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { realpath, stat } from 'fs/promises'
import { homedir } from 'os'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import * as pty from 'node-pty'
import { APP_NAME } from '../../lib/brand'
import { prepareWindowsGitRuntime } from '../drivers/windows-git-runtime'
import type { UpdateBlockerTerminal } from '../../lib/ipc-contract'
import { Logger } from './logger'
import { dailyLogRelativePath, PTY_EVENTS_LOG_FILE } from './log-paths'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { ProjectManager } from '../../lib/engines/project-manager'
import type { Database } from '../database/database'
import type { StorageEngine } from '../storage/storage-engine'
import { buildProcessEnvironmentAsync } from '../drivers/cli-environment'
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
/**
 * Prepare one plain shell on an Oven, not tied to a chat or a checkout.
 *
 * `pty:createOven` uses this when the user opens an Oven from Settings, where
 * there is no thread to route through: the launch lands in the Oven's home
 * directory instead of a project checkout.
 */
export interface PtyOvenShellLaunchHook {
  (ovenId: string): Promise<PtyRemoteLaunch>
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
  /** A watchdog stop is a failure even if the shell reports a clean exit. */
  exitCodeOverride?: number
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

async function buildShellEnv(): Promise<Record<string, string>> {
  const harnessEnv = await buildProcessEnvironmentAsync()
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
async function resolveStartingDirectory(baseCwd: string, directory: string): Promise<string> {
  if (directory.includes('\0')) {
    throw new Error('Terminal directory is invalid')
  }
  let real: string
  try {
    real = await realpath(resolve(baseCwd, directory))
  } catch {
    throw new Error('Terminal directory is unavailable')
  }
  let isDirectory: boolean
  try {
    isDirectory = (await stat(real)).isDirectory()
  } catch {
    isDirectory = false
  }
  if (!isDirectory) {
    throw new Error('Terminal path is not a directory')
  }
  const root = await realpath(baseCwd)
  const contained = relative(root, real)
  if (contained.startsWith('..') || isAbsolute(contained)) {
    throw new Error('Terminal directory is outside the project')
  }
  return real
}

/** Prefer Git Bash on Windows, with native shells available offline. */
async function resolveShell(): Promise<string> {
  if (process.platform === 'win32') {
    const bash = (await buildProcessEnvironmentAsync())['CLAUDE_CODE_GIT_BASH_PATH']
    if (bash && (await pathIsAccessible(bash))) return bash
    const systemRoot = process.env['SystemRoot'] || 'C:\\Windows'
    const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    if (await pathIsAccessible(powershell)) return powershell
    return (
      process.env['ComSpec'] || process.env['COMSPEC'] || join(systemRoot, 'System32', 'cmd.exe')
    )
  }
  const preferred = process.env['SHELL']
  if (preferred && (await pathIsAccessible(preferred))) return preferred
  if (await pathIsAccessible('/bin/zsh')) return '/bin/zsh'
  if (await pathIsAccessible('/bin/bash')) return '/bin/bash'
  return '/bin/sh'
}

/** Match the login-shell behavior users expect from a desktop terminal. */
function resolveShellArgs(shell: string): string[] {
  switch (basename(shell)) {
    case 'bash.exe':
      return ['-l']
    case 'powershell.exe':
    case 'pwsh.exe':
      return ['-NoLogo', '-NoProfile']
    case 'cmd.exe':
      return ['/d']
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

function resolveShellCommandArgs(shell: string, script: string): string[] {
  if (process.platform !== 'win32' || basename(shell).toLowerCase() === 'bash.exe')
    return ['-lc', script]
  if (basename(shell).toLowerCase() === 'cmd.exe') return ['/d', '/s', '/c', script]
  return [
    ...resolveShellArgs(shell),
    '-NonInteractive',
    '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')
  ]
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
  private readonly commandOutput = new Map<string, PtyOutputBuffer>()
  private sender: WebContents | null = null
  private projectManager: ProjectManager
  private scopeRoots

  constructor(
    private storage: StorageEngine,
    _database: Database,
    scopeResolver?: ScopeRootResolver,
    private readonly trackProcess?: (process: PtyTrackedProcess) => void,
    private readonly onUserInput?: PtyUserInputHook,
    private readonly remoteLaunch?: PtyRemoteLaunchHook,
    private readonly ovenShellLaunch?: PtyOvenShellLaunchHook
  ) {
    this.projectManager = new ProjectManager(_database)
    this.scopeRoots = scopeResolver ? scopeRootProvider(scopeResolver) : undefined
  }

  private readonly pendingStarts = new Map<
    string,
    { cancelled: boolean; promise: Promise<{ id: string; pid: number }> }
  >()
  private stopped = false

  private start(
    id: string,
    work: (ensureActive: () => void) => Promise<{ id: string; pid: number }>
  ): Promise<{ id: string; pid: number }> {
    if (this.stopped) return Promise.reject(new Error('Terminal service has stopped'))
    const existing = this.pendingStarts.get(id)
    if (existing) return existing.promise
    const pending = { cancelled: false, promise: Promise.resolve({ id, pid: 0 }) }
    const ensureActive = (): void => {
      if (pending.cancelled || this.stopped) throw new Error('Terminal creation was cancelled')
    }
    pending.promise = Promise.resolve()
      .then(() => {
        ensureActive()
        return work(ensureActive).then((result) => {
          ensureActive()
          return result
        })
      })
      .finally(() => {
        if (this.pendingStarts.get(id) === pending) this.pendingStarts.delete(id)
      })
    this.pendingStarts.set(id, pending)
    return pending.promise
  }

  /**
   * Publish a spawned session, unless its creation was cancelled in the interval
   * between the spawn and this call.
   *
   * The renderer destroys a terminal the moment it closes one, and that destroy
   * can land inside a creation that is still awaiting its environment or its
   * remote handoff. Registering the session unconditionally in that window left a
   * shell running with no session on the books: nothing tracked it, nothing could
   * stop it, and its output went to a renderer that had already dropped the
   * terminal. A cancelled start kills the process it created instead, and reports
   * the cancellation to its caller.
   */
  private commitSession(
    id: string,
    session: PtySession,
    ensureActive: () => void
  ): { id: string; pid: number } {
    try {
      ensureActive()
    } catch (error) {
      // The user already closed this terminal, so nothing should be left
      // running: stop the whole tree now rather than only the shell.
      void stopPtyProcesses(session.process.pid, { graceMs: 0 })
      throw error
    }
    this.sessions.set(id, session)
    return { id, pid: session.process.pid }
  }

  private create(
    id: string,
    projectId: string,
    threadId: string,
    cols: number,
    rows: number,
    scopeBucketId?: string,
    directory?: string
  ): Promise<{ id: string; pid: number }> {
    return this.start(id, (check) =>
      this.createSession(id, projectId, threadId, cols, rows, scopeBucketId, directory, check)
    )
  }
  private createOven(
    id: string,
    ovenId: string,
    cols: number,
    rows: number
  ): Promise<{ id: string; pid: number }> {
    return this.start(id, (check) => this.createOvenSession(id, ovenId, cols, rows, check))
  }
  private createCommand(
    id: string,
    command: string,
    args: string[],
    cols: number,
    rows: number,
    idleTimeoutMs?: number,
    environment?: Record<string, string>
  ): Promise<{ id: string; pid: number }> {
    return this.start(id, (check) =>
      this.createCommandSession(id, command, args, cols, rows, idleTimeoutMs, environment, check)
    )
  }
  private createAction(
    id: string,
    projectId: string,
    threadId: string,
    script: string,
    variables: Record<string, string>,
    cols: number,
    rows: number,
    scopeBucketId?: string
  ): Promise<{ id: string; pid: number }> {
    return this.start(id, (check) =>
      this.createActionSession(
        id,
        projectId,
        threadId,
        script,
        variables,
        cols,
        rows,
        scopeBucketId,
        check
      )
    )
  }

  private async prepareWindowsShell(): Promise<void> {
    if (process.platform !== 'win32') return
    try {
      await prepareWindowsGitRuntime()
    } catch (error) {
      Logger.info('Windows Git setup unavailable; continuing with a native terminal', error)
    }
  }

  attach(sender: WebContents): void {
    this.sender = sender
  }

  detach(): void {
    this.sender = null
  }

  register(): void {
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
    ipcMain.handle('pty:createOven', (_, id: string, ovenId: string, cols: number, rows: number) =>
      this.createOven(id, ovenId, cols, rows)
    )
    ipcMain.on('pty:ack', (event, id: unknown, length: unknown) => {
      if (event.sender !== this.sender || typeof id !== 'string' || typeof length !== 'number')
        return
      this.commandOutput.get(id)?.acknowledge(length)
    })
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

  private async createSession(
    id: string,
    projectId: string,
    threadId: string,
    cols: number,
    rows: number,
    scopeBucketId?: string,
    directory?: string,
    ensureActive: () => void = () => undefined
  ): Promise<{ id: string; pid: number }> {
    const remote = await this.remoteLaunch?.(projectId, threadId, directory)
    try {
      ensureActive()
    } catch (error) {
      await remote?.dispose()
      throw error
    }
    const reused = await this.reuseOvenSession(id, remote)
    if (reused) {
      ensureActive()
      return reused
    }
    if (remote) return this.createRemote(id, projectId, threadId, cols, rows, remote, ensureActive)

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
    if (!baseCwd || !(await pathIsAccessible(baseCwd))) {
      throw new Error(`Project directory is unavailable`)
    }
    const cwd =
      directory === undefined ? baseCwd : await resolveStartingDirectory(baseCwd, directory)

    await this.prepareWindowsShell()
    const shell = await resolveShell()
    const createdAt = Date.now()

    const env = await buildShellEnv()
    ensureActive()
    const proc = pty.spawn(shell, resolveShellArgs(shell), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
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
      if (this.sessions.get(id)?.process !== proc) return
      sendToRenderer(this.sender, `pty:data:${id}`, data)
    })

    proc.onExit(({ exitCode }) => {
      if (this.sessions.get(id)?.process !== proc) return
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

    this.commitSession(
      id,
      {
        id,
        process: proc,
        projectId,
        cwd,
        shell,
        createdAt,
        lastActivityAt: createdAt
      },
      ensureActive
    )
    void this.recordEvent({
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

  /**
   * Open a plain shell on one Oven, with no chat or checkout behind it.
   *
   * The renderer asks for this from Settings, where no thread exists to route
   * through, so the launch comes from the dedicated Oven-shell hook and lands in
   * the Oven's home directory. A live session under the same id is reattached
   * rather than respawned, exactly like a thread terminal.
   */
  private async createOvenSession(
    id: string,
    ovenId: string,
    cols: number,
    rows: number,
    ensureActive: () => void = () => undefined
  ): Promise<{ id: string; pid: number }> {
    if (!this.ovenShellLaunch) throw new Error(`This build cannot open an ${APP_NAME} Oven shell.`)
    const launch = await this.ovenShellLaunch(ovenId)
    try {
      ensureActive()
    } catch (error) {
      await launch.dispose()
      throw error
    }
    const reused = await this.reuseOvenSession(id, launch)
    if (reused) {
      ensureActive()
      return reused
    }
    return this.createRemote(id, '', '', cols, rows, launch, ensureActive)
  }

  private async createRemote(
    id: string,
    projectId: string,
    threadId: string,
    cols: number,
    rows: number,
    launch: PtyRemoteLaunch,
    ensureActive: () => void
  ): Promise<{ id: string; pid: number }> {
    let proc: pty.IPty
    try {
      ensureActive()
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
      if (this.sessions.get(id)?.process !== proc) return
      const session = this.sessions.get(id)
      if (session) session.lastActivityAt = Date.now()
      sendToRenderer(this.sender, `pty:data:${id}`, data)
    })
    proc.onExit(({ exitCode }) => {
      void launch.dispose().catch(() => Logger.dev('Oven terminal credential cleanup failed'))
      if (this.sessions.get(id)?.process !== proc) return
      this.sessions.delete(id)
      sendToRenderer(this.sender, `pty:exit:${id}`, exitCode)
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
    try {
      this.commitSession(
        id,
        {
          id,
          projectId,
          process: proc,
          cwd: launch.remoteCwd,
          shell: 'ssh',
          remote: true,
          ovenId: launch.ovenId,
          createdAt,
          lastActivityAt: createdAt
        },
        ensureActive
      )
    } catch (error) {
      // The handoff's own credentials must not outlive a launch the caller
      // cancelled; its local ssh process is already killed by the commit.
      await launch.dispose()
      throw error
    }
    void this.recordEvent({
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
  private async createCommandSession(
    id: string,
    command: string,
    args: string[],
    cols: number,
    rows: number,
    idleTimeoutMs?: number,
    environment?: Record<string, string>,
    ensureActive: () => void = () => undefined
  ): Promise<{ id: string; pid: number }> {
    if (!ALLOWED_COMMANDS.has(normalizedCommandName(command))) {
      throw new Error(`Refusing to start unknown harness command: ${command}`)
    }

    const reused = this.reuseLiveSession(id)
    if (reused) {
      ensureActive()
      return reused
    }

    const cwd = homedir()
    const createdAt = Date.now()

    const env = { ...(await buildShellEnv()), ...safeCommandEnvironment(environment) }
    ensureActive()
    const proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })
    this.trackProcess?.({
      pid: proc.pid,
      command: [command, ...args].join(' '),
      cwd
    })

    const output = new PtyOutputBuffer(proc, (data) =>
      sendToRenderer(this.sender, `pty:data:${id}`, data)
    )
    this.commandOutput.get(id)?.dispose()
    this.commandOutput.set(id, output)
    proc.onData((data) => {
      if (this.sessions.get(id)?.process !== proc) return
      const session = this.sessions.get(id)
      if (session) session.lastActivityAt = Date.now()
      output.push(data)
    })

    proc.onExit(({ exitCode }) => {
      if (this.sessions.get(id)?.process !== proc) return
      exitCode = this.sessions.get(id)?.exitCodeOverride ?? exitCode
      this.sessions.delete(id)
      output.end(() => {
        if (this.commandOutput.get(id) !== output) return
        this.commandOutput.delete(id)
        sendToRenderer(this.sender, `pty:exit:${id}`, exitCode)
      })
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

    try {
      this.commitSession(
        id,
        {
          id,
          process: proc,
          projectId: '',
          cwd,
          shell: command,
          createdAt,
          idleTimeoutMs: idleTimeoutMs && idleTimeoutMs > 0 ? idleTimeoutMs : undefined,
          lastActivityAt: createdAt
        },
        ensureActive
      )
    } catch (error) {
      // A cancelled command keeps no paced buffer: its pump is disposed here so
      // the killed process's remaining output cannot outlive the session.
      if (this.commandOutput.get(id) === output) this.commandOutput.delete(id)
      output.dispose()
      throw error
    }
    // The one kind of session the watchdog exists for is now on the books.
    this.syncIdleWatchdog()
    void this.recordEvent({
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
   *
   * Armed by {@link syncIdleWatchdog}, which is what keeps the interval off the
   * books while no session carries a timeout. A pass that finds nothing left to
   * watch puts it back off.
   */
  private ensureIdleWatchdog(): void {
    if (this.idleWatchdog) return
    this.idleWatchdog = setInterval(() => {
      this.sweepIdleSessions()
      // A single-command session that has exited or has already been killed
      // leaves nothing for the next pass to look at.
      this.syncIdleWatchdog()
    }, IDLE_WATCHDOG_INTERVAL_MS)
    // Never keep the Electron main process alive just for the watchdog.
    this.idleWatchdog.unref()
  }

  /**
   * Whether a hung session could still be caught: only a single-command session
   * carries an idle timeout, and every other kind is skipped by the pass above.
   */
  private hasTimedSession(): boolean {
    for (const session of this.sessions.values()) {
      if (session.idleTimeoutMs) return true
    }
    return false
  }

  /** Arm the watchdog for a timed session, or clear it when the last one is gone. */
  private syncIdleWatchdog(): void {
    if (this.hasTimedSession()) this.ensureIdleWatchdog()
    else this.stopIdleWatchdog()
  }

  private stopIdleWatchdog(): void {
    if (!this.idleWatchdog) return
    clearInterval(this.idleWatchdog)
    this.idleWatchdog = null
  }

  private sweepIdleSessions(): void {
    const now = Date.now()
    for (const session of this.sessions.values()) {
      if (!session.idleTimeoutMs) continue
      if (now - session.lastActivityAt < session.idleTimeoutMs) continue
      Logger.info(
        `[pty] Session ${session.id} (${session.shell}) idle for ${Math.round(
          (now - session.lastActivityAt) / 1000
        )}s   killing hung process`
      )
      sendToRenderer(
        this.sender,
        `pty:data:${session.id}`,
        `\r\n\x1b[33m[${APP_NAME}] No activity for ${Math.round(
          session.idleTimeoutMs / 1000
        )}s   the process appears hung and was stopped automatically.\x1b[0m\r\n`
      )
      // Give the notice a moment to flush before the PTY goes away.
      setTimeout(() => {
        if (this.sessions.get(session.id) === session) {
          session.exitCodeOverride = 1
          session.idleTimeoutMs = undefined
          this.sessions.delete(session.id)
          void stopPtyProcesses(session.process.pid, { graceMs: 0 }).catch(() => {
            sendToRenderer(this.sender, `pty:exit:${session.id}`, 1)
          })
        }
      }, 300)
    }
  }

  private async createActionSession(
    id: string,
    projectId: string,
    threadId: string,
    script: string,
    variables: Record<string, string>,
    cols: number,
    rows: number,
    scopeBucketId?: string,
    ensureActive: () => void = () => undefined
  ): Promise<{ id: string; pid: number }> {
    const remote = await this.remoteLaunch?.(projectId, threadId, undefined, script, variables)
    try {
      ensureActive()
    } catch (error) {
      await remote?.dispose()
      throw error
    }
    const reused = await this.reuseOvenSession(id, remote)
    if (reused) {
      ensureActive()
      return reused
    }
    if (remote) return this.createRemote(id, projectId, threadId, cols, rows, remote, ensureActive)

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
    if (!cwd || !(await pathIsAccessible(cwd))) {
      throw new Error(`Project directory is unavailable`)
    }

    await this.prepareWindowsShell()
    const shell = await resolveShell()
    const createdAt = Date.now()
    const env = { ...(await buildShellEnv()), ...safeVariables }
    ensureActive()
    const proc = pty.spawn(shell, resolveShellCommandArgs(shell, script), {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env
    })
    this.trackProcess?.({
      scopeId: `pty:${id}`,
      projectId,
      threadId,
      pid: proc.pid,
      command: script,
      cwd
    })
    proc.onData((data) => {
      if (this.sessions.get(id)?.process === proc)
        sendToRenderer(this.sender, `pty:data:${id}`, data)
    })
    proc.onExit(({ exitCode }) => {
      if (this.sessions.get(id)?.process !== proc) return
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
    this.commitSession(
      id,
      {
        id,
        process: proc,
        projectId,
        cwd,
        shell,
        createdAt,
        lastActivityAt: createdAt
      },
      ensureActive
    )
    void this.recordEvent({
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

  /**
   * Close one terminal and stop everything it was running.
   *
   * Resolves once the session's process tree is gone, so a caller that stops a
   * harness install/update and then re-probes the harness reads the state that
   * exists after the stop, not the one it is still racing.
   */
  private async destroy(id: string): Promise<void> {
    const pending = this.pendingStarts.get(id)
    if (pending) pending.cancelled = true
    this.pendingStarts.delete(id)
    this.commandOutput.get(id)?.dispose()
    this.commandOutput.delete(id)
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    await stopPtyProcesses(session.process.pid)
  }

  destroyAll(): void {
    this.stopped = true
    for (const pending of this.pendingStarts.values()) pending.cancelled = true
    this.pendingStarts.clear()
    for (const output of this.commandOutput.values()) output.dispose()
    this.commandOutput.clear()
    this.sender = null
    this.stopIdleWatchdog()
    for (const id of [...this.sessions.keys()]) {
      void this.destroy(id)
    }
  }

  /** Number of live terminal sessions   any of which a forced restart would kill. */
  activeSessionCount(): number {
    return this.sessions.size
  }

  /**
   * The live sessions, as the force-install modal lists them. Oldest first, so
   * the row a user recognises as "the one I left running" is at the top.
   *
   * The shell is reduced to its own name because the stored value is an absolute
   * path, and a row reading `/opt/homebrew/bin/fish` says less than `fish` does
   * next to the directory it was opened in.
   */
  describeSessions(): UpdateBlockerTerminal[] {
    return [...this.sessions.values()]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((session) => ({
        sessionId: session.id,
        shell: basename(session.shell),
        cwd: session.cwd
      }))
  }

  /**
   * Tell the renderer that these sessions are being ended on purpose, so it does
   * not restart the shells it would otherwise treat as crashed.
   *
   * This is what makes a stop stick. The renderer respawns a shell that exits on
   * its own, exactly like a desktop terminal, so a stop the app performs without
   * this announcement comes straight back: the update gate then never sees its
   * terminal count reach zero, and a task-manager kill looks as if it was
   * ignored. Sent before the kill, so the renderer has already marked the session
   * when its exit arrives.
   */
  private announceStoppedSessions(ids: readonly string[]): void {
    if (ids.length === 0) return
    sendToRenderer(this.sender, 'pty:sessionsClosed', [...ids])
  }

  /** Live session ids whose shell process is `pid`. */
  private sessionIdsForPid(pid: number): string[] {
    const ids: string[] = []
    for (const session of this.sessions.values()) {
      if (session.process.pid === pid) ids.push(session.id)
    }
    return ids
  }

  /**
   * Announce the stop of the session whose shell process is `pid`, for a kill
   * that happens outside this service (the task manager ending an app-owned
   * pid). Returns whether any live session matched.
   *
   * Only the announcement happens here: the caller owns the kill, and this is
   * purely what keeps the renderer from respawning the shell behind it.
   */
  announceStopForPid(pid: number): boolean {
    const ids = this.sessionIdsForPid(pid)
    if (ids.length === 0) return false
    this.announceStoppedSessions(ids)
    return true
  }

  /**
   * Kill every live shell and forget the sessions, leaving the renderer binding
   * and the idle watchdog alone.
   *
   * Deliberately distinct from {@link destroyAll}, which is the shutdown path and
   * also drops the transport: this one is a UI action that stops work, so it must
   * not have side effects beyond the shells the user was shown. Each shell is
   * killed exactly as a normal close kills it, so it still gets the chance to
   * exit cleanly on the hangup instead of being orphaned.
   *
   * Announced first, because a killed shell the renderer reads as a crash is
   * respawned within milliseconds and the stop the caller asked for would never
   * take effect.
   */
  closeAllSessions(): void {
    const ids = [...new Set([...this.sessions.keys(), ...this.pendingStarts.keys()])]
    this.announceStoppedSessions(ids)
    for (const id of ids) {
      void this.destroy(id)
    }
  }
}
