import type { Database } from '../../main/database/database'
import {
  DEFAULT_SCOPE_BUCKET_ID,
  DEFAULT_SCOPE_WORKTREE_DEFAULTS,
  isManagedScopeRoot,
  type ManagedWorktreeDescriptor,
  type ProjectRootDescriptor,
  type ScopeBoard,
  type ScopeBucket,
  type ScopeEnvironmentMode,
  type ScopeRootDescriptor,
  type ScopeSetupCommandSpec,
  type ScopeSetupStatus,
  type ScopeWorktreeDefaults
} from '../types'

const SCOPE_BOARD_VERSION = 2

export class ScopeManagerError extends Error {}

function projectRoot(): ProjectRootDescriptor {
  return { kind: 'project' }
}

function defaultSetupStatus(): ScopeSetupStatus {
  return { state: 'not_run', commands: [] }
}

function defaultBucket(id: string, name: string, sortOrder: number): ScopeBucket {
  return {
    id,
    name,
    sortOrder,
    collapsed: false,
    collapsedSlices: [],
    root: projectRoot()
  }
}

function defaultBoard(): ScopeBoard {
  return {
    version: SCOPE_BOARD_VERSION,
    buckets: [defaultBucket(DEFAULT_SCOPE_BUCKET_ID, 'Default', 0)],
    worktreeDefaults: { ...DEFAULT_SCOPE_WORKTREE_DEFAULTS, setupCommands: [] }
  }
}

interface RawBucketLike {
  id?: unknown
  name?: unknown
  color?: unknown
  iconType?: unknown
  sortOrder?: unknown
  collapsed?: unknown
  collapsedSlices?: unknown
  root?: unknown
  archivedAt?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Structural guard applied to any root descriptor read from storage. */
function parseRootDescriptor(value: unknown): ScopeRootDescriptor {
  if (!isRecord(value)) throw new ScopeManagerError('Scope root descriptor must be an object')
  if (value.kind === 'project') return projectRoot()
  if (value.kind === 'worktree') {
    const descriptor = value as Partial<ManagedWorktreeDescriptor>
    if (
      typeof descriptor.directoryName !== 'string' ||
      typeof descriptor.branch !== 'string' ||
      typeof descriptor.baseBranch !== 'string' ||
      typeof descriptor.baseCommit !== 'string' ||
      typeof descriptor.createdAt !== 'number' ||
      (descriptor.environmentMode !== 'copy' && descriptor.environmentMode !== 'symlink')
    ) {
      throw new ScopeManagerError('Managed scope root descriptor is incomplete')
    }
    const setup = parseSetupStatus(descriptor.setup)
    return {
      kind: 'worktree',
      directoryName: descriptor.directoryName,
      branch: descriptor.branch,
      baseBranch: descriptor.baseBranch,
      baseCommit: descriptor.baseCommit,
      createdAt: descriptor.createdAt,
      environmentMode: descriptor.environmentMode,
      setup
    }
  }
  throw new ScopeManagerError(`Unsupported scope root kind: ${String(value.kind)}`)
}

function parseSetupStatus(value: unknown): ScopeSetupStatus {
  if (!isRecord(value) || typeof value.state !== 'string') return defaultSetupStatus()
  const commands = Array.isArray(value.commands) ? value.commands : []
  return {
    state: value.state as ScopeSetupStatus['state'],
    commands: commands.filter((entry): entry is ScopeSetupStatus['commands'][number] =>
      isRecord(entry)
    ) as ScopeSetupStatus['commands'],
    ...(typeof value.startedAt === 'number' ? { startedAt: value.startedAt } : {}),
    ...(typeof value.finishedAt === 'number' ? { finishedAt: value.finishedAt } : {})
  }
}

function parseBucket(raw: RawBucketLike): ScopeBucket {
  if (typeof raw.id !== 'string' || typeof raw.name !== 'string') {
    throw new ScopeManagerError('Scope bucket is missing its identity')
  }
  const bucket: ScopeBucket = {
    id: raw.id,
    name: raw.name,
    sortOrder: typeof raw.sortOrder === 'number' ? raw.sortOrder : 0,
    collapsed: raw.collapsed === true,
    collapsedSlices: Array.isArray(raw.collapsedSlices)
      ? (raw.collapsedSlices as ScopeBucket['collapsedSlices'])
      : [],
    root: raw.root === undefined ? projectRoot() : parseRootDescriptor(raw.root)
  }
  if (typeof raw.color === 'string') bucket.color = raw.color
  if (typeof raw.iconType === 'string') bucket.iconType = raw.iconType
  if (typeof raw.archivedAt === 'number') bucket.archivedAt = raw.archivedAt
  return bucket
}

function parseWorktreeDefaults(value: unknown): ScopeWorktreeDefaults {
  if (!isRecord(value)) return { ...DEFAULT_SCOPE_WORKTREE_DEFAULTS, setupCommands: [] }
  const commands = Array.isArray(value.setupCommands)
    ? value.setupCommands.filter(
        (entry): entry is ScopeSetupCommandSpec =>
          isRecord(entry) &&
          typeof entry.executable === 'string' &&
          Array.isArray(entry.args) &&
          entry.args.every((arg) => typeof arg === 'string')
      )
    : []
  return {
    setupCommands: commands.map((command) => ({
      executable: command.executable,
      args: [...command.args]
    })),
    runSetupByDefault: value.runSetupByDefault !== false,
    environmentMode:
      value.environmentMode === 'symlink'
        ? ('symlink' satisfies ScopeEnvironmentMode)
        : ('copy' satisfies ScopeEnvironmentMode)
  }
}

/**
 * Migrate a persisted version 1 board in memory: every existing bucket becomes
 * project-rooted and gains the version 2 defaults. Order, appearance, collapse
 * state, and thread assignments are untouched.
 */
function migrateVersion1(raw: Record<string, unknown>): ScopeBoard {
  const bucketsRaw = Array.isArray(raw.buckets) ? raw.buckets : []
  const buckets = bucketsRaw.map((entry) => parseBucket(entry as RawBucketLike))
  if (!buckets.some((bucket) => bucket.id === DEFAULT_SCOPE_BUCKET_ID)) {
    buckets.unshift(defaultBucket(DEFAULT_SCOPE_BUCKET_ID, 'Default', -1))
  }
  for (const bucket of buckets) {
    // The Default bucket must always remain project-rooted and non-archivable.
    if (bucket.id === DEFAULT_SCOPE_BUCKET_ID) {
      bucket.root = projectRoot()
      delete bucket.archivedAt
    } else if (bucket.root.kind !== 'worktree') {
      bucket.root = projectRoot()
    }
  }
  return {
    version: SCOPE_BOARD_VERSION,
    buckets: buckets.map((bucket, index) => ({ ...bucket, sortOrder: index })),
    worktreeDefaults: parseWorktreeDefaults(undefined)
  }
}

function normalizeVersion2(raw: Record<string, unknown>): ScopeBoard {
  const migrated = migrateVersion1(raw)
  migrated.worktreeDefaults = parseWorktreeDefaults(raw.worktreeDefaults)
  return migrated
}

export interface CreateScopeBucketInput {
  name: string
  color?: string
  iconType?: string
}

export interface UpdateScopeAppearanceInput {
  name?: string
  color?: string | null
  iconType?: string | null
}

export class ScopeManager {
  constructor(private db: Database) {}

