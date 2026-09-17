import { fileURLToPath } from 'url'
import { realpath } from 'fs/promises'
import { isAbsolute, relative, resolve, sep } from 'path'
import type { WebFrameMain } from 'electron'
import type { GitHubAvatarRequest } from '../../../lib/types'
import { isLocalDevelopmentUrl } from '../../../lib/local-development-url'
import { Logger } from '../../system/logger'

const HOSTNAME_PATTERN =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\d{1,5})?$/iu

/**
 * Bracketed IPv6 literal such as `[::1]` or `[fe80::1]:5173`. The character set
 * excludes scheme, path, credential, and control characters, so a match can only
 * ever be used as the authority of an internal favicon fetch URL.
 */
const IPV6_HOST_PATTERN = /^\[[0-9a-f:.]+:[0-9a-f:.]*\](?::\d{1,5})?$/iu

/** Max entries the renderer may ask for in a single favicon resolution call. */
const MAX_FAVICON_HOSTNAMES = 64

/** Absolute upper bound of a host entry, including brackets and an optional port. */
const MAX_FAVICON_HOSTNAME_LENGTH = 253 + 6 + 8

/**
 * Whether a host entry's trailing `:port`, when present, is a real port. Bracketed
 * IPv6 literals are handled first because their inner colons are not separators.
 */
function isValidPortSuffix(value: string): boolean {
  const bracketEnd = value.startsWith('[') ? value.indexOf(']') : -1
  const portIndex = value.lastIndexOf(':')
  // `[::1]` and `[fe80::1]` carry no port; their colons live inside the brackets.
  if (portIndex === -1 || (bracketEnd !== -1 && portIndex < bracketEnd)) return true
  const port = Number(value.slice(portIndex + 1))
  return Number.isInteger(port) && port >= 1 && port <= 65_535
}

/** Whether an entry is a hostname-shaped string safe to embed in a fetch origin. */
function isFaviconHostname(entry: unknown): entry is string {
  if (typeof entry !== 'string') return false
  if (entry.length === 0 || entry.length > MAX_FAVICON_HOSTNAME_LENGTH) return false
  if (entry.includes('\0') || entry.includes('\n') || entry.includes('\r')) return false
  if (!HOSTNAME_PATTERN.test(entry) && !IPV6_HOST_PATTERN.test(entry)) return false
  return isValidPortSuffix(entry)
}

/**
 * Validate a list of hostnames used for favicon resolution. Each entry must be
 * a bounded, hostname-shaped string with no scheme, path, or control
 * characters. An optional trailing `:port` (1–65535) is allowed so localhost
 * development servers resolve against their real port, and bracketed IPv6
 * literals such as `[::1]:5173` are accepted for the same reason.
 *
 * Entries are derived from arbitrary link text and browser tab URLs, so a single
 * host the URL parser emitted but this app cannot fetch (an underscore host, for
 * example) must not sink the whole call: malformed entries are skipped and logged
 * at dev level, and the caller receives the valid hostnames, deduplicated in
 * first-occurrence order.
 */
export function validateFaviconHostnames(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('Favicon hostnames must be an array')
  if (value.length === 0 || value.length > MAX_FAVICON_HOSTNAMES) {
    throw new TypeError(
      `Favicon hostnames must contain between 1 and ${MAX_FAVICON_HOSTNAMES} entries`
    )
  }
  const hostnames: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (!isFaviconHostname(entry)) {
      Logger.dev(`Skipping invalid favicon hostname at index ${index}`)
      continue
    }
    const normalized = entry.toLowerCase()
    if (!hostnames.includes(normalized)) hostnames.push(normalized)
  }
  return hostnames
}

/** Matches the renderer store's batch size, so one batch is never truncated. */
const MAX_REMOTE_IMAGE_URLS = 32

/** Longer than any real image URL; the resolver only needs the origin and path. */
const MAX_REMOTE_IMAGE_URL_LENGTH = 2_048

/** How many logins one avatar request may carry, matching the favicon batch cap. */
const MAX_AVATAR_LOGINS = 64
/** A GitHub login is at most 39 characters, and the `[bot]` suffix adds five. */
const MAX_GITHUB_LOGIN_LENGTH = 44
/** Letters, digits and single hyphens, optionally GitHub's `[bot]` app form. */
const GITHUB_LOGIN_PATTERN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}(?:\[bot\])?$/iu

