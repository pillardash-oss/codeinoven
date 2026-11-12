import { isOpenCodeV2Version } from '../../lib/opencode-version'
import {
  cachedOpenCodeInstallation,
  detectOpenCodeInstallation,
  resolvedOpenCodeCommand
} from '../agents/opencode-installation'
import type {
  HarnessAuthAccount,
  HarnessAuthStatus,
  HarnessLoginOptions
} from '../drivers/driver.interface'
import { readOpenCodeV2StoredCredentials } from '../drivers/opencode-account-usage'
import { readClineStatus, removeClineCredential } from './provider-account-cline-store'
import { readMuseStatus } from './provider-account-muse-store'
import {
  resolveOpencodeLogoutTarget,
  resolveOpenCodeV2LogoutCredential,
  resolveOpenCodeV2StoredIntegration
} from './provider-account-opencode-store'
import { fileBackedAuth, readPiStatus } from './provider-account-pi-store'
import {
  parseClaudeStatus,
  parseCodexStatus,
  parseOpenCodeStatus,
  readAntigravityStatus
} from './provider-account-status-parsers'

/**
 * The CLI grammar CodeInOven drives for each harness, including the OpenCode
 * V1/V2 pair chosen from the install the app detected.
 */

export interface AuthDefinition {
  id: string
  name: string
  command: string
  statusArgs?: string[]
  parseStatus?(output: string, succeeded: boolean): HarnessAuthStatus
  /** Alternative to CLI probing for harnesses without a status subcommand. */
  readStatus?(projectPath?: string, environment?: NodeJS.ProcessEnv): Promise<HarnessAuthStatus>
  loginArgs(options: HarnessLoginOptions): string[]
  /** CLI arguments that remove a provider's stored credentials. */
  logoutArgs?(providerId?: string, credential?: string): string[]
  /** Confirm that a CLI logout actually removed the account rather than returning a no-op. */
  verifyLogout?(environment: NodeJS.ProcessEnv): Promise<void>
  /**
   * CLI arguments that make one stored credential the active one, for harnesses
   * whose own store holds several accounts per integration (OpenCode V2's
   * `auth switch <integration> <credential>`). Absent when the harness has no
   * switch command, which is what gates the `accountActivation` capability.
   */
  activateArgs?(providerId: string, credentialId: string): string[]
  /**
   * Maps a stored slug id (and optionally the account's display name) to the
   * credential identifier the harness CLI actually accepts at logout time.
   */
  resolveLogoutTarget?(providerId: string, providerHint?: string): Promise<string | undefined>
  /**
   * Resolve the integration id the harness CLI currently uses for an account,
   * read from that account's own credential store.
   *
   * A managed row's provider id is pinned when its container is created, so a
   * release that renames an integration leaves the row naming a provider the
   * CLI no longer knows. OpenCode's `opencode-zen` became `opencode`, and every
   * command built from the stale id ends with "Integration not found:
   * opencode-zen". The account's store is the authority for the integration a
   * command names, so login, logout and switch all resolve through it.
   */
  resolveStoredIntegration?(
    providerId: string,
    environment: NodeJS.ProcessEnv
  ): Promise<string | undefined>
  /**
   * Resolves the credential selector a multi-account CLI needs as the second
   * positional logout argument.
   *
   * OpenCode V2's `auth logout <integration> [<credential>]` opens an account
   * picker when the credential is omitted, which ends the command with "Pass a
   * credential ID or label when running without an interactive terminal". The
   * account the user picked is known, so it is resolved to its stored
   * credential id here instead of letting the CLI guess. `credentialHint` is the
   * account's own credential id when the registry kept one, else its display
   * name.
   */
  resolveLogoutCredential?(
    providerId: string,
    credentialHint: string | undefined,
    environment: NodeJS.ProcessEnv
  ): Promise<string | undefined>
  /**
   * Version line whose credential store holds the account state, for harnesses
   * that keep several credentials in their own store. Only V2 OpenCode does, and
   * its `auth list` output does not say which credential is active, so the store
   * has to be read to know. Absent for a single-credential harness.
   */
  nativeStore?: 'v2'
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
  /**
   * CodeInOven can run this harness's own sign-in flow in-app (Pi, through
   * pi-ai's `login()`). Advertised to the UI as `inAppLogin`, and preferred
   * over a terminal handoff, which no bundled runtime can produce.
   */
  inAppLogin?: boolean
}

/**
 * OpenCode V1 auth: `opencode auth list`, with a `--provider` login target and
 * a credential store CodeInOven can edit directly (`~/.local/share/opencode`).
 *
 * The command is the canonical install the app assessed, so a v1 binary answers
 * the probe and the login from the same copy rather than from whichever one PATH
 * resolves for that particular spawn.
 */
function openCodeV1Auth(command: string): AuthDefinition {
  return {
    id: 'opencode',
    name: 'OpenCode',
    command,
    statusArgs: ['auth', 'list'],
    parseStatus: parseOpenCodeStatus,
    loginArgs: (options) => [
      'auth',
      'login',
      ...(options.providerId ? ['--provider', options.providerId] : [])
    ],
    logoutArgs: (providerId) => ['auth', 'logout', ...(providerId ? [providerId] : [])],
    resolveLogoutTarget: resolveOpencodeLogoutTarget,
    pickerLogin: true
  }
}

