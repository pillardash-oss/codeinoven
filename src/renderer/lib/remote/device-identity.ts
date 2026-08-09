/**
 * Persistent phone device identity.
 *
 * Every phone installs a stable identity (a random `deviceId` plus a
 * human-readable `deviceName`) so the desktop gateway can tell devices apart,
 * remember renames across reconnects, and let the user disconnect or rename a
 * specific phone. The identity is generated once and kept in storage; the
 * device name can be changed from the desktop (renames are persisted
 * desktop-side too) or locally by the user.
 *
 * Since the 2026-08-08 remediation (A-04) the phone also owns two
 * NON-EXPORTABLE Web Crypto key pairs — an ECDSA P-256 signing key and an
 * ECDH P-256 agreement key. Only the public halves are ever shared; the
 * private `CryptoKey` objects live in IndexedDB (structured-cloneable) so a
 * shared QR secret or a caller-supplied device id is never durable authority.
 */

const DEVICE_ID_KEY = 'deviceId'
const DEVICE_NAME_KEY = 'deviceName'
const DEVICE_AUTH_VERSION_KEY = 'authVersion'
const SIGNING_PUBLIC_JWK_KEY = 'signingPublicJwk'
const AGREEMENT_PUBLIC_JWK_KEY = 'agreementPublicJwk'

export interface DeviceIdentity {
  id: string
  name: string
}

/**
 * Per-device proof-of-possession key material (A-04). The private signing and
 * agreement `CryptoKey` objects are non-exportable and never transmitted.
 */
export interface DeviceKeyMaterial {
  /** Assigned by the desktop at enrollment; null until then. */
  deviceId: string | null
  deviceName: string
  signingKey: CryptoKey
  signingPublicJwk: JsonWebKey
  agreementKey: CryptoKey
  agreementPublicJwk: JsonWebKey
  authVersion: number
}

/**
 * Durable store for the phone's identity strings and non-exportable key
 * objects. The default is IndexedDB (browser); tests inject an in-memory
 * store. CryptoKeys are structured-cloneable, so IndexedDB can persist them
 * directly without ever exposing the private material as JWK text.
 */
export interface DeviceKeyStore {
  getString(key: string): Promise<string | null>
  setString(key: string, value: string): Promise<void>
  removeString(key: string): Promise<void>
  getSigningKey(): Promise<CryptoKey | null>
  setSigningKey(key: CryptoKey): Promise<void>
  getAgreementKey(): Promise<CryptoKey | null>
  setAgreementKey(key: CryptoKey): Promise<void>
  removeKeys(): Promise<void>
}

/** In-memory key store used by tests and as a non-persistent fallback. */
export function createMemoryDeviceKeyStore(): DeviceKeyStore {
  const strings = new Map<string, string>()
  let signing: CryptoKey | null = null
  let agreement: CryptoKey | null = null
  return {
    getString: async (key) => strings.get(key) ?? null,
    setString: async (key, value) => {
      strings.set(key, value)
    },
    removeString: async (key) => {
      strings.delete(key)
    },
    getSigningKey: async () => signing,
    setSigningKey: async (key) => {
      signing = key
    },
    getAgreementKey: async () => agreement,
    setAgreementKey: async (key) => {
      agreement = key
    },
    removeKeys: async () => {
      signing = null
      agreement = null
    }
  }
}

/**
 * IndexedDB-backed store. CryptoKey objects are persisted via structured
 * clone; string metadata is kept under the same object store.
 */
