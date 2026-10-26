import { basename, isAbsolute, relative, resolve, sep } from 'path'
import { toPosixPath } from '../../lib/paths'
import { tmpdir } from 'os'

export type PermissionRisk = 'low' | 'medium' | 'high' | 'critical'
export type PermissionPolicyMode = 'auto_review' | 'full_access'
export type PermissionDecision = PermissionPolicyMode | 'ask'

export interface PermissionRequest {
  permission: string
  path?: string
  paths?: readonly string[]
  commands?: readonly string[]
  /**
   * Tool name the caller could not classify as read-only. Pi's built-in MCP
   * tools, `codemode`, `tool_search`, and anything a later harness release adds
   * reach the gate without a path or a command, so no rule below can stand in
   * for their behavior. Auto Review asks about them; Full Access keeps
   * auto-approving, like every other request in that mode.
   */
  unclassifiedTool?: string
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
  sensitiveFileProtectionEnabled?: boolean
  approvalTtlMs?: number
  protectedPathPatterns?: readonly string[]
  /** Absolute paths the user explicitly provided for this turn (attachments).
   *  These are always in scope regardless of location or protected status. */
  allowedPaths?: readonly string[]
  /** When true, only `allowedPaths` are permitted; every other path (even
   *  inside the project root) requires explicit approval. Used by File-System-
   *  OFF chats so the agent can only touch files the user attached. */
  restrictToAllowed?: boolean
  /** Absolute directories pre-authorized for this session (the chat's own
   *  `chats-cwd/<threadId>` workspace directory, and a project's `.cio` agent
   *  scratch folder). Everything confined to one of them is auto-approved in
   *  every mode, File-System-OFF chats included: path-scoped operations
   *  (deletes included) and shell commands the policy can prove stay inside.
   *  Anything that cannot be proven confined still asks. */
  scratchPaths?: readonly string[]
  now?: () => number
}

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000
const SAFE_AUTO_PERMISSIONS = new Set(['read', 'list', 'search'])
/** Folders inside a scratch root that the platform owns: feature specs and the
 *  PR worktrees of `.cio/git`. The rest of scratch is the agent's own space,
 *  but deleting a spec or a worktree destroys authored work, so those stay
 *  gated even though their parent folder never prompts. */
const SCRATCH_RESERVED_DIRECTORIES = ['specs', 'git'] as const
/** Commands that run another command from a string. A scratch-confined call
 *  cannot vouch for what these evaluate, so they always ask. */
