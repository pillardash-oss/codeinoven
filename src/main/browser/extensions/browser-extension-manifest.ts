/**
 * The manifest an installed copy is handed to Chromium under.
 *
 * Chromium's extension loader knows a fixed set of permission names. A manifest
 * that declares one it does not know is not refused   the name is ignored   but the
 * load is announced on stderr as
 *
 *     ExtensionLoadWarning: Warnings loading extension at <path>:
 *       Permission 'contextMenus' is unknown.
 *
 * which is what the user's dev console filled with on every launch of a jar that
 * holds a real extension: Bitwarden declares five names this runtime has never had
 * (`contextMenus`, `sidePanel`, `webNavigation`, `notifications`, `privacy`), so
 * five warnings appeared per load with nothing the user could do about them.
 *
 * The names are stripped from the copy the app installs, and only from the words
 * Chromium reads. Three things make that safe here:
 *
 *   - Chromium granted nothing for a name it does not know, so removing it cannot
 *     take a capability away from the extension.
 *   - The app's own `chrome.*` surface installs the namespaces it implements
 *     unconditionally (its `contextMenus`, `privacy`, `webNavigation`,
 *     `notifications` and `sidePanel` bridges do not consult the manifest), so a
 *     shimmed capability survives the strip. The one surface that does read the
 *     manifest is the `chrome.permissions` bridge, which answers from the declared
 *     names: a stripped name answers `false` to `contains` and `request`. That is
 *     the same deliberate tradeoff as the paragraph below, seen from a second
 *     reader.
 *   - What the extension declared is still the app's own record: the registry
 *     keeps `declaredPermissions` from the install, which is what the capability
 *     report and the extensions panel are built from (see
 *     `src/lib/browser/browser-extension-capabilities.ts`).
 *
 * The one observer that sees a difference is the extension itself, if it inspects
 * `chrome.runtime.getManifest().permissions`. That is deliberate and it is the
 * price of a quiet launch: the alternative is a manifest that lies to the runtime
 * on every load. The extensions this app is used with read their manifest for the
 * version and their own declared files, not for their permissions.
 *
 * Measured, not assumed: `RUNTIME_UNKNOWN_EXTENSION_PERMISSIONS` below is what
 * Electron 44.8.0 (Chromium 152.0.7977.167) answered when one manifest declared
 * every permission name this Chromium can carry. Chromium refuses `socket` and
 * `usbDevices` without a value, which is itself proof that it knows them, so those
 * two never appear in it. Two names that warn for reasons of their own are
 * deliberately NOT stripped, because their warning is a fact about this runtime
 * the user should keep seeing: `'usb' is not allowed for specified platform` and
 * `'webRequestBlocking' requires manifest version of 2 or lower`.
 */

import { readManifestObject, writeManifest, stringArray } from './browser-extension-source'

/**
 * Permission names this runtime reports as unknown but the app implements anyway.
 *
 * They are kept in the installed manifest rather than stripped, because an
 * extension's own copy is what it reads back with `getManifest()`: a download
 * manager that only turns its capture on when it declared `downloads` would find
 * the permission missing here and stay quiet, even though the compatibility
 * preamble gives it the namespace. Keeping the name costs the one warning the
 * loader prints and buys an extension whose own view of itself is true.
 *
 * `downloads` is the first entry: the app's download manager owns every download
 * the browser starts, feeds the four events, and forwards cancel, pause, resume and
 * erase (see `browser-download-extension.ts`).
 */
export const IMPLEMENTED_EXTENSION_PERMISSIONS: readonly string[] = ['downloads']

/**
 * Permission names this runtime's extension loader reports as unknown.
 *
 * Declaring one cannot enable anything: Chromium ignores the name rather than
 * granting it, and prints the warning the user's log caught. The list is the
 * measurement described above, taken over the union of the three tables that name
 * a manifest permission in the Chromium `DEPS` pins
 * (`extensions/common/api/_permission_features.json`,
 * `extensions/common/permissions/extensions_api_permissions.cc` and
 * `chrome/common/extensions/permissions/chrome_api_permissions.cc`, the last of
 * which Electron does not compile), loaded through
 * `session.extensions.loadExtension`; a runtime upgrade that starts supporting
 * one of these is a reason to re-measure rather than to keep the name here.
 */
