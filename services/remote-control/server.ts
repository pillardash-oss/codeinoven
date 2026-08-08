import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { serve, type Server, type ServerWebSocket } from 'bun'
import { RemoteControlDatabase } from './database'
import {
  createEnrollmentCode,
  decryptSecret,
  encryptSecret,
  hashPassword,
  loadMasterKey,
  normalizeEmail,
  normalizeLabel,
  randomToken,
  tokenHash,
  validatePassword,
  verifyPassword
} from './security'
import type { AuthenticatedSession, RelaySocketData } from './types'

const SESSION_COOKIE = 'cio_remote_session'
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1_000
const ENROLLMENT_TTL_MS = 10 * 60 * 1_000
const MAX_JSON_BYTES = 16 * 1_024
const MAX_RELAY_BYTES = 1024 * 1_024
const RATE_WINDOW_MS = 60_000
const RATE_LIMIT = 120

const port = positiveInteger(process.env['PORT'], 8877)
const production = process.env['NODE_ENV'] === 'production'
const databasePath = resolve(process.env['REMOTE_DATABASE_PATH'] ?? 'data/remote-control.sqlite')
const masterKey = loadMasterKey(process.env['REMOTE_MASTER_KEY'])
const allowedOrigins = new Set(
  (process.env['REMOTE_ALLOWED_ORIGINS'] ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
)

mkdirSync(dirname(databasePath), { recursive: true })
const database = new RemoteControlDatabase(databasePath)

const desktopSockets = new Map<string, ServerWebSocket<RelaySocketData>>()
const mobileSockets = new Map<string, Set<ServerWebSocket<RelaySocketData>>>()
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
  return server.requestIP(request)?.address ?? 'unknown'
}

function withinRateLimit(request: Request, discriminator = ''): boolean {
  const key = `${requestKey(request)}:${discriminator}`
  const now = Date.now()
  const bucket = rateBuckets.get(key)
  if (!bucket || bucket.resetAt <= now) {
    rateBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS })
    return true
  }
  bucket.count += 1
  return bucket.count <= RATE_LIMIT
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

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get('cookie')
  if (!cookie) return null
  for (const item of cookie.split(';')) {
    const separator = item.indexOf('=')
    if (separator === -1) continue
    if (item.slice(0, separator).trim() === name) {
      return decodeURIComponent(item.slice(separator + 1).trim())
    }
  }
  return null
}

function sessionFromRequest(request: Request): AuthenticatedSession | null {
  const token = cookieValue(request, SESSION_COOKIE)
  if (!token) return null
  const session = database.sessionByTokenHash(tokenHash(token))
  if (session) database.touchSession(session.id)
  return session
}

function sessionCookie(token: string, maxAgeSeconds: number): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ]
  if (production) attributes.push('Secure')
  return attributes.join('; ')
}

function bearerToken(request: Request): string | null {
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  const token = authorization.slice(7).trim()
  return token.length > 0 ? token : null
}

function closeDesktopSocket(desktopId: string, code: number, reason: string): void {
  const socket = desktopSockets.get(desktopId)
  if (!socket) return
  desktopSockets.delete(desktopId)
  socket.close(code, reason)
}

async function handleRegister(request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const email = normalizeEmail(body?.['email'])
  const displayName = normalizeLabel(body?.['displayName'])
  const password = validatePassword(body?.['password'])
  if (!email || !displayName || !password) {
    return json({ error: 'invalid-registration' }, 400)
  }
  if (!withinRateLimit(request, `register:${email}`)) return json({ error: 'rate-limited' }, 429)
  if (database.findUserByEmail(email)) return json({ error: 'email-unavailable' }, 409)

  const userId = crypto.randomUUID()
  database.createUser({
    id: userId,
    email,
    display_name: displayName,
    password_hash: await hashPassword(password),
    created_at: Date.now()
  })
  database.audit('account.registered', userId, null)
  return createAuthenticatedResponse(userId, displayName, email, 201)
}

async function handleLogin(request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const email = normalizeEmail(body?.['email'])
  const password = validatePassword(body?.['password'])
  if (!email || !password) return json({ error: 'invalid-credentials' }, 401)
  if (!withinRateLimit(request, `login:${email}`)) return json({ error: 'rate-limited' }, 429)

  const user = database.findUserByEmail(email)
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    return json({ error: 'invalid-credentials' }, 401)
  }
  database.audit('account.login', user.id, null)
  return createAuthenticatedResponse(user.id, user.display_name, user.email)
}

