import { describe, expect, it } from 'vitest'
import {
  MAX_ENCRYPTED_PAYLOAD_BYTES,
  MAX_PLAINTEXT_BYTES,
  MAX_RAW_PAYLOAD_CHARS,
  MAX_REPLAY_CACHE,
  decryptPayload,
  encryptPayload,
  replayCacheSize
} from '../../../../src/renderer/lib/remote/session-security'
describe('payload encryption', () => {
  it('round-trips a payload through AES-GCM', async () => {
    const ciphertext = await encryptPayload('shared-secret', 'hello phone')
    expect(ciphertext).not.toContain('hello phone')
    await expect(decryptPayload('shared-secret', ciphertext)).resolves.toBe('hello phone')
  })

  it('produces a distinct ciphertext each time for the same plaintext', async () => {
    const first = await encryptPayload('shared-secret', 'same')
    const second = await encryptPayload('shared-secret', 'same')
    expect(first).not.toBe(second)
  })

  it('fails to decrypt with the wrong secret', async () => {
    const ciphertext = await encryptPayload('server-secret', 'payload')
    await expect(decryptPayload('client-secret', ciphertext)).rejects.toThrow()
  })

  it('rejects malformed ciphertext', async () => {
    await expect(decryptPayload('shared-secret', 'not-a-payload')).rejects.toThrow(
      'malformed-encrypted-payload'
    )
  })
})

describe('payload size limits', () => {
  it('rejects an encrypted payload above the ciphertext cap before decrypting', async () => {
    const oversized = await encryptPayload(
      'shared-secret',
      'x'.repeat(MAX_ENCRYPTED_PAYLOAD_BYTES + 1024)
    )
    await expect(decryptPayload('shared-secret', oversized)).rejects.toThrow(
      'oversized-encrypted-payload'
    )
  })

  it('rejects a raw envelope above the cap before any crypto work on the payload', async () => {
    // A structurally valid envelope whose base64 ciphertext segment is oversized
    // but is NOT real ciphertext: the cap must fire before hashing or decrypting.
    const timestamp = Date.now().toString(36)
    const hugeSegment = 'A'.repeat(Math.ceil((MAX_ENCRYPTED_PAYLOAD_BYTES * 4) / 3) + 1)
    const envelope = `v2:${timestamp}:MTIzNDU2Nzg5MDEy:${hugeSegment}`
    await expect(decryptPayload('shared-secret', envelope)).rejects.toThrow(
      'oversized-encrypted-payload'
    )
  })

  it('lets the raw oversized check win over the malformed check', async () => {
    // No colons at all, so this payload is malformed — but the raw string
    // length check runs first and must reject it as oversized.
    const oversized = 'x'.repeat(MAX_RAW_PAYLOAD_CHARS + 1)
    await expect(decryptPayload('shared-secret', oversized)).rejects.toThrow(
      'oversized-encrypted-payload'
    )
  })

  it('rejects a decrypted payload above the plaintext cap before decoding it', async () => {
    // Ciphertext of a payload larger than the plaintext cap but still below the
    // encrypted cap, so the plaintext check is what rejects it.
    const oversized = await encryptPayload('shared-secret', 'y'.repeat(MAX_PLAINTEXT_BYTES + 1024))
    expect(oversized.length).toBeGreaterThan(0)
    await expect(decryptPayload('shared-secret', oversized)).rejects.toThrow(
      'oversized-plaintext-payload'
    )
  })

  it('accepts a payload within both caps', async () => {
    const small = await encryptPayload('shared-secret', 'small payload')
    await expect(decryptPayload('shared-secret', small)).resolves.toBe('small payload')
  })
})

describe('replay protection', () => {
  it('rejects the same encrypted payload on a second decrypt', async () => {
    const ciphertext = await encryptPayload('shared-secret', 'one-time-message')
    await expect(decryptPayload('shared-secret', ciphertext)).resolves.toBe('one-time-message')
    await expect(decryptPayload('shared-secret', ciphertext)).rejects.toThrow(
      'replayed-encrypted-payload'
    )
  })

  it('keeps the replay store bounded at the fixed-size cap', async () => {
    const before = replayCacheSize()
    for (let index = 0; index < MAX_REPLAY_CACHE + 8; index += 1) {
      const ciphertext = await encryptPayload('shared-secret', `payload-${index}`)
      await decryptPayload('shared-secret', ciphertext)
    }
    expect(replayCacheSize() - before).toBeLessThanOrEqual(MAX_REPLAY_CACHE)
  })
})
