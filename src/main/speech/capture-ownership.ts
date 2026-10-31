/**
 * Which process owns a microphone capture that is still open.
 *
 * Two CodeInOven instances share one config root, so one instance's recorder
 * writes into a staging file every other instance can see. That makes a staging
 * file ambiguous: it is either the leftover of a process that died while it was
 * recording, or the live recording of a sibling that is appending to it right
 * now. Settling it the wrong way destroys an active recording: the file is
 * renamed away from under the recorder's still-open handle, its attempt is
 * closed as failed, and the audio that reaches the new name is referenced by no
 * row, so the transcript can never be produced.
 *
 * A capture therefore names its owning process next to its staging file, and a
 * launch only reclaims what no live process owns any more.
 *
 * The record is a sibling file rather than a field in `history.json` because
 * every instance rewrites that index whole, so an ownership fact written there
 * can be erased by a sibling's concurrent write, while it is only meaningful for
 * as long as one staging file exists.
 */

import { readFile, rm, writeFile } from 'node:fs/promises'
import { instanceRegistry } from '../system/instance-registry'
import { Logger } from '../system/logger'

export interface CaptureOwner {
  pid: number
  /** When the owning process opened the capture. */
  startedAt: number
}

/** Suffix appended to a staging path to hold its ownership record. */
export const CAPTURE_OWNER_SUFFIX = '.owner.json'

export function captureOwnerPath(stagingPath: string): string {
  return `${stagingPath}${CAPTURE_OWNER_SUFFIX}`
}

/**
 * Claim a staging path before the staging file itself is created, so a sibling
 * scanning the directory can never find a capture that names no owner.
 */
export async function claimCaptureOwner(stagingPath: string): Promise<void> {
  const owner: CaptureOwner = { pid: process.pid, startedAt: Date.now() }
  await writeFile(captureOwnerPath(stagingPath), `${JSON.stringify(owner)}\n`, { mode: 0o600 })
}

/** Forget a capture this process finished, failed, or released at shutdown. */
export async function releaseCaptureOwner(stagingPath: string): Promise<void> {
  await rm(captureOwnerPath(stagingPath), { force: true }).catch((error) =>
    Logger.dev('Speech capture ownership record could not be removed:', error)
  )
}

/** Read a staging path's ownership record, or `null` when it has none. */
export async function readCaptureOwner(stagingPath: string): Promise<CaptureOwner | null> {
  try {
    const parsed: unknown = JSON.parse(await readFile(captureOwnerPath(stagingPath), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return null
    const candidate = parsed as Partial<CaptureOwner>
    if (typeof candidate.pid !== 'number' || typeof candidate.startedAt !== 'number') return null
    return { pid: candidate.pid, startedAt: candidate.startedAt }
  } catch {
    return null
  }
}

/**
 * Whether the process that opened a capture is still running.
 *
 * The instance registry is the app's own answer to "is that process still
 * running this work", and it errs towards alive: when the registry itself
 * cannot be read, a pid that exists counts as the owner. That is the right
 * trade here, because reclaiming a live recording costs the user a transcript,
 * while leaving a dead one behind only delays its sweep to the next launch.
 */
export function isCaptureOwnerAlive(owner: CaptureOwner): boolean {
  return instanceRegistry.isRunOwnerAlive(owner.pid)
}
