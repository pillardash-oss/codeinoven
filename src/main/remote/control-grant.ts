export interface DesktopControlGrant {
  desktopPublicKey: JsonWebKey
  ciphertext: string
}

function toBase64Url(bytes: Uint8Array): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
  let output = ''
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0
    const second = bytes[index + 1]
    const third = bytes[index + 2]
    output += alphabet[first >> 2]
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)]
    if (second !== undefined) output += alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)]
    if (third !== undefined) output += alphabet[third & 63]
  }
  return output
}

function grantContext(desktopId: string, mobileDeviceId: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`codeinoven-control-grant:${desktopId}:${mobileDeviceId}`)
}

export async function createDesktopControlGrant(input: {
  desktopId: string
  mobileDeviceId: string
  mobilePublicKey: JsonWebKey
  controlSecret: string
}): Promise<DesktopControlGrant> {
  const mobileKey = await crypto.subtle.importKey(
    'jwk',
    input.mobilePublicKey,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  )
  const desktopKeys = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveKey']
  )
  const encryptionKey = await crypto.subtle.deriveKey(
    { name: 'ECDH', public: mobileKey },
    desktopKeys.privateKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt']
  )
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: grantContext(input.desktopId, input.mobileDeviceId) },
    encryptionKey,
    new TextEncoder().encode(input.controlSecret)
  )
  return {
    desktopPublicKey: await crypto.subtle.exportKey('jwk', desktopKeys.publicKey),
    ciphertext: `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`
  }
}