export function createIndexedDbDeviceKeyStore(
  dbName = 'codeinoven-remote-device',
  storeName = 'keys'
): DeviceKeyStore {
  function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1)
      request.onupgradeneeded = () => {
        request.result.createObjectStore(storeName)
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('indexeddb-open-failed'))
    })
  }

  function withStore<T>(
    mode: IDBTransactionMode,
    run: (store: IDBObjectStore) => IDBRequest
  ): Promise<T> {
    return openDatabase().then(
      (db) =>
        new Promise<T>((resolve, reject) => {
          const tx = db.transaction(storeName, mode)
          const request = run(tx.objectStore(storeName))
          request.onsuccess = () => resolve(request.result as T)
          request.onerror = () => reject(request.error ?? new Error('indexeddb-failed'))
          tx.oncomplete = () => db.close()
        })
    )
  }

  return {
    getString: (key) => withStore<string>('readonly', (store) => store.get(key)),
    setString: (key, value) =>
      withStore<unknown>('readwrite', (store) => store.put(value, key)).then(() => undefined),
    removeString: (key) =>
      withStore<unknown>('readwrite', (store) => store.delete(key)).then(() => undefined),
    getSigningKey: () => withStore<CryptoKey>('readonly', (store) => store.get('signing')),
    setSigningKey: (key) =>
      withStore<unknown>('readwrite', (store) => store.put(key, 'signing')).then(() => undefined),
    getAgreementKey: () => withStore<CryptoKey>('readonly', (store) => store.get('agreement')),
    setAgreementKey: (key) =>
      withStore<unknown>('readwrite', (store) => store.put(key, 'agreement')).then(() => undefined),
    removeKeys: async () => {
      await withStore<unknown>('readwrite', (store) => store.delete('signing')).then(
        () => undefined
      )
      await withStore<unknown>('readwrite', (store) => store.delete('agreement')).then(
        () => undefined
      )
    }
  }
}

const SIGNING_ALGO: EcKeyImportParams = { name: 'ECDSA', namedCurve: 'P-256' }
const AGREEMENT_ALGO: EcKeyImportParams = { name: 'ECDH', namedCurve: 'P-256' }

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
export async function loadDeviceIdentity(
  storage: Storage = globalThis.localStorage
): Promise<DeviceIdentity> {
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
export async function persistDeviceName(
  name: string,
  storage: Storage = globalThis.localStorage
): Promise<void> {
  try {
    storage.setItem(DEVICE_NAME_KEY, name)
  } catch {
    // best-effort
  }
}

/** Generate a non-extractable key pair; only the public JWK is exportable. */
async function generateNonExtractablePair(algorithm: EcKeyImportParams): Promise<{
  privateKey: CryptoKey
  publicJwk: JsonWebKey
}> {
  const usages: KeyUsage[] = algorithm.name === 'ECDSA' ? ['sign', 'verify'] : ['deriveKey']
  const pair = await crypto.subtle.generateKey(algorithm, false, usages)
  return {
    privateKey: pair.privateKey,
    publicJwk: await crypto.subtle.exportKey('jwk', pair.publicKey)
  }
}

function defaultStore(): DeviceKeyStore {
  return typeof indexedDB !== 'undefined'
    ? createIndexedDbDeviceKeyStore()
    : createMemoryDeviceKeyStore()
}

function parsePublicJwk(value: string | null): JsonWebKey | null {
  if (!value) return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null
    const key = parsed as Record<string, unknown>
    if (
      key['kty'] !== 'EC' ||
      key['crv'] !== 'P-256' ||
      typeof key['x'] !== 'string' ||
      typeof key['y'] !== 'string'
    ) {
      return null
    }
    return { kty: 'EC', crv: 'P-256', x: key['x'], y: key['y'] }
  } catch {
    return null
  }
}

/**
 * Load (or create) the phone's persistent proof-of-possession keys. The
 * private `CryptoKey` objects are non-extractable and stored in IndexedDB;
 * only the public JWKs leave the device.
 */