/**
 * Validate the accounts an avatar request carries.
 *
 * Each entry has to be login-shaped, `[bot]` accounts included, so nothing but a
 * GitHub account name can reach the avatar host. The optional declared URL arrives
 * from the provider rather than from user content, but it is still checked before
 * main fetches it: HTTPS only, plus the local-development exception the provider
 * base URL already allows, so a self-hosted or test server can serve a picture.
 * Entries that fail are dropped rather than failing the batch, the way favicon
 * hostnames are, because a provider writes `unknown` for a comment whose user
 * record is missing and that should not cost a request.
 */
export function validateGitHubAvatarRequests(value: unknown): GitHubAvatarRequest[] {
  if (!Array.isArray(value)) throw new TypeError('Avatar accounts must be an array')
  if (value.length === 0 || value.length > MAX_AVATAR_LOGINS) {
    throw new TypeError(`Avatar accounts must contain between 1 and ${MAX_AVATAR_LOGINS} entries`)
  }
  const accounts: GitHubAvatarRequest[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      Logger.dev(`Skipping non-object avatar entry at index ${index}`)
      continue
    }
    const record = entry as Record<string, unknown>
    const login = typeof record['login'] === 'string' ? record['login'].trim() : ''
    if (login.length === 0 || login.length > MAX_GITHUB_LOGIN_LENGTH) {
      Logger.dev(`Skipping invalid avatar login at index ${index}`)
      continue
    }
    if (!GITHUB_LOGIN_PATTERN.test(login)) {
      Logger.dev(`Skipping non-login avatar entry at index ${index}`)
      continue
    }
    accounts.push({ login, avatarUrl: validateDeclaredAvatarUrl(record['avatarUrl'], index) })
  }
  return accounts
}

/** The provider-declared picture URL, or null when absent or not fetchable. */
function validateDeclaredAvatarUrl(value: unknown, index: number): string | null {
  if (typeof value !== 'string') return null
  const candidate = value.trim()
  if (candidate.length === 0) return null
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    Logger.dev(`Skipping malformed avatar URL at index ${index}`)
    return null
  }
  if (url.protocol !== 'https:' && !isLocalDevelopmentUrl(candidate)) {
    Logger.dev(`Skipping non-HTTPS avatar URL at index ${index}`)
    return null
  }
  return url.href
}

/**
 * Validate the image URLs found inside provider-authored markdown.
 *
 * Only `https:` survives. The resolver re-checks this and additionally refuses
 * literal private hosts, because it is the side that actually opens the
 * connection; this pass exists so an obviously unusable URL never reaches the
 * network layer at all. Malformed entries are skipped rather than failing the
 * batch: the list is derived from arbitrary comment text, and one bad URL must
 * not blank out every other picture in the same message.
 */
export function validateRemoteImageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) throw new TypeError('Image URLs must be an array')
  if (value.length === 0 || value.length > MAX_REMOTE_IMAGE_URLS) {
    throw new TypeError(`Image URLs must contain between 1 and ${MAX_REMOTE_IMAGE_URLS} entries`)
  }
  const urls: string[] = []
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index]
    if (
      typeof entry !== 'string' ||
      entry.length === 0 ||
      entry.length > MAX_REMOTE_IMAGE_URL_LENGTH
    ) {
      Logger.dev(`Skipping invalid image URL at index ${index}`)
      continue
    }
    if (!entry.startsWith('https://')) {
      Logger.dev(`Skipping non-HTTPS image URL at index ${index}`)
      continue
    }
    if (!urls.includes(entry)) urls.push(entry)
  }
  return urls
}

// ─── Privileged-IPC validation wrapper ──────────────────────────────────────

const WEB_PROTOCOLS = new Set(['https:', 'http:'])
const MAX_EXTERNAL_URL_LENGTH = 8192
const MAX_SCOPED_PATH_LENGTH = 16_384

/** True when the string contains a control character (C0, DEL). */
function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}

/** Resolve the origin of a URL, or null when it cannot be parsed. */
export function originOfUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    // The URL spec serializes `file:` origins as the literal string "null";
    // normalize them to the scheme so trusted-file origins can be matched.
    return parsed.protocol === 'file:' ? 'file://' : parsed.origin
  } catch {
    return null
  }
}

/** Whether a URL's origin is contained in the trusted set. */
export function isTrustedOrigin(url: string, trustedOrigins: ReadonlySet<string>): boolean {
  const origin = originOfUrl(url)
  return origin !== null && trustedOrigins.has(origin)
}

