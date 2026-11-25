/**
 * Where the utility host's own stderr is kept.
 *
 * The host is a child of the Oven service daemon, and its output was thrown away
 * by `stdio: 'ignore'`. That discard is why nothing an Oven recorded could be
 * read afterwards: above all the one line that says a capability could not run
 * on the Oven and was forwarded to the app, which is the only record anywhere of
 * why a call moved back and why an Oven could not do the work it was handed.
 *
 * So the daemon keeps the child's stderr in one bounded file beside the state
 * file: appended as it arrives, reset once it passes
 * `OVEN_UTILITY_HOST_LOG_LIMIT_BYTES`. Reset rather than rotated, because an Oven
 * has no operator collecting old files and one bounded file is the whole promise
 * this makes; the reset line stays in the file so a gap is explained rather than
 * mysterious.
 */
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { Writable } from 'node:stream'
import { Logger } from '../../../system/logger'
import { ovenUtilityHostDirectory } from './oven-utility-host-state'

/** The file an Oven's utility host writes its stderr to, inside its own folder. */
export const OVEN_UTILITY_HOST_LOG_FILE = 'host.log'

/** How much history one Oven keeps before the file starts over. */
export const OVEN_UTILITY_HOST_LOG_LIMIT_BYTES = 1024 * 1024

/** The one log file an Oven's utility host owns. */
export function ovenUtilityHostLogPath(home: string): string {
  return `${ovenUtilityHostDirectory(home)}/${OVEN_UTILITY_HOST_LOG_FILE}`
}

/**
 * A sink for the host's stderr that never grows past the limit.
 *
 * A `Writable` because the child's stderr is simply piped into it: Node calls
 * `_write` only after the previous chunk landed, so the size check cannot race
 * another write. A failed write is reported once and then dropped, because a
 * diagnostic log can never be the thing that takes the daemon down, and logging
 * that failure through `Logger` would loop back into this same stream.
 */
export function openOvenUtilityHostLog(home: string): Writable {
  const directory = ovenUtilityHostDirectory(home)
  const path = ovenUtilityHostLogPath(home)
  let size: number | undefined
  let broken = false
  const append = async (chunk: Buffer): Promise<void> => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (size === undefined) size = await currentLogSize(path)
    if (size + chunk.byteLength > OVEN_UTILITY_HOST_LOG_LIMIT_BYTES) {
      const reset = `[This Oven utility host log passed ${OVEN_UTILITY_HOST_LOG_LIMIT_BYTES} bytes and was reset here.]\n`
      await writeFile(path, reset, { mode: 0o600 })
      size = Buffer.byteLength(reset)
    }
    await appendFile(path, chunk, { mode: 0o600 })
    size += chunk.byteLength
  }
  return new Writable({
    write(chunk: Buffer, _encoding, callback): void {
      if (broken) {
        callback()
        return
      }
      void append(chunk).then(
        () => callback(),
        (error: unknown) => {
          broken = true
          Logger.error('Could not write the Oven utility host log:', error)
          callback()
        }
      )
    }
  })
}

/** Bytes already in the log, treating a missing or unreadable file as empty. */
async function currentLogSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}
