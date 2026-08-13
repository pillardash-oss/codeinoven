import { serve, type Server, type ServerWebSocket } from 'bun'
import { isIP } from 'node:net'
import { auth, authDatabasePath, closeAuthDatabase, remoteAuthSession } from './auth'
import { EnrollmentClaimConflictError, RemoteControlDatabase } from './database'
import { createEnrollmentCode, normalizeLabel, randomToken, tokenHash } from './security'
import { RelayHub } from './relay-hub'
import {
  remoteAuthOrigin,
  remoteBrowserOrigin,
  remotePublicOrigin,
  trustRemoteProxy
} from './runtime-config'
import type {
  AuthenticatedSession,
  DesktopRecord,
  EnrollmentRecord,
  RelaySocketData
} from './types'

const ENROLLMENT_TTL_MS = 10 * 60 * 1_000
const DESKTOP_AUTHORIZATION_TTL_MS = 2 * 60 * 1_000
const ACCOUNT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1_000
const MAX_JSON_BYTES = 16 * 1_024
const MAX_RELAY_BYTES = 1024 * 1_024
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 120
const MAX_MEMORY_CLOCK_SKEW_MS = 5 * 60_000
const SESSION_PERSIST_INTERVAL_MS = 5 * 60_000

const port = positiveInteger(process.env['PORT'], 8877)
const allowedOrigins = new Set([remoteBrowserOrigin, remotePublicOrigin, remoteAuthOrigin])

const database = new RemoteControlDatabase(authDatabasePath)
const relayHub = new RelayHub({
  bufferLimit: positiveInteger(process.env['RELAY_BUFFER_LIMIT'], 256),
  bufferTtlMs: positiveInteger(process.env['RELAY_BUFFER_TTL_MS'], 60_000)
})
const sessionSockets = new Map<string, Set<ServerWebSocket<RelaySocketData>>>()
const rateBuckets = new Map<string, { count: number; resetAt: number }>()
const persistedSessions = new Map<string, { identity: string; persistedAt: number }>()

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function json(data: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      ...headers
    }
  })
}

function requestOriginAllowed(request: Request): boolean {
  const origin = request.headers.get('origin')
  return !origin || allowedOrigins.has(origin)
}

function requestKey(request: Request): string {
  if (trustRemoteProxy) {
    const forwarded = request.headers.get('x-client-ip')?.trim()
    if (forwarded && isIP(forwarded) !== 0) return forwarded
  }
  return server.requestIP(request)?.address ?? 'unknown'
}

function withinRateLimit(request: Request, discriminator = '', maximum = RATE_LIMIT): boolean {
  const key = `${requestKey(request)}:${discriminator}`
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  bucket.count += 1
  return bucket.count <= maximum
}

async function readJsonObject(
  request: Request,
  maxBytes = MAX_JSON_BYTES
): Promise<Record<string, unknown> | null> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  if (declared > maxBytes) return null
  const text = await request.text()
  if (Buffer.byteLength(text) > maxBytes) return null
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

async function sessionFromRequest(request: Request): Promise<AuthenticatedSession | null> {
  const remoteSession = await remoteAuthSession(request)
  if (!remoteSession) return null
  const session: AuthenticatedSession = {
    id: remoteSession.id,
    userId: remoteSession.userId,
    expiresAt: remoteSession.expiresAt
  }
  const now = Date.now()
  const identity = JSON.stringify([
    remoteSession.userId,
    remoteSession.email,
    remoteSession.displayName,
    remoteSession.image,
    remoteSession.expiresAt
  ])
  const persisted = persistedSessions.get(session.id)
  if (
    !persisted ||
    persisted.identity !== identity ||
    now - persisted.persistedAt >= SESSION_PERSIST_INTERVAL_MS
  ) {
    database.upsertOAuthUser({
      id: remoteSession.userId,
      email: remoteSession.email,
      displayName: remoteSession.displayName,
      image: remoteSession.image
    })
    database.rememberOAuthSession(session)
    if (persistedSessions.size >= 10_000) persistedSessions.clear()
    persistedSessions.set(session.id, { identity, persistedAt: now })
  }
  return session
}

function profileIdentityFromRequest(
  request: Request
): { userId: string; desktop: DesktopRecord | null } | null {
  const token = bearerToken(request)
  if (!token) return null
  const hash = tokenHash(token)
  const accountUserId = database.findUserIdByAccountTokenHash(hash)
  if (accountUserId) return { userId: accountUserId, desktop: null }
  const desktop = database.findDesktopByProfileTokenHash(hash)
  return desktop?.user_id ? { userId: desktop.user_id, desktop } : null
}

