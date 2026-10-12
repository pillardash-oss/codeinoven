/**
 * Finding and validating the native messaging host an extension asked for.
 *
 * Electron implements `chrome.runtime.connectNative` and `sendNativeMessage` as
 * functions but refuses every host   a real name and a bogus name both disconnect
 * with "Access to the native messaging host was disabled by the system
 * administrator." (measured, see `.cio/tmp/nm-probe`). Nothing in the runtime looks
 * for a host manifest at all, so the app has to do what Chromium would have done:
 * find the manifest, check that it admits this extension, and then hand the host
 * process to `browser-native-host-process.ts`.
 *
 * The lookup follows Chromium's: a directory per browser product on macOS and
 * Linux, the registry on Windows, and this app's own user-data directory first so
 * the app's own installs win. On macOS and Linux the file is `<name>.json` inside
 * the directory; the manifest's `allowed_origins` is the gate that stops one
 * extension from driving a host installed for another.
 *
 * The pure halves   the directory list, the name rule, the manifest parser and the
 * origin check   are exported separately so they can be tested without a
 * filesystem or a running app.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

/** The longest host name Chromium will look up, kept so a hostile name cannot be
 *  turned into a long path hop. */
const MAX_HOST_NAME_LENGTH = 256

/** Chromium's own rule for a host name, minus the requirement that it is lower
 *  case: a manifest the user installed may name its host either way. */
const HOST_NAME = /^[A-Za-z0-9_.]+$/u

/** The one supported host shape. Anything else is a manifest this app cannot run. */
const STDIO_HOST_TYPE = 'stdio'

export interface NativeHostManifest {
  name: string
  /** Absolute path to the executable to spawn. */
  path: string
  allowedOrigins: string[]
  /** Where the manifest was read from, for the app's own diagnostics. */
  manifestPath: string
}

export type NativeHostLookupFailure =
  'invalid-name' | 'not-found' | 'invalid-manifest' | 'type-unsupported' | 'origin-not-allowed'

export type NativeHostLookupResult =
  | { found: true; host: NativeHostManifest }
  | { found: false; reason: NativeHostLookupFailure; searched: string[] }

export interface NativeHostLookupOptions {
  platform: NodeJS.Platform
  /** Home directory; injected so the pure list is testable. */
  home: string
  /** This app's own user-data directory. */
  userData: string
}

/** Whether a name is one Chromium would look up rather than reject outright. */
export function nativeHostNameIsValid(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= MAX_HOST_NAME_LENGTH &&
    HOST_NAME.test(name) === true &&
    name.startsWith('.') === false &&
    name.endsWith('.') === false &&
    name.includes('..') === false
  )
}

/**
 * The directories a host manifest is looked for in, most specific first.
 *
 * The app's own directory is tried before any browser's so an install made for
 * this app wins over one a user's Chrome happens to carry. The browser product
 * directories are Chromium's list extended with the Chromium-family browsers a
 * user is likely to have (Brave, Edge, Vivaldi, Helium, Zen), because Bitwarden's
 * desktop app writes its manifest for the browsers it can see and the app should
 * find the same host whichever of them the user has.
 */
