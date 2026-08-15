import type { ActionCtx } from './_generated/server'
import { internal } from './_generated/api'
import { createAuth, socialProviderConfigured } from './auth'

const DESKTOP_AUTHORIZATION_TTL_MS = 2 * 60 * 1_000
const ACCOUNT_TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1_000
const MAX_PROFILE_BYTES = 512 * 1_024

const emptyUsage = (generatedAt: number): Record<string, unknown> => ({
  messageCount: 0,
  costUsd: 0,
  tokens: 0,
  durationMs: 0,
  topHarnessId: null,
  topModelId: null,
  harnesses: [],
  models: [],
  activityDays: [],
  generatedAt
})

const json = (value: unknown, status = 200): Response =>
  Response.json(value, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff'
    }
  })

const redirect = (location: string, source?: Response): Response => {
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

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')

const randomToken = (length: number): string =>
  base64Url(crypto.getRandomValues(new Uint8Array(length)))

const tokenHash = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return base64Url(new Uint8Array(digest))
}

const validBase64Url = (value: string | null, minimum: number, maximum: number): value is string =>
  Boolean(
    value && value.length >= minimum && value.length <= maximum && /^[A-Za-z0-9_-]+$/u.test(value)
  )

const validDesktopCallback = (value: string | null): string | null => {
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

const sessionForRequest = async (ctx: ActionCtx, request: Request) => {
  const auth = createAuth(ctx)
  return auth.api.getSession({ headers: request.headers })
}

const identityForRequest = async (
  ctx: ActionCtx,
  request: Request
): Promise<{ id: string; email: string; name: string; image?: string } | null> => {
  const session = await sessionForRequest(ctx, request)
  if (session) {
    return {
      id: session.user.id,
      email: session.user.email,
      name: session.user.name,
      image: session.user.image ?? undefined
    }
  }
  const authorization = request.headers.get('authorization')
  if (!authorization?.startsWith('Bearer ')) return null
  const token = authorization.slice(7).trim()
  if (!token) return null
  const authUserId = await ctx.runQuery(internal.profiles.userIdForAccountToken, {
    tokenHash: await tokenHash(token),
    now: Date.now()
  })
  if (!authUserId) return null
  const profile = await ctx.runQuery(internal.profiles.get, { authUserId })
  return profile
    ? {
        id: profile.authUserId,
        email: profile.email,
        name: profile.displayName,
        image: profile.image
      }
    : null
}

export const desktopSignIn = async (ctx: ActionCtx, request: Request): Promise<Response> => {
  const url = new URL(request.url)
  const provider = url.searchParams.get('provider')
  const redirectUri = validDesktopCallback(url.searchParams.get('redirect_uri'))
  const state = url.searchParams.get('state')
  const codeChallenge = url.searchParams.get('code_challenge')
  if (
    (provider !== 'google' && provider !== 'apple') ||
    !redirectUri ||
    !validBase64Url(state, 32, 128) ||
    !validBase64Url(codeChallenge, 43, 43) ||
    url.searchParams.get('code_challenge_method') !== 'S256'
  ) {
    return json({ error: 'invalid-desktop-sign-in' }, 400)
  }
  if (!socialProviderConfigured(provider)) {
    return json({ error: 'oauth-provider-not-configured', provider }, 503)
  }

  const siteUrl = process.env['SITE_URL']
  if (!siteUrl) return json({ error: 'auth-not-configured' }, 503)
  const authorizeUrl = new URL('/desktop/authorize', siteUrl)
  authorizeUrl.search = new URLSearchParams({
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge
  }).toString()
  const errorUrl = new URL(authorizeUrl)
  errorUrl.searchParams.set('oauth_error', provider)
  const headers = new Headers(request.headers)
  headers.set('Content-Type', 'application/json')
  headers.set('Origin', siteUrl)
  headers.delete('Content-Length')
  const authRequest = new Request(new URL('/api/auth/sign-in/social', siteUrl), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      provider,
      callbackURL: authorizeUrl.toString(),
      errorCallbackURL: errorUrl.toString()
    })
  })
  const response = await createAuth(ctx).handler(authRequest)
  if (!response.ok) return response
  const payload: unknown = await response.json()
  const providerUrl =
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)['url']
      : null
  return typeof providerUrl === 'string'
    ? redirect(providerUrl, response)
    : json({ error: 'oauth-start-failed' }, 502)
}

