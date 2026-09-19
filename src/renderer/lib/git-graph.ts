import type { GitCommitInfo, GitRemoteUpdate } from '$shared/types'

/** Horizontal pitch of one graph lane, in px. */
export const GRAPH_LANE_WIDTH = 12
/** Vertical pitch of one graph row, in px. Kept in sync with the row's CSS height. */
export const GRAPH_ROW_HEIGHT = 30
/** Lanes the column draws before it stops growing. Beyond this the graph clips. */
export const GRAPH_MAX_LANES = 8
/** Corner radius of an elbow where an edge changes lane. */
export const GRAPH_ELBOW_RADIUS = 4

/**
 * Lane colours cycle through the theme's semantic tokens so the graph re-colours
 * correctly in light and dark mode without a second palette.
 */
export const GRAPH_LANE_COLORS = [
  'var(--color-primary)',
  'var(--color-info)',
  'var(--color-success)',
  'var(--color-warning)',
  'var(--color-accent)',
  'var(--color-danger)'
] as const

/** One rendered row of the commit graph. */
export interface GitGraphRow {
  commit: GitCommitInfo
  /** Lane the commit's node sits in. */
  lane: number
  /** Lanes that merge into this commit from the row above. */
  mergingLanes: number[]
  /** Lanes that pass straight through this row untouched. */
  passingLanes: number[]
  /** Lanes this commit's parents occupy in the row below. */
  parentLanes: number[]
  /** Lanes in use at this row, used to size the column. */
  laneCount: number
}

/** Centre of a lane, in px. */
export function graphLaneX(lane: number): number {
  return lane * GRAPH_LANE_WIDTH + GRAPH_LANE_WIDTH / 2
}

/** Colour for a lane, cycling the palette. */
export function graphLaneColor(lane: number): string {
  return GRAPH_LANE_COLORS[lane % GRAPH_LANE_COLORS.length] ?? GRAPH_LANE_COLORS[0]
}

function firstFreeLane(active: ReadonlyArray<string | null>): number {
  const index = active.indexOf(null)
  return index === -1 ? active.length : index
}

/**
 * Assigns a lane to every commit in `commits`, newest first, the same way
 * `git log --graph` walks history: a commit takes the lane already tracking it,
 * lanes that were waiting for it terminate into it (that is a merge), and its
 * parents claim lanes for the rows below.
 *
 * The walk is a single forward pass, so appending an older page never disturbs
 * the rows already assigned.
 */
export function assignGraphLanes(commits: readonly GitCommitInfo[]): GitGraphRow[] {
  // Lane index -> the commit hash that lane is currently waiting for.
  const active: Array<string | null> = []
  const rows: GitGraphRow[] = []

  for (const commit of commits) {
    const mergingLanes: number[] = []
    let lane = -1
    for (let index = 0; index < active.length; index += 1) {
      if (active[index] !== commit.hash) continue
      // The leftmost lane waiting for this commit becomes its lane; any other
      // lane waiting for it is a branch that ends here.
      if (lane === -1) lane = index
      else mergingLanes.push(index)
    }
    if (lane === -1) {
      // A tip the walk had not seen yet (e.g. a branch outside the loaded page).
      lane = firstFreeLane(active)
    }

    for (const index of mergingLanes) active[index] = null

    const passingLanes: number[] = []
    for (let index = 0; index < active.length; index += 1) {
      if (index !== lane && active[index] !== null) passingLanes.push(index)
    }

    // The commit now stands in for its first parent; extra parents are a merge
    // and claim their own lane unless another lane already tracks them.
    const [firstParent, ...extraParents] = commit.parents
    active[lane] = firstParent ?? null
    const parentLanes: number[] = []
    if (firstParent) parentLanes.push(lane)
    for (const parent of extraParents) {
      let parentLane = active.indexOf(parent)
      if (parentLane === -1) {
        parentLane = firstFreeLane(active)
        active[parentLane] = parent
      }
      if (!parentLanes.includes(parentLane)) parentLanes.push(parentLane)
    }

    // Drop trailing empty lanes so the column never grows without cause.
    while (active.length > 0 && active[active.length - 1] === null) active.pop()

    rows.push({
      commit,
      lane,
      mergingLanes,
      passingLanes,
      parentLanes,
      laneCount: Math.max(
        active.length,
        lane + 1,
        ...mergingLanes.map((index) => index + 1),
        ...passingLanes.map((index) => index + 1)
      )
    })
  }

  return rows
}

/** Where every recorded movement of the upstream ref lands on the graph. */
export interface GitGraphRemotePlacement {
  /**
   * Row index -> the movement whose batch of commits starts on that row, i.e.
   * the rows from it down to the next boundary. An update is stamped on the ref,
   * so its commit is the newest one in that batch, which is exactly the row the
   * boundary sits above.
   *
   * Only movements the ref still holds appear here. They are the live
   * `Pushed to` / `Received from` lines.
   */
  boundaries: Map<number, GitRemoteUpdate>
  /**
   * Row index -> the movement that had this commit on the ref, for commits the
   * ref has since moved off.
   *
   * A commit is marked when a recorded movement reached it and the upstream no
   * longer contains it: it was genuinely on the remote, and a rewrite (a
   * force-push, or a reset we then fetched) took it away. It is drawn as a mark
   * on the row, never as a boundary line, because a line at that position would
   * claim the rows below it had just been pushed, which is now the opposite of
   * the truth.
   */
  rewritten: Map<number, GitRemoteUpdate>
}