  /**
   * Load the board for a project. Missing records produce a fresh default
   * board; version 1 records migrate deterministically to version 2; malformed
   * records fail loudly instead of silently discarding user scopes.
   */
  getBoard(projectId: string): ScopeBoard {
    const row = this.db.get<{ data: string }>(
      'SELECT data FROM scope_boards WHERE project_id=?',
      projectId
    )
    let board: ScopeBoard
    if (row) {
      board = this.parsePersisted(row.data)
    } else {
      board = defaultBoard()
    }
    this.assertInvariants(board)
    if (!row || this.needsPersistence(board, row.data)) {
      this.persist(projectId, board)
    }
    return board
  }

  private parsePersisted(data: string): ScopeBoard {
    let parsed: unknown
    try {
      parsed = JSON.parse(data)
    } catch (error) {
      throw new ScopeManagerError('Stored scope board is not valid JSON', { cause: error })
    }
    if (!isRecord(parsed)) throw new ScopeManagerError('Stored scope board must be an object')
    if (parsed.version === 1) return migrateVersion1(parsed)
    if (parsed.version === SCOPE_BOARD_VERSION) return normalizeVersion2(parsed)
    throw new ScopeManagerError(`Unsupported scope board version: ${String(parsed.version)}`)
  }

  private needsPersistence(board: ScopeBoard, rawData: string): boolean {
    return JSON.stringify(board) !== rawData
  }

