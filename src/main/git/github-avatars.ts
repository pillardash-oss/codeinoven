import { fetchImageAsDataUrl } from '../editor/favicon-service'

/**
 * Avatars for the GitHub logins a pull request conversation names.
 *
 * The renderer CSP is `img-src 'self' data: blob: file: appfile:`, so an
 * `avatars.githubusercontent.com` URL renders as a broken image and every picture
 * has to arrive as a `data:` URL. The signed-in user's own avatar takes the same
 * route in `github-auth-service.ts`; this is that idea for everyone else in a
 * conversation, cached by login so thirty comments from five people cost five
 * downloads. Link favicons come through the same inliner for the same reason.
 *
 * One URL covers both kinds of account: the CDN answers the `[bot]` form GitHub
 * uses for app accounts (checked: `dependabot[bot]` returns the app's picture),
 * and an account GitHub has never heard of gets GitHub's own placeholder, which is
 * what their site shows too. A fetch that fails outright is remembered as null so
 * the UI keeps its monogram and no second request is spent on it.
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

/** Resolve avatars for many logins in one call. Keys are the logins as asked for. */
export async function resolveAvatars(logins: string[]): Promise<Record<string, string | null>> {
  const result: Record<string, string | null> = {}
  await Promise.all(
    [...new Set(logins)].map(async (login) => {
      result[login] = await avatarFor(login)
    })
  )
  return result
}

async function avatarFor(login: string): Promise<string | null> {
  const trimmed = login.trim()
  const cached = cache.get(trimmed)
  if (cached && cached.expiresAt > Date.now()) return cached.dataUrl
  const dataUrl = trimmed.length === 0 ? null : await fetchImageAsDataUrl(avatarUrl(trimmed))
  remember(trimmed, dataUrl)
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
