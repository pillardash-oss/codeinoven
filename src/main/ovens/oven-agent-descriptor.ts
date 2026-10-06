import { createHash } from 'node:crypto'
import {
  OVEN_AGENT_CODE_PREFIX,
  OVEN_AGENT_DESCRIPTOR_VERSION,
  type OvenAgentDescriptor,
  type OvenAgentIdentity
} from '../../lib/ovens'

/**
 * SHA-256 fingerprint of an OpenSSH public key, in the form `ssh-keygen -lf`
 * prints.
 *
 * Shared by the app and the published `cio-oven` CLI so the fingerprint a user
 * compares against GitHub is computed the same way on both sides.
 */
export function fingerprint(publicKey: string): string {
  const blob = publicKey.trim().split(/\s+/u)[1]
  if (!blob) return 'unknown'
  const digest = createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64')
  return `SHA256:${digest.replace(/=+$/u, '')}`
}

/** A descriptor is tiny; anything larger is not one of ours. */
const MAX_CODE_BYTES = 256 * 1024
const PRIVATE_KEY =
  /^-----BEGIN OPENSSH PRIVATE KEY-----\r?\n[\s\S]{1,32000}\r?\n-----END OPENSSH PRIVATE KEY-----\r?\n?$/u
const PUBLIC_KEY = /^ssh-ed25519 [A-Za-z0-9+/]{20,}={0,3}(?: [^\r\n]{0,200})?$/u

/**
 * Turn a descriptor into the single-line registration code a user pastes.
 *
 * base64url keeps the code copy-safe: it contains no characters a shell, chat
 * client, or clipboard will mangle, and no newlines.
 */
export function encodeOvenAgentDescriptor(descriptor: OvenAgentDescriptor): string {
  const json = JSON.stringify(validateOvenAgentDescriptor(descriptor))
  return `${OVEN_AGENT_CODE_PREFIX}${Buffer.from(json, 'utf8').toString('base64url')}`
}

/**
 * Read a descriptor from whatever the user actually pasted.
 *
 * The agent prints human instructions around the code, so the prefix is located
 * anywhere in the input rather than only at its start. A saved descriptor file is
 * raw JSON, which is accepted too.
 */
export function decodeOvenAgentDescriptor(input: string): OvenAgentDescriptor {
  if (typeof input !== 'string' || !input.trim())
    throw new TypeError('Paste the registration code the agent printed.')
  if (Buffer.byteLength(input, 'utf8') > MAX_CODE_BYTES)
    throw new TypeError('That registration code is too large to be an Oven agent descriptor.')
  const marker = input.indexOf(OVEN_AGENT_CODE_PREFIX)
  let json: string
  if (marker >= 0) {
    const token = input.slice(marker + OVEN_AGENT_CODE_PREFIX.length).match(/^[A-Za-z0-9_-]+/u)?.[0]
    if (!token) throw new TypeError('The registration code is incomplete. Paste the whole line.')
    try {
      json = Buffer.from(token, 'base64url').toString('utf8')
    } catch {
      throw new TypeError('The registration code is not valid base64url data.')
    }
  } else {
    json = input.trim()
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new TypeError('That is not a CodeInOven Oven agent registration code.')
  }
  return validateOvenAgentDescriptor(parsed)
}

/** Strict validation shared by encoding and decoding. */
export function validateOvenAgentDescriptor(value: unknown): OvenAgentDescriptor {
  if (typeof value !== 'object' || !value || Array.isArray(value))
    throw new TypeError('The Oven agent descriptor must be an object.')
  const raw = value as Record<string, unknown>
  if (raw.kind !== 'codeinoven-oven-agent')
    throw new TypeError('That registration code is not from a CodeInOven Oven agent.')
  const version = integer(raw.version, 'Descriptor version', 1, 1_000)
  if (version !== OVEN_AGENT_DESCRIPTOR_VERSION)
    throw new TypeError(
      `This registration code was written by a different agent format (v${version}). Update CodeInOven or rerun the agent.`
    )
  const protocolVersion = integer(raw.protocolVersion, 'Protocol version', 1, 1_000)
  const serviceRevision = token(raw.serviceRevision, 'Service revision', 128)
  if (!/^[A-Za-z0-9._-]+$/u.test(serviceRevision))
    throw new TypeError('The descriptor carries an invalid service revision.')
  const port = integer(raw.port, 'SSH port', 1, 65535)
  const identity = raw.identity === undefined ? undefined : validateIdentity(raw.identity)
  return {
    kind: 'codeinoven-oven-agent',
    version,
    protocolVersion,
    serviceRevision,
    platform: label(raw.platform, 'Platform', 32),
    architecture: label(raw.architecture, 'Architecture', 32),
    hostname: label(raw.hostname, 'Host name', 255),
    user: label(raw.user, 'SSH user', 128),
    port,
    name: label(raw.name, 'Oven name', 80),
    dataRoot: path(raw.dataRoot, 'Data root'),
    nodeVersion: label(raw.nodeVersion, 'Node version', 64),
    ...(identity ? { identity } : {}),
    createdAt: integer(raw.createdAt, 'Created time', 0, Number.MAX_SAFE_INTEGER)
  }
}

export function descriptorHasIdentity(
  descriptor: OvenAgentDescriptor
): descriptor is OvenAgentDescriptor & { identity: OvenAgentIdentity } {
  return descriptor.identity !== undefined
}

function validateIdentity(value: unknown): OvenAgentIdentity {
  if (typeof value !== 'object' || !value || Array.isArray(value))
    throw new TypeError('The descriptor identity must be an object.')
  const raw = value as Record<string, unknown>
  if (raw.algorithm !== 'ed25519')
    throw new TypeError('The Oven agent identity must be an ed25519 key.')
  if (typeof raw.privateKey !== 'string' || !PRIVATE_KEY.test(raw.privateKey))
    throw new TypeError('The descriptor carries an invalid private key.')
  if (typeof raw.publicKey !== 'string' || !PUBLIC_KEY.test(raw.publicKey))
    throw new TypeError('The descriptor carries an invalid public key.')
  return { algorithm: 'ed25519', privateKey: raw.privateKey, publicKey: raw.publicKey }
}

function integer(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new TypeError(`${label} is out of range.`)
  return value
}

function token(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new TypeError(`${label} is required.`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max || trimmed.includes('\0'))
    throw new TypeError(`${label} is required.`)
  return trimmed
}

/** Human-facing text that must stay a single line without control characters. */
function label(value: unknown, name: string, max: number): string {
  const text = token(value, name, max)
  if (hasControlCharacters(text)) throw new TypeError(`${name} contains control characters.`)
  return text
}

/** A POSIX or Windows absolute path, exactly as the agent reported it. */
function path(value: unknown, name: string): string {
  const text = token(value, name, 4096)
  if (hasControlCharacters(text)) throw new TypeError(`${name} contains control characters.`)
  if (!(text.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(text)))
    throw new TypeError(`${name} must be an absolute path.`)
  return text
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
