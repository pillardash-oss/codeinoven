import { spawnSync } from 'node:child_process'
import { constants, existsSync } from 'node:fs'
import { access, chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { delimiter, dirname, join, posix } from 'node:path'
import { homedir } from 'node:os'
import { fingerprint } from '../../../src/main/ovens/oven-agent-descriptor'

/** The comment OpenSSH records beside the provisioned key. */
const KEY_COMMENT = 'codeinoven-oven-agent'

/** Well-known SIDs, used instead of group names Windows localizes. */
const ADMINISTRATORS_SID = 'S-1-5-32-544'
const SYSTEM_SID = 'S-1-5-18'

/**
 * How OpenSSH classifies the account this machine runs as.
 *
 * Windows sshd authorizes an administrator account from the machine-wide file
 * and ignores that account's own `authorized_keys`, so the class decides which
 * file has to carry the key.
 */
export type OvenSshAccountKind = 'administrator' | 'standard'

export interface AuthorizedKeyPlan {
  kind: OvenSshAccountKind
  /** Every file the key is authorized in, most authoritative first. */
  files: string[]
  /** The file sshd reads keys from for this account, so the one that must carry it. */
  requiredFile: string
  /** The machine-wide file, present only for an administrator account. */
  adminFile: string | null
}

export interface AuthorizedKeyPlanInput {
  platform: string
  /** Whether the account belongs to Administrators, whether or not it is elevated. */
  administrator: boolean
  home: string
  programData: string
}

/**
 * Decide where the public half has to be authorized for SSH to accept the key.
 *
 * Windows sshd ships a `Match Group administrators` block that points those
 * accounts at the machine-wide file. Writing only `~/.ssh/authorized_keys`
 * there looks like a complete setup and then refuses every connection with
 * `Permission denied`, so both the installer and this CLI ask this question
 * first and report the answer.
 */
export function authorizedKeyPlan(input: AuthorizedKeyPlanInput): AuthorizedKeyPlan {
  // These are paths on the target machine, rendered as strings that the
  // installer and the Oven's sshd both read. Join them with POSIX separators
  // regardless of the host computing the plan: `join()` would emit backslashes
  // on a Windows checkout, so the same plan would name different files per
  // host. Windows accepts mixed separators, so the POSIX form is correct there
  // too.
  const perUser = posix.join(input.home, '.ssh', 'authorized_keys')
  if (input.platform !== 'win32' || !input.administrator)
    return { kind: 'standard', files: [perUser], requiredFile: perUser, adminFile: null }
  const adminFile = posix.join(input.programData, 'ssh', 'administrators_authorized_keys')
  return { kind: 'administrator', files: [adminFile, perUser], requiredFile: adminFile, adminFile }
}

export interface IdentityResult {
  privateKey: string
  publicKey: string
  fingerprint: string
  keyPath: string
  created: boolean
  /** How OpenSSH classifies this account. */
  account: OvenSshAccountKind
  /** Files the public half was written to and read back from. */
  authorized: string[]
  /** The file sshd reads keys from for this account. */
  requiredFile: string
  /** Whether the file sshd reads already carries the key. */
  verified: boolean
  /** Work the user has to finish by hand before a connection can succeed. */
  warnings: string[]
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
 * Group membership is the deciding fact, not elevation: an administrator who
 * runs an ordinary shell still gets the machine-wide treatment from sshd, and
 * asking the token would answer "no" and authorize the wrong file. The
 * well-known SID is the one form of the group that no locale renames.
 */
function windowsAccountIsAdministrator(): boolean {
  if (process.platform !== 'win32') return false
  const result = spawnSync('whoami', ['/groups'], { encoding: 'utf8', windowsHide: true })
  return (result.stdout ?? '').includes(ADMINISTRATORS_SID)
}

/** The plan that matches the machine this code is running on. */
function currentAccountPlan(): AuthorizedKeyPlan {
  return authorizedKeyPlan({
    platform: process.platform,
    administrator: windowsAccountIsAdministrator(),
    home: homedir(),
    programData: process.env['ProgramData'] ?? 'C:\\ProgramData'
  })
}

async function hasLine(file: string, line: string): Promise<boolean> {
  try {
    const existing = await readFile(file, 'utf8')
    return existing.split(/\r?\n/u).some((entry) => entry.trim() === line.trim())
  } catch {
    return false
  }
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
 * Narrow a key file to the accounts sshd allows to read it.
 *
 * sshd on Windows silently skips a key it finds in a file another account can
 * read, and the machine-wide file shipped by the OpenSSH feature inherits an
 * ACL that is not restricted to Administrators and SYSTEM. Returns the command
 * the user has to run when this shell cannot apply it.
 */
function restrictKeyFileAccess(file: string, grant: string[]): string | undefined {
  const result = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', ...grant], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status === 0) return undefined
  return (
    `Could not restrict access to ${file}, and sshd ignores a key other accounts can read. ` +
    `Run this in an elevated shell:\n    icacls "${file}" /inheritance:r /grant:r ${grant.join(' ')}`
  )
}

/** The ACL sshd expects: the owning account plus SYSTEM and Administrators. */
function keyFileGrants(file: string, plan: AuthorizedKeyPlan, userSid: string): string[] {
  if (file === plan.adminFile) return [`*${SYSTEM_SID}:F`, `*${ADMINISTRATORS_SID}:F`]
  return [`*${userSid}:F`, `*${SYSTEM_SID}:F`, `*${ADMINISTRATORS_SID}:F`]
}

/** The current account's SID, needed to keep it in the ACL it already had. */
function currentUserSid(): string | undefined {
  const result = spawnSync('whoami', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true
  })
  if (result.status !== 0) return undefined
  const sid = (result.stdout ?? '').trim().replace(/"/gu, '').split(',').pop()?.trim()
  return sid && /^S-1-[\d-]+$/u.test(sid) ? sid : undefined
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
  const plan = currentAccountPlan()
  const userSid = process.platform === 'win32' ? currentUserSid() : undefined
  const authorized: string[] = []
  const warnings: string[] = []
  for (const file of plan.files) {
    try {
      await appendLine(file, publicKey)
    } catch (error) {
      if (file !== plan.adminFile) throw error
      warnings.push(
        `Could not write ${file}. As an administrator, add this line there by hand:\n    ${publicKey}`
      )
      continue
    }
    if (userSid) {
      const aclWarning = restrictKeyFileAccess(file, keyFileGrants(file, plan, userSid))
      if (aclWarning) warnings.push(aclWarning)
    }
    if (await hasLine(file, publicKey)) authorized.push(file)
    else warnings.push(`The key could not be read back from ${file} after writing it.`)
  }
  const verified = authorized.includes(plan.requiredFile)
  if (!verified)
    warnings.push(
      `sshd reads this account's keys from ${plan.requiredFile}, which does not carry the key, so CodeInOven will be refused with "Permission denied".`
    )
  return {
    privateKey,
    publicKey,
    fingerprint: fingerprint(publicKey),
    keyPath,
    created,
    account: plan.kind,
    authorized,
    requiredFile: plan.requiredFile,
    verified,
    warnings
  }
}

/** Read an already-provisioned identity without changing anything. */
export async function readIdentity(keyPath: string): Promise<IdentityResult | null> {
  if (!(await isFile(keyPath))) return null
  const privateKey = await readFile(keyPath, 'utf8')
  const publicKey = (await readFile(`${keyPath}.pub`, 'utf8')).trim()
  const plan = currentAccountPlan()
  const verified = await hasLine(plan.requiredFile, publicKey)
  return {
    privateKey,
    publicKey,
    fingerprint: fingerprint(publicKey),
    keyPath,
    created: false,
    account: plan.kind,
    authorized: verified ? [plan.requiredFile] : [],
    requiredFile: plan.requiredFile,
    verified,
    warnings: verified
      ? []
      : [
          `The key is missing from ${plan.requiredFile}, so CodeInOven will be refused with "Permission denied". Run start again to authorize it.`
        ]
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
