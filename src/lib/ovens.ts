/** Local remains a stable identity even when the user's default is remote. */
export const LOCAL_OVEN_ID = 'local'
export const OVEN_PROTOCOL_VERSION = 1
export type OvenIcon = string

export interface OvenConnection {
  /** SSH config alias, DNS name, or IP address. Never a shell command. */
  host: string
  user?: string
  port: number
  authentication: 'agent' | 'identity' | 'vault'
  identityFile?: string
}

export interface Oven {
  id: string
  kind: 'local' | 'ssh'
  name: string
  icon: OvenIcon
  customSvg?: string
  color: string
  connection?: OvenConnection
  hasPrivateKey: boolean
  hasPassphrase: boolean
  hasPublicKey: boolean
  createdAt: number
  updatedAt: number
}

/** Secrets are write-only at the renderer boundary. Omission preserves them. */
export interface SaveOvenInput {
  id?: string
  name: string
  icon: OvenIcon
  customSvg?: string
  color: string
  connection: OvenConnection
  privateKey?: string
  passphrase?: string
  publicKey?: string
}

export interface OvenState {
  ovens: Oven[]
  defaultOvenId: string
  secureStorageAvailable: boolean
}

export interface OvenProbe {
  protocolVersion: number
  serviceRevision: string
  platform: string
  architecture: string
  home: string
  nodeVersion: string
  harnesses: { command: string; path: string | null }[]
  activeRuns: number
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

export const OVEN_HARNESS_COMMANDS = ['codex', 'claude', 'opencode', 'muse', 'pi', 'cline'] as const

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
  | { operation: 'mkdir'; root: string; path: string }
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
  | { operation: 'git'; root: string; action: 'status' | 'diff' | 'log' }
  | { operation: 'clone'; root: string; url: string }

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