export const desktopAuthorize = async (ctx: ActionCtx, request: Request): Promise<Response> => {
  const url = new URL(request.url)
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
  const session = await sessionForRequest(ctx, request)
  if (!session) {
    callback.searchParams.set('error', 'unauthorized')
    return redirect(callback.toString())
  }
  const now = Date.now()
  await ctx.runMutation(internal.profiles.ensure, {
    authUserId: session.user.id,
    email: session.user.email,
    displayName: session.user.name,
    image: session.user.image ?? undefined,
    usageJson: JSON.stringify(emptyUsage(now)),
    globalMemoriesJson: '[]',
    updatedAt: now
  })
  const code = randomToken(32)
  await ctx.runMutation(internal.desktop_auth.createAuthorizationCode, {
    codeHash: await tokenHash(code),
    authUserId: session.user.id,
    redirectUri,
    codeChallenge,
    expiresAt: Date.now() + DESKTOP_AUTHORIZATION_TTL_MS
  })
  callback.searchParams.set('code', code)
  return redirect(callback.toString())
}

export const desktopRefresh = async (ctx: ActionCtx, request: Request): Promise<Response> => {
  const authorization = request.headers.get('authorization')
  const currentToken = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!currentToken) return json({ error: 'unauthorized' }, 401)
  const profileToken = randomToken(48)
  const expiresAt = Date.now() + ACCOUNT_TOKEN_TTL_MS
  const refreshed = await ctx.runMutation(internal.desktop_auth.refreshAccountToken, {
    tokenHash: await tokenHash(currentToken),
    replacementTokenHash: await tokenHash(profileToken),
    replacementExpiresAt: expiresAt,
    now: Date.now()
  })
  return refreshed ? json({ profileToken, expiresAt }) : json({ error: 'unauthorized' }, 401)
}

export const desktopExchange = async (ctx: ActionCtx, request: Request): Promise<Response> => {
  const body: unknown = await request.json().catch(() => null)
  const record =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null
  const code = typeof record?.['code'] === 'string' ? record['code'] : null
  const verifier = typeof record?.['codeVerifier'] === 'string' ? record['codeVerifier'] : null
  const redirectUri = validDesktopCallback(
    typeof record?.['redirectUri'] === 'string' ? record['redirectUri'] : null
  )
  if (!validBase64Url(code, 32, 128) || !validBase64Url(verifier, 43, 128) || !redirectUri) {
    return json({ error: 'invalid-authorization-code' }, 400)
  }
  const profileToken = randomToken(48)
  const expiresAt = Date.now() + ACCOUNT_TOKEN_TTL_MS
  const exchanged = await ctx.runMutation(internal.desktop_auth.exchangeAuthorizationCode, {
    codeHash: await tokenHash(code),
    codeChallenge: await tokenHash(verifier),
    redirectUri,
    accountTokenHash: await tokenHash(profileToken),
    accountTokenExpiresAt: expiresAt,
    now: Date.now()
  })
  return exchanged
    ? json({ profileToken, expiresAt })
    : json({ error: 'invalid-authorization-code' }, 400)
}

export const accountProfile = async (ctx: ActionCtx, request: Request): Promise<Response> => {
  const identity = await identityForRequest(ctx, request)
  if (!identity) return json({ error: 'unauthorized' }, 401)
  const stored = await ctx.runQuery(internal.profiles.get, { authUserId: identity.id })
  if (request.method === 'GET') {
    return json({
      profile: {
        id: identity.id,
        email: identity.email,
        displayName: identity.name,
        image: identity.image ?? null,
        usage: stored ? JSON.parse(stored.usageJson) : null,
        globalMemories: stored ? JSON.parse(stored.globalMemoriesJson) : [],
        updatedAt: stored?.updatedAt ?? Date.now()
      }
    })
  }
  const text = await request.text()
  if (new TextEncoder().encode(text).byteLength > MAX_PROFILE_BYTES) {
    return json({ error: 'profile-too-large' }, 413)
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return json({ error: 'invalid-profile' }, 400)
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return json({ error: 'invalid-profile' }, 400)
  }
  const record = body as Record<string, unknown>
  if (typeof record['usage'] !== 'object' || !Array.isArray(record['globalMemories'])) {
    return json({ error: 'invalid-profile' }, 400)
  }
  const updatedAt = Date.now()
  const mergedMemories = await ctx.runMutation(internal.profiles.save, {
    authUserId: identity.id,
    email: identity.email,
    displayName: identity.name,
    image: identity.image,
    usageJson: JSON.stringify(record['usage']),
    globalMemoriesJson: JSON.stringify(record['globalMemories']),
    updatedAt
  })
  return json({
    profile: {
      id: identity.id,
      email: identity.email,
      displayName: identity.name,
      image: identity.image ?? null,
      usage: record['usage'],
      // The server returns the per-entry merged union (not the request echo) so
      // every device adopts memories written on other devices.
      globalMemories: mergedMemories ?? record['globalMemories'],
      updatedAt
    }
  })
}
