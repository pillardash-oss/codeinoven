import { execFile, spawn } from 'child_process'
import { readFileSync } from 'fs'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { dirname, join } from 'path'
import type { OfferedProvider } from '../../lib/types'
import type {
  HarnessAuthAccount,
  HarnessAuthCapabilities,
  HarnessAuthStatus,
  HarnessLoginHandoff,
  HarnessLoginOptions
} from '../drivers/driver.interface'
import { buildHarnessEnvironment } from '../drivers/cli-environment'
import { antigravityModelSlugs } from '../drivers/antigravity-model-output'

const STATUS_TIMEOUT_MS = 10_000
const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'gu')
/** Cline keeps provider/API-key state in JSON; the CLI has no status subcommand. */
const CLINE_SETTINGS_DIR = join(homedir(), '.cline', 'data', 'settings')
/** Pi keeps configured providers in models.json; the CLI has no status subcommand. */
const PI_AGENT_DIR = join(homedir(), '.pi', 'agent')
/** OpenCode's global config file — hiding providers writes disabled_providers here. */
const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.json')
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
  pickerLogin: false
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
  const result = await new Promise<{ succeeded: boolean; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn('agy', ['models'], {
        env: buildHarnessEnvironment(),
        stdio: ['ignore', 'pipe', 'pipe']
      })
      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        resolve({ succeeded: false, stdout, stderr })
      }, STATUS_TIMEOUT_MS)
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('error', (error) => {
        clearTimeout(timer)
        resolve({ succeeded: false, stdout, stderr: error.message })
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        resolve({ succeeded: code === 0, stdout, stderr })
      })
    }
  )
  const output = result.stdout.trim() || result.stderr.trim()
  return parseAntigravityStatus(output, result.succeeded)
}

/**
 * Cline stores provider auth state in `~/.cline/data/settings/providers.json` and the
 * CLI exposes no `auth status` subcommand (`cline auth <name>` only configures a
 * provider). Each configured provider is reported as an authenticated account.
 */