export function nativeHostSearchDirectories(options: NativeHostLookupOptions): string[] {
  const { platform, home, userData } = options
  const dirs: string[] = [join(userData, 'NativeMessagingHosts')]
  if (platform === 'darwin') {
    const applicationSupport = join(home, 'Library', 'Application Support')
    for (const product of [
      join('Google', 'Chrome'),
      join('Google', 'Chrome Beta'),
      join('Google', 'Chrome Dev'),
      join('Google', 'Chrome Canary'),
      'Chromium',
      join('BraveSoftware', 'Brave-Browser'),
      'Microsoft Edge',
      'Vivaldi',
      'net.imput.helium',
      'zen'
    ]) {
      dirs.push(join(applicationSupport, product, 'NativeMessagingHosts'))
    }
    // System-wide installs, which Chromium reads after the per-user ones.
    for (const product of [join('Google', 'Chrome'), 'Chromium']) {
      dirs.push(join('/Library', 'Application Support', product, 'NativeMessagingHosts'))
    }
    return dirs
  }
  if (platform === 'win32') {
    // Windows has no per-product directory: the manifest's location comes from the
    // registry, and only the app's own directory is searched directly.
    return dirs
  }
  // Linux and everything else Chromium treats the same way.
  const config = join(home, '.config')
  for (const product of [
    'google-chrome',
    'chromium',
    'google-chrome-beta',
    'google-chrome-unstable',
    'BraveSoftware/Brave-Browser',
    'microsoft-edge',
    'vivaldi'
  ]) {
    dirs.push(join(config, product, 'NativeMessagingHosts'))
  }
  dirs.push('/etc/opt/chrome/native-messaging-hosts')
  dirs.push('/etc/chromium/native-messaging-hosts')
  return dirs
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Read one manifest object. Answers null for anything this app cannot run, rather
 * than a partially-filled record a caller might trust.
 *
 * `expectedName` is which host was asked for: a manifest whose own `name` differs
 * is not the manifest for that request, which is Chromium's rule too.
 */
export function parseNativeHostManifest(
  raw: unknown,
  expectedName: string,
  manifestPath: string
): NativeHostManifest | { failure: 'invalid-manifest' | 'type-unsupported' } {
  const record = asRecord(raw)
  if (!record) return { failure: 'invalid-manifest' }
  const declaredName = record['name']
  if (typeof declaredName !== 'string' || declaredName !== expectedName) {
    return { failure: 'invalid-manifest' }
  }
  const type = record['type']
  if (typeof type === 'string' && type !== STDIO_HOST_TYPE) {
    return { failure: 'type-unsupported' }
  }
  const declaredPath = record['path']
  if (typeof declaredPath !== 'string' || declaredPath.length === 0) {
    return { failure: 'invalid-manifest' }
  }
  // A relative path is resolved against the manifest's own directory, which is the
  // only interpretation that stays inside what the manifest's installer chose.
  const hostPath = isAbsolute(declaredPath)
    ? declaredPath
    : resolve(dirname(manifestPath), declaredPath)
  const rawOrigins = record['allowed_origins']
  if (Array.isArray(rawOrigins) === false) return { failure: 'invalid-manifest' }
  const allowedOrigins = rawOrigins.filter(
    (origin): origin is string => typeof origin === 'string' && origin.length > 0
  )
  if (allowedOrigins.length === 0) return { failure: 'invalid-manifest' }
  return { name: declaredName, path: hostPath, allowedOrigins, manifestPath }
}

/**
 * Whether an extension origin is admitted by a manifest's list.
 *
 * Chromium admits an exact origin, and also the wildcard form (an extension
 * origin whose id is a star) that a manifest may use to admit any extension. A
 * trailing slash is optional on both sides because manifests in the wild are
 * inconsistent about it.
 */
export function originMatchesAllowedOrigins(
  origin: string,
  allowedOrigins: readonly string[]
): boolean {
  const normalised = origin.endsWith('/') ? origin : `${origin}/`
  for (const allowed of allowedOrigins) {
    const candidate = allowed.endsWith('/') ? allowed : `${allowed}/`
    if (candidate === normalised) return true
    if (candidate === 'chrome-extension://*/' && normalised.startsWith('chrome-extension://')) {
      return true
    }
  }
  return false
}

function isManifest(value: NativeHostManifest | { failure: string }): value is NativeHostManifest {
  return 'name' in value
}

/** Registry roots Windows may hold a host manifest path under, most specific
 *  first. Each is a registry key name with the host name appended. */
export function nativeHostRegistryKeys(name: string, platform: NodeJS.Platform): string[] {
  if (platform !== 'win32') return []
  const products = [
    'Google\\Chrome',
    'Google\\Chrome Beta',
    'Google\\Chrome Dev',
    'Google\\Chrome SxS',
    'Chromium',
    'BraveSoftware\\Brave-Browser',
    'Microsoft\\Edge',
    'Vivaldi'
  ]
  const keys: string[] = []
  for (const product of products) {
    keys.push(`HKCU\\Software\\${product}\\NativeMessagingHosts\\${name}`)
    keys.push(`HKLM\\Software\\${product}\\NativeMessagingHosts\\${name}`)
  }
  return keys
}

function queryWindowsRegistryValue(key: string): Promise<string | null> {
  return new Promise((resolveValue) => {
    execFile('reg.exe', ['query', key, '/ve'], { windowsHide: true }, (error, stdout) => {
      if (error || typeof stdout !== 'string') {
        resolveValue(null)
        return
      }
      // `(Default)    REG_SZ    C:\path\to\host.json`
      for (const line of stdout.split(/\r?\n/u)) {
        const match = /^\s*(?:\(Default\)|<Default>)\s+REG_SZ\s+(.+?)\s*$/iu.exec(line)
        if (match?.[1]) {
          resolveValue(match[1])
          return
        }
      }
      resolveValue(null)
    })
  })
}

/**
 * Ask every place a manifest could live for `name`, and answer the first one whose
 * `allowed_origins` admits `origin`.
 *
 * A manifest that exists but belongs to the wrong name, has no path, or does not
 * admit this extension is not a reason to accept a later, weaker one: the search
 * stops at the first manifest for this host name and either admits the extension or
 * reports why not, which is what makes "the host is there but not for me" a fact
 * the app can tell the user instead of a silent disconnect.
 */
export async function resolveNativeHostManifest(
  name: string,
  origin: string,
  options: NativeHostLookupOptions
): Promise<NativeHostLookupResult> {
  const searched = nativeHostSearchDirectories(options)
  if (nativeHostNameIsValid(name) === false) {
    return { found: false, reason: 'invalid-name', searched }
  }

  const candidatePaths: string[] = searched.map((directory) => join(directory, `${name}.json`))
  for (const key of nativeHostRegistryKeys(name, options.platform)) {
    const manifestPath = await queryWindowsRegistryValue(key)
    if (manifestPath) candidatePaths.push(manifestPath)
  }

  let sawManifest = false
  let failure: NativeHostLookupFailure = 'not-found'
  for (const manifestPath of candidatePaths) {
    const contents = await readFile(manifestPath, 'utf8').catch(() => null)
    if (contents === null) continue
    let raw: unknown
    try {
      raw = JSON.parse(contents)
    } catch {
      sawManifest = true
      failure = 'invalid-manifest'
      continue
    }
    const parsed = parseNativeHostManifest(raw, name, manifestPath)
    if (isManifest(parsed) === false) {
      sawManifest = true
      failure = parsed.failure
      continue
    }
    sawManifest = true
    if (originMatchesAllowedOrigins(origin, parsed.allowedOrigins) === false) {
      failure = 'origin-not-allowed'
      continue
    }
    return { found: true, host: parsed }
  }

  return { found: false, reason: sawManifest ? failure : 'not-found', searched }
}
