import { resolveIdeExecutable } from './ide-executables'
import { ideInstallations } from './ide-installations'
import {
  DEFAULT_IDE_LANGUAGE_SERVERS,
  type IdeLanguageMapping,
  type IdeLanguageServer
} from '../../lib/ide-language-servers'
import { StringDecoder } from 'node:string_decoder'
import { parentPort } from 'node:worker_threads'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpath, readFile, stat } from 'node:fs/promises'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isWithinRoot, validateRelativePath } from './project-files/project-files-paths'
import type {
  IdeRequest,
  IdeResponse,
  IdeLocation,
  IdeProgress,
  IdeCompletionItem,
  IdeCodeAction,
  IdePosition,
  IdeRange,
  IdeTextEdit
} from '../../lib/editor-ide'

const port = parentPort!
const MAX_BYTES = 2 * 1024 * 1024
/**
 * How long one language-server request may take.
 *
 * A warm server answers in milliseconds, so this bound exists only to stop a
 * hung child from occupying a slot forever. Hover, definition and references are
 * the exception and use `INTELLIGENCE_TIMEOUT_MS`: the first of them after a
 * document opens pays that server's own project load, which measured 11.8 s for
 * svelte-language-server on this repository (the rest of the hovers on the same
 * document answered in 20-70 ms). The old flat 12 s bound sat inside that load,
 * so the first hover was cancelled, every hover queued behind it blew the IDE
 * service's own watchdog, and the editor reported "Editor intelligence timed
 * out" with nothing else to act on.
 */
const REQUEST_TIMEOUT_MS = 12_000
const INTELLIGENCE_TIMEOUT_MS = 30_000
const sessions = new Map<string, Promise<Session>>()
const liveSessions = new Set<Session>()
let configuredServers: IdeLanguageServer[] | undefined
const owners = new Map<string, OwnedDocument[]>()
interface OwnedDocument {
  session: Session
  uri: string
}
interface Selection {
  server: IdeLanguageServer
  mapping: IdeLanguageMapping
}
const searches = new Map<string, ReturnType<typeof spawn>>()
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

class Session {
  /** Identity of this session's configuration, so a changed definition retires it. */
  readonly configurationKey: string
  /** The settings this session answers `workspace/configuration` from. */
  readonly settings: Record<string, unknown>
  readonly documents = new Map<string, { text: string; version: number }>()
  /** The diagnostics the server last published for a document. Code actions
   *  are asked for against them, which is how an unresolved icon gets an
   *  "Import X from ..." quick fix instead of an empty menu. */
  readonly diagnostics = new Map<string, unknown[]>()
  /** A server's request to apply an edit on its behalf. Set only while an
   *  execute-command is running, so a stray apply cannot land in another
   *  action's result. */
  applyEditHandler: ((edit: unknown) => void) | null = null
  /** Documents this session already paid its cold-start request for. */
  readonly warmed = new Set<string>()
  capabilities: Record<string, unknown> = {}
  private stopped = false
  private failure = ''
  private stderr = ''
  private sequence = 0
  private buffer = Buffer.alloc(0)
  private pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  readonly child: ChildProcessWithoutNullStreams
  constructor(
    readonly root: string,
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    readonly definition: IdeLanguageServer
  ) {
    this.configurationKey = JSON.stringify(definition)
    this.settings = definition.settings
    this.child = spawn(command, args, { cwd: root, env, stdio: 'pipe', windowsHide: true })
    liveSessions.add(this)
    this.child.once('exit', () => liveSessions.delete(this))
    this.child.stdout.on('data', (data: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, data])
      if (this.buffer.length > 8 * MAX_BYTES) {
        this.stop()
        return
      }
      for (;;) {
        const headerEnd = this.buffer.indexOf('\r\n\r\n')
        if (headerEnd < 0) return
        const length = Number(
          /content-length:\s*(\d+)/iu.exec(this.buffer.subarray(0, headerEnd).toString())?.[1]
        )
        if (!Number.isSafeInteger(length) || length < 0 || length > 8 * MAX_BYTES) {
          this.stop()
          return
        }
        if (this.buffer.length < headerEnd + 4 + length) return
        const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length)
        this.buffer = this.buffer.subarray(headerEnd + 4 + length)
        try {
          this.receive(record(JSON.parse(body.toString())))
        } catch {
          this.stop()
          return
        }
      }
    })
    this.child.on('spawn', () => port.postMessage({ serverPid: this.child.pid, add: true }))
    this.child.on('exit', () =>
      port.postMessage({
        serverPid: this.child.pid,
        add: false,
        idle: owners.size === 0 && searches.size === 0
      })
    )
    this.child.stderr.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-2000)
    })
    this.child.stdin.on('error', () => this.stop())
    this.child.on('error', (error) => {
      this.failure = error.message
      this.stop()
    })
    this.child.on('exit', (code) => {
      this.failure ||= `Exited with code ${code}. ${this.stderr.trim()}`
      this.stop()
    })
  }
  send(message: object): void {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message })
    if (this.child.stdin.writableLength > 4 * MAX_BYTES) throw new Error('Language server is busy')
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  notify(method: string, params: unknown): void {
    this.send({ method, params })
  }
  explainEmptyResult(): void {
    // Configuration failures belong in the command result, not an empty picker.
    if (/Cannot find (?:package|module)/u.test(this.stderr)) {
      const detail = this.stderr.match(/(?:Error[^\n]*|Cannot find (?:package|module)[^\n]*)/u)?.[0]
      throw new Error(
        `Project dependencies could not be loaded. ${detail ?? this.stderr.slice(-1000)} Install this project's dependencies, then retry IDE Mode.`
      )
    }
  }
  request(method: string, params: unknown, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.notify('$/cancelRequest', { id })
        reject(new Error(`The language server did not answer ${method} in time`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ id, method, params })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }
  private receive(message: Record<string, unknown>): void {
    if (typeof message.method === 'string' && message.id !== undefined) {
      if (message.method === 'workspace/configuration') {
        const items = record(message.params).items
        this.send({
          id: message.id,
          result: Array.isArray(items)
            ? items.map((item) => {
                const section = record(item).section
                return typeof section === 'string'
                  ? section
                      .split('.')
                      .reduce<unknown>(
                        (value, key) =>
                          Object.hasOwn(record(value), key) ? record(value)[key] : null,
                        this.settings
                      )
                  : this.settings
              })
            : []
        })
      } else if (message.method === 'workspace/workspaceFolders') {
        this.send({
          id: message.id,
          result: [{ uri: pathToFileURL(this.root).href, name: this.root }]
        })
      } else if (message.method === 'workspace/applyEdit') {
        // The app owns the buffers, so the edit is handed to the request that
        // asked for it instead of being written behind the user's back.
        this.applyEditHandler?.(record(message.params).edit)
        this.send({ id: message.id, result: { applied: true } })
      } else if (
        message.method === 'client/registerCapability' ||
        message.method === 'window/workDoneProgress/create'
      ) {
        this.send({ id: message.id, result: null })
      } else {
        this.send({
          id: message.id,
          error: { code: -32601, message: 'This editor does not support that request' }
        })
      }
      return
    }
    // Notifications carry no id. The one worth forwarding is the server's own
    // report about the work it is doing, which is how a loading project becomes
    // a labelled progress bar instead of a silent wait.
    if (typeof message.method === 'string') {
      if (message.method === '$/progress') this.reportProgress(record(message.params))
      if (message.method === 'textDocument/publishDiagnostics') {
        const params = record(message.params)
        const uri = params.uri
        if (typeof uri === 'string' && Array.isArray(params.diagnostics))
          this.diagnostics.set(uri, params.diagnostics.slice(0, 2000))
      }
      return
    }
    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(message.id)
    if (message.error)
      pending.reject(new Error(String(record(message.error).message ?? 'Language server error')))
    else pending.resolve(message.result)
  }
  /** Forward one work item to the app. The server and workspace come from here. */
  noteProgress(entry: Omit<IdeProgress, 'serverId' | 'name' | 'root'>): void {
    port.postMessage({
      progress: {
        serverId: this.definition.id,
        name: this.definition.name,
        root: this.root,
        ...entry
      } satisfies IdeProgress
    })
  }
  private reportProgress(params: Record<string, unknown>): void {
    const value = record(params.value)
    const kind = value.kind
    if (kind !== 'begin' && kind !== 'report' && kind !== 'end') return
    const token = typeof params.token === 'string' ? params.token : String(params.token ?? '')
    if (!token || token.length > 200) return
    const text = (candidate: unknown): string | undefined =>
      typeof candidate === 'string' && candidate.trim() ? candidate.trim().slice(0, 300) : undefined
    const percentage =
      typeof value.percentage === 'number' && Number.isFinite(value.percentage)
        ? Math.min(100, Math.max(0, Math.round(value.percentage)))
        : undefined
    this.noteProgress({
      token,
      kind,
      title: text(value.title),
      message: text(value.message),
      percentage
    })
  }
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    liveSessions.delete(this)
    this.child.kill()
    const killTimer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
    }, 1000)
    killTimer.unref()
    this.child.once('exit', () => clearTimeout(killTimer))
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(
        new Error(
          `Language server stopped. ${this.failure || this.stderr || 'Verify its installation in Settings > IDE Mode.'}`
        )
      )
    }
    this.pending.clear()
    for (const [key, session] of sessions)
      void session
        .then((value) => {
          if (value === this && this.child.killed) sessions.delete(key)
        })
        .catch(() => undefined)
  }
}

