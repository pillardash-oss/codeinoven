import type {
  AccountUser,
  Assistant,
  AuthResult,
  Device,
  Message,
  Oven,
  Page,
  Project,
  Prompt,
  Session,
  Thread,
  ThreadStatus
} from './types'

/**
 * The one place the app talks to the hosted service. No component and no store
 * builds a URL of its own, because this boundary is what a later transport or
 * encryption change has to be able to overwrite in one file.
 */

/** A failure the service described, with its own code and HTTP status. */
export class ApiError extends Error {
  readonly code: string
  readonly status: number
  readonly details: Record<string, unknown> | null

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details ?? null
  }

  /** A session that expired, was revoked, or never existed. */
  get isUnauthorized(): boolean {
    return this.status === 401
  }
}

/**
 * In the browser and the dev server `/api` is proxied to the Go service. A
 * native build has no proxy, so `VITE_API_BASE` points at a reachable origin.
 */
const API_BASE = (import.meta.env.VITE_API_BASE ?? '/api').replace(/\/$/, '')

let bearerToken: string | null = null

/** The token every request carries. Set by the session store, never by a screen. */
export function setApiToken(token: string | null): void {
  bearerToken = token
}

export function getApiBase(): string {
  return API_BASE
}

interface ResponseEnvelope<T> {
  data: T
  nextCursor?: string | null
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/**
 * No screen may wait on the service forever. A phone on a bad network is the
 * normal case, not an exception: a request that never answers would hold the
 * shell on its loading state and read as a frozen app, so every call has a
 * deadline and reports its own timeout as a network failure.
 */
const REQUEST_TIMEOUT_MS = 12_000

interface Deadline {
  signal: AbortSignal
  expired: () => boolean
  done: () => void
}

function deadlineFor(outer: AbortSignal | undefined): Deadline {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, REQUEST_TIMEOUT_MS)
  const forward = (): void => controller.abort()
  outer?.addEventListener('abort', forward, { once: true })
  return {
    signal: controller.signal,
    expired: () => expired,
    done: () => {
      clearTimeout(timer)
      outer?.removeEventListener('abort', forward)
    }
  }
}

async function request<T>(
  path: string,
  options: RequestOptions = {}
): Promise<ResponseEnvelope<T>> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`

  const deadline = deadlineFor(options.signal)
  let response: Response
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      credentials: 'omit',
      signal: deadline.signal
    })
  } catch (cause) {
    // A network failure is not an HTTP answer: name it so a screen can offer a
    // retry instead of showing an empty list as though the account had none.
    const timedOut = deadline.expired()
    throw new ApiError(
      timedOut ? 'timeout' : 'network',
      timedOut ? 'The oven did not answer in time.' : 'Cannot reach CodeInOven right now.',
      0,
      { cause: cause instanceof Error ? cause.message : String(cause) }
    )
  } finally {
    deadline.done()
  }

  if (response.status === 204) return { data: undefined as T }

  const payload = (await response.json().catch(() => null)) as ResponseEnvelope<T> | null

  if (!response.ok) {
    const error = payload?.error
    throw new ApiError(
      error?.code ?? 'internal',
      error?.message ?? 'The service could not complete that request.',
      response.status,
      error?.details
    )
  }

  return payload ?? { data: undefined as T }
}

async function data<T>(path: string, options?: RequestOptions): Promise<T> {
  return (await request<T>(path, options)).data
}

async function page<T>(path: string, options?: RequestOptions): Promise<Page<T>> {
  const envelope = await request<T[]>(path, options)
  return { items: envelope.data ?? [], nextCursor: envelope.nextCursor ?? null }
}

function query(params: object): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text ? `?${text}` : ''
}

export interface Credentials {
  email: string
  password: string
  name?: string
  device?: { name: string; platform: 'ios' | 'android' | 'desktop' }
}

export interface ThreadQuery {
  project?: string
  state?: ThreadStatus
  unread?: boolean
  q?: string
  limit?: number
  cursor?: string | null
}

export interface ProjectQuery {
  sort?: 'activity' | 'name' | 'created'
  q?: string
  limit?: number
  cursor?: string | null
}

export const api = {
  health: () => data<{ status: string }>('/health'),

  signUp: (input: Credentials) =>
    data<AuthResult>('/v1/auth/email/sign-up', { method: 'POST', body: input }),

  signIn: (input: Credentials) =>
    data<AuthResult>('/v1/auth/email/sign-in', { method: 'POST', body: input }),

  signOut: () => data<void>('/v1/auth/sign-out', { method: 'POST' }),

  /** Which provider sign-ins this server can actually complete. */
  providers: () => data<Record<string, boolean>>('/v1/auth/providers'),

  /** Trade the one-time code from the browser round trip for a session. */
  exchangeOAuth: (input: { code: string }) =>
    data<AuthResult>('/v1/auth/oauth/exchange', { method: 'POST', body: input }),

  me: () => data<AccountUser>('/v1/me'),

  updateMe: (input: { name: string }) =>
    data<AccountUser>('/v1/me', { method: 'PATCH', body: input }),

  devices: () => data<Device[]>('/v1/me/devices'),

  revokeDevice: (id: string) => data<void>(`/v1/me/devices/${id}`, { method: 'DELETE' }),

  sessions: () => data<Session[]>('/v1/auth/sessions'),

  revokeSession: (id: string) => data<void>(`/v1/auth/sessions/${id}`, { method: 'DELETE' }),

  /** Every machine this account has reported in from, most recent first. */
  ovens: () => data<Oven[]>('/v1/ovens'),

  assistants: () => data<Assistant[]>('/v1/assistants'),

  projects: (input: ProjectQuery = {}, signal?: AbortSignal) =>
    page<Project>(`/v1/projects${query(input)}`, { signal }),

  project: (id: string) => data<Project>(`/v1/projects/${id}`),

  threads: (input: ThreadQuery = {}, signal?: AbortSignal) =>
    page<Thread>(`/v1/threads${query(input)}`, { signal }),

  thread: (id: string) => data<Thread>(`/v1/threads/${id}`),

  createThread: (input: { projectId: string; title: string }) =>
    data<Thread>('/v1/threads', { method: 'POST', body: input }),

  messages: (threadId: string, input: { limit?: number; cursor?: string | null } = {}) =>
    page<Message>(`/v1/threads/${threadId}/messages${query(input)}`),

  sendPrompt: (threadId: string, input: { body: string; clientId: string }) =>
    data<Prompt>(`/v1/threads/${threadId}/prompts`, { method: 'POST', body: input }),

  /** Where the prompt the phone sent has got to: queued, claimed, done, failed. */
  prompt: (id: string) => data<Prompt>(`/v1/prompts/${id}`),

  /** Take back a message that is still waiting its turn. */
  deletePrompt: (id: string) => data<void>(`/v1/prompts/${id}`, { method: 'DELETE' }),

  /** Stop waiting: the oven takes this message before the rest of the queue. */
  steerPrompt: (id: string) => data<Prompt>(`/v1/prompts/${id}/steer`, { method: 'POST' })
}
