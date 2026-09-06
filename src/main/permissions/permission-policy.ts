import { basename, isAbsolute, relative, resolve, sep } from 'path'
import { tmpdir } from 'os'

export type PermissionRisk = 'low' | 'medium' | 'high' | 'critical'
export type PermissionPolicyMode = 'auto_review' | 'full_access'
export type PermissionDecision = PermissionPolicyMode | 'ask'

export interface PermissionRequest {
  permission: string
  path?: string
  paths?: readonly string[]
  commands?: readonly string[]
}

export interface PermissionScope {
  projectRoot: string
  paths: readonly string[]
}

export interface PermissionApproval {
  required: boolean
  expiresAt?: number
}

export interface PermissionLedgerEntry {
  permission: string
  risk: PermissionRisk
  decision: PermissionDecision
  reason: string
  scope: PermissionScope
  expiresAt?: number
}

export interface PermissionDecisionResult {
  decision: PermissionDecision
  approved: boolean
  reason: string
  risk: PermissionRisk
  scope: PermissionScope
  approval: PermissionApproval
  ledger: PermissionLedgerEntry
}

export interface PermissionPolicyOptions {
  projectRoot: string
  mode: PermissionPolicyMode
  approvalTtlMs?: number
  protectedPathPatterns?: readonly string[]
  /** Absolute paths the user explicitly provided for this turn (attachments).
   *  These are always in scope regardless of location or protected status. */
  allowedPaths?: readonly string[]
  /** When true, only `allowedPaths` are permitted; every other path (even
   *  inside the project root) requires explicit approval. Used by File-System-
   *  OFF chats so the agent can only touch files the user attached. */
  restrictToAllowed?: boolean
  now?: () => number
}

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000
const SAFE_AUTO_PERMISSIONS = new Set(['read', 'list', 'search'])
const CRITICAL_TERMS = [
  'shell',
  'terminal',
  'command',
  'exec',
  'process',
  'delete',
  'remove',
  'destroy',
  'erase',
  'wipe',
  'network',
  'http',
  'fetch',
  'download',
  'upload',
  'credential',
  'secret',
  'token',
  'password',
  'apikey',
  'api-key',
  'private-key'
]
const HIGH_RISK_TERMS = [
  'write',
  'edit',
  'modify',
  'create',
  'move',
  'rename',
  'install',
  'publish',
  'deploy',
  'config'
]
const DESTRUCTIVE_TERMS = ['delete', 'remove', 'destroy', 'erase', 'wipe']
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /(?:^|[;&|]\s*)rm\s+(?=[^\n]*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s|$))/u,
  /(?:^|[;&|]\s*)find\s+[^\n]+\s-delete(?:\s|$)/u,
  /(?:^|[;&|]\s*)git\s+clean\s+(?=[^\n]*-[a-zA-Z]*f)(?=[^\n]*-[a-zA-Z]*d)/u,
  /(?:^|[;&|]\s*)Remove-Item\b[^\n]*\s-Recurse\b/iu,
  /(?:^|[;&|]\s*)(?:rmdir|rd|del)\b[^\n]*\s\/(?:s|S)\b/u
]
const DEFAULT_PROTECTED_PATTERNS = [
  '.git',
  '.env',
  '.env.*',
  'secrets',
  'secret',
  'credentials',
  '.ssh',
  '.aws',
  '.config',
  '.gnupg',
  '.kube',
  '.docker',
  '.npmrc',
  '.pypirc',
  '.netrc',
  '.gitconfig',
  'id_rsa',
  'id_ed25519',
  '*.lock',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
  'cargo.lock',
  'gemfile.lock',
  'composer.lock'
]

