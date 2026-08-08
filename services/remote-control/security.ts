import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual
} from 'node:crypto'
import { password as bunPassword } from 'bun'

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  return email.length <= 254 && EMAIL_PATTERN.test(email) ? email : null
}

export function normalizeLabel(value: unknown, maxLength = 100): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  return label.length > 0 && label.length <= maxLength ? label : null
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export function tokenHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url')
}

export function safeTokenEqual(token: string, expectedHash: string): boolean {
  const actual = Buffer.from(tokenHash(token))
  const expected = Buffer.from(expectedHash)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

export async function hashPassword(password: string): Promise<string> {
  return bunPassword.hash(password, {
    algorithm: 'argon2id',
    memoryCost: 65_536,
    timeCost: 3
  })
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bunPassword.verify(password, hash)
}

export function validatePassword(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.length >= 12 && value.length <= 256 ? value : null
}

export function loadMasterKey(encoded: string | undefined): Buffer {
  if (!encoded) throw new Error('REMOTE_MASTER_KEY must be a base64-encoded 32-byte key')
  const key = Buffer.from(encoded, 'base64')
  if (key.length !== 32) throw new Error('REMOTE_MASTER_KEY must decode to exactly 32 bytes')
  return key
}

export function encryptSecret(key: Buffer, plaintext: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`
}

export function decryptSecret(key: Buffer, envelope: string): string {
  const [ivValue, tagValue, ciphertextValue] = envelope.split('.')
  if (!ivValue || !tagValue || !ciphertextValue) throw new Error('Invalid encrypted secret')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivValue, 'base64url'))
  decipher.setAuthTag(Buffer.from(tagValue, 'base64url'))
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextValue, 'base64url')),
    decipher.final()
  ]).toString('utf8')
}

export function createEnrollmentCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const input = randomBytes(16)
  let output = ''
  for (const byte of input) output += alphabet[byte % alphabet.length]
  return `${output.slice(0, 4)}-${output.slice(4, 8)}-${output.slice(8, 12)}-${output.slice(12)}`
}
