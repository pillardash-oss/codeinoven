/**
 * Install a pre-exec env hook into one interactive terminal session.
 *
 * A shell is spawned before the user has typed anything, so the app cannot know
 * which command will run. The hook in `lib/terminal-env-hook` hands each accepted
 * line to the app and exports only the values that line's inject rule admits, then
 * takes them back after the command. This module owns the session directory, the
 * startup files, and the watcher that answers each request.
 *
 * Everything here degrades to "no values for this command": a request that arrives
 * after the shell stopped waiting, a resolver that throws, or a directory that
 * vanished never blocks or breaks the user's shell.
 */

import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { watch, type FSWatcher } from 'fs'
import { homedir } from 'os'
import { basename, join } from 'path'
import { getConfigRoot } from '../../lib/utils'
import { Logger } from './logger'
import {
  TERMINAL_ENV_HOOK_COMMAND_LIMIT,
  bashRcFile,
  hookEnvironment,
  hookScript,
  parseHookRequest,
  responseScript,
  undoScript,
  terminalEnvHookShell,
  zshRcFiles,
  type TerminalEnvHookShell
} from '../../lib/terminal-env-hook'

/** Directory mode for a session: the values passing through it are the user's. */
const SESSION_DIRECTORY_MODE = 0o700
/** File mode for everything inside a session directory. */
const SESSION_FILE_MODE = 0o600
/** Root of every hook session, under the app's own data root. */
const HOOK_ROOT = 'runtime/env-hook'

/** One resolved shell command, as the hook asks for it. */
export interface TerminalEnvHookResolution {
  /** The shell's working directory when it ran the line. */
  pwd: string
  /** The command line exactly as the shell accepted it. */
  command: string
}

export interface TerminalEnvHookRequest {
  /** Terminal session id, for a directory that can be told apart in a listing. */
  sessionId: string
  /** The shell that will run the session. */
  shell: string
  /** Names a ruled file keeps back until a command admits them. */
  deferred: readonly string[]
  /** Values that come from no ruled file, injected the ordinary way. */
  environment: Record<string, string>
  /** Resolve one command line to the values its rule admits. */
  resolve: (resolution: TerminalEnvHookResolution) => Promise<Record<string, string>>
  /** Where session directories live. Defaults to the app data root. */
  root?: string
}

/** A prepared hook, ready to spawn the shell with. */
export interface TerminalEnvHookSession {
  /** Values that are not waiting on a rule. */
  environment: Record<string, string>
  /** Environment that points the shell at its session directory. */
  variables: Record<string, string>
  /** Shell arguments that install the hook, instead of the plain login args. */
  args: string[]
  /** Stop watching and delete the session directory. */
  dispose: () => Promise<void>
}

/** Session directories are named for the shell and the session, never for a path. */
function directoryPrefix(sessionId: string, shell: TerminalEnvHookShell): string {
  const safe = basename(sessionId).replace(/[^A-Za-z0-9._-]/gu, '-')
  return `${shell}-${safe.slice(0, 40) || 'session'}-`
}

/** The shell arguments that make the installed startup file the one it reads. */
function hookArgs(kind: TerminalEnvHookShell, files: readonly string[]): string[] {
  if (kind === 'zsh') return ['-l']
  if (kind === 'bash') {
    const rc = files.find((file) => file.endsWith('bashrc'))
    // A long bash option is only read before the short ones, so it comes first.
    return rc ? ['--init-file', rc, '-i'] : ['-l']
  }
  // fish evaluates `-C` before its own config, so the event handlers exist for
  // every line the user types without replacing their config.fish.
  return ['-l', '-C', hookScript('fish')]
}

/**
 * Start one hook session, or return null when this shell cannot hold it.
 *
 * The caller keeps `dispose` for the life of the terminal: it removes the
 * directory, and with it every request and response that ever passed through.
 */
