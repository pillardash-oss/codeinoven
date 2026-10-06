/** Local remains a stable identity even when the user's default is remote. */
export const LOCAL_OVEN_ID = 'local'
export const OVEN_PROTOCOL_VERSION = 1
export type OvenIcon = string

export interface OvenAppearance {
  icon: OvenIcon
  color: string
  customSvg?: string
}

export interface OvenConnection {
  /** SSH config alias, DNS name, or IP address. Never a shell command. */
  host: string
  user?: string
  port: number
  authentication: 'agent' | 'identity' | 'vault' | 'password'
  identityFile?: string
}

export interface Oven {
  id: string
  kind: 'local' | 'ssh'
  name: string
  icon: OvenIcon
  customSvg?: string
  imageDataUrl?: string
  color: string
  connection?: OvenConnection
  hasPrivateKey: boolean
  hasPassphrase: boolean
  hasPublicKey: boolean
  hasPassword?: boolean
  connectionStatus?: OvenConnectionStatus
  createdAt: number
  updatedAt: number
}

/** Secrets are write-only at the renderer boundary. Omission preserves them. */
export interface SaveOvenInput {
  id?: string
  name: string
  icon: OvenIcon
  customSvg?: string
  imagePath?: string
  clearImage?: boolean
  color: string
  connection: OvenConnection
  privateKey?: string
  passphrase?: string
  publicKey?: string
  password?: string
}

export interface OvenState {
  ovens: Oven[]
  defaultOvenId: string
  secureStorageAvailable: boolean
}

export interface OvenConnectionStatus {
  state: 'connected' | 'disconnected'
  checkedAt: number
  latencyMs?: number
  error?: string
  specs?: {
    hostname: string
    platform: string
    architecture: string
    cpuCount: number
    memoryBytes: number
    diskBytes: number
    diskAvailableBytes: number
    nodeVersion: string | null
  }
}

export interface OvenHarnessInventoryItem {
  harnessId: string
  command: string
  executablePath: string | null
  installedVersion: string | null
  health: 'healthy' | 'missing' | 'broken' | 'unsupported' | 'unknown'
  issueCategory?:
    'not-installed' | 'broken-executable' | 'unsupported-platform' | 'timeout' | 'unknown'
  updateAvailable: boolean
  latestVersion?: string
  checkedAt: number
  cached?: boolean
}

export interface OvenProbe {
  protocolVersion: number
  serviceRevision: string
  platform: string
  architecture: string
  home: string
  nodeVersion: string
  /**
   * The zone the Oven service runs on, as an IANA id.
   *
   * The service reports its own process zone, which is the Oven's system zone
   * and always an IANA id even on Windows, where the platform's own catalogue
   * names zones differently. Missing while an older service is deployed.
   */
  timezone?: string
  specs?: NonNullable<OvenConnectionStatus['specs']>
  harnesses: { command: string; path: string | null }[]
  activeRuns: number
  inventory?: OvenHarnessInventoryItem[]
}

export interface OvenRun {
  id: string
  command: string
  cwd: string
  status: 'running' | 'completed' | 'failed' | 'stopped'
  createdAt: number
  finishedAt?: number
  exitCode?: number | null
}

export interface OvenRunEvent {
  sequence: number
  stream: 'stdout' | 'stderr' | 'exit'
  text: string
}

export interface StartOvenRunInput {
  /** Client-generated id makes a retried start idempotent. */
  id: string
  command: string
  args: string[]
  cwd: string
  environment?: Record<string, string>
  input?: string
  closeInput?: boolean
}

/**
 * Remote commands CodeInOven probes, installation registry, and runs on an oven,
 * mapped to their canonical harness id in the harness registry.
 *
 * The oven side can only resolve a bare executable name, so this table is the
 * one place the two registries meet: `claude` on disk is the `claude-code`
 * harness, and Antigravity's `agy` command is included so oven inventory matches
 * the harnesses the app can actually drive. Adding a harness to the registry
 * without adding its remote command here makes it Local-only.
 */
