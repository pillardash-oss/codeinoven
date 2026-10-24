import { resolveIdeExecutable } from './ide-executables'
import { ideInstallations } from './ide-installations'
import {
  DEFAULT_IDE_LANGUAGE_SERVERS,
  type IdeLanguageServer
} from '../../lib/ide-language-servers'
import { StringDecoder } from 'node:string_decoder'
import { parentPort } from 'node:worker_threads'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { realpath, readFile, stat } from 'node:fs/promises'
import { delimiter, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isWithinRoot, validateRelativePath } from './project-files/project-files-paths'
import type { IdeRequest, IdeResponse, IdeLocation } from '../../lib/editor-ide'

const port = parentPort!
const MAX_BYTES = 2 * 1024 * 1024
const sessions = new Map<string, Promise<Session>>()
const liveSessions = new Set<Session>()
let configuredServers: IdeLanguageServer[] | undefined
const owners = new Map<string, { session: Session; uri: string }>()
const searches = new Map<string, ReturnType<typeof spawn>>()
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {}

class Session {
  readonly documents = new Map<string, { text: string; version: number }>()
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
    readonly settings: Record<string, unknown>,
    readonly configurationKey: string
  ) {
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

function selectDefinition(path: string, servers: IdeLanguageServer[]) {
  return servers
    .flatMap((server) =>
      server.enabled
        ? server.languages
            .filter((mapping) => path.toLowerCase().endsWith(mapping.extension))
            .map((mapping) => ({ server, mapping }))
        : []
    )
    .sort((left, right) => right.mapping.extension.length - left.mapping.extension.length)[0]
}

async function sessionFor(
  root: string,
  path: string,
  env: NodeJS.ProcessEnv,
  servers: IdeLanguageServer[]
): Promise<{ session: Session; language: string }> {
  const selected = selectDefinition(path, servers)
  if (!selected)
    throw new Error(
      'No enabled language server for this file type. Configure one in Settings > IDE Mode.'
    )
  const definition = selected.server
  const language = selected.mapping.languageId
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
    if (sessions.size >= 4)
      throw new Error('IDE Mode supports four active language servers. Close unused editors first.')
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
      const session = new Session(
        workspaceRoot,
        executable,
        args,
        localEnv,
        definition.settings,
        JSON.stringify(definition)
      )
      try {
        const result = record(
          await session.request('initialize', {
            initializationOptions: definition.initializationOptions,
            processId: process.pid,
            rootUri: pathToFileURL(workspaceRoot).href,
            workspaceFolders: [{ uri: pathToFileURL(workspaceRoot).href, name: workspaceRoot }],
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
    const { session } = await sessionFor(
      root,
      join(root, `__ide_check${definition.languages[0].extension}`),
      env,
      [{ ...definition, enabled: true }]
    )
    const capabilities = {
      definition: Boolean(session.capabilities.definitionProvider),
      references: Boolean(session.capabilities.referencesProvider),
      hover: Boolean(session.capabilities.hoverProvider)
    }
    if (![...owners.values()].some((owner) => owner.session === session)) session.stop()
    return { capabilities }
  }
  if (request.action === 'grep') return grep(root, request, env)
  validateRelativePath(request.path, false)
  const path = await realpath(resolve(root, request.path))
  if (!isWithinRoot(root, path)) throw new Error('File is outside the project')
  const currentOwner = owners.get(request.owner)
  const selected = selectDefinition(path, servers)
  if (currentOwner && currentOwner.session.configurationKey !== JSON.stringify(selected?.server))
    closeOwner(request.owner)
  const { session, language } = await sessionFor(root, path, env, servers)
  if (
    selected &&
    (!currentOwner || currentOwner.session.configurationKey !== JSON.stringify(selected.server))
  )
    void ideInstallations(env, [selected.server], true).catch(() => undefined)
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
  const connected = [
    {
      id: selected!.server.id,
      name: selected!.server.name,
      executable: session.child.spawnfile,
      root: session.root,
      language,
      languages:
        selected!.server.command === 'svelteserver'
          ? ['Svelte', 'HTML', 'CSS', 'JavaScript', 'TypeScript']
          : [language]
    }
  ]
  if (request.action === 'capabilities' || request.action === 'sync')
    return {
      capabilities,
      servers: connected,
      installations: await ideInstallations(env, selected ? [selected.server] : [], false)
    }
  if (!capabilities[request.action]) return { capabilities, locations: [] }
  const result = await session.request(`textDocument/${request.action}`, {
    textDocument: { uri },
    position: { line: request.line ?? 0, character: request.character ?? 0 },
    ...(request.action === 'references' ? { context: { includeDeclaration: true } } : {})
  })
  if (!result || (Array.isArray(result) && result.length === 0)) session.explainEmptyResult()
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
        if (!allowed.has(owned.session.configurationKey)) closeOwner(owner)
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
    if (request.action === 'grep' || request.action === 'close' || request.action === 'cancel')
      searches.get(key)?.kill()
    const task = (chains.get(key) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() =>
        handle(
          root,
          request,
          env,
          configuredServers ?? message.servers ?? DEFAULT_IDE_LANGUAGE_SERVERS
        )
      )
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
