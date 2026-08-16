import { serve, type Server, type ServerWebSocket } from 'bun'
import { isIP } from 'node:net'
import { EnrollmentClaimConflictError, RemoteControlDatabase } from './database'
import { createEnrollmentCode, normalizeLabel, randomToken, tokenHash } from './security'
import { RelayHub } from './relay-hub'
import {
  convexSiteUrl,
  remoteAuthOrigin,
  remoteBrowserOrigin,
  remoteDatabasePath,
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
const MAX_JSON_BYTES = 16 * 1_024
const MAX_RELAY_BYTES = 1024 * 1_024
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 120
const SESSION_PERSIST_INTERVAL_MS = 5 * 60_000
const CONVEX_SESSION_TTL_MS = 24 * 60 * 60_000
const CONVEX_REQUEST_TIMEOUT_MS = 10_000

const port = positiveInteger(process.env['PORT'], 8877)
const allowedOrigins = new Set([remoteBrowserOrigin, remotePublicOrigin, remoteAuthOrigin])

const database = new RemoteControlDatabase(remoteDatabasePath)
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

interface AccountIdentity {
  id: string
  email: string
  displayName: string
  image: string | null
}

function parseAccountIdentity(value: unknown): AccountIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const profile = (value as Record<string, unknown>)['profile']
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) return null
  const record = profile as Record<string, unknown>
  if (
    typeof record['id'] !== 'string' ||
    typeof record['email'] !== 'string' ||
    typeof record['displayName'] !== 'string' ||
    (record['image'] !== null && typeof record['image'] !== 'string')
  ) {
    return null
  }
  return {
    id: record['id'],
    email: record['email'],
    displayName: record['displayName'],
    image: record['image']
  }
}

async function accountIdentityFromRequest(request: Request): Promise<AccountIdentity | null> {
  const authorization = request.headers.get('authorization')
  const cookie = request.headers.get('cookie')
  if (!authorization && !cookie) return null
  const headers = new Headers({ Origin: remotePublicOrigin })
  if (authorization) headers.set('Authorization', authorization)
  if (cookie) headers.set('Cookie', cookie)
  try {
    const response = await fetch(new URL('/v1/profile', convexSiteUrl), {
      headers,
      signal: AbortSignal.timeout(CONVEX_REQUEST_TIMEOUT_MS)
    })
    if (!response.ok) return null
    return parseAccountIdentity(await response.json())
  } catch {
    return null
  }
}

async function sessionFromRequest(request: Request): Promise<AuthenticatedSession | null> {
  const account = await accountIdentityFromRequest(request)
  if (!account) return null
  const credential =
    request.headers.get('authorization') ?? request.headers.get('cookie') ?? account.id
  const now = Date.now()
  const session: AuthenticatedSession = {
    id: `convex:${tokenHash(credential)}`,
    userId: account.id,
    expiresAt: now + CONVEX_SESSION_TTL_MS
  }
  const identitySnapshot = JSON.stringify([
    account.id,
    account.email,
    account.displayName,
    account.image
  ])
  const persisted = persistedSessions.get(session.id)
  if (
    !persisted ||
    persisted.identity !== identitySnapshot ||
    now - persisted.persistedAt >= SESSION_PERSIST_INTERVAL_MS
  ) {
    database.upsertOAuthUser({
      id: account.id,
      email: account.email,
      displayName: account.displayName,
      image: account.image
    })
    database.rememberOAuthSession(session)
    if (persistedSessions.size >= 10_000) persistedSessions.clear()
    persistedSessions.set(session.id, { identity: identitySnapshot, persistedAt: now })
  }
  return session
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
  const desktopTokenHeader = request.headers.get('x-codeinoven-desktop-token')?.trim() ?? ''
  const desktopToken = desktopTokenHeader.length <= 256 ? desktopTokenHeader : ''
  const headerDesktop = desktopToken
    ? database.findDesktopByTokenHash(tokenHash(desktopToken))
    : null
  const legacyDesktop = presentedHash ? database.findDesktopByTokenHash(presentedHash) : null
  const existing = headerDesktop ?? legacyDesktop
  const accountIdentity = presentedToken ? await accountIdentityFromRequest(request) : null
  const accountUserId = accountIdentity?.id ?? null
  if ((!existing && !accountUserId) || (desktopToken && !accountUserId)) {
    return json({ error: 'unauthorized' }, 401)
  }
  if (existing?.user_id && accountUserId && existing.user_id !== accountUserId) {
    return json({ error: 'enrollment-conflict' }, 403)
  }
  if (accountIdentity) {
    database.upsertOAuthUser({
      id: accountIdentity.id,
      email: accountIdentity.email,
      displayName: accountIdentity.displayName,
      image: accountIdentity.image
    })
  }
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
  if (
    url.pathname === '/v1/relay' &&
    request.headers.get('upgrade')?.toLowerCase() === 'websocket'
  ) {
    return websocketUpgrade(request, url)
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
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)
process.stdout.write(
  `CodeInOven remote control service listening on ${server.hostname}:${server.port}\n`
)