/**
 * Every enabled server that handles this file, most specific extension first.
 *
 * A file routinely needs more than one server: Svelte or TypeScript structure
 * plus Tailwind class documentation, exactly as a full editor runs them side by
 * side. One server is listed once even when two of its extensions match.
 */
function selectDefinitions(path: string, servers: IdeLanguageServer[]): Selection[] {
  const lower = path.toLowerCase()
  const byServer = new Map<string, Selection>()
  for (const server of servers) {
    if (!server.enabled) continue
    for (const mapping of server.languages) {
      if (!lower.endsWith(mapping.extension)) continue
      const existing = byServer.get(server.id)
      if (existing && existing.mapping.extension.length >= mapping.extension.length) continue
      byServer.set(server.id, { server, mapping })
    }
  }
  return [...byServer.values()].sort(
    (left, right) => right.mapping.extension.length - left.mapping.extension.length
  )
}

async function sessionFor(
  root: string,
  path: string,
  env: NodeJS.ProcessEnv,
  definition: IdeLanguageServer
): Promise<Session> {
  const { command, args } = definition
  let workspaceRoot = root
  if (definition.rootMarkers.length) {
    let candidate = dirname(path)
    for (let depth = 0; depth < 64 && isWithinRoot(root, candidate); depth++) {
      const found = await Promise.all(
        definition.rootMarkers.map((marker) =>
          stat(join(candidate, marker)).then(
            () => true,
            () => false
          )
        )
      )
      if (found.some(Boolean)) {
        workspaceRoot = candidate
        break
      }
      if (candidate === root) break
      candidate = dirname(candidate)
    }
  }
  if (!(await stat(workspaceRoot)).isDirectory())
    throw new Error(`Language server workspace is not a directory: ${workspaceRoot}`)
  const key = `${workspaceRoot}\0${JSON.stringify(definition)}`
  let pending = sessions.get(key)
  if (!pending) {
    if (sessions.size >= 8)
      throw new Error(
        'IDE Mode supports eight active language servers. Close unused editors first.'
      )
    pending = (async () => {
      const overrides = Object.fromEntries(
        Object.entries(definition.env).map(([key, value]) => [
          key,
          value.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/gu, (_match: string, name: string) => {
            if (env[name] === undefined) throw new Error(`Environment variable ${name} is not set`)
            return env[name]!
          })
        ])
      )
      const localEnv = {
        ...env,
        ...overrides,
        PATH: `${join(workspaceRoot, 'node_modules', '.bin')}${delimiter}${join(root, 'node_modules', '.bin')}${delimiter}${overrides.PATH ?? env.PATH ?? ''}`
      }
      const executable = await resolveIdeExecutable(command, localEnv, workspaceRoot)
      if (!executable)
        throw new Error(
          `Language server ${definition.name} is not installed or its executable is unavailable. Open Settings > IDE Mode and install ${definition.name}, or configure an absolute executable path. Searched managed tools, project/PATH directories and Neovim Mason installations.`
        )
      const session = new Session(workspaceRoot, executable, args, localEnv, definition)
      try {
        const result = record(
          await session.request('initialize', {
            initializationOptions: definition.initializationOptions,
            processId: process.pid,
            rootUri: pathToFileURL(workspaceRoot).href,
            workspaceFolders: [{ uri: pathToFileURL(workspaceRoot).href, name: workspaceRoot }],
            capabilities: {
              general: { positionEncodings: ['utf-16'] },
              // A server only reports work-done progress when the client says it
              // understands it. Declaring it is what turns a silent project load
              // into the labelled progress the IDE panel shows.
              window: { workDoneProgress: true },
              workspace: { configuration: true, workspaceFolders: true, applyEdit: true },
              textDocument: {
                hover: { contentFormat: ['plaintext', 'markdown'] },
                definition: { linkSupport: true },
                completion: {
                  // No snippet support: this editor inserts plain text, so a
                  // server must not answer with `${1:...}` placeholders.
                  completionItem: {
                    documentationFormat: ['plaintext', 'markdown'],
                    labelDetailsSupport: true,
                    // tsserver only attaches an auto-import edit when the item
                    // is resolved, and it only resolves the fields listed here.
                    resolveSupport: {
                      properties: ['documentation', 'detail', 'additionalTextEdits']
                    },
                    insertReplaceSupport: true
                  },
                  contextSupport: true
                },
                codeAction: {
                  codeActionLiteralSupport: {
                    codeActionKind: {
                      valueSet: [
                        'quickfix',
                        'refactor',
                        'refactor.extract',
                        'refactor.inline',
                        'refactor.rewrite',
                        'source',
                        'source.addMissingImports',
                        'source.organizeImports',
                        'source.fixAll'
                      ]
                    }
                  },
                  isPreferredSupport: true,
                  disabledSupport: true,
                  dataSupport: true,
                  resolveSupport: { properties: ['edit'] }
                },
                publishDiagnostics: { versionSupport: false },
                synchronization: { dynamicRegistration: false, didSave: false }
              }
            }
          })
        )
        session.capabilities = record(result.capabilities)
        session.notify('initialized', {})
        session.notify('workspace/didChangeConfiguration', { settings: definition.settings })
        return session
      } catch (error) {
        session.stop()
        sessions.delete(key)
        throw new Error(
          `Cannot start ${command}. Install it locally or on PATH. ${error instanceof Error ? error.message : ''}`,
          { cause: error }
        )
      }
    })()
    sessions.set(key, pending)
    void pending.catch(() => {
      if (sessions.get(key) === pending) sessions.delete(key)
    })
  }
  return pending
}

