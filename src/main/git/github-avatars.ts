import { fetchImageAsDataUrl } from '../editor/favicon-service'
import type { GitHubAvatarRequest } from '../../lib/types'

/**
 * Avatars for the GitHub accounts a pull request conversation names.
 *
 * The renderer CSP is `img-src 'self' data: blob: file: appfile:`, so an
 * `avatars.githubusercontent.com` URL renders as a broken image and every picture
 * has to arrive as a `data:` URL. The signed-in user's own avatar takes the same
 * route in `github-auth-service.ts`; this is that idea for everyone else in a
 * conversation, cached by login so thirty comments from five people cost five
 * downloads. Link favicons come through the same inliner for the same reason.
 *
 * The URL the provider declared always wins over the login. Deriving the URL from
 * the login alone is right for people and wrong for apps: GitHub answers
 * `pullfrog[bot]` with a generated identicon, while the `avatar_url` on the very
 * same comment is the app's real picture   the one github.com shows. Accounts
 * arrive without a declared URL in some payloads (mention candidates for one), so
 * the login fallback stays.
 *
 * An account GitHub has never heard of gets its own placeholder, which is what
 * their site shows too. A fetch that fails outright is remembered as null so the
 * UI keeps its monogram and no second request is spent on it.
 */

/** Avatars change rarely and a login is stable, so a hit is worth keeping most of a day. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000
/**
 * A miss is retried sooner, because it can mean a deleted account, an app account
 * GitHub does not serve a picture for, or a request that merely blipped.
 */
const NEGATIVE_CACHE_TTL_MS = 10 * 60 * 1000
/** Bounded so a long-lived main process cannot accumulate logins forever. */
const MAX_CACHE_ENTRIES = 512
/** GitHub's own size parameter. The UI draws 20px, so 128 covers a retina screen. */
const AVATAR_SIZE_PIXELS = 128

const cache = new Map<string, { dataUrl: string | null; expiresAt: number }>()

/** Resolve avatars for many accounts in one call. Keys are the logins as asked for. */
export async function resolveAvatars(
  accounts: GitHubAvatarRequest[]
): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {}
  await Promise.all(
    dedupeByLogin(accounts).map(async (account) => {
      result[account.login] = await avatarFor(account)
    })
  )
  return result
}

/**
 * One request per login. A login asked for twice   once with the provider's URL and
 * once without   keeps its declared URL, since that is the only form that can be
 * right for an app account.
 */
function dedupeByLogin(accounts: GitHubAvatarRequest[]): GitHubAvatarRequest[] {
  const byLogin = new Map<string, GitHubAvatarRequest>()
  for (const account of accounts) {
    const login = account.login.trim()
    if (login.length === 0) continue
    const existing = byLogin.get(login)
    if (!existing || (!existing.avatarUrl && account.avatarUrl)) {
      byLogin.set(login, { login, avatarUrl: account.avatarUrl ?? null })
    }
  }
  return [...byLogin.values()]
}

async function avatarFor(account: GitHubAvatarRequest): Promise<string | null> {
  const login = account.login.trim()
  const declared = account.avatarUrl?.trim()
  const cached = cache.get(login)
  if (cached && cached.expiresAt > Date.now()) return cached.dataUrl
  const dataUrl = await fetchImageAsDataUrl(declared ? declared : avatarUrl(login))
  remember(login, dataUrl)
  return dataUrl
}

/** Where GitHub serves this account's picture. The login needs no other form. */
function avatarUrl(login: string): string {
  return `https://avatars.githubusercontent.com/${encodeURIComponent(login)}?s=${AVATAR_SIZE_PIXELS}`
}

function remember(login: string, dataUrl: string | null): void {
  if (cache.size >= MAX_CACHE_ENTRIES && !cache.has(login)) {
    // Map iteration is insertion ordered, so the first key is the oldest entry.
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(login, {
    dataUrl,
    expiresAt: Date.now() + (dataUrl === null ? NEGATIVE_CACHE_TTL_MS : CACHE_TTL_MS)
  })
}