export async function installTerminalEnvHook(
  request: TerminalEnvHookRequest
): Promise<TerminalEnvHookSession | null> {
  const detected = terminalEnvHookShell(request.shell)
  if (!detected) return null
  const kind: TerminalEnvHookShell = detected
  // Windows has no pre-exec point in any of its shells, so a rule cannot be
  // honoured there; the terminal keeps the environment it always had.
  if (process.platform === 'win32') return null

  const root = request.root ? join(request.root, HOOK_ROOT) : join(getConfigRoot(), HOOK_ROOT)
  await mkdir(root, { recursive: true, mode: SESSION_DIRECTORY_MODE })
  const directory = await mkdtemp(join(root, directoryPrefix(request.sessionId, kind)))

  const rcInput = {
    home: homedir(),
    userZdotdir: process.env['ZDOTDIR'] || homedir(),
    deferred: request.deferred,
    directory
  }
  const files: string[] = []
  try {
    if (kind === 'zsh') {
      for (const file of zshRcFiles(rcInput)) {
        const path = join(directory, file.name)
        await writeFile(path, file.contents, { mode: SESSION_FILE_MODE })
        files.push(path)
      }
    } else if (kind === 'bash') {
      const file = bashRcFile(rcInput)
      const path = join(directory, file.name)
      await writeFile(path, file.contents, { mode: SESSION_FILE_MODE })
      files.push(path)
    }
  } catch (error: unknown) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }

  let disposed = false
  /** Serialized so two requests that land together are answered in order. */
  let queue: Promise<void> = Promise.resolve()

  async function answer(seq: string): Promise<void> {
    const requestPath = join(directory, `req.${seq}`)
    const text = await readFile(requestPath, 'utf8').catch(() => null)
    if (text === null) return
    const parsed = parseHookRequest(text)
    let values: Record<string, string> = {}
    if (parsed.command.length > 0 && parsed.command.length <= TERMINAL_ENV_HOOK_COMMAND_LIMIT) {
      try {
        values = await request.resolve({ pwd: parsed.pwd, command: parsed.command })
      } catch (error: unknown) {
        // A failed lookup must never hold the user's command hostage.
        Logger.dev('A terminal env hook request could not be resolved:', error)
      }
    }
    if (disposed) return
    // The restore snippet lands first: the shell sources `res.<n>` the moment it
    // appears, and must find its undo beside it by the time the command ends.
    await writeFile(join(directory, `undo.${seq}`), undoScript(kind, values), {
      mode: SESSION_FILE_MODE
    }).catch(() => undefined)
    // Written under a temporary name and renamed in, so the shell never sources a
    // half-written export list.
    await writeFile(join(directory, `res.${seq}.tmp`), responseScript(kind, values), {
      mode: SESSION_FILE_MODE
    }).catch(() => undefined)
    await rename(join(directory, `res.${seq}.tmp`), join(directory, `res.${seq}`)).catch(
      () => undefined
    )
    await rm(requestPath, { force: true }).catch(() => undefined)
  }

  async function drain(): Promise<void> {
    if (disposed) return
    const names = await readdir(directory).catch(() => [] as string[])
    const pending = names
      .map((name) => /^req\.(\d+)$/u.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1])
      .sort((left, right) => Number(left) - Number(right))
    for (const seq of pending) await answer(seq)
  }

  const schedule = (): void => {
    queue = queue.then(drain).catch((error: unknown) => {
      Logger.dev('A terminal env hook sweep failed:', error)
    })
  }

  let watcher: FSWatcher | null = null
  try {
    watcher = watch(directory, { persistent: false }, schedule)
    watcher.on('error', () => undefined)
  } catch (error: unknown) {
    Logger.dev('The terminal env hook could not watch its session directory:', error)
  }
  schedule()

  return {
    environment: request.environment,
    variables: hookEnvironment(kind, directory),
    args: hookArgs(kind, files),
    dispose: async () => {
      if (disposed) return
      disposed = true
      watcher?.close()
      await queue.catch(() => undefined)
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}