function closeOwner(owner: string, keep?: ReadonlySet<Session>, nextUri?: string): void {
  searches.get(owner)?.kill()
  searches.delete(owner)
  const owned = owners.get(owner) ?? []
  owners.delete(owner)
  if (!owned.length) return
  const remaining = [...owners.values()].flat()
  for (const entry of owned) {
    const kept = keep?.has(entry.session) ?? false
    const shared = remaining.some(
      (value) => value.session === entry.session && value.uri === entry.uri
    )
    // A kept session still has to drop the document this editor is leaving.
    if (!(kept ? entry.uri === nextUri : shared)) {
      entry.session.notify('textDocument/didClose', { textDocument: { uri: entry.uri } })
      entry.session.documents.delete(entry.uri)
    }
    if (!kept && !remaining.some((value) => value.session === entry.session)) entry.session.stop()
  }
}
async function locations(root: string, result: unknown): Promise<IdeLocation[]> {
  const values = Array.isArray(result) ? result : result ? [result] : []
  const output: IdeLocation[] = []
  for (const value of values.slice(0, 200)) {
    const item = record(value)
    const uri = item.uri ?? item.targetUri
    if (typeof uri !== 'string' || !uri.startsWith('file:')) continue
    try {
      const path = await realpath(fileURLToPath(uri))
      if (!isWithinRoot(root, path)) continue
      const start = record(record(item.range ?? item.targetSelectionRange).start)
      if (typeof start.line !== 'number' || typeof start.character !== 'number') continue
      output.push({
        path: relative(root, path).split('\\').join('/'),
        line: start.line + 1,
        character: start.character
      })
    } catch {
      /* Ignore missing or out-of-workspace targets. */
    }
  }
  return output
}
function documentation(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(documentation).join('\n\n')
  return typeof record(value).value === 'string' ? String(record(value).value) : ''
}

/** One LSP position, refused when it is not a non-negative integer pair. */
function lspPosition(value: unknown): IdePosition | null {
  const position = record(value)
  const line = Number(position.line)
  const character = Number(position.character)
  if (!Number.isInteger(line) || !Number.isInteger(character)) return null
  if (line < 0 || character < 0) return null
  return { line, character }
}
function lspRange(value: unknown): IdeRange | null {
  const range = record(value)
  const start = lspPosition(range.start)
  const end = lspPosition(range.end)
  return start && end ? { start, end } : null
}
/** A range, an InsertReplaceEdit or a completion's default edit range. */
function rangeOf(value: unknown): IdeRange | null {
  const entry = record(value)
  return lspRange(entry.range ?? entry.replace ?? entry.insert ?? entry)
}
function normalizeEdits(value: unknown): IdeTextEdit[] | undefined {
  if (!Array.isArray(value)) return undefined
  const edits: IdeTextEdit[] = []
  for (const item of value) {
    const edit = record(item)
    const range = rangeOf(edit.range)
    if (typeof edit.newText !== 'string' || !range) continue
    edits.push({ range, newText: edit.newText })
  }
  return edits.length ? edits : undefined
}
/**
 * A snippet flattened to the text it stands for.
 *
 * Snippet support is deliberately not advertised, but a server that answers
 * with a snippet anyway must never put `${1:...}` into the user's file, so the
 * placeholders are unwrapped and the tab stops dropped.
 */
