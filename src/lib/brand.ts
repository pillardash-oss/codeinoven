/**
 * Single source of truth for product branding.
 *
 * A rebrand should only require editing this file plus the static configs
 * that cannot import TypeScript: package.json (name/description),
 * electron-builder.yml (productName/appId) and src/renderer/index.html title.
 */

/** Display name shown everywhere users see the product. */
export const APP_NAME = 'CodeInOven'

/** Application identifier used by native operating-system integrations. */
export const APP_ID = 'com.pillardash.codeinoven'

/** Lowercase identifier used for paths, storage keys and file prefixes. */
export const APP_SLUG = 'codeinoven'

/** Vendor segment used in the config root path. */
export const ORG_SLUG = 'pillardash'

/**
 * Present the product, and not the runtime it is built on, to every remote
 * server the app and its embedded browser talk to.
 *
 * Chromium's user agent carries the product token Electron derives from
 * `app.setName()` and then appends its own `Electron/<version>` token after the
 * `Chrome/` token. That trailing token is what makes sites report Electron, so
 * it is dropped here and the product token is kept (with the pinned build
 * version inserted when the runtime did not add one at all).
 */
export function brandUserAgent(userAgent: string, version: string): string {
  const productToken = `${APP_NAME}/${version}`
  const tokens = userAgent
    .split(' ')
    .filter((token) => token.length > 0 && !token.startsWith('Electron/'))
    // The runtime stamps the product name with whatever version it resolved for
    // itself, so every product token is pinned to the version the caller owns
    // (the build version, which a nightly prerelease changes).
    .map((token) => (token.startsWith(`${APP_NAME}/`) ? productToken : token))
  if (tokens.includes(productToken)) return tokens.join(' ')
  const chromeIndex = tokens.findIndex((token) => token.startsWith('Chrome/'))
  tokens.splice(chromeIndex === -1 ? tokens.length : chromeIndex, 0, productToken)
  return tokens.join(' ')
}

/** Official web links shown on the About settings page. */
export const WEBSITE_URL = 'https://codeinoven.com'
export const GITHUB_URL = 'https://github.com/pillardash-oss/codeinoven'
export const X_URL = 'https://x.com/codeinoven'

/** Support address also used by the package author metadata. */
export const SUPPORT_EMAIL = 'hey@pillardash.com'
export const FEEDBACK_URL = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${APP_NAME} feedback`)}`