function validDesktopCallback(value: string | null): string | null {
  if (!value || value.length > 500) return null
  try {
    const url = new URL(value)
    const port = Number.parseInt(url.port, 10)
    if (
      url.protocol !== 'http:' ||
      url.hostname !== '127.0.0.1' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      url.pathname !== '/account/callback' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

function validBase64Url(value: string | null, minimum: number, maximum: number): value is string {
  return Boolean(
    value && value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_-]+$/u.test(value)
  )
}

function publicRequestOrigin(url: URL): string | null {
  if (url.host === new URL(remoteAuthOrigin).host) return remoteAuthOrigin
  if (url.host === new URL(remotePublicOrigin).host) return remotePublicOrigin
  return null
}

function redirect(location: string, source?: Response): Response {
  const headers = new Headers({
    Location: location,
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  })
  for (const cookie of source?.headers.getSetCookie() ?? []) headers.append('Set-Cookie', cookie)
  return new Response(null, { status: 302, headers })
}

async function beginDesktopSignIn(request: Request, url: URL): Promise<Response> {
  const publicOrigin = publicRequestOrigin(url)
  const provider = url.searchParams.get('provider')
  const redirectUri = validDesktopCallback(url.searchParams.get('redirect_uri'))
  const state = url.searchParams.get('state')
  const codeChallenge = url.searchParams.get('code_challenge')
  if (
    !publicOrigin ||
    (provider !== 'google' && provider !== 'apple') ||
    !redirectUri ||
    !validBase64Url(state, 32, 128) ||
    !validBase64Url(codeChallenge, 43, 43) ||
    url.searchParams.get('code_challenge_method') !== 'S256'
  ) {
    return json({ error: 'invalid-desktop-sign-in' }, 400)
  }
  if (!withinRateLimit(request, 'desktop-sign-in', 20)) {
    return json({ error: 'rate-limited' }, 429)
  }

  const authorizeUrl = new URL('/desktop/authorize', publicOrigin)
  authorizeUrl.search = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge
  }).toString()
  const errorUrl = new URL(authorizeUrl)
  errorUrl.searchParams.set('oauth_error', provider)

  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('Origin', publicOrigin)
  headers.delete('Content-Length')
  const authRequest = new Request(new URL('/api/auth/sign-in/social', publicOrigin), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      provider,
      callbackURL: authorizeUrl.toString(),
      errorCallbackURL: errorUrl.toString()
    })
  })
  const response = await auth.handler(authRequest)
  if (!response.ok) return response
  const payload = (await response.json()) as Record<string, unknown>
  const providerUrl = payload['url']
  if (typeof providerUrl !== 'string') return json({ error: 'oauth-start-failed' }, 502)
  return redirect(providerUrl, response)
}

async function authorizeDesktop(request: Request, url: URL): Promise<Response> {
  const redirectUri = validDesktopCallback(url.searchParams.get('redirect_uri'))
  const state = url.searchParams.get('state')
  const codeChallenge = url.searchParams.get('code_challenge')
  if (!redirectUri || !validBase64Url(state, 32, 128) || !validBase64Url(codeChallenge, 43, 43)) {
    return json({ error: 'invalid-desktop-authorization' }, 400)
  }
  const callback = new URL(redirectUri)
  callback.searchParams.set('state', state)
  if (url.searchParams.has('oauth_error')) {
    callback.searchParams.set('error', 'oauth-failed')
    return redirect(callback.toString())
  }
  const session = await sessionFromRequest(request)
  if (!session) {
    callback.searchParams.set('error', 'unauthorized')
    return redirect(callback.toString())
  }
  const code = randomToken(32)
  database.createDesktopAuthorizationCode({
    codeHash: tokenHash(code),
    userId: session.userId,
    codeChallenge,
    redirectUri,
    expiresAt: Date.now() + DESKTOP_AUTHORIZATION_TTL_MS
  })
  callback.searchParams.set('code', code)
  return redirect(callback.toString())
}

