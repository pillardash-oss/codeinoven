/**
 * The durable record of which extensions are installed, and which jars each one
 * runs in.
 *
 * It is a file rather than renderer state because the main process is what loads
 * an extension into a session: the renderer could be reloaded, asleep, or not have
 * opened the browser at all, and a box that opens a tab still has to get the
 * extensions the user enabled for it. The renderer reads this list; it never owns
 * it.
 *
 * The file is shared state between app instances, the same way the permission
 * memory is, so a write replaces it whole but only ever with what was loaded plus
 * this instance's change: a corrupt or truncated entry is dropped rather than
 * trusted, because everything in here names a folder the app will load code from.
 *
 * The source folder is never taken from the file. It is derived from the id, so a
 * tampered registry cannot point an extension at a directory of its choosing.
 */

import { isExtensionId } from './browser-extension-crx'
import type {
  BrowserExtension,
  BrowserExtensionInjection,
  BrowserExtensionSource
} from '../../../lib/ipc/browser'

/** Where the registry lives, relative to the config root. */
export const BROWSER_EXTENSION_REGISTRY_FILE = 'browser/extensions.json'

/** Where every extension's own folder lives, relative to the config root. One
 *  directory per extension id, each holding the `source` tree the app loads. */
export const BROWSER_EXTENSION_STORE_DIR = 'browser/extensions'

/** The subdirectory of the store that holds a prepared source tree. */
export const BROWSER_EXTENSION_SOURCE_DIR = 'source'

/** Bumped only if the stored shape changes incompatibly. */
export const BROWSER_EXTENSION_REGISTRY_VERSION = 1

/** A cap on installed extensions. Each one costs a renderer in every jar that
 *  loads it, so the list is bounded rather than unbounded. */
export const MAX_BROWSER_EXTENSIONS = 40

/** How many jars one extension may name. */
const MAX_JARS_PER_EXTENSION = 200

/**
 * The largest icon that is kept in the registry.
 *
 * The list is one JSON document, so an icon lives in it as a data URL. Real
 * manifest icons are a few kilobytes; a package declaring a megabyte "icon" would
 * otherwise put forty megabytes in a file every write rewrites.
 */
const MAX_ICON_DATA_URL_LENGTH = 64 * 1024

const MAX_NAME_LENGTH = 200
const MAX_VERSION_LENGTH = 40
const MAX_DESCRIPTION_LENGTH = 500
const MAX_POPUP_PATH_LENGTH = 2_048
const MAX_PERMISSION_LENGTH = 80
const MAX_PERMISSIONS = 200
const MAX_RULE_RESOURCES = 500
const MAX_RULESET_ID_LENGTH = 120
const MAX_CAPABILITIES = 80
const MAX_WARNINGS = 40
const MAX_WARNING_LENGTH = 400
const MAX_JAR_ID_LENGTH = 260

/** Every load-failure warning starts with this, so a successful load can clear
 *  exactly the warnings it is the answer to and leave the install-time ones alone. */
const LOAD_WARNING_PREFIX = 'It could not be loaded'

const SOURCES: readonly BrowserExtensionSource[] = ['webstore', 'folder']
const INJECTIONS: readonly BrowserExtensionInjection[] = [
  'module-bootstrap',
  'prepend-classic',
  'prepend-mv2',
  'none'
]

/** One installed extension, exactly as it is stored. */
export interface BrowserExtensionRecord {
  id: string
  name: string
  version: string
  description: string
  source: BrowserExtensionSource
  /** The Web Store id it was fetched by, or null for a folder install. */
  webstoreId: string | null
  popupPath: string | null
  /** Whether the user pinned it into the browser view's header. A pin is bounded
   *  and needs a popup to open, which is what the service enforces before it is
   *  written. */
  pinned: boolean
  iconDataUrl: string | null
  declaredPermissions: string[]
  ruleResources: { id: string; enabled: boolean }[]
  manifestVersion: number
  /** What it declared that this runtime cannot provide. */
  missingCapabilities: string[]
  /** Anything that went wrong without being fatal. */
  warnings: string[]
  injected: BrowserExtensionInjection
  /** Fingerprint of the source tree, so an update that changed the files is
   *  detectable and the injection is re-applied. */
  sourceHash: string
  /** Whether it is loaded into any jar at all. */
  enabled: boolean
  /**
   * The jars it runs in: box ids, with the empty string for the context's own jar.
   * Empty means installed and loaded nowhere, which is where an install starts.
   */
  boxes: string[]
  installedAt: number
}

/** Minimal persistence surface this store needs; a `StorageEngine` satisfies it
 *  structurally. Paths are relative to the app config root. */
export interface BrowserExtensionRegistryPersistence {
  read<T>(relativePath: string): Promise<T | null>
  write(relativePath: string, data: unknown): Promise<void>
}

interface PersistedRegistry {
  version?: number
  extensions?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.replaceAll('\0', '').trim()
  if (trimmed.length === 0) return fallback
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function optionalBoundedString(value: unknown, maxLength: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.replaceAll('\0', '').trim()
  if (trimmed.length === 0) return null
  return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed
}

function boundedStringList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    const trimmed = candidate.replaceAll('\0', '').trim()
    if (trimmed.length === 0 || trimmed.length > maxLength) continue
    if (out.includes(trimmed)) continue
    out.push(trimmed)
    if (out.length >= maxItems) break
  }
  return out
}

