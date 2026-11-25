/**
 * Where one Oven keeps a credential at rest, and why it sometimes cannot.
 *
 * An Oven has no Electron, so it has no `safeStorage`: the only encrypted store
 * it can honestly offer is the one its own operating system already runs — the
 * login keychain on macOS (holding the key to encrypted files, because its CLI
 * cannot take a long value on stdin), the Secret Service on Linux, DPAPI on Windows. Each
 * platform therefore gets one small backend that speaks its native tool, and a
 * machine with none of them reports itself unavailable instead of writing
 * plaintext under a reassuring name.
 *
 * Three rules hold for every backend:
 *
 * 1. A value reaches the store on stdin, never in argv, so it cannot be read out
 *    of a process list by another account on the same machine.
 * 2. A value is bounded. A credential bundle is a handful of tokens, not a file,
 *    so anything above 32 KiB is refused rather than carried around.
 * 3. Every command runs through the injectable `SecretCommandRunner`, so a test
 *    never touches a real keychain and a probe never surprises an operator.
 */
import { execFile } from 'node:child_process'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { OvenUtilitySecretBackend } from '../../../../lib/oven-utility-host'

/** Most one stored value may carry: a bundle of tokens, never a file. */
export const OVEN_UTILITY_SECRET_MAX_VALUE_BYTES = 32 * 1024

/** Most utility bundles one Oven keeps at rest. */
export const OVEN_UTILITY_SECRET_MAX_KEYS = 64

/**
 * The service name every platform backend files an Oven's credentials under.
 *
 * It names this app on the user's machine rather than one Oven: a user who
 * reimages or replaces an Oven still finds their credentials under the name they
 * expect, and nothing is filed under a machine name that changes.
 */
const OVEN_UTILITY_SECRET_SERVICE = 'codeinoven-oven'

/** Longest backend key this module accepts, which is a utility id in practice. */
const MAX_KEY_LENGTH = 200

/** What the macOS keychain answers when the item it was asked for is absent. */
const KEYCHAIN_ITEM_NOT_FOUND = 44

/** The keychain account holding the key that encrypts this Oven's files on macOS. */
const KEYCHAIN_KEY_ACCOUNT = 'cio-store-key'

/** The cipher for those files, and the sizes of what precedes the ciphertext. */
const FILE_CIPHER = 'aes-256-gcm'
const FILE_IV_BYTES = 12
const FILE_TAG_BYTES = 16

/** Shorter than the daemon's 15 s wait, so a hung store still gets reported. */
const COMMAND_TIMEOUT_MS = 10_000

/** What a command that was killed for taking too long exits with, as `timeout` does. */
const COMMAND_TIMED_OUT = 124

/** Longest stderr excerpt an error message carries. */
const MAX_ERROR_DETAIL = 240

/**
 * Why a Linux machine with no session bus cannot keep a credential.
 *
 * Exported because the exact words are part of what the app shows once, and a
 * test asserts them rather than a substring of them.
 */
export const OVEN_UTILITY_LINUX_NO_SESSION_BUS_REASON =
  'This Linux machine has no session bus (DBUS_SESSION_BUS_ADDRESS is unset), so no secret service can be reached.'

/** Why a Linux machine without `secret-tool` cannot keep a credential. */
export const OVEN_UTILITY_LINUX_NO_SECRET_TOOL_REASON =
  'This Linux machine has no `secret-tool`, so no secret service can be reached.'

/** Why a Linux machine whose secret service does not answer cannot keep a credential. */
const OVEN_UTILITY_LINUX_NO_SERVICE_REASON =
  'The secret service on this Linux machine is locked or not running'

/** A key nothing is filed under, looked up to see whether the service answers. */
const PROBE_KEY = 'cio-probe'

/** Why an unknown platform cannot keep a credential. */
const NO_PLATFORM_STORE_REASON =
  'This operating system offers no credential store CodeInOven can use.'

/** One command's outcome, normalized so a backend never sees an exception. */
export interface SecretCommandResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Run one command with one stdin value and report how it went.
 *
 * Injectable on purpose: a test drives a backend with a recorder instead of a
 * real keychain, and the platform backends never care which one they got. The
 * stdin value is optional because a probe has nothing to hand the tool.
 */