function plainSnippet(value: string): string {
  return value
    .replace(/\$\{\d+:([^}]*)\}/gu, '$1')
    .replace(/\$\{\d+\}/gu, '')
    .replace(/\$\d+/gu, '')
}
function normalizeCompletion(
  value: unknown,
  defaults: Record<string, unknown>,
  serverId: string
): IdeCompletionItem | null {
  const item = record(value)
  if (typeof item.label !== 'string' || !item.label) return null
  const insertTextFormat = item.insertTextFormat ?? defaults.insertTextFormat
  const text = (candidate: unknown): string | undefined => {
    if (typeof candidate !== 'string') return undefined
    return insertTextFormat === 2 ? plainSnippet(candidate) : candidate
  }
  const edit = record(item.textEdit)
  const editRange = rangeOf(edit) ?? rangeOf(defaults.editRange)
  const newText = text(edit.newText)
  const itemText = text(item.insertText) ?? text(item.label)
  const completion: IdeCompletionItem = { label: item.label, serverId }
  const labelDetail = record(item.labelDetails).detail ?? record(item.labelDetails).description
  if (typeof labelDetail === 'string' && labelDetail) completion.labelDetail = labelDetail
  if (typeof item.detail === 'string' && item.detail) completion.detail = item.detail
  const docs = documentation(item.documentation).slice(0, 8_000)
  if (docs) completion.documentation = docs
  if (typeof item.kind === 'number') completion.kind = item.kind
  if (Array.isArray(item.tags)) completion.tags = item.tags.filter((tag) => tag === 1)
  if (typeof item.sortText === 'string') completion.sortText = item.sortText
  if (typeof item.filterText === 'string') completion.filterText = item.filterText
  if (itemText) completion.insertText = itemText
  if (editRange && newText !== undefined) completion.textEdit = { range: editRange, newText }
  const additional = normalizeEdits(item.additionalTextEdits)
  if (additional) completion.additionalTextEdits = additional
  if (Array.isArray(item.commitCharacters))
    completion.commitCharacters = item.commitCharacters.filter(
      (character): character is string => typeof character === 'string'
    )
  if (item.data !== undefined) completion.data = item.data
  return completion
}
/** The identifier the caret is inside, for a code action's own range. */
function wordRangeAt(text: string, line: number, character: number): IdeRange {
  const lines = text.split('\n')
  const target = lines[Math.max(0, Math.min(line, lines.length - 1))] ?? ''
  const caret = Math.max(0, Math.min(character, target.length))
  const isWord = (value: string | undefined): boolean => value !== undefined && /[\w$]/u.test(value)
  let from = caret
  let to = caret
  while (from > 0 && isWord(target[from - 1])) from--
  while (to < target.length && isWord(target[to])) to++
  const safeLine = Math.max(0, Math.min(line, lines.length - 1))
  return {
    start: { line: safeLine, character: from },
    end: { line: safeLine, character: to }
  }
}
function overlapsRange(value: unknown, range: IdeRange): boolean {
  const diagnostic = lspRange(record(value).range)
  if (!diagnostic) return false
  return range.start.line <= diagnostic.end.line && range.end.line >= diagnostic.start.line
}
/** The word characters immediately before the caret, as the reader typed them. */
function wordPrefixAt(text: string, line: number, character: number): string {
  const range = wordRangeAt(text, line, character)
  const target = text.split('\n')[range.start.line] ?? ''
  return target.slice(
    range.start.character,
    Math.max(range.start.character, Math.min(character, target.length))
  )
}
/**
 * Every completion the file's servers offer at the caret.
 *
 * The renderer shows these in CodeMirror's own dropdown, so the answer is kept
 * to plain serialisable data: the opaque `data` field travels back untouched
 * when an item is resolved for its auto-import edit.
 */
async function completionsFor(
  entries: { session: Session; selection: Selection }[],
  uri: string,
  request: IdeRequest,
  text: string
): Promise<IdeResponse> {
  const providers = entries.filter((entry) =>
    Boolean(entry.session.capabilities.completionProvider)
  )
  if (!providers.length) return { completions: [] }
  const position = { line: request.line ?? 0, character: request.character ?? 0 }
  const context = {
    triggerKind: request.triggerKind ?? 1,
    ...(request.triggerCharacter ? { triggerCharacter: request.triggerCharacter } : {})
  }
  const results = await Promise.allSettled(
    providers.map((entry) =>
      entry.session.request(
        'textDocument/completion',
        { textDocument: { uri }, position, context },
        INTELLIGENCE_TIMEOUT_MS
      )
    )
  )
  const completions: IdeCompletionItem[] = []
  let isIncomplete = false
  let rejection: unknown
  for (const [index, result] of results.entries()) {
    if (result.status === 'rejected') {
      rejection ??= result.reason
      continue
    }
    const answer = record(result.value)
    const items = Array.isArray(result.value)
      ? result.value
      : Array.isArray(answer.items)
        ? answer.items
        : []
    if (answer.isIncomplete === true) isIncomplete = true
    const defaults = record(answer.itemDefaults)
    const serverId = providers[index].selection.server.id
    // The whole answer is normalized, not a prefix of it: a server lists its
    // auto-import items at the end (svelteserver put Widget at 1002 of 1039),
    // so truncating before the prefix filter would drop exactly the item the
    // reader is spelling.
    for (const item of items.slice(0, 5_000)) {
      const normalized = normalizeCompletion(item, defaults, serverId)
      if (normalized) completions.push(normalized)
    }
  }
  if (
    !completions.length &&
    rejection !== undefined &&
    results.every((r) => r.status === 'rejected')
  )
    throw rejection instanceof Error ? rejection : new Error(String(rejection))
  // Keep the list small enough to cross the IPC boundary on every keystroke.
  // The typed prefix is filtered here, where the buffer is, so the item the
  // reader is spelling survives the cap instead of being dropped from page 40
  // of an alphabetical list. A prefix with no exact start keeps the whole list
  // so CodeMirror's fuzzy matching still has something to show.
  const prefix = wordPrefixAt(text, request.line ?? 0, request.character ?? 0).toLowerCase()
  const matching = prefix
    ? completions.filter((item) => (item.filterText ?? item.label).toLowerCase().startsWith(prefix))
    : completions
  // The server's sortText is what puts an auto-import at the top: svelteserver
  // marks a discovered component with "-1" while the plain globals use their
  // own keys. Sorting after the filter (and before the cap) keeps that intent
  // and keeps an explicit, empty-prefix request useful.
  const shown = matching.length || !prefix ? matching : completions
  const ordered = shown.sort((left, right) =>
    (left.sortText ?? left.label).localeCompare(right.sortText ?? right.label)
  )
  return { completions: ordered.slice(0, 250), isIncomplete }
}
/** Resolve one completion, which is where tsserver attaches its auto-import. */
async function resolveCompletion(
  entries: { session: Session; selection: Selection }[],
  request: IdeRequest
): Promise<IdeResponse> {
  const payload = record(request.payload)
  const serverId = typeof payload.serverId === 'string' ? payload.serverId : ''
  const entry =
    entries.find((candidate) => candidate.selection.server.id === serverId) ?? entries[0]
  if (!entry || !entry.session.capabilities.completionProvider) return { completions: [] }
  const resolved = await entry.session.request(
    'completionItem/resolve',
    payload,
    INTELLIGENCE_TIMEOUT_MS
  )
  const completion = normalizeCompletion(resolved, {}, entry.selection.server.id)
  return { completions: completion ? [completion] : [] }
}
/**
 * The actions the file's servers offer for the code under the caret.
 *
 * Imports and quick fixes are the useful half of this: an unresolved icon has
 * no meaning until its module is imported, so the context menu lists the
 * server's own "Import ..." action beside Go to Definition.
 */
