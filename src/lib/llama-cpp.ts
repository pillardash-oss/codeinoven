/**
 * Local AI server entries: the shared model behind the Settings page.
 *
 * A row is a server launch the app owns: one model (a local file or folder, or a
 * Hugging Face reference the server downloads itself), a bind address, and any
 * extra flags the user needs. Two engines are launched this way: `llama-server`
 * for GGUF, and `mlx_lm.server` for MLX repositories. Nothing here touches the
 * filesystem or the network, so the renderer can validate a row before it is
 * saved and the main process can validate it again on the way in.
 */

/** Cap on saved server rows, so a hand-edited config cannot grow unbounded. */
export const MAX_LLAMA_CPP_SERVERS = 32

export const LLAMA_CPP_NAME_MAX_LENGTH = 120
export const LLAMA_CPP_HOST_MAX_LENGTH = 255
export const LLAMA_CPP_FLAGS_MAX_LENGTH = 2_000
export const LLAMA_CPP_MODEL_PATH_MAX_LENGTH = 4_096
export const LLAMA_CPP_REFERENCE_MAX_LENGTH = 512

/** Loopback by default: a local model server should not be on the network
 *  unless the user deliberately asks for it. */
export const DEFAULT_LLAMA_CPP_HOST = '127.0.0.1'
/** First port a new row proposes; `nextFreeLlamaCppPort` walks upward from here. */
export const DEFAULT_LLAMA_CPP_PORT = 8080
export const MIN_LLAMA_CPP_PORT = 1
export const MAX_LLAMA_CPP_PORT = 65_535

/**
 * One `llama-server` launch.
 *
 * `modelPath` and `modelReference` are exclusive: exactly one of them names the
 * model, and validation drops a row that names neither or both.
 */
export interface LlamaCppServerEntry {
  id: string
  /** Engine that runs this server. */
  runtime: LocalAiRuntimeId
  name: string
  /** Absolute path of an imported local model: a `.gguf` file, or an MLX folder. */
  modelPath: string
  /** Hugging Face repo, `repo:quant`, or a repository file URL. */
  modelReference: string
  host: string
  port: number
  /** Extra server flags, space separated with optional quoting. */
  extraFlags: string
}

/** What a server gets as its model selector. */
export type LocalAiModelSource =
  { kind: 'local'; path: string } | { kind: 'huggingface'; reference: HuggingFaceModelReference }

/** A parsed Hugging Face reference, always in the shape llama.cpp understands. */
export interface HuggingFaceModelReference {
  /** `owner/name`, e.g. `LiquidAI/LFM2.5-2.6B-GGUF`. */
  repo: string
  /** Quantisation tag, e.g. `Q5_K_M`, passed as `repo:QUANT`. */
  quant?: string
  /** One specific file inside the repository, passed as `--hf-file`. */
  file?: string
}

const HUGGINGFACE_HOSTS = new Set(['huggingface.co', 'www.huggingface.co'])
const REPO_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
/** A quantisation tag is a filename fragment, never a path. */
const QUANT_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const GGUF_FILE = /\.gguf$/iu

/**
 * Parse whatever the user pasted into a Hugging Face reference.
 *
 * Accepted: `owner/repo`, `owner/repo:Q5_K_M`, `owner/repo/q5_k_m`,
 * `owner/repo/file.gguf`, and a full `https://huggingface.co/owner/repo/resolve/main/file.gguf`
 * URL. Anything else answers null instead of being forwarded to llama.cpp.
 */