async function exchangeDesktopAuthorizationCode(request: Request): Promise<Response> {
  if (!withinRateLimit(request, 'desktop-auth-exchange', 30)) {
    return json({ error: 'rate-limited' }, 429)
  }
  const body = await readJsonObject(request)
  const code = typeof body?.['code'] === 'string' ? body['code'] : null
  const codeVerifier = typeof body?.['codeVerifier'] === 'string' ? body['codeVerifier'] : null
  const redirectUri = validDesktopCallback(
    typeof body?.['redirectUri'] === 'string' ? body['redirectUri'] : null
  )
  if (!validBase64Url(code, 32, 128) || !validBase64Url(codeVerifier, 43, 128) || !redirectUri) {
    return json({ error: 'invalid-authorization-code' }, 400)
  }
  const authorization = database.consumeDesktopAuthorizationCode({
    codeHash: tokenHash(code),
    codeChallenge: tokenHash(codeVerifier),
    redirectUri
  })
  if (!authorization) return json({ error: 'invalid-authorization-code' }, 400)

  const profileToken = randomToken(48)
  database.createAccountToken({
    tokenHash: tokenHash(profileToken),
    userId: authorization.user_id,
    expiresAt: Date.now() + ACCOUNT_TOKEN_TTL_MS
  })
  return json({ profileToken, expiresAt: Date.now() + ACCOUNT_TOKEN_TTL_MS })
}

function emptyUsageSummary(): Record<string, unknown> {
  return {
    messageCount: 0,
    costUsd: 0,
    tokens: 0,
    durationMs: 0,
    topHarnessId: null,
    topModelId: null,
    harnesses: [],
    models: [],
    activityDays: [],
    generatedAt: Date.now()
  }
}

function parseStoredJson(value: string, fallback: unknown): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return fallback
  }
}

function nonnegativeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

function validUsageSummary(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const usage = value as Record<string, unknown>
  const validRows = (rows: unknown): boolean =>
    Array.isArray(rows) &&
    rows.length <= 100 &&
    rows.every(
      (row) =>
        typeof row === 'object' &&
        row !== null &&
        !Array.isArray(row) &&
        typeof (row as Record<string, unknown>)['id'] === 'string' &&
        nonnegativeNumber((row as Record<string, unknown>)['messageCount']) &&
        nonnegativeNumber((row as Record<string, unknown>)['costUsd']) &&
        nonnegativeNumber((row as Record<string, unknown>)['tokens'])
    )
  return (
    nonnegativeNumber(usage['messageCount']) &&
    nonnegativeNumber(usage['costUsd']) &&
    nonnegativeNumber(usage['tokens']) &&
    nonnegativeNumber(usage['durationMs']) &&
    nonnegativeNumber(usage['generatedAt']) &&
    validRows(usage['harnesses']) &&
    validRows(usage['models']) &&
    Array.isArray(usage['activityDays']) &&
    usage['activityDays'].length <= 3_660
  )
}

interface ValidGlobalMemory extends Record<string, unknown> {
  id: string
  updatedAt: number
}

function validGlobalMemory(value: unknown, now = Date.now()): value is ValidGlobalMemory {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry['id'] === 'string' &&
    typeof entry['label'] === 'string' &&
    typeof entry['content'] === 'string' &&
    typeof entry['enabled'] === 'boolean' &&
    nonnegativeNumber(entry['updatedAt']) &&
    entry['updatedAt'] <= now + MAX_MEMORY_CLOCK_SKEW_MS &&
    typeof entry['category'] === 'string' &&
    typeof entry['priority'] === 'string' &&
    entry['scope'] === 'global' &&
    typeof entry['source'] === 'string' &&
    nonnegativeNumber(entry['frequency']) &&
    nonnegativeNumber(entry['lastReinforced'])
  )
}

function mergeGlobalMemories(storedJson: string | null, incoming: unknown[]): unknown[] {
  const now = Date.now()
  const stored = storedJson ? parseStoredJson(storedJson, []) : []
  const merged = new Map<string, Record<string, unknown>>()
  for (const item of [...(Array.isArray(stored) ? stored : []), ...incoming]) {
    if (!validGlobalMemory(item, now)) continue
    const entry = item
    const previous = merged.get(entry['id'])
    if (!previous || Number(previous['updatedAt'] ?? 0) <= entry['updatedAt']) {
      merged.set(entry['id'], entry)
    }
  }
  return [...merged.values()].sort(
    (left, right) => Number(right['updatedAt'] ?? 0) - Number(left['updatedAt'] ?? 0)
  )
}

function accountProfile(userId: string): Response {
  const user = database.findUserById(userId)
  if (!user) return json({ error: 'unauthorized' }, 401)
  const stored = database.accountProfile(userId)
  return json({
    profile: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      image: user.image_url,
      usage: stored ? parseStoredJson(stored.usage_json, emptyUsageSummary()) : emptyUsageSummary(),
      globalMemories: stored ? mergeGlobalMemories(stored.global_memories_json, []) : [],
      updatedAt: stored?.updated_at ?? user.created_at
    }
  })
}

