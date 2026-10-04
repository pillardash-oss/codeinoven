import { isAbsolute } from 'node:path'
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { sanitizeCustomSvg } from '../../lib/custom-svg'
import {
  ovenHarnessIdForCommand,
  OVEN_HARNESS_COMMANDS,
  type SaveOvenInput,
  type OvenIcon,
  type OvenConnection,
  type OvenSetupConfiguration,
  type OvenSetupSelectedHarness,
  type OvenSetupGitConfiguration
} from '../../lib/ovens'
import { findHarness } from '../agents/harness-registry'
import type { SecretVault } from '../storage/secret-vault'

export async function validateIdentityPath(value: unknown): Promise<string> {
  const supplied = text(value, 'Identity file', 4096)
  const path = supplied.startsWith('~/') ? join(homedir(), supplied.slice(2)) : supplied
  if (!isAbsolute(path) || /[\r\n]/u.test(path))
    throw new Error('Choose or paste an absolute private-key path.')
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(path, 'r')
  } catch {
    throw new Error('The identity file does not exist or cannot be read.')
  }
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > 128 * 1024) throw new Error('Choose an SSH private-key file.')
    const buffer = Buffer.alloc(256)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (
      !/^-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----\r?\n/u.test(
        buffer.toString('utf8', 0, bytesRead)
      )
    )
      throw new Error('Choose the private key, not its .pub public-key file.')
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      throw new Error(
        'SSH requires a private key readable only by its owner. Set its permissions to 600.'
      )
    return path
  } finally {
    await file.close()
  }
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) {
    throw new TypeError(`${label} must be a nonempty string of at most ${max} characters.`)
  }
  return value.trim()
}

export function ovenId(value: unknown): string {
  const id = text(value, 'Oven ID', 80)
  if (!/^[a-zA-Z0-9_-]+$/u.test(id)) throw new TypeError('Invalid Oven ID.')
  return id
}

export function validateSaveOven(value: unknown): SaveOvenInput {
  if (typeof value !== 'object' || !value) throw new TypeError('Oven settings are required.')
  const input = value as Record<string, unknown>
  if (typeof input.connection !== 'object' || !input.connection) {
    throw new TypeError('An SSH connection is required.')
  }
  const raw = input.connection as Record<string, unknown>
  const host = text(raw.host, 'SSH host', 255)
  if (!/^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*|[a-fA-F0-9:]+)$/u.test(host)) {
    throw new TypeError('SSH host must be an alias, DNS name, or IP address.')
  }
  const user = raw.user === undefined ? undefined : text(raw.user, 'SSH user', 128)
  if (user && !/^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/u.test(user)) throw new TypeError('Invalid SSH user.')
  const port = raw.port
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('SSH port must be between 1 and 65535.')
  }
  if (!['agent', 'identity', 'vault', 'password'].includes(String(raw.authentication))) {
    throw new TypeError('Choose password, SSH agent, an identity file, or a vaulted key.')
  }
  const authentication = raw.authentication as OvenConnection['authentication']
  const connection: OvenConnection = { host, ...(user ? { user } : {}), port, authentication }
  if (authentication === 'identity') {
    const identityFile = text(raw.identityFile, 'Identity file', 4096)
    if (
      (!isAbsolute(identityFile) && !identityFile.startsWith('~/')) ||
      /[\r\n]/u.test(identityFile)
    ) {
      throw new TypeError('Identity file must be an absolute path.')
    }
    connection.identityFile = identityFile
  }
  const icon = text(input.icon, 'Oven icon', 80)
  if (!/^[a-z0-9-]+$/u.test(icon)) throw new TypeError('Choose an Oven icon.')
  const color = text(input.color, 'Oven colour', 7)
  if (!/^#[a-fA-F0-9]{6}$/u.test(color)) throw new TypeError('Choose a six-digit hex colour.')
  const result: SaveOvenInput = {
    ...(input.id === undefined ? {} : { id: ovenId(input.id) }),
    name: text(input.name, 'Oven name', 80),
    icon: icon as OvenIcon,
    ...(input.customSvg === undefined
      ? {}
      : { customSvg: sanitizeCustomSvg(text(input.customSvg, 'Custom SVG', 32768)) }),
    color,
    connection
  }
  if (input.imagePath !== undefined)
    result.imagePath = text(input.imagePath, 'Icon image path', 4096)
  if (input.clearImage !== undefined) {
    if (typeof input.clearImage !== 'boolean') throw new TypeError('Invalid image selection.')
    result.clearImage = input.clearImage
  }
  if (input.privateKey !== undefined) {
    const key = text(input.privateKey, 'Private key', 32_768)
    if (!/^-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----\r?\n/u.test(key)) {
      throw new TypeError('Paste a PEM or OpenSSH private key, not a public key.')
    }
    result.privateKey = `${key}\n`
  }
  if (input.password !== undefined) {
    if (
      typeof input.password !== 'string' ||
      input.password.length > 4096 ||
      input.password.includes('\0')
    )
      throw new TypeError('Invalid SSH account password.')
    result.password = input.password
  }
  if (input.passphrase !== undefined) {
    if (
      typeof input.passphrase !== 'string' ||
      input.passphrase.length > 4096 ||
      input.passphrase.includes('\0')
    ) {
      throw new TypeError('Invalid key passphrase.')
    }
    result.passphrase = input.passphrase
  }
  if (input.publicKey !== undefined) {
    const key = text(input.publicKey, 'Public key', 16_384)
    if (
      !/^(?:ssh-[a-z0-9-]+|ecdsa-[a-z0-9-]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/]+=*(?: [^\r\n]*)?$/u.test(
        key
      )
    ) {
      throw new TypeError('Paste an OpenSSH public key.')
    }
    result.publicKey = key
  }
  return result
}

