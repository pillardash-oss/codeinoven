/**
 * Persistent phone device identity.
 *
 * Every phone installs a stable identity (a random `deviceId` plus a
 * human-readable `deviceName`) so the desktop gateway can tell devices apart,
 * remember renames across reconnects, and let the user disconnect or rename a
 * specific phone. The identity is generated once and kept in `localStorage`;
 * the device name can be changed from the desktop (renames are persisted
 * desktop-side too) or locally by the user.
 */

const DEVICE_ID_KEY = 'codeinoven.remote.deviceId'
const DEVICE_NAME_KEY = 'codeinoven.remote.deviceName'

export interface DeviceIdentity {
  id: string
  name: string
}

function randomId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `device-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
  }
}

/** A friendly default device name derived from the user agent. */
export function defaultDeviceName(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/iPad/i.test(ua)) return 'iPad'
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/Android/i.test(ua)) return 'Android phone'
  if (/Mac/i.test(ua)) return 'Mac'
  if (/Windows/i.test(ua)) return 'Windows PC'
  return 'Phone'
}

/** Load the persisted device identity, creating it on first run. */
export function loadDeviceIdentity(storage: Storage = globalThis.localStorage): DeviceIdentity {
  let id = ''
  let name = ''
  try {
    id = storage.getItem(DEVICE_ID_KEY) ?? ''
    name = storage.getItem(DEVICE_NAME_KEY) ?? ''
  } catch {
    // storage unavailable — fall through to a fresh ephemeral identity
  }
  if (!id) {
    id = randomId()
    try {
      storage.setItem(DEVICE_ID_KEY, id)
    } catch {
      // ephemeral id is fine if storage cannot persist
    }
  }
  if (!name) {
    name = defaultDeviceName()
    try {
      storage.setItem(DEVICE_NAME_KEY, name)
    } catch {
      // ephemeral name is fine if storage cannot persist
    }
  }
  return { id, name }
}

/** Persist a local device name override (used when the phone sets its own). */
export function persistDeviceName(name: string, storage: Storage = globalThis.localStorage): void {
  try {
    storage.setItem(DEVICE_NAME_KEY, name)
  } catch {
    // best-effort
  }
}