export type SecretCommandRunner = (argv: string[], stdin?: string) => Promise<SecretCommandResult>

/** Whether a backend can read and write right now, and why it cannot when it cannot. */
export interface SecretBackendProbe {
  available: boolean
  reason?: string
}

/**
 * The at-rest store one machine offers.
 *
 * Keys are opaque names this app chose; a backend never interprets one. A read
 * that finds nothing answers `null` rather than throwing, because "this machine
 * holds no credential for that utility" is a normal state and not a failure.
 */
export interface SecretBackend {
  /** Which kind of store this is, as the contract spells it. */
  readonly id: OvenUtilitySecretBackend
  probe(): Promise<SecretBackendProbe>
  read(key: string): Promise<string | null>
  write(key: string, value: string): Promise<void>
  remove(key: string): Promise<void>
}

export interface SecretBackendOptions {
  /** Directory a file-backed backend keeps its ciphertext in. */
  directory: string
  /** Where commands run. Defaults to this process; tests inject a recorder. */
  runner?: SecretCommandRunner
  /** Platform facts. Default to this process; tests inject them. */
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}

/**
 * Pick the backend this machine can offer.
 *
 * The choice is by platform alone. Whether that backend actually works is what
 * `probe()` answers, because a locked keychain and a Linux desktop session
 * without a bus are not compile-time facts.
 */
export function createOvenUtilitySecretBackend(options: SecretBackendOptions): SecretBackend {
  const run = options.runner ?? runSecretCommand
  switch (options.platform ?? process.platform) {
    case 'darwin':
      return new MacosKeychainSecretBackend(options.directory, run)
    case 'linux':
      return new LinuxSecretBackend(
        new LinuxSecretServiceBackend(run, options.env ?? process.env),
        new LinuxEncryptedFileBackend(options.directory)
      )
    case 'win32':
      return new WindowsDpapiSecretBackend(options.directory, run)
    default:
      return new UnavailableSecretBackend(NO_PLATFORM_STORE_REASON)
  }
}

/** Refuse a key this module cannot file safely, before a process is started. */
function assertKey(key: string): void {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH || key.includes('\0'))
    throw new Error('An Oven credential key must be a bounded name with no NUL in it.')
}

/** Refuse a value above the store's budget, before a process is started. */
function assertValue(value: string): void {
  if (Buffer.byteLength(value, 'utf8') > OVEN_UTILITY_SECRET_MAX_VALUE_BYTES)
    throw new Error(
      `One stored credential may carry at most ${OVEN_UTILITY_SECRET_MAX_VALUE_BYTES} bytes.`
    )
}

/** One command line, trimmed of the trailing newline every tool writes. */
function trimTrailingNewlines(value: string): string {
  return value.replace(/[\r\n]+$/u, '')
}

/** A bounded excerpt of a command's own words, for an error a human reads. */
function commandDetail(result: SecretCommandResult): string {
  const detail = result.stderr.trim()
  return detail.length > 0 ? `: ${detail.slice(0, MAX_ERROR_DETAIL)}` : ''
}

/** The exit code of a failed `execFile`, whether it exited or never started. */
function failedExitCode(error: Error): number {
  const code = (error as { code?: unknown }).code
  if (typeof code === 'number') return code
  if (code === 'ENOENT') return 127
  if ((error as { killed?: unknown }).killed) return COMMAND_TIMED_OUT
  return 1
}

/**
 * Run one command through the platform's own executable.
 *
 * `maxBuffer` bounds what a store can make this process hold, and the timeout
 * bounds a keychain that decided to wait for a human: an unattended Oven launch
 * must never block on a prompt nobody is there to answer.
 */