export const OVEN_HARNESS_COMMANDS = [
  'codex',
  'claude',
  'opencode',
  'muse',
  'pi',
  'cline',
  'agy'
] as const

export type OvenHarnessCommand = (typeof OVEN_HARNESS_COMMANDS)[number]

const OVEN_HARNESS_ID_BY_COMMAND: Record<string, string> = {
  codex: 'codex',
  claude: 'claude-code',
  opencode: 'opencode',
  muse: 'muse',
  pi: 'pi',
  cline: 'cline',
  agy: 'antigravity'
}

/** Resolve the canonical harness id for a remote command, or undefined when unknown. */
export function ovenHarnessIdForCommand(command: string): string | undefined {
  return OVEN_HARNESS_ID_BY_COMMAND[command]
}

/** True when the command is one CodeInOven is allowed to run on an oven. */
export function isOvenHarnessCommand(value: unknown): value is OvenHarnessCommand {
  return typeof value === 'string' && OVEN_HARNESS_ID_BY_COMMAND[value] !== undefined
}

export interface OvenFile {
  path: string
  kind: 'file' | 'directory' | 'symlink'
  size: number
  modifiedAt: number
  mode: number
  target?: string
}

export type OvenWorkspaceRequest =
  | { operation: 'ensure'; root: string }
  | { operation: 'reserve'; root: string }
  | { operation: 'list'; root: string; path: string; after?: string }
  | { operation: 'read'; root: string; path: string; offset: number }
  | {
      operation: 'write'
      root: string
      path: string
      offset: number
      data: string
      exclusive?: boolean
      mode?: number
    }
  | { operation: 'mkdir'; root: string; path: string; exclusive?: boolean }
  | { operation: 'publishFile'; root: string; path: string; staged: string }
  /**
   * Rename one entry inside the root, creating the destination's parents.
   *
   * Used to adopt app-owned files out of a checkout (a pi session transcript)
   * into the Oven's app data directory, which shares a root with the checkout.
   */
  | { operation: 'move'; root: string; path: string; to: string }
  | { operation: 'symlink'; root: string; path: string; target: string }
  | { operation: 'stat'; root: string; path: string }
  | {
      operation: 'replace'
      root: string
      path: string
      staged: string
      mode: number
      expectedData?: string
    }
  | { operation: 'git'; root: string; action: 'status' | 'diff' | 'log' | 'branch' }
  | {
      operation: 'clone'
      root: string
      url: string
      /**
       * Home-relative identity the Oven's Git environment must use.
       *
       * The app mirrors the GitHub identity this machine already authenticates
       * with: a file-backed key travels whole with owner-only permissions, an
       * agent-held key travels as its public half and the forwarded agent
       * supplies the secret half. A dedicated Oven identity, when configured,
       * takes precedence over this path.
       */
      localIdentityFile?: string
    }

/** Scope checkouts that exist on one Oven, offered as the other end of a Git sync. */
export interface OvenRootPeers {
  /** Scope bucket id the running checkout belongs to. */
  currentScope: string
  checkouts: Array<{ id: string; name: string; root: string }>
}

/** One end of a file or Git operation: a checkout on an Oven, or a local root. */
export interface OvenRootTarget {
  ovenId: string
  root: string
}

export interface OvenWorkspaceResult {
  root: string
  files?: OvenFile[]
  after?: string
  data?: string
  size?: number
  text?: string
  file?: OvenFile
}

export interface OvenTransferInput {
  sourceOvenId: string
  sourceRoot: string
  targetOvenId: string
  targetRoot: string
}

export interface OvenTransferReview extends OvenTransferInput {
  id: string
  files: number
  bytes: number
  expiresAt: number
}

export type OvenPackageManager =
  'apt' | 'dnf' | 'yum' | 'pacman' | 'zypper' | 'brew' | 'winget' | 'choco' | 'scoop' | 'unknown'