async function saveAccountProfile(request: Request, userId: string): Promise<Response> {
  const body = await readJsonObject(request, 512 * 1_024)
  const usage = body?.['usage']
  const memories = body?.['globalMemories']
  const now = Date.now()
  if (
    !validUsageSummary(usage) ||
    !Array.isArray(memories) ||
    !memories.every((memory) => validGlobalMemory(memory, now))
  ) {
    return json({ error: 'invalid-profile' }, 400)
  }
  const usageJson = JSON.stringify(usage)
  const existing = database.accountProfile(userId)
  const memoriesJson = JSON.stringify(
    mergeGlobalMemories(existing?.global_memories_json ?? null, memories)
  )
  if (usageJson.length > 128 * 1_024 || memoriesJson.length > 384 * 1_024) {
    return json({ error: 'profile-too-large' }, 413)
  }
  database.saveAccountProfile(userId, usageJson, memoriesJson)
  return accountProfile(userId)
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  return authorization.slice(7).trim() || null
}

function normalizeLanEndpoint(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  if (typeof value !== 'string' || value.length > 500) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' || url.username || url.password) return null
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 100
}

function normalizedPublicKey(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const key = value as Record<string, unknown>
  if (
    key['kty'] !== 'EC' ||
    key['crv'] !== 'P-256' ||
    typeof key['x'] !== 'string' ||
    typeof key['y'] !== 'string'
  ) {
    return null
  }
  const serialized = JSON.stringify({ kty: 'EC', crv: 'P-256', x: key['x'], y: key['y'] })
  return serialized.length <= 1_000 ? serialized : null
}

function closeDesktop(desktopId: string, code: number, reason: string): void {
  relayHub.closePeer(desktopId, code, reason)
}

function closeSessionSockets(sessionId: string, code: number, reason: string): void {
  const sockets = sessionSockets.get(sessionId)
  sessionSockets.delete(sessionId)
  for (const socket of sockets ?? []) socket.close(code, reason)
}

async function handleEnrollmentRequest(request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const name = normalizeLabel(body?.['name'])
  const platform = normalizeLabel(body?.['platform'], 50)
  const lanEndpoint = normalizeLanEndpoint(body?.['lanEndpoint'])
  if (!name || !platform || (body?.['lanEndpoint'] && !lanEndpoint)) {
    return json({ error: 'invalid-enrollment' }, 400)
  }
  if (!withinRateLimit(request, 'enrollment', 10)) return json({ error: 'rate-limited' }, 429)

  const presentedToken = bearerToken(request)
  const presentedHash = presentedToken ? tokenHash(presentedToken) : null
  const existing = presentedHash ? database.findDesktopByTokenHash(presentedHash) : null
  const accountUserId = presentedHash ? database.findUserIdByAccountTokenHash(presentedHash) : null
  if (presentedToken && !existing && !accountUserId) return json({ error: 'unauthorized' }, 401)
  const desktopId = existing?.id ?? crypto.randomUUID()
  const deviceToken = existing ? null : randomToken()
  const profileToken = accountUserId && presentedToken ? presentedToken : randomToken()
  const now = Date.now()
  if (existing) {
    database.deleteEnrollmentForDesktop(existing.id)
    if (!database.rotateDesktopProfileToken(existing.id, tokenHash(profileToken))) {
      return json({ error: 'unauthorized' }, 401)
    }
  } else if (deviceToken) {
    database.createDesktop({
      id: desktopId,
      user_id: accountUserId,
      name,
      platform,
      lan_endpoint: lanEndpoint,
      token_hash: tokenHash(deviceToken),
      profile_token_hash: tokenHash(accountUserId ? randomToken() : profileToken),
      control_secret_cipher: '',
      created_at: now,
      last_seen_at: null,
      revoked_at: null
    })
  }

  const code = createEnrollmentCode()
  const enrollment: EnrollmentRecord = {
    id: crypto.randomUUID(),
    desktop_id: desktopId,
    code_hash: tokenHash(code.replaceAll('-', '')),
    expires_at: now + ENROLLMENT_TTL_MS,
    claimed_at: null,
    mobile_device_id: null,
    mobile_public_key: null,
    grant_ciphertext: null,
    desktop_public_key: null
  }
  database.createEnrollment(enrollment, now)
  database.audit('desktop.enrollment-created', existing?.user_id ?? accountUserId, desktopId)
  return json(
    {
      enrollmentId: enrollment.id,
      desktopId,
      deviceToken,
      profileToken,
      code,
      expiresAt: enrollment.expires_at
    },
    201
  )
}