/** Resolvers for the local-file scopes that reveal/preview operations may target. */
export interface PrivilegedScopeResolvers {
  /** Registered local project root directories, resolved lazily. */
  projectRoots: () => Promise<readonly string[]> | readonly string[]
  /** Concrete app-owned artifact directories (per project) that reveal/preview
   *  may target   never the whole config root, which holds secrets. */
  appArtifactRoots: () => Promise<readonly string[]> | readonly string[]
  /** Exact canonical files previously persisted as user-authored attachments. */
  isApprovedFile?: (canonicalPath: string) => Promise<boolean> | boolean
}

export class ScopedPathError extends TypeError {
  constructor(
    readonly code: 'missing' | 'out_of_scope',
    message: string
  ) {
    super(message)
    this.name = 'ScopedPathError'
  }
}

export function isMissingScopedPathError(error: unknown): boolean {
  return error instanceof ScopedPathError && error.code === 'missing'
}

export interface PrivilegedIpcValidatorOptions {
  /** Exact URLs the app's own renderer document lives at. Privileged IPC and
   *  main-frame navigation are bound to these URLs, not to URL origins alone,
   *  so packaged foreign `file:` documents can never be reached. */
  navigationTargets?: Iterable<string>
  /** Resolvers for the file scopes reveal/preview operations may target. */
  scopes?: PrivilegedScopeResolvers
  /** Retained for compatibility with callers; HTTP external links are supported in all builds. */
  allowDevelopmentHttp?: boolean
}

/** Minimal structural view of a frame for identity checks. */
export interface FrameIdentity {
  url: string
  parent?: FrameIdentity | null
}

/** A frame that can be checked for a trusted main-frame identity. */
export type TrustedFrameCandidate = FrameIdentity | WebFrameMain

/**
 * Shared privileged-IPC validation wrapper. Every renderer-exposed operation
 * that can open the system browser, reveal files, or read local files goes
 * through this single boundary so sender frames, external URLs, and local
 * paths are validated consistently across the main process.
 */
export class PrivilegedIpcValidator {
  readonly #navigationTargets: ReadonlySet<string>
  readonly #scopes: PrivilegedScopeResolvers | undefined
  readonly #userSelectedFiles = new Set<string>()
  readonly #userSelectedRoots = new Set<string>()

  constructor(options: PrivilegedIpcValidatorOptions) {
    this.#navigationTargets = new Set(
      [...(options.navigationTargets ?? [])]
        .map((url) => this.#normalizeUrl(url))
        .filter((url): url is string => url !== null)
    )
    this.#scopes = options.scopes
  }

  /**
   * Whether the IPC sender frame is the app's own trusted main frame. Only the
   * top-level frame (no parent) may invoke privileged IPC, and its document URL
   * must match one of the app's own renderer URLs (query strings ignored, so
   * first-party documents may carry state such as ?theme=)   never a foreign
   * or arbitrary same-origin document.
   */
  isTrustedSenderFrame(frame: TrustedFrameCandidate | null | undefined): boolean {
    if (!frame || typeof frame.url !== 'string' || frame.url.length === 0) return false
    if (frame.parent != null) return false
    return this.#isTrustedRendererUrl(frame.url)
  }

  /** Reject a privileged IPC call whose sender frame is not trusted. */
  assertTrustedSender(
    event: { senderFrame?: TrustedFrameCandidate | null } | null | undefined
  ): void {
    if (!this.isTrustedSenderFrame(event?.senderFrame)) {
      throw new Error('Privileged IPC rejected: sender frame is not trusted')
    }
  }

