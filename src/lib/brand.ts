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
