import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { Logger } from '../system/logger'
import type { OvenSsh } from './oven-ssh'

const execute = promisify(execFile)

/**
 * Home-relative location of the mirror.
 *
 * The private half lands here when OpenSSH reads the identity from a file on
 * this machine; an agent-held key is mirrored as its public half only, and the
 * forwarded agent on the Oven supplies the secret half at authentication time.
 */
const MIRROR_RELATIVE = '.ssh/codeinoven-local-github'

/** GitHub's SSH endpoint. Other providers are configured explicitly, later. */
const GITHUB_SSH = 'git@github.com'

/** A remote that can be served by the mirrored GitHub identity. */
const GITHUB_ORIGIN = /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https?:\/\/github\.com\/)/iu

/** Home-relative identity files stay inside `~/.ssh`; anything else is refused. */
const MIRROR_PATH = /^\.ssh\/codeinoven-local-github(?:\.pub)?$/u

interface LocalIdentity {
  /** SHA256 fingerprint of the key GitHub accepted on this machine. */
  fingerprint: string
  /** Public half, in `ssh-ed25519 AAAA…` form. */
  publicKey: string
  /** Private key material when the identity is file-backed. */
  privateKey: string | null
}

/** Mirrors already installed per Oven, so a repeated operation uploads nothing. */
const mirrors = new WeakMap<OvenSsh, Map<string, { fingerprint: string; file: string }>>()

/** One mirrored identity: the file the Oven-side Git environment points at. */
export interface LocalGitIdentityMirror {
  /** Home-relative identity path on the Oven. */
  file: string
  /** SHA256 fingerprint, for logs only. Never key material. */
  fingerprint: string
}

/**
 * Mirror the GitHub identity this machine already authenticates with onto one
 * Oven, and return the identity path the Oven-side Git environment must use.
 *
 * The user's rule is that the Oven works as them: if Git is not configured for
 * an Oven, the Oven uses the same account this machine does. A dedicated
 * CodeInOven identity for that Oven always takes precedence, and it is chosen
 * over this mirror by the Oven-side environment, not here.
 *
 * Returns undefined when the checkout is not a GitHub remote, when GitHub is
 * unreachable from this machine, or when no identity was accepted, so the
 * caller reports the real Git failure instead of guessing at one.
 */
export async function mirrorLocalGitIdentity(
  ssh: OvenSsh,
  ovenId: string,
  repository?: string
): Promise<LocalGitIdentityMirror | undefined> {
  if (!(await isGitHubCheckout(repository))) return undefined
  const identity = await acceptedLocalIdentity()
  if (!identity) return undefined
  const file = identity.privateKey ? MIRROR_RELATIVE : `${MIRROR_RELATIVE}.pub`
  const installed = mirrors.get(ssh) ?? new Map<string, { fingerprint: string; file: string }>()
  mirrors.set(ssh, installed)
  const current = installed.get(ovenId)
  if (current?.fingerprint === identity.fingerprint && current.file === file)
    return { file, fingerprint: identity.fingerprint }
  await ssh.putHomeSecretFile(ovenId, file, `${identity.privateKey ?? identity.publicKey}\n`)
  installed.set(ovenId, { fingerprint: identity.fingerprint, file })
  Logger.info('Mirrored the local GitHub identity to an Oven', {
    ovenId,
    fingerprint: identity.fingerprint,
    fileBacked: identity.privateKey !== null
  })
  return { file, fingerprint: identity.fingerprint }
}

/** True when the checkout's origin is a GitHub remote the mirror can serve. */
async function isGitHubCheckout(repository?: string): Promise<boolean> {
  if (!repository) return true
  const remote = await execute('git', ['-C', repository, 'remote', 'get-url', 'origin'], {
    timeout: 5_000,
    maxBuffer: 16 * 1024
  }).catch(() => null)
  return remote !== null && GITHUB_ORIGIN.test(remote.stdout.trim())
}

