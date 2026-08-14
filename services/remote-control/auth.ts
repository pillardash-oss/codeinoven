import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { Database } from 'bun:sqlite'
import { betterAuth } from 'better-auth'
import { importPKCS8, SignJWT } from 'jose'
import {
  remoteAuthOrigin,
  remoteDatabasePath,
  remoteProduction,
  remotePublicOrigin
} from './runtime-config'

function environmentValue(name: string, developmentFallback: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (remoteProduction) throw new Error(`${name} is required in production`)
  return developmentFallback
}

export const authDatabasePath = remoteDatabasePath

const authHosts = [new URL(remotePublicOrigin).host, new URL(remoteAuthOrigin).host]
const trustedOrigins = [
  new URL(remotePublicOrigin).origin,
  new URL(remoteAuthOrigin).origin,
  'https://appleid.apple.com'
]
const appleClientId = environmentValue('APPLE_OAUTH_CLIENT_ID', 'development-apple-client-id')
const appleTeamId = environmentValue('APPLE_TEAM_ID', 'development-apple-team-id')
const appleKeyId = environmentValue('APPLE_KEY_ID', 'development-apple-key-id')
const developmentApplePrivateKey = remoteProduction
  ? ''
  : generateKeyPairSync('ec', { namedCurve: 'P-256' })
      .privateKey.export({
        type: 'pkcs8',
        format: 'pem'
      })
      .toString()
const applePrivateKey = environmentValue(
  'APPLE_PRIVATE_KEY',
  developmentApplePrivateKey
).replaceAll('\\n', '\n')
mkdirSync(dirname(authDatabasePath), { recursive: true })
const authDatabase = new Database(authDatabasePath)
authDatabase.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA temp_store = MEMORY;
  PRAGMA cache_size = -16384;
  PRAGMA mmap_size = 134217728;
  PRAGMA wal_autocheckpoint = 1000;
  PRAGMA journal_size_limit = 33554432;
`)

async function generateAppleClientSecret(): Promise<string> {
  const key = await importPKCS8(applePrivateKey, 'ES256')
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({ alg: 'ES256', kid: appleKeyId })
    .setIssuer(appleTeamId)
    .setSubject(appleClientId)
    .setAudience('https://appleid.apple.com')
    .setIssuedAt(now)
    .setExpirationTime(now + 180 * 24 * 60 * 60)
    .sign(key)
}

export const auth = betterAuth({
  appName: 'CodeInOven',
  baseURL: {
    allowedHosts: authHosts,
    protocol: remoteProduction ? 'https' : 'http',
    fallback: remotePublicOrigin
  },
  secret: environmentValue(
    'BETTER_AUTH_SECRET',
    'development-only-codeinoven-auth-secret-change-me'
  ),
  database: authDatabase,
  trustedOrigins,
  emailAndPassword: { enabled: false },
  socialProviders: {
    google: {
      clientId: environmentValue('GOOGLE_OAUTH_CLIENT_ID', 'development-google-client-id'),
      clientSecret: environmentValue(
        'GOOGLE_OAUTH_CLIENT_SECRET',
        'development-google-client-secret'
      )
    },
    apple: async () => {
      return {
        clientId: appleClientId,
        clientSecret: await generateAppleClientSecret()
      }
    }
  },
  account: {
    encryptOAuthTokens: true
  },
  session: {
    expiresIn: 30 * 24 * 60 * 60,
    updateAge: 24 * 60 * 60
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 100,
    storage: 'database'
  },
  advanced: {
    cookiePrefix: 'codeinoven',
    useSecureCookies: remoteProduction,
    ipAddress: {
      ipAddressHeaders: ['x-client-ip']
    }
  }
})

export interface RemoteAuthSession {
  id: string
  userId: string
  expiresAt: number
  email: string
  displayName: string
  image: string | null
}

export async function remoteAuthSession(request: Request): Promise<RemoteAuthSession | null> {
  const result = await auth.api.getSession({ headers: request.headers })
  if (!result) return null
  return {
    id: result.session.id,
    userId: result.user.id,
    expiresAt: result.session.expiresAt.getTime(),
    email: result.user.email,
    displayName: result.user.name,
    image: result.user.image ?? null
  }
}

export function closeAuthDatabase(): void {
  authDatabase.close()
}
