import type { HarnessExecutionTarget } from './common'

/** Live connection state of a provider harness on this machine. */
export type ProviderConnectionStatus = 'idle' | 'checking' | 'available' | 'not_found' | 'error'

export interface ProviderConnectionInfo {
  id: string
  name: string
  command: string
  /** Whether CodeInOven currently has a working HarnessDriver for this CLI. */
  integration: 'ready' | 'planned'
  /** Whether this harness can consume custom base-URL providers at runtime. */
  supportsCustomProviders: boolean
  /** Whether this harness supports manual context compaction (harness manifest). */
  supportsManualCompaction?: boolean
  status: ProviderConnectionStatus
  /** Absolute path to the resolved binary, when found. */
  resolvedPath?: string
  /** Host runtime that owns the resolved binary. */
  executionTarget?: HarnessExecutionTarget
  /** First line of `<command> --version` output, when the probe succeeds. */
  version?: string
  /**
   * The probed command actually being driven, when it differs from `command`.
   * Set for harnesses with aliases (OpenCode's `opencode2`): the app reports the
   * name it resolved so install/update/auth act on the binary in use.
   */
  activeCommand?: string
  /** Human-readable detail for error/not_found states. */
  detail?: string
}

/** Where a confirmed harness-manifest behavior override came from. */
export type HarnessConfirmationSource = 'user' | 'runtime'

/** A confirmed behavior override layered on top of a harness's declared manifest. */
export interface ConfirmedHarnessBehavior {
  value: boolean
  source: HarnessConfirmationSource
  confirmedAt: number
}

/**
 * Per-harness view of the effective behavior for the Settings surface.
 * `declared` is the code manifest; `effective` is what the app actually uses
 * after a confirmed override (or runtime in-use validation) is applied.
 */
export interface HarnessManifestEntry {
  harnessId: string
  /** The declared (code manifest) value. */
  declared: boolean
  /** A user/runtime confirmed override when present. */
  confirmed?: ConfirmedHarnessBehavior
  /** What the app actually uses: confirmed override ?? declared. */
  effective: boolean
  /** Epoch ms the harness was last actually used, when known. */
  lastUsedAt?: number
}

export interface ProviderCapabilities {
  fileEditing: boolean
  computerUse: boolean
  multiFile: boolean
  streaming: boolean
  toolUse: boolean
  planningMode: boolean
}

export type ProviderStatus = 'connected' | 'disconnected' | 'error' | 'busy'

export interface ProviderConfig {
  id: string
  adapter: string
  config: {
    binaryPath?: string
    defaultModel?: string
    env?: Record<string, string>
    apiUrl?: string
    apiKey?: string
  }
}

export interface ProviderAccountAuthCapabilities {
  status: boolean
  loginHandoff: boolean
  logout: boolean
  accountActivation: boolean
  multipleAccounts: boolean
  /** The harness presents its own interactive provider picker in the login terminal. */
  pickerLogin: boolean
  /** CodeInOven can store an API key for a catalog provider in the harness's own auth store. */
  apiKeyEntry: boolean
}

/** Progress surfaced while an in-app OAuth sign-in runs (Pi). */
export type PiOAuthUiEvent =
  | { type: 'auth_url'; url: string; instructions?: string }
  | { type: 'device_code'; userCode: string; verificationUri: string }
  | { type: 'progress'; message: string }
  | { type: 'info'; message: string }

/** A question an in-app OAuth sign-in needs answered before continuing. */
export interface PiOAuthUiPrompt {
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: Array<{ id: string; label: string }>
}

export interface ProviderAccountAuthEntry {
  id: string
  /** Stable provider id used by models, login, and logout commands. */
  providerId: string
  label: string
  method?: string
  active?: boolean
}

/** One user-named credential container for a harness. */
export interface HarnessAccount {
  id: string
  harnessId: string
  /** Provider authenticated by this account. */
  providerId: string
  /** Display name reported by the harness for this provider. */
  providerName: string
  label: string
  containerKind: 'legacy-default' | 'managed'
  /**
   * Identity of the credential this legacy row mirrors (a harness credential
   * id or slug). One provider can hold several credentials, and this is what
   * keeps their mirrored rows apart across reconciliations.
   */
  sourceId?: string
  /** Marks the user's preferred account for this harness+provider. When unset,
   *  the earliest created account acts as the default. */
  isDefault?: boolean
  createdAt: number
  updatedAt: number
}

