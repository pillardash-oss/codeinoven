/**
 * Platform-safe UUIDv7 generator.
 *
 * UUIDv7 is used for message IDs because it is:
 * - Sortable by time (timestamp prefix)
 * - Compatible with browsers, Electron renderer, and Node main process
 * - Idempotent enough for optimistic → confirmed message reconciliation
 *
 * This module must not import Node-only APIs so it can be bundled into the
 * renderer as well as the main process.
 */

function fillRandom(buf: Uint8Array<ArrayBuffer>): void {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(buf)
  } else {
    // Fallback for environments without Web Crypto API.
    for (let i = 0; i < buf.length; i++) {
      buf[i] = Math.floor(Math.random() * 256)
    }
  }
}

function bytesToUuid(buf: Uint8Array): string {
  const hex = Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const MESSAGE_RANDOM_LENGTH = 14
let lastMessageTimestamp = 0
let messageCounter = 0

function randomBase62(length: number): string {
  const bytes = new Uint8Array(length)
  fillRandom(bytes)
  return Array.from(bytes, (byte) => BASE62[byte % BASE62.length]).join('')
}

/** Encode time and an intra-millisecond counter exactly as OpenCode does. */
function ascendingMessageTime(): string {
  const currentTimestamp = Date.now()
  if (currentTimestamp !== lastMessageTimestamp) {
    lastMessageTimestamp = currentTimestamp
    messageCounter = 0
  }
  messageCounter += 1

  const encoded = BigInt(currentTimestamp) * 0x1000n + BigInt(messageCounter)
  const bytes = new Uint8Array(6)
  for (let index = 0; index < bytes.length; index++) {
    bytes[index] = Number((encoded >> BigInt(40 - 8 * index)) & 0xffn)
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Generate a UUIDv7 string. */
export function uuidv7(): string {
  const buf = new Uint8Array(16)
  let timestamp = BigInt(Date.now())

  // 48-bit Unix timestamp in milliseconds (big-endian).
  for (let index = 5; index >= 0; index--) {
    buf[index] = Number(timestamp & 0xffn)
    timestamp >>= 8n
  }

  // Fill the remaining bytes with random data.
  fillRandom(buf.subarray(6))

  // Version = 7 (0b0111 in the high nibble of the version field).
  buf[6] = (buf[6] & 0x0f) | 0x70
  // Variant = 10 (0b10 in the high bits of the variant field).
  buf[8] = (buf[8] & 0x3f) | 0x80

  return bytesToUuid(buf)
}

/**
 * Generate an ascending OpenCode-compatible message identifier.
 *
 * OpenCode compares message IDs to decide whether a user turn is newer than
 * the preceding assistant turn, so UUID-prefixed IDs can terminate follow-up
 * prompts before the model is called.
 */
export function messageId(): string {
  return `msg_${ascendingMessageTime()}${randomBase62(MESSAGE_RANDOM_LENGTH)}`
}