/** The minimum Node.js the oven service runtime requires. */
export const OVEN_MINIMUM_NODE_VERSION = 22

/** How much authority the authenticated oven user has for system mutation. */
export type OvenPrivilege = 'root' | 'passwordless-sudo' | 'sudo' | 'none'

export interface OvenToolStatus {
  installed: boolean
  version: string | null
  path?: string | null
}

/** How an Oven's clock zone can be set, as preflight observed it. */
export type OvenTimezoneMethod =
  'timedatectl' | 'systemsetup' | 'zoneinfo' | 'powershell' | 'unsupported'

/** An Oven's own clock zone, read without changing anything. */
export interface OvenTimezone {
  /**
   * Zone the Oven runs on now: an IANA id such as `Africa/Lagos` everywhere but
   * Windows, where the platform names zones in its own catalogue instead.
   */
  current: string | null
  /** Mechanism available for setting it, or `unsupported` when there is none. */
  method: OvenTimezoneMethod
}

/** Outcome of matching one Oven's clock to this computer's time zone. */
export interface OvenTimezoneSyncResult {
  status: 'updated' | 'current' | 'unsupported'
  /** Zone the Oven is on after the attempt, as the Oven reports it. */
  zone: string | null
  /** One sentence for the toast that reports the attempt. */
  message: string
}

export interface OvenHarnessPreflight {
  harnessId: string
  command: string
  name: string
  supported: boolean
  unsupportedReason?: string
  /** Documented install channels for this platform, in preference order. */
  channels: string[]
  executablePath: string | null
  installedVersion: string | null
  health: 'healthy' | 'missing' | 'broken' | 'unsupported' | 'unknown'
  issueCategory?: 'not-installed' | 'broken-executable' | 'unsupported-platform' | 'timeout'
}

/**
 * One read-only observation of a remote oven. Everything here comes from
 * non-mutating commands, so collecting a report is always safe.
 */
export interface OvenPreflightReport {
  ovenId: string
  checkedAt: number
  /** `process.platform` reported by the oven, normalized to a known value. */
  platform: NodeJS.Platform
  architecture: string
  osName: string
  osVersion: string | null
  packageManager: OvenPackageManager
  privilege: OvenPrivilege
  git: OvenToolStatus
  curl: OvenToolStatus
  node: OvenToolStatus
  npm: OvenToolStatus
  /** The Oven's own clock zone, read read-only alongside everything else. */
  timezone: OvenTimezone
  harnesses: OvenHarnessPreflight[]
  /** Set when the oven reports pending OS updates or a required reboot. Never acted on. */
  osUpdateRequired: boolean
  osUpdateDetail?: string
  rebootRequired: boolean
  durationMs: number
}

export interface OvenPreflightIssue {
  code:
    | 'unsupported-platform'
    | 'unsupported-architecture'
    | 'unknown-package-manager'
    | 'missing-git'
    | 'missing-curl'
    | 'node-missing'
    | 'node-too-old'
    | 'npm-missing'
    | 'harness-unsupported'
    | 'harness-broken'
    | 'os-update-pending'
    | 'reboot-required'
  message: string
  /** Blocks setup outright rather than merely warning. */
  blocking: boolean
}

/** The pure verdict computed from a preflight report. Never performs I/O. */
export interface OvenPreflightAssessment {
  ovenId: string
  checkedAt: number
  platform: NodeJS.Platform
  architecture: string
  osName: string
  supported: boolean
  /** Setup can mutate this oven once the user starts it. */
  setupCapable: boolean
  prerequisitesSatisfied: boolean
  issues: OvenPreflightIssue[]
  harnesses: OvenHarnessPreflight[]
  packageManager: OvenPackageManager
  privilege: OvenPrivilege
  nodeVersion: string | null
  timezone: OvenTimezone
  osUpdateRequired: boolean
  osUpdateDetail?: string
  rebootRequired: boolean
}

