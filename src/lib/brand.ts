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

/** Official web links shown on the About settings page. */
export const WEBSITE_URL = 'https://codeinoven.com'
export const GITHUB_URL = 'https://github.com/pillardash-oss/codeinoven'
export const X_URL = 'https://x.com/pillardash'
