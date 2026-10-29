import { randomUUID } from 'node:crypto'
import type { StorageEngine } from '../storage/storage-engine'
import type {
  ScreenBoardOrder,
  ScreenBoardPlacement,
  ScreenBoardState,
  ScreenGroup
} from '../../lib/ipc/design'
import { Logger } from '../system/logger'

/**
 * How the screens of one design are organised, remembered per design folder.
 *
 * A design is a folder of screens, and a folder of thirty screens stops being
 * something a person scans: the screens that belong together are the flow the user
 * is working on, and the rest are other attempts. A group is a record about screens,
 * never a place on disk: nothing here moves or renames a file, so grouping is safe
 * to do freely and deleting a group returns its screens to the plain list.
 *
 * The order is the user's own as well. `custom` means "the arrangement I dragged",
 * and a screen the agent wrote after that arrangement still appears first: a custom
 * order only says where the screens the user has placed go, never that a new one is
 * hidden at the bottom. That is why an unplaced screen is drawn before the placed
 * ones rather than appended.
 *
 * It is one JSON file under the config root rather than a table, because it is a
 * view of a folder the user owns: a board that cannot be read is an empty board, and
 * losing that file must never lose a screen.
 */

const STORE_FILE = 'design-screen-boards.json'
const MAX_GROUPS = 200
const MAX_NAME_LENGTH = 80
const MAX_ENTRY_LENGTH = 512
const MAX_PLACEMENTS_PER_BOARD = 4000

export type ScreenBoardStore = {
  version: 1
  /** The app-wide reading of a design's screens, shared by every board. */
  view: 'cards' | 'list'
  boards: Record<string, ScreenBoardRecord>
}

export interface ScreenBoardRecord {
  groups: ScreenGroup[]
  placements: ScreenBoardPlacement[]
  order: ScreenBoardOrder
  updatedAt: number
}

export interface ScreenBoardDeps {
  storage: Pick<StorageEngine, 'read' | 'write'>
  /** Announce a board that changed, so every window reading it agrees. */
  onChanged: (projectId: string, directory: string, updatedAt: number) => void
}

function boardKey(projectId: string, directory: string): string {
  return `${projectId}\u0000${directory}`
}

function requireId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(value))
    throw new TypeError(`Invalid ${label}`)
  return value
}

/**
 * A design folder as the board addresses it: project-relative, forward slashes,
 * no traversal and no absolute path.
 */
function requireDirectory(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024)
    throw new TypeError('Invalid design directory')
  const normalized = value.replace(/\\/gu, '/').replace(/\/+/gu, '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..'))
    throw new TypeError('Invalid design directory')
  return normalized.replace(/\/$/u, '')
}

function requireEntry(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_ENTRY_LENGTH)
    throw new TypeError('Invalid screen entry')
  const normalized = value.replace(/\\/gu, '/')
  if (normalized.startsWith('/') || normalized.split('/').includes('..'))
    throw new TypeError('Invalid screen entry')
  return normalized
}

function requireGroupName(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('A group needs a name')
  const name = value.trim()
  if (name.length === 0 || name.length > MAX_NAME_LENGTH)
    throw new TypeError(`A group name must be 1 to ${MAX_NAME_LENGTH} characters`)
  return name
}

function requireOrder(value: unknown): ScreenBoardOrder {
  const orders: ScreenBoardOrder[] = ['latest', 'name', 'name-desc', 'oldest', 'custom']
  const found = orders.find((order) => order === value)
  if (!found) throw new TypeError('Unknown screen order')
  return found
}

function requireView(value: unknown): 'cards' | 'list' {
  if (value !== 'cards' && value !== 'list') throw new TypeError('Unknown screens view')
  return value
}

/** A stored board, read as untrusted: one bad record must not poison the file. */
function recordOf(value: unknown): ScreenBoardRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const groups: ScreenGroup[] = []
  const rawGroups = Array.isArray(record['groups']) ? record['groups'] : []
  for (const raw of rawGroups.slice(0, MAX_GROUPS)) {
    if (!raw || typeof raw !== 'object') continue
    const group = raw as Record<string, unknown>
    if (typeof group['id'] !== 'string' || typeof group['name'] !== 'string') continue
    groups.push({
      id: group['id'],
      name: group['name'],
      position: Number.isFinite(group['position']) ? Number(group['position']) : groups.length,
      collapsed: group['collapsed'] === true
    })
  }
  // A placement whose group is gone is dropped rather than kept as a dangling
  // reference: its screen is simply ungrouped again.
  const groupIds = new Set(groups.map((group) => group.id))
  const placements: ScreenBoardPlacement[] = []
  const rawPlacements = Array.isArray(record['placements']) ? record['placements'] : []
  for (const raw of rawPlacements.slice(0, MAX_PLACEMENTS_PER_BOARD)) {
    if (!raw || typeof raw !== 'object') continue
    const placement = raw as Record<string, unknown>
    if (typeof placement['entry'] !== 'string') continue
    const groupId = typeof placement['groupId'] === 'string' ? placement['groupId'] : null
    const position = Number.isFinite(placement['position'])
      ? Number(placement['position'])
      : placements.length
    placements.push({
      entry: placement['entry'],
      groupId: groupId !== null && groupIds.has(groupId) ? groupId : null,
      position
    })
  }
  const order = ['latest', 'name', 'name-desc', 'oldest', 'custom'].find(
    (candidate) => candidate === record['order']
  ) as ScreenBoardOrder | undefined
  return {
    groups: groups.toSorted((left, right) => left.position - right.position),
    placements,
    order: order ?? 'latest',
    updatedAt: Number.isFinite(record['updatedAt']) ? Number(record['updatedAt']) : 0
  }
}

