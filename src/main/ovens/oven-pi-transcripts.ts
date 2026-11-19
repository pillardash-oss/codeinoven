import { randomUUID } from 'node:crypto'
import type { OvenWorkspaceRequest, OvenWorkspaceResult } from '../../lib/ovens'
import { Logger } from '../system/logger'
import { nativePiSessionDir, type PiNativeTranscriptSource } from '../drivers/pi/pi-native-session'
import { removeOvenWorkspaceFile } from './oven-pi-storage'

/**
 * Pi's own session transcripts, read from the Oven a session runs on.
 *
 * A pi process writes its session file beside itself, so a session resumed on an
 * Oven has to open the Oven's copy: `switch_session <file>` names a path on the
 * machine pi is running on, and every helper above this seam resolved that path
 * from this computer's disk. The directory layout is pi's, computed by
 * `nativePiSessionDir` exactly as the local reader computes it, and only the
 * bytes travel over the Oven's file API instead of `node:fs`.
 */

/** The slice of the Oven client a transcript source reads through. */
export interface OvenPiTranscriptService {
  workspace(id: string, input: OvenWorkspaceRequest): Promise<OvenWorkspaceResult>
}

/** One bound session's machine, as the transcript reader sees it. */
export interface OvenPiTranscriptRoute {
  /** The Oven the session's pi process runs on. */
  ovenId: string
  /**
   * That session's account root on the Oven: the `PI_CODING_AGENT_DIR` its pi
   * was started with, which is where pi writes its `sessions/` directory.
   */
  agentDirectory: string
}

/** The Oven's read chunk, which bounds one `read` answer. */
export const OVEN_PI_TRANSCRIPT_CHUNK_BYTES = 128 * 1024

/**
 * How often `waitFor` asks the Oven for the directory again.
 *
 * A transcript pi flushed within this window is found on the next poll, and a
 * poll is one cheap listing: the alternative is a stream the service does not
 * offer for a directory nobody is running on the Oven's own side.
 */
export const OVEN_PI_TRANSCRIPT_POLL_MS = 250

/** A transcript file is read by the pi process on the Oven only. */
const TRANSCRIPT_FILE_MODE = 0o600

/**
 * A transcript source over the Oven a session's pi process runs on.
 *
 * `route` resolves one project path (the checkout the Oven-side pi works in) to
 * the machine and account that hold its transcripts, or null when no bound
 * session works there. Nothing here is cached: a route is installed per turn by
 * the Oven layer, so the lookup runs on every read.
 */
export function ovenPiTranscriptSource(input: {
  service: OvenPiTranscriptService
  route: (projectPath: string) => OvenPiTranscriptRoute | null
}): PiNativeTranscriptSource {
  // The one definition of pi's layout is the local reader's; only its separators
  // are rewritten here, because an Oven path is always `/`-joined.
  const directoryOf = (projectPath: string, route: OvenPiTranscriptRoute): string =>
    ovenPath(nativePiSessionDir(projectPath, route.agentDirectory))

  return {
    resolve: (projectPath, fileName) => {
      const route = input.route(projectPath)
      if (!route) throw unreachable(projectPath)
      return `${directoryOf(projectPath, route)}/${fileName}`
    },
    list: async (projectPath) => {
      const route = input.route(projectPath)
      if (!route) return null
      try {
        return await listTranscriptNames(input.service, route, directoryOf(projectPath, route))
      } catch (error) {
        // A machine that cannot answer has no transcript this app can read.
        // Reporting an absent directory instead of throwing keeps a resume a
        // cold start, exactly as a project pi never wrote to behaves locally.
        Logger.dev('Could not list native Pi transcripts on the Oven:', error)
        return null
      }
    },
    read: async (projectPath, fileName) => {
      const route = input.route(projectPath)
      if (!route) return null
      try {
        return await readTranscriptText(
          input.service,
          route,
          directoryOf(projectPath, route),
          fileName
        )
      } catch (error) {
        Logger.dev('Could not read a native Pi transcript on the Oven:', error)
        return null
      }
    },
    write: async (projectPath, fileName, content) => {
      const route = input.route(projectPath)
      if (!route) throw unreachable(projectPath)
      await writeTranscript(
        input.service,
        route,
        directoryOf(projectPath, route),
        fileName,
        content
      )
    },
    waitFor: async (projectPath, suffix, timeoutMs) => {
      const route = input.route(projectPath)
      if (!route) return null
      const directory = directoryOf(projectPath, route)
      // The caller's budget is the whole wait: a poll is only started while
      // there is time left to answer it, and the sleep never runs past the
      // deadline, so the wait is as slow as one listing and never longer.
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const names = await listTranscriptNames(input.service, route, directory).catch(
          (error: unknown) => {
            // A machine that cannot answer has no transcript this app can read
            // yet, which is the same "nothing there" a poll keeps checking for.
            Logger.dev('Could not poll native Pi transcripts on the Oven:', error)
            return null
          }
        )
        const newest = names
          ?.filter((name) => name.endsWith(suffix))
          .sort()
          .at(-1)
        if (newest) return `${directory}/${newest}`
        const remaining = deadline - Date.now()
        if (remaining <= 0) return null
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(OVEN_PI_TRANSCRIPT_POLL_MS, remaining))
        )
      }
    },
    remove: async (projectPath, fileName) => {
      const route = input.route(projectPath)
      if (!route) return
      await removeTranscript(input.service, route, directoryOf(projectPath, route), fileName)
    },
    // Only a checkout one of this runtime's sessions works in has transcripts
    // here; every other project is read on this computer, exactly as before.
    holds: (projectPath) => input.route(projectPath) !== null
  }
}

