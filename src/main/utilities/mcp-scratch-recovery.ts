import { realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, sep } from 'node:path'

/**
 * A package runner's scratch install directory, as bun names it:
 * `bunx-<uid>-<package>` under the OS temp root, holding the tree's own
 * `node_modules`.
 *
 * The runner writes the tree and its lockfile in that folder and then reuses it
 * on every later run. A run killed while it materializes the tree (the first
 * install of a large server easily outlives a cold start budget) leaves the
 * lockfile in place and most package folders empty. The runner has no reason to
 * look again, so every later start dies inside the module loader with
 * `ERR_MODULE_NOT_FOUND` for a package that the lockfile says is installed.
 */
const SCRATCH_INSTALL = /^bunx-\d+-/u

/** Absolute paths printed inside an error message, quoted or bare. */
const ABSOLUTE_PATH = /(?:[A-Za-z]:\\|\/)[^\s'"]+/gu

/** The install directory a cited file belongs to: the parent of its `node_modules`. */
function installRootOf(cited: string): string | undefined {
  let candidate = dirname(cited)
  for (let depth = 0; depth < 16; depth += 1) {
    if (basename(candidate) === 'node_modules') return dirname(candidate)
    const parent = dirname(candidate)
    if (parent === candidate) return undefined
    candidate = parent
  }
  return undefined
}

/**
 * The scratch install roots an SDK error message points into.
 *
 * A candidate must sit under the OS temp root and carry the runner's own
 * `bunx-<uid>-` path segment: the deletion this enables must never reach a
 * user's global cache, a project's `node_modules`, or anything else the message
 * happens to name.
 */
async function scratchRootsInMessage(message: string): Promise<string[]> {
  const tempRoots = [...new Set([tmpdir(), await realpath(tmpdir()).catch(() => tmpdir())])]
  const roots = new Set<string>()
  for (const match of message.matchAll(ABSOLUTE_PATH)) {
    const root = installRootOf(match[0])
    if (!root) continue
    const rootReal = await realpath(root).catch(() => root)
    const underTemp = tempRoots.some(
      (tempRoot) => rootReal === tempRoot || rootReal.startsWith(`${tempRoot}${sep}`)
    )
    if (!underTemp) continue
    if (!rootReal.split(sep).some((segment) => SCRATCH_INSTALL.test(segment))) continue
    roots.add(rootReal)
  }
  return [...roots]
}

/** Whether a startup failure describes a package that should be on disk but is not. */
function isMissingInstall(messages: string): boolean {
  return /ERR_MODULE_NOT_FOUND|Cannot find (?:package|module)/u.test(messages)
}

/**
 * Delete the scratch install a failed start was running out of, so the next
 * attempt reinstalls instead of dying on the same half-written tree.
 *
 * Returns the directories removed, which is empty for every failure that is not
 * a broken package-runner install - a missing credential or a server that
 * refuses to start leaves the filesystem untouched.
 */
export async function purgeCorruptPackageInstall(error: unknown): Promise<string[]> {
  const messages: string[] = []
  for (let current: unknown = error, depth = 0; depth < 4 && current; depth += 1) {
    if (current instanceof Error) messages.push(current.message)
    else if (typeof current === 'string') messages.push(current)
    current = current instanceof Error ? current.cause : undefined
  }
  const text = messages.join('\n')
  if (!isMissingInstall(text)) return []
  const roots = await scratchRootsInMessage(text)
  const purged: string[] = []
  for (const root of roots) {
    try {
      await rm(root, { recursive: true, force: true })
      purged.push(root)
    } catch {
      // A directory that cannot be removed is not a reason to fail the start; the
      // retry then reports the same install problem the first attempt did.
    }
  }
  return purged
}