export class ScreenBoardService {
  private store: ScreenBoardStore | null = null
  /** One write at a time, so two gestures cannot land out of order. */
  private writeChain: Promise<void> = Promise.resolve()

  constructor(private readonly deps: ScreenBoardDeps) {}

  /** Every board's reading of its screens, plus the app-wide view. */
  private async ensureLoaded(): Promise<ScreenBoardStore> {
    if (this.store) return this.store
    let stored: unknown = null
    try {
      stored = await this.deps.storage.read<unknown>(STORE_FILE)
    } catch (error) {
      Logger.error('Screen boards could not be read; starting empty:', error)
    }
    const parsed = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {}
    const boards: Record<string, ScreenBoardRecord> = {}
    const rawBoards = parsed['boards']
    if (rawBoards && typeof rawBoards === 'object' && !Array.isArray(rawBoards)) {
      for (const [key, value] of Object.entries(rawBoards as Record<string, unknown>)) {
        const record = recordOf(value)
        if (record) boards[key] = record
      }
    }
    this.store = {
      version: 1,
      view: parsed['view'] === 'list' ? 'list' : 'cards',
      boards
    }
    return this.store
  }

  async state(projectId: unknown, directory: unknown): Promise<ScreenBoardState> {
    const project = requireId(projectId, 'project id')
    const folder = requireDirectory(directory)
    const store = await this.ensureLoaded()
    return this.answer(project, folder, store.boards[boardKey(project, folder)] ?? null, store)
  }

  /** The app-wide cards/list reading, which every design board shares. */
  async view(): Promise<'cards' | 'list'> {
    return (await this.ensureLoaded()).view
  }

  async setView(value: unknown): Promise<'cards' | 'list'> {
    const view = requireView(value)
    const store = await this.ensureLoaded()
    if (store.view === view) return view
    store.view = view
    this.persist(store)
    return view
  }

  async setOrder(
    projectId: unknown,
    directory: unknown,
    order: unknown
  ): Promise<ScreenBoardState> {
    const project = requireId(projectId, 'project id')
    const folder = requireDirectory(directory)
    const next = requireOrder(order)
    const store = await this.ensureLoaded()
    const record = this.recordFor(store, project, folder)
    record.order = next
    record.updatedAt = Date.now()
    return this.commit(store, project, folder, record)
  }

  async createGroup(
    projectId: unknown,
    directory: unknown,
    name: unknown
  ): Promise<ScreenBoardState> {
    const project = requireId(projectId, 'project id')
    const folder = requireDirectory(directory)
    const store = await this.ensureLoaded()
    const record = this.recordFor(store, project, folder)
    if (record.groups.length >= MAX_GROUPS)
      throw new Error('This design already holds too many groups')
    const named = requireGroupName(name)
    record.groups.push({
      id: randomUUID(),
      name: named,
      position: record.groups.length,
      collapsed: false
    })
    record.updatedAt = Date.now()
    return this.commit(store, project, folder, record)
  }

  async renameGroup(
    projectId: unknown,
    directory: unknown,
    groupId: unknown,
    name: unknown
  ): Promise<ScreenBoardState> {
    const project = requireId(projectId, 'project id')
    const folder = requireDirectory(directory)
    const id = requireId(groupId, 'group id')
    const store = await this.ensureLoaded()
    const record = this.recordFor(store, project, folder)
    const group = record.groups.find((candidate) => candidate.id === id)
    if (!group) throw new Error('That group is gone')
    group.name = requireGroupName(name)
    record.updatedAt = Date.now()
    return this.commit(store, project, folder, record)
  }