export function normalizePermissionName(permission: string): string {
  return permission
    .trim()
    .toLowerCase()
    .replace(/[\s_:/.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
}

export function classifyPermissionRisk(permission: string): PermissionRisk {
  const normalized = normalizePermissionName(permission)
  const terms = normalized.split('-').filter(Boolean)

  if (containsTerm(terms, CRITICAL_TERMS)) {
    return 'critical'
  }

  if (containsTerm(terms, HIGH_RISK_TERMS)) {
    return 'high'
  }

  if (isSafeAutoPermission(normalized)) {
    return 'low'
  }

  return 'medium'
}

export class PermissionPolicy {
  private readonly projectRoot: string
  private readonly approvalTtlMs: number
  private readonly protectedPathPatterns: readonly string[]
  private readonly allowedPaths: readonly string[]
  private readonly restrictToAllowed: boolean
  private readonly now: () => number

  constructor(private readonly options: PermissionPolicyOptions) {
    this.projectRoot = resolve(options.projectRoot)
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
    this.protectedPathPatterns = [
      ...DEFAULT_PROTECTED_PATTERNS,
      ...(options.protectedPathPatterns ?? [])
    ]
    this.allowedPaths = (options.allowedPaths ?? []).map((path) => resolve(path))
    this.restrictToAllowed = options.restrictToAllowed === true
    this.now = options.now ?? Date.now
  }

  evaluate(request: PermissionRequest): PermissionDecisionResult {
    const permission = normalizePermissionName(request.permission)
    const risk = classifyPermissionRisk(permission)
    const paths =
      request.path === undefined ? (request.paths ?? []) : [request.path, ...(request.paths ?? [])]
    const scope = this.createScope(paths)

    if (!permission) {
      return this.createDecision('ask', false, 'A permission name is required.', 'low', scope)
    }

    if (this.options.mode === 'auto_review') {
      return this.evaluateAutoReview(permission, risk, paths, request.commands ?? [], scope)
    }

    return this.evaluateFullAccess(permission, risk, paths, scope)
  }

  private evaluateAutoReview(
    permission: string,
    risk: PermissionRisk,
    paths: readonly string[],
    commands: readonly string[],
    scope: PermissionScope
  ): PermissionDecisionResult {
    const destructiveReason = this.getDestructiveReason(permission)
    if (destructiveReason) {
      return this.createDecision('ask', false, destructiveReason, risk, scope)
    }

    const destructiveCommand = commands.find((command) =>
      DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
    )
    if (destructiveCommand) {
      return this.createDecision(
        'ask',
        false,
        `Recursive or destructive command requires explicit approval: ${destructiveCommand}`,
        'critical',
        scope
      )
    }

    // File-System-OFF chats only auto-approve reads confined to the attached
    // files. Shell commands, writes, and reads elsewhere must ask — the agent
    // must not reach the broader file system (or the shell) unprompted.
    if (this.restrictToAllowed) {
      const confinedRead =
        commands.length === 0 &&
        isSafeAutoPermission(permission) &&
        paths.length > 0 &&
        paths.every((path) => {
          if (hasTraversal(path)) return false
          const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path)
          return this.isAllowedPath(resolvedPath)
        })
      if (!confinedRead) {
        return this.createDecision(
          'ask',
          false,
          'This chat is restricted to the files you attached; anything beyond that needs your approval.',
          risk,
          scope
        )
      }
      return this.createDecision(
        'auto_review',
        true,
        'Auto-approved: a read of a file the user attached to this chat.',
        risk,
        scope
      )
    }

    const pathReason = this.getAutoReviewPathReason(paths)
    if (pathReason) {
      return this.createDecision('ask', false, pathReason, risk, scope)
    }

    return this.createDecision(
      'auto_review',
      true,
      'Auto Review — every permission that is not explicitly denied is auto-approved.',
      risk,
      scope
    )
  }

  private getDestructiveReason(permission: string): string | undefined {
    const terms = normalizePermissionName(permission).split('-').filter(Boolean)
    return terms.some((term) => DESTRUCTIVE_TERMS.includes(term))
      ? `Destructive permission requires explicit approval: ${permission}`
      : undefined
  }

  private evaluateFullAccess(
    permission: string,
    risk: PermissionRisk,
    paths: readonly string[],
    scope: PermissionScope
  ): PermissionDecisionResult {
    return this.createDecision(
      'full_access',
      true,
      'Full Access — yolo mode, every operation is auto-approved.',
      risk,
      scope
    )
  }

  private getAutoReviewPathReason(paths: readonly string[]): string | undefined {
    for (const path of paths) {
      if (hasTraversal(path)) {
        return `Path traversal is not permitted: ${path}`
      }

      const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path)

      // Files the user explicitly attached are always in scope.
      if (this.isAllowedPath(resolvedPath)) {
        continue
      }

      // File-System-OFF chats are restricted to the provided attachments.
      if (this.restrictToAllowed) {
        return `This chat is restricted to the files you attached. Reading other local files requires your approval: ${path}`
      }

      if (!isWithinDirectory(this.projectRoot, resolvedPath)) {
        if (isAllowedExternalPath(resolvedPath)) {
          continue
        }
        const type = isAbsolute(path) ? 'absolute external path' : 'path outside the project root'
        return `The ${type} is not permitted: ${path}`
      }

      if (this.isProtectedPath(resolvedPath)) {
        return `Protected path access requires explicit approval: ${path}`
      }
    }

    return undefined
  }

  /** Whether a resolved path is inside the attachment allowlist (or the allowlist
   *  requirement does not apply). A matching path — or any path below a directory
   *  that was attached — is always permitted. */
  private isAllowedPath(path: string): boolean {
    return this.allowedPaths.some((allowed) => {
      return allowed === path || isWithinDirectory(allowed, path)
    })
  }

  private isProtectedPath(path: string): boolean {
    const relativePath = relative(this.projectRoot, path).split(sep).join('/')
    const segments = relativePath.split('/').filter(Boolean)
    const fileName = basename(path).toLowerCase()

    return this.protectedPathPatterns.some((pattern) => {
      const matcher = globMatcher(pattern.toLowerCase())
      return (
        matcher.test(relativePath.toLowerCase()) ||
        matcher.test(fileName) ||
        segments.some((segment) => matcher.test(segment.toLowerCase()))
      )
    })
  }

  private createScope(paths: readonly string[]): PermissionScope {
    return {
      projectRoot: this.projectRoot,
      paths: paths.map((path) => resolve(this.projectRoot, path))
    }
  }

  private createDecision(
    decision: PermissionDecision,
    approved: boolean,
    reason: string,
    risk: PermissionRisk,
    scope: PermissionScope
  ): PermissionDecisionResult {
    const expiresAt = decision === 'ask' ? this.now() + this.approvalTtlMs : undefined
    const approval = expiresAt === undefined ? { required: false } : { required: true, expiresAt }
    const ledger = {
      permission: '',
      risk,
      decision,
      reason,
      scope,
      ...(expiresAt === undefined ? {} : { expiresAt })
    } satisfies PermissionLedgerEntry

    return { decision, approved, reason, risk, scope, approval, ledger }
  }
}

function containsTerm(terms: readonly string[], candidates: readonly string[]): boolean {
  return terms.some((term) => candidates.includes(term))
}

function isSafeAutoPermission(permission: string): boolean {
  return normalizePermissionName(permission)
    .split('-')
    .some((term) => SAFE_AUTO_PERMISSIONS.has(term))
}

function hasTraversal(path: string): boolean {
  return path.split(/[\\/]+/).includes('..')
}

function isWithinDirectory(directory: string, candidate: string): boolean {
  const relativePath = relative(directory, candidate)
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  )
}

function isAllowedExternalPath(path: string): boolean {
  return path.startsWith('/tmp/') || path === '/tmp' || isWithinDirectory(resolve(tmpdir()), path)
}

function globMatcher(pattern: string): RegExp {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}
