/**
 * Turning a downloaded package or a picked folder into the source tree the app
 * will actually load: extracted safely, given a stable identity, and summarised
 * so the surface can describe what was installed.
 *
 * Three properties matter and each is enforced here rather than trusted:
 *
 *   1. **An archive cannot write outside its destination.** Entry names come from
 *      the package, so a name containing `..` or an absolute path is refused, and
 *      a symlink entry is skipped: a symlink is how an archive reaches a file the
 *      user did not agree to hand over.
 *   2. **The identity is pinned, never derived from where the app put the files.**
 *      An unpacked extension's id is a hash of its install path, which makes the
 *      same extension installed twice two different extensions with two different
 *      storage areas. A CRX's publisher key is injected as the manifest's `key`,
 *      and a folder with no key of its own is given a freshly generated one, so
 *      the id is the extension's own from the first run onwards.
 *   3. **The fingerprint ignores what Chromium writes into the source.** Enabling
 *      a static ruleset makes Chromium compile the rulesets into `_metadata/`
 *      inside the extension's own folder, so a fingerprint that hashed everything
 *      would change whenever the user configured their filters and report a
 *      legitimate enable as an upstream change.
 */

import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, extname, join, resolve, sep } from 'node:path'
import JSZip from 'jszip'
import { missingExtensionCapabilities } from '../../../lib/browser/browser-extension-capabilities'
import { extensionIdFromManifestKey } from './browser-extension-crx'

/** The file that declares an extension. */
export const EXTENSION_MANIFEST_NAME = 'manifest.json'

/** A directory an extension writes into itself, which the fingerprint skips. */
const GENERATED_DIRECTORY_NAME = '_metadata'

/** Archive entries that describe the archive rather than its contents. */
const ARCHIVE_METADATA_PREFIXES = ['__MACOSX/'] as const

/** How many entries are extracted before the worker yields, so its message loop
 *  keeps delivering progress while a package is unpacked. */
const ENTRIES_PER_YIELD = 24

/** An icon is drawn next to a name, so the bytes are bounded well below what a
 *  package could carry. */
const MAX_ICON_BYTES = 512 * 1024

const ICON_MIME_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp'
}

/** The summary the app keeps about one installed extension. */
export interface ExtensionSourceSummary {
  /** The id the pinned key derives, or null when the manifest carried no usable key. */
  id: string | null
  name: string
  version: string
  description: string
  /** Extension-root-relative popup document, or null. */
  popupPath: string | null
  /** Every permission the extension declares, deduplicated and in declaration order. */
  declaredPermissions: string[]
  /** The `declarative_net_request` rulesets it ships, with whether each is
   *  declared enabled, so the install report can say the runtime ignores that flag. */
  ruleResources: { id: string; enabled: boolean }[]
  /** Manifest version, so the surface can be honest that MV2 is on borrowed time. */
  manifestVersion: number
}

export interface ManifestRecord {
  manifestVersion: number
  name: string
  version: string
  description: string
  popupPath: string | null
  declaredPermissions: string[]
  ruleResources: { id: string; enabled: boolean }[]
  /** The `key` the manifest pins, if it already had one. */
  key: string | null
  /** The background declaration, so the injector can pick its shape. */
  background: {
    serviceWorker: string | null
    isModule: boolean
    scripts: string[]
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolveYield) => setImmediate(resolveYield))
}

/**
 * The path one archive entry may occupy, or null when it must be refused.
 *
 * Refused: absolute paths, any `..` segment, drive-qualified names, and the
 * archive's own metadata. Windows separators are normalised, because a package
 * built on Windows can carry them and `join` would otherwise treat the whole
 * entry as one file name.
 */
