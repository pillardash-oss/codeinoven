import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Database } from 'bun:sqlite'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'

const production = process.env['NODE_ENV'] === 'production'

function environmentValue(name: string, developmentFallback: string): string {
  const value = process.env[name]?.trim()
  if (value) return value
  if (production) throw new Error(`${name} is required in production`)
  return developmentFallback
}

export const authDatabasePath = resolve(
  process.env['REMOTE_DATABASE_PATH'] ?? 'data/remote-control.sqlite'
)

const baseURL = environmentValue('BETTER_AUTH_URL', 'http://localhost:8877')
const baseOrigin = new URL(baseURL).origin
mkdirSync(dirname(authDatabasePath), { recursive: true })
const authDatabase = new Database(authDatabasePath)
authDatabase.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')

export const auth = betterAuth({
  appName: 'CodeInOven',
  baseURL,
  secret: environmentValue(
    'BETTER_AUTH_SECRET',
    'development-only-codeinoven-auth-secret-change-me'
  ),
  database: authDatabase,
  trustedOrigins: [baseOrigin],
  emailAndPassword: { enabled: false },
  socialProviders: {
    github: {
      clientId: environmentValue('CODEINOVEN_GITHUB_CLIENT_ID', 'development-github-client-id'),
      clientSecret: environmentValue(
        'GITHUB_OAUTH_CLIENT_SECRET',
        'development-github-client-secret'
      ),
      scope: ['read:user', 'user:email']
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
    useSecureCookies: production,
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

export async function migrateAuthSchema(): Promise<void> {
  const migrations = await getMigrations(auth.options)
  await migrations.runMigrations()
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