export function parseHuggingFaceModelReference(value: string): HuggingFaceModelReference | null {
  const raw = value.trim()
  if (raw.length === 0 || raw.length > LLAMA_CPP_REFERENCE_MAX_LENGTH) return null

  if (/^https?:\/\//iu.test(raw)) return parseHuggingFaceUrl(raw)

  const [owner, repoSegment, ...tail] = raw.split('/')
  if (!owner || !repoSegment || !REPO_SEGMENT.test(owner)) return null
  const [repoName, quantSuffix] = splitQuant(repoSegment)
  if (!repoName || !REPO_SEGMENT.test(repoName)) return null
  const repo = `${owner}/${repoName}`

  if (tail.length === 0) return quantSuffix ? { repo, quant: quantSuffix } : { repo }
  // `repo:quant/file` names two different model selectors at once.
  if (tail.length > 1 || quantSuffix) return null
  const last = tail[0]
  if (!last || !QUANT_TAG.test(last)) return null
  if (GGUF_FILE.test(last)) return { repo, file: last }
  // `owner/repo/q5_k_m` is the quantisation llama.cpp should fetch.
  return { repo, quant: last }
}

function splitQuant(segment: string): [string, string | undefined] {
  const colon = segment.indexOf(':')
  if (colon === -1) return [segment, undefined]
  const repo = segment.slice(0, colon)
  const quant = segment.slice(colon + 1)
  if (!QUANT_TAG.test(quant)) return ['', undefined]
  return [repo, quant]
}

function parseHuggingFaceUrl(raw: string): HuggingFaceModelReference | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  const host = url.hostname.toLowerCase()
  if (!HUGGINGFACE_HOSTS.has(host) && !host.endsWith('.huggingface.co')) return null
  const segments = url.pathname.split('/').filter((segment) => segment.length > 0)
  if (segments.length < 2) return null
  const [owner, repoName] = segments
  if (!REPO_SEGMENT.test(owner) || !REPO_SEGMENT.test(repoName)) return null
  const repo = `${owner}/${repoName}`
  // `/resolve/<revision>/<file>` names one file; `/tree/…`, `/blob/…` and the
  // repository root all describe the model as a whole.
  const fileIndex = segments.findIndex((segment) => segment === 'resolve')
  const file = fileIndex >= 0 ? segments.slice(fileIndex + 2).join('/') : ''
  if (file.length === 0) return { repo }
  if (file.includes('/') || !GGUF_FILE.test(file) || !QUANT_TAG.test(file)) return null
  return { repo, file }
}

/** Render a parsed reference the way the editor shows it back to the user. */
export function formatHuggingFaceModelReference(reference: HuggingFaceModelReference): string {
  const base = reference.quant ? `${reference.repo}:${reference.quant}` : reference.repo
  return reference.file ? `${base}/${reference.file}` : base
}

/** Which model a row launches, or null when the row names none validly. */
export function localAiModelSource(entry: LlamaCppServerEntry): LocalAiModelSource | null {
  const path = entry.modelPath.trim()
  const reference = entry.modelReference.trim()
  if (path.length > 0 && reference.length === 0) return { kind: 'local', path }
  if (reference.length > 0 && path.length === 0) {
    const parsed = parseHuggingFaceModelReference(reference)
    return parsed ? { kind: 'huggingface', reference: parsed } : null
  }
  return null
}

/** A short human label for the model, for the card and the log header. */
export function localAiModelLabel(entry: LlamaCppServerEntry): string {
  const source = localAiModelSource(entry)
  if (!source) return 'No model'
  if (source.kind === 'local') {
    // A row rewritten to the folder its download landed in keeps naming the
    // repository: the snapshot's own folder is a commit hash, which says nothing.
    const repo = huggingFaceRepoForCachePath(source.path)
    if (repo.length > 0) return repo
    const segments = source.path.split(/[\\/]/u)
    return segments[segments.length - 1] || source.path
  }
  const { repo, quant, file } = source.reference
  if (file) return file
  return quant ? `${repo} · ${quant}` : repo
}

