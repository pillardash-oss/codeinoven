import { rm } from 'fs/promises'

/**
 * Codes that mean "the walk raced another write", not "the removal is wrong".
 * Recursive `rm` is not atomic: a fire-and-forget persist (a session record, a
 * log line, a compaction summary) can land between the directory listing and
 * the final `rmdir`/`unlink`, and the removal then fails with `ENOTEMPTY` even
 * though every entry it saw was deleted. On Windows the same race surfaces as
 * `EBUSY`/`EPERM` because the file is still open.
 */
const RETRIABLE_CODES = new Set(['ENOTEMPTY', 'EBUSY', 'EEXIST', 'EPERM', 'EACCES', 'ENOENT'])

const DEFAULT_ATTEMPTS = 6
const BASE_DELAY_MS = 25

/**
 * Remove one temp root, retrying briefly while late writes settle. Tests that
 * tear down a config root a `StorageEngine` writes into must use this instead of
 * a bare `rmSync`, otherwise the cleanup fails on a machine that is fast enough
 * to still be writing (CI Unix runners) rather than slow enough to be done.
 */
export async function removeTempRoot(path: string, attempts = DEFAULT_ATTEMPTS): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(path, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= attempts || code === undefined || !RETRIABLE_CODES.has(code)) throw error
      await new Promise((resolve) => setTimeout(resolve, BASE_DELAY_MS * (attempt + 1)))
    }
  }
}

/** Remove several temp roots concurrently. Paths are consumed, not mutated. */
export async function removeTempRoots(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => removeTempRoot(path)))
}