export interface HarnessAccountCreateInput {
  harnessId: string
  providerId: string
  /** Optional display label. Blank labels are generated as `<provider>-N`. */
  label?: string
}

/** Unlisted credential container used only while a provider sign-in is underway. */
export interface PendingHarnessAccount {
  id: string
  harnessId: string
  providerId: string
}

export interface HarnessAccountRenameInput {
  accountId: string
  label: string
}

export interface ProviderAccountAuthStatus {
  capabilities: ProviderAccountAuthCapabilities | null
  state: 'authenticated' | 'unauthenticated' | 'unknown' | 'error' | 'unsupported'
  accounts: ProviderAccountAuthEntry[]
  detail?: string
}

export interface ProviderAccountLoginOptions {
  mode?: 'default' | 'subscription' | 'console' | 'device'
  accountHint?: string
  sso?: boolean
  /** Provider to authenticate against, for harnesses that support per-provider login. */
  providerId?: string
  /** Managed account whose isolated credential home receives the login. */
  accountId?: string
}

/** User-controlled terminal handoff. Main never executes this command. */
export interface ProviderAccountLoginHandoff {
  kind: 'terminal'
  command: string
  args: string[]
  /** Bounded credential-home overrides applied only to this login process. */
  environment?: Record<string, string>
  title: string
  mutatesGlobalCredentials: boolean
}

export type HarnessUpdateState = 'idle' | 'checking' | 'current' | 'update_available' | 'error'

export interface HarnessUpdateStatus {
  harnessId: string
  state: HarnessUpdateState
  /** Locally installed version reported by the harness, when known. */
  currentVersion?: string
  /** Latest published version on the harness's distribution channel. */
  latestVersion?: string
  /** Human-readable detail for error states. */
  detail?: string
  /** Epoch ms of the last completed check. */
  checkedAt: number
}

/** User-controlled update terminal handoff. Main never executes this command. */
export interface HarnessUpdateHandoff {
  kind: 'terminal'
  command: string
  args: string[]
  title: string
}

/** How a harness CLI was (or can be) installed on this machine. */
export type HarnessInstallMethod = 'npm' | 'brew' | 'winget' | 'native' | 'bundled'

/**
 * Controls one provider-catalog refresh.
 */
export interface ProviderCatalogRefreshOptions {
  /** Bypass every cache and re-discover from the drivers. Defaults to true. */
  force?: boolean
  /**
   * Also force each harness's own model catalog to re-fetch from upstream
   * before discovery. Costs a network round trip per provider, so only an
   * explicit user-triggered refresh (the model picker's refresh button) sets
   * it; background revalidations leave it unset.
   */
  refreshModelCatalogs?: boolean
}

/** OS-specific install/download page for a harness, resolved for the current platform. */
export interface HarnessInstallInfo {
  harnessId: string
  /** Official install/download page for the user's operating system. */
  pageUrl: string
  /** Install methods the harness officially supports on this OS. */
  methods: HarnessInstallMethod[]
  /** The install method detected for the local install (drives uninstall). */
  detectedMethod?: HarnessInstallMethod
}

/** User-controlled install terminal handoff. Main never executes this command. */
export interface HarnessInstallHandoff {
  kind: 'terminal'
  command: string
  args: string[]
  title: string
  /** The install method the command uses (native installers are preferred on Windows). */
  method: HarnessInstallMethod
}

/** User-controlled uninstall terminal handoff. Main never executes this command. */
export interface HarnessUninstallHandoff {
  kind: 'terminal'
  command: string
  args: string[]
  title: string
  /** The install method the uninstall command targets. */
  method: HarnessInstallMethod
}

/** A provider a harness offers for connection, surfaced from its catalog. */
export interface OfferedProvider {
  id: string
  name: string
  /** Number of models the harness exposes for this provider (when known). */
  modelCount: number
  /** Whether credentials are already stored for this provider. */
  authenticated: boolean
  /** Whether the harness supports a fully in-app OAuth sign-in for this provider. */
  oauth?: boolean
  /** Human-readable hint when the provider cannot be connected from the UI. */
  detail?: string
}
