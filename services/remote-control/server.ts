import { serve, type Server, type ServerWebSocket } from 'bun'
import { isIP } from 'node:net'
import {
  auth,
  authDatabasePath,
  closeAuthDatabase,
  migrateAuthSchema,
  remoteAuthSession
} from './auth'
import { RemoteControlDatabase } from './database'
import { createEnrollmentCode, normalizeLabel, randomToken, tokenHash } from './security'
import { RelayHub } from './relay-hub'
import type { AuthenticatedSession, EnrollmentRecord, RelaySocketData } from './types'

const ENROLLMENT_TTL_MS = 10 * 60 * 1_000
const MAX_JSON_BYTES = 16 * 1_024
const MAX_RELAY_BYTES = 1024 * 1_024
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 120
const trustProxy = process.env['REMOTE_TRUST_PROXY'] === 'true'

const port = positiveInteger(process.env['PORT'], 8877)
const allowedOrigins = new Set(
  (process.env['REMOTE_ALLOWED_ORIGINS'] ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
)

await migrateAuthSchema()
const database = new RemoteControlDatabase(authDatabasePath)
const relayHub = new RelayHub({
  bufferLimit: positiveInteger(process.env['RELAY_BUFFER_LIMIT'], 256),
  bufferTtlMs: positiveInteger(process.env['RELAY_BUFFER_TTL_MS'], 60_000)
})
const sessionSockets = new Map<string, Set<ServerWebSocket<RelaySocketData>>>()
const rateBuckets = new Map<string, { count: number; resetAt: number }>()

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
  if (trustProxy) {
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

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '0', 10)
  if (declared > MAX_JSON_BYTES) return null
  const text = await request.text()
  if (Buffer.byteLength(text) > MAX_JSON_BYTES) return null
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
  database.upsertOAuthUser({
    id: remoteSession.userId,
    email: remoteSession.email,
    displayName: remoteSession.displayName
  })
  database.rememberOAuthSession(session)
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
  const existing = presentedToken
    ? database.findDesktopByTokenHash(tokenHash(presentedToken))
    : null
  if (presentedToken && !existing) return json({ error: 'unauthorized' }, 401)
  const desktopId = existing?.id ?? crypto.randomUUID()
  const deviceToken = existing ? null : randomToken()
  const now = Date.now()
  if (existing) {
    database.deleteEnrollmentForDesktop(existing.id)
  } else if (deviceToken) {
    database.createDesktop({
      id: desktopId,
      user_id: null,
      name,
      platform,
      lan_endpoint: lanEndpoint,
      token_hash: tokenHash(deviceToken),
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
  database.audit('desktop.enrollment-created', existing?.user_id ?? null, desktopId)
  return json(
    {
      enrollmentId: enrollment.id,
      desktopId,
      deviceToken,
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
  const enrollment = database.enrollmentByCodeHash(tokenHash(rawCode))
  const desktop = enrollment ? database.findDesktop(enrollment.desktop_id) : null
  if (!enrollment || !desktop) return json({ error: 'invalid-enrollment-code' }, 400)
  const mobileRegistered = database.registerMobileDevice({
    id: mobileDeviceId,
    userId: session.userId,
    name: mobileName,
    publicKey: mobilePublicKey
  })
  if (
    !mobileRegistered ||
    (desktop.user_id !== null && desktop.user_id !== session.userId) ||
    (desktop.user_id === null && !database.claimDesktop(desktop.id, session.userId))
  ) {
    return json({ error: 'invalid-enrollment-code' }, 400)
  }
  database.bindEnrollmentToMobile(enrollment.id, mobileDeviceId, mobilePublicKey)
  database.audit('desktop.claimed', session.userId, enrollment.desktop_id)
  return json({ desktopId: enrollment.desktop_id })
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

  const session = await sessionFromRequest(request)
  if (!session) return json({ error: 'unauthorized' }, 401)
  if (url.pathname === '/v1/me' && request.method === 'GET') {
    const user = database.findUserById(session.userId)
    return user
      ? json({
          user: { id: user.id, email: user.email, displayName: user.display_name },
          entitlement: database.entitlementForUser(user.id)
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
    const replayed = relayHub.connectDesktop(desktop.id, socket)
    socket.data.authenticated = true
    socket.data.desktopId = desktop.id
    socket.data.userId = desktop.user_id
    database.touchDesktop(desktop.id)
    database.audit('relay.desktop-connected', desktop.user_id, desktop.id)
    socket.send(JSON.stringify({ type: 'relay:authenticated', desktopId: desktop.id }))
    for (const frame of replayed) socket.send(frame)
    relayHub
      .mobileSocket(desktop.id)
      ?.send(JSON.stringify({ type: 'relay:presence', online: true }))
    return
  }

  // Receiver-generated end-to-end confirmation: forward the ACK to the sender
  // and release the retained frame in the hub.
  if (record['type'] === 'relay:ack' && typeof record['id'] === 'number') {
    const ackDesktopId = socket.data.desktopId
    if (ackDesktopId) relayHub.acknowledge(ackDesktopId, record['id'])
    return
  }

  if (record['type'] !== 'relay:data' || typeof record['payload'] !== 'string') return
  const desktopId = socket.data.desktopId
  if (!desktopId) return
  if (socket.data.role === 'desktop') {
    const outcome = relayHub.forward(desktopId, 'desktop', socket, text)
    if (!outcome.accepted && typeof record['id'] === 'number') {
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
  if (!outcome.accepted && typeof record['id'] === 'number') {
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
        const replayed = relayHub.connectMobile(socket.data.desktopId, socket)
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
        for (const frame of replayed) socket.send(frame)
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
