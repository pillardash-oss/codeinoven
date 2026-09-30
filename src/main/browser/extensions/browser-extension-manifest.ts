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
 *   - The app's own `chrome.*` surface does not read the manifest at all: the
 *     compatibility preamble installs the namespaces it implements (its
 *     `contextMenus`, `privacy`, `webNavigation`, `notifications` and `sidePanel`
 *     bridges are unconditional), so a shimmed capability survives the strip.
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
 * Measured, not assumed: `RUNTIME_UNKNOWN_EXTENSION_PERMISSIONS` below was produced
 * by loading a manifest that declared the whole Chrome permission vocabulary
 * against Electron 44.4.5 and reading back what Chromium called unknown. Two names
 * that warn for reasons of their own are deliberately NOT stripped, because their
 * warning is a fact about this runtime the user should keep seeing:
 * `'usb' is not allowed for specified platform` and `'webRequestBlocking' requires
 * manifest version of 2 or lower`.
 */

import { readManifestObject, writeManifest, stringArray } from './browser-extension-source'

/**
 * Permission names this runtime's extension loader reports as unknown.
 *
 * Declaring one cannot enable anything: Chromium ignores the name rather than
 * granting it, and prints the warning the user's log caught. Measured against
 * Electron 44.4.5 (a manifest declaring the Chrome vocabulary, loaded through
 * `session.extensions.loadExtension`); a runtime upgrade that starts supporting
 * one of these is a reason to re-measure rather than to keep the name here.
 */
export const RUNTIME_UNKNOWN_EXTENSION_PERMISSIONS: readonly string[] = [
  'bookmarks',
  'browsingData',
  'contentSettings',
  'contextMenus',
  'cookies',
  'debugger',
  'declarativeContent',
  'devtools',
  'downloads',
  'fontSettings',
  'gcm',
  'geolocation',
  'history',
  'identity',
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
  'ttsEngine',
  'webNavigation',
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