async function codeActionsFor(
  entries: { session: Session; selection: Selection }[],
  uri: string,
  request: IdeRequest,
  text: string
): Promise<IdeResponse> {
  const providers = entries.filter((entry) =>
    Boolean(entry.session.capabilities.codeActionProvider)
  )
  if (!providers.length) return { codeActions: [] }
  const range = wordRangeAt(text, request.line ?? 0, request.character ?? 0)
  const diagnostics = providers.flatMap((entry) =>
    (entry.session.diagnostics.get(uri) ?? []).filter((item) => overlapsRange(item, range))
  )
  const results = await Promise.allSettled(
    providers.map((entry) =>
      entry.session.request(
        'textDocument/codeAction',
        {
          textDocument: { uri },
          range,
          context: { diagnostics, triggerKind: 1, only: undefined }
        },
        INTELLIGENCE_TIMEOUT_MS
      )
    )
  )
  const actions: IdeCodeAction[] = []
  const seen = new Set<string>()
  for (const [index, result] of results.entries()) {
    if (result.status !== 'fulfilled' || !Array.isArray(result.value)) continue
    const serverId = providers[index].selection.server.id
    for (const raw of result.value.slice(0, 60)) {
      const action = record(raw)
      if (typeof action.title !== 'string' || !action.title || seen.has(action.title)) continue
      seen.add(action.title)
      actions.push({
        title: action.title,
        ...(typeof action.kind === 'string' ? { kind: action.kind } : {}),
        ...(action.isPreferred === true ? { isPreferred: true } : {}),
        ...(action.disabled !== undefined
          ? { disabled: Boolean(record(action.disabled).reason) }
          : {}),
        action: raw,
        serverId
      })
    }
  }
  // Preferred actions first; the sort is stable, so each server's own order holds.
  actions.sort(
    (left, right) => Number(right.isPreferred === true) - Number(left.isPreferred === true)
  )
  return { codeActions: actions.slice(0, 40) }
}
/** Group a WorkspaceEdit's edits by document URI. */
function workspaceEdits(edit: unknown): Map<string, IdeTextEdit[]> {
  const grouped = new Map<string, IdeTextEdit[]>()
  const add = (uri: unknown, edits: unknown): void => {
    if (typeof uri !== 'string' || !Array.isArray(edits)) return
    const normalized = normalizeEdits(edits)
    if (!normalized) return
    grouped.set(uri, [...(grouped.get(uri) ?? []), ...normalized])
  }
  const collection = record(edit)
  for (const [uri, edits] of Object.entries(record(collection.changes))) add(uri, edits)
  if (Array.isArray(collection.documentChanges))
    for (const change of collection.documentChanges) {
      const entry = record(change)
      add(record(entry.textDocument).uri, entry.edits)
    }
  return grouped
}
/**
 * Apply a code action, or its command, and return the re-laid-out document.
 *
 * Only the document the editor holds is written. An action that also wants to
 * change other files reports them instead, because dropping those edits
 * silently would leave the project half-changed with no way to know.
 */