/**
 * OpenCode V2 account status, read from its own SQLite credential store.
 *
 * `opencode auth list --format json` prints the same integrations the store
 * holds, but running the client has a side effect the app cannot live with: the
 * CLI ensures OpenCode's managed background service, so a status probe spawns
 * `opencode serve --service`   a daemon that survives the probe, re-parents to
 * launchd, and is then adopted by the task manager. The store is read-only and
 * process-free, so the accounts still list and nothing is left running.
 */
async function readOpenCodeV2Status(
  _projectPath?: string,
  environment: NodeJS.ProcessEnv = {}
): Promise<HarnessAuthStatus> {
  const stored = await readOpenCodeV2StoredCredentials(environment)
  const accounts: HarnessAuthAccount[] = stored.map((credential) => ({
    id: credential.id,
    providerId: credential.integrationId,
    label: credential.label ?? credential.integrationId,
    ...(credential.method ? { method: credential.method } : {})
  }))
  return { state: accounts.length > 0 ? 'authenticated' : 'unauthenticated', accounts }
}

/**
 * OpenCode V2 auth: credentials live in its own SQLite store, while login and
 * logout take a positional provider id.
 *
 * Every client subcommand drives OpenCode's own managed daemon
 * (`opencode serve --service`), which binds one fixed default port per install.
 * A managed account is a separate install (its container owns XDG_CONFIG_HOME,
 * XDG_DATA_HOME and friends), so the CLI cannot bind that port while any other
 * OpenCode install's daemon already holds it, and it dies with
 * "Server process exited with code 1   Managed service port <port> on 127.0.0.1
 * is already in use by another process". `--standalone` runs the command on a
 * private server instead, which is the rule the rest of the app already
 * follows: it never talks to OpenCode's managed service.
 */
function openCodeV2Auth(command: string): AuthDefinition {
  return {
    id: 'opencode',
    name: 'OpenCode',
    command,
    readStatus: readOpenCodeV2Status,
    loginArgs: (options) => [
      'auth',
      'login',
      ...(options.providerId ? [options.providerId] : []),
      '--standalone'
    ],
    resolveStoredIntegration: resolveOpenCodeV2StoredIntegration,
    logoutArgs: (providerId, credential) => [
      'auth',
      'logout',
      ...(providerId ? [providerId] : []),
      ...(credential ? [credential] : []),
      '--standalone'
    ],
    resolveLogoutCredential: resolveOpenCodeV2LogoutCredential,
    // V2 keeps several credentials per integration and switches the active one
    // by id or label (`opencode auth switch <integration> <credential>`).
    activateArgs: (providerId, credentialId) => [
      'auth',
      'switch',
      providerId,
      credentialId,
      '--standalone'
    ],
    // The active credential lives in V2's own store, and `auth list` does not
    // report it, so account state is read from the store itself.
    nativeStore: 'v2',
    pickerLogin: true
  }
}

/**
 * The auth definition for whichever OpenCode line is installed. One harness id
 * (`opencode`) covers both, so the CLI grammar is chosen from the detected
 * version instead of a second harness entry. A cold cache runs the bounded
 * probe here, so a V2-only machine never falls back to a V1 command.
 */
export async function openCodeAuthDefinition(): Promise<AuthDefinition> {
  const installation = cachedOpenCodeInstallation() ?? (await detectOpenCodeInstallation())
  if (installation && isOpenCodeV2Version(installation.version)) {
    return openCodeV2Auth(installation.command)
  }
  return openCodeV1Auth(resolvedOpenCodeCommand())
}

/** Version-aware definition without spawning a probe (for existence checks). */
export function openCodeAuthDefinitionCached(): AuthDefinition {
  const installation = cachedOpenCodeInstallation()
  if (installation && isOpenCodeV2Version(installation.version)) {
    return openCodeV2Auth(installation.command)
  }
  return openCodeV1Auth(resolvedOpenCodeCommand())
}

export const AUTH_DEFINITIONS: AuthDefinition[] = [
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
    loginArgs: (options) => ['auth', ...(options.providerId ? [options.providerId] : [])],
    removeStoredCredential: removeClineCredential
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    command: 'codex',
    statusArgs: ['login', 'status'],
    parseStatus: parseCodexStatus,
    loginArgs: (options) => ['login', ...(options.mode === 'device' ? ['--device-auth'] : [])],
    logoutArgs: () => ['logout']
  },
  {
    id: 'pi',
    name: 'Pi',
    command: 'pi',
    readStatus: readPiStatus,
    // No terminal handoff: connecting happens in-app   the provider's own
    // sign-in flow (OAuth or guided key entry) run through pi-ai, or a pasted
    // API key   so a bundled Pi with no CLI to spawn still connects, and a
    // beginner never meets Pi's full TUI.
    loginArgs: () => [],
    inAppLogin: true,
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
    logoutArgs: () => ['--print', '/logout'],
    verifyLogout: async (environment) => {
      const status = await readAntigravityStatus(undefined, environment)
      if (status.state !== 'unauthenticated') {
        throw new Error(
          status.state === 'authenticated'
            ? 'Antigravity is still authenticated after logout. Environment API keys cannot be disconnected by logout.'
            : 'Antigravity logout could not be verified. Refresh the account status and retry.'
        )
      }
    },
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