function createAuthenticatedResponse(
  userId: string,
  displayName: string,
  email: string,
  status = 200
): Response {
  const token = randomToken()
  const session: AuthenticatedSession = {
    id: crypto.randomUUID(),
    userId,
    expiresAt: Date.now() + SESSION_TTL_MS
  }
  database.createSession(session, tokenHash(token))
  return json({ user: { id: userId, displayName, email } }, status, {
    'Set-Cookie': sessionCookie(token, Math.floor(SESSION_TTL_MS / 1_000))
  })
}

async function handleEnrollmentRequest(request: Request): Promise<Response> {
  const body = await readJsonObject(request)
  const name = normalizeLabel(body?.['name'])
  const platform = normalizeLabel(body?.['platform'], 50)
  const controlSecret = normalizeLabel(body?.['controlSecret'], 512)
  if (!name || !platform || !controlSecret || controlSecret.length < 32) {
    return json({ error: 'invalid-enrollment' }, 400)
  }
  if (!withinRateLimit(request, 'enrollment')) return json({ error: 'rate-limited' }, 429)

  const desktopId = crypto.randomUUID()
  const deviceToken = randomToken()
  const code = createEnrollmentCode()
  const enrollmentId = crypto.randomUUID()
  const now = Date.now()
  database.createDesktop({
    id: desktopId,
    user_id: null,
    name,
    platform,
    token_hash: tokenHash(deviceToken),
    control_secret_cipher: encryptSecret(masterKey, controlSecret),
    created_at: now,
    last_seen_at: null,
    revoked_at: null
  })
  database.createEnrollment(
    {
      id: enrollmentId,
      desktop_id: desktopId,
      code_hash: tokenHash(code.replaceAll('-', '')),
      expires_at: now + ENROLLMENT_TTL_MS,
      claimed_at: null
    },
    now
  )
  database.audit('desktop.enrollment-created', null, desktopId)
  return json(
    {
      enrollmentId,
      desktopId,
      deviceToken,
      code,
      expiresAt: now + ENROLLMENT_TTL_MS
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
  if (rawCode.length !== 16) return json({ error: 'invalid-enrollment-code' }, 400)
  if (!withinRateLimit(request, `claim:${session.userId}`))
    return json({ error: 'rate-limited' }, 429)

  const enrollment = database.enrollmentByCodeHash(tokenHash(rawCode))
  if (!enrollment || !database.claimDesktop(enrollment.desktop_id, session.userId)) {
    return json({ error: 'invalid-enrollment-code' }, 400)
  }
  database.markEnrollmentClaimed(enrollment.id)
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
    claimed: desktop.user_id !== null,
    expiresAt: enrollment?.expires_at ?? null,
    revoked: desktop.revoked_at !== null
  })
}

function listDesktops(session: AuthenticatedSession): Response {
  const desktops = database.listDesktops(session.userId).map((desktop) => ({
    id: desktop.id,
    name: desktop.name,
    platform: desktop.platform,
    online: desktopSockets.has(desktop.id),
    lastSeenAt: desktop.last_seen_at,
    createdAt: desktop.created_at
  }))
  return json({ desktops })
}