async function handleEnrollmentClaim(
  request: Request,
  session: AuthenticatedSession
): Promise<Response> {
  const body = await readJsonObject(request)
  const rawCode =
    typeof body?.['code'] === 'string' ? body['code'].toUpperCase().replaceAll('-', '') : ''
  const mobileDeviceId = body?.['mobileDeviceId']
  const mobileName = normalizeLabel(body?.['mobileName'])
  const mobilePublicKey = normalizedPublicKey(body?.['mobilePublicKey'])
  if (rawCode.length !== 16 || !validId(mobileDeviceId) || !mobileName || !mobilePublicKey) {
    return json({ error: 'invalid-enrollment-code' }, 400)
  }
  if (!withinRateLimit(request, `claim:${session.userId}`, 20)) {
    return json({ error: 'rate-limited' }, 429)
  }
  let claimed: { desktopId: string } | null
  try {
    claimed = database.claimEnrollment({
      codeHash: tokenHash(rawCode),
      userId: session.userId,
      mobileDeviceId,
      mobileName,
      mobilePublicKey
    })
  } catch (error) {
    if (!(error instanceof EnrollmentClaimConflictError)) throw error
    database.audit('desktop.enrollment-conflict', session.userId, error.desktopId)
    return json({ error: 'enrollment-conflict' }, 409)
  }
  if (!claimed) return json({ error: 'invalid-enrollment-code' }, 400)
  database.audit('desktop.claimed', session.userId, claimed.desktopId)
  return json({ desktopId: claimed.desktopId })
}

function handleEnrollmentStatus(request: Request, desktopId: string): Response {
  const token = bearerToken(request)
  const desktop = token ? database.findDesktopByTokenHash(tokenHash(token)) : null
  if (!desktop || desktop.id !== desktopId) return json({ error: 'unauthorized' }, 401)
  const enrollment = database.enrollmentForDesktop(desktopId)
  return json({
    desktopId,
    claimed: enrollment?.claimed_at !== null && enrollment?.claimed_at !== undefined,
    expiresAt: enrollment?.expires_at ?? null,
    revoked: desktop.revoked_at !== null,
    mobileDeviceId: enrollment?.mobile_device_id ?? null,
    mobilePublicKey: enrollment?.mobile_public_key
      ? (JSON.parse(enrollment.mobile_public_key) as unknown)
      : null,
    grantReady: Boolean(enrollment?.grant_ciphertext && enrollment.desktop_public_key)
  })
}

async function handleGrantUpload(request: Request, desktopId: string): Promise<Response> {
  const token = bearerToken(request)
  const desktop = token ? database.findDesktopByTokenHash(tokenHash(token)) : null
  if (!desktop || desktop.id !== desktopId) return json({ error: 'unauthorized' }, 401)
  const body = await readJsonObject(request)
  const mobileDeviceId = body?.['mobileDeviceId']
  const desktopPublicKey = normalizedPublicKey(body?.['desktopPublicKey'])
  const ciphertext = body?.['ciphertext']
  if (
    !validId(mobileDeviceId) ||
    !desktopPublicKey ||
    typeof ciphertext !== 'string' ||
    ciphertext.length < 24 ||
    ciphertext.length > 2_000
  ) {
    return json({ error: 'invalid-control-grant' }, 400)
  }
  if (!database.saveDesktopGrant(desktopId, mobileDeviceId, desktopPublicKey, ciphertext)) {
    return json({ error: 'not-found' }, 404)
  }
  // A refreshed grant can carry a rotated transport key. Close both peers and
  // discard outstanding ciphertext before either side reconnects; replaying a
  // frame encrypted with the previous key creates an unrecoverable loop.
  closeDesktop(desktopId, 4004, 'control-key-rotated')
  database.audit('desktop.control-grant-created', desktop.user_id, desktopId)
  return json({ ok: true })
}

function listDesktops(session: AuthenticatedSession): Response {
  return json({
    desktops: database.listDesktops(session.userId).map((desktop) => ({
      id: desktop.id,
      name: desktop.name,
      platform: desktop.platform,
      online: relayHub.desktopOnline(desktop.id),
      lastSeenAt: desktop.last_seen_at,
      createdAt: desktop.created_at
    }))
  })
}