export async function loadOrCreateDeviceKeyMaterial(
  options: {
    store?: DeviceKeyStore
  } = {}
): Promise<DeviceKeyMaterial> {
  const store = options.store ?? defaultStore()
  const deviceName = (await store.getString(DEVICE_NAME_KEY)) || defaultDeviceName()
  await store.setString(DEVICE_NAME_KEY, deviceName)
  const rawId = await store.getString(DEVICE_ID_KEY)
  let deviceId = rawId && rawId.length > 0 ? rawId : null

  const signingKey = await store.getSigningKey()
  const agreementKey = await store.getAgreementKey()
  if (signingKey || agreementKey) {
    const signingPublicJwk = parsePublicJwk(await store.getString(SIGNING_PUBLIC_JWK_KEY))
    const agreementPublicJwk = parsePublicJwk(await store.getString(AGREEMENT_PUBLIC_JWK_KEY))
    if (signingKey && agreementKey && signingPublicJwk && agreementPublicJwk) {
      const authVersionRaw = await store.getString(DEVICE_AUTH_VERSION_KEY)
      const parsedVersion = Number.parseInt(authVersionRaw ?? '', 10)
      return {
        deviceId,
        deviceName,
        signingKey,
        signingPublicJwk,
        agreementKey,
        agreementPublicJwk,
        authVersion: Number.isFinite(parsedVersion) && parsedVersion > 0 ? parsedVersion : 1
      }
    }

    // Older builds stored only non-exportable private keys, so their public
    // halves cannot be recovered. Replace that incomplete identity atomically
    // and require a fresh enrollment instead of weakening key exportability.
    await store.removeString(DEVICE_ID_KEY)
    const authVersionRaw = await store.getString(DEVICE_AUTH_VERSION_KEY)
    if (authVersionRaw !== null) await store.removeString(DEVICE_AUTH_VERSION_KEY)
    await store.removeKeys()
    deviceId = null
  }

  const signing = await generateNonExtractablePair(SIGNING_ALGO)
  const agreement = await generateNonExtractablePair(AGREEMENT_ALGO)
  await store.setSigningKey(signing.privateKey)
  await store.setAgreementKey(agreement.privateKey)
  await store.setString(SIGNING_PUBLIC_JWK_KEY, JSON.stringify(signing.publicJwk))
  await store.setString(AGREEMENT_PUBLIC_JWK_KEY, JSON.stringify(agreement.publicJwk))
  await store.setString(DEVICE_AUTH_VERSION_KEY, '1')
  return {
    deviceId,
    deviceName,
    signingKey: signing.privateKey,
    signingPublicJwk: signing.publicJwk,
    agreementKey: agreement.privateKey,
    agreementPublicJwk: agreement.publicJwk,
    authVersion: 1
  }
}

/** Persist the desktop-assigned device id after the enrollment handshake. */
export async function saveAssignedDeviceId(
  deviceId: string,
  store: DeviceKeyStore = defaultStore()
): Promise<void> {
  await store.setString(DEVICE_ID_KEY, deviceId)
}

/** Persist a bumped authVersion (after a desktop-issued rotation). */
export async function saveDeviceAuthVersion(
  authVersion: number,
  store: DeviceKeyStore = defaultStore()
): Promise<void> {
  await store.setString(DEVICE_AUTH_VERSION_KEY, String(authVersion))
}

/** Clear the phone's device identity + keys (used by "forget device data"). */
export async function clearDeviceIdentity(store: DeviceKeyStore = defaultStore()): Promise<void> {
  await store.removeString(DEVICE_ID_KEY)
  await store.removeString(DEVICE_AUTH_VERSION_KEY)
  await store.removeString(SIGNING_PUBLIC_JWK_KEY)
  await store.removeString(AGREEMENT_PUBLIC_JWK_KEY)
  await store.removeKeys()
}

const encoder = new TextEncoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

/** ECDSA P-256/SHA-256 signature over a transcript (proof of possession). */
export async function signTranscript(signingKey: CryptoKey, transcript: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    signingKey,
    encoder.encode(transcript)
  )
  return toBase64Url(new Uint8Array(signature))
}

/**
 * The exact transcript the phone signs for a handshake. For a new device it
 * binds the enrollment to the single-use pairing bootstrap; for an enrolled
 * device it binds the signature to the device identity and credential version.
 * LAN and relay transcripts are distinct so a captured signature cannot be
 * replayed across transports.
 */
export function handshakeTranscript(input: {
  nonce: string
  deviceId?: string | null
  authVersion?: number
  bootstrap?: string | null
  context?: 'lan' | 'relay'
}): string {
  const prefix = input.context === 'relay' ? 'codeinoven:relay' : 'codeinoven'
  if (input.deviceId) {
    return `${prefix}:auth:${input.nonce}:${input.deviceId}:${input.authVersion ?? 1}`
  }
  return `${prefix}:enroll:${input.bootstrap ?? ''}:${input.nonce}`
}
