import { createHash } from 'node:crypto'
import { hostname, platform, release, userInfo } from 'node:os'
import { app } from 'electron'
import type {
  CodeInOvenAccountStatus,
  CodeInOvenSignInInput
} from '../../lib/ipc/codeinoven-account'
import { Logger } from '../system/logger'
import type { SecretsService } from '../secrets/secrets-service'
import type { StorageEngine } from '../storage/storage-engine'

/**
 * The desktop's CodeInOven service account.
 *
 * Signing in gives this machine a session on the hosted service, and while
 * that session lives the machine reports in as an Oven once a minute, which is
 * what the phone lists and what queued prompts are addressed to. The session
 * token sits in the secrets vault; only the address of the service, the
 * account summary and the vault reference are written in the clear.
 *
 * Nothing runs until there is an account: a desktop that never signs in reads
 * one small file at start and arms no timer.
 */

const STATE_FILE = 'codeinoven-account.json'
const HEARTBEAT_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_API_BASE = process.env['CIO_SERVICE_API_BASE'] ?? 'http://127.0.0.1:8080'

interface StoredAccount {
  apiBase: string
  tokenRef: string | null
  user: CodeInOvenAccountStatus['user']
  deviceId: string | null
}

interface ServiceUser {
  id: string
  email: string
  name: string | null
  emailVerifiedAt: number | null
}

interface AuthPayload {
  user: ServiceUser
  token: string
  device: { id: string }
}

class ServiceError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message)
  }
}

export class CodeInOvenAccountService {
  private state: StoredAccount = {
    apiBase: DEFAULT_API_BASE,
    tokenRef: null,
    user: null,
    deviceId: null
  }
  private token: string | null = null
  private lastHeartbeatAt: number | null = null
  private error: string | null = null
  private timer: NodeJS.Timeout | null = null
  private loaded: Promise<void> | null = null

  constructor(
    private readonly storage: StorageEngine,
    private readonly vault: SecretsService
  ) {}

  /** Read the stored account and, only if there is one, start reporting in. */
  start(): Promise<void> {
    this.loaded ??= this.load()
    return this.loaded
  }

  async status(): Promise<CodeInOvenAccountStatus> {
    await this.start()
    return this.snapshot()
  }

  async signIn(input: CodeInOvenSignInInput): Promise<CodeInOvenAccountStatus> {
    await this.start()
    const apiBase = normaliseBase(input.apiBase)
    const device = { name: hostname() || 'Desktop', platform: 'desktop' }
    const path = input.name === undefined ? '/v1/auth/email/sign-in' : '/v1/auth/email/sign-up'
    const body =
      input.name === undefined
        ? { email: input.email, password: input.password, device }
        : { email: input.email, password: input.password, name: input.name, device }

    const result = await this.request<AuthPayload>(apiBase, path, { method: 'POST', body })
    // A previous session on another service is signed out locally first, so
    // two accounts never share the one vault entry.
    await this.dropSession()
    this.token = result.token
    this.state = {
      apiBase,
      tokenRef: await this.vault.save(result.token, undefined, {
        scope: 'codeinoven-account',
        ownerId: result.user.id,
        label: `CodeInOven account ${result.user.email}`
      }),
      user: summary(result.user),
      deviceId: result.device.id
    }
    this.error = null
    await this.persist()
    this.arm()
    return this.snapshot()
  }

  async signOut(): Promise<CodeInOvenAccountStatus> {
    await this.start()
    if (this.token) {
      // The service ending the session is a courtesy: this machine forgets the
      // token whether or not the service can be reached.
      await this.request(this.state.apiBase, '/v1/auth/sign-out', { method: 'POST' }).catch(
        (cause: unknown) => Logger.dev('CodeInOven sign-out did not reach the service', cause)
      )
    }
    await this.dropSession()
    this.error = null
    await this.persist()
    return this.snapshot()
  }

  dispose(): void {
    this.disarm()
  }

  private async load(): Promise<void> {
    const stored = await this.storage.read<StoredAccount>(STATE_FILE).catch(() => null)
    if (!stored) return
    this.state = {
      apiBase: typeof stored.apiBase === 'string' ? stored.apiBase : DEFAULT_API_BASE,
      tokenRef: typeof stored.tokenRef === 'string' ? stored.tokenRef : null,
      user: stored.user ?? null,
      deviceId: typeof stored.deviceId === 'string' ? stored.deviceId : null
    }
    if (!this.state.tokenRef) return
    this.token = await this.vault.resolveOrNull(this.state.tokenRef)
    if (this.token) this.arm()
  }

  private arm(): void {
    this.disarm()
    void this.heartbeat()
    this.timer = setInterval(() => void this.heartbeat(), HEARTBEAT_MS)
    this.timer.unref()
  }

  private disarm(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async heartbeat(): Promise<void> {
    if (!this.token) return
    try {
      await this.request(this.state.apiBase, '/v1/ovens/heartbeat', {
        method: 'POST',
        body: {
          name: hostname() || 'Desktop',
          fingerprint: machineFingerprint(),
          descriptor: {
            platform: platform(),
            release: release(),
            appVersion: app.getVersion()
          }
        }
      })
      this.lastHeartbeatAt = Date.now()
      this.error = null
    } catch (cause) {
      if (cause instanceof ServiceError && cause.status === 401) {
        // The session was revoked from another device: this machine is signed out.
        await this.dropSession()
        await this.persist()
        this.error = 'This desktop was signed out from another device.'
        return
      }
      this.error = cause instanceof Error ? cause.message : 'Cannot reach the CodeInOven service.'
    }
  }

  private async dropSession(): Promise<void> {
    this.disarm()
    if (this.state.tokenRef) {
      await this.vault
        .remove(this.state.tokenRef)
        .catch((cause: unknown) => Logger.dev('Could not remove the account token', cause))
    }
    this.token = null
    this.lastHeartbeatAt = null
    this.state = { apiBase: this.state.apiBase, tokenRef: null, user: null, deviceId: null }
  }

  private async persist(): Promise<void> {
    await this.storage.write(STATE_FILE, this.state)
  }

  private snapshot(): CodeInOvenAccountStatus {
    return {
      apiBase: this.state.apiBase,
      signedIn: this.token !== null && this.state.user !== null,
      user: this.state.user,
      lastHeartbeatAt: this.lastHeartbeatAt,
      error: this.error
    }
  }

  private async request<T>(
    apiBase: string,
    path: string,
    options: { method: string; body?: unknown }
  ): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`
    let response: Response
    try {
      response = await fetch(`${apiBase}${path}`, {
        method: options.method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      })
    } catch {
      throw new ServiceError(`Cannot reach the CodeInOven service at ${apiBase}.`, 0)
    }
    if (response.status === 204) return undefined as T
    const payload = (await response.json().catch(() => null)) as {
      data?: T
      error?: { message?: string }
    } | null
    if (!response.ok) {
      throw new ServiceError(
        payload?.error?.message ?? `The service answered ${response.status}.`,
        response.status
      )
    }
    return payload?.data as T
  }
}

function summary(user: ServiceUser): CodeInOvenAccountStatus['user'] {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerifiedAt !== null
  }
}

function normaliseBase(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  const url = new URL(trimmed)
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('The service address must start with http:// or https://.')
  }
  return trimmed
}

/** One stable id per machine and OS user, so a reinstall reports as the same Oven. */
function machineFingerprint(): string {
  let user: string
  try {
    user = userInfo().username
  } catch {
    user = ''
  }
  return createHash('sha256').update(`${hostname()}|${platform()}|${user}`).digest('hex')
}
