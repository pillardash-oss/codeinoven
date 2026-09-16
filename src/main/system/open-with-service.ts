import { app } from 'electron'
import { realpath, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import type { OpenedPath } from '../../lib/types'
import { Logger } from './logger'

/**
 * Upper bound on paths held for one hand-off. The OS never sends more than a
 * Finder/Explorer selection; the cap keeps a pathological argv (or a runaway
 * `open` invocation) from growing the queue without bound.
 */
const MAX_PENDING_PATHS = 32
/** Canonical paths stay readable for the whole session (a file opened earlier
 *  can still be previewed later), so the grant list is bounded instead. */
const MAX_GRANTED_PATHS = 256

/** Electron's own switches and the app bundle argument never name a path. */
function isSwitchArgument(value: string): boolean {
  return value.startsWith('-')
}

/**
 * Paths that belong to the app itself rather than to the user's launch request:
 * the app directory (passed explicitly when the CLI resolves an unpackaged
 * app), the executable, and the packaged resources directory. A launch that
 * echoes any of them must never be mistaken for "open this folder".
 */
function internalLaunchPaths(): Set<string> {
  const internal = new Set<string>()
  if (!app.isPackaged) internal.add(resolve(app.getAppPath()))
  internal.add(resolve(process.execPath))
  internal.add(resolve(process.resourcesPath))
  return internal
}

/**
 * Extract the folder/file paths from a launch argv.
 *
 * Only absolute paths count: the app bundle argument (`electron .` in
 * development) is relative or equal to the app path, and forwarded Chromium
 * switches start with `-`. Everything else is classified later by
 * {@link OpenWithService.ingest}.
 */
export function parseOpenedPathArguments(argv: readonly string[]): string[] {
  const internal = internalLaunchPaths()
  const candidates: string[] = []
  for (const raw of argv.slice(1)) {
    if (!raw || isSwitchArgument(raw)) continue
    if (!isAbsolute(raw)) continue
    const candidate = resolve(raw)
    if (internal.has(candidate)) continue
    if (!candidates.includes(candidate)) candidates.push(candidate)
  }
  return candidates
}

/**
 * Routes OS-supplied paths ("Open in CodeInOven", Dock/taskbar drops, launch
 * arguments) into the renderer.
 *
 * Two consumers exist with different lifetimes:
 *
 * - the **renderer**, which drains {@link consumePending} once on mount and
 *   receives `openWith:paths` pushes afterwards, and
 * - the **privileged IPC boundary**, which needs every opened path to stay
 *   authorized so the standalone viewer can read the file (and its preview)
 *   for the rest of the session ({@link onPaths} / {@link grantedPaths}).
 */
export class OpenWithService {
  #pending: OpenedPath[] = []
  #granted: OpenedPath[] = []
  #listeners = new Set<(paths: readonly OpenedPath[]) => void>()
  #ingestChain: Promise<void> = Promise.resolve()

  /**
   * Classify and enqueue OS-supplied paths. Serialized so two rapid hand-offs
   * (e.g. several `open-file` events) cannot interleave their dedupe checks.
   */
  ingest(rawPaths: readonly string[]): Promise<void> {
    this.#ingestChain = this.#ingestChain.then(() => this.#ingestNow(rawPaths))
    return this.#ingestChain
  }

  /** Paths waiting for the renderer, without draining them. */
  peek(): readonly OpenedPath[] {
    return this.#pending
  }

  /** Take the paths the renderer has not handled yet (drains the queue). */
  consumePending(): OpenedPath[] {
    if (this.#pending.length === 0) return []
    const drained = this.#pending
    this.#pending = []
    return drained
  }

  /** Every path opened in this session, for scope authorization. */
  grantedPaths(): readonly OpenedPath[] {
    return this.#granted
  }

  /** Subscribe to newly opened paths (main-process consumers only). */
  onPaths(listener: (paths: readonly OpenedPath[]) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async #ingestNow(rawPaths: readonly string[]): Promise<void> {
    const accepted: OpenedPath[] = []
    for (const rawPath of rawPaths.slice(0, MAX_PENDING_PATHS)) {
      const opened = await classifyOpenedPath(rawPath)
      if (!opened) continue
      if (this.#pending.some((entry) => entry.path === opened.path)) continue
      if (this.#pending.length >= MAX_PENDING_PATHS) break
      this.#pending.push(opened)
      accepted.push(opened)
      this.#rememberGrant(opened)
    }
    if (accepted.length === 0) return
    for (const listener of this.#listeners) {
      try {
        listener(accepted)
      } catch (error) {
        // One consumer failing must not drop the hand-off for the others.
        Logger.error('Open-path listener failed:', error)
      }
    }
  }

  #rememberGrant(opened: OpenedPath): void {
    if (this.#granted.some((entry) => entry.path === opened.path)) return
    this.#granted.push(opened)
    if (this.#granted.length > MAX_GRANTED_PATHS) this.#granted.shift()
  }
}

/**
 * Resolve a raw OS path to a canonical {@link OpenedPath}. Paths that do not
 * exist (or are neither a folder nor a regular file) are dropped: the OS can
 * hand over stale references, and a launch argument may simply not be a path.
 */
async function classifyOpenedPath(rawPath: string): Promise<OpenedPath | null> {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null
  if (rawPath.includes('\0')) return null
  try {
    const canonical = await realpath(rawPath)
    const metadata = await stat(canonical)
    if (!metadata.isDirectory() && !metadata.isFile()) return null
    return {
      path: canonical,
      kind: metadata.isDirectory() ? 'directory' : 'file',
      name: basename(canonical)
    }
  } catch {
    return null
  }
}

/** Singleton shared by the main process lifecycle. */
export const openWithService = new OpenWithService()