function desktopConnection(
  session: AuthenticatedSession,
  desktopId: string,
  mobileDeviceId: string | null
): Response {
  if (!mobileDeviceId) return json({ error: 'device-not-approved' }, 403)
  const desktop = database.findDesktop(desktopId)
  const grant = database.enrollmentGrant(desktopId, session.userId, mobileDeviceId)
  if (!desktop || desktop.revoked_at !== null) return json({ error: 'not-found' }, 404)
  if (!grant?.desktop_public_key || !grant.grant_ciphertext) {
    return json({ error: 'device-not-approved' }, 403)
  }
  return json({
    desktop: {
      id: desktop.id,
      name: desktop.name,
      platform: desktop.platform,
      online: relayHub.desktopOnline(desktop.id)
    },
    grant: {
      mobileDeviceId,
      desktopPublicKey: JSON.parse(grant.desktop_public_key) as unknown,
      ciphertext: grant.grant_ciphertext
    },
    lanEndpoint: desktop.lan_endpoint,
    relayPath: '/v1/relay'
  })
}

async function mutateDesktop(
  request: Request,
  session: AuthenticatedSession,
  desktopId: string
): Promise<Response> {
  if (request.method === 'DELETE') {
    if (!database.revokeDesktop(desktopId, session.userId)) return json({ error: 'not-found' }, 404)
    closeDesktop(desktopId, 4003, 'revoked')
    database.audit('desktop.revoked', session.userId, desktopId)
    return new Response(null, { status: 204 })
  }
  const body = await readJsonObject(request)
  const name = normalizeLabel(body?.['name'])
  if (!name) return json({ error: 'invalid-name' }, 400)
  if (!database.renameDesktop(desktopId, session.userId, name))
    return json({ error: 'not-found' }, 404)
  database.audit('desktop.renamed', session.userId, desktopId)
  return json({ desktopId, name })
}

function revokeFromDesktop(request: Request, desktopId: string): Response {
  const token = bearerToken(request)
  if (!token) return json({ error: 'not-found' }, 404)
  const desktop = database.findDesktopByTokenHash(tokenHash(token))
  if (!desktop || desktop.id !== desktopId) return json({ error: 'not-found' }, 404)
  database.revokeDesktopByTokenHash(tokenHash(token))
  closeDesktop(desktopId, 4003, 'revoked')
  database.audit('desktop.revoked-by-device', desktop.user_id, desktopId)
  return new Response(null, { status: 204 })
}

async function websocketUpgrade(request: Request, url: URL): Promise<Response | undefined> {
  const role = url.searchParams.get('role')
  if (role === 'mobile') {
    const desktopId = url.searchParams.get('desktopId')
    const mobileDeviceId = url.searchParams.get('mobileDeviceId')
    const session = await sessionFromRequest(request)
    const grant =
      session && desktopId && mobileDeviceId
        ? database.enrollmentGrant(desktopId, session.userId, mobileDeviceId)
        : null
    if (!session || !desktopId || !mobileDeviceId || !grant?.grant_ciphertext) {
      return json({ error: 'unauthorized' }, 401)
    }
    const upgraded = server.upgrade(request, {
      data: {
        authenticated: true,
        role: 'mobile',
        desktopId,
        userId: session.userId,
        sessionId: session.id,
        mobileDeviceId,
        connectedAt: Date.now()
      }
    })
    return upgraded ? undefined : json({ error: 'upgrade-failed' }, 400)
  }
  if (role === 'desktop') {
    const upgraded = server.upgrade(request, {
      data: {
        authenticated: false,
        role: 'desktop',
        desktopId: null,
        userId: null,
        sessionId: null,
        mobileDeviceId: null,
        connectedAt: Date.now()
      }
    })
    return upgraded ? undefined : json({ error: 'upgrade-failed' }, 400)
  }
  return json({ error: 'invalid-relay-role' }, 400)
}