/**
 * The identity GitHub accepts from this machine, read from OpenSSH itself.
 *
 * Probing `ssh -T` is the only honest answer: it applies the user's config,
 * their default identity files, and their agent, so the app mirrors the key
 * that actually authenticates instead of guessing at a file name.
 */
async function acceptedLocalIdentity(): Promise<LocalIdentity | null> {
  const environment = buildProcessEnvironment()
  const probe = await execute(
    'ssh',
    [
      '-v',
      '-T',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=8',
      GITHUB_SSH
    ],
    { env: environment, timeout: 20_000, maxBuffer: 256 * 1024 }
  ).catch((error: unknown) => ({ stderr: stderrOf(error) }))
  const accepted = /Server accepts key: (.*)$/mu.exec(probe.stderr)?.[1]
  if (!accepted) return null
  const tokens = accepted.trim().split(/\s+/u)
  const fingerprint = tokens.find((token) => /^SHA256:[A-Za-z0-9+/]+$/u.test(token))
  if (!fingerprint) return null
  const source = tokens[0]?.startsWith('/') ? tokens[0] : null
  const publicKey = await publicKeyFor(source, fingerprint, environment)
  if (!publicKey) return null
  const privateKey = source ? await readPrivateKey(source) : null
  return { fingerprint, publicKey, privateKey }
}

/** Derive the public half, from the key file when there is one, else the agent. */
async function publicKeyFor(
  source: string | null,
  fingerprint: string,
  environment: NodeJS.ProcessEnv
): Promise<string | null> {
  if (source) {
    const derived = await execute('ssh-keygen', ['-y', '-f', source], {
      env: environment,
      timeout: 5_000,
      maxBuffer: 32 * 1024
    }).catch(() => null)
    const publicKey = derived?.stdout.trim()
    if (publicKey?.startsWith('ssh-')) return publicKey
  }
  const listed = await execute('ssh-add', ['-L'], {
    env: environment,
    timeout: 5_000,
    maxBuffer: 128 * 1024
  }).catch(() => null)
  return (
    listed?.stdout
      .split(/\r?\n/u)
      .find(
        (line) =>
          /^(?:ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp256) [A-Za-z0-9+/]+=*/u.test(line) &&
          fingerprintOf(line) === fingerprint
      ) ?? null
  )
}

/** Private key material, refused when the file is not a readable key. */
async function readPrivateKey(path: string): Promise<string | null> {
  const contents = await readFile(path, 'utf8').catch(() => null)
  if (!contents || !/-----BEGIN [A-Z ]*PRIVATE KEY-----/u.test(contents)) return null
  return contents
}

/** OpenSSH's own fingerprint form: `SHA256:` plus the unpadded digest of the blob. */
function fingerprintOf(publicKeyLine: string): string | null {
  const blob = publicKeyLine.split(/\s+/u)[1]
  if (!blob) return null
  return `SHA256:${createHash('sha256')
    .update(Buffer.from(blob, 'base64'))
    .digest('base64')
    .replace(/=+$/u, '')}`
}

function stderrOf(error: unknown): string {
  if (!error || typeof error !== 'object' || !('stderr' in error)) return ''
  const value = (error as { stderr?: unknown }).stderr
  return typeof value === 'string' ? value : value instanceof Buffer ? value.toString('utf8') : ''
}

/** Channels that reach the network and feed the state of the checkout. */
export const OVEN_GIT_NETWORK_CHANNELS = new Set([
  'git:fetch',
  'git:fetchBranch',
  'git:pull',
  'git:pullIntegrate',
  'git:push',
  'git:deleteRemoteBranch',
  'git:preparePrResolve'
])

/** A mirrored identity path is the only one this app accepts from the wire. */
export function isMirroredIdentityPath(value: unknown): value is string {
  return typeof value === 'string' && MIRROR_PATH.test(value)
}
