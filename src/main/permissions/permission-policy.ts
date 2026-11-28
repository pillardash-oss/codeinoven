import { basename, isAbsolute, relative, resolve, sep } from 'path'
import { toPosixPath } from '../../lib/paths'
import { tmpdir } from 'os'
import { CIO_SCRATCH_DIRECTORY } from '../../lib/cio-cleanup'
import { isOvenMode, type PermissionPolicyMode } from '../../lib/permission-level'
import { deletionTargets } from './agent-created-files'

export type PermissionRisk = 'low' | 'medium' | 'high' | 'critical'
/** The modes a policy evaluates with. Oven Mode is the highest: it behaves like
 *  Full Access with every protective check forced off, so no card can ever be
 *  produced. Declared in `src/lib/permission-level.ts` so the renderer can name
 *  it too. */
export type { PermissionPolicyMode }
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
   * for their behavior. An unverifiable capability is critical by definition,
   * so Auto Review asks about it; Full Access keeps auto-approving, like every
   * other request in that mode.
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
  /** Absolute paths this session created itself, in POSIX form. Removing one
   *  of them is the agent clearing away its own throwaway work, wherever it
   *  put it, so it never needs a card. An overwrite never counts: the chat
   *  engine only records a path when the call genuinely brought the file into
   *  existence. */
  agentCreatedPaths?: readonly string[]
  /** Absolute directories this session owns outright: an assistant task's own
   *  `assistant-cwd/<assistantId ?? threadId>` root, or a chat's own
   *  `chats-cwd/<threadId>` / `browser-cwd/<threadId>` workspace. The
   *  sensitive-file block list exists to protect secrets the session does not
   *  own, so a protected name inside one of these roots is the session's own
   *  business and never needs an approval. Targets that leave the roots keep
   *  asking. */
  workspaceRoots?: readonly string[]
  now?: () => number
}

const DEFAULT_APPROVAL_TTL_MS = 5 * 60 * 1000
const SAFE_AUTO_PERMISSIONS = new Set(['read', 'list', 'search'])
/** Folders inside a scratch root that the platform owns: feature specs and the
 *  PR worktrees of `.cio/git`. The rest of scratch is the agent's own space,
 *  but deleting a spec or a worktree destroys authored work, so those stay
 *  gated even though their parent folder never prompts. */
const SCRATCH_RESERVED_DIRECTORIES = ['specs', 'git'] as const
/** Package managers whose `run <task>` executes the project's own script, and
 *  the shape of a task name. */
const PACKAGE_TASK_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const PACKAGE_TASK_NAME = /^[A-Za-z0-9:_.-]+$/u

/** Whether one segment runs a package task by name (`bun run build`).
 *
 *  That is the project's own script, which Auto Review already runs without a
 *  card when the task stands alone, so it is read as an ordinary segment when
 *  deciding what a destructive chain deletes. Everything else an interpreter
 *  can do is not a task: inline code (`bash -c`, `bun -e`) and a script file
 *  (`bun ./stage/x.ts`) can reach anywhere without naming a path this module
 *  can see. */
function isPackageTaskRun(commandName: string, operands: readonly string[]): boolean {
  if (!PACKAGE_TASK_RUNNERS.has(commandName)) return false
  const verb = operands[0]
  const task = operands[1]
  if (verb !== 'run' && verb !== 'run-script') return false
  return task !== undefined && PACKAGE_TASK_NAME.test(task)
}

/** One `NAME=<literal>` assignment a chain made before using it. Only literal
 *  text is recorded: a value that evaluates anything stays unresolved, so the
 *  proofs below keep asking about it. */
const SHELL_ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/u
const SHELL_ASSIGNMENT_VALUE = /^[A-Za-z0-9._~/-]+$/u

