/**
 * Fit a page snapshot into what the model is actually shown.
 *
 * The gateway cuts any text answer past its character limit, and it cuts from the
 * end, so a portal whose blades live in frames lost exactly the form the agent was
 * asked to fill. Fitting here decides what survives instead: first the repetition
 * a ref already carries, then page prose, then the elements nobody can see, and
 * only last the visible controls, each step reported so the agent knows to narrow.
 */

/** Room for the snapshot inside the gateway limit, leaving space for its envelope. */
export const SNAPSHOT_CHARACTER_BUDGET = 10_500

type SnapshotRecord = Record<string, unknown>

export interface SnapshotOmissions {
  /** Characters of page and frame text left out. */
  text?: number
  /** Elements left out, hidden ones first. */
  elements?: number
  /** Element fields dropped because a ref already names the element. */
  fields?: string[]
}

const size = (value: unknown): number => JSON.stringify(value).length

const asRecord = (value: unknown): SnapshotRecord | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SnapshotRecord)
    : null

/** Drop empty fields, and the fields a ref makes redundant when asked to. */
function compactElement(element: unknown, dropped: ReadonlySet<string>): unknown {
  const record = asRecord(element)
  if (!record) return element
  const compact: SnapshotRecord = {}
  for (const [key, value] of Object.entries(record)) {
    if (dropped.has(key)) continue
    if (value === '' || value === undefined) continue
    if (key === 'visible' && value === true) continue
    compact[key] = value
  }
  return compact
}

function textOf(record: SnapshotRecord): string {
  return typeof record['text'] === 'string' ? record['text'] : ''
}

/** Share `room` characters of text between the page and its frames, frames first. */
function shrinkText(snapshot: SnapshotRecord, frames: SnapshotRecord[], room: number): number {
  const holders = [...frames.filter((frame) => textOf(frame).length > 0), snapshot]
  const total = holders.reduce((sum, holder) => sum + textOf(holder).length, 0)
  if (total <= room) return 0
  let omitted = 0
  for (const holder of holders) {
    const text = textOf(holder)
    if (!text) continue
    const keep = Math.max(0, Math.floor((text.length / total) * room))
    if (keep >= text.length) continue
    omitted += text.length - keep
    if (keep === 0) delete holder['text']
    else holder['text'] = text.slice(0, keep)
  }
  return omitted
}

/**
 * Return a snapshot whose JSON fits `budget` characters, with what was left out.
 * The input is not modified.
 */
export function fitSnapshot(
  input: SnapshotRecord,
  budget: number = SNAPSHOT_CHARACTER_BUDGET
): { snapshot: SnapshotRecord; omitted: SnapshotOmissions | null } {
  if (size(input) <= budget) return { snapshot: input, omitted: null }
  const omitted: SnapshotOmissions = {}
  const frames = (Array.isArray(input['frames']) ? input['frames'] : []).map((frame) => ({
    ...(asRecord(frame) ?? {})
  }))
  const original = Array.isArray(input['elements']) ? input['elements'] : []
  const snapshot: SnapshotRecord = { ...input, frames }

  // A ref is what every action takes, so the selector and box repeat it.
  const dropped = new Set(['selector', 'box'])
  let elements = original.map((element) => compactElement(element, dropped))
  omitted.fields = [...dropped]
  snapshot['elements'] = elements

  const overflow = size(snapshot) - budget
  if (overflow > 0) {
    const text = [snapshot, ...frames].reduce((sum, holder) => sum + textOf(holder).length, 0)
    const removed = shrinkText(snapshot, frames, Math.max(0, text - overflow - 64))
    if (removed > 0) omitted.text = removed
  }

  if (size(snapshot) > budget) {
    // Hidden elements go before visible ones; within each group, the end goes first.
    const order = elements
      .map((element, index) => ({ index, hidden: asRecord(element)?.['visible'] === false }))
      .sort((a, b) => Number(b.hidden) - Number(a.hidden) || b.index - a.index)
    const removed = new Set<number>()
    let current = size(snapshot)
    for (const { index } of order) {
      if (current <= budget) break
      current -= size(elements[index]) + 1
      removed.add(index)
    }
    elements = elements.filter((_, index) => !removed.has(index))
    snapshot['elements'] = elements
    snapshot['count'] = elements.length
    omitted.elements = removed.size
  }
  return { snapshot, omitted }
}
