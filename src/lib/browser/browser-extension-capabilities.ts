/**
 * The `chrome.*` surface this runtime does not have, as a fact about the runtime
 * rather than about any one extension.
 *
 * Electron compiles out a set of namespaces even when an extension declares the
 * permission for them, so an extension that needs one is not broken by anything
 * the app did; it is running against a browser that does not implement it. This
 * list is the measured surface (the shipped runtime was asked, from inside an
 * extension's own service worker, which namespaces existed with the permission
 * declared) and it exists so the app can tell the user which capabilities an
 * extension lost instead of implying the extension is whole.
 *
 * `nativeMessaging` is in the list for a different reason: the namespace and its
 * functions are present, and every call is refused by the runtime with "Access to
 * the native messaging host was disabled by the system administrator". A
 * password manager whose desktop bridge is the point cannot be made to work here,
 * and saying so is the honest thing to do.
 *
 * `contextMenus` is deliberately not in the list. The runtime still has no
 * namespace of its own, but the app's install-time bridge records the tree each
 * extension creates and renders it in the native context menu, so an extension
 * that contributes menu items keeps them (what is lost is `onShown`/`onHidden`,
 * which nothing in this runtime ever fires).
 *
 * `userScripts` is deliberately not in the list either. The compatibility preamble
 * implements the namespace on top of `scripting.registerContentScripts`, which the
 * runtime does have, by having the app write each registered script's code into a
 * file inside the extension's own copy and registering that file. What is
 * approximated is the world: the `USER_SCRIPT` execution world does not exist in
 * this runtime's `scripting` API at all ("Value must be one of ISOLATED, MAIN",
 * measured with the permission declared), so a script that asked for it runs in
 * the extension's isolated world instead, which is isolated from the page in the
 * same way. The one difference is the extension's MV3 CSP, which refuses `eval`
 * where the user-script world is exempt from both CSPs; the generated user scripts
 * of the extensions that use this API (uBlock Origin Lite's own scriptlet template)
 * are `eval`-free, so they run as intended.
 *
 * Pure data, shared by the main process (which reports it per install) and the
 * renderer (which explains it), so the two can never disagree.
 */
export const BROWSER_EXTENSION_ABSENT_CAPABILITIES: readonly string[] = [
  'bookmarks',
  'browsingData',
  'commands',
  'cookies',
  'debugger',
  'declarativeContent',
  'devtools',
  'downloads',
  'fontSettings',
  'gcm',
  'history',
  'identity',
  'nativeMessaging',
  'notifications',
  'omnibox',
  'pageCapture',
  'permissions',
  'privacy',
  'search',
  'sessions',
  'sidePanel',
  'tabCapture',
  'tabGroups',
  'topSites',
  'tts',
  'usb',
  'webNavigation',
  'windows'
]

/**
 * What one extension asked for that this runtime cannot give it, in the order the
 * extension declared it so the report reads like its own manifest.
 */
export function missingExtensionCapabilities(
  declaredPermissions: readonly string[]
): readonly string[] {
  const missing: string[] = []
  for (const permission of declaredPermissions) {
    if (!BROWSER_EXTENSION_ABSENT_CAPABILITIES.includes(permission)) continue
    if (missing.includes(permission)) continue
    missing.push(permission)
  }
  return missing
}
