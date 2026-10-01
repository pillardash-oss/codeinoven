/**
 * The macOS keychain access group a WebAuthn credential is stored under, derived
 * once so the code-signing entitlement and the runtime call can never disagree.
 *
 * Chromium compares the group handed to `app.configureWebAuthn` against the
 * `keychain-access-groups` entitlement byte for byte and refuses to service a
 * request when they differ. Both sides therefore come from one function: the
 * packaging script writes the entitlement from it, and the main process passes
 * the same string at boot.
 */

import { APP_ID } from '../brand'

/** Suffix that keeps WebAuthn credentials in their own group, apart from any
 *  other keychain group the app may hold inside the same team. */
export const WEBAUTHN_KEYCHAIN_GROUP_SUFFIX = '.webauthn'

/**
 * True when `value` is shaped like an Apple team identifier (ten upper-case
 * alphanumerics), which is what both the entitlement prefix and the baked build
 * value must be.
 */
export function isAppleTeamId(value: string): boolean {
  return /^[A-Z0-9]{10}$/.test(value)
}

/**
 * The keychain group for this app's WebAuthn credentials, of the form
 * `<TEAM_ID>.<BUNDLE_ID>.webauthn`.
 */
export function webauthnKeychainAccessGroup(teamId: string): string {
  return `${teamId}.${APP_ID}${WEBAUTHN_KEYCHAIN_GROUP_SUFFIX}`
}