export const RUNTIME_UNKNOWN_EXTENSION_PERMISSIONS: readonly string[] = [
  'accessibilityFeatures.modify',
  'accessibilityFeatures.read',
  'accessibilityPrivate',
  'accessibilityServicePrivate',
  'activityLogPrivate',
  'autofillPrivate',
  'autotestPrivate',
  'background',
  'bookmarks',
  'brailleDisplayPrivate',
  'browsingData',
  'certificateProvider',
  'chromeosInfoPrivate',
  'commandLinePrivate',
  'commands.accessibility',
  'contentSettings',
  'contextMenus',
  'contextualTasksPrivate',
  'cookies',
  'debugger',
  'declarativeContent',
  'desktopCapture',
  'developerPrivate',
  'devtools',
  'dictationPrivate',
  'documentScan',
  'downloads',
  'downloads.open',
  'downloads.shelf',
  'downloads.ui',
  'echoPrivate',
  'enterprise.deviceAttributes',
  'enterprise.hardwarePlatform',
  'enterprise.kioskInput',
  'enterprise.login',
  'enterprise.networkingAttributes',
  'enterprise.platformKeys',
  'enterprise.platformKeysPrivate',
  'enterprise.reportingPrivate',
  'experimental',
  'experimentalActor',
  'experimentalAiData',
  'favicon',
  'fileBrowserHandler',
  'fileManagerPrivate',
  'fileSystemProvider',
  'fontSettings',
  'gcm',
  'geolocation',
  'glicPrivate',
  'glicPrivate.invoke',
  'history',
  'homepage',
  'identity',
  'identity.email',
  'imageLoaderPrivate',
  'imageWriterPrivate',
  'indigoPrivate',
  'input',
  'inputMethodPrivate',
  'languageSettingsPrivate',
  'mdns',
  'mediaPlayerPrivate',
  'newTabPageOverride',
  'notifications',
  'omnibox',
  'omnibox.directInput',
  'pageCapture',
  'passwordsPrivate',
  'permissions',
  'platformKeys',
  'privacy',
  'processes',
  'proxyOverrideRulesPrivate',
  'readingList',
  'runtime',
  'safeBrowsingPrivate',
  'search',
  'searchProvider',
  'sessions',
  'settingsPrivate',
  'sidePanel',
  'smartCardProviderPrivate',
  'startupPages',
  'systemPrivate',
  'tabCapture',
  'tabCaptureForTab',
  'tabGroups',
  'terminalPrivate',
  'topSites',
  'transientBackground',
  'tts',
  'ttsEngine',
  'usersPrivate',
  'virtualKeyboardPrivate',
  'wallpaper',
  'webAuthenticationProxy',
  'webNavigation',
  'webcamPrivate',
  'webrtcDesktopCapturePrivate',
  'webrtcLoggingPrivate',
  'webrtcLoggingPrivate.audioDebug',
  'windows'
]

/** The manifest keys a permission can be declared under. Both are stripped: an
 *  optional permission that can never be requested is as unknown as a required
 *  one, and Chromium warns about it either way. */
const PERMISSION_KEYS = ['permissions', 'optional_permissions'] as const

/**
 * Remove the permissions this runtime cannot have from a manifest, in place.
 *
 * Answers the names that were removed, in the order they were declared, so a
 * caller can say what it stripped. A manifest with nothing to strip is left
 * exactly as it was, including a malformed permission list: this is not the place
 * to repair a manifest, only to stop feeding Chromium a word it rejects.
 */
export function stripUnknownPermissions(manifest: Record<string, unknown>): string[] {
  const removed: string[] = []
  for (const key of PERMISSION_KEYS) {
    const declared = stringArray(manifest[key])
    if (declared.length === 0) continue
    const kept = declared.filter((permission) => {
      if (IMPLEMENTED_EXTENSION_PERMISSIONS.includes(permission)) return true
      if (!RUNTIME_UNKNOWN_EXTENSION_PERMISSIONS.includes(permission)) return true
      if (!removed.includes(permission)) removed.push(permission)
      return false
    })
    if (kept.length === declared.length) continue
    manifest[key] = kept
  }
  return removed
}

/**
 * Bring one installed copy's manifest up to what this runtime can be handed, and
 * answer what was removed.
 *
 * Run before every `loadExtension` rather than only at install, because a copy
 * installed before this rule existed would otherwise keep warning for the rest of
 * its life: the file on disk is the app's own copy, and rewriting it is the same
 * act as installing the current preamble into it.
 */
export async function stripInstalledManifestPermissions(extensionDir: string): Promise<string[]> {
  const manifest = await readManifestObject(extensionDir)
  const removed = stripUnknownPermissions(manifest)
  if (removed.length > 0) await writeManifest(extensionDir, manifest)
  return removed
}
