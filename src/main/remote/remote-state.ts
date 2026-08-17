/**
 * Persistent remote-mode state.
 *
 * The remote-mode flag is stored under the app config root so a desktop
 * restart restores the LAN gateway and keeps the phone connection alive
 * without the user re-enabling remote mode by hand. Kept as a tiny pure module
 * so the persistence semantics are unit-testable without Electron.
 */

export const REMOTE_STATE_FILE = 'remote/state.json'

export interface RemoteModeState {
  enabled: boolean
}

/** Read the persisted remote-mode flag (false when absent or malformed). */
export async function readRemoteModeState(storage: {
  read: <T>(relativePath: string) => Promise<T | null>
}): Promise<boolean> {
  try {
    const state = await storage.read<RemoteModeState>(REMOTE_STATE_FILE)
    return state?.enabled === true
  } catch {
    return false
  }
}

/** Persist the remote-mode flag. */
export async function writeRemoteModeState(
  storage: {
    write: (relativePath: string, value: unknown) => Promise<void>
  },
  enabled: boolean
): Promise<void> {
  await storage.write(REMOTE_STATE_FILE, { enabled })
}