/** The failure a path no bound session works in deserves. */
function unreachable(projectPath: string): Error {
  return new Error(
    `No Oven session works in ${projectPath}, so its Pi transcripts cannot be reached.`
  )
}

/** Every file name in one transcript directory, or null when it is absent. */
async function listTranscriptNames(
  service: OvenPiTranscriptService,
  route: OvenPiTranscriptRoute,
  directory: string
): Promise<string[] | null> {
  const names: string[] = []
  let after: string | undefined
  try {
    do {
      const page = await service.workspace(route.ovenId, {
        operation: 'list',
        root: directory,
        path: '.',
        ...(after ? { after } : {})
      })
      for (const file of page.files ?? []) if (file.kind === 'file') names.push(file.path)
      after = page.after
    } while (after)
  } catch (error) {
    // A directory pi has not created yet is "no transcripts", not a failure.
    if (isMissing(error)) return null
    throw error
  }
  return names
}

/** One transcript's text, read in the Oven's chunks to EOF. */
async function readTranscriptText(
  service: OvenPiTranscriptService,
  route: OvenPiTranscriptRoute,
  directory: string,
  fileName: string
): Promise<string | null> {
  const chunks: Buffer[] = []
  let offset = 0
  for (;;) {
    let result: OvenWorkspaceResult
    try {
      result = await service.workspace(route.ovenId, {
        operation: 'read',
        root: directory,
        path: fileName,
        offset
      })
    } catch (error) {
      // A transcript that is already gone reads as absent, exactly as a local
      // read of a removed file does. A later chunk failing is a real failure:
      // half a transcript would silently truncate the resumed conversation.
      if (offset === 0 && isMissing(error)) return null
      throw error
    }
    const bytes = Buffer.from(result.data ?? '', 'base64')
    if (!bytes.length) break
    chunks.push(bytes)
    offset += bytes.length
    // A short chunk is the last one; `size` ends the walk without the extra
    // request a file whose length is an exact multiple of the chunk needs.
    if (bytes.length < OVEN_PI_TRANSCRIPT_CHUNK_BYTES) break
    if (typeof result.size === 'number' && offset >= result.size) break
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Write one transcript whole, and publish it in a single step.
 *
 * The chunks land in a staging file beside the destination and one rename
 * publishes it, so a pi process resuming onto this session never opens half a
 * transcript. The directory pi's own layout names is created first, exactly as
 * the local source creates it for a seeded transcript.
 */
async function writeTranscript(
  service: OvenPiTranscriptService,
  route: OvenPiTranscriptRoute,
  directory: string,
  fileName: string,
  content: string
): Promise<void> {
  const bytes = Buffer.from(content, 'utf8')
  await service.workspace(route.ovenId, { operation: 'mkdir', root: directory, path: '.' })
  const staged = `${fileName}.${randomUUID()}.next`
  try {
    for (
      let offset = 0;
      offset < bytes.length || offset === 0;
      offset += OVEN_PI_TRANSCRIPT_CHUNK_BYTES
    ) {
      await service.workspace(route.ovenId, {
        operation: 'write',
        root: directory,
        path: staged,
        offset,
        data: bytes.subarray(offset, offset + OVEN_PI_TRANSCRIPT_CHUNK_BYTES).toString('base64'),
        exclusive: offset === 0,
        mode: TRANSCRIPT_FILE_MODE
      })
    }
    await service.workspace(route.ovenId, {
      operation: 'replace',
      root: directory,
      path: fileName,
      staged,
      mode: TRANSCRIPT_FILE_MODE
    })
  } catch (error) {
    // The staged file is invisible to pi either way; deleting it keeps the
    // session directory from collecting one leftover per failed write.
    await removeOvenWorkspaceFile((request) => service.workspace(route.ovenId, request), {
      root: directory,
      path: staged
    }).catch(() => undefined)
    throw error
  }
}

/**
 * Take one transcript out of the directory pi resumes from.
 *
 * The Oven deletes it. A service bundle older than this app has no delete, so
 * there the file is parked in the same `.trash` directory the session's handoff
 * files use, which `removeOvenWorkspaceFile` keeps to a few entries: pi no longer
 * lists the file, and a mistaken removal stays recoverable on the Oven without
 * the directory growing for the life of the machine.
 *
 * A transcript that is already gone is not a failure: pi may have cleaned up a
 * session this app discarded, and the caller only cares that nothing is there.
 */
async function removeTranscript(
  service: OvenPiTranscriptService,
  route: OvenPiTranscriptRoute,
  directory: string,
  fileName: string
): Promise<void> {
  try {
    await removeOvenWorkspaceFile((input) => service.workspace(route.ovenId, input), {
      root: directory,
      path: fileName
    })
  } catch (error) {
    Logger.dev('Could not discard a Pi transcript on the Oven:', error)
  }
}

/** One Oven path in the form every Oven request uses. */
function ovenPath(value: string): string {
  const normalized = value.replace(/\\/gu, '/')
  const trimmed = normalized.length > 1 ? normalized.replace(/\/+$/u, '') : normalized
  // A Windows drive root has to keep its separator: `C:/` is not `C:`.
  return /^[A-Za-z]:$/u.test(trimmed) ? `${trimmed}/` : trimmed
}

/** Whether a failed request means the path is not there. */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'ENOENT') return true
  return error instanceof Error && error.message.includes('ENOENT')
}