async function applyCodeAction(
  entries: { session: Session; selection: Selection }[],
  root: string,
  uri: string,
  request: IdeRequest,
  text: string
): Promise<IdeResponse> {
  const payload = record(request.payload)
  const raw = record(payload.action)
  if (!Object.keys(raw).length) throw new Error('This action carried no edit')
  const serverId = typeof payload.serverId === 'string' ? payload.serverId : ''
  const entry =
    entries.find((candidate) => candidate.selection.server.id === serverId) ?? entries[0]
  if (!entry) throw new Error('The language server is no longer available')
  let resolved = raw
  const provider = record(entry.session.capabilities.codeActionProvider)
  if (raw.data !== undefined && provider.resolveProvider === true)
    resolved = record(
      await entry.session.request('codeAction/resolve', raw, INTELLIGENCE_TIMEOUT_MS)
    )
  let edit = resolved.edit
  const command = record(resolved.command)
  if (edit === undefined && typeof command.command === 'string') {
    let captured: unknown
    entry.session.applyEditHandler = (value) => {
      captured = value
    }
    try {
      await entry.session.request(
        'workspace/executeCommand',
        {
          command: command.command,
          arguments: Array.isArray(command.arguments) ? command.arguments : []
        },
        INTELLIGENCE_TIMEOUT_MS
      )
    } finally {
      entry.session.applyEditHandler = null
    }
    edit = captured
  }
  if (edit === undefined) {
    const title = typeof payload.title === 'string' ? payload.title : 'This action'
    throw new Error(`${title} returned no edit to apply`)
  }
  const grouped = workspaceEdits(edit)
  if (!grouped.size) {
    const title = typeof payload.title === 'string' ? payload.title : 'This action'
    throw new Error(`${title} returned no edit to apply`)
  }
  const next = applyTextEdits(text, grouped.get(uri) ?? []) ?? text
  const skippedFiles: string[] = []
  for (const key of grouped.keys()) {
    if (key === uri) continue
    if (!key.startsWith('file:')) {
      skippedFiles.push(key)
      continue
    }
    try {
      const path = fileURLToPath(key)
      skippedFiles.push(relative(root, path).split('\\').join('/'))
    } catch {
      skippedFiles.push(key)
    }
  }
  return { text: next, skippedFiles }
}
async function grep(
  root: string,
  request: IdeRequest,
  env: NodeJS.ProcessEnv
): Promise<IdeResponse> {
  searches.get(request.owner)?.kill()
  if (!request.query?.trim()) return { locations: [] }
  return new Promise((resolve, reject) => {
    const child = spawn(
      'rg',
      [
        '--json',
        '--fixed-strings',
        // Case-insensitive unless the reader asked for exact case.
        ...(request.caseSensitive ? [] : ['--ignore-case']),
        '--max-count',
        '20',
        '--max-filesize',
        '2M',
        '--glob',
        '!.cio/**',
        '--',
        request.query!,
        '.'
      ],
      { cwd: root, env, windowsHide: true }
    )
    searches.set(request.owner, child)
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    let bytes = 0
    const found: IdeLocation[] = []
    let truncated = false
    const timer = setTimeout(() => {
      truncated = true
      child.kill()
    }, 5_000)
    child.stderr.resume()
    child.stdout.on('data', (data: Buffer) => {
      bytes += data.length
      if (bytes > 4 * MAX_BYTES) {
        truncated = true
        child.kill()
        return
      }
      buffer += decoder.write(data)
      let end: number
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 1)
        try {
          const entry = record(JSON.parse(line))
          if (entry.type !== 'match') continue
          const data = record(entry.data)
          const path = String(record(data.path).text ?? '').replace(/^\.\//u, '')
          const text = String(record(data.lines).text ?? '')
          found.push({
            path,
            line: Number(data.line_number),
            character: 0,
            preview: text.trim().slice(0, 240)
          })
          if (found.length >= 200) {
            truncated = true
            child.kill()
            break
          }
        } catch {
          /* Ignore non-match output. */
        }
      }
    })
    child.on('error', () => {
      clearTimeout(timer)
      searches.delete(request.owner)
      reject(new Error('Project grep requires ripgrep (rg) on PATH.'))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (searches.get(request.owner) === child) searches.delete(request.owner)
      if (code !== null && code > 1) reject(new Error('Project grep failed'))
      else resolve({ locations: found, truncated })
    })
  })
}

const chains = new Map<string, Promise<unknown>>()
/**
 * How a request queues against the other requests of the same editor.
 *
 * Everything used to share one promise chain per editor, which was wrong in
 * both directions. A `close` (the tab unmounted) queued behind a hover that was
 * still loading a server, so the editor's 20 s watchdog killed a request that
 * had done nothing but wait. And two hovers queued behind one another, so the
 * second one answered only after the first had spent its whole load, which is
 * how a warm server still produced `hover timed out`.
 *
 * Only document lifecycle (open/sync/capabilities) needs ordering, because a
 * request must never reach a language server before its `didOpen`. A close
 * discards that work outright, and hover, definition and references always wait
 * for the document to be synced but never for each other.
 */
const DOCUMENT_ACTIONS = new Set(['sync', 'capabilities', 'format'])
const INTELLIGENCE_ACTIONS = new Set([
  'hover',
  'definition',
  'references',
  'completion',
  'resolveCompletion',
  'codeActions',
  'applyCodeAction'
])
/** Bumped by every close, so work that was already queued cannot resurrect a
 *  document the editor has left. */
const generations = new Map<string, number>()

/**
 * Pay a server's cold start before the user asks for an answer.
 *
 * A language server loads its project lazily, on the first request that needs
 * it: svelte-language-server took 11.8 s on this repository to answer the first
 * hover and 20-70 ms for every hover after that. Sending one throwaway hover as
 * soon as the document is synced moves that cost off the request the user is
 * waiting on, and the answer is discarded. Failures are ignored on purpose: the
 * real request reports them with the server's name attached.
 */
function warm(session: Session, uri: string): void {
  if (!session.capabilities.hoverProvider || session.warmed.has(uri)) return
  session.warmed.add(uri)
  // The app knows this request is running, even when the server reports nothing
  // about its own loading, so the panel names the wait instead of showing a
  // connected server that silently cannot answer yet. No percentage is invented:
  // only a server's own report carries one.
  session.noteProgress({ token: 'warmup', kind: 'begin', title: 'Preparing project' })
  const settle = (): void => session.noteProgress({ token: 'warmup', kind: 'end' })
  void session
    .request(
      'textDocument/hover',
      { textDocument: { uri }, position: { line: 0, character: 0 } },
      INTELLIGENCE_TIMEOUT_MS
    )
    .then(settle, settle)
}

/** The actions a file offers when any of its servers advertises them. */
function capabilitiesOf(sessions: Session[]) {
  return {
    definition: sessions.some((session) => Boolean(session.capabilities.definitionProvider)),
    references: sessions.some((session) => Boolean(session.capabilities.referencesProvider)),
    hover: sessions.some((session) => Boolean(session.capabilities.hoverProvider)),
    completion: sessions.some((session) => Boolean(session.capabilities.completionProvider)),
    codeActions: sessions.some((session) => Boolean(session.capabilities.codeActionProvider))
  }
}

/**
 * Ask the file's own language server to re-lay-out the document.
 *
 * Formatting is the server's job, not the app's: the server already holds the
 * syntax tree it parsed for navigation and knows the conventions of the language
 * it covers, so this is the one formatter that stays correct for TypeScript, CSS,
 * HTML, JSON and Svelte alike. A server that does not advertise formatting is not
 * an error   the document comes back untouched and the caller saves it as it is.
 */
async function formatDocument(
  entries: { session: Session; selection: Selection }[],
  uri: string,
  text: string
): Promise<IdeResponse> {
  const provider = entries.find((entry) =>
    Boolean(entry.session.capabilities.documentFormattingProvider)
  )
  if (!provider) return { text }
  const edits = await provider.session.request(
    'textDocument/formatting',
    { textDocument: { uri }, options: { tabSize: 2, insertSpaces: true } },
    INTELLIGENCE_TIMEOUT_MS
  )
  const formatted = applyTextEdits(text, edits)
  return { text: formatted ?? text }
}

