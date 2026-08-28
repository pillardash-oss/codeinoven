import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { readHarnessHomeFile, writeHarnessHomeFile } from '../drivers/harness-runtime'

const PI_AGENT_DIR = join(homedir(), '.pi', 'agent')
const PI_AUTH_PATH = join(PI_AGENT_DIR, 'auth.json')

/**
 * Transport that honors WSL-resident pi installs: read/write the auth file
 * inside the distro when pi runs there (matching `readPiStatus`'s view), and
 * fall back to a plain atomic write on the native filesystem otherwise.
 */
export const piAuthFileIo: PiAuthFileIo = {
  async read(): Promise<string | null> {
    const wslRaw = await readHarnessHomeFile('pi', '.pi/agent/auth.json').catch(() => undefined)
    if (wslRaw !== undefined) return wslRaw
    try {
      return await readFile(PI_AUTH_PATH, 'utf8')
    } catch {
      return null
    }
  },
  async write(content: string): Promise<void> {
    if (await writeHarnessHomeFile('pi', '.pi/agent/auth.json', content)) return
    await mkdir(dirname(PI_AUTH_PATH), { recursive: true })
    const temporaryPath = `${PI_AUTH_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, PI_AUTH_PATH)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

/**
 * One stored credential in Pi's auth store (`~/.pi/agent/auth.json`),
 * keyed by provider id — the exact shape `@earendil-works/pi-ai`'s
 * CredentialStore persists and the TUI's OAuth flows write.
 */
interface PiCredential {
  type?: string
  key?: unknown
  refresh?: unknown
  access?: unknown
}

type PiAuthData = Record<string, PiCredential>

/** Pluggable file transport so callers can route through WSL-aware helpers. */
export interface PiAuthFileIo {
  /** Full file text, or null when the file does not exist. */
  read(): Promise<string | null>
  write(content: string): Promise<void>
}

/**
 * Headless access to Pi's own credential store. Writes are atomic replace-file
 * (never in-place truncation), so a pi process reading auth.json concurrently
 * sees either the old or the new document — matching the durability semantics
 * pi itself relies on for the same file.
 */
export class PiAuthConfigService {
  private readonly authPath: string
  private readonly io?: PiAuthFileIo

  constructor(authPath = PI_AUTH_PATH, io?: PiAuthFileIo) {
    this.authPath = authPath
    this.io = io
  }

  /** Provider ids holding any stored credential. */
  async credentialIds(): Promise<Set<string>> {
    return new Set(Object.keys(await this.readAll()))
  }

  /** Whether `providerId` holds a usable api-key or OAuth credential. */
  async hasCredential(providerId: string): Promise<boolean> {
    const entry = (await this.readAll())[providerId]
    if (!entry) return false
    if (entry.type === 'api_key') {
      return typeof entry.key === 'string' && entry.key.trim().length > 0
    }
    if (entry.type === 'oauth') {
      return typeof entry.access === 'string' && entry.access.length > 0
    }
    // Untyped entries follow the historical literal-key layout.
    return typeof entry.key === 'string' && entry.key.trim().length > 0
  }

  /** True when the provider's stored credential is an OAuth token set. */
  async isOauth(providerId: string): Promise<boolean> {
    return (await this.readAll())[providerId]?.type === 'oauth'
  }

  /** Store an API key for a provider, replacing any previous credential. */
  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    assertProviderId(providerId)
    const data = await this.readAll()
    data[providerId] = { type: 'api_key', key: apiKey }
    await this.writeAll(data)
  }

  /**
   * Store a full OAuth credential (refresh/access/expiry plus any extra token
   * fields) — the same shape Pi's own TUI sign-in persists.
   */
  async setOAuthCredential(providerId: string, credential: Record<string, unknown>): Promise<void> {
    assertProviderId(providerId)
    const data = await this.readAll()
    data[providerId] = { ...credential, type: 'oauth' }
    await this.writeAll(data)
  }

  /** Remove a provider's stored credential entirely (logout). */
  async removeCredential(providerId: string): Promise<void> {
    assertProviderId(providerId)
    const data = await this.readAll()
    if (!(providerId in data)) return
    delete data[providerId]
    await this.writeAll(data)
  }

  private async readAll(): Promise<PiAuthData> {
    try {
      const raw = this.io ? await this.io.read() : await readFile(this.authPath, 'utf8')
      if (raw === null) return {}
      const parsed = JSON.parse(raw) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed as PiAuthData
    } catch {
      return {}
    }
  }

  private async writeAll(data: PiAuthData): Promise<void> {
    const content = `${JSON.stringify(data, null, 2)}\n`
    if (this.io) {
      await this.io.write(content)
      return
    }
    await mkdir(dirname(this.authPath), { recursive: true })
    const temporaryPath = `${this.authPath}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, this.authPath)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

function assertProviderId(value: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u.test(value)) {
    throw new TypeError('Pi provider id contains unsupported characters')
  }
}
