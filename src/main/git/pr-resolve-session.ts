import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PrResolveSession } from '../../lib/types'

/**
 * The on-disk record of a prepared PR conflict-resolution session.
 *
 * The session used to live in the renderer's git store only, which made the
 * whole finish step depend on that window staying alive: an app restart between
 * "prepare" and "Complete merge" dropped the record, the panel then completed
 * the merge as a plain local commit, and the pull request never heard about the
 * resolution while the temporary `pr-<n>` branch stayed behind.
 *
 * The record is written beside the pull request's other sidecars (the same
 * `.cio/git/pr/<n>/` directory the agent assignments use), so the finish step
 * survives a renderer reload and an app restart, and keying it by repository
 * root keeps two checkouts of the same repository apart.
 */

const SESSION_FILE = 'resolve.json'

function directoryFor(repositoryRoot: string, pullNumber: number): string {
  return join(repositoryRoot, '.cio', 'git', 'pr', String(pullNumber))
}

function fileFor(repositoryRoot: string, pullNumber: number): string {
  return join(directoryFor(repositoryRoot, pullNumber), SESSION_FILE)
}

/** The pull request number a temporary `pr-<n>` branch was created for. */
export function pullNumberForBranch(branch: string | null): number | null {
  if (!branch) return null
  const match = /^pr-(\d+)$/u.exec(branch)
  if (!match) return null
  const value = Number(match[1])
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Read one record defensively: it lives inside the user's project, so a
 * hand-edited, truncated or older file has to degrade to "no session" rather
 * than break a status read.
 */
function parseSession(value: unknown, branch: string, pullNumber: number): PrResolveSession | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const remote = optionalString(record['remote'])
  const baseBranch = optionalString(record['baseBranch'])
  const headBranch = optionalString(record['headBranch'])
  const returnBranch = optionalString(record['returnBranch'])
  const recordedBranch = optionalString(record['branch'])
  const recordedNumber = record['pullNumber']
  if (!remote || !baseBranch || !headBranch || !returnBranch) return null
  if (recordedBranch !== branch) return null
  if (recordedNumber !== pullNumber) return null
  const createdAt = record['createdAt']
  return {
    remote,
    pullNumber,
    baseBranch,
    headBranch,
    returnBranch,
    branch,
    createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0
  }
}

/**
 * Sessions already read or written in this process, keyed by repository root and
 * branch. Status reads are frequent, and only this module writes the file, so a
 * cached answer is as current as the file until the next prepare or finish.
 */
const cache = new Map<string, PrResolveSession | null>()

function cacheKey(repositoryRoot: string, branch: string): string {
  return `${repositoryRoot}\u0000${branch}`
}

function forgetRoot(repositoryRoot: string): void {
  const prefix = `${repositoryRoot}\u0000`
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

/**
 * The session recorded for the branch a checkout currently has checked out, or
 * null when the checkout is not a prepared PR resolution. Never throws: an
 * unreadable record is simply not a session.
 */
export async function readPrResolveSession(
  repositoryRoot: string,
  branch: string | null
): Promise<PrResolveSession | null> {
  const pullNumber = pullNumberForBranch(branch)
  if (!branch || pullNumber === null) return null
  const key = cacheKey(repositoryRoot, branch)
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const raw = await readFile(fileFor(repositoryRoot, pullNumber), 'utf-8').catch(() => null)
  if (raw === null) {
    cache.set(key, null)
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    parsed = null
  }
  const session = parseSession(parsed, branch, pullNumber)
  cache.set(key, session)
  return session
}

/** Record a prepared session so the finish step can be found again later. */
export async function writePrResolveSession(
  repositoryRoot: string,
  session: PrResolveSession
): Promise<void> {
  const directory = directoryFor(repositoryRoot, session.pullNumber)
  await mkdir(directory, { recursive: true })
  await writeFile(fileFor(repositoryRoot, session.pullNumber), JSON.stringify(session), 'utf-8')
  forgetRoot(repositoryRoot)
  cache.set(cacheKey(repositoryRoot, session.branch), session)
}

/** Drop a session once its resolution has been pushed and its branch removed. */
export async function clearPrResolveSession(
  repositoryRoot: string,
  pullNumber: number
): Promise<void> {
  await rm(fileFor(repositoryRoot, pullNumber), { force: true }).catch(() => undefined)
  forgetRoot(repositoryRoot)
}