const runSecretCommand: SecretCommandRunner = (argv, stdin = '') =>
  new Promise<SecretCommandResult>((resolve) => {
    const [program, ...args] = argv
    if (!program) {
      resolve({ code: 127, stdout: '', stderr: 'No command to run.' })
      return
    }
    const child = execFile(
      program,
      args,
      {
        encoding: 'utf8',
        timeout: COMMAND_TIMEOUT_MS,
        maxBuffer: MAX_ERROR_DETAIL * 1024,
        windowsHide: true
      },
      (error, stdout, stderr) => {
        resolve({
          code: error ? failedExitCode(error) : 0,
          stdout: stdout ?? '',
          stderr: stderr ?? ''
        })
      }
    )
    // A tool like `which` can exit before stdin is written. The exit code is the
    // answer, and an unhandled EPIPE here would take the whole utility host down.
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(stdin)
  })

/** Where a file-backed backend keeps one key: named by hash, so any id is a safe name. */
function secretFilePath(directory: string, key: string): string {
  return join(directory, `${createHash('sha256').update(key).digest('hex')}`)
}

/** Write one ciphertext 0600. */
async function writeSecretFile(path: string, data: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  await writeFile(path, data, { mode: 0o600 })
  // `writeFile` applies its mode only when it creates the file, so a file left
  // behind by an earlier version keeps whatever permissions it already had.
  await chmod(path, 0o600)
}

/** Encrypt one value with a 32-byte key: IV, then tag, then ciphertext. */
function sealValue(secret: Buffer, value: string): Buffer {
  const iv = randomBytes(FILE_IV_BYTES)
  const cipher = createCipheriv(FILE_CIPHER, secret, iv, { authTagLength: FILE_TAG_BYTES })
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body])
}

/** Decrypt what `sealValue` wrote. A tampered file fails its tag check and throws. */
function openSealed(secret: Buffer, sealed: Buffer): string {
  const body = FILE_IV_BYTES + FILE_TAG_BYTES
  const decipher = createDecipheriv(FILE_CIPHER, secret, sealed.subarray(0, FILE_IV_BYTES), {
    authTagLength: FILE_TAG_BYTES
  })
  decipher.setAuthTag(sealed.subarray(FILE_IV_BYTES, body))
  return Buffer.concat([decipher.update(sealed.subarray(body)), decipher.final()]).toString('utf8')
}

/** Read a file, answering null when it does not exist. */
async function readOptional(path: string): Promise<Buffer | null> {
  return await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null
    throw error
  })
}

/**
 * The login keychain, through the tool macOS ships for exactly this.
 *
 * `security` has no stdin form of `-w` (`-w -` stores a dash), and its
 * interactive mode cuts a line at 4 KiB, below what a bundle may carry. So the
 * keychain holds one random key, handed over in interactive mode, and each
 * value is a file encrypted with it.
 */
class MacosKeychainSecretBackend implements SecretBackend {
  readonly id: OvenUtilitySecretBackend = 'macos-keychain'

  constructor(
    private readonly directory: string,
    private readonly run: SecretCommandRunner
  ) {}

  /**
   * Whether the keychain can be used right now.
   *
   * `show-keychain-info` fails on a locked keychain, as it is over SSH, where
   * `list-keychains` succeeds and promises a store that cannot be written.
   */
  async probe(): Promise<SecretBackendProbe> {
    const result = await this.run(['/usr/bin/security', 'show-keychain-info'])
    return result.code === 0
      ? { available: true }
      : {
          available: false,
          reason:
            'The macOS login keychain is locked or not reachable for this account, so no credential can be kept at rest.'
        }
  }

  async read(key: string): Promise<string | null> {
    assertKey(key)
    const sealed = await readOptional(this.pathFor(key))
    if (!sealed) return null
    const secret = await this.storeKey()
    if (!secret) return null
    return openSealed(secret, sealed)
  }

  async write(key: string, value: string): Promise<void> {
    assertKey(key)
    assertValue(value)
    const secret = (await this.storeKey()) ?? (await this.createStoreKey())
    await writeSecretFile(this.pathFor(key), sealValue(secret, value))
  }

  async remove(key: string): Promise<void> {
    assertKey(key)
    await rm(this.pathFor(key), { force: true })
    // Earlier releases filed an item under the key itself.
    const result = await this.run([
      '/usr/bin/security',
      'delete-generic-password',
      '-s',
      OVEN_UTILITY_SECRET_SERVICE,
      '-a',
      key
    ])
    // Deleting what is already gone is the state the caller asked for.
    if (result.code !== 0 && result.code !== KEYCHAIN_ITEM_NOT_FOUND)
      throw new Error(
        `The macOS keychain could not remove \`${key}\` (security exit ${result.code}).`
      )
  }

