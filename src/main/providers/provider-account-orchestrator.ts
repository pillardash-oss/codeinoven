import { randomUUID } from 'crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import type { OfferedProvider } from '../../lib/types'
import type {
  HarnessAuthAccount,
  HarnessAuthCapabilities,
  HarnessAuthStatus,
  HarnessLoginHandoff,
  HarnessLoginOptions
} from '../drivers/driver.interface'
import { buildProcessEnvironment } from '../drivers/cli-environment'
import { antigravityModelSlugs } from '../drivers/antigravity-model-output'
import {
  prepareHarnessTerminalHandoff,
  readHarnessHomeFile,
  runHarnessCommand,
  writeHarnessHomeFile
} from '../drivers/harness-runtime'
import { PiAuthConfigService, type PiAuthFileIo } from './pi-auth-config'
import { listPiCatalogProviders } from './pi-catalog'
import { isPiOAuthProvider, runPiOAuthLogin } from './pi-oauth'
import { BrowserWindow } from 'electron'
import { sendToRenderer } from '../ipc/renderer-delivery'
import { forwardRemoteEvent } from '../remote/remote-event-forwarder'

const PI_NATIVE_AUTH_PATH = join(homedir(), '.pi', 'agent', 'auth.json')

/**
 * Transport that honors WSL-resident pi installs: read/write the auth file
 * inside the distro when pi runs there (matching `readPiStatus`'s view), and
 * fall back to a plain atomic write on the native filesystem otherwise.
 */