  /**
   * Validate a URL for `shell.openExternal` / window-open. Parsed web URLs are
   * permitted over either `https:` or `http:`; credentials, control characters,
   * malformed input, and non-web schemes are rejected. Returns the normalized
   * URL.
   */
  validateExternalUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_EXTERNAL_URL_LENGTH) {
      throw new TypeError('External URL must be a string of at most 8192 characters')
    }
    if (containsControlCharacter(value)) {
      throw new TypeError('External URL must not contain control characters')
    }
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new TypeError('External URL is malformed')
    }
    if (!WEB_PROTOCOLS.has(parsed.protocol)) {
      throw new TypeError(`External URL scheme "${parsed.protocol}" is not supported`)
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new TypeError('External URL must not contain credentials')
    }
    return parsed.toString()
  }

  /**
   * Whether the main frame may navigate to the given URL. Only the exact
   * canonical app renderer document is navigable, so arbitrary same-origin or
   * `file:` targets are never reachable.
   */
  isTrustedNavigation(url: string): boolean {
    return this.#isTrustedRendererUrl(url)
  }

  #isTrustedRendererUrl(url: string): boolean {
    const normalized = this.#normalizeUrl(url)
    return normalized !== null && this.#navigationTargets.has(normalized)
  }

  #normalizeUrl(url: string): string | null {
    try {
      const parsed = new URL(url)
      // First-party documents are identified by their path; a query string
      // (e.g. the permission popup's ?theme= hint) must never make a trusted
      // sender untrustworthy. Fragments stay significant (hash routing can
      // change what a document renders).
      parsed.search = ''
      return parsed.href
    } catch {
      return null
    }
  }

  /** Record a file the user explicitly selected through an OS dialog. The
   *  canonical (symlink-resolved) path is what grants preview/reveal, so a
   *  later swap to a symlink can never widen the grant. */
  async registerUserSelectedFile(path: string): Promise<void> {
    const canonical = await this.#canonicalizeIfExists(path)
    if (canonical) this.#userSelectedFiles.add(canonical)
  }

  /** Record a directory the user explicitly selected through an OS dialog. */
  async registerUserSelectedRoot(path: string): Promise<void> {
    const canonical = await this.#canonicalizeIfExists(path)
    if (canonical) this.#userSelectedRoots.add(canonical)
  }

  /**
   * Validate a local path for file preview/reveal. The candidate must be a
   * bounded absolute path (or `file://` URL) free of control characters that,
   * after symlink resolution, lives inside a registered project root, a
   * concrete app-owned artifact root, or a user-selected directory, or exactly
   * matches a user-selected file (by canonical path only). Returns the
   * canonical path.
   */
  async resolveScopedPath(value: unknown): Promise<string> {
    const candidate = this.#decodeCandidatePath(value)
    const canonical = await this.#canonicalize(candidate)
    if (this.#userSelectedFiles.has(canonical)) return canonical
    if (await this.#scopes?.isApprovedFile?.(canonical)) return canonical
    const scopes = await this.#resolveScopes()
    for (const scope of scopes) {
      if (isWithinRoot(scope, canonical)) return canonical
    }
    throw new ScopedPathError(
      'out_of_scope',
      'Path is outside the approved project or user-selected scopes'
    )
  }

  #decodeCandidatePath(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SCOPED_PATH_LENGTH) {
      throw new TypeError('Path must be a string of at most 16384 characters')
    }
    if (containsControlCharacter(value)) {
      throw new TypeError('Path must not contain control characters')
    }
    const decoded = value.startsWith('file://') ? this.#fileUrlToPath(value) : value
    if (!isAbsolute(decoded)) {
      throw new TypeError('Path must be absolute')
    }
    return resolve(decoded)
  }

  #fileUrlToPath(value: string): string {
    try {
      return fileURLToPath(value)
    } catch {
      throw new TypeError('Path is not a valid file URL')
    }
  }

  async #canonicalizeIfExists(path: string): Promise<string | null> {
    try {
      return await realpath(path)
    } catch {
      return null
    }
  }

  async #canonicalize(path: string): Promise<string> {
    try {
      return await realpath(path)
    } catch {
      throw new ScopedPathError('missing', 'Path does not resolve to an existing file or directory')
    }
  }

  async #resolveScopes(): Promise<string[]> {
    if (!this.#scopes) return []
    const [projectRoots, artifactRoots] = await Promise.all([
      this.#scopes.projectRoots(),
      this.#scopes.appArtifactRoots()
    ])
    const candidates = [...projectRoots, ...artifactRoots, ...this.#userSelectedRoots].filter(
      (root) => typeof root === 'string' && root.length > 0
    )
    const resolved: string[] = []
    for (const root of candidates) {
      try {
        resolved.push(await realpath(root))
      } catch {
        // A root that no longer exists can grant no scope.
      }
    }
    return resolved
  }
}

function isWithinRoot(root: string, target: string): boolean {
  const pathFromRoot = relative(root, target)
  return (
    pathFromRoot === '' ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !isAbsolute(pathFromRoot))
  )
}
