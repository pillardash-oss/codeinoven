/**
 * The worker failed because another connection holds the write lock.
 *
 * Retrying that statement on the primary connection cannot succeed sooner: it
 * waits out the same busy timeout, only now on the Electron main thread, where
 * five seconds of waiting freezes every window, menu and IPC reply. A worker
 * failure of this kind is answered as a failure instead of being retried there.
 */
export function isLockContention(error: string | undefined): boolean {
  if (!error) return false
  return /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database table is locked/i.test(error)
}