function safeRelativeEntryPath(rawName: string): string | null {
  const normalized = rawName
    .replaceAll('\\', '/')
    .replace(/^\.\/+/u, '')
    .replace(/^\/+/u, '')
  if (!normalized) return null
  if (/^[a-zA-Z]:/u.test(normalized)) return null
  for (const prefix of ARCHIVE_METADATA_PREFIXES) {
    if (normalized.startsWith(prefix)) return null
  }
  const segments = normalized.split('/')
  if (segments.some((segment) => segment === '..' || segment === '.')) return null
  if (segments.some((segment) => segment.length === 0)) return null
  if (segments[0] === GENERATED_DIRECTORY_NAME) return null
  return segments.join('/')
}

/** True when `candidate` really sits inside `root`, so a joined path can never
 *  address something above the destination. */
function isInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root)
  const resolvedCandidate = resolve(candidate)
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(resolvedRoot + sep)
}

/**
 * Extract a ZIP payload into `destinationDir`.
 *
 * The directory is expected to be empty and app-owned; it is never merged into.
 * `onProgress` receives a count of entries written, which is the only progress a
 * ZIP offers without decompressing everything twice.
 */
export async function extractZipToDirectory(
  zipBytes: Buffer,
  destinationDir: string,
  onProgress: (entriesWritten: number) => void
): Promise<number> {
  const archive = await JSZip.loadAsync(zipBytes)
  const entries = Object.values(archive.files)
  let written = 0
  for (const entry of entries) {
    const relative = safeRelativeEntryPath(entry.name)
    if (!relative) continue
    const absolute = join(destinationDir, relative)
    if (!isInside(destinationDir, absolute)) {
      throw new Error(`The package tried to write outside its own folder (${entry.name})`)
    }
    if (entry.dir) {
      await mkdir(absolute, { recursive: true })
      continue
    }
    // A symlink is recorded with the unix mode's symlink bit set. Following one is
    // how an archive reads or writes a file the user never offered, so they are
    // skipped rather than extracted.
    const permissions = entry.unixPermissions
    if (typeof permissions === 'number' && (permissions & 0o170000) === 0o120000) continue
    await mkdir(dirname(absolute), { recursive: true })
    const contents = await entry.async('nodebuffer')
    await writeFile(absolute, contents)
    written += 1
    onProgress(written)
    if (written % ENTRIES_PER_YIELD === 0) await yieldToEventLoop()
  }
  return written
}