/**
 * Apply a language server's edits to a document, bottom-up so every offset stays
 * valid, and return the new text. Edits that overlap or arrive malformed are
 * dropped rather than allowed to corrupt the file: a partial format is better
 * than a scrambled one, and the caller keeps the unformatted text when nothing
 * applies.
 */
function applyTextEdits(text: string, result: unknown): string | null {
  if (!Array.isArray(result)) return null
  const lineStarts = [0]
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) lineStarts.push(index + 1)
  }
  const offsetOf = (position: unknown): number | null => {
    const line = Number(record(position).line)
    const character = Number(record(position).character)
    if (!Number.isInteger(line) || !Number.isInteger(character)) return null
    if (line < 0 || line >= lineStarts.length || character < 0) return null
    const start = lineStarts[line]
    const breakIndex = text.indexOf('\n', start)
    const end = breakIndex === -1 ? text.length : breakIndex
    if (start + character > end) return null
    return start + character
  }
  const edits: { from: number; to: number; insert: string }[] = []
  for (const item of result) {
    const range = record(record(item).range)
    const from = offsetOf(range.start)
    const to = offsetOf(range.end)
    const insert = record(item).newText
    if (from === null || to === null || to < from || typeof insert !== 'string') continue
    edits.push({ from, to, insert })
  }
  if (!edits.length) return null
  edits.sort((left, right) => right.from - left.from || right.to - left.to)
  let formatted = text
  let boundary = text.length
  for (const edit of edits) {
    // A later edit in this loop starts before the previous one did; overlapping
    // ranges mean the server's answer is not safe to apply.
    if (edit.to > boundary) return null
    formatted = formatted.slice(0, edit.from) + edit.insert + formatted.slice(edit.to)
    boundary = edit.from
  }
  return formatted
}

