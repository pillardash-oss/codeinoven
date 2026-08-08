import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
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

export function createEnrollmentCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const input = randomBytes(16)
  let output = ''
  for (const byte of input) output += alphabet[byte % alphabet.length]
  return `${output.slice(0, 4)}-${output.slice(4, 8)}-${output.slice(8, 12)}-${output.slice(12)}`
}