function recordShellAssignment(tokens: readonly string[], variables: Map<string, string>): boolean {
  if (tokens.length !== 1) return false
  const match = SHELL_ASSIGNMENT.exec(tokens[0] ?? '')
  const name = match?.[1]
  const value = match?.[2]
  if (name === undefined || value === undefined) return false
  if (!SHELL_ASSIGNMENT_VALUE.test(value)) return false
  variables.set(name, value)
  return true
}

/** One token as the shell hands it to a command, with the positions the shell
 *  reads literally recorded: single-quoted text, and a character a backslash
 *  escaped, expand nothing. */
interface ShellToken {
  readonly text: string
  readonly literal: readonly boolean[]
}

/** One token with the chain's own literal assignments and `$PWD` applied.
 *
 *  `$PWD` is the directory the shell is in at that point, which the caller
 *  tracks through `cd`. A `$` or a backtick the shell would act on is unreadable
 *  here, so an unknown variable, a substitution, and a `$1` all make the whole
 *  token undefined. The same characters inside single quotes are plain text, so
 *  they are kept as written. */
function expandShellToken(
  token: ShellToken,
  variables: ReadonlyMap<string, string>,
  workingDirectory: string
): string | undefined {
  let expanded = ''
  for (let index = 0; index < token.text.length; index += 1) {
    const character = token.text[index]!
    if (token.literal[index] === true) {
      expanded += character
      continue
    }
    if (character === '`') return undefined
    if (character !== '$') {
      expanded += character
      continue
    }
    const rest = token.text.slice(index)
    const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}|^\$([A-Za-z_][A-Za-z0-9_]*)/u.exec(rest)
    if (match === null) return undefined
    const name = match[1] ?? match[2] ?? ''
    if (name === 'PWD') {
      expanded += workingDirectory
    } else {
      const value = variables.get(name)
      if (value === undefined) return undefined
      expanded += value
    }
    index += match[0].length - 1
  }
  return expanded
}

/** Every token of one segment, expanded. Undefined when any of them is
 *  unreadable, because a proof that skips one token proves nothing. */
function expandShellSegment(
  segment: readonly ShellToken[],
  variables: ReadonlyMap<string, string>,
  workingDirectory: string
): string[] | undefined {
  const expanded: string[] = []
  for (const token of segment) {
    const value = expandShellToken(token, variables, workingDirectory)
    if (value === undefined) return undefined
    expanded.push(value)
  }
  return expanded
}

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
/** Command names whose segment removes entries from the file system. */
const DESTRUCTIVE_SEGMENTS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri'])
/** Longest shell command the confinement proof will read. Anything longer is
 *  left to the ordinary card instead of being parsed. */
const MAX_PROVEN_COMMAND_LENGTH = 8192
/** What each destructive verb looks like. Every lookahead stops at the end of
 *  the verb's own segment (`;`, `&`, `|`) as well as at a newline: a flag on a
 *  later command is that command's, so `rm -f scan/*; git status --porcelain`
 *  is not a recursive delete because `--porcelain` happens to contain an `r`.
 *
 *  A newline ends a command exactly as `;` does, so every verb is anchored on
 *  one too. Without it, `echo start` and a following line `rm -rf /` read as a
 *  single command with no destructive verb in it, and the delete ran without a
 *  card. */
