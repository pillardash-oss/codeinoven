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
 * Advertise the actual Chromium version using the standard Chrome/Safari
 * sequence. Extra Electron or app product tokens make sites such as WhatsApp
 * reject an otherwise supported browser, so omit them from remote requests.
 */
export function brandUserAgent(userAgent: string, chromeVersion: string): string {
  const tokens = userAgent
    .split(' ')
    .filter(
      (token) =>
        token.length > 0 &&
        !token.startsWith('Electron/') &&
        !token.startsWith(`${APP_NAME}/`) &&
        !token.startsWith('Chrome/')
    )
  const safariIndex = tokens.findIndex((token) => token.startsWith('Safari/'))
  tokens.splice(safariIndex === -1 ? tokens.length : safariIndex, 0, `Chrome/${chromeVersion}`)
  return tokens.join(' ')
}

/** Official web links shown on the About settings page. */
export const WEBSITE_URL = 'https://codeinoven.com'
export const GITHUB_URL = 'https://github.com/pillardash-oss/codeinoven'
export const X_URL = 'https://x.com/codeinoven'

/** Support address also used by the package author metadata. */
export const SUPPORT_EMAIL = 'hey@pillardash.com'
export const FEEDBACK_URL = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(`${APP_NAME} feedback`)}`
