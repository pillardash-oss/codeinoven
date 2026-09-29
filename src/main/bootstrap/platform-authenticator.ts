import { app } from 'electron'
import { Logger } from '../system/logger'
import { isAppleTeamId, webauthnKeychainAccessGroup } from '../../lib/browser/browser-webauthn'

declare const __CODEINOVEN_MAC_TEAM_ID__: string | undefined

/**
 * Arm the macOS platform authenticator the browser needs to service a passkey.
 *
 * This is only half of what a passkey needs, and the other half is not in this
 * file: arming makes Touch ID available, and a sign-in still has to be able to
 * choose an account. `get({ allowCredentials: [] })`, which is the shape a site
 * like Google uses for "sign in with a passkey", is a discoverable request, and
 * Electron routes it through `select-webauthn-account` on the Session. Electron
 * cancels that request when no listener is registered, and it does not fail
 * fast: measured on this runtime against a stored credential, the page's promise
 * never settled at all, so the site shows a spinner forever. Nothing arms that
 * listener yet, and no amount of code here can substitute for it.
 *
 * On macOS, Electron services a platform passkey request only after
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
 *    services nothing. The entitlement and the embedded profile are both
 *    required, and neither is enough alone.
 *  - **Windows.** Nothing is needed here, and nothing is possible: Chromium
 *    routes the ceremony to Windows Hello itself and the OS answers
 *    availability, so the app must not call this, because the binding is
 *    registered inside `#if BUILDFLAG(IS_MAC)` and does not exist off macOS.
 *    What availability really depends on is Windows: Windows 10 1903 or later,
 *    `webauthn.dll` loadable, and Hello set up by the user, behind Chromium's
 *    default-on `WebAuthenticationUseNativeWinApi` flag.
 *  - **Linux.** The platform authenticator is genuinely unavailable: the
 *    availability query is hardcoded false and no platform discovery is created.
 *    That is not the whole story for passkeys, though, because the transport set
 *    is built independently of it and USB roaming keys are always offered. A
 *    security key therefore still works, except one that needs a PIN, because
 *    Electron implements no PIN UI.
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