  /** The key the files are encrypted with, or null before the first write. */
  private async storeKey(): Promise<Buffer | null> {
    const result = await this.run([
      '/usr/bin/security',
      'find-generic-password',
      '-s',
      OVEN_UTILITY_SECRET_SERVICE,
      '-a',
      KEYCHAIN_KEY_ACCOUNT,
      '-w'
    ])
    if (result.code === KEYCHAIN_ITEM_NOT_FOUND) return null
    if (result.code !== 0)
      throw new Error(
        `The macOS keychain could not be read (security exit ${result.code}${commandDetail(result)}).`
      )
    return Buffer.from(trimTrailingNewlines(result.stdout), 'hex')
  }

  /** Create that key. It travels in a command on stdin, so it is never in argv. */
  private async createStoreKey(): Promise<Buffer> {
    const secret = randomBytes(32)
    const result = await this.run(
      ['/usr/bin/security', '-i'],
      `add-generic-password -s ${OVEN_UTILITY_SECRET_SERVICE} -a ${KEYCHAIN_KEY_ACCOUNT} -w ${secret.toString('hex')}\n`
    )
    // Read back before anything depends on it. stderr is not quoted, because
    // interactive mode can echo the line it was given, and the line holds the key.
    const saved = result.code === 0 ? await this.storeKey() : null
    if (!saved?.equals(secret))
      throw new Error(
        `The macOS keychain could not save its encryption key (security exit ${result.code}).`
      )
    return secret
  }

  private pathFor(key: string): string {
    return `${secretFilePath(this.directory, key)}.keychain`
  }
}

/** `secret-tool` exits 1 both for a miss and for a failure, and only a failure says why. */
function isSecretToolMiss(result: SecretCommandResult): boolean {
  return result.code === 1 && result.stderr.trim().length === 0
}

/**
 * The desktop's Secret Service, through `secret-tool`.
 *
 * Availability needs both halves: the tool, and a session bus to talk over. A
 * machine can have the binary installed and still be an SSH session with no
 * bus, which is exactly the case that must report itself unavailable instead of
 * spawning a tool that hangs waiting for a daemon.
 */
class LinuxSecretServiceBackend implements SecretBackend {
  readonly id: OvenUtilitySecretBackend = 'linux-secret-service'

  constructor(
    private readonly run: SecretCommandRunner,
    private readonly env: NodeJS.ProcessEnv
  ) {}

  async probe(): Promise<SecretBackendProbe> {
    if (!this.env['DBUS_SESSION_BUS_ADDRESS'])
      return { available: false, reason: OVEN_UTILITY_LINUX_NO_SESSION_BUS_REASON }
    const resolved = await this.run(['which', 'secret-tool'])
    if (resolved.code !== 0)
      return { available: false, reason: OVEN_UTILITY_LINUX_NO_SECRET_TOOL_REASON }
    // The tool and a bus can both exist on a headless machine with no service
    // behind them. Only a lookup tells, and a clean miss exits 1 without a word.
    const lookup = await this.run([
      'secret-tool',
      'lookup',
      'service',
      OVEN_UTILITY_SECRET_SERVICE,
      'key',
      PROBE_KEY
    ])
    if (lookup.code === 0 || isSecretToolMiss(lookup)) return { available: true }
    return {
      available: false,
      reason: `${OVEN_UTILITY_LINUX_NO_SERVICE_REASON}${commandDetail(lookup)}`
    }
  }

  async read(key: string): Promise<string | null> {
    assertKey(key)
    const result = await this.run([
      'secret-tool',
      'lookup',
      'service',
      OVEN_UTILITY_SECRET_SERVICE,
      'key',
      key
    ])
    if (result.code === 0) return trimTrailingNewlines(result.stdout)
    if (isSecretToolMiss(result)) return null
    throw new Error(
      `The secret service could not read \`${key}\` (secret-tool exit ${result.code}${commandDetail(result)}).`
    )
  }