  /** Delete a group; its screens stay, ungrouped. */
  async removeGroup(
    projectId: unknown,
    directory: unknown,
    groupId: unknown
  ): Promise<ScreenBoardState> {
    const project = requireId(projectId, 'project id')
    const folder = requireDirectory(directory)
    const id = requireId(groupId, 'group id')
    const store = await this.ensureLoaded()
    const record = this.recordFor(store, project, folder)
    record.groups = record.groups.filter((group) => group.id !== id)
    record.groups.forEach((group, index) => (group.position = index))
    record.placements = record.placements.map((placement) =>
      placement.groupId === id ? { ...placement, groupId: null } : placement
    )
    record.updatedAt = Date.now()
    return this.commit(store, project, folder, record)
  }

  async setCollapsed(
    projectId: unknown,
    directory: unknown,
    groupId: unknown,
    collapsed: unknown
  ): Promise<ScreenBoardState> {
    const project = requireId(projectId, 'project id')
    const folder = requireDirectory(directory)
    const id = requireId(groupId, 'group id')
    const store = await this.ensureLoaded()
    const record = this.recordFor(store, project, folder)
    const group = record.groups.find((candidate) => candidate.id === id)
    if (!group) throw new Error('That group is gone')
    group.collapsed = collapsed === true
    record.updatedAt = Date.now()
    return this.commit(store, project, folder, record)
  }

  /**
   * Set one group's screens, in the order given.
   *
   * The caller sends the group as the user arranged it, which is what makes a drop
   * and a reorder the same gesture: the listed screens join this group in this
   * order, screens the list leaves out stay where they are, and a screen that came
   * from another group leaves its old place. Because a hand-made order is what the
   * user is expressing, the board's order becomes `custom`.
   */
  async place(
    projectId: unknown,
    directory: unknown,
    groupId: unknown,
    entries: unknown
  ): Promise<ScreenBoardState> {
    const project = requireId(projectId, 'project id')
    const folder = requireDirectory(directory)
    if (!Array.isArray(entries) || entries.length > MAX_PLACEMENTS_PER_BOARD)
      throw new TypeError('A move needs a list of screens')
    const store = await this.ensureLoaded()
    const record = this.recordFor(store, project, folder)
    const destination = typeof groupId === 'string' ? requireId(groupId, 'group id') : null
    if (destination !== null && !record.groups.some((group) => group.id === destination))
      throw new Error('That group is gone')
    const ordered = entries.map((entry) => requireEntry(entry))
    const listed = new Set(ordered)
    const outside = record.placements.filter(
      (placement) => (placement.groupId ?? null) !== destination || !listed.has(placement.entry)
    )
    // Members of the destination the caller did not list keep their order behind
    // the listed ones: a partial list never silently drops a screen.
    const retained = record.placements
      .filter(
        (placement) => (placement.groupId ?? null) === destination && !listed.has(placement.entry)
      )
      .toSorted((left, right) => left.position - right.position)
    const placed: ScreenBoardPlacement[] = ordered.map((entry, index) => ({
      entry,
      groupId: destination,
      position: index
    }))
    record.placements = [
      ...outside.map((placement) => ({ ...placement })),
      ...placed,
      ...retained.map((placement, index) => ({
        ...placement,
        position: placed.length + index
      }))
    ]
    record.order = 'custom'
    record.updatedAt = Date.now()
    return this.commit(store, project, folder, record)
  }

  private recordFor(
    store: ScreenBoardStore,
    projectId: string,
    directory: string
  ): ScreenBoardRecord {
    const key = boardKey(projectId, directory)
    const existing = store.boards[key]
    if (existing) return existing
    const created: ScreenBoardRecord = { groups: [], placements: [], order: 'latest', updatedAt: 0 }
    store.boards[key] = created
    return created
  }

  private commit(
    store: ScreenBoardStore,
    projectId: string,
    directory: string,
    record: ScreenBoardRecord
  ): ScreenBoardState {
    this.persist(store)
    try {
      this.deps.onChanged(projectId, directory, record.updatedAt)
    } catch (error) {
      Logger.dev('Screen board change could not be announced', error)
    }
    return this.answer(projectId, directory, record, store)
  }

  private answer(
    projectId: string,
    directory: string,
    record: ScreenBoardRecord | null,
    store: ScreenBoardStore
  ): ScreenBoardState {
    return {
      projectId,
      directory,
      groups: record ? record.groups.map((group) => ({ ...group })) : [],
      placements: record ? record.placements.map((placement) => ({ ...placement })) : [],
      order: record?.order ?? 'latest',
      view: store.view,
      updatedAt: record?.updatedAt ?? 0
    }
  }

  /** Write the whole file, one write at a time, and keep the in-memory copy. */
  private persist(store: ScreenBoardStore): void {
    this.writeChain = this.writeChain
      .then(() => this.deps.storage.write(STORE_FILE, store))
      .catch((error: unknown) => {
        Logger.error('Screen boards could not be written:', error)
      })
  }
}
