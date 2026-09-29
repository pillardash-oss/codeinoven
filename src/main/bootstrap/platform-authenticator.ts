import { app } from 'electron'
import { Logger } from '../system/logger'
import { isAppleTeamId, webauthnKeychainAccessGroup } from '../../lib/browser/browser-webauthn'

declare const __CODEINOVEN_MAC_TEAM_ID__: string | undefined

/**
 * Arm the platform authenticator the browser needs to service a passkey.
 *
 * Electron services a platform passkey request only after
 * `app.configureWebAuthn` has been called. Until then
 * `PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()` resolves
 * to `false`, and a request that only the platform authenticator could serve
 * never settles at all: measured on this runtime, `create()` and `get()` stay
 * pending with no prompt, no error and no timeout, and the pending request then
 * rejects every later call on that page with `A request is already pending`.
 *
 * What each platform needs is not the same thing, and this only has to do the
 * macOS half:
 *
 *  - **macOS.** Touch ID is the platform authenticator, and it is enabled by
 *    this call. The credentials live in the keychain under a group that the
 *    code signature must separately grant through `keychain-access-groups`,
 *    which is why a build made without that entitlement and the provisioning
 *    profile that authorizes it logs Chromium's own guard line per request
 *    (`touch_id_context.mm` "entitlement is missing or incorrect") and still
 *    services nothing.
 *  - **Windows.** Nothing is needed here. Chromium routes the ceremony to
 *    Windows Hello itself and the OS answers availability, so the app does not
 *    and must not call this: the binding is registered inside
 *    `#if BUILDFLAG(IS_MAC)` and is `undefined` off macOS.
 *  - **Linux.** Nothing can be done. The availability query is hardcoded false
 *    and there is no Linux platform discovery.
 *
 * Two gates, both deliberate: an unpackaged build cannot carry the entitlement
 * at all, so arming there would only produce a guard line per request, and a
 * build with no team identifier cannot name the group the entitlement grants.
 */
export function installPlatformAuthenticator(): void {
  if (process.platform !== 'darwin' || !app.isPackaged) return

  const teamId = (__CODEINOVEN_MAC_TEAM_ID__ ?? '').trim()
  if (!isAppleTeamId(teamId)) {
    Logger.info(
      'WebAuthn platform authenticator not armed: this build carries no Apple team identifier'
    )
    return
  }

  const keychainAccessGroup = webauthnKeychainAccessGroup(teamId)
  app.configureWebAuthn({ touchID: { keychainAccessGroup } })
  Logger.info('WebAuthn platform authenticator armed for Touch ID', { keychainAccessGroup })
}