/**
 * The jars an extension names, or null for "every jar".
 *
 * A box id is accepted by shape only: the registry does not know which boxes
 * exist, and it must not, because a box can be deleted in the renderer while the
 * registry is being written. A jar that no longer exists simply matches nothing.
 */
function parseJars(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const jars: string[] = []
  for (const candidate of value) {
    if (typeof candidate !== 'string') continue
    // The empty string is the context's own jar, which has no box id.
    if (candidate.length === 0) {
      if (!jars.includes('')) jars.push('')
    } else if (candidate.length <= MAX_JAR_ID_LENGTH && !candidate.includes('\0')) {
      if (!jars.includes(candidate)) jars.push(candidate)
    }
    if (jars.length >= MAX_JARS_PER_EXTENSION) break
  }
  return jars
}

function parseRuleResources(value: unknown): { id: string; enabled: boolean }[] {
  if (!Array.isArray(value)) return []
  const out: { id: string; enabled: boolean }[] = []
  for (const candidate of value) {
    if (!isRecord(candidate)) continue
    const id = boundedString(candidate['id'], MAX_RULESET_ID_LENGTH, '')
    if (!id) continue
    out.push({ id, enabled: candidate['enabled'] === true })
    if (out.length >= MAX_RULE_RESOURCES) break
  }
  return out
}

function parseRecord(value: unknown): BrowserExtensionRecord | null {
  if (!isRecord(value)) return null
  const id = value['id']
  // An id is the folder name and the key sessions load under, so a record without
  // a well-formed one cannot be honoured: repairing it would load code from a
  // different folder than the user installed.
  if (!isExtensionId(id)) return null
  const source = SOURCES.find((candidate) => candidate === value['source'])
  if (!source) return null
  const injected = INJECTIONS.find((candidate) => candidate === value['injected']) ?? 'none'
  const manifestVersion = value['manifestVersion'] === 2 ? 2 : 3
  const installedAt =
    typeof value['installedAt'] === 'number' && Number.isFinite(value['installedAt'])
      ? Math.max(0, Math.trunc(value['installedAt']))
      : Date.now()
  const iconDataUrl = optionalBoundedString(value['iconDataUrl'], MAX_ICON_DATA_URL_LENGTH)
  return {
    id,
    name: boundedString(value['name'], MAX_NAME_LENGTH, id),
    version: boundedString(value['version'], MAX_VERSION_LENGTH, '0'),
    description: boundedString(value['description'], MAX_DESCRIPTION_LENGTH, ''),
    source,
    webstoreId: isExtensionId(value['webstoreId']) ? value['webstoreId'] : null,
    popupPath: optionalBoundedString(value['popupPath'], MAX_POPUP_PATH_LENGTH),
    pinned: value['pinned'] === true,
    iconDataUrl: iconDataUrl && iconDataUrl.startsWith('data:image/') ? iconDataUrl : null,
    declaredPermissions: boundedStringList(
      value['declaredPermissions'],
      MAX_PERMISSIONS,
      MAX_PERMISSION_LENGTH
    ),
    ruleResources: parseRuleResources(value['ruleResources']),
    manifestVersion,
    missingCapabilities: boundedStringList(
      value['missingCapabilities'],
      MAX_CAPABILITIES,
      MAX_PERMISSION_LENGTH
    ),
    warnings: boundedStringList(value['warnings'], MAX_WARNINGS, MAX_WARNING_LENGTH),
    injected,
    sourceHash: boundedString(value['sourceHash'], 128, ''),
    enabled: value['enabled'] !== false,
    boxes: parseJars(value['boxes']),
    installedAt
  }
}

/** The absolute path of one extension's prepared source tree. */
export function extensionSourceDirectory(configRoot: string, id: string): string {
  return `${configRoot}/${BROWSER_EXTENSION_STORE_DIR}/${id}/${BROWSER_EXTENSION_SOURCE_DIR}`
}

/** Whether an extension runs in a jar. The empty id is the context's own jar. */
export function extensionRunsInJar(
  record: Pick<BrowserExtensionRecord, 'boxes'>,
  boxId: string | null
): boolean {
  return record.boxes.includes(boxId ?? '')
}

/** The record as the renderer sees it: no paths, and the runtime warnings it has
 *  collected so far folded in. */
export function toExtensionView(
  record: BrowserExtensionRecord,
  runtimeWarnings: readonly string[],
  updateAvailableVersion: string | null = null
): BrowserExtension {
  const warnings = [...record.warnings]
  for (const warning of runtimeWarnings) {
    if (!warnings.includes(warning)) warnings.push(warning)
  }
  return {
    id: record.id,
    name: record.name,
    version: record.version,
    description: record.description,
    source: record.source,
    webstoreId: record.webstoreId,
    updateAvailableVersion,
    iconDataUrl: record.iconDataUrl,
    enabled: record.enabled,
    boxes: record.boxes,
    popupPath: record.popupPath,
    pinned: record.pinned,
    missingCapabilities: [...record.missingCapabilities],
    warnings,
    injected: record.injected,
    installedAt: record.installedAt
  }
}