/** Split an extra-flags string into argv tokens, honouring single and double quotes. */
export function tokenizeLlamaCppFlags(value: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false
  for (const character of value) {
    if (quote) {
      if (character === quote) quote = null
      else current += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      hasToken = true
      continue
    }
    if (/\s/u.test(character)) {
      if (hasToken) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += character
    hasToken = true
  }
  if (hasToken) tokens.push(current)
  return tokens
}

/**
 * The model id llama-server advertises in `/v1/models`, and the id a custom
 * provider must store to be selectable as `provider/model`.
 *
 * Without an alias llama.cpp names the model after the absolute `-m` path, so a
 * provider saved from that list carries an id no selection can address, and the
 * same model is called one thing on the card and another in the picker. The
 * alias is the label the app already shows, reduced to characters a model id can
 * hold.
 */
export function llamaCppModelAlias(entry: LlamaCppServerEntry): string {
  const label = localAiModelLabel(entry)
  const alias = label
    .replace(/[^A-Za-z0-9._-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 96)
  return alias || 'llama.cpp'
}

/**
 * The id to record for a model an OpenAI-compatible endpoint reports.
 *
 * llama.cpp answers `/v1/models` with the absolute `.gguf` path it was started
 * with. That path is not a model id: a selection is written as
 * `provider/model`, so it would carry the user's home directory into every
 * request. A GGUF path is reduced to its file name; every other id is kept as
 * served, since `org/model` and `org/model@q4` are real ids elsewhere.
 */
export function llamaCppAddressableModelId(id: string): string {
  const absolute = id.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(id)
  if (!absolute || !/\.gguf$/iu.test(id)) return id
  const segments = id.split(/[\\/]/u)
  return segments[segments.length - 1] || id
}

/**
 * The id a started server reports for a row's model, which is what an address is
 * matched against.
 *
 * llama.cpp is told an alias, so its served id is stable. `mlx_lm.server` names
 * the model after exactly the `--model` value it was started with, and it lists
 * every downloaded MLX repository on `/v1/models` instead of the one it holds, so
 * the row's own selector is the only identity that answers "is this my model?".
 */
export function localAiModelId(entry: LlamaCppServerEntry): string {
  const source = localAiModelSource(entry)
  if (!source) return ''
  if (entry.runtime === 'mlx') {
    return source.kind === 'local' ? source.path : source.reference.repo
  }
  return llamaCppModelAlias(entry)
}

/**
 * Every id a started server may report for this row.
 *
 * A row that downloaded its model is rewritten to point at the folder it landed
 * in, and a server started from the earlier tag keeps naming the repository. Both
 * ids mean this row's model, so adoption matches either one.
 */
export function localAiModelAliases(entry: LlamaCppServerEntry): string[] {
  const ids: string[] = []
  const primary = localAiModelId(entry)
  if (primary.length > 0) ids.push(primary)
  const source = localAiModelSource(entry)
  if (entry.runtime === 'mlx' && source?.kind === 'local') {
    const repo = huggingFaceRepoForCachePath(source.path)
    if (repo.length > 0 && !ids.includes(repo)) ids.push(repo)
  }
  return ids
}

/**
 * The repository a Hugging Face cache folder belongs to, or an empty string.
 *
 * The cache names a repository `models--<owner>--<name>`, so a snapshot path
 * answers which repository it holds. A name with a single dash keeps it, and a
 * double dash inside a name is rejoined to the tail.
 */
export function huggingFaceRepoForCachePath(path: string): string {
  const marker = /(?:^|[\\/])models--([^\\/]+)/u.exec(path)
  const slug = marker?.[1] ?? ''
  if (slug.length === 0) return ''
  const [owner, ...rest] = slug.split('--')
  if (!owner || rest.length === 0) return ''
  return `${owner}/${rest.join('--')}`
}

/**
 * The id to record for a model an OpenAI-compatible endpoint reports.
 *
 * An MLX server may answer with the absolute folder it loaded, and a selection
 * is written as `provider/model`, so an absolute path would carry the user's
 * home directory into every request. It is reduced to its last segment; a GGUF
 * path keeps the llama.cpp rule above, and every other id is kept as served.
 */
export function localAiAddressableModelId(id: string, runtime: LocalAiRuntimeId): string {
  if (runtime === 'llama.cpp') return llamaCppAddressableModelId(id)
  const absolute = id.startsWith('/') || /^[a-zA-Z]:[\\/]/u.test(id)
  if (!absolute) return id
  const segments = id.split(/[\\/]/u)
  return segments[segments.length - 1] || id
}

/**
 * The argv `llama-server` is launched with. The model selector comes first so
 * the generated command reads the same as the one the user would type.
 *
 * `logFile` is where the app asks the server to write its log as well, so a
 * server that outlives the app still has a log to read afterwards. It is left
 * out of the copyable command: that path belongs to the app, not the user.
 */
export function buildLlamaServerArgs(entry: LlamaCppServerEntry, logFile?: string): string[] {
  const source = localAiModelSource(entry)
  if (!source) return []
  const args = source.kind === 'local' ? ['-m', source.path] : huggingFaceArgs(source.reference)
  args.push('--host', entry.host.trim(), '--port', String(entry.port))
  const flags = tokenizeLlamaCppFlags(entry.extraFlags)
  // An alias the user set in the extra flags wins; the generated one only keeps
  // the served id addressable when they gave none.
  if (!flags.some((flag) => flag === '-a' || flag.startsWith('--alias'))) {
    args.push('--alias', llamaCppModelAlias(entry))
  }
  if (logFile && !flags.some((flag) => flag.startsWith('--log-file'))) {
    args.push('--log-file', logFile)
  }
  args.push(...flags)
  return args
}

function huggingFaceArgs(reference: HuggingFaceModelReference): string[] {
  const args = ['-hf', reference.quant ? `${reference.repo}:${reference.quant}` : reference.repo]
  if (reference.file) args.push('--hf-file', reference.file)
  return args
}

/** The command line shown in the card, for the user to copy. */
export function describeLlamaServerCommand(
  entry: LlamaCppServerEntry,
  executable = 'llama-server'
): string {
  const args = buildLlamaServerArgs(entry)
  if (args.length === 0) return ''
  return [executable, ...args.map(quoteArg)].join(' ')
}

/**
 * The argv `mlx_lm.server` is launched with.
 *
 * MLX has no alias and no log file: the server names the model after the
 * selector it was given, and prints its log to the terminal it runs in. A
 * Hugging Face reference is the repository alone, because an MLX repository is
 * one model; the server fetches it on the first load.
 */
export function buildMlxServerArgs(entry: LlamaCppServerEntry): string[] {
  const source = localAiModelSource(entry)
  if (!source) return []
  const model = source.kind === 'local' ? source.path : source.reference.repo
  return [
    '--model',
    model,
    '--host',
    entry.host.trim(),
    '--port',
    String(entry.port),
    ...tokenizeLlamaCppFlags(entry.extraFlags)
  ]
}

/** The argv a row is launched with, whichever engine owns it. */
export function localAiServerArgs(entry: LlamaCppServerEntry, logFile?: string): string[] {
  return entry.runtime === 'mlx' ? buildMlxServerArgs(entry) : buildLlamaServerArgs(entry, logFile)
}

/** The command line shown in the card, for the user to copy. */
export function describeLocalAiServerCommand(
  entry: LlamaCppServerEntry,
  executable: string
): string {
  const args = localAiServerArgs(entry)
  if (args.length === 0) return ''
  return [executable, ...args.map(quoteArg)].join(' ')
}

/** What a row's server binary is called when the app has not resolved it yet. */
export function localAiServerCommandName(runtime: LocalAiRuntimeId): string {
  return runtime === 'mlx' ? 'mlx_lm.server' : 'llama-server'
}

function quoteArg(value: string): string {
  return /^[A-Za-z0-9_./:=@+-]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`
}

/**
 * Address the app probes for readiness. A server bound to every interface is
 * reached over loopback, which is where it listens too.
 */
export function llamaCppProbeHost(host: string): string {
  const trimmed = host.trim()
  if (trimmed === '0.0.0.0' || trimmed === '::' || trimmed === '' || trimmed === 'localhost') {
    return '127.0.0.1'
  }
  return trimmed
}

export function llamaCppBaseUrl(entry: Pick<LlamaCppServerEntry, 'host' | 'port'>): string {
  return `http://${llamaCppProbeHost(entry.host)}:${entry.port}`
}

/** Stable PTY id for a row, so a renderer reload reattaches to the live process. */
export function localAiPtyId(entryId: string): string {
  return `local-ai:${entryId}`
}

const HOST_LABEL =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/u

/** A bare IPv4 address, `0.0.0.0`, `::`, or a DNS label: never a scheme or a path. */
export function isLlamaCppHostValid(host: string): boolean {
  const value = host.trim()
  if (value.length === 0 || value.length > LLAMA_CPP_HOST_MAX_LENGTH) return false
  if (value === '::' || value === '::1') return true
  if (value.includes(':') || value.includes('/') || value.includes(' ') || value.includes('\0')) {
    return false
  }
  return HOST_LABEL.test(value)
}

export function isLlamaCppPortValid(port: number): boolean {
  return Number.isInteger(port) && port >= MIN_LLAMA_CPP_PORT && port <= MAX_LLAMA_CPP_PORT
}

/** First port from `DEFAULT_LLAMA_CPP_PORT` up that no saved row already claims. */
export function nextFreeLlamaCppPort(entries: readonly LlamaCppServerEntry[]): number {
  const taken = new Set(entries.map((entry) => entry.port))
  let port = DEFAULT_LLAMA_CPP_PORT
  while (taken.has(port) && port < MAX_LLAMA_CPP_PORT) port++
  return port
}

/** The `host:port` a row binds, as one string to compare and show. */
export function llamaCppServerAddress(entry: Pick<LlamaCppServerEntry, 'host' | 'port'>): string {
  return `${entry.host.trim() || DEFAULT_LLAMA_CPP_HOST}:${entry.port}`
}

/** One server on this machine and every saved model that opens on its address. */
export interface LlamaCppServerGroup {
  /** `host:port`, the identity of the server. */
  address: string
  host: string
  port: number
  /** Saved models that load on this address, in saved order. */
  entries: LlamaCppServerEntry[]
}

/**
 * Group saved rows into servers.
 *
 * An address is the server: one host and port can hold several saved models,
 * and exactly one of them runs at a time because `llama-server` loads one model
 * per process. Two rows on one address are therefore two models of one server,
 * never two servers.
 */
export function groupLlamaCppServers(
  entries: readonly LlamaCppServerEntry[]
): LlamaCppServerGroup[] {
  const groups = new Map<string, LlamaCppServerGroup>()
  for (const entry of entries) {
    const address = llamaCppServerAddress(entry)
    const existing = groups.get(address)
    if (existing) {
      existing.entries.push(entry)
      continue
    }
    groups.set(address, { address, host: entry.host.trim(), port: entry.port, entries: [entry] })
  }
  return [...groups.values()]
}

/**
 * Why a row cannot be saved, or null when it can.
 *
 * Two rows may name the same address on purpose: one port serves one model at a
 * time, and the user is allowed to keep several saved models pointed at it, then
 * start whichever one they want. Starting one while another is bound there asks
 * before the running model is stopped, so this validation must not refuse it.
 */
/** How one engine's model is named in the editor and on the row. */
export interface LocalAiModelCopy {
  /** What the local source is called, e.g. "Local GGUF file". */
  localTitle: string
  localHint: string
  localPlaceholder: string
  /** Placeholder for the Hugging Face reference, when the engine takes one. */
  referencePlaceholder: string
  /** Whether this engine can pull a model from a Hugging Face reference. */
  huggingFace: boolean
  /** Pick dialog title, so the OS dialog names the right thing. */
  pickTitle: string
}

/**
 * The words one engine's model uses.
 *
 * An MLX server loads a model folder of safetensors, which has nothing to do with
 * GGUF; saying "GGUF" in the editor is how a user ends up pointing an engine at a
 * file it cannot read.
 */
export function localAiModelCopy(runtime: LocalAiRuntimeId): LocalAiModelCopy {
  if (runtime === 'mlx') {
    return {
      localTitle: 'Local MLX model',
      localHint: 'A model folder holding the weights and the tokenizer.',
      localPlaceholder: '/path/to/mlx-model',
      referencePlaceholder: 'mlx-community/Qwen3-4B-4bit',
      huggingFace: true,
      pickTitle: 'Choose an MLX model folder'
    }
  }
  return {
    localTitle: 'Local GGUF file',
    localHint: 'A file already on this machine, referenced where it lives.',
    localPlaceholder: '/path/to/model.gguf',
    referencePlaceholder: 'LiquidAI/LFM2.5-2.6B-GGUF:Q5_K_M',
    huggingFace: true,
    pickTitle: 'Choose a GGUF model'
  }
}

export function localAiEntryProblem(entry: LlamaCppServerEntry): string | null {
  const name = entry.name.trim()
  if (name.length === 0) return 'Give the server a name'
  if (name.length > LLAMA_CPP_NAME_MAX_LENGTH) return 'The name is too long'
  const source = localAiModelSource(entry)
  if (source === null) {
    const copy = localAiModelCopy(entry.runtime)
    return copy.huggingFace
      ? 'Choose a local model or a Hugging Face reference'
      : `Choose a ${copy.localTitle.toLowerCase()}`
  }
  // An MLX repository is one model, so a quantisation tag or a file name inside
  // it names something the server cannot load; it fetches the whole repository.
  if (source.kind === 'huggingface' && entry.runtime === 'mlx') {
    if (source.reference.quant || source.reference.file) {
      return 'An MLX model is one repository: use owner/repo without a quant tag or file'
    }
  }
  if (!isLlamaCppHostValid(entry.host)) return 'Enter a host such as 127.0.0.1'
  if (!isLlamaCppPortValid(entry.port)) return 'Enter a port between 1 and 65535'
  if (entry.extraFlags.length > LLAMA_CPP_FLAGS_MAX_LENGTH) return 'The extra flags are too long'
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function boundedString(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  return trimmed.length > max ? null : trimmed
}

/**
 * Validate a whole saved list. A hand-edited or future-written row is dropped
 * rather than failing the launch, matching how the other tolerant config lists
 * are read.
 */
/** The engine an entry belongs to; an older save without one is llama.cpp. */
function readEntryRuntime(value: unknown): LocalAiRuntimeId {
  return value === 'mlx' ? 'mlx' : 'llama.cpp'
}

/** A row saved for the Core ML engine, which the app no longer serves. */
function isRetiredCoreMlRow(raw: Record<string, unknown>): boolean {
  return raw.runtime === 'coreml'
}

export function validateLlamaCppServers(value: unknown): LlamaCppServerEntry[] {
  if (!Array.isArray(value)) throw new TypeError('Llama.cpp servers must be a list')
  if (value.length > MAX_LLAMA_CPP_SERVERS) {
    throw new TypeError(`At most ${MAX_LLAMA_CPP_SERVERS} Llama.cpp servers can be saved`)
  }
  const entries: LlamaCppServerEntry[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    if (!isRecord(raw)) continue
    // Core ML never had a server the app could launch, so a saved row is a
    // leftover rather than a server: it is dropped instead of being shown as a
    // llama.cpp row it is not.
    if (isRetiredCoreMlRow(raw)) continue
    const id = boundedString(raw.id, 128)
    if (!id || ids.has(id)) continue
    const name = boundedString(raw.name, LLAMA_CPP_NAME_MAX_LENGTH)
    const modelPath = boundedString(raw.modelPath, LLAMA_CPP_MODEL_PATH_MAX_LENGTH)
    const modelReference = boundedString(raw.modelReference, LLAMA_CPP_REFERENCE_MAX_LENGTH)
    const host = boundedString(raw.host, LLAMA_CPP_HOST_MAX_LENGTH)
    const extraFlags = boundedString(raw.extraFlags, LLAMA_CPP_FLAGS_MAX_LENGTH)
    if (name === null || modelPath === null || modelReference === null) continue
    if (host === null || extraFlags === null) continue
    const port = typeof raw.port === 'number' ? raw.port : Number.NaN
    const entry: LlamaCppServerEntry = {
      id,
      runtime: readEntryRuntime(raw.runtime),
      name,
      modelPath,
      modelReference,
      host: host || DEFAULT_LLAMA_CPP_HOST,
      port: isLlamaCppPortValid(port) ? port : DEFAULT_LLAMA_CPP_PORT,
      extraFlags
    }
    if (localAiEntryProblem(entry) !== null) continue
    ids.add(id)
    entries.push(entry)
  }
  return entries
}

/**
 * The local inference runtimes whose server process the app owns.
 *
 * `llama.cpp` runs as a `llama-server` process and `mlx` as `mlx_lm.server`, both
 * spawned and stopped by the Local AI page. Core ML is not here: it is bound into
 * the bundled speech workers, so it is a speech runtime rather than a server.
 */
export type LocalAiRuntimeId = 'llama.cpp' | 'mlx'
/** One engine on the Local AI page, as a tab. */
export interface LocalAiRuntimeTab {
  id: LocalAiRuntimeId
  label: string
  title: string
}

/** The two engines the page serves, in tab order. */
export const LOCAL_AI_RUNTIME_TABS: readonly LocalAiRuntimeTab[] = [
  {
    id: 'llama.cpp',
    label: 'llama.cpp',
    title: 'The llama.cpp engine and its GGUF servers'
  },
  { id: 'mlx', label: 'MLX', title: 'The MLX engine and the models it serves' }
]

/**
 * How long a resident local model stays loaded after its last use.
 *
 * One window for every local server the app owns: the same model is held for
 * speech cleanup and for search embeddings, so two windows would only decide
 * which subsystem re-loads it first. `keep` pins it for the rest of the session.
 */
export const LOCAL_AI_UNLOAD_OPTIONS = ['5m', '10m', '20m', '30m', 'keep'] as const

/** What "Unload now" released, so the page can name it instead of saying "done". */
export interface LocalAiUnloadResult {
  /** Servers that were resident and stopped. */
  stopped: number
  /** Model files those servers had loaded. */
  models: string[]
}

export type LocalAiUnloadOption = (typeof LOCAL_AI_UNLOAD_OPTIONS)[number]

/** 30 minutes: long enough to stay warm across a working session. */
export const DEFAULT_LOCAL_AI_UNLOAD_OPTION: LocalAiUnloadOption = '30m'

const LOCAL_AI_UNLOAD_MS: Readonly<Record<Exclude<LocalAiUnloadOption, 'keep'>, number>> = {
  '5m': 5 * 60_000,
  '10m': 10 * 60_000,
  '20m': 20 * 60_000,
  '30m': 30 * 60_000
}

export const LOCAL_AI_UNLOAD_LABELS: Readonly<Record<LocalAiUnloadOption, string>> = {
  '5m': '5 minutes',
  '10m': '10 minutes',
  '20m': '20 minutes',
  '30m': '30 minutes',
  keep: 'Never unload'
}

export function isLocalAiUnloadOption(value: unknown): value is LocalAiUnloadOption {
  return typeof value === 'string' && LOCAL_AI_UNLOAD_OPTIONS.some((option) => option === value)
}

/** A stored value that is no longer a valid option falls back to the default. */
export function readLocalAiUnloadOption(value: unknown): LocalAiUnloadOption {
  return isLocalAiUnloadOption(value) ? value : DEFAULT_LOCAL_AI_UNLOAD_OPTION
}

/** How long the window lasts, or null when the user pinned the model. */
export function localAiUnloadMs(option: LocalAiUnloadOption): number | null {
  return option === 'keep' ? null : LOCAL_AI_UNLOAD_MS[option]
}

/** What the binary card states about the engine it runs. */
export interface LocalAiRuntimeStatus {
  /** The engine this status was read for. */
  runtime: LocalAiRuntimeId
  platform: NodeJS.Platform
  installed: boolean
  /** Absolute path of the resolved server, empty when there is none. */
  path: string
  /** Version, empty when the binary could not report one. */
  version: string
  /** Package manager that can install or update this engine here. */
  installer: 'homebrew' | null
  installerPath: string
  /** True when the installer reports a newer build than the one on disk. */
  updateAvailable: boolean
  /** Version the installer would move to, empty when there is nothing newer. */
  latestVersion: string
  /** One sentence the card shows under the status. */
  detail: string
}

/**
 * Where a row's log comes from, and what the file already holds.
 *
 * `pty` means the process is still attached to the terminal that started it, so
 * its output arrives over the PTY channels. `file` means the row reads the
 * server's own `--log-file` instead, which is all that is left once the app
 * instance that launched it is gone.
 */
export interface LlamaCppLogStream {
  source: 'pty' | 'file'
  lines: string[]
}

/** Where a downloaded model lives on this machine, and what it costs on disk. */
export interface LocalAiModelLocation {
  /** Absolute folder (MLX snapshot) or file (GGUF) the server loaded. */
  path: string
  /** Bytes the model occupies, 0 when it could not be measured. */
  bytes: number
}

/** The readiness answer for a started server. */
export interface LlamaCppProbeResult {
  ready: boolean
  /** Model ids the server reports on `/v1/models`. */
  models: string[]
  /** Why the probe failed, for the card to show while it is still starting. */
  error: string
}

/**
 * The Homebrew work the Local AI page runs in its docked terminal: install an
 * engine, move it to the newest build, or remove it.
 */
export type LlamaCppBrewJobKind = 'install' | 'update' | 'uninstall'

/**
 * Environment every Homebrew job here runs with.
 *
 * Homebrew asks `Do you want to proceed with the <action>? [y/n]` whenever a
 * terminal is attached and the plan reaches past the named formula, which an
 * `upgrade llama.cpp` always does because the formula pulls libomp, ggml and
 * openssl along with it. Nothing types into that prompt, so the job would sit
 * there until the idle watchdog killed it. `HOMEBREW_NO_ASK` turns the ask off.
 *
 * It is set through the environment rather than as a `--no-ask` flag on purpose:
 * older Homebrew releases predate the flag and would reject the command, while
 * they ignore a variable they do not know.
 */
export const LOCAL_AI_BREW_ENVIRONMENT: Readonly<Record<string, string>> = {
  HOMEBREW_NO_ASK: '1'
}

/** The formula that installs one engine here. */
export function localAiBrewFormula(runtime: LocalAiRuntimeId): string {
  return runtime === 'mlx' ? 'mlx-lm' : 'llama.cpp'
}

/** The Homebrew arguments that carry out one job, always non-interactive. */
export function localAiBrewArgs(runtime: LocalAiRuntimeId, kind: LlamaCppBrewJobKind): string[] {
  const formula = localAiBrewFormula(runtime)
  switch (kind) {
    case 'install':
      return ['install', formula]
    case 'update':
      return ['upgrade', formula]
    case 'uninstall':
      return ['uninstall', formula]
  }
}

/**
 * Read a saved row list without failing the launch: a value that is not a list
 * arrives as no rows, and a row that cannot launch is dropped, matching how the
 * other tolerant config lists are read.
 */
export function readLlamaCppServers(value: unknown): LlamaCppServerEntry[] {
  if (!Array.isArray(value)) return []
  return validateLlamaCppServers(value.slice(0, MAX_LLAMA_CPP_SERVERS))
}
