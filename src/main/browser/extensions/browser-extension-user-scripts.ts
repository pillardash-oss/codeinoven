/**
 * The files `chrome.userScripts.register` needs, materialized into the extension's
 * own copy.
 *
 * Why a file at all: this runtime has no `chrome.userScripts`, and its `scripting`
 * API refuses the `USER_SCRIPT` execution world, so the compatibility preamble
 * rebuilds the API on top of `scripting.registerContentScripts`. That call takes
 * `js` as a list of paths inside the extension, never code, and a worker cannot
 * write a file. So the worker asks app main for the write through the bridge page
 * and waits for the answer, and this module is the half that touches disk.
 *
 * Safety: the worker is extension code, so nothing it sends is trusted. Every path
 * must sit directly inside `cio-user-scripts/`, be a plain file name, and stay
 * under a size cap, and the whole request is bounded in count. Files the current
 * request does not ask for are pruned, so a filter the user removes does not leave
 * code on disk for the life of the install.
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const USER_SCRIPT_DIR_NAME = 'cio-user-scripts'

/** One file to write, as asked for by the worker. */
export interface UserScriptFileWrite {
  path: string
  code: string
}

/** One materialization request, read out of the extension's own storage. */
export interface UserScriptFileRequest {
  request: number
  files: UserScriptFileWrite[]
  keep: string[]
}

/** What app main writes back so the worker can stop waiting. */
export interface UserScriptFileResult {
  request: number
  paths: string[]
  error: string | null
}

const MAX_FILES = 64
const MAX_CODE_LENGTH = 512 * 1024
const FILE_NAME = /^[A-Za-z0-9._-]+$/

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/** The file name inside `cio-user-scripts/`, or null when the path is not one the
 *  app is willing to write. */
export function userScriptFileName(path: string): string | null {
  const prefix = `${USER_SCRIPT_DIR_NAME}/`
  if (path.startsWith(prefix) === false) return null
  const name = path.slice(prefix.length)
  if (!name || name.length > 96 || FILE_NAME.test(name) === false) return null
  return name
}

/**
 * Read one request out of whatever the bridge page handed over. A request the app
 * cannot trust is refused here rather than half-applied, and a refusal is answered
 * with the reason so the extension sees a real error instead of a silent no-op.
 */
export function parseUserScriptFileRequest(raw: unknown): UserScriptFileRequest | null {
  const record = asRecord(raw)
  if (!record) return null
  const request = typeof record['request'] === 'number' ? record['request'] : 0
  if (!Number.isSafeInteger(request) || request <= 0) return null
  const rawFiles = Array.isArray(record['files']) ? record['files'] : []
  if (rawFiles.length > MAX_FILES) return null
  const files: UserScriptFileWrite[] = []
  for (const candidate of rawFiles) {
    const file = asRecord(candidate)
    if (!file) return null
    const path = typeof file['path'] === 'string' ? file['path'] : ''
    const code = typeof file['code'] === 'string' ? file['code'] : ''
    if (userScriptFileName(path) === null) return null
    if (code.length === 0 || code.length > MAX_CODE_LENGTH) return null
    files.push({ path, code })
  }
  const rawKeep = Array.isArray(record['keep']) ? record['keep'] : []
  const keep = rawKeep.filter(
    (entry): entry is string => typeof entry === 'string' && userScriptFileName(entry) !== null
  )
  return { request, files, keep }
}

/**
 * Write the request's files into the extension's copy and prune the ones it no
 * longer wants. Returns the result the bridge page writes back into the worker's
 * storage.
 */
export async function materializeUserScriptFiles(
  sourceDir: string,
  request: UserScriptFileRequest
): Promise<UserScriptFileResult> {
  const dir = join(sourceDir, USER_SCRIPT_DIR_NAME)
  try {
    await mkdir(dir, { recursive: true })
    const wanted = new Map<string, string>()
    for (const file of request.files) {
      const name = userScriptFileName(file.path)
      if (name === null) continue
      wanted.set(name, file.code)
    }
    for (const [name, code] of wanted) {
      await writeFile(join(dir, name), code, 'utf8')
    }
    const keep = new Set(
      request.keep
        .map((path) => userScriptFileName(path))
        .filter((name): name is string => name !== null)
    )
    const existing = await readdir(dir).catch(() => [] as string[])
    for (const name of existing) {
      if (keep.has(name)) continue
      await rm(join(dir, name), { force: true }).catch(() => undefined)
    }
    return { request: request.request, paths: [...wanted.keys()].map((name) => `${USER_SCRIPT_DIR_NAME}/${name}`), error: null }
  } catch (error) {
    return {
      request: request.request,
      paths: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
