import type { WebContents } from 'electron'
import { trustedIpcMain as ipcMain } from '../ipc/trusted-ipc-main'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { basename } from 'path'
import * as pty from 'node-pty'
import { APP_NAME } from '../../lib/brand'
import { Logger } from './logger'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { ProjectManager } from '../../lib/engines/project-manager'
import type { Database } from '../database/database'
import type { StorageEngine } from '../storage/storage-engine'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { scopeRootProvider, type ScopeRootResolver } from '../workspaces/scope-root-resolver'

interface PtySession {
  id: string
  projectId: string
  cwd: string
  shell: string
  createdAt: number
  process: pty.IPty
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
  private sender: WebContents | null = null
  private projectManager: ProjectManager
  private scopeRoots

  constructor(
    private storage: StorageEngine,
    _database: Database,
    scopeResolver?: ScopeRootResolver,
    private readonly trackProcess?: (process: PtyTrackedProcess) => void,
    private readonly onUserInput?: PtyUserInputHook
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
    ipcMain.handle(
      'pty:create',
      (
        _,
        id: string,
        projectId: string,
        threadId: string,
        cols: number,
        rows: number,
        scopeBucketId?: string
      ) => this.create(id, projectId, threadId, cols, rows, scopeBucketId)
    )
    ipcMain.handle(
      'pty:createCommand',
      (_, id: string, command: string, args: string[], cols: number, rows: number) =>
        this.createCommand(id, command, args, cols, rows)
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

  private async create(
    id: string,
    projectId: string,
    threadId: string,
    cols: number,
    rows: number,
    scopeBucketId?: string
  ): Promise<{ id: string; pid: number }> {
    const project = await this.projectManager.getProject(projectId)
    if (!project || project.hidden || project.source !== 'local' || !project.path) {
      throw new Error(`Terminal sessions require a local ${APP_NAME} project`)
    }

    // Resolve the terminal root through the scope when one is supplied; a
    // managed scope's worktree is captured here and kept for the session
    // lifetime, even if the UI later switches scope.
    const cwd =
      scopeBucketId && this.scopeRoots
        ? await this.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
        : project.path
    if (!cwd || !existsSync(cwd)) {
      throw new Error(`Project directory is unavailable`)
    }

    // Tear down any existing session with the same id
    this.destroy(id)

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
      createdAt
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

  private async recordEvent(event: Record<string, unknown>): Promise<void> {
    try {
      await this.storage.appendRaw('logs/pty-events.jsonl', `${JSON.stringify(event)}\n`)
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
    rows: number
  ): Promise<{ id: string; pid: number }> {
    const allowed = new Set([
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
      'git'
    ])
    if (!allowed.has(basename(command))) {
      throw new Error(`Refusing to start unknown harness command: ${command}`)
    }

    this.destroy(id)
    const cwd = homedir()
    const createdAt = Date.now()

    const proc = pty.spawn(command, args, {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env: buildShellEnv()
    })
    this.trackProcess?.({
      pid: proc.pid,
      command: [command, ...args].join(' '),
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
      createdAt
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
    // main project directory — matching interactive terminal behavior.
    const cwd =
      scopeBucketId && this.scopeRoots
        ? await this.scopeRoots.resolveCompatibilityRoot(projectId, scopeBucketId)
        : project.path
    if (!cwd || !existsSync(cwd)) {
      throw new Error(`Project directory is unavailable`)
    }

    this.destroy(id)
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
    this.sessions.set(id, { id, process: proc, projectId, cwd, shell, createdAt })
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
    // Any user keystroke (including pastes) keeps the user-activity window
    // open so their commands' file writes are never claimed by an agent turn.
    if (data.length > 0 && this.onUserInput) {
      this.onUserInput(session.projectId, session.cwd)
    }
    session.process.write(data)
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
    for (const id of this.sessions.keys()) {
      this.destroy(id)
    }
  }

  /** Number of live terminal sessions — any of which a forced restart would kill. */
  activeSessionCount(): number {
    return this.sessions.size
  }
}
