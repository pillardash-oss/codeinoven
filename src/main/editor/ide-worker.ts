import { StringDecoder } from 'node:string_decoder'
import { parentPort } from 'node:worker_threads'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpath, readFile } from 'node:fs/promises'
import { delimiter, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isWithinRoot, validateRelativePath } from './project-files/project-files-paths'
import type { IdeRequest, IdeResponse, IdeLocation } from '../../lib/editor-ide'

const port = parentPort!
const MAX_BYTES = 2 * 1024 * 1024
const sessions = new Map<string, Promise<Session>>()
const owners = new Map<string, { session: Session; uri: string }>()
const searches = new Map<string, ReturnType<typeof spawn>>()
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}
const presets: Record<string, [string, string, string[]]> = {
  '.ts': ['typescript', 'typescript-language-server', ['--stdio']],
  '.mts': ['typescript', 'typescript-language-server', ['--stdio']],
  '.cts': ['typescript', 'typescript-language-server', ['--stdio']],
  '.mjs': ['javascript', 'typescript-language-server', ['--stdio']],
  '.cjs': ['javascript', 'typescript-language-server', ['--stdio']],
  '.tsx': ['typescriptreact', 'typescript-language-server', ['--stdio']],
  '.js': ['javascript', 'typescript-language-server', ['--stdio']],
  '.jsx': ['javascriptreact', 'typescript-language-server', ['--stdio']],
  '.svelte': ['svelte', 'svelteserver', ['--stdio']],
  '.py': ['python', 'pyright-langserver', ['--stdio']],
  '.rs': ['rust', 'rust-analyzer', []],
  '.go': ['go', 'gopls', []],
  '.c': ['c', 'clangd', []],
  '.cpp': ['cpp', 'clangd', []],
  '.h': ['c', 'clangd', []],
  '.css': ['css', 'vscode-css-language-server', ['--stdio']],
  '.html': ['html', 'vscode-html-language-server', ['--stdio']],
  '.json': ['json', 'vscode-json-language-server', ['--stdio']]
}