const DESTRUCTIVE_COMMAND_PATTERNS = [
  /(?:^|[;&|\n]\s*)rm\s+(?=[^\n;&|]*(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?:\s|$))/u,
  /(?:^|[;&|\n]\s*)find\s+[^\n;&|]+\s-delete(?:\s|$)/u,
  /(?:^|[;&|\n]\s*)git\s+clean\s+(?=[^\n;&|]*-[a-zA-Z]*f)(?=[^\n;&|]*-[a-zA-Z]*d)/u,
  /(?:^|[;&|\n]\s*)Remove-Item\b[^\n;&|]*\s-Recurse\b/iu,
  /(?:^|[;&|\n]\s*)(?:rmdir|rd|del)\b[^\n;&|]*\s\/(?:s|S)\b/u
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
  private readonly agentCreatedPaths: ReadonlySet<string>
  private readonly workspaceRoots: readonly string[]
  private readonly restrictToAllowed: boolean
  private readonly sensitiveFileProtectionEnabled: boolean
  private readonly ovenMode: boolean
  private readonly now: () => number

  constructor(private readonly options: PermissionPolicyOptions) {
    this.projectRoot = resolve(options.projectRoot)
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS
    // Oven Mode is the top level: the agent works on an external Oven the user
    // handed it, so the protections Full Access still honors are off. Forcing
    // them here keeps the guarantee even if a caller passes them anyway, and
    // `evaluate` never reaches a rule that could ask.
    this.ovenMode = isOvenMode(options.mode)
    this.protectedPathPatterns = this.ovenMode
      ? []
      : [...DEFAULT_PROTECTED_PATTERNS, ...(options.protectedPathPatterns ?? [])]
    this.allowedPaths = (options.allowedPaths ?? []).map((path) => resolve(path))
    this.scratchPaths = (options.scratchPaths ?? []).map((path) => resolve(path))
    this.agentCreatedPaths = new Set(
      (options.agentCreatedPaths ?? []).map((path) => toPosixPath(resolve(path)))
    )
    this.workspaceRoots = (options.workspaceRoots ?? []).map((path) => resolve(path))
    this.restrictToAllowed = !this.ovenMode && options.restrictToAllowed === true
    this.sensitiveFileProtectionEnabled =
      !this.ovenMode && options.sensitiveFileProtectionEnabled !== false
    this.now = options.now ?? Date.now
  }

  evaluate(request: PermissionRequest): PermissionDecisionResult {
    const permission = normalizePermissionName(request.permission)
    const risk = classifyPermissionRisk(permission)
    const rawPaths =
      request.path === undefined ? (request.paths ?? []) : [request.path, ...(request.paths ?? [])]
    const paths = rawPaths.map(normalizeNativePath)
    const scope = this.createScope(paths)

    // Oven Mode approves everything, before any rule below can raise a card:
    // the sensitive-file block list, the bundled-pi file policy, protected path
    // patterns, `restrictToAllowed`, and the workspace-root rules are all off,
    // because the machine the agent is working on is the user's own Oven and
    // the task may need anything on it. A malformed request (an empty
    // permission name) is approved too: it is a harness payload, not a policy
    // decision, and parking an Oven turn for it serves nobody. The decision
    // value stays `oven_mode` so the ledger records which level approved.
    if (this.ovenMode) {
      return this.createDecision(
        'oven_mode',
        true,
        'Oven Mode   the agent works on an external Oven, so every operation is auto-approved.',
        // The risk describes the operation, not the tier: a protected-file
        // request keeps the critical risk that makes it legible in the ledger,
        // even though Oven Mode approves it without a card.
        permission === 'bundled-pi-sensitive-files' ? 'critical' : risk,
        scope
      )
    }

    if (permission === 'bundled-pi-sensitive-files') {
      if (!this.sensitiveFileProtectionEnabled) {
        return this.createDecision(
          this.options.mode,
          true,
          'Sensitive-file checks are disabled in settings.',
          'low',
          scope
        )
      }
      // Everything inside the session's own workspace is its own work: an
      // assistant using a `.env` or a `credentials/` folder it created is not
      // reaching anyone else's secret. Only targets that leave that workspace
      // still need the user's approval.
      const outsideWorkspace = paths.filter(
        (path) => !this.isWorkspacePath(path) && !this.isAgentCreatedPath(path)
      )
      if (paths.length > 0 && outsideWorkspace.length === 0) {
        return this.createDecision(
          'auto_review',
          true,
          "Auto-approved: the protected file is inside this session's own workspace.",
          'low',
          scope
        )
      }
      const narrowed = outsideWorkspace.length > 0 && outsideWorkspace.length < paths.length
      return this.createDecision(
        'ask',
        false,
        narrowed
          ? "This action targets a protected file outside this session's own workspace. Approval is required for this invocation."
          : 'This action targets a file in your sensitive-file block list. Approval is required for this invocation.',
        'critical',
        narrowed ? this.createScope(outsideWorkspace) : scope
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

    // An agent's own throwaway files are its to remove. This runs before the
    // destructive rules below because those rules exist to protect work the
    // session does not own, and a file the session just created is not that.
    if (this.isAgentCreatedCleanup(permission, paths, commands)) {
      return this.createDecision(
        'auto_review',
        true,
        'Auto-approved: the agent is removing a file this session created itself.',
        risk,
        scope
      )
    }

    const destructiveReason = this.getDestructiveReason(permission)
    if (destructiveReason) {
      return this.createDecision('ask', false, destructiveReason, risk, scope)
    }

    const destructiveCommands = commands.filter((command) =>
      DESTRUCTIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command))
    )
    if (destructiveCommands.length > 0) {
      // The command still runs on the user's machine, but a removal that
      // provably stays inside the folder this session was handed (its own
      // workspace, its scratch tree, or a path it created itself) is the
      // agent clearing away its own work. A compound command with a
      // redirection or a glob stays readable that way because only the delete
      // segments are proven; every other segment can reach no further than an
      // ordinary command already does.
      const unproven = destructiveCommands.find(
        (command) => !this.isConfinedDestructiveCommand(command)
      )
      if (unproven === undefined) {
        return this.createDecision(
          'auto_review',
          true,
          "Auto-approved: the command removes only files inside this session's own workspace.",
          risk,
          scope
        )
      }
      return this.createDecision(
        'ask',
        false,
        `Recursive or destructive command requires explicit approval: ${unproven}`,
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

    // Auto Review stops for critical work only. Everything high risk and below
    // runs without a card, which is why the scope rules below no longer deny a
    // path just for leaving the open project.
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

    const pathDenial = this.getAutoReviewPathDenial(paths, risk)
    if (pathDenial) {
      return this.createDecision('ask', false, pathDenial.reason, pathDenial.risk, scope)
    }

    // A tool the caller could not classify is never auto-approved. The
    // extension already ruled out a read-only surface, and no path rule can
    // replace the behavior of a tool the app does not know, so the user decides.
    // It carries critical risk because an unverifiable capability can do
    // anything, which is exactly the tier Auto Review still stops for.
    if (unclassifiedTool) {
      return this.createDecision(
        'ask',
        false,
        `"${unclassifiedTool}" is a tool CodeInOven cannot verify as read-only, so it needs your approval.`,
        'critical',
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

  /** Whether a path resolves inside a directory this session owns outright.
   *  A `~` prefix or a traversal segment is never proven to stay inside, so it
   *  keeps the protected-file card. */
  private isWorkspacePath(path: string): boolean {
    if (this.workspaceRoots.length === 0) return false
    if (!path || path.startsWith('~') || hasTraversal(path)) return false
    const normalized = normalizeNativePath(path)
    const resolvedPath = isAbsolute(normalized)
      ? resolve(normalized)
      : resolve(this.projectRoot, normalized)
    return this.workspaceRoots.some((root) => isWithinDirectory(root, resolvedPath))
  }

  /** Whether a path is one this session created itself.
   *
   *  Only an exact match qualifies. Deleting a directory the session created
   *  one of its files inside is a broader removal than the session made, so it
   *  keeps its card. */
  private isAgentCreatedPath(path: string): boolean {
    if (this.agentCreatedPaths.size === 0) return false
    const normalized = toPosixPath(
      isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path)
    )
    return this.agentCreatedPaths.has(normalized)
  }

  /** Whether the request removes nothing but files this session created. A
   *  readable delete command names its targets; a delete permission names them
   *  directly. Anything unreadable is not proven, so the card still asks. */
  private isAgentCreatedCleanup(
    permission: string,
    paths: readonly string[],
    commands: readonly string[]
  ): boolean {
    if (this.agentCreatedPaths.size === 0) return false
    const targets = deletionTargets(permission, paths, commands, this.projectRoot)
    if (targets === undefined || targets.length === 0) return false
    // Every target the request names has to be the session's own creation, so a
    // request that also points anywhere else keeps its card.
    if (!paths.every((path) => this.isAgentCreatedPath(path))) return false
    return targets.every((target) => this.agentCreatedPaths.has(target))
  }

  /** Whether removing `resolvedPath` only touches work this session owns: a
   *  path the session created itself, its scratch tree (minus the folders the
   *  platform owns), or its own workspace root. */
  private isConfinedDeletionTarget(resolvedPath: string): boolean {
    if (this.agentCreatedPaths.has(toPosixPath(resolvedPath))) return true
    if (this.isScratchRoot(resolvedPath)) return true
    return this.workspaceRoots.some((root) => {
      if (!isWithinDirectory(root, resolvedPath)) return false
      return !SCRATCH_RESERVED_DIRECTORIES.some((reserved) =>
        isWithinDirectory(resolve(root, CIO_SCRATCH_DIRECTORY, reserved), resolvedPath)
      )
    })
  }

  /** Whether a delete target with a glob provably only enumerates inside work
   *  this session owns.
   *
   *  A shell glob expands to names inside the directory its static prefix
   *  names; it cannot climb out without a literal `..`, and a target that names
   *  one is refused. So deleting a `packages` glob of build output under the
   *  stage proves what deleting one package's output proves. A pattern with no
   *  prefix at all (`rm -rf *`, `rm -rf /*`) still asks: it names no directory
   *  this module can check. */
  private isConfinedDeletionGlob(target: string, base: string): boolean {
    if (!target || target.startsWith('~')) return false
    if (hasTraversal(target)) return false
    const prefix = target.split(/[*?[\]]/u)[0] ?? ''
    if (prefix.length === 0) return false
    const normalized = normalizeNativePath(prefix)
    const resolvedPrefix = isAbsolute(normalized) ? resolve(normalized) : resolve(base, normalized)
    return this.isConfinedDeletionTarget(resolvedPrefix)
  }

  /** Whether a shell command provably removes only files this session owns.
   *
   *  Only the segments that actually delete are proven, and each one is
   *  resolved against the working directory the chain has `cd`ed into so a
   *  `cd` out of the session's roots rejects. A glob, a substitution, a `~`,
   *  or a wrapper that evaluates another command hides its targets, so it
   *  yields false and the ordinary card still asks. A `NAME=<literal>`
   *  assignment is followed the way the shell follows it, and `$PWD` is the
   *  directory the chain is in at that point, so `S=.cio/tmp/stage; rm -rf
   *  "$S"` proves what `rm -rf .cio/tmp/stage` proves. A package task run
   *  (`bun run build`) is the project's own script, which is trusted on its
   *  own, so it removes nothing here either.
   */
  private isConfinedDestructiveCommand(command: string): boolean {
    if (!command.trim() || command.length > MAX_PROVEN_COMMAND_LENGTH) return false
    // A chain written across lines is read one command per line, which the
    // segment proof below does not do yet, so it keeps its card. A backtick or
    // a brace outside single quotes can substitute a command or expand into
    // arguments this module cannot see; the same characters inside single
    // quotes are plain text the shell hands to the command.
    if (/\n|\r/u.test(command)) return false
    if (containsLiveShellCharacter(command, '`{}', '`')) return false
    const segments = shellSegments(command)
    if (!segments) return false
    const variables = new Map<string, string>()
    let workingDirectory: string | undefined = this.projectRoot
    let removesSomething = false
    for (const segment of segments) {
      const expanded = expandShellSegment(segment, variables, workingDirectory ?? this.projectRoot)
      if (expanded === undefined) return false
      if (recordShellAssignment(expanded, variables)) continue
      const references = segmentReferences(expanded)
      if (references === undefined) return false
      const [name, ...operands] = references.tokens
      if (name === undefined) return false
      const commandName = basename(name).toLowerCase()
      if (SHELL_INTERPRETERS.has(commandName) || commandName === 'bun') {
        if (!isPackageTaskRun(commandName, operands)) return false
        // A task run removes nothing itself; its own deletes are the project's
        // script, which is trusted on its own.
        continue
      }
      if (commandName === 'cd' || commandName === 'pushd') {
        const cdOperands = operands.filter((token) => !token.startsWith('-'))
        if (cdOperands.length !== 1 || !isReadableTarget(cdOperands[0]!)) {
          workingDirectory = undefined
          continue
        }
        const normalized = normalizeNativePath(cdOperands[0]!)
        workingDirectory = isAbsolute(normalized)
          ? resolve(normalized)
          : resolve(workingDirectory ?? this.projectRoot, normalized)
        continue
      }
      const removal = destructiveSegmentRemovals(references.tokens)
      if (removal === undefined) continue
      removesSomething = true
      if (workingDirectory === undefined) return false
      if (removal === 'working-directory') {
        // `git clean` acts on the directory it runs in, so that directory
        // itself has to be one of the session's own roots.
        if (!this.isConfinedDeletionTarget(workingDirectory)) return false
        continue
      }
      if (removal.length === 0) return false
      for (const target of removal) {
        if (!isReadableTarget(target)) {
          // A glob is proven by the directory it enumerates, not by the names
          // it matches: a pattern cannot leave the directory its static prefix
          // names without a literal `..`, and that is refused here.
          if (!this.isConfinedDeletionGlob(target, workingDirectory)) return false
          continue
        }
        const normalized = normalizeNativePath(target)
        const resolvedPath = isAbsolute(normalized)
          ? resolve(normalized)
          : resolve(workingDirectory, normalized)
        if (!this.isConfinedDeletionTarget(resolvedPath)) return false
      }
    }
    return removesSomething
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
   * operand, and every file its redirections name, resolves inside a scratch
   * root qualifies. The working directory starts at the project root, which is
   * outside scratch, so a bare relative operand or a command with no path
   * operand at all rejects until the chain `cd`s into scratch. Substitution,
   * traversal, a heredoc, and anything that evaluates another command reject:
   * those can reach outside without naming a path the policy can see. A
   * redirect to `/dev/null` and a descriptor duplication name no file at all,
   * so they never disqualify an otherwise confined command. A `NAME=<literal>`
   * assignment is read the way the shell reads it, and `$PWD` is the directory
   * the chain is in at that point, so staging through `S=.cio/tmp/stage` is
   * provable instead of asking because a `$` appeared.
   */
  private isScratchCommand(command: string): boolean {
    if (!command.trim() || command.length > 8192) return false
    if (/\n|\r/u.test(command)) return false
    // Brace expansion happens before a path is resolved, so `tmp/{..,..}` names
    // a directory this module never sees. Only the literal characters inside
    // quotes are safe.
    if (containsLiveShellCharacter(command, '`{}', '`')) return false
    const segments = shellSegments(command)
    if (!segments) return false
    const variables = new Map<string, string>()
    let workingDirectory = this.projectRoot
    for (const segment of segments) {
      const expanded = expandShellSegment(segment, variables, workingDirectory)
      if (expanded === undefined) return false
      if (recordShellAssignment(expanded, variables)) continue
      const references = segmentReferences(expanded)
      if (references === undefined) return false
      const [name, ...operands] = references.tokens
      if (name === undefined) return false
      for (const target of references.redirectTargets) {
        if (isTheVoid(target)) continue
        if (!this.resolveScratchTarget(workingDirectory, target)) return false
      }
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

  /** Path rules that still produce a card in Auto Review.
   *
   * Only a critical request is stopped by where it points. Auto Review runs
   * every operation that is not critical, so reading or editing a file outside
   * the open project (an absolute external path, or one that traverses out of
   * it) no longer parks the turn behind a card. Projects, chats, and assistants
   * all resolve through this policy, so the same rule governs each of them.
   * What stays gated is the sensitive-file block list, which is an explicit
   * denial regardless of tier, and the path scope of an already critical
   * request. */
  private getAutoReviewPathDenial(
    paths: readonly string[],
    risk: PermissionRisk
  ): { reason: string; risk: PermissionRisk } | undefined {
    for (const path of paths) {
      const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(this.projectRoot, path)

      // Match the normalized user-supplied input before rejecting traversal:
      // a supplied ../reference.png is as authorized as its absolute path.
      if (this.isAllowedPath(resolvedPath)) {
        continue
      }

      // File-System-OFF chats are restricted to the provided attachments.
      if (this.restrictToAllowed) {
        return {
          reason: `This chat is restricted to the files you attached. Reading other local files requires your approval: ${path}`,
          risk
        }
      }

      // The block list protects secrets the session does not own, so it is a
      // critical card wherever the target lives. A session's own workspace is
      // excluded: that is its own work, not someone else's secret.
      if (!this.isWorkspacePath(resolvedPath) && this.isProtectedPath(resolvedPath)) {
        return {
          reason: `Protected path access requires explicit approval: ${path}`,
          risk: 'critical'
        }
      }

      if (risk !== 'critical') {
        continue
      }

      if (hasTraversal(path)) {
        return { reason: `Path traversal is not permitted: ${path}`, risk }
      }

      if (
        !isWithinDirectory(this.projectRoot, resolvedPath) &&
        !isAllowedExternalPath(resolvedPath)
      ) {
        const type = isAbsolute(path) ? 'absolute external path' : 'path outside the project root'
        return { reason: `The ${type} is not permitted: ${path}`, risk }
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
 *  an operator inside a quoted argument stays part of that argument and
 *  recording which characters the shell reads literally. Returns undefined
 *  when the quotes do not balance. */
function shellSegments(command: string): ShellToken[][] | undefined {
  const segments: ShellToken[][] = []
  let segment: ShellToken[] = []
  let token = ''
  let literal: boolean[] = []
  let quote: '"' | "'" | null = null
  const push = (character: string, isLiteral: boolean): void => {
    token += character
    literal.push(isLiteral)
  }
  const endToken = (): void => {
    if (token) segment.push({ text: token, literal })
    token = ''
    literal = []
  }
  const endSegment = (): void => {
    endToken()
    if (segment.length > 0) segments.push(segment)
    segment = []
  }
  /** Drop a descriptor number a redirection operator was written against, so
   *  `2>&1` leaves no stray `2` token behind. */
  const trimDescriptors = (): void => {
    const trimmed = token.replace(/\d+$/u, '')
    literal = literal.slice(0, trimmed.length)
    token = trimmed
  }
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote !== null) {
      if (character === quote) {
        quote = null
        continue
      }
      const escapes = character === '\\' && quote === '"' && command[index + 1] !== undefined
      if (escapes) {
        index += 1
        push(command[index]!, true)
        continue
      }
      // A backtick and a `$` expand inside double quotes, so only single-quoted
      // text expands nothing at all.
      push(character, quote === "'" || (character !== '$' && character !== '`'))
      continue
    }
    if (character === '\\' && command[index + 1] !== undefined) {
      index += 1
      push(command[index]!, true)
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
    if (character === '>' && command[index + 1] === '&') {
      // `<fd>>&<fd>`, written `2>&1` or `>&2`, duplicates a descriptor
      // without touching the file system. Dropping the descriptor digits and
      // the duplication keeps the segment whole; treating the `&` as a
      // separator would split the command and leave an unreadable `2>`.
      trimDescriptors()
      index += 1
      while (/\d/u.test(command[index + 1] ?? '')) index += 1
      continue
    }
    if (character === '&' || character === '|' || character === ';') {
      if (character === '&' && command[index + 1] === '>') {
        // `&>file` sends both streams to a file; the target names it below.
        trimDescriptors()
        index += 1
        while (/\d/u.test(command[index + 1] ?? '')) index += 1
        continue
      }
      endSegment()
      if ((character === '&' || character === '|') && command[index + 1] === character) index += 1
      continue
    }
    push(character, false)
  }
  if (quote !== null) return undefined
  endSegment()
  return segments
}

/** Whether `command` contains one of `characters` where the shell acts on it
 *  instead of reading it as text.
 *
 *  Single quotes make the shell read everything literally, and a backslash
 *  escapes the next character, so `sed -i 's/^- \[ \] (Move the \`x\`)/…/'`
 *  names no substitution at all. Double quotes only stop some characters:
 *  `liveInsideDoubleQuotes` names the ones that still expand there, which is a
 *  backtick and never a brace. */
function containsLiveShellCharacter(
  command: string,
  characters: string,
  liveInsideDoubleQuotes: string
): boolean {
  let quote: '"' | "'" | null = null
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote !== "'" && character === '\\') {
      index += 1
      continue
    }
    if (quote === "'") {
      if (character === "'") quote = null
      continue
    }
    if (character === '"') {
      quote = quote === '"' ? null : '"'
      continue
    }
    if (quote === '"') {
      if (liveInsideDoubleQuotes.includes(character)) return true
      continue
    }
    if (character === "'") {
      quote = "'"
      continue
    }
    if (characters.includes(character)) return true
  }
  return false
}

function isReadableTarget(operand: string): boolean {
  return operand.length > 0 && !/[*?[\]~]/u.test(operand)
}

/** Whether a redirection target discards its stream instead of naming a file. */
function isTheVoid(target: string): boolean {
  return target === '/dev/null' || target === 'NUL'
}

/** Split one chain segment into the tokens a command acts on and the paths its
 *  redirections name. Descriptor duplication (`2>&1`, `>&2`) and a heredoc name
 *  no file at all, so they are dropped. Returns undefined for a redirection this
 *  module cannot read, which leaves the caller asking. */
function segmentReferences(
  segment: readonly string[]
): { tokens: string[]; redirectTargets: string[] } | undefined {
  const tokens: string[] = []
  const redirectTargets: string[] = []
  for (let index = 0; index < segment.length; index += 1) {
    const token = segment[index]!
    if (!/[<>]/u.test(token)) {
      tokens.push(token)
      continue
    }
    const match = /^(?:\d+|&)?(<<|>>|<|>)(.*)$/u.exec(token)
    if (match === null || match[1] === '<<') return undefined
    const inline = match[2]!
    const target = inline === '' ? segment[index + 1] : inline
    if (target === undefined || target === '' || /[<>]/u.test(target)) return undefined
    if (inline === '') index += 1
    if (target.startsWith('&') || /^\d+$/u.test(target)) continue
    redirectTargets.push(target)
  }
  return { tokens, redirectTargets }
}

/** What one chain segment removes: the operands it names, or
 *  `working-directory` when it removes entries from the directory it runs in
 *  (`git clean`). Undefined means the segment removes nothing. */
function destructiveSegmentRemovals(
  segment: readonly string[]
): string[] | 'working-directory' | undefined {
  const name = basename(segment[0] ?? '')
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|ps1)$/u, '')
  if (DESTRUCTIVE_SEGMENTS.has(name)) {
    return segment
      .slice(1)
      .filter((token) => !token.startsWith('-') && !/^\/[A-Za-z]$/u.test(token))
  }
  if (name === 'find' && segment.includes('-delete')) {
    return segment.slice(1, segment.indexOf('-delete')).filter((token) => !token.startsWith('-'))
  }
  if (name === 'git' && segment[1] === 'clean') return 'working-directory'
  return undefined
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