function boolean(value: unknown, label: string, fallback: boolean): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be true or false.`)
  return value
}

const MAX_SELECTED_HARNESSES = OVEN_HARNESS_COMMANDS.length

function validateSelectedHarness(value: unknown): OvenSetupSelectedHarness {
  if (typeof value !== 'object' || !value) throw new TypeError('Each harness selection must be an object.')
  const raw = value as Record<string, unknown>
  const harnessId = text(raw.harnessId, 'Harness', 64)
  // The renderer sends the canonical harness id; accept only registered ones so
  // a typo cannot become an install of something unknown.
  if (!findHarness(harnessId)) throw new TypeError(`Unknown harness: ${harnessId}`)
  if (!OVEN_HARNESS_COMMANDS.some((command) => ovenHarnessIdForCommand(command) === harnessId))
    throw new TypeError(`${findHarness(harnessId)?.name ?? harnessId} is not available on remote Ovens.`)
  const selection: OvenSetupSelectedHarness = { harnessId }
  if (raw.accountId !== undefined) selection.accountId = text(raw.accountId, 'Account', 128)
  if (raw.install !== undefined) selection.install = boolean(raw.install, 'Install selection', true)
  if (raw.update !== undefined) selection.update = boolean(raw.update, 'Update selection', true)
  return selection
}

/**
 * Validate a submitted Git identity without ever storing or echoing it.
 *
 * Raw key material is converted into vault references by the caller. Any
 * configuration that still carries a `privateKey` or `passphrase` field is
 * rejected outright, because that value would otherwise reach a persisted
 * operation record and a progress event.
 */
function validateGitConfiguration(value: unknown): OvenSetupGitConfiguration {
  if (value === undefined) return { enabled: false, host: 'github' }
  if (typeof value !== 'object' || !value) throw new TypeError('Git settings are required.')
  const raw = value as Record<string, unknown>
  for (const forbidden of ['privateKey', 'passphrase', 'password', 'secret'] as const) {
    if (raw[forbidden] !== undefined)
      throw new TypeError(
        'Secret values cannot be part of a persisted setup operation. Submit them once so they can be stored in the encrypted vault.'
      )
  }
  const host = raw.host === undefined ? 'github' : text(raw.host, 'Git host', 16)
  if (host !== 'github' && host !== 'any')
    throw new TypeError('Only GitHub SSH identities are supported in this release.')
  const git: OvenSetupGitConfiguration = {
    enabled: boolean(raw.enabled, 'Git setup', false),
    host
  }
  if (raw.privateKeyRef !== undefined) git.privateKeyRef = text(raw.privateKeyRef, 'Key reference', 256)
  if (raw.publicKeyFingerprint !== undefined)
    git.publicKeyFingerprint = text(raw.publicKeyFingerprint, 'Key fingerprint', 128)
  if (raw.publicKey !== undefined) {
    const publicKey = text(raw.publicKey, 'Public key', 16_384)
    if (!/^(?:ssh-[a-z0-9-]+|ecdsa-[a-z0-9-]+|sk-[a-z0-9@.-]+) [A-Za-z0-9+/]+=*(?: [^\r\n]*)?$/u.test(publicKey))
      throw new TypeError('Paste an OpenSSH public key.')
    git.publicKey = publicKey
  }
  if (git.enabled && !git.privateKeyRef)
    throw new TypeError('Paste a dedicated SSH private key to configure Git on this Oven.')
  return git
}

/**
 * Validate a complete setup request. Local ovens never receive full setup, and
 * the whole configuration is size-bounded so it can be journaled and resumed.
 */
export function validateOvenSetupConfiguration(value: unknown): OvenSetupConfiguration {
  if (typeof value !== 'object' || !value || Array.isArray(value))
    throw new TypeError('Invalid setup configuration.')
  if (JSON.stringify(value).length > 64 * 1024)
    throw new TypeError('The setup configuration is too large.')
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.selectedHarnesses) || raw.selectedHarnesses.length > MAX_SELECTED_HARNESSES)
    throw new TypeError('Choose at most one entry per available harness.')
  const selectedHarnesses = raw.selectedHarnesses.map(validateSelectedHarness)
  const seen = new Set<string>()
  for (const selection of selectedHarnesses) {
    if (seen.has(selection.harnessId)) throw new TypeError('Each harness can only be selected once.')
    seen.add(selection.harnessId)
  }
  return {
    selectedHarnesses,
    synchronizeAccounts: boolean(raw.synchronizeAccounts, 'Account synchronization', true),
    synchronizeConfiguration: boolean(raw.synchronizeConfiguration, 'Configuration synchronization', true),
    git: validateGitConfiguration(raw.git),
    packageUpgrades: boolean(raw.packageUpgrades, 'Package upgrades', false)
  }
}

/** Guard for read-only setup requests, which must not carry a configuration at all. */
export function assertNoSecretFields(value: unknown, label: string): void {
  if (typeof value !== 'object' || !value) return
  const serialized = JSON.stringify(value) ?? ''
  if (/"(?:privateKey|passphrase|password|token|secret)"\s*:/u.test(serialized))
    throw new TypeError(`${label} must not contain secret values.`)
}

/** Reject harness ids the remote service cannot run, and return the canonical id. */
export function validateOvenHarnessId(value: unknown): string {
  const id = text(value, 'Harness', 64)
  if (!findHarness(id)) throw new TypeError(`Unknown harness: ${id}`)
  if (!OVEN_HARNESS_COMMANDS.some((command) => ovenHarnessIdForCommand(command) === id))
    throw new TypeError('That harness is not available on remote Ovens.')
  return id
}

const PRIVATE_KEY_PATTERN = /^-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----/u

/**
 * Convert a submitted setup request into a persisted configuration.
 *
 * This is the one place raw key material is allowed to arrive. The private key
 * is moved into the encrypted vault and replaced by a reference before
 * validation, so what reaches the operation record, the
 * journal, and every progress event contains no secret at all. Submitting the
 * same key again reuses the existing reference instead of growing the vault.
 */
export async function validateStartOvenSetup(
  value: unknown,
  vault: SecretVault
): Promise<OvenSetupConfiguration> {
  if (typeof value !== 'object' || !value || Array.isArray(value))
    throw new TypeError('Invalid setup configuration.')
  const submitted = value as Record<string, unknown>
  const wrapped = Object.hasOwn(submitted, 'configuration')
  if (wrapped && Object.keys(submitted).some((key) => !['configuration', 'gitIdentity'].includes(key)))
    throw new TypeError('The setup request contains unsupported fields.')
  const raw = submitted.configuration && typeof submitted.configuration === 'object' && !Array.isArray(submitted.configuration)
    ? { ...(submitted.configuration as Record<string, unknown>) }
    : { ...submitted }
  const identity = submitted.gitIdentity
  if (identity !== undefined) {
    if (!identity || typeof identity !== 'object' || Array.isArray(identity))
      throw new TypeError('Invalid Git identity configuration.')
    if (Object.keys(identity).some((key) => !['privateKey', 'passphrase'].includes(key)))
      throw new TypeError('The Git identity contains unsupported fields.')
    const git = raw.git && typeof raw.git === 'object' && !Array.isArray(raw.git)
      ? { ...(raw.git as Record<string, unknown>) }
      : {}
    const identityFields = identity as Record<string, unknown>
    if (identityFields.privateKey !== undefined) git.privateKey = identityFields.privateKey
    if (identityFields.passphrase !== undefined)
      throw new TypeError('Oven Git setup does not accept key passphrases. Load the encrypted key into the Oven ssh-agent first.')
    raw.git = git
  }
  const gitInput = raw.git
  if (gitInput && typeof gitInput === 'object' && !Array.isArray(gitInput)) {
    const git = { ...(gitInput as Record<string, unknown>) }
    if (git.privateKey !== undefined) {
      const privateKey = text(git.privateKey, 'Private key', 64 * 1024)
      if (!PRIVATE_KEY_PATTERN.test(privateKey)) throw new TypeError('Paste an OpenSSH private key.')
      git.privateKeyRef = await vault.save(
        privateKey,
        typeof git.privateKeyRef === 'string' && git.privateKeyRef ? git.privateKeyRef : undefined
      )
      delete git.privateKey
    }
    raw.git = git
  }
  const configuration = validateOvenSetupConfiguration(raw)
  // Nothing secret may survive into a persisted operation. Fail closed if it did.
  assertNoSecretFields(configuration, 'The setup configuration')
  return configuration
}