function desktopConnection(session: AuthenticatedSession, desktopId: string): Response {
  const desktop = database.findDesktop(desktopId)
  if (!desktop || desktop.user_id !== session.userId || desktop.revoked_at !== null) {
    return json({ error: 'not-found' }, 404)
  }
  return json({
    desktop: {
      id: desktop.id,
      name: desktop.name,
      platform: desktop.platform,
      online: desktopSockets.has(desktop.id)
    },
    controlSecret: decryptSecret(masterKey, desktop.control_secret_cipher),
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
    closeDesktopSocket(desktopId, 4003, 'revoked')
    for (const socket of mobileSockets.get(desktopId) ?? []) socket.close(4003, 'revoked')
    mobileSockets.delete(desktopId)
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

function websocketUpgrade(request: Request, url: URL): Response | undefined {
  const role = url.searchParams.get('role')
  if (role === 'mobile') {
    const desktopId = url.searchParams.get('desktopId')
    const session = sessionFromRequest(request)
    const desktop = desktopId ? database.findDesktop(desktopId) : null
    if (!session || !desktop || desktop.user_id !== session.userId || desktop.revoked_at !== null) {
      return json({ error: 'unauthorized' }, 401)
    }
    const upgraded = server.upgrade(request, {
      data: {
        authenticated: true,
        role: 'mobile',
        desktopId,
        userId: session.userId,
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
  if (url.pathname === '/v1/auth/register' && request.method === 'POST')
    return handleRegister(request)
  if (url.pathname === '/v1/auth/login' && request.method === 'POST') return handleLogin(request)
  if (url.pathname === '/v1/auth/logout' && request.method === 'POST') {
    const token = cookieValue(request, SESSION_COOKIE)
    if (token) database.deleteSession(tokenHash(token))
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie('', 0) })
  }
  if (url.pathname === '/v1/device-enrollments' && request.method === 'POST') {
    return handleEnrollmentRequest(request)
  }

  const enrollmentStatus = url.pathname.match(/^\/v1\/device-enrollments\/([^/]+)\/status$/)
  if (enrollmentStatus && request.method === 'GET') {
    return handleEnrollmentStatus(request, enrollmentStatus[1] ?? '')
  }

  const session = sessionFromRequest(request)
  if (!session) return json({ error: 'unauthorized' }, 401)
  if (url.pathname === '/v1/me' && request.method === 'GET') {
    const user = database.findUserById(session.userId)
    return user
      ? json({ user: { id: user.id, email: user.email, displayName: user.display_name } })
      : json({ error: 'unauthorized' }, 401)
  }
  if (url.pathname === '/v1/device-enrollments/claim' && request.method === 'POST') {
    return handleEnrollmentClaim(request, session)
  }
  if (url.pathname === '/v1/desktops' && request.method === 'GET') return listDesktops(session)

  const connection = url.pathname.match(/^\/v1\/desktops\/([^/]+)\/connection$/)
  if (connection && request.method === 'GET') {
    return desktopConnection(session, connection[1] ?? '')
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
    const previous = desktopSockets.get(desktop.id)
    if (previous && previous !== socket) previous.close(4000, 'replaced')
    socket.data.authenticated = true
    socket.data.desktopId = desktop.id
    socket.data.userId = desktop.user_id
    desktopSockets.set(desktop.id, socket)
    database.touchDesktop(desktop.id)
    database.audit('relay.desktop-connected', desktop.user_id, desktop.id)
    socket.send(JSON.stringify({ type: 'relay:authenticated', desktopId: desktop.id }))
    for (const mobile of mobileSockets.get(desktop.id) ?? []) {
      mobile.send(JSON.stringify({ type: 'relay:presence', online: true }))
    }
    return
  }

  if (record['type'] !== 'relay:data' || typeof record['payload'] !== 'string') return
  const desktopId = socket.data.desktopId
  if (!desktopId) return
  if (socket.data.role === 'desktop') {
    for (const mobile of mobileSockets.get(desktopId) ?? []) mobile.send(text)
  } else {
    desktopSockets.get(desktopId)?.send(text)
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
      if (socket.data.role === 'mobile' && socket.data.desktopId) {
        let sockets = mobileSockets.get(socket.data.desktopId)
        if (!sockets) {
          sockets = new Set()
          mobileSockets.set(socket.data.desktopId, sockets)
        }
        sockets.add(socket)
        socket.send(
          JSON.stringify({
            type: 'relay:authenticated',
            desktopId: socket.data.desktopId,
            online: desktopSockets.has(socket.data.desktopId)
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
      if (socket.data.role === 'desktop' && desktopSockets.get(desktopId) === socket) {
        desktopSockets.delete(desktopId)
        for (const mobile of mobileSockets.get(desktopId) ?? []) {
          mobile.send(JSON.stringify({ type: 'relay:presence', online: false }))
        }
        database.audit('relay.desktop-disconnected', socket.data.userId, desktopId)
        return
      }
      const sockets = mobileSockets.get(desktopId)
      sockets?.delete(socket)
      if (sockets?.size === 0) mobileSockets.delete(desktopId)
    }
  }
})

const cleanupTimer = setInterval(() => {
  database.deleteExpiredSessions()
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