/**
 * Places the recorded ref movements on the rows they belong to.
 *
 * `unpushedCount` is the panel's drift with the upstream, and it splits the
 * answer in two: a movement at or below that boundary still stands, so it draws
 * a boundary line, while a movement above it names a commit the upstream no
 * longer holds. That second case is not dropped: the commits the movement
 * carried that this branch still has and the upstream no longer does were
 * published and then rewritten away, and they are reported as `rewritten` so the
 * graph can say so.
 *
 * A movement whose commit is not among the rows (older than the loaded pages) is
 * skipped rather than guessed at, because it has no row to anchor to. When two
 * entries name the same commit, the newest wins: that is the entry that moved
 * the ref last.
 */
export function graphRemotePlacement(
  rows: readonly GitGraphRow[],
  updates: readonly GitRemoteUpdate[],
  unpushedCount: number
): GitGraphRemotePlacement {
  const indexByHash = new Map<string, number>()
  for (const [index, row] of rows.entries()) indexByHash.set(row.commit.hash, index)

  const boundaries = new Map<number, GitRemoteUpdate>()
  const rewritten = new Map<number, GitRemoteUpdate>()

  // Newest first, so the first update to claim a row is the movement that put
  // the ref there last, and a newer rewrite outranks an older one.
  for (const update of updates) {
    const index = indexByHash.get(update.sha)
    if (index === undefined) continue
    if (index >= unpushedCount) {
      if (!boundaries.has(index)) boundaries.set(index, update)
      continue
    }
    // The ref has moved off this commit. Everything the movement carried that
    // this branch still has, and the upstream no longer does, is unpublished now
    // but went up once.
    for (const reached of reachableRowIndexes(index, rows, indexByHash)) {
      if (reached < unpushedCount && !rewritten.has(reached)) rewritten.set(reached, update)
    }
  }

  return { boundaries, rewritten }
}

/**
 * Row indexes reachable from `start` by walking first and merge parents, so a
 * movement marks the whole batch it carried and not just its newest commit.
 */
function reachableRowIndexes(
  start: number,
  rows: readonly GitGraphRow[],
  indexByHash: ReadonlyMap<string, number>
): number[] {
  const reached: number[] = []
  const seen = new Set<number>([start])
  const queue: number[] = [start]
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const index = queue[cursor]
    reached.push(index)
    for (const parent of rows[index].commit.parents) {
      const parentIndex = indexByHash.get(parent)
      if (parentIndex === undefined || seen.has(parentIndex)) continue
      seen.add(parentIndex)
      queue.push(parentIndex)
    }
  }
  return reached
}

/** One SVG path segment of a graph row. */
export interface GitGraphEdge {
  /** `d` attribute, inside a box one row tall and `laneCount` lanes wide. */
  path: string
  /** Stroke colour, matching the lane the segment belongs to. */
  color: string
}

/**
 * Draws the segments of a single row: lanes that pass straight through,
 * branches that elbow in from the row above to merge, and this commit's parents
 * heading into the row below. Geometry only   no DOM, so it stays inspectable.
 */
export function graphRowEdges(row: GitGraphRow): GitGraphEdge[] {
  const edges: GitGraphEdge[] = []
  const middle = GRAPH_ROW_HEIGHT / 2
  const radius = GRAPH_ELBOW_RADIUS
  const nodeX = graphLaneX(row.lane)

  for (const lane of row.passingLanes) {
    const x = graphLaneX(lane)
    edges.push({ path: `M${x} 0V${GRAPH_ROW_HEIGHT}`, color: graphLaneColor(lane) })
  }

  for (const lane of row.mergingLanes) {
    const x = graphLaneX(lane)
    const direction = nodeX > x ? 1 : -1
    edges.push({
      path: `M${x} 0V${middle - radius}Q${x} ${middle} ${x + direction * radius} ${middle}H${nodeX}`,
      color: graphLaneColor(lane)
    })
  }

  for (const lane of row.parentLanes) {
    const x = graphLaneX(lane)
    if (x === nodeX) {
      edges.push({ path: `M${nodeX} ${middle}V${GRAPH_ROW_HEIGHT}`, color: graphLaneColor(lane) })
      continue
    }
    const direction = x > nodeX ? 1 : -1
    edges.push({
      path: `M${nodeX} ${middle}H${x - direction * radius}Q${x} ${middle} ${x} ${middle + radius}V${GRAPH_ROW_HEIGHT}`,
      color: graphLaneColor(lane)
    })
  }

  return edges
}
