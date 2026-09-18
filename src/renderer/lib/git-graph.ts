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

/**
 * Row index -> the upstream update whose batch of commits starts on that row.
 *
 * An update is stamped on the ref, so its commit is the newest one in that
 * batch, which is exactly the row the batch's boundary sits above. An update
 * whose commit is not among the rows (older than the pages loaded so far, or no
 * longer in this branch's history after a rewrite) is skipped rather than
 * guessed at, because a boundary anchored to no row would be drawn in the wrong
 * place. When two entries name the same commit, the newest wins: that is the
 * entry that actually moved the ref last.
 *
 * `unpushedCount` is the panel's drift with the upstream, and it bounds the
 * answer: a commit above that boundary is not on the remote now, so an entry
 * naming it describes a position the remote has since been rewritten away from.
 * Skipping those keeps a `Pushed` line from sitting on top of the amber run that
 * says the opposite.
 */
export function graphBatchStarts(
  rows: readonly GitGraphRow[],
  updates: readonly GitRemoteUpdate[],
  unpushedCount: number
): Map<number, GitRemoteUpdate> {
  const indexByHash = new Map<string, number>()
  for (const [index, row] of rows.entries()) indexByHash.set(row.commit.hash, index)
  const starts = new Map<number, GitRemoteUpdate>()
  for (const update of updates) {
    const index = indexByHash.get(update.sha)
    if (index === undefined || index < unpushedCount || starts.has(index)) continue
    starts.set(index, update)
  }
  return starts
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