async function readJsonFile(filePath: string): Promise<unknown> {
  const text = await readFile(filePath, 'utf8')
  return JSON.parse(text) as unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/**
 * Resolve a manifest string that may be an i18n placeholder (`__MSG_name__`).
 *
 * The manifest's own `default_locale` wins, then `en`, then whatever locale folder
 * exists first, because a Web Store package always ships its messages and a
 * placeholder shown raw in the user's extension list is worse than a guess.
 */
async function resolveManifestText(
  extensionDir: string,
  manifest: Record<string, unknown>,
  value: unknown
): Promise<string> {
  if (typeof value !== 'string') return ''
  const placeholder = /^__MSG_(.+)__$/u.exec(value)
  if (!placeholder?.[1]) return value
  const messageKey = placeholder[1]
  const defaultLocale =
    typeof manifest['default_locale'] === 'string' ? manifest['default_locale'] : null
  const localesDir = join(extensionDir, '_locales')
  // Declared without an initialiser on purpose: the catch below returns, so the
  // readdir result is the only value this list can ever hold.
  let candidates: string[]
  try {
    candidates = await readdir(localesDir)
  } catch {
    return value
  }
  const ordered = [
    ...(defaultLocale ? [defaultLocale] : []),
    'en',
    'en_US',
    ...candidates.filter((locale) => locale !== defaultLocale && locale !== 'en')
  ]
  for (const locale of ordered) {
    if (!candidates.includes(locale)) continue
    try {
      const messages = asRecord(await readJsonFile(join(localesDir, locale, 'messages.json')))
      const message = asRecord(messages[messageKey])
      const text = message['message']
      if (typeof text === 'string' && text.length > 0) return text
    } catch {
      // A locale that cannot be read is skipped rather than fatal: the extension
      // itself is still installable, it just shows its own placeholder.
    }
  }
  return value
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : []
}

function ruleResourcesOf(manifest: Record<string, unknown>): { id: string; enabled: boolean }[] {
  const dnr = asRecord(manifest['declarative_net_request'])
  const resources = dnr['rule_resources']
  if (!Array.isArray(resources)) return []
  const out: { id: string; enabled: boolean }[] = []
  for (const entry of resources) {
    const record = asRecord(entry)
    const id = record['id']
    if (typeof id !== 'string' || id.length === 0) continue
    out.push({ id, enabled: record['enabled'] === true })
  }
  return out
}

/** Every permission the extension declares, in declaration order and without
 *  duplicates, including the optional ones: an optional permission that can never
 *  be granted is still a capability the user should be told is missing. */
function declaredPermissionsOf(manifest: Record<string, unknown>): string[] {
  const declared: string[] = []
  for (const permission of [
    ...stringArray(manifest['permissions']),
    ...stringArray(manifest['optional_permissions'])
  ]) {
    if (!declared.includes(permission)) declared.push(permission)
  }
  return declared
}

function popupPathOf(manifest: Record<string, unknown>): string | null {
  for (const key of ['action', 'browser_action']) {
    const action = asRecord(manifest[key])
    const popup = action['default_popup']
    if (typeof popup === 'string' && popup.length > 0) return popup.replace(/^\/+/u, '')
  }
  return null
}

/**
 * The address of an extension's declared popup document, or null when the
 * declaration cannot name a document inside the extension's own files.
 *
 * The path is resolved against the extension's own origin rather than joined by
 * hand, and the result has to still be that origin: a manifest that declares an
 * absolute URL, or a path that climbs out of the extension's root, gets no popup
 * rather than a navigation. The host is compared rather than the origin because
 * a `chrome-extension:` URL's origin is opaque.
 */
export function extensionPopupUrl(id: string, popupPath: string | null): string | null {
  if (!popupPath) return null
  let resolved: URL
  try {
    resolved = new URL(popupPath, `chrome-extension://${id}/`)
  } catch {
    return null
  }
  if (resolved.protocol !== 'chrome-extension:' || resolved.host !== id) return null
  return resolved.href
}

function backgroundOf(manifest: Record<string, unknown>): ManifestRecord['background'] {
  const background = asRecord(manifest['background'])
  const serviceWorker = background['service_worker']
  const hasServiceWorker = typeof serviceWorker === 'string' && serviceWorker.length > 0
  return {
    serviceWorker: hasServiceWorker ? (serviceWorker as string) : null,
    isModule: background['type'] === 'module',
    scripts: stringArray(background['scripts'])
  }
}

/** Read the manifest of an extracted extension, with its text resolved. */
export async function readManifestRecord(extensionDir: string): Promise<ManifestRecord> {
  let raw: unknown
  try {
    raw = await readJsonFile(join(extensionDir, EXTENSION_MANIFEST_NAME))
  } catch {
    throw new Error('The extension has no readable manifest.json')
  }
  const manifest = asRecord(raw)
  if (typeof manifest['name'] !== 'string' || manifest['name'].length === 0) {
    throw new Error('The extension manifest declares no name')
  }
  return {
    manifestVersion:
      typeof manifest['manifest_version'] === 'number' ? manifest['manifest_version'] : 3,
    name: await resolveManifestText(extensionDir, manifest, manifest['name']),
    version: typeof manifest['version'] === 'string' ? manifest['version'] : '0',
    description: await resolveManifestText(extensionDir, manifest, manifest['description']),
    popupPath: popupPathOf(manifest),
    declaredPermissions: declaredPermissionsOf(manifest),
    ruleResources: ruleResourcesOf(manifest),
    key: typeof manifest['key'] === 'string' ? manifest['key'] : null,
    background: backgroundOf(manifest)
  }
}

/** Best available icon as a data URL, or null. Prefers the manifest's `icons`
 *  (the largest it ships under a sane bound) over an action icon, because the
 *  action icon is sized for a toolbar the app does not draw. */
export async function readManifestIconDataUrl(
  extensionDir: string,
  manifest: unknown
): Promise<string | null> {
  const record = asRecord(manifest)
  const candidates: string[] = []
  const icons = asRecord(record['icons'])
  const sized = Object.entries(icons)
    .map(([size, path]) => ({ size: Number(size), path }))
    .filter((entry) => typeof entry.path === 'string' && Number.isFinite(entry.size))
    .sort((left, right) => right.size - left.size)
  for (const entry of sized) candidates.push(entry.path as string)
  for (const key of ['action', 'browser_action']) {
    const action = asRecord(record[key])
    const declared = action['default_icon']
    if (typeof declared === 'string') candidates.push(declared)
    else
      for (const path of Object.values(asRecord(declared))) {
        if (typeof path === 'string') candidates.push(path)
      }
  }
  for (const candidate of candidates) {
    const relative = candidate.replace(/^\/+/u, '')
    if (!relative) continue
    const mime = ICON_MIME_TYPES[extname(relative).toLowerCase()]
    if (!mime) continue
    const absolute = join(extensionDir, relative)
    if (!isInside(extensionDir, absolute)) continue
    try {
      const bytes = await readFile(absolute)
      if (bytes.byteLength === 0 || bytes.byteLength > MAX_ICON_BYTES) continue
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      // A declared icon that is missing or unreadable is not a failure: the row
      // falls back to a glyph.
    }
  }
  return null
}

/** How many action icons are held in memory at once. A worker re-records its
 *  action state on every change and the app reads that snapshot every 80 ms, so
 *  the bytes behind one icon would otherwise be re-read from disk on each read. */
const MAX_ACTION_ICON_CACHE = 64

/**
 * An icon an extension set on its own action, as a data URL the app's renderer
 * can actually draw.
 *
 * The extension hands back what `chrome.runtime.getURL` gave it, a
 * `chrome-extension://` address, and that address is unloadable where the app
 * draws: the renderer runs in a different session that has no such extension
 * loaded, and an action icon is not a web-accessible resource in the first place
 * (Bitwarden declares two icons as accessible and none of its state icons).
 * Measured, with the address an extension really records: `{ok: false}` in the
 * app's own renderer, and the same icon inlined `{ok: true, w: 19}`. So the
 * bytes are read from the extension's own folder and carried as a data URL.
 *
 * Null means "nothing the app can draw", which a caller reads as "use the
 * extension's manifest icon" rather than as a failure. That is the case for
 * every reason this can miss: an address of another extension's file, a path
 * that leaves the extension's folder, a format with no image MIME type, a file
 * over the size bound, and a file that is simply not there.
 */
export async function readActionIconDataUrl(
  extensionDir: string,
  extensionId: string,
  iconUrl: unknown,
  cache?: Map<string, string | null>
): Promise<string | null> {
  if (typeof iconUrl !== 'string' || !iconUrl) return null
  const relative = actionIconRelativePath(iconUrl, extensionId)
  if (!relative) return null
  const mime = ICON_MIME_TYPES[extname(relative).toLowerCase()]
  if (!mime) return null
  const absolute = join(extensionDir, relative)
  if (!isInside(extensionDir, absolute)) return null
  const cached = cache?.get(absolute)
  if (cached !== undefined) return cached
  let value: string | null = null
  try {
    const bytes = await readFile(absolute)
    if (bytes.byteLength > 0 && bytes.byteLength <= MAX_ICON_BYTES) {
      value = `data:${mime};base64,${bytes.toString('base64')}`
    }
  } catch {
    // A recorded icon whose file is gone is not an error worth reporting: the
    // pin falls back to the extension's manifest icon.
  }
  if (cache) {
    // A crude bound rather than an LRU: this holds a handful of small images and
    // an extension swapping between two icons is the case that matters.
    if (cache.size >= MAX_ACTION_ICON_CACHE) cache.clear()
    cache.set(absolute, value)
  }
  return value
}

/** The extension-root-relative path inside a recorded icon address, or null when
 *  the address is not one of this extension's own files.
 *
 * A `chrome-extension://` address carries the extension's id as its host, and a
 * resource belonging to another extension is not this one's to inline. */
function actionIconRelativePath(iconUrl: string, extensionId: string): string | null {
  const scheme = 'chrome-extension://'
  let rest: string
  if (iconUrl.startsWith(scheme)) {
    const afterScheme = iconUrl.slice(scheme.length)
    const slash = afterScheme.indexOf('/')
    if (slash < 0) return null
    if (afterScheme.slice(0, slash) !== extensionId) return null
    rest = afterScheme.slice(slash + 1)
  } else if (iconUrl.startsWith('/') || !iconUrl.includes('://')) {
    // A root-relative or bare path, which `setIcon` also accepts and which the
    // extension's own `getURL` would have resolved before recording it.
    rest = iconUrl.replace(/^\/+/, '')
  } else {
    return null
  }
  const cut = rest.search(/[?#]/)
  if (cut >= 0) rest = rest.slice(0, cut)
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return null
  }
  return decoded || null
}

/** A fresh RSA key, as the base64 SPKI a manifest `key` expects.
 *
 *  A folder install has no publisher key of its own, and without one its id would
 *  be a hash of wherever the app unpacked it. Generating one gives it an id of its
 *  own that survives being uninstalled and installed again. */
export function generateExtensionKey(): string {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  return publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
}

/** Write a manifest back, with a trailing newline so the file stays hand-readable. */
export async function writeManifest(extensionDir: string, manifest: unknown): Promise<void> {
  await writeFile(
    join(extensionDir, EXTENSION_MANIFEST_NAME),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

/** The manifest as a mutable record, for the installer to pin a key and repoint
 *  the background entry into. */
export async function readManifestObject(extensionDir: string): Promise<Record<string, unknown>> {
  return asRecord(await readJsonFile(join(extensionDir, EXTENSION_MANIFEST_NAME)))
}

/**
 * A fingerprint of the extension's own files: every path and its content hash,
 * with everything Chromium generates inside the folder left out.
 */
export async function hashExtensionDirectory(extensionDir: string): Promise<string> {
  const files: { relativePath: string; contents: Buffer }[] = []
  async function walk(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === GENERATED_DIRECTORY_NAME) continue
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute, relative)
        continue
      }
      if (!entry.isFile()) continue
      files.push({ relativePath: relative, contents: await readFile(absolute) })
    }
  }
  await walk(extensionDir, '')
  const digest = createHash('sha256')
  files.sort((left, right) => (left.relativePath < right.relativePath ? -1 : 1))
  for (const file of files) {
    digest.update(file.relativePath)
    digest.update('\0')
    digest.update(createHash('sha256').update(file.contents).digest())
    digest.update('\n')
  }
  return digest.digest('hex')
}

/** Summarise a prepared source tree for the registry. */
export function summariseExtensionSource(record: ManifestRecord): ExtensionSourceSummary {
  return {
    id: extensionIdFromManifestKey(record.key),
    name: record.name,
    version: record.version,
    description: record.description,
    popupPath: record.popupPath,
    declaredPermissions: record.declaredPermissions,
    ruleResources: record.ruleResources,
    manifestVersion: record.manifestVersion
  }
}

/** What this extension declared that the runtime cannot provide. */
export function missingCapabilitiesFor(summary: ExtensionSourceSummary): string[] {
  return [...missingExtensionCapabilities(summary.declaredPermissions)]
}