async function readClineStatus(): Promise<HarnessAuthStatus> {
  let stored: Record<string, unknown>
  try {
    const raw = await readFile(join(CLINE_SETTINGS_DIR, 'providers.json'), 'utf8')
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
 * Pi stores configured providers and API keys in `~/.pi/agent/models.json` and
 * `auth.json`; the CLI exposes no `auth status` subcommand. A provider is
 * reported as an authenticated account when it carries an API key, and as a
 * configured-but-unauthenticated entry otherwise.
 */
async function readPiStatus(): Promise<HarnessAuthStatus> {
  let stored: Record<string, unknown>
  try {
    const raw = await readFile(join(PI_AGENT_DIR, 'models.json'), 'utf8')
    stored = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return { state: 'unauthenticated', accounts: [] }
  }
  const providers = stored['providers']
  if (typeof providers !== 'object' || providers === null || Array.isArray(providers)) {
    return { state: 'unauthenticated', accounts: [] }
  }
  let authKeys: Set<string> | null = null
  try {
    const raw = await readFile(join(PI_AGENT_DIR, 'auth.json'), 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (Array.isArray(parsed)) {
      authKeys = new Set(
        parsed
          .map((entry) => {
            const item = entry as Record<string, unknown> | null
            return typeof item?.['provider'] === 'string' ? item['provider'] : undefined
          })
          .filter((value): value is string => Boolean(value))
      )
    }
  } catch {
    authKeys = null
  }
  const accounts: HarnessAuthAccount[] = []
  let signedIn = 0
  for (const [providerId, rawEntry] of Object.entries(providers as Record<string, unknown>)) {
    const entry = rawEntry as Record<string, unknown> | null
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) continue
    const apiKey = typeof entry['apiKey'] === 'string' ? entry['apiKey'] : undefined
    const authenticated =
      Boolean(apiKey && apiKey !== 'none') || (authKeys !== null && authKeys.has(providerId))
    accounts.push({
      id: accountId(providerId),
      label: providerId,
      active: authenticated
    })
    if (authenticated) signedIn += 1
  }
  return {
    state: signedIn > 0 ? 'authenticated' : accounts.length > 0 ? 'unauthenticated' : 'unknown',
    accounts
  }
}

/**
 * Muse keeps OAuth credentials in `~/.config/muse/auth.json` (or
 * `$XDG_CONFIG_HOME/muse/auth.json`) and honors a `META_API_KEY` env var that
 * takes priority over a logged-in session. The CLI exposes no `auth status`
 * subcommand, so the auth file is read directly. Its shape is
 * `{ schema_version, providers: { <id>: { access_token, api_key, ... } } }` —
 * a provider is authenticated when it carries an `access_token` or `api_key`.
 */
async function readMuseStatus(): Promise<HarnessAuthStatus> {
  if (process.env['META_API_KEY']) {
    return {
      state: 'authenticated',
      accounts: [{ id: 'meta', label: 'Meta', method: 'api-key', active: true }]
    }
  }
  let stored: Record<string, unknown>
  try {
    const raw = await readFile(MUSE_AUTH_PATH, 'utf8')
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
function readHiddenProviders(): string[] {
  try {
    const raw = readFileSync(OPENCODE_CONFIG_PATH, 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const list = parsed['disabled_providers']
      if (Array.isArray(list)) {
        return list.filter((entry): entry is string => typeof entry === 'string')
      }
    }
    return []
  } catch {
    return []
  }
}

/**
 * Merge `disabled_providers` into OpenCode's global config. Plain JSON configs
 * are edited in place; JSONC configs (with comments) are never overwritten.
 */
async function writeHiddenProviders(providers: string[]): Promise<void> {
  const configDir = dirname(OPENCODE_CONFIG_PATH)
  await mkdir(configDir, { recursive: true })
  let config: Record<string, unknown> = {}
  try {
    const raw = await readFile(OPENCODE_CONFIG_PATH, 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new Error(
        `Cannot edit ${OPENCODE_CONFIG_PATH}: it is not plain JSON. Add "disabled_providers": [...] manually to hide providers.`
      )
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      config = parsed as Record<string, unknown>
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code
    if (code === 'ENOENT') {
      config = {}
    } else {
      throw error
    }
  }
  config['disabled_providers'] = providers
  await writeFile(OPENCODE_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
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
    loginArgs: () => ['--help']
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
  capabilities(harnessId: string): HarnessAuthCapabilities | null {
    const definition = this.definition(harnessId)
    if (!definition) return null
    return {
      ...READ_AND_HANDOFF_ONLY,
      logout: definition.logoutArgs !== undefined,
      pickerLogin: definition.pickerLogin === true
    }
  }

  async getStatus(harnessId: string, projectPath?: string): Promise<HarnessAuthStatus> {
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
  }

  beginLogin(harnessId: string, options: HarnessLoginOptions = {}): HarnessLoginHandoff {
    const definition = this.requireDefinition(harnessId)
    return {
      kind: 'terminal',
      command: definition.command,
      args: definition.loginArgs(options),
      title: `Sign in to ${definition.name}`,
      mutatesGlobalCredentials: true
    }
  }

  /** Remove a stored harness credential by running the harness's own logout CLI. */
  async logout(harnessId: string, providerId?: string): Promise<void> {
    const definition = this.requireDefinition(harnessId)
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
      case 'pi': {
        const status = await readPiStatus()
        return status.accounts.map((account) => ({
          id: account.label,
          name: account.label,
          modelCount: 0,
          authenticated: status.state === 'authenticated'
        }))
      }
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

  /** Provider IDs currently hidden from the harness (via its own config). */
  getHiddenProviders(harnessId: string): string[] {
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
    const current = readHiddenProviders()
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

  private run(command: string, args: string[], cwd?: string): Promise<CommandResult> {
    return new Promise((resolve) => {
      execFile(
        command,
        args,
        {
          ...(cwd ? { cwd } : {}),
          env: buildHarnessEnvironment(),
          timeout: STATUS_TIMEOUT_MS,
          maxBuffer: 1024 * 1024
        },
        (error, stdout, stderr) => {
          resolve({
            succeeded: error === null,
            stdout,
            stderr,
            ...(error ? { error: error.message } : {})
          })
        }
      )
    })
  }
}
