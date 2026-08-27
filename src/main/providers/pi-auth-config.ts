import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const PI_AGENT_DIR = join(homedir(), '.pi', 'agent')
const PI_AUTH_PATH = join(PI_AGENT_DIR, 'auth.json')

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

/**
 * Headless access to Pi's own credential store. Writes are atomic replace-file
 * (never in-place truncation), so a pi process reading auth.json concurrently
 * sees either the old or the new document — matching the durability semantics
 * pi itself relies on for the same file.
 */
export class PiAuthConfigService {
  private readonly authPath: string

  constructor(authPath = PI_AUTH_PATH) {
    this.authPath = authPath
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

  /** Store an API key for a provider, replacing any previous credential. */
  async setApiKey(providerId: string, apiKey: string): Promise<void> {
    assertProviderId(providerId)
    const data = await this.readAll()
    data[providerId] = { type: 'api_key', key: apiKey }
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
      const raw = await readFile(this.authPath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return parsed as PiAuthData
    } catch {
      return {}
    }
  }

  private async writeAll(data: PiAuthData): Promise<void> {
    await mkdir(dirname(this.authPath), { recursive: true })
    const content = `${JSON.stringify(data, null, 2)}\n`
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
