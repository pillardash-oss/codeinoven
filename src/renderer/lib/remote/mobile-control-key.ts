import { loadDeviceIdentity } from './device-identity'

const DATABASE_NAME = 'codeinoven-remote-keys'
const STORE_NAME = 'control-keys'
const KEY_VERSION = 'p256-v1'

interface StoredMobileKeys {
  privateKey: CryptoKey
  publicKey: CryptoKey
}

export interface MobileGrantIdentity {
  id: string
  name: string
  publicKey: JsonWebKey
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open secure key storage'))
  })
}

async function readStoredKeys(key: string): Promise<StoredMobileKeys | null> {
  const database = await openDatabase()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly')
    const request = transaction.objectStore(STORE_NAME).get(key)
    request.onsuccess = () => resolve((request.result as StoredMobileKeys | undefined) ?? null)
    request.onerror = () => reject(request.error ?? new Error('Could not read secure key storage'))
    transaction.oncomplete = () => database.close()
  })
}

async function writeStoredKeys(key: string, value: StoredMobileKeys): Promise<void> {
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not save secure key'))
  })
  database.close()
}

async function loadOrCreateKeys(deviceId: string): Promise<StoredMobileKeys> {
  const storageKey = `${KEY_VERSION}:${deviceId}`
  const stored = await readStoredKeys(storageKey)
  if (stored?.privateKey && stored.publicKey) return stored
  const generated = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, [
    'deriveKey'
  ])
  const keys = { privateKey: generated.privateKey, publicKey: generated.publicKey }
  await writeStoredKeys(storageKey, keys)
  return keys
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padding = '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(normalized + padding)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

function grantContext(desktopId: string, mobileDeviceId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`codeinoven-control-grant:${desktopId}:${mobileDeviceId}`)
}

export async function mobileGrantIdentity(): Promise<MobileGrantIdentity> {
  const identity = loadDeviceIdentity()
  const keys = await loadOrCreateKeys(identity.id)
  return {
    id: identity.id,
    name: identity.name,
    publicKey: await crypto.subtle.exportKey('jwk', keys.publicKey)
  }
}

export async function decryptDesktopGrant(input: {
  desktopId: string
  mobileDeviceId: string
  desktopPublicKey: JsonWebKey
  ciphertext: string
}): Promise<string> {
  const keys = await loadOrCreateKeys(input.mobileDeviceId)
  const desktopKey = await crypto.subtle.importKey(
    'jwk',
    input.desktopPublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
  const decryptionKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: desktopKey },
    keys.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt']
  )
  const [ivValue, encryptedValue, extra] = input.ciphertext.split('.')
  if (!ivValue || !encryptedValue || extra) throw new Error('invalid-control-grant')
  const decrypted = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: decodeBase64Url(ivValue),
      additionalData: grantContext(input.desktopId, input.mobileDeviceId)
    },
    decryptionKey,
    decodeBase64Url(encryptedValue)
  )
  return new TextDecoder().decode(decrypted)
}