class Session {
  readonly documents = new Map<string, { text: string; version: number }>()
  capabilities: Record<string, unknown> = {}
  private stopped = false
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
    env: NodeJS.ProcessEnv
  ) {
    this.child = spawn(command, args, { cwd: root, env, stdio: 'pipe', windowsHide: true })
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
    this.child.stderr.resume()
    this.child.stdin.on('error', () => this.stop())
    this.child.on('error', () => this.stop())
    this.child.on('exit', () => this.stop())
  }
  send(message: object): void {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message })
    if (this.child.stdin.writableLength > 4 * MAX_BYTES) throw new Error('Language server is busy')
    this.child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`)
  }
  notify(method: string, params: unknown): void {
    this.send({ method, params })
  }
  request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.notify('$/cancelRequest', { id })
        reject(new Error('Language server request timed out'))
      }, 12_000)
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
        this.send({ id: message.id, result: Array.isArray(items) ? items.map(() => ({})) : [] })
      } else if (message.method === 'workspace/workspaceFolders') {
        this.send({
          id: message.id,
          result: [{ uri: pathToFileURL(this.root).href, name: this.root }]
        })
      } else if (
        message.method === 'client/registerCapability' ||
        message.method === 'window/workDoneProgress/create'
      ) {
        this.send({ id: message.id, result: null })
      } else {
        this.send({
          id: message.id,
          error: { code: -32601, message: 'This editor supports read-only language intelligence' }
        })
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
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.child.kill()
    const killTimer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL')
    }, 1000)
    killTimer.unref()
    this.child.once('exit', () => clearTimeout(killTimer))
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Language server stopped. Check that its executable is installed.'))
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

async function sessionFor(
  root: string,
  path: string,
  env: NodeJS.ProcessEnv
): Promise<{ session: Session; language: string }> {
  const preset = presets[extname(path)]
  if (!preset) throw new Error('No language server preset for this file type')
  const [language, command, args] = preset
  const key = `${root}\0${command}`
  let pending = sessions.get(key)
  if (!pending) {
    if (sessions.size >= 4)
      throw new Error('IDE Mode supports four active language servers. Close unused editors first.')
    pending = (async () => {
      const localEnv = {
        ...env,
        PATH: `${join(root, 'node_modules', '.bin')}${delimiter}${env.PATH ?? ''}`
      }
      const session = new Session(root, command, args, localEnv)
      try {
        const result = record(
          await session.request('initialize', {
            initializationOptions:
              command === 'typescript-language-server'
                ? {
                    tsserver: { useSyntaxServer: 'never' },
                    disableAutomaticTypingAcquisition: true,
                    maxTsServerMemory: 128
                  }
                : {},
            processId: process.pid,
            rootUri: pathToFileURL(root).href,
            workspaceFolders: [{ uri: pathToFileURL(root).href, name: root }],
            capabilities: {
              general: { positionEncodings: ['utf-16'] },
              workspace: { configuration: true, workspaceFolders: true },
              textDocument: {
                hover: { contentFormat: ['plaintext', 'markdown'] },
                definition: { linkSupport: true },
                synchronization: { dynamicRegistration: false, didSave: false }
              }
            }
          })
        )
        session.capabilities = record(result.capabilities)
        session.notify('initialized', {})
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
  }
  return { session: await pending, language }
}

function closeOwner(owner: string): void {
  searches.get(owner)?.kill()
  searches.delete(owner)
  const owned = owners.get(owner)
  owners.delete(owner)
  if (!owned) return
  if (
    ![...owners.values()].some(
      (value) => value.session === owned.session && value.uri === owned.uri
    )
  ) {
    owned.session.notify('textDocument/didClose', { textDocument: { uri: owned.uri } })
    owned.session.documents.delete(owned.uri)
  }
  if (![...owners.values()].some((value) => value.session === owned.session)) owned.session.stop()
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
async function handle(
  root: string,
  request: IdeRequest,
  env: NodeJS.ProcessEnv
): Promise<IdeResponse> {
  if (request.action === 'cancel') {
    searches.get(request.owner)?.kill()
    return {}
  }
  if (request.action === 'close') {
    closeOwner(request.owner)
    return {}
  }
  if (request.action === 'grep') return grep(root, request, env)
  validateRelativePath(request.path, false)
  const path = await realpath(resolve(root, request.path))
  if (!isWithinRoot(root, path)) throw new Error('File is outside the project')
  const { session, language } = await sessionFor(root, path, env)
  const uri = pathToFileURL(path).href
  const owned = owners.get(request.owner)
  owners.set(request.owner, { session, uri })
  if (owned && (owned.session !== session || owned.uri !== uri)) {
    const previousOwner = `${request.owner}:previous`
    owners.set(previousOwner, owned)
    closeOwner(previousOwner)
  }
  const text = request.text ?? (await readFile(path, 'utf8'))
  if (Buffer.byteLength(text) > MAX_BYTES) throw new Error('File is too large for IDE Mode')
  const previous = session.documents.get(uri)
  if (!previous) {
    session.notify('textDocument/didOpen', {
      textDocument: { uri, languageId: language, version: 1, text }
    })
    session.documents.set(uri, { text, version: 1 })
  } else if (text !== previous.text) {
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
  const capabilities = {
    definition: Boolean(session.capabilities.definitionProvider),
    references: Boolean(session.capabilities.referencesProvider),
    hover: Boolean(session.capabilities.hoverProvider)
  }
  if (request.action === 'capabilities' || request.action === 'sync') return { capabilities }
  if (!capabilities[request.action]) return { capabilities, locations: [] }
  const result = await session.request(`textDocument/${request.action}`, {
    textDocument: { uri },
    position: { line: request.line ?? 0, character: request.character ?? 0 },
    ...(request.action === 'references' ? { context: { includeDeclaration: true } } : {})
  })
  return request.action === 'hover'
    ? { capabilities, documentation: documentation(record(result).contents).slice(0, 32_000) }
    : { capabilities, locations: await locations(root, result) }
}
port.on(
  'message',
  (message: {
    id: number
    root: string
    request: IdeRequest
    env: NodeJS.ProcessEnv
    stop?: boolean
  }) => {
    if (message.stop) {
      for (const child of searches.values()) child.kill()
      for (const session of sessions.values())
        void session.then((value) => value.stop()).catch(() => undefined)
      return
    }
    const { id, root, request, env } = message
    const key = request.owner
    if (request.action === 'grep' || request.action === 'close' || request.action === 'cancel')
      searches.get(key)?.kill()
    const task = (chains.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => handle(root, request, env))
    chains.set(key, task)
    void task
      .then(
        (result) =>
          port.postMessage({
            id,
            result,
            idle: owners.size === 0 && searches.size === 0 && chains.size === 1
          }),
        (error) =>
          port.postMessage({
            id,
            error: error instanceof Error ? error.message : String(error),
            idle: owners.size === 0 && searches.size === 0 && chains.size === 1
          })
      )
      .finally(() => {
        if (chains.get(key) === task) chains.delete(key)
      })
  }
)