  async write(key: string, value: string): Promise<void> {
    assertKey(key)
    assertValue(value)
    const result = await this.run(
      [
        'secret-tool',
        'store',
        '--label=CodeInOven',
        'service',
        OVEN_UTILITY_SECRET_SERVICE,
        'key',
        key
      ],
      value
    )
    if (result.code !== 0)
      throw new Error(
        `The secret service could not write \`${key}\` (secret-tool exit ${result.code}).`
      )
  }

  async remove(key: string): Promise<void> {
    assertKey(key)
    const result = await this.run([
      'secret-tool',
      'clear',
      'service',
      OVEN_UTILITY_SECRET_SERVICE,
      'key',
      key
    ])
    // `clear` exits non-zero when there is nothing to clear, which is the state
    // the caller asked for. With a message, the same code is a real failure.
    if (result.code !== 0 && !isSecretToolMiss(result))
      throw new Error(
        `The secret service could not remove \`${key}\` (secret-tool exit ${result.code}).`
      )
  }
}

/** The file holding the key a Linux machine without a secret service encrypts with. */
const LINUX_STORE_KEY_FILE = 'store-key'

/**
 * Encrypted files, for a Linux machine with no secret service to hand a key to.
 *
 * A headless server rarely runs one: GNOME Keyring needs a password at login
 * that nobody is there to type, the kernel keyring forgets everything on reboot,
 * and per-user `systemd-creds` arrives only in systemd 256. So the key lives in
 * a 0600 file in a 0700 directory, readable by this account and root only, and
 * every value is AES-256-GCM sealed with it, as DPAPI does it on Windows. It is
 * weaker than a store that needs a password to open, and that is the trade an
 * unattended machine has to make to keep anything across a reboot.
 */
class LinuxEncryptedFileBackend implements SecretBackend {
  readonly id: OvenUtilitySecretBackend = 'linux-encrypted-file'

  constructor(private readonly directory: string) {}

  async probe(): Promise<SecretBackendProbe> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      await chmod(this.directory, 0o700)
      return { available: true }
    } catch (error) {
      return {
        available: false,
        reason: `The credential folder on this machine cannot be written (${(error as NodeJS.ErrnoException).code ?? 'unknown error'}).`
      }
    }
  }

  async read(key: string): Promise<string | null> {
    assertKey(key)
    const sealed = await readOptional(this.pathFor(key))
    if (!sealed) return null
    const secret = await readOptional(this.keyPath())
    if (!secret) return null
    return openSealed(secret, sealed)
  }

  async write(key: string, value: string): Promise<void> {
    assertKey(key)
    assertValue(value)
    await writeSecretFile(this.pathFor(key), sealValue(await this.storeKey(), value))
  }

  async remove(key: string): Promise<void> {
    assertKey(key)
    await rm(this.pathFor(key), { force: true })
  }

  /** The key, created on first use. `wx` keeps two writers from each making one. */
  private async storeKey(): Promise<Buffer> {
    const existing = await readOptional(this.keyPath())
    if (existing?.length === 32) return existing
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      await writeFile(this.keyPath(), randomBytes(32), { mode: 0o600, flag: 'wx' })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const saved = await readOptional(this.keyPath())
    if (saved?.length !== 32) throw new Error('The credential key on this machine is damaged.')
    return saved
  }

  private keyPath(): string {
    return join(this.directory, LINUX_STORE_KEY_FILE)
  }

  private pathFor(key: string): string {
    return `${secretFilePath(this.directory, key)}.sealed`
  }
}

/**
 * Linux: the secret service when one answers, encrypted files otherwise.
 *
 * The choice is made by the probe and then held, so one machine never splits
 * its credentials across two stores within one daemon's life.
 */
class LinuxSecretBackend implements SecretBackend {
  private active: SecretBackend

  constructor(
    private readonly service: SecretBackend,
    private readonly files: SecretBackend
  ) {
    this.active = files
  }

  get id(): OvenUtilitySecretBackend {
    return this.active.id
  }

