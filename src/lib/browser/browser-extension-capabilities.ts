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
 * `nativeMessaging` is deliberately not in the list. The runtime's own
 * `connectNative`/`sendNativeMessage` refuse every host, but the app implements
 * native messaging itself   it finds and validates the host manifest, then owns
 * the host process   and the compatibility preamble gives the extension the Port
 * and the `permissions` namespace that goes with enabling it. A password manager's
 * desktop bridge therefore works here instead of being reported as lost.
 *
 * `permissions` is deliberately not in the list either. The runtime has no
 * namespace of its own, but the compatibility preamble implements it from the
 * extension's declared manifest, which is what an extension needs to enable an
 * optional capability such as `nativeMessaging` at runtime.
 *
 * `downloads` is deliberately not in the list. The runtime compiles the namespace
 * out, but the app owns every download the browser starts, so the compatibility
 * preamble feeds the extension the four events in the shapes the API documents and
 * forwards `cancel`, `pause`, `resume` and `erase` back to the download manager. A
 * capture extension (AB Download Manager and its kind) therefore sees a download
 * arrive and can stop the browser's copy to fetch the file itself, which is the
 * whole of what that permission is used for. What stays approximated is `search`,
 * `download`, `open`, `show` and `removeFile`, which answer empty rather than
 * failing loudly.
 *
 * `cookies` is deliberately not in the list either, with one limit: it is
 * read-only. `get` and `getAll` are answered from the jar's own session, which is
 * exactly what a download manager asks for   it collects the `Cookie` header a
 * native download needs, and without this namespace every download it takes over
 * arrives unauthenticated and asks the user to sign in. `set`, `remove` and
 * `removeAll` are refused rather than silently ignored, because this app has no
 * business writing a site's cookies from an extension.
 *
 * `webRequest` is not in the list, and it carries a limit of its own. The five
 * notification events (`onSendHeaders`, `onResponseStarted`, `onHeadersReceived`,
 * `onCompleted`, `onErrorOccurred`) are delivered from the jar's own session, which
 * is what lets a capture extension recognise a download before Chromium starts
 * one. The blocking halves are not implemented: a listener's return value is
 * ignored, so an extension cannot cancel or rewrite a response here   the download
 * path (`downloads.cancel`) is the supported way to take a transfer over.
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
  'debugger',
  'declarativeContent',
  'devtools',
  'fontSettings',
  'gcm',
  'history',
  'identity',
  'notifications',
  'omnibox',
  'pageCapture',
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
