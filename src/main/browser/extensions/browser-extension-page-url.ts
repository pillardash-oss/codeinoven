/**
 * The page of an extension the app is willing to host for it.
 *
 * An extension opens its own settings, dialogs and reports with
 * `chrome.windows.create`, and the worker's shim routes any page on that
 * extension's own origin to the app. The origin is the security boundary: the
 * app hosts a page only when it belongs to the extension that asked, so a
 * request can never name another extension's page, and never carries
 * credentials. Everything else is refused before a view is created.
 *
 * The worker resolves a relative URL against the extension root before it sends
 * it, so what arrives here is absolute; the parse is still the check, because a
 * malformed string from a worker is untrusted input like any other.
 */
export function ownedExtensionPageUrl(
  extensionId: string,
  rawUrl: string | undefined
): string | null {
  if (!rawUrl) return null
  try {
    const url = new URL(rawUrl)
    if (
      url.protocol !== 'chrome-extension:' ||
      url.host !== extensionId ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}