const piAuthFileIo: PiAuthFileIo = {
  async read(): Promise<string | null> {
    const wslRaw = await readHarnessHomeFile('pi', '.pi/agent/auth.json').catch(() => undefined)
    if (wslRaw !== undefined) return wslRaw
    try {
      return await readFile(PI_NATIVE_AUTH_PATH, 'utf8')
    } catch {
      return null
    }
  },
  async write(content: string): Promise<void> {
    if (await writeHarnessHomeFile('pi', '.pi/agent/auth.json', content)) return
    await mkdir(dirname(PI_NATIVE_AUTH_PATH), { recursive: true })
    const temporaryPath = `${PI_NATIVE_AUTH_PATH}.${process.pid}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      await rename(temporaryPath, PI_NATIVE_AUTH_PATH)
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

/** Shared headless store for harnesses whose credentials live in files (Pi). */
const fileBackedAuth = new PiAuthConfigService(undefined, piAuthFileIo)

const STATUS_TIMEOUT_MS = 10_000
/** Status commands should emit a small response. Stop broken CLIs before they consume RAM. */
const STATUS_OUTPUT_MAX_BYTES = 64 * 1024
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu')
/** Cline keeps provider/API-key state in JSON; the CLI has no status subcommand. */
const CLINE_SETTINGS_DIR = join(homedir(), '.cline', 'data', 'settings')
/** Pi keeps configured providers in models.json; the CLI has no status subcommand. */
const PI_AGENT_DIR = join(homedir(), '.pi', 'agent')
/** OpenCode's global config file — hiding providers edits disabled_providers here. */
const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json')
const OPENCODE_CONFIG_FORMAT = { tabSize: 2, insertSpaces: true, eol: '\n' }
/** Muse Code stores OAuth credentials here (or $XDG_CONFIG_HOME/muse/auth.json). */
const MUSE_AUTH_PATH = join(homedir(), '.config', 'muse', 'auth.json')

interface AuthDefinition {
  id: string
  name: string
  command: string
  statusArgs?: string[]
  parseStatus?(output: string, succeeded: boolean): HarnessAuthStatus
  /** Alternative to CLI probing for harnesses without a status subcommand. */
  readStatus?(projectPath?: string): Promise<HarnessAuthStatus>
  loginArgs(options: HarnessLoginOptions): string[]
  /** CLI arguments that remove a provider's stored credentials. */
  logoutArgs?(providerId?: string): string[]
  /**
   * Whether the bare login command shows the harness's own interactive provider
   * picker (so the UI skips its in-app provider list and lets the user choose).
   */
  pickerLogin?: boolean
  /**
   * The harness keeps credentials in a file CodeInOven can manage headlessly:
   * catalog providers can be connected by storing an API key, and connected
   * ones disconnected by removing the stored credential.
   */
  apiKeyEntry?: boolean
  /** Store an API key for one provider in the harness's own auth store. */
  setCredential?(providerId: string, apiKey: string): Promise<void>
  /** Remove one provider's stored credential (used for disconnect). */
  removeStoredCredential?(providerId: string): Promise<void>
}

interface CommandResult {
  succeeded: boolean
  stdout: string
  stderr: string
  error?: string
}

const READ_AND_HANDOFF_ONLY: HarnessAuthCapabilities = {
  status: true,
  loginHandoff: true,
  logout: false,
  accountActivation: false,
  multipleAccounts: false,
  pickerLogin: false,
  apiKeyEntry: false
}

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, '')
}

function accountId(label: string): string {
  return (
    label
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/gu, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, '-')
      .replace(/^-+|-+$/gu, '') || 'account'
  )
}

function parseOpenCodeStatus(output: string, succeeded: boolean): HarnessAuthStatus {
  const clean = stripAnsi(output)
  const accounts: HarnessAuthAccount[] = clean
    .split(/\r?\n/u)
    .map((line) => line.match(/●\s+(.+?)\s+(api|oauth)\s*$/iu))
    .filter((match): match is RegExpMatchArray => match !== null)
    .map((match) => {
      const label = match[1]?.trim() ?? 'Provider'
      return {
        id: accountId(label),
        label,
        method: match[2]?.toLowerCase()
      }
    })
  const count = clean.match(/\b(\d+)\s+credentials?\b/iu)
  if (count) {
    return {
      state: Number.parseInt(count[1] ?? '0', 10) > 0 ? 'authenticated' : 'unauthenticated',
      accounts
    }
  }
  return {
    state: succeeded ? 'unknown' : 'error',
    accounts,
    detail: 'OpenCode did not report a recognizable credential status.'
  }
}

function parseClaudeStatus(output: string, succeeded: boolean): HarnessAuthStatus {
  try {
    const parsed = JSON.parse(output) as unknown
    if (parsed && typeof parsed === 'object') {
      const status = parsed as Record<string, unknown>
      const loggedIn = status['loggedIn'] === true
      const method = typeof status['authMethod'] === 'string' ? status['authMethod'] : undefined
      const provider =
        typeof status['apiProvider'] === 'string' ? status['apiProvider'] : 'Anthropic'
      return {
        state: loggedIn ? 'authenticated' : 'unauthenticated',
        accounts: loggedIn
          ? [
              {
                id: accountId(provider),
                label: provider,
                ...(method ? { method } : {}),
                active: true
              }
            ]
          : []
      }
    }
  } catch {
    // Fall through to a bounded, non-sensitive status.
  }
  return {
    state: succeeded ? 'unknown' : 'error',
    accounts: [],
    detail: 'Claude Code did not report a recognizable authentication status.'
  }
}

function parseCodexStatus(output: string, succeeded: boolean): HarnessAuthStatus {
  const clean = stripAnsi(output).trim()
  if (/not logged in|logged out|no authentication/iu.test(clean)) {
    return { state: 'unauthenticated', accounts: [] }
  }
  const match = clean.match(/logged in(?:\s+using)?\s+(.+)/iu)
  if (match) {
    const label = match[1]?.trim() ?? 'OpenAI'
    return {
      state: 'authenticated',
      accounts: [{ id: accountId(label), label, active: true }]
    }
  }
  return {
    state: succeeded ? 'unknown' : 'error',
    accounts: [],
    detail: 'Codex did not report a recognizable login status.'
  }
}

/**
 * Antigravity keeps its Google credentials in the OS keyring and exposes no
 * `auth status` subcommand. `agy models` only lists model slugs when signed in
 * and otherwise exits with a "please sign in" notice, so it doubles as the
 * auth probe: model slugs imply an authenticated Google account.
 */
function parseAntigravityStatus(output: string, succeeded: boolean): HarnessAuthStatus {
  const clean = stripAnsi(output).trim()
  if (/please sign in|sign in to view|authentication required/iu.test(clean)) {
    return { state: 'unauthenticated', accounts: [] }
  }
  const hasSlugs = antigravityModelSlugs(clean).length > 0
  if (hasSlugs) {
    return {
      state: 'authenticated',
      accounts: [{ id: 'google', label: 'Google', active: true }]
    }
  }
  return {
    state: succeeded ? 'unknown' : 'error',
    accounts: [],
    detail: 'Antigravity did not report a recognizable authentication status.'
  }
}

/**
 * Antigravity CLI reads stdin and hangs when that pipe stays open without EOF,
 * so the shared execFile-based probe cannot be used. Spawn `agy models` with
 * stdin ignored and let the common parser classify the result.
 */
async function readAntigravityStatus(): Promise<HarnessAuthStatus> {
  let result: { succeeded: boolean; stdout: string; stderr: string }
  try {
    const output = await runHarnessCommand('agy', ['models'], {
      env: buildProcessEnvironment(),
      timeoutMs: STATUS_TIMEOUT_MS,
      maxOutputBytes: STATUS_OUTPUT_MAX_BYTES
    })
    result = { succeeded: true, ...output }
  } catch (error) {
    result = {
      succeeded: false,
      stdout: '',
      stderr: error instanceof Error ? error.message : String(error)
    }
  }
  const output = result.stdout.trim() || result.stderr.trim()
  return parseAntigravityStatus(output, result.succeeded)
}

/**
 * Cline stores provider auth state in `~/.cline/data/settings/providers.json` and the
 * CLI exposes no `auth status` subcommand (`cline auth <name>` only configures a
 * provider). Each configured provider is reported as an authenticated account.
 */
async function readClineStatus(projectPath?: string): Promise<HarnessAuthStatus> {
  let stored: Record<string, unknown>
  try {
    const wslRaw = await readHarnessHomeFile(
      'cline',
      '.cline/data/settings/providers.json',
      projectPath
    )
    const raw =
      wslRaw === undefined
        ? await readFile(join(CLINE_SETTINGS_DIR, 'providers.json'), 'utf8')
        : wslRaw
    if (raw === null) return { state: 'unauthenticated', accounts: [] }
    stored = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { state: 'unauthenticated', accounts: [] }
  }
  const providers = stored['providers']
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    return { state: 'unauthenticated', accounts: [] }
  }
  const lastUsed =
    typeof stored['lastUsedProvider'] === 'string' ? stored['lastUsedProvider'] : undefined
  const accounts: HarnessAuthAccount[] = []
  for (const [providerId, rawEntry] of Object.entries(providers as Record<string, unknown>)) {
    const entry = rawEntry as Record<string, unknown> | null
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const method = typeof entry['tokenSource'] === 'string' ? entry['tokenSource'] : undefined
    accounts.push({
      id: accountId(providerId),
      label: providerId,
      ...(method === undefined ? {} : { method }),
      active: providerId === lastUsed
    })
  }
  return {
    state: accounts.length > 0 ? 'authenticated' : 'unauthenticated',
    accounts
  }
}

/**
 * Pi stores configured providers in `~/.pi/agent/models.json` and credentials
 * (api keys and OAuth tokens written by both the TUI and CodeInOven) in
 * `auth.json` — a record keyed by provider id. A provider is reported as an
 * authenticated account when its models.json entry carries an API key or a
 * credential exists in auth.json; credentials without a models.json entry are
 * still connected providers and must be listed.
 */
async function readPiStatus(projectPath?: string): Promise<HarnessAuthStatus> {
  const credentialIds = await fileBackedAuth.credentialIds()
  let stored: Record<string, unknown> = {}
  try {
    const wslRaw = await readHarnessHomeFile('pi', '.pi/agent/models.json', projectPath)
    const raw =
      wslRaw === undefined ? await readFile(join(PI_AGENT_DIR, 'models.json'), 'utf8') : wslRaw
    if (raw !== null) stored = JSON.parse(raw) as Record<string, unknown>
  } catch {
    stored = {}
  }
  const providers = record(stored['providers']) ?? {}
  const accounts: HarnessAuthAccount[] = []
  let signedIn = 0
  for (const [providerId, rawEntry] of Object.entries(providers)) {
    const entry = record(rawEntry)
    if (!entry) continue
    const apiKey = typeof entry['apiKey'] === 'string' ? entry['apiKey'] : undefined
    const authenticated =
      Boolean(apiKey && apiKey !== 'none') || credentialIds.has(providerId)
    accounts.push({
      id: accountId(providerId),
      label: providerId,
      active: authenticated
    })
    if (authenticated) signedIn += 1
  }
  // Credentials stored directly in auth.json (catalog providers connected via
  // CodeInOven or pi's own sign-in) are connected even without a models.json
  // entry.
  for (const providerId of credentialIds) {
    if (accounts.some((account) => account.label === providerId)) continue
    accounts.push({
      id: accountId(providerId),
      label: providerId,
      ...(await fileBackedAuth.isOauth(providerId) ? { method: 'oauth' } : {}),
      active: true
    })
    signedIn += 1
  }
  return {
    state: signedIn > 0 ? 'authenticated' : accounts.length > 0 ? 'unauthenticated' : 'unknown',
    accounts
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

/**
 * Muse keeps OAuth credentials in `~/.config/muse/auth.json` (or
 * `$XDG_CONFIG_HOME/muse/auth.json`) and honors a `META_API_KEY` env var that
 * takes priority over a logged-in session. The CLI exposes no `auth status`
 * subcommand, so the auth file is read directly. Its shape is
 * `{ schema_version, providers: { <id>: { access_token, api_key, ... } } }` —
 * a provider is authenticated when it carries an `access_token` or `api_key`.
 */
async function readMuseStatus(projectPath?: string): Promise<HarnessAuthStatus> {
  if (process.env['META_API_KEY']) {
    return {
      state: 'authenticated',
      accounts: [{ id: 'meta', label: 'Meta', method: 'api-key', active: true }]
    }
  }
  let stored: Record<string, unknown>
  try {
    const wslRaw = await readHarnessHomeFile('muse', '.config/muse/auth.json', projectPath)
    const raw = wslRaw === undefined ? await readFile(MUSE_AUTH_PATH, 'utf8') : wslRaw
    if (raw === null) return { state: 'unauthenticated', accounts: [] }
    stored = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { state: 'unauthenticated', accounts: [] }
  }
  const providers = stored['providers']
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    return { state: 'unauthenticated', accounts: [] }
  }
  const accounts: HarnessAuthAccount[] = []
  let signedIn = 0
  for (const [providerId, rawEntry] of Object.entries(providers as Record<string, unknown>)) {
    const entry = rawEntry as Record<string, unknown> | null
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const token = typeof entry['access_token'] === 'string' ? entry['access_token'] : undefined
    const apiKey = typeof entry['api_key'] === 'string' ? entry['api_key'] : undefined
    const authenticated = Boolean((token && token.length > 0) || (apiKey && apiKey.length > 0))
    const method =
      typeof entry['mechanism'] === 'string'
        ? entry['mechanism']
        : typeof entry['obtained_via'] === 'string'
          ? entry['obtained_via']
          : authenticated
            ? 'oauth'
            : undefined
    accounts.push({
      id: accountId(providerId),
      label: (typeof entry['user_full_name'] === 'string' && entry['user_full_name']) || providerId,
      ...(method === undefined ? {} : { method }),
      active: authenticated
    })
    if (authenticated) signedIn += 1
  }
  return {
    state: signedIn > 0 ? 'authenticated' : 'unauthenticated',
    accounts
  }
}

/** Provider ids listed under `disabled_providers` in OpenCode's global config. */
async function readHiddenProviders(): Promise<string[]> {
  try {
    const wslRaw = await readHarnessHomeFile('opencode', '.config/opencode/opencode.json')
    const raw = wslRaw === undefined ? await readConfigOrEmpty(OPENCODE_CONFIG_PATH) : wslRaw
    if (raw === null) return []
    const errors: ParseError[] = []
    const parsed = parse(raw, errors, { allowTrailingComma: true })
    if (errors.length === 0 && parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const list = (parsed as Record<string, unknown>)['disabled_providers']
      if (Array.isArray(list)) {
        return Array.from(
          new Set(list.filter((entry): entry is string => typeof entry === 'string'))
        )
      }
    }
    return []
  } catch {
    return []
  }
}

/**
 * Merge `disabled_providers` into OpenCode's global config with a targeted text
 * edit, so the rest of the file (comments, trailing commas, other keys)
 * round-trips untouched. Written atomically so a harness config is never left
 * half-written.
 */
async function writeHiddenProviders(providers: string[]): Promise<void> {
  const wslRaw = await readHarnessHomeFile('opencode', '.config/opencode/opencode.json')
  const raw =
    wslRaw === undefined ? await readConfigOrEmpty(OPENCODE_CONFIG_PATH) : (wslRaw ?? '{}\n')
  const edited = applyEdits(
    raw,
    modify(raw, ['disabled_providers'], providers, {
      formattingOptions: OPENCODE_CONFIG_FORMAT
    })
  )
  const content = edited.endsWith('\n') ? edited : `${edited}\n`
  if (await writeHarnessHomeFile('opencode', '.config/opencode/opencode.json', content)) return

  const configDir = dirname(OPENCODE_CONFIG_PATH)
  await mkdir(configDir, { recursive: true })
  const temporaryPath = `${OPENCODE_CONFIG_PATH}.${process.pid}.${randomUUID()}.tmp`
  try {
    await writeFile(temporaryPath, content, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600
    })
    await rename(temporaryPath, OPENCODE_CONFIG_PATH)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}

async function readConfigOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '{}\n'
    throw error
  }
}

const AUTH_DEFINITIONS: AuthDefinition[] = [
  {
    id: 'opencode',
    name: 'OpenCode',
    command: 'opencode',
    statusArgs: ['auth', 'list'],
    parseStatus: parseOpenCodeStatus,
    loginArgs: (options) => [
      'auth',
      'login',
      ...(options.providerId ? ['--provider', options.providerId] : [])
    ],
    logoutArgs: (providerId) => ['auth', 'logout', ...(providerId ? [providerId] : [])],
    pickerLogin: true
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    command: 'claude',
    statusArgs: ['auth', 'status', '--json'],
    parseStatus: parseClaudeStatus,
    loginArgs: (options) => [
      'auth',
      'login',
      ...(options.mode === 'console' ? ['--console'] : []),
      ...(options.mode === 'subscription' ? ['--claudeai'] : []),
      ...(options.accountHint ? ['--email', options.accountHint] : []),
      ...(options.sso ? ['--sso'] : [])
    ],
    logoutArgs: () => ['auth', 'logout']
  },
  {
    id: 'cline',
    name: 'Cline',
    command: 'cline',
    readStatus: readClineStatus,
    loginArgs: (options) => ['auth', ...(options.providerId ? [options.providerId] : [])]
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    statusArgs: ['login', 'status'],
    parseStatus: parseCodexStatus,
    loginArgs: (options) => ['login', ...(options.mode === 'device' ? ['--device-auth'] : [])]
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    readStatus: readPiStatus,
    // No terminal handoff: connecting happens in-app (API key) so a beginner
    // never meets Pi's full TUI. OAuth flows stay available in pi itself.
    loginArgs: () => [],
    apiKeyEntry: true,
    setCredential: (providerId, apiKey) => fileBackedAuth.setApiKey(providerId, apiKey),
    removeStoredCredential: (providerId) => fileBackedAuth.removeCredential(providerId)
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    command: 'agy',
    readStatus: readAntigravityStatus,
    loginArgs: () => [],
    pickerLogin: true
  },
  {
    id: 'muse',
    name: 'Muse Code',
    command: 'muse',
    readStatus: readMuseStatus,
    loginArgs: () => ['login'],
    logoutArgs: () => ['logout'],
    pickerLogin: true
  }
]

/**
 * Account status, offered-provider catalogs, and explicit login/logout flows
 * for local harnesses. Login and logout commands are handed to the UI, which
 * runs them inside a user-visible embedded terminal — CodeInOven never mutates
 * a harness credential store on its own.
 */
export class ProviderAccountOrchestrator {
  private statusQueueTail: Promise<void> = Promise.resolve()
  /** Live in-app OAuth sign-ins (Pi), awaiting user prompts / completion. */
  private oauthSessions = new Map<
    string,
    {
      controller: AbortController
      pendingPrompt?: (value: string) => void
    }
  >()

  capabilities(harnessId: string): HarnessAuthCapabilities | null {
    const definition = this.definition(harnessId)
    if (!definition) return null
    return {
      ...READ_AND_HANDOFF_ONLY,
      logout: definition.logoutArgs !== undefined || definition.removeStoredCredential !== undefined,
      pickerLogin: definition.pickerLogin === true,
      apiKeyEntry: definition.apiKeyEntry === true
    }
  }

  /** Store an API key for one catalog provider in a file-backed auth store. */
  async setCredential(harnessId: string, providerId: string, apiKey: string): Promise<void> {
    const definition = this.requireDefinition(harnessId)
    if (!definition.setCredential) {
      throw new Error(
        `${harnessId} does not support headless credential storage. Use the harness's own sign-in flow.`
      )
    }
    await definition.setCredential(providerId, apiKey)
  }

  /**
   * Start a fully in-app OAuth sign-in for a Pi catalog provider: browser URL
   * and device codes are broadcast to the UI, prompts (paste-the-code, select)
   * are answered via {@link respondOAuthPrompt}, and the resulting credential
   * is stored in Pi's own auth store. Mirrors what Pi's TUI does — without the
   * TUI.
   */
  async beginOAuthLogin(harnessId: string, providerId: string): Promise<string> {
    this.requireDefinition(harnessId)
    if (harnessId !== 'pi') {
      throw new Error(`${harnessId} does not support in-app OAuth sign-in.`)
    }
    if (!isPiOAuthProvider(providerId)) {
      throw new Error(`"${providerId}" connects with an API key, not OAuth.`)
    }
    const loginId = `pi-oauth-${crypto.randomUUID()}`
    const controller = new AbortController()
    const session: { controller: AbortController; pendingPrompt?: (value: string) => void } = {
      controller
    }
    this.oauthSessions.set(loginId, session)
    void runPiOAuthLogin(providerId, {
      signal: controller.signal,
      onEvent: (event) => this.broadcastOAuthEvent(loginId, { kind: 'event', event }),
      prompt: (prompt) =>
        new Promise<string>((resolve, reject) => {
          const promptId = `${loginId}-p-${crypto.randomUUID()}`
          session.pendingPrompt = resolve
          this.broadcastOAuthEvent(loginId, { kind: 'prompt', promptId, prompt })
          controller.signal.addEventListener(
            'abort',
            () => reject(new Error('Sign-in was cancelled.')),
            { once: true }
          )
        })
    })
      .then(async (credential) => {
        await fileBackedAuth.setOAuthCredential(providerId, credential)
        this.broadcastOAuthEvent(loginId, { kind: 'complete', providerId })
      })
      .catch((error: unknown) => {
        this.broadcastOAuthEvent(loginId, {
          kind: 'failed',
          error: error instanceof Error ? error.message : String(error)
        })
      })
      .finally(() => this.oauthSessions.delete(loginId))
    return loginId
  }

  /** Answer the outstanding prompt of a running OAuth sign-in. */
  respondOAuthPrompt(loginId: string, value: string): void {
    const session = this.oauthSessions.get(loginId)
    const pending = session?.pendingPrompt
    if (!session || !pending) throw new Error('No sign-in prompt is waiting for an answer.')
    session.pendingPrompt = undefined
    pending(value)
  }

  /** Cancel a running OAuth sign-in. */
  cancelOAuthLogin(loginId: string): void {
    this.oauthSessions.get(loginId)?.controller.abort()
    this.oauthSessions.delete(loginId)
  }

  private broadcastOAuthEvent(loginId: string, payload: Record<string, unknown>): void {
    for (const win of BrowserWindow.getAllWindows()) {
      sendToRenderer(win.webContents, 'providerAccounts:oauthEvent', { loginId, ...payload })
    }
    forwardRemoteEvent('providerAccounts:oauthEvent', { loginId, ...payload })
  }

  async getStatus(harnessId: string, projectPath?: string): Promise<HarnessAuthStatus> {
    return this.enqueueStatus(async () => {
      const definition = this.requireDefinition(harnessId)
      if (definition.readStatus) {
        return definition.readStatus(projectPath)
      }
      const result = await this.run(definition.command, definition.statusArgs ?? [], projectPath)
      if (!definition.parseStatus) {
        return {
          state: 'error',
          accounts: [],
          detail: `Status parsing is not implemented for harness: ${harnessId}`
        }
      }
      const output = result.stdout.trim() || result.stderr.trim()
      const status = definition.parseStatus(output, result.succeeded)
      if (status.state === 'error' && result.error) {
        return { ...status, detail: result.error }
      }
      return status
    })
  }

  async beginLogin(
    harnessId: string,
    options: HarnessLoginOptions = {}
  ): Promise<HarnessLoginHandoff> {
    const definition = this.requireDefinition(harnessId)
    const prepared = await prepareHarnessTerminalHandoff(
      definition.command,
      definition.loginArgs(options)
    )
    return {
      kind: 'terminal',
      command: prepared.command,
      args: prepared.args,
      title: `Sign in to ${definition.name}`,
      mutatesGlobalCredentials: true
    }
  }

  /** Remove a stored harness credential via its CLI logout or auth store. */
  async logout(harnessId: string, providerId?: string): Promise<void> {
    const definition = this.requireDefinition(harnessId)
    if (definition.removeStoredCredential) {
      if (!providerId) throw new Error(`${harnessId} requires a provider to disconnect.`)
      await definition.removeStoredCredential(providerId)
      return
    }
    if (!definition.logoutArgs) {
      throw new Error(
        `${harnessId} does not expose a logout command. Remove the credential in the harness itself.`
      )
    }
    const result = await this.run(definition.command, definition.logoutArgs(providerId), homedir())
    if (!result.succeeded) {
      const detail = result.error ?? (result.stderr.trim() || result.stdout.trim())
      throw new Error(`Logout failed: ${detail || 'unknown error'}`)
    }
  }

  /**
   * The providers a harness offers for connection, surfaced from its catalog.
   * OpenCode's bare login (`opencode auth login`) presents its own interactive
   * picker of every known provider, so there is nothing to enumerate here — the
   * honestly reportable set is whatever the harness is already connected to.
   * The others are small enough to enumerate from their own configuration.
   */
  async listOffered(harnessId: string): Promise<OfferedProvider[]> {
    const definition = this.requireDefinition(harnessId)
    switch (definition.id) {
      case 'opencode': {
        const status = await this.getStatus(harnessId)
        if (status.state === 'error') return []
        return status.accounts.map((account) => ({
          id: account.id,
          name: account.label,
          modelCount: 0,
          authenticated: status.state === 'authenticated'
        }))
      }
      case 'claude-code':
        return [{ id: 'anthropic', name: 'Anthropic', modelCount: 0, authenticated: false }]
      case 'codex':
        return [{ id: 'openai', name: 'OpenAI', modelCount: 0, authenticated: false }]
      case 'cline': {
        const status = await readClineStatus()
        return status.accounts.map((account) => ({
          id: account.label,
          name: account.label,
          modelCount: 0,
          authenticated: status.state === 'authenticated'
        }))
      }
      case 'pi':
        return this.listPiOffered()
      case 'antigravity': {
        const status = await this.getStatus(harnessId)
        if (status.state === 'error') return []
        return status.accounts.map((account) => ({
          id: account.id,
          name: account.label,
          modelCount: 0,
          authenticated: status.state === 'authenticated'
        }))
      }
      case 'muse': {
        const status = await this.getStatus(harnessId)
        if (status.state === 'error') return []
        return status.accounts.map((account) => ({
          id: account.id,
          name: account.label,
          modelCount: 0,
          authenticated: status.state === 'authenticated'
        }))
      }
      default:
        return []
    }
  }

  /**
   * Pi offers every catalog provider, not just connected ones. Connectivity is
   * a stored auth.json credential or an API-keyed entry in its native
   * models.json. Falls back to the configured-accounts view when the catalog
   * probe cannot run.
   */
  private async listPiOffered(): Promise<OfferedProvider[]> {
    const native = await readPiStatus()
    const keyedNativeIds = new Set(
      native.accounts.filter((account) => account.active === true).map((account) => account.label)
    )
    let catalog: OfferedProvider[]
    try {
      catalog = await listPiCatalogProviders()
    } catch {
      return native.accounts.map((account) => ({
        id: account.label,
        name: account.label,
        modelCount: 0,
        authenticated: keyedNativeIds.has(account.label)
      }))
    }
    const merged = new Map(catalog.map((provider) => [provider.id, provider]))
    // Native custom providers from models.json are connectable targets too and
    // may not appear in the bundled catalog.
    for (const account of native.accounts) {
      if (!merged.has(account.label)) {
        merged.set(account.label, {
          id: account.label,
          name: account.label,
          modelCount: 0,
          authenticated: false
        })
      }
    }
    for (const provider of merged.values()) {
      if (
        !provider.authenticated &&
        ((await fileBackedAuth.hasCredential(provider.id)) || keyedNativeIds.has(provider.id))
      ) {
        provider.authenticated = true
      }
    }
    return [...merged.values()]
  }

  /** Provider IDs currently hidden from the harness (via its own config). */
  async getHiddenProviders(harnessId: string): Promise<string[]> {
    if (harnessId !== 'opencode') return []
    return readHiddenProviders()
  }

  /** Add or remove a provider id in the harness's disabled_providers config. */
  async setProviderHidden(
    harnessId: string,
    providerId: string,
    hidden: boolean
  ): Promise<string[]> {
    if (harnessId !== 'opencode') {
      throw new Error(`${harnessId} does not support hiding providers from its config file.`)
    }
    const current = await readHiddenProviders()
    const next = new Set(current)
    if (hidden) {
      next.add(providerId)
    } else {
      next.delete(providerId)
    }
    const list = Array.from(next)
    await writeHiddenProviders(list)
    return list
  }

  async activateAccount(harnessId: string, _accountId: string): Promise<void> {
    this.requireDefinition(harnessId)
    void _accountId
    throw new Error(
      `${harnessId} account activation is not available without an isolated credential profile.`
    )
  }

  // ─── Offered-provider catalog ──────────────────────────────────────────────

  private definition(harnessId: string): AuthDefinition | undefined {
    return AUTH_DEFINITIONS.find((definition) => definition.id === harnessId)
  }

  private requireDefinition(harnessId: string): AuthDefinition {
    const definition = this.definition(harnessId)
    if (!definition) throw new Error(`Authentication is not supported for harness: ${harnessId}`)
    return definition
  }

  private async run(command: string, args: string[], cwd?: string): Promise<CommandResult> {
    try {
      const result = await runHarnessCommand(command, args, {
        ...(cwd ? { cwd } : {}),
        env: buildProcessEnvironment(),
        timeoutMs: STATUS_TIMEOUT_MS,
        maxOutputBytes: STATUS_OUTPUT_MAX_BYTES
      })
      return { succeeded: true, ...result }
    } catch (error) {
      return {
        succeeded: false,
        stdout: '',
        stderr: '',
        error: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /** Serialize status reads and CLI probes across every renderer caller. */
  private enqueueStatus<T>(task: () => Promise<T>): Promise<T> {
    const preceding = this.statusQueueTail
    let release: () => void = () => undefined
    this.statusQueueTail = new Promise<void>((resolve) => {
      release = resolve
    })
    return preceding.then(task).finally(release)
  }
}