export type OvenSetupStepStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'blocked'
  | 'interrupted'
  | 'cancelled'
  | 'skipped'

export interface OvenSetupStep {
  id: string
  name: string
  status: OvenSetupStepStatus
  startedAt?: number
  finishedAt?: number
  durationMs?: number
  error?: string
  detail?: string
  retryCount?: number
  installProgress?: {
    stage: 'starting' | 'downloading' | 'installing' | 'verifying'
    percent?: number
  }
  skippedReason?: string
  requiresElevation?: boolean
}

export type OvenSetupOperationStatus =
  | 'idle'
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'blocked'

export interface OvenSetupSelectedHarness {
  harnessId: string
  accountId?: string
  install?: boolean
  update?: boolean
}

/**
 * Git identity as it is persisted. Raw key material never reaches an operation
 * record: the IPC layer converts a submitted private key into a vault reference.
 * Only that reference is stored, journaled, or sent back to the renderer.
 */
export interface OvenSetupGitConfiguration {
  enabled: boolean
  host: 'github' | 'any'
  privateKeyRef?: string
  /** Fingerprint of the installed public key, used to detect a changed identity. */
  publicKeyFingerprint?: string
  publicKey?: string
}

/** Everything an operation needs to resume, with no secret values. */
export interface OvenSetupConfiguration {
  selectedHarnesses: OvenSetupSelectedHarness[]
  synchronizeAccounts: boolean
  synchronizeConfiguration: boolean
  git: OvenSetupGitConfiguration
  packageUpgrades: boolean
}

/**
 * Start request. The Git identity is accepted exactly once, in the submission,
 * and the IPC layer converts it into a vault reference before the operation is
 * created. Nothing downstream ever sees the raw key value.
 */
export interface StartOvenSetupInput {
  configuration: OvenSetupConfiguration
  gitIdentity?: { privateKey: string }
}

export interface OvenSetupPreflightResult {
  report: OvenPreflightReport
  assessment: OvenPreflightAssessment
}

export interface OvenSetupProgressEvent {
  /** Monotonic per operation so the renderer can resume from a cursor after a reload. */
  sequence: number
  operationId: string
  ovenId: string
  status: OvenSetupOperationStatus
  phase: OvenSetupPhase
  steps: OvenSetupStep[]
  currentStepId?: string
  startedAt: number
  finishedAt?: number
  error?: string
  /** Operator-facing status. Never contains prompts, spec text, or secrets. */
  message?: string
}

export type OvenSetupPhase =
  'preflight' | 'bootstrap' | 'prerequisites' | 'harnesses' | 'accounts' | 'git' | 'finalize'

export interface OvenSetupOperation {
  id: string
  ovenId: string
  status: OvenSetupOperationStatus
  /** Sticky flag set once the first complete setup succeeds. */
  setupComplete?: boolean
  configuration: OvenSetupConfiguration
  steps: OvenSetupStep[]
  startedAt: number
  finishedAt?: number
  error?: string
  updatedAt: number
}

/** Accept the familiar SSH form without ever accepting arbitrary CLI options. */
export function parseOvenAddress(value: string): Pick<OvenConnection, 'host' | 'user' | 'port'> {
  const address = value.trim().replace(/^ssh\s+/u, '')
  const match =
    /^(?:([a-zA-Z0-9_.-]+)@)?(\[[a-fA-F0-9:]+\]|[a-zA-Z0-9][a-zA-Z0-9._-]*)(?::([0-9]+))?$/u.exec(
      address
    )
  if (!match) throw new TypeError('Use an SSH alias or user@host, with an optional :port.')
  const port = match[3] ? Number(match[3]) : 22
  if (port < 1 || port > 65535) throw new TypeError('SSH port must be between 1 and 65535.')
  return { host: match[2].replace(/^\[|\]$/gu, ''), ...(match[1] ? { user: match[1] } : {}), port }
}
