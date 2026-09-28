import { isBlockedFetchHost, isLocalDevelopmentUrl } from './local-development-url'

/**
 * Whether a link a drag carried may be fetched to become an attachment.
 *
 * The link comes out of a page the user dragged from, so it is untrusted input
 * even though the gesture was deliberate: it is the *page* that names the URL,
 * not the user. The rules here are the ones the app's own browser address bar is
 * held to, so a thing the user can look at in the browser is a thing they can
 * attach, and nothing else opens a connection from the main process:
 *
 * - `http` and `https` only. `file:`, `blob:`, `data:` and every custom scheme
 *   are refused rather than handed to a fetcher that might resolve them locally.
 * - no credentials in the URL, so a link cannot smuggle a password to a host.
 * - loopback and the local network are allowed (that is where the app's own
 *   browser spends its time: localhost dev servers, served designs), while the
 *   ranges that only matter to a process opening the connection (link-local,
 *   cloud metadata, unique-local and IPv4-mapped IPv6) are refused.
 * - plain `http` is only for a local host, because an off-machine plain-http
 *   fetch would put the user's page content on the wire in the clear.
 *
 * Redirects are re-checked by the transfer that follows this, hop by hop: a
 * public host is free to answer `Location: http://169.254.169.254/`.
 */

/** Longest accepted media link. A drag payload is a link, not a payload. */
export const MAX_ATTACHABLE_MEDIA_URL_LENGTH = 4_096

export type AttachableMediaUrlCheck = { ok: true; url: URL } | { ok: false; reason: string }

/** Whether a dragged link may be fetched, and the URL to fetch. */
export function checkAttachableMediaUrl(raw: string): AttachableMediaUrlCheck {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, reason: 'the link is empty' }
  if (trimmed.length > MAX_ATTACHABLE_MEDIA_URL_LENGTH) {
    return {
      ok: false,
      reason: `the link is longer than ${MAX_ATTACHABLE_MEDIA_URL_LENGTH} characters`
    }
  }
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return { ok: false, reason: 'the link is not a web address' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return {
      ok: false,
      reason: `only an http or https link can be attached, and this one uses "${url.protocol}"`
    }
  }
  if (url.username !== '' || url.password !== '') {
    return { ok: false, reason: 'the link carries credentials' }
  }
  const local = isLocalDevelopmentUrl(url.href)
  if (url.protocol === 'http:' && !local) {
    return {
      ok: false,
      reason: 'plain http is only accepted for a host on this machine or the local network'
    }
  }
  if (!local && isBlockedFetchHost(url)) {
    return {
      ok: false,
      reason: 'the link points at an address that only this machine can reach'
    }
  }
  return { ok: true, url }
}