  async probe(): Promise<SecretBackendProbe> {
    const service = await this.service.probe()
    this.active = service.available ? this.service : this.files
    return service.available ? service : await this.files.probe()
  }

  read(key: string): Promise<string | null> {
    return this.active.read(key)
  }

  write(key: string, value: string): Promise<void> {
    return this.active.write(key, value)
  }

  remove(key: string): Promise<void> {
    return this.active.remove(key)
  }
}

/** The PowerShell scripts DPAPI needs, kept brief because they are argv. */
const POWERSHELL = 'powershell.exe'
const POWERSHELL_FLAGS = ['-NoProfile', '-NonInteractive', '-Command']
const DPAPI_ENCRYPT_SCRIPT =
  '$v=[Console]::In.ReadToEnd(); ConvertFrom-SecureString (ConvertTo-SecureString -String $v -AsPlainText -Force) | Write-Output'
const DPAPI_DECRYPT_SCRIPT =
  '$c=[Console]::In.ReadToEnd(); $s=ConvertTo-SecureString $c; [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)) | Write-Output'

/**
 * DPAPI, through PowerShell, with one ciphertext file per key.
 *
 * Windows has no command-line equivalent of `security`/`secret-tool`, so the
 * ciphertext is kept beside the host's other 0600 files and the encryption key
 * never leaves DPAPI. The file name is a hash of the key so a utility id can be
 * any text the app allows without becoming a path.
 */
class WindowsDpapiSecretBackend implements SecretBackend {
  readonly id: OvenUtilitySecretBackend = 'windows-dpapi'

  constructor(
    private readonly directory: string,
    private readonly run: SecretCommandRunner
  ) {}

  async probe(): Promise<SecretBackendProbe> {
    const result = await this.run([POWERSHELL, ...POWERSHELL_FLAGS, '[Console]::Out.Write("ok")'])
    return result.code === 0
      ? { available: true }
      : {
          available: false,
          reason:
            'Windows PowerShell is not reachable, so DPAPI cannot encrypt a credential for this account.'
        }
  }

  async read(key: string): Promise<string | null> {
    assertKey(key)
    const ciphertext = await readFile(this.pathFor(key), 'utf8').catch(() => null)
    if (ciphertext === null) return null
    const result = await this.run(
      [POWERSHELL, ...POWERSHELL_FLAGS, DPAPI_DECRYPT_SCRIPT],
      ciphertext
    )
    if (result.code !== 0)
      throw new Error(`Windows DPAPI could not read \`${key}\` (PowerShell exit ${result.code}).`)
    return trimTrailingNewlines(result.stdout)
  }

  async write(key: string, value: string): Promise<void> {
    assertKey(key)
    assertValue(value)
    const result = await this.run([POWERSHELL, ...POWERSHELL_FLAGS, DPAPI_ENCRYPT_SCRIPT], value)
    if (result.code !== 0)
      throw new Error(
        `Windows DPAPI could not encrypt \`${key}\` (PowerShell exit ${result.code}).`
      )
    const ciphertext = result.stdout.trim()
    if (ciphertext.length === 0) throw new Error(`Windows DPAPI answered nothing for \`${key}\`.`)
    await writeSecretFile(this.pathFor(key), ciphertext)
  }

  async remove(key: string): Promise<void> {
    assertKey(key)
    await rm(this.pathFor(key), { force: true })
  }

  /** One ciphertext file per key, named by the key's hash rather than its text. */
  private pathFor(key: string): string {
    return `${secretFilePath(this.directory, key)}.dpapi`
  }
}

/** A machine whose platform offers no store this app can honestly use. */
class UnavailableSecretBackend implements SecretBackend {
  readonly id: OvenUtilitySecretBackend = 'unavailable'

  constructor(private readonly reason: string) {}

  async probe(): Promise<SecretBackendProbe> {
    return { available: false, reason: this.reason }
  }

  async read(_key: string): Promise<string | null> {
    throw new Error(this.reason)
  }

  async write(_key: string, _value: string): Promise<void> {
    throw new Error(this.reason)
  }

  async remove(_key: string): Promise<void> {
    // Nothing was ever written, so there is nothing to withdraw.
  }
}
