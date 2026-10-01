import { isAbsolute } from 'node:path'
import { sanitizeCustomSvg } from '../../lib/custom-svg'
import { type SaveOvenInput, type OvenIcon, type OvenConnection } from '../../lib/ovens'

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
  if (!['agent', 'identity', 'vault'].includes(String(raw.authentication))) {
    throw new TypeError('Choose SSH agent, an identity file, or a vaulted key.')
  }
  const authentication = raw.authentication as OvenConnection['authentication']
  const connection: OvenConnection = { host, ...(user ? { user } : {}), port, authentication }
  if (authentication === 'identity') {
    const identityFile = text(raw.identityFile, 'Identity file', 4096)
    if (!isAbsolute(identityFile) || /[\r\n]/u.test(identityFile)) {
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
  if (input.privateKey !== undefined) {
    const key = text(input.privateKey, 'Private key', 32_768)
    if (!/^-----BEGIN (?:OPENSSH|RSA|EC|DSA|ENCRYPTED)? ?PRIVATE KEY-----\r?\n/u.test(key)) {
      throw new TypeError('Paste a PEM or OpenSSH private key, not a public key.')
    }
    result.privateKey = `${key}\n`
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