const SHELL_INTERPRETERS = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'fish',
  'ksh',
  'csh',
  'tcsh',
  'cmd',
  'cmd.exe',
  'powershell',
  'pwsh',
  'node',
  'nodejs',
  'deno',
  'python',
  'python3',
  'perl',
  'ruby',
  'eval',
  'source',
  'xargs'
])
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
  private readonly scratchPaths: readonly string[]
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
    this.scratchPaths = (options.scratchPaths ?? []).map((path) => resolve(path))
    this.restrictToAllowed = options.restrictToAllowed === true
    this.now = options.now ?? Date.now
  }

  evaluate(request: PermissionRequest): PermissionDecisionResult {
    const permission = normalizePermissionName(request.permission)
    const risk = classifyPermissionRisk(permission)
    const rawPaths =
      request.path === undefined ? (request.paths ?? []) : [request.path, ...(request.paths ?? [])]
    const paths = rawPaths.map(normalizeNativePath)
    const scope = this.createScope(paths)

    if (permission === 'bundled-pi-sensitive-files') {
      if (this.options.sensitiveFileProtectionEnabled === false) {
        return this.createDecision(
          this.options.mode,
          true,
          'Sensitive-file checks are disabled in settings.',
          'low',
          scope
        )
      }
      return this.createDecision(
        'ask',
        false,
        'This action targets a file in your sensitive-file block list. Approval is required for this invocation.',
        'critical',
        scope
      )
    }

    if (!permission) {
      return this.createDecision('ask', false, 'A permission name is required.', 'low', scope)
    }

    if (this.options.mode === 'auto_review') {
      return this.evaluateAutoReview(
        permission,
        risk,
        paths,
        request.commands ?? [],
        scope,
        request.unclassifiedTool
      )
    }

    return this.evaluateFullAccess(permission, risk, paths, scope)
  }

  private evaluateAutoReview(
    permission: string,
    risk: PermissionRisk,
    paths: readonly string[],
    commands: readonly string[],
    scope: PermissionScope,
    unclassifiedTool?: string
  ): PermissionDecisionResult {
    // Scratch is the folder the agent was handed for its own work, so its own
    // housekeeping there (clearing a staged package, deleting a temp file,
    // moving artifacts around the scratch tree) never reaches the user. The
    // check is textual and conservative: a command that cannot be proven to
    // stay inside scratch falls through to the rules below and asks.
    if (!unclassifiedTool && this.isScratchScope(paths, commands)) {
      return this.createDecision(
        'auto_review',
        true,
        "Auto-approved: the operation stays inside this thread's scratch folder.",
        risk,
        scope
      )
    }

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

    const listingPaths =
      !unclassifiedTool && ['shell', 'bash', 'shell-exec'].includes(permission)
        ? commands.map((command) => scratchListingPaths(command, this.projectRoot))
        : []
    if (
      listingPaths.length > 0 &&
      listingPaths.every((targets) =>
        targets?.every((target) => this.scratchPaths.includes(target))
      ) &&
      paths.every((path) => this.scratchPaths.includes(resolve(this.projectRoot, path)))
    ) {
      return this.createDecision(
        'auto_review',
        true,
        'Auto-approved: listing the workspace directory owned by this chat.',
        'low',
        this.createScope(listingPaths.flatMap((targets) => targets ?? []))
      )
    }

    // File-System-OFF chats only auto-approve reads confined to the attached
    // files. Shell commands, writes, and reads elsewhere must ask   the agent
    // must not reach the broader file system (or the shell) unprompted.
    if (this.restrictToAllowed) {
      const confinedRead =
        commands.length === 0 &&
        isSafeAutoPermission(permission) &&
        paths.length > 0 &&
        paths.every((path) => {
          const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path)
          return this.isAllowedPath(resolvedPath)
        })
      if (!confinedRead) {
        return this.createDecision(
          'ask',
          false,
          'Work inside this chat workspace is already authorized; access outside it requires an attached input or your approval.',
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

    // A tool the caller could not classify is never auto-approved. The
    // extension already ruled out a read-only surface, and no path rule can
    // replace the behavior of a tool the app does not know, so the user decides.
    if (unclassifiedTool) {
      return this.createDecision(
        'ask',
        false,
        `"${unclassifiedTool}" is a tool CodeInOven cannot verify as read-only, so it needs your approval.`,
        'medium',
        scope
      )
    }

    return this.createDecision(
      'auto_review',
      true,
      'Auto Review   every permission that is not explicitly denied is auto-approved.',
      risk,
      scope
    )
  }

  /** Whether the whole request stays inside a pre-authorized scratch directory:
   *  every requested path, and every shell command, must resolve there. */
  private isScratchScope(paths: readonly string[], commands: readonly string[]): boolean {
    if (this.scratchPaths.length === 0) return false
    if (paths.length === 0 && commands.length === 0) return false
    if (!paths.every((path) => this.isScratchPath(this.projectRoot, path))) return false
    return commands.every((command) => this.isScratchCommand(command))
  }

  /** Whether one path, resolved against `base` when relative, lands inside a
   *  scratch root but outside the folders the platform owns. */
  private isScratchPath(base: string, path: string): boolean {
    if (!path || path.startsWith('~') || hasTraversal(path)) return false
    const normalized = normalizeNativePath(path)
    const resolvedPath = isAbsolute(normalized) ? resolve(normalized) : resolve(base, normalized)
    return this.isScratchRoot(resolvedPath)
  }

  private isScratchRoot(resolvedPath: string): boolean {
    const inScratch = this.scratchPaths.some((scratch) => isWithinDirectory(scratch, resolvedPath))
    if (!inScratch) return false
    return !this.scratchPaths.some((scratch) => {
      // Only project scratch has platform-owned lifecycle folders. A chat
      // owns every subdirectory of its dedicated workspace.
      if (basename(scratch) !== '.cio') return false
      return SCRATCH_RESERVED_DIRECTORIES.some((reserved) =>
        isWithinDirectory(resolve(scratch, reserved), resolvedPath)
      )
    })
  }

  /**
   * Whether a shell command provably runs entirely inside scratch.
   *
   * Only a simple command (or a `&&`/`||`/`;`/`|` chain of them) whose every
   * operand resolves inside a scratch root qualifies. The working directory
   * starts at the project root, which is outside scratch, so a bare relative
   * operand or a command with no path operand at all rejects until the chain
   * `cd`s into scratch. Redirection, substitution, traversal, and anything that
   * evaluates another command reject: those can reach outside without naming a
   * path the policy can see.
   */
  private isScratchCommand(command: string): boolean {
    if (!command.trim() || command.length > 8192) return false
    if (/[`$<>]/u.test(command) || /\n|\r/u.test(command)) return false
    const segments = shellSegments(command)
    if (!segments) return false
    let workingDirectory = this.projectRoot
    for (const segment of segments) {
      const [name, ...operands] = segment
      if (name === undefined) return false
      if (SHELL_INTERPRETERS.has(basename(name).toLowerCase()) || name === 'bun') {
        // A chat may run a script it created in its own cwd, just as it may
        // create the file. Keep inline evaluation and shell wrappers gated:
        // their arguments are code, so path checks cannot establish scope.
        const runtime = basename(name).toLowerCase()
        const script = runtime === 'bun' && operands[0] === 'run' ? operands[1] : operands[0]
        if (
          !this.scratchPaths.includes(this.projectRoot) ||
          !['python', 'python3', 'node', 'nodejs', 'bun', 'deno', 'ruby', 'perl'].includes(
            runtime
          ) ||
          script === undefined ||
          script.startsWith('-') ||
          !/\.(?:py|js|mjs|cjs|ts|mts|rb|pl)$/u.test(script) ||
          !this.resolveScratchTarget(workingDirectory, script)
        )
          return false
      }
      if (name === 'cd' || name === 'pushd') {
        const target = operands.find((operand) => !operand.startsWith('-'))
        if (target === undefined || operands.length > 1) return false
        const next = this.resolveScratchTarget(workingDirectory, target)
        if (next === undefined) return false
        workingDirectory = next
        continue
      }
      const targets = operands.filter((operand) => !operand.startsWith('-'))
      if (!targets.every((target) => this.resolveScratchTarget(workingDirectory, target))) {
        return false
      }
      // A segment with no path operand acts on its working directory, so that
      // directory itself has to be scratch (this is what keeps `git clean -fdx`
      // run from the project root from being mistaken for scratch work).
      if (targets.length === 0 && !this.isScratchRoot(workingDirectory)) return false
    }
    return true
  }

  private resolveScratchTarget(base: string, operand: string): string | undefined {
    if (!this.isScratchPath(base, operand)) return undefined
    const normalized = normalizeNativePath(operand)
    return isAbsolute(normalized) ? resolve(normalized) : resolve(base, normalized)
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
      'Full Access   yolo mode, every operation is auto-approved.',
      risk,
      scope
    )
  }

  private getAutoReviewPathReason(paths: readonly string[]): string | undefined {
    for (const path of paths) {
      const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path)

      // Match the normalized user-supplied input before rejecting traversal:
      // a supplied ../reference.png is as authorized as its absolute path.
      if (this.isAllowedPath(resolvedPath)) {
        continue
      }

      if (hasTraversal(path)) {
        return `Path traversal is not permitted: ${path}`
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
   *  requirement does not apply). A matching path   or any path below a directory
   *  that was attached   is always permitted. */
  private isAllowedPath(path: string): boolean {
    return this.allowedPaths.some((allowed) => {
      return allowed === path || isWithinDirectory(allowed, path)
    })
  }

  private isProtectedPath(path: string): boolean {
    const relativePath = toPosixPath(relative(this.projectRoot, path))
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

/** Rewrite POSIX/MSYS-style Windows drive paths ("/C/Users/...") into native
 *  Windows form ("C:\\Users\\..."). Tools running under the agent harness on
 *  Windows report such paths; resolving them verbatim anchors them to the
 *  current drive's root ("C:\\C\\Users\\..."), which makes in-project files
 *  look like external paths and triggers spurious permission prompts. */
export function normalizeNativePath(path: string): string {
  if (process.platform !== 'win32') return path
  const match = /^\/([A-Za-z])(?=\/|$)/u.exec(path)
  if (match === null) return path
  return `${match[1]!.toUpperCase()}:\\${path.slice(match[0].length).replaceAll('/', '\\')}`
}

function containsTerm(terms: readonly string[], candidates: readonly string[]): boolean {
  return terms.some((term) => candidates.includes(term))
}

/** Split a shell command into its pipeline/chain segments, honoring quotes so
 *  an operator inside a quoted argument stays part of that argument. Returns
 *  undefined when the quotes do not balance. */
function shellSegments(command: string): string[][] | undefined {
  const segments: string[][] = []
  let segment: string[] = []
  let token = ''
  let quote: '"' | "'" | null = null
  const endToken = (): void => {
    if (token) segment.push(token)
    token = ''
  }
  const endSegment = (): void => {
    endToken()
    if (segment.length > 0) segments.push(segment)
    segment = []
  }
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote !== null) {
      if (character === quote) quote = null
      else token += character
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === ' ' || character === '\t') {
      endToken()
      continue
    }
    if (character === '&' || character === '|' || character === ';') {
      if (character === '&' && command[index + 1] === '>') {
        // `<fd>>&<fd>` duplicates a descriptor without touching the file
        // system, so its descriptor digits are dropped instead of splitting
        // the segment.
        token = token.replace(/\d+$/u, '')
        index += 1
        while (/\d/u.test(command[index + 1] ?? '')) index += 1
        continue
      }
      endSegment()
      if ((character === '&' || character === '|') && command[index + 1] === character) index += 1
      continue
    }
    token += character
  }
  if (quote !== null) return undefined
  endSegment()
  return segments
}

/** Recognize only a literal ls of workspace roots. Descendants are excluded
 * because a directory symlink could lead outside the authorized workspace.
 * Never infer confinement for an arbitrary shell command from its cwd. */
function scratchListingPaths(command: string, cwd: string): string[] | undefined {
  if (command.length > 8192 || /[\\$`\n\r;&|<>*?[\]{}()]/u.test(command)) return undefined
  const tokens: string[] = []
  const tokenPattern = /"([^"\n]*)"|'([^'\n]*)'|([^\s"']+)/gu
  let end = 0
  for (const match of command.matchAll(tokenPattern)) {
    if (command.slice(end, match.index).trim() || (end > 0 && match.index === end)) return undefined
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
    end = match.index + match[0].length
  }
  if (command.slice(end).trim() || tokens.shift() !== 'ls') return undefined
  const targets: string[] = []
  let options = true
  for (const token of tokens) {
    if (options && token === '--') {
      options = false
      continue
    }
    if (options && token.startsWith('-')) {
      // No recursion, dereferencing, or flags that take additional arguments.
      if (!/^-[alhdFprtS1n]+$/u.test(token)) return undefined
      continue
    }
    if (!token || hasTraversal(token) || token.startsWith('~')) return undefined
    targets.push(resolve(cwd, normalizeNativePath(token)))
  }
  return targets.length > 0 ? targets : [cwd]
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