async function routeHttp(request: Request): Promise<Response | undefined> {
  const url = new URL(request.url)
  if (!requestOriginAllowed(request)) return json({ error: 'origin-not-allowed' }, 403)
  if (!withinRateLimit(request)) return json({ error: 'rate-limited' }, 429)
  if (url.pathname === '/healthz' && request.method === 'GET') return json({ ok: true })
  if (url.pathname === '/desktop/sign-in' && request.method === 'GET') {
    return beginDesktopSignIn(request, url)
  }
  if (url.pathname === '/desktop/authorize' && request.method === 'GET') {
    return authorizeDesktop(request, url)
  }
  if (url.pathname === '/v1/desktop-auth/exchange' && request.method === 'POST') {
    return exchangeDesktopAuthorizationCode(request)
  }
  if (
    url.pathname === '/v1/relay' &&
    request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  ) {
    return websocketUpgrade(request, url)
  }
  if (url.pathname.startsWith('/api/auth/')) {
    const endingSession =
      url.pathname === '/api/auth/sign-out' ? await sessionFromRequest(request) : null
    const response = await auth.handler(request)
    if (endingSession && response.ok) {
      closeSessionSockets(endingSession.id, 4003, 'session-ended')
    }
    return response
  }
  if (url.pathname === '/v1/device-enrollments' && request.method === 'POST') {
    return handleEnrollmentRequest(request)
  }
  const enrollmentStatus = url.pathname.match(/^\/v1\/device-enrollments\/([^/]+)\/status$/)
  if (enrollmentStatus && request.method === 'GET') {
    return handleEnrollmentStatus(request, enrollmentStatus[1] ?? '')
  }
  const grantUpload = url.pathname.match(/^\/v1\/device-enrollments\/([^/]+)\/grant$/)
  if (grantUpload && request.method === 'PUT') {
    return handleGrantUpload(request, grantUpload[1] ?? '')
  }
  const deviceEnrollment = url.pathname.match(/^\/v1\/device-enrollments\/([^/]+)$/)
  if (deviceEnrollment && request.method === 'DELETE') {
    return revokeFromDesktop(request, deviceEnrollment[1] ?? '')
  }

  if (url.pathname === '/v1/profile') {
    const session = await sessionFromRequest(request)
    const profileIdentity = session ? null : profileIdentityFromRequest(request)
    const profileDesktop = profileIdentity?.desktop ?? null
    const userId = session?.userId ?? profileIdentity?.userId ?? null
    if (!userId) return json({ error: 'unauthorized' }, 401)
    if (request.method === 'GET') return accountProfile(userId)
    if (request.method === 'PUT') {
      if (profileDesktop && !withinRateLimit(request, `profile:${profileDesktop.id}`, 12)) {
        return json({ error: 'rate-limited' }, 429)
      }
      const response = await saveAccountProfile(request, userId)
      if (profileDesktop && response.ok) {
        database.audit('desktop.profile-synced', userId, profileDesktop.id)
      }
      return response
    }
    return json({ error: 'method-not-allowed' }, 405)
  }

  const session = await sessionFromRequest(request)
  if (!session) return json({ error: 'unauthorized' }, 401)
  if (url.pathname === '/v1/me' && request.method === 'GET') {
    const user = database.findUserById(session.userId)
    return user
      ? json({
          user: { id: user.id, email: user.email, displayName: user.display_name }
        })
      : json({ error: 'unauthorized' }, 401)
  }
  if (url.pathname === '/v1/device-enrollments/claim' && request.method === 'POST') {
    return handleEnrollmentClaim(request, session)
  }
  if (url.pathname === '/v1/desktops' && request.method === 'GET') return listDesktops(session)
  const connection = url.pathname.match(/^\/v1\/desktops\/([^/]+)\/connection$/)
  if (connection && request.method === 'GET') {
    return desktopConnection(session, connection[1] ?? '', url.searchParams.get('mobileDeviceId'))
  }
  const desktop = url.pathname.match(/^\/v1\/desktops\/([^/]+)$/)
  if (desktop && (request.method === 'PATCH' || request.method === 'DELETE')) {
    return mutateDesktop(request, session, desktop[1] ?? '')
  }
  return json({ error: 'not-found' }, 404)
}