export class BrowserExtensionRegistry {
  private readonly records = new Map<string, BrowserExtensionRecord>()
  /** Serializes writes so a slower earlier snapshot can never land after a newer
   *  one and drop an extension the user just installed. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly persistence: BrowserExtensionRegistryPersistence) {}

  async load(): Promise<void> {
    let stored: unknown
    try {
      stored = await this.persistence.read<unknown>(BROWSER_EXTENSION_REGISTRY_FILE)
    } catch {
      // A registry that cannot be read is treated as empty rather than fatal: the
      // app still starts, and the user can reinstall. Nothing is written until a
      // change is made, so a corrupt file is not clobbered by a mere read.
      stored = null
    }
    this.records.clear()
    const container = isRecord(stored) ? (stored as PersistedRegistry) : null
    const entries = container?.extensions
    if (!Array.isArray(entries)) return
    for (const entry of entries) {
      const record = parseRecord(entry)
      if (!record) continue
      if (this.records.has(record.id)) continue
      this.records.set(record.id, record)
      if (this.records.size >= MAX_BROWSER_EXTENSIONS) break
    }
  }

  list(): BrowserExtensionRecord[] {
    return [...this.records.values()].sort((left, right) => left.installedAt - right.installedAt)
  }

  get(id: string): BrowserExtensionRecord | null {
    return this.records.get(id) ?? null
  }

  async upsert(record: BrowserExtensionRecord): Promise<void> {
    this.records.set(record.id, record)
    this.trimToCap()
    await this.persist()
  }

  async remove(id: string): Promise<void> {
    if (!this.records.delete(id)) return
    await this.persist()
  }

  async patch(
    id: string,
    patch: {
      enabled?: boolean
      boxes?: string[]
      pinned?: boolean
      /** Recomputed when the app's own surface changes, which is why it is
       *  patchable: a namespace the preamble learns to implement is a capability
       *  an installed extension gets back without being reinstalled. */
      missingCapabilities?: string[]
    }
  ): Promise<BrowserExtensionRecord | null> {
    const record = this.records.get(id)
    if (!record) return null
    if (patch.enabled !== undefined) record.enabled = patch.enabled
    if (patch.boxes !== undefined) record.boxes = parseJars(patch.boxes)
    if (patch.pinned !== undefined) record.pinned = patch.pinned
    if (patch.missingCapabilities !== undefined) {
      record.missingCapabilities = [...patch.missingCapabilities]
    }
    await this.persist()
    return record
  }

  /** Add a warning to a record, without writing if it is already there. Returns
   *  whether anything changed. */
  async warn(id: string, warning: string): Promise<boolean> {
    const record = this.records.get(id)
    if (!record) return false
    if (record.warnings.includes(warning)) return false
    record.warnings.push(warning)
    if (record.warnings.length > MAX_WARNINGS) record.warnings.shift()
    await this.persist()
    return true
  }

  /**
   * Replace the record's "could not be loaded" warning, or clear it.
   *
   * A load can fail for a reason that fixes itself (the source was being rewritten
   * by an update) or for one that does not (the runtime lacks the API the extension
   * needs). Keeping exactly one such warning and clearing it when a load succeeds
   * is what stops a transient failure from marking an extension broken forever.
   */
  async setLoadWarning(id: string, warning: string | null): Promise<boolean> {
    const record = this.records.get(id)
    if (!record) return false
    const kept = record.warnings.filter((entry) => !entry.startsWith(LOAD_WARNING_PREFIX))
    const next = warning ? [...kept, warning] : kept
    if (next.length === record.warnings.length && next.every((v, i) => v === record.warnings[i])) {
      return false
    }
    record.warnings = next
    await this.persist()
    return true
  }

  /** Forget one box from every extension's jar list. A deleted box cannot be
   *  restored by a re-created id, so leaving it named here would be a jar that
   *  never exists again. Returns whether anything changed. */
  async forgetBox(boxId: string): Promise<boolean> {
    let changed = false
    for (const record of this.records.values()) {
      const next = record.boxes.filter((jar) => jar !== boxId)
      if (next.length === record.boxes.length) continue
      record.boxes = next
      changed = true
    }
    if (changed) await this.persist()
    return changed
  }

  private trimToCap(): void {
    const list = this.list()
    if (list.length <= MAX_BROWSER_EXTENSIONS) return
    for (const record of list.slice(0, list.length - MAX_BROWSER_EXTENSIONS)) {
      this.records.delete(record.id)
    }
  }

  private persist(): Promise<void> {
    const payload = {
      version: BROWSER_EXTENSION_REGISTRY_VERSION,
      updatedAt: new Date().toISOString(),
      extensions: this.list()
    }
    this.writeChain = this.writeChain
      .then(() => this.persistence.write(BROWSER_EXTENSION_REGISTRY_FILE, payload))
      .catch(() => undefined)
    return this.writeChain
  }
}