/** Keep one server's copy of a document current, in the sync mode it asked for. */
function syncDocument(session: Session, uri: string, language: string, text: string): void {
  const previous = session.documents.get(uri)
  if (!previous) {
    session.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: language, version: 1, text }
    })
    session.documents.set(uri, { text, version: 1 })
    return
  }
  if (text === previous.text) return
  const version = previous.version + 1
  const sync = session.capabilities.textDocumentSync
  const kind = typeof sync === 'number' ? sync : record(sync).change
  const change =
    kind === 2
      ? {
          range: {
            start: { line: 0, character: 0 },
            end: {
              line: previous.text.split('\n').length - 1,
              character: previous.text.slice(previous.text.lastIndexOf('\n') + 1).length
            }
          },
          text
        }
      : { text }
  if (kind !== 0)
    session.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [change]
    })
  session.documents.set(uri, { text, version })
}
async function handle(
  root: string,
  request: IdeRequest,
  env: NodeJS.ProcessEnv,
  servers: IdeLanguageServer[]
): Promise<IdeResponse> {
  if (request.action === 'inventory')
    return {
      installations: await ideInstallations(
        env,
        request.serverId ? servers.filter((server) => server.id === request.serverId) : servers,
        request.query === 'updates'
      )
    }
  if (request.action === 'install') throw new Error('Setup must run through the IDE service')
  if (request.action === 'cancel') {
    searches.get(request.owner)?.kill()
    return {}
  }
  if (request.action === 'close') {
    closeOwner(request.owner)
    return {}
  }
  if (request.action === 'check') {
    const definition = servers.find((server) => server.id === request.serverId)
    if (!definition) throw new Error('Language server configuration not found')
    const session = await sessionFor(
      root,
      join(root, `__ide_check${definition.languages[0].extension}`),
      env,
      { ...definition, enabled: true }
    )
    const capabilities = capabilitiesOf([session])
    if (![...owners.values()].flat().some((owner) => owner.session === session)) session.stop()
    return { capabilities }
  }
  if (request.action === 'grep') return grep(root, request, env)
  validateRelativePath(request.path, false)
  const path = await realpath(resolve(root, request.path))
  if (!isWithinRoot(root, path)) throw new Error('File is outside the project')
  const selections = selectDefinitions(path, servers)
  if (!selections.length)
    throw new Error(
      'No enabled language server for this file type. Configure one in Settings > IDE Mode.'
    )
  // Inventory the servers this file needs before starting any of them. When
  // every one is missing, the answer is an installable state rather than an
  // error: the editor then knows what to install and can retry by itself, where
  // a thrown "not installed" used to leave the file silently without
  // intelligence and without the list that would make it installable.
  const requestedServers = selections.map((selection) => selection.server)
  const opening = request.action === 'sync' || request.action === 'capabilities'
  // Only a document open pays this walk. Hover, completion and code actions
  // run on every keystroke or mouse move, and the executable does not change
  // between them, so the disk lookup stays on the one request that needs it.
  const inventory = opening ? await ideInstallations(env, requestedServers, false) : undefined
  if (inventory?.length && inventory.every((item) => item.source === 'missing'))
    return { capabilities: capabilitiesOf([]), servers: [], installations: inventory }
  const uri = pathToFileURL(path).href
  const text = request.text ?? (await readFile(path, 'utf8'))
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('File is too large for IDE Mode')
  const entries: { session: Session; selection: Selection }[] = []
  let failure: unknown
  // Servers start in parallel: their loads are independent, and starting them
  // one after another made the slowest one's wait add up for every later
  // server instead of overlapping with it.
  const started = await Promise.allSettled(
    selections.map(async (selection) => ({
      session: await sessionFor(root, path, env, selection.server),
      selection
    }))
  )
  for (const result of started) {
    if (result.status === 'fulfilled') entries.push(result.value)
    // One server that is missing or broken must not disable the rest.
    else failure ??= result.reason
  }
  if (!entries.length)
    throw failure instanceof Error
      ? failure
      : new Error(String(failure ?? 'No language server could be started'))
  const currentOwner = owners.get(request.owner) ?? []
  const settled =
    currentOwner.length === entries.length &&
    currentOwner.every(
      (entry, index) => entry.session === entries[index].session && entry.uri === uri
    )
  if (currentOwner.length && !settled)
    closeOwner(request.owner, new Set(entries.map((entry) => entry.session)), uri)
  if (!settled) void ideInstallations(env, [selections[0].server], true).catch(() => undefined)
  for (const entry of entries) {
    syncDocument(entry.session, uri, entry.selection.mapping.languageId, text)
    warm(entry.session, uri)
  }
  owners.set(
    request.owner,
    entries.map((entry) => ({ session: entry.session, uri }))
  )
  const capabilities = capabilitiesOf(entries.map((entry) => entry.session))
  const connected = entries.map(({ session, selection }) => ({
    id: selection.server.id,
    name: selection.server.name,
    executable: session.child.spawnfile,
    root: session.root,
    language: selection.mapping.languageId,
    languages:
      selection.server.command === 'svelteserver'
        ? ['Svelte', 'HTML', 'CSS', 'JavaScript', 'TypeScript']
        : [selection.mapping.languageId]
  }))
  if (request.action === 'capabilities' || request.action === 'sync')
    return {
      capabilities,
      servers: connected,
      installations: inventory ?? (await ideInstallations(env, requestedServers, false))
    }
  if (request.action === 'format') return formatDocument(entries, uri, text)
  if (request.action === 'completion') return completionsFor(entries, uri, request, text)
  if (request.action === 'resolveCompletion') return resolveCompletion(entries, request)
  if (request.action === 'codeActions') return codeActionsFor(entries, uri, request, text)
  if (request.action === 'applyCodeAction')
    return applyCodeAction(entries, root, uri, request, text)
  if (!capabilities[request.action]) return { capabilities, locations: [] }
  const params = {
    textDocument: { uri },
    position: { line: request.line ?? 0, character: request.character ?? 0 },
    ...(request.action === 'references' ? { context: { includeDeclaration: true } } : {})
  }
  const providers = entries.filter((entry) =>
    Boolean(entry.session.capabilities[`${request.action}Provider`])
  )
  const results = await Promise.allSettled(
    providers.map((entry) =>
      entry.session
        .request(
          `textDocument/${request.action}`,
          params,
          request.action === 'references' ||
            request.action === 'hover' ||
            request.action === 'definition'
            ? INTELLIGENCE_TIMEOUT_MS
            : REQUEST_TIMEOUT_MS
        )
        .catch((error: unknown) => {
          throw new Error(
            `${entry.selection.server.name} could not answer ${request.action}. ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        })
    )
  )
  const answers: unknown[] = []
  let rejection: unknown
  for (const result of results) {
    if (result.status === 'fulfilled') answers.push(result.value)
    else rejection ??= result.reason
  }
  // One server failing must not hide the answers the others already produced.
  if (!answers.length && rejection !== undefined)
    throw new Error(rejection instanceof Error ? rejection.message : String(rejection))
  if (request.action === 'hover') {
    const docs = [
      ...new Set(
        answers
          .map((answer) => documentation(record(answer).contents).trim())
          .filter((value) => value.length > 0)
      )
    ]
    if (!docs.length) entries[0].session.explainEmptyResult()
    return { capabilities, documentation: docs.join('\n\n---\n\n').slice(0, 32_000) }
  }
  const merged = new Map<string, IdeLocation>()
  for (const answer of answers)
    for (const location of await locations(root, answer))
      merged.set(`${location.path}:${location.line}:${location.character}`, location)
  if (!merged.size) entries[0].session.explainEmptyResult()
  return { capabilities, locations: [...merged.values()].slice(0, 200) }
}
port.on(
  'message',
  (message: {
    id: number
    root: string
    request: IdeRequest
    env: NodeJS.ProcessEnv
    configure?: IdeLanguageServer[]
    servers?: IdeLanguageServer[]
    stop?: boolean
  }) => {
    if (message.configure) {
      configuredServers = message.configure
      const allowed = new Set(
        message.configure.filter((server) => server.enabled).map((server) => JSON.stringify(server))
      )
      for (const [owner, owned] of owners)
        if (owned.some((entry) => !allowed.has(entry.session.configurationKey))) closeOwner(owner)
      for (const session of liveSessions) if (!allowed.has(session.configurationKey)) session.stop()
      return
    }
    if (message.stop) {
      for (const child of searches.values()) child.kill()
      for (const session of liveSessions) session.stop()
      return
    }
    const { id, root, request, env } = message
    const key = request.owner
    const servers = configuredServers ?? message.servers ?? DEFAULT_IDE_LANGUAGE_SERVERS
    if (request.action === 'grep' || request.action === 'close' || request.action === 'cancel')
      searches.get(key)?.kill()
    const generation = generations.get(key) ?? 0
    const reply = (result: IdeResponse | null, error?: unknown): void =>
      port.postMessage({
        id,
        ...(error === undefined
          ? { result: result ?? {} }
          : { error: error instanceof Error ? error.message : String(error) }),
        idle: owners.size === 0 && searches.size === 0 && chains.size <= 1
      })
    const work = (): Promise<IdeResponse> => {
      // A close discards the queue: the editor is gone and must not be re-opened
      // by a sync that was sent a moment before it.
      if ((generations.get(key) ?? 0) !== generation) return Promise.resolve({})
      return handle(root, request, env, servers)
    }
    let task: Promise<IdeResponse>
    if (request.action === 'close') {
      // Bumped before the close runs, so older work is refused and cannot
      // resurrect the editor's documents afterwards.
      generations.set(key, generation + 1)
      chains.delete(key)
      task = handle(root, request, env, servers)
    } else if (request.action === 'cancel' || request.action === 'grep') {
      task = work()
    } else if (DOCUMENT_ACTIONS.has(request.action)) {
      task = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
      chains.set(key, task)
      // Cleared once it settles, so the map is a queue of live work rather than a
      // record of every editor that was ever open.
      const settle = (): void => {
        if (chains.get(key) === task) chains.delete(key)
      }
      void task.then(settle, settle)
    } else if (INTELLIGENCE_ACTIONS.has(request.action)) {
      // No chains.set: the next hover does not wait for this one.
      task = (chains.get(key) ?? Promise.resolve()).catch(() => undefined).then(work)
    } else {
      task = work()
    }
    void task.then(
      (result) => {
        // The editor closed while this ran. Its answer is worthless now, and the
        // documents the request just registered have to go with it, or a session
        // nobody owns keeps the whole worker alive.
        if (request.action !== 'close' && (generations.get(key) ?? 0) !== generation) {
          closeOwner(key)
          reply({})
          return
        }
        reply(result)
      },
      (error: unknown) => reply(null, error)
    )
  }
)