function relayMessage(socket: ServerWebSocket<RelaySocketData>, message: string | Buffer): void {
  const text = typeof message === 'string' ? message : message.toString('utf8')
  if (Buffer.byteLength(text) > MAX_RELAY_BYTES) {
    socket.close(4009, 'message-too-large')
    return
  }
  let record: Record<string, unknown>
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return
    record = parsed as Record<string, unknown>
  } catch {
    return
  }

  if (!socket.data.authenticated) {
    const token = typeof record['token'] === 'string' ? record['token'] : ''
    if (record['type'] !== 'relay:authenticate' || !token) {
      socket.close(4001, 'authentication-required')
      return
    }
    const desktop = database.findDesktopByTokenHash(tokenHash(token))
    if (!desktop || !desktop.user_id) {
      socket.close(4001, 'authentication-failed')
      return
    }
    // The hub delivers any replayed buffered frames to the new socket itself;
    // the server must not re-send them (single delivery path).
    relayHub.connectDesktop(desktop.id, socket)
    socket.data.authenticated = true
    socket.data.desktopId = desktop.id
    socket.data.userId = desktop.user_id
    database.touchDesktop(desktop.id)
    database.audit('relay.desktop-connected', desktop.user_id, desktop.id)
    socket.send(JSON.stringify({ type: 'relay:authenticated', desktopId: desktop.id }))
    relayHub
      .mobileSocket(desktop.id)
      ?.send(JSON.stringify({ type: 'relay:presence', online: true }))
    return
  }

  // Receiver-generated end-to-end confirmation: authenticate the ACK against
  // the retained intended receiver role + current socket, forward it to the
  // sender, and release the retained frame in the hub.
  if (record['type'] === 'relay:ack' && typeof record['id'] === 'string') {
    const ackDesktopId = socket.data.desktopId
    if (ackDesktopId && socket.data.role) {
      relayHub.acknowledge(ackDesktopId, record['id'], socket.data.role, socket)
    }
    return
  }

  if (record['type'] !== 'relay:data' || typeof record['payload'] !== 'string') return
  const desktopId = socket.data.desktopId
  if (!desktopId) return
  if (socket.data.role === 'desktop') {
    const outcome = relayHub.forward(desktopId, 'desktop', socket, text)
    if (!outcome.accepted && typeof record['id'] === 'string') {
      socket.send(
        JSON.stringify({
          type: 'relay:nack',
          id: record['id'],
          reason: outcome.reason ?? 'rejected'
        })
      )
    }
    return
  }
  if (!socket.data.sessionId || !database.activeSessionById(socket.data.sessionId)) {
    socket.close(4003, 'session-ended')
    return
  }
  const outcome = relayHub.forward(desktopId, 'mobile', socket, text)
  if (!outcome.accepted && typeof record['id'] === 'string') {
    socket.send(
      JSON.stringify({
        type: 'relay:nack',
        id: record['id'],
        reason: outcome.reason ?? 'rejected'
      })
    )
  }
}

const server: Server<RelaySocketData> = serve<RelaySocketData>({
  hostname: process.env['HOST'] ?? '127.0.0.1',
  port,
  fetch: routeHttp,
  websocket: {
    idleTimeout: 90,
    maxPayloadLength: MAX_RELAY_BYTES,
    open(socket) {
      if (socket.data.role === 'mobile' && socket.data.desktopId && socket.data.sessionId) {
        // The hub delivers any replayed buffered frames itself (single path).
        relayHub.connectMobile(socket.data.desktopId, socket)
        const sockets = sessionSockets.get(socket.data.sessionId) ?? new Set()
        sockets.add(socket)
        sessionSockets.set(socket.data.sessionId, sockets)
        socket.send(
          JSON.stringify({
            type: 'relay:authenticated',
            desktopId: socket.data.desktopId,
            online: relayHub.desktopOnline(socket.data.desktopId)
          })
        )
      } else {
        socket.send(JSON.stringify({ type: 'relay:authentication-required' }))
      }
    },
    message: relayMessage,
    close(socket) {
      const desktopId = socket.data.desktopId
      if (!desktopId) return
      if (socket.data.role === 'desktop' && relayHub.desktopOnline(desktopId)) {
        relayHub.disconnect(desktopId, 'desktop', socket)
        relayHub
          .mobileSocket(desktopId)
          ?.send(JSON.stringify({ type: 'relay:presence', online: false }))
        database.audit('relay.desktop-disconnected', socket.data.userId, desktopId)
      } else if (socket.data.role === 'mobile' && relayHub.mobileOnline(desktopId)) {
        relayHub.disconnect(desktopId, 'mobile', socket)
      }
      const sessionId = socket.data.sessionId
      if (sessionId) {
        const sockets = sessionSockets.get(sessionId)
        sockets?.delete(socket)
        if (sockets?.size === 0) sessionSockets.delete(sessionId)
      }
    }
  }
})

const cleanupTimer = setInterval(() => {
  for (const sessionId of database.expiredSessionIds()) {
    closeSessionSockets(sessionId, 4003, 'session-expired')
  }
  database.deleteExpiredSessions()
  database.deleteExpiredEnrollments()
  database.pruneAudit(Date.now())
  relayHub.sweep()
  const now = Date.now()
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key)
  }
}, RATE_WINDOW_MS)

function shutdown(): void {
  clearInterval(cleanupTimer)
  server.stop(true)
  database.close()
  closeAuthDatabase()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
process.stdout.write(
  `CodeInOven remote control service listening on ${server.hostname}:${server.port}\n`
)
