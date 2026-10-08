import { safeStorage, type Cookie, type Session } from 'electron'
import { readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Logger } from '../../system/logger'

interface CookieSession {
  ready: Promise<void>
  timer: ReturnType<typeof setTimeout> | null
  tail: Promise<void>
  path: string
}

// Process-owned rather than window-owned: parking the window keeps its jars live.
const sessions = new Map<Session, CookieSession>()
const MAX_SNAPSHOT_BYTES = 1024 * 1024

function encryptionAvailable(): boolean {
  return (
    safeStorage.isEncryptionAvailable() &&
    (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
  )
}

function isCookie(value: unknown): value is Cookie {
  if (!value || typeof value !== 'object') return false
  const cookie = value as Record<string, unknown>
  return (
    typeof cookie.name === 'string' &&
    typeof cookie.value === 'string' &&
    typeof cookie.domain === 'string' &&
    typeof cookie.path === 'string' &&
    typeof cookie.secure === 'boolean' &&
    typeof cookie.httpOnly === 'boolean' &&
    cookie.session === true &&
    typeof cookie.sameSite === 'string' &&
    ['unspecified', 'no_restriction', 'lax', 'strict'].includes(cookie.sameSite)
  )
}

/** Keep session cookies encrypted without changing website expiry or logout rules. */
export function restoreBrowserSessionCookies(browserSession: Session): Promise<void> {
  const existing = sessions.get(browserSession)
  if (existing) return existing.ready
  const root = browserSession.getStoragePath()
  if (!root) return Promise.resolve()
  const state: CookieSession = {
    ready: Promise.resolve(),
    timer: null,
    tail: Promise.resolve(),
    path: join(root, 'codeinoven-session-cookies.encrypted')
  }
  sessions.set(browserSession, state)
  state.ready = (async () => {
    if (!encryptionAvailable()) return
    try {
      if ((await stat(state.path)).size > MAX_SNAPSHOT_BYTES) {
        throw new Error('Cookie snapshot exceeds size limit')
      }
      const encrypted = await readFile(state.path)
      if (encrypted.length > MAX_SNAPSHOT_BYTES)
        throw new Error('Cookie snapshot exceeds size limit')
      const parsed: unknown = JSON.parse(safeStorage.decryptString(encrypted))
      if (!Array.isArray(parsed) || !parsed.every(isCookie))
        throw new Error('Invalid cookie snapshot')
      const current = await browserSession.cookies.get({})
      for (let offset = 0; offset < parsed.length; offset += 16) {
        await Promise.all(
          parsed.slice(offset, offset + 16).map(async (cookie: Cookie) => {
            if (
              current.some(
                (live) =>
                  live.name === cookie.name &&
                  live.domain === cookie.domain &&
                  live.path === cookie.path
              )
            )
              return
            const domain = cookie.domain ?? ''
            await browserSession.cookies.set({
              url: `${cookie.secure ? 'https' : 'http'}://${domain.replace(/^\./u, '')}${cookie.path}`,
              name: cookie.name,
              value: cookie.value,
              path: cookie.path,
              ...(cookie.hostOnly ? {} : { domain }),
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
              sameSite: cookie.sameSite
            })
          })
        )
      }
    } catch (error: unknown) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) {
        Logger.error('Browser session cookies could not be restored:', error)
      }
    }
    // Subscribe after restoring so replay cannot overwrite its own snapshot.
    browserSession.cookies.on('changed', () => {
      if (state.timer) clearTimeout(state.timer)
      state.timer = setTimeout(() => {
        state.timer = null
        void persist(browserSession, state)
      }, 1000)
    })
  })()
  return state.ready
}

function persist(browserSession: Session, state: CookieSession): Promise<void> {
  state.tail = state.tail
    .then(async () => {
      if (!encryptionAvailable()) return
      const cookies = await browserSession.cookies.get({ session: true })
      const payload = JSON.stringify(cookies)
      if (Buffer.byteLength(payload) > MAX_SNAPSHOT_BYTES - 64)
        throw new Error('Cookie snapshot exceeds size limit')
      await writeFile(`${state.path}.tmp`, safeStorage.encryptString(payload), { mode: 0o600 })
      await rename(`${state.path}.tmp`, state.path)
    })
    .catch((error: unknown) => Logger.error('Browser session cookies could not be saved:', error))
  return state.tail
}

/** Wait for a tracked jar without creating a snapshot for other browser contexts. */
export function waitBrowserSessionCookies(browserSession: Session): Promise<void> {
  return sessions.get(browserSession)?.ready ?? Promise.resolve()
}

/** Also used after clearing cookies so an old snapshot cannot resurrect a login. */
export async function flushBrowserSessionCookiesFor(browserSession: Session): Promise<void> {
  const state = sessions.get(browserSession)
  if (state) {
    await state.ready
    if (state.timer) clearTimeout(state.timer)
    state.timer = null
    await persist(browserSession, state)
  }
  browserSession.flushStorageData()
  await browserSession.cookies.flushStore()
}

/** Await disk writes before Electron or the updater terminates the process. */
export async function flushBrowserSessionCookies(): Promise<void> {
  for (const browserSession of sessions.keys()) {
    try {
      await flushBrowserSessionCookiesFor(browserSession)
    } catch (error: unknown) {
      Logger.error('Browser cookie store could not be flushed:', error)
    }
  }
}