  private assertInvariants(board: ScopeBoard): void {
    const ids = new Set<string>()
    for (const bucket of board.buckets) {
      if (ids.has(bucket.id)) {
        throw new ScopeManagerError(`Duplicate scope bucket ID: ${bucket.id}`)
      }
      ids.add(bucket.id)
    }
    const fallback = board.buckets.find((bucket) => bucket.id === DEFAULT_SCOPE_BUCKET_ID)
    if (!fallback) throw new ScopeManagerError('The Default scope bucket cannot be removed')
    if (isManagedScopeRoot(fallback.root) || fallback.archivedAt !== undefined) {
      throw new ScopeManagerError('The Default scope must remain project-rooted and active')
    }
  }

  private persist(projectId: string, board: ScopeBoard): void {
    this.db.run(
      'INSERT OR REPLACE INTO scope_boards(project_id, data, updated_at) VALUES(?,?,?)',
      projectId,
      JSON.stringify(board),
      Date.now()
    )
  }

  private loadMutable(projectId: string): ScopeBoard {
    return this.getBoard(projectId)
  }

  private requireBucket(board: ScopeBoard, bucketId: string): ScopeBucket {
    const bucket = board.buckets.find((candidate) => candidate.id === bucketId)
    if (!bucket) throw new ScopeManagerError(`Unknown scope bucket: ${bucketId}`)
    return bucket
  }

  /** Reorder buckets without touching appearance or lifecycle metadata. */
  updateLayout(projectId: string, orderedIds: readonly string[]): ScopeBoard {
    const board = this.loadMutable(projectId)
    if (orderedIds.length !== board.buckets.length) {
      throw new ScopeManagerError('Layout update must include every scope exactly once')
    }
    const present = new Set(board.buckets.map((bucket) => bucket.id))
    const seen = new Set<string>()
    for (const id of orderedIds) {
      if (!present.has(id) || seen.has(id)) {
        throw new ScopeManagerError('Layout update contains an unknown or duplicate scope ID')
      }
      seen.add(id)
    }
    const updated: ScopeBoard = {
      ...board,
      buckets: orderedIds.map((id, sortOrder) => {
        const bucket = this.requireBucket(board, id)
        return { ...bucket, sortOrder }
      })
    }
    this.assertInvariants(updated)
    this.persist(projectId, updated)
    return updated
  }

  /** Update display-only metadata. Branch and directory names stay stable. */
  updateAppearance(
    projectId: string,
    bucketId: string,
    patch: UpdateScopeAppearanceInput
  ): ScopeBoard {
    const board = this.loadMutable(projectId)
    this.requireBucket(board, bucketId)
    const updated: ScopeBoard = {
      ...board,
      buckets: board.buckets.map((candidate) => {
        if (candidate.id !== bucketId) return candidate
        const next: ScopeBucket = { ...candidate }
        if (patch.name !== undefined) next.name = patch.name
        if (patch.color === null) delete next.color
        else if (patch.color !== undefined) next.color = patch.color
        if (patch.iconType === null) delete next.iconType
        else if (patch.iconType !== undefined) next.iconType = patch.iconType
        return next
      })
    }
    this.assertInvariants(updated)
    this.persist(projectId, updated)
    return updated
  }

  updateCollapse(
    projectId: string,
    bucketId: string,
    patch: { collapsed?: boolean; collapsedSlices?: ScopeBucket['collapsedSlices'] }
  ): ScopeBoard {
    const board = this.loadMutable(projectId)
    this.requireBucket(board, bucketId)
    const updated: ScopeBoard = {
      ...board,
      buckets: board.buckets.map((candidate) => {
        if (candidate.id !== bucketId) return candidate
        return {
          ...candidate,
          ...(patch.collapsed === undefined ? {} : { collapsed: patch.collapsed }),
          ...(patch.collapsedSlices === undefined
            ? {}
            : { collapsedSlices: [...patch.collapsedSlices] })
        }
      })
    }
    this.persist(projectId, updated)
    return updated
  }

  /** Create a new custom scope rooted at the project directory. */
  createBucket(
    projectId: string,
    input: CreateScopeBucketInput
  ): { board: ScopeBoard; bucket: ScopeBucket } {
    const board = this.loadMutable(projectId)
    const name = input.name.trim()
    if (!name) throw new ScopeManagerError('Scope name must not be empty')
    const bucket: ScopeBucket = {
      ...defaultBucket(this.generateBucketId(), name, board.buckets.length),
      ...(input.color ? { color: input.color } : {}),
      ...(input.iconType ? { iconType: input.iconType } : {})
    }
    const updated: ScopeBoard = { ...board, buckets: [...board.buckets, bucket] }
    this.assertInvariants(updated)
    this.persist(projectId, updated)
    return { board: updated, bucket }
  }

