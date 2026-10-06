import { spawnSync } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fingerprint } from '../../../src/main/ovens/oven-agent-descriptor'

/** The comment OpenSSH records beside the provisioned key. */
const KEY_COMMENT = 'codeinoven-oven-agent'

export interface IdentityResult {
  privateKey: string
  publicKey: string
  fingerprint: string
  keyPath: string
  created: boolean
  /** Files the public half was authorized in, in the order they were written. */
  authorized: string[]
  /** Set when the key could not be authorized everywhere the machine needs it. */
  warning?: string
}

/** Whether an executable is on PATH, honoring PATHEXT on Windows. */
export function commandExists(name: string): boolean {
  const separator = process.platform === 'win32' ? ';' : delimiter
  const extensions =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
      : ['']
  for (const directory of (process.env['PATH'] ?? '').split(separator).filter(Boolean)) {
    if (existsSync(join(directory, name))) return true
    for (const extension of extensions) {
      if (existsSync(join(directory, `${name}${extension}`))) return true
      if (existsSync(join(directory, `${name}${extension.toLowerCase()}`))) return true
    }
  }
  return false
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/**
 * Whether the current Windows account belongs to Administrators.
 *
 * OpenSSH on Windows reads `administrators_authorized_keys` instead of the
 * per-user file for those accounts, so the deciding fact is group membership,
 * not whether the shell happens to be elevated. The well-known group SID is the
 * one stable way to ask.
 */
function windowsAccountIsAdministrator(): boolean {
  if (process.platform !== 'win32') return false
  const result = spawnSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true })
  return (result.stdout ?? '').includes('S-1-5-32-544')
}

/** Where the public half has to be authorized for SSH to accept the key. */
async function authorizedKeyFiles(): Promise<{ files: string[]; adminFile: string | null }> {
  const files = [join(homedir(), '.ssh', 'authorized_keys')]
  if (process.platform !== 'win32' || !windowsAccountIsAdministrator())
    return { files, adminFile: null }
  const programData = process.env['ProgramData'] ?? 'C:\\ProgramData'
  const adminFile = join(programData, 'ssh', 'administrators_authorized_keys')
  return { files: [...files, adminFile], adminFile }
}

async function appendLine(file: string, line: string): Promise<boolean> {
  let existing = ''
  try {
    existing = await readFile(file, 'utf8')
  } catch {
    // Absent or unreadable means there is nothing to append to yet.
  }
  if (existing.split(/\r?\n/u).some((entry) => entry.trim() === line.trim())) return false
  const separator = existing && !existing.endsWith('\n') ? '\n' : ''
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, `${existing}${separator}${line}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(file, 0o600)
  return true
}

/**
 * Create (or reuse) the dedicated identity and authorize its public half.
 *
 * The private key is never generated anywhere but this machine, so the key the
 * app stores and the key the machine already authorized are the same file.
 * Re-running reuses an existing key: a new one on every start would invalidate
 * every Oven the user already registered.
 */
export async function provisionIdentity(keyPath: string): Promise<IdentityResult> {
  const sshDirectory = dirname(keyPath)
  await mkdir(sshDirectory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(sshDirectory, 0o700)
  const created = !(await isFile(keyPath))
  if (created) {
    if (!commandExists('ssh-keygen'))
      throw new Error(
        'OpenSSH is required to provision a dedicated key. Install the OpenSSH client, or run start with --no-identity.'
      )
    const result = spawnSync(
      'ssh-keygen',
      ['-t', 'ed25519', '-N', '', '-C', KEY_COMMENT, '-f', keyPath, '-q'],
      { encoding: 'utf8', windowsHide: true }
    )
    if (result.status !== 0)
      throw new Error(result.stderr?.trim() || 'ssh-keygen could not create the dedicated key.')
  }
  await chmod(keyPath, 0o600).catch(() => undefined)
  const privateKey = await readFile(keyPath, 'utf8')
  const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim()
  const { files, adminFile } = await authorizedKeyFiles()
  const authorized: string[] = []
  let warning: string | undefined
  for (const file of files) {
    try {
      await appendLine(file, publicKey)
      authorized.push(file)
    } catch (error) {
      if (file === adminFile) {
        warning = `Could not authorize the key in ${file}. As an administrator, add this line there by hand:\n    ${publicKey}`
      } else {
        throw error
      }
    }
  }
  return {
    privateKey,
    publicKey,
    fingerprint: fingerprint(publicKey),
    keyPath,
    created,
    authorized,
    ...(warning ? { warning } : {})
  }
}

/** Read an already-provisioned identity without changing anything. */
export async function readIdentity(keyPath: string): Promise<IdentityResult | null> {
  if (!(await isFile(keyPath))) return null
  const privateKey = await readFile(keyPath, 'utf8')
  const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim()
  return {
    privateKey,
    publicKey,
    fingerprint: fingerprint(publicKey),
    keyPath,
    created: false,
    authorized: []
  }
}

/** Exported for callers that need the same probe the CLI uses. */
export async function identityExists(keyPath: string): Promise<boolean> {
  try {
    await access(keyPath, constants.F_OK)
    return true
  } catch {
    return false
  }
}
