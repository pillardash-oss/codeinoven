/**
 * Persistent remote-mode state.
 *
 * The remote-mode flag is stored under the app config root so a desktop
 * restart restores the LAN gateway and keeps the phone connection alive
 * without the user re-enabling remote mode by hand. Kept as a tiny pure module
 * so the persistence semantics are unit-testable without Electron.
 */

export const REMOTE_STATE_FILE = 'remote/state.json'
export const REMOTE_DEVICES_FILE = 'remote/devices.json'

export interface RemoteModeState {
  enabled: boolean
}

/** A device-name override, keyed by device id. */
export type RemoteDeviceNames = Record<string, string>

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

/** Read the persisted device-name overrides ({ deviceId: name }). */
export async function readRemoteDeviceNames(storage: {
  read: <T>(relativePath: string) => Promise<T | null>
}): Promise<RemoteDeviceNames> {
  try {
    const names = await storage.read<RemoteDeviceNames>(REMOTE_DEVICES_FILE)
    if (typeof names !== 'object' || names === null || Array.isArray(names)) return {}
    const clean: RemoteDeviceNames = {}
    for (const [deviceId, name] of Object.entries(names)) {
      if (typeof name === 'string' && name.trim().length > 0) {
        clean[deviceId] = name.trim().slice(0, 100)
      }
    }
    return clean
  } catch {
    return {}
  }
}

/** Persist a single device-name override, preserving the rest. */
export async function writeRemoteDeviceName(
  storage: {
    read: <T>(relativePath: string) => Promise<T | null>
    write: (relativePath: string, value: unknown) => Promise<void>
  },
  deviceId: string,
  name: string
): Promise<void> {
  const names = await readRemoteDeviceNames(storage)
  const trimmed = name.trim()
  if (trimmed.length === 0) {
    delete names[deviceId]
  } else {
    names[deviceId] = trimmed.slice(0, 100)
  }
  await storage.write(REMOTE_DEVICES_FILE, names)
}