  /**
   * Ensure a bucket with a specific ID exists (used by orchestration flows
   * that derive deterministic scope IDs). Existing buckets are returned
   * unchanged; lifecycle metadata is never overwritten.
   */
  ensureBucket(
    projectId: string,
    input: CreateScopeBucketInput & { id: string }
  ): { board: ScopeBoard; bucket: ScopeBucket } {
    const board = this.loadMutable(projectId)
    const existing = board.buckets.find((candidate) => candidate.id === input.id)
    if (existing) return { board, bucket: existing }
    const name = input.name.trim() || 'Scope'
    const bucket: ScopeBucket = {
      ...defaultBucket(input.id, name, board.buckets.length),
      ...(input.color ? { color: input.color } : {}),
      ...(input.iconType ? { iconType: input.iconType } : {})
    }
    const updated: ScopeBoard = { ...board, buckets: [...board.buckets, bucket] }
    this.assertInvariants(updated)
    this.persist(projectId, updated)
    return { board: updated, bucket }
  }

  private generateBucketId(): string {
    const id = `scope-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return id
  }

  /** Archive or restore a scope. Archival performs no filesystem mutation. */
  setArchive(projectId: string, bucketId: string, archived: boolean): ScopeBoard {
    if (bucketId === DEFAULT_SCOPE_BUCKET_ID) {
      throw new ScopeManagerError('The Default scope cannot be archived')
    }
    const board = this.loadMutable(projectId)
    this.requireBucket(board, bucketId)
    const updated: ScopeBoard = {
      ...board,
      buckets: board.buckets.map((candidate) => {
        if (candidate.id !== bucketId) return candidate
        const next: ScopeBucket = { ...candidate }
        if (archived) next.archivedAt = Date.now()
        else delete next.archivedAt
        return next
      })
    }
    this.persist(projectId, updated)
    return updated
  }

  /** Attach a managed-worktree root to a non-Default scope. */
  attachManagedRoot(
    projectId: string,
    bucketId: string,
    descriptor: ManagedWorktreeDescriptor
  ): ScopeBoard {
    if (bucketId === DEFAULT_SCOPE_BUCKET_ID) {
      throw new ScopeManagerError('The Default scope cannot become a managed worktree')
    }
    const board = this.loadMutable(projectId)
    this.requireBucket(board, bucketId)
    const updated: ScopeBoard = {
      ...board,
      buckets: board.buckets.map((candidate) =>
        candidate.id === bucketId ? { ...candidate, root: descriptor } : candidate
      )
    }
    this.assertInvariants(updated)
    this.persist(projectId, updated)
    return updated
  }

  /** Detach a managed worktree, returning the scope to the project directory. */
  detachManagedRoot(projectId: string, bucketId: string): ScopeBoard {
    if (bucketId === DEFAULT_SCOPE_BUCKET_ID) {
      throw new ScopeManagerError('The Default scope already uses the project directory')
    }
    const board = this.loadMutable(projectId)
    this.requireBucket(board, bucketId)
    const updated: ScopeBoard = {
      ...board,
      buckets: board.buckets.map((candidate) =>
        candidate.id === bucketId ? { ...candidate, root: projectRoot() } : candidate
      )
    }
    this.persist(projectId, updated)
    return updated
  }

  /** Delete a non-Default scope bucket from the board. */
  deleteBucket(projectId: string, bucketId: string): ScopeBoard {
    if (bucketId === DEFAULT_SCOPE_BUCKET_ID) {
      throw new ScopeManagerError('The Default scope cannot be deleted')
    }
    const board = this.loadMutable(projectId)
    this.requireBucket(board, bucketId)
    const updated: ScopeBoard = {
      ...board,
      buckets: board.buckets
        .filter((candidate) => candidate.id !== bucketId)
        .map((candidate, sortOrder) => ({ ...candidate, sortOrder }))
    }
    this.persist(projectId, updated)
    return updated
  }

  /** Persist project-level managed-worktree defaults. */
  setWorktreeDefaults(projectId: string, defaults: ScopeWorktreeDefaults): ScopeBoard {
    const board = this.loadMutable(projectId)
    const updated: ScopeBoard = {
      ...board,
      worktreeDefaults: {
        setupCommands: defaults.setupCommands.map((command) => ({
          executable: command.executable,
          args: [...command.args]
        })),
        runSetupByDefault: defaults.runSetupByDefault,
        environmentMode: defaults.environmentMode
      }
    }
    this.persist(projectId, updated)
    return updated
  }
}
