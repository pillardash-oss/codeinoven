import type { AuthoredWorkKind } from '../ipc/design'

/**
 * Where authored work goes, and which session a folder belongs to.
 *
 * A design session writes into one folder and a video session writes into
 * another, and until now both were constants. A user who wants their designs in
 * version control needs to point them somewhere Git tracks, so the roots are a
 * setting and this module is the only place that decides what a root may be, how
 * the setting is read, and which session a folder belongs to.
 *
 * The classifier is here rather than inside the service that happened to need it
 * first, because more than one caller asks the same question: the design service
 * when it decides which session a folder belongs to, the browser when it decides
 * whether a tab is rendering a design, and the database when it classifies
 * historical rows. A second copy is how a folder ends up being a design to the
 * board and not to the tab.
 *
 * Deliberately free of `node:` imports: the renderer reads the roots to label
 * the board, and this module is on that path.
 */

/** The project-relative folder each session writes into, as the user set it. */
export interface WorkRoots {
  /** A design session's folder, e.g. `.cio/designs` or `designs`. */
  design: string
  /** A video session's folder, e.g. `.cio/videos` or `videos`. */
  video: string
}

/**
 * The roots a fresh install uses, and the ones Reset returns to.
 *
 * `.cio/` is the app's scratch tree and is ignored by Git, so work written here
 * is explorable rather than a change to the product. Promoting it, by pointing a
 * root into the source tree and committing what lands there, stays a deliberate
 * act.
 */
export const DEFAULT_WORK_ROOTS: WorkRoots = {
  design: '.cio/designs',
  video: '.cio/videos'
}

/** Ceiling on one root, so a hand-written config value cannot inflate a log line. */
export const MAX_WORK_ROOT_LENGTH = 200

/**
 * Every kind, in the order a folder is tested against its roots.
 *
 * Order matters only for a path a user could make sit under both roots, which
 * {@link workRootsConflict} refuses to store; the array exists so the classifier
 * and any caller iterating kinds read them from one place.
 */
export const AUTHORED_WORK_KINDS: readonly AuthoredWorkKind[] = ['design', 'video']

/** The kind's own folder, from the pair. */
export function workRootForKind(roots: WorkRoots, kind: AuthoredWorkKind): string {
  return kind === 'video' ? roots.video : roots.design
}

/**
 * One sentence about what a folder means for version control, for the playbooks.
 *
 * Where the work lands decides whether it is committed, and the answer is the
 * user's setting rather than a fact about the app. A playbook that stated the
 * default as if it were the rule would tell an agent its designs were scratch
 * while the user had already pointed them into the source tree.
 */
export function workRootGuidance(root: string): string {
  return root.startsWith('.cio/')
    ? `\`${root}\` sits under \`.cio\`, which Git ignores, so this work stays scratch until the user asks for it in the source tree.`
    : `\`${root}\` is inside the project's own tree, so it is version-controlled like the rest of the source.`
}

/** Both folders, keyed by kind, for callers that switch on the kind. */
export function workRootsByKind(roots: WorkRoots): Record<AuthoredWorkKind, string> {
  return { design: roots.design, video: roots.video }
}

/** Whether a folder is the default for its kind, which is what Reset returns to. */
export function isDefaultWorkRoot(kind: AuthoredWorkKind, root: string): boolean {
  return workRootForKind(DEFAULT_WORK_ROOTS, kind) === root
}

/** A root may not be this folder, whatever its spelling: work written into Git's
 *  own directory is not version control, it is damage. */
const FORBIDDEN_ROOT_SEGMENT = '.git'

/**
 * One root as the app will store it, or null when it cannot be one.
 *
 * A root is a folder inside the project, so it is project-relative by
 * definition: an absolute path, a home-relative path and a Windows drive are all
 * refused rather than silently reinterpreted. `\` is read as a separator so a
 * path typed on Windows works, `.` segments and repeated separators are dropped
 * so two spellings of one folder cannot look like two settings, and `..` is
 * refused outright because escaping the project is the one thing a root must
 * never do.
 *
 * A refusal is the caller's to report: this answers the question, it does not
 * throw, so the settings boundary can say which field was wrong and the config
 * reader can fall back to the default without a try/catch.
 */
export function normalizeWorkRoot(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const collapsed = value.trim().replace(/[\\]+/gu, '/')
  if (collapsed.length === 0 || collapsed.length > MAX_WORK_ROOT_LENGTH) return null
  if (collapsed.startsWith('/') || collapsed.startsWith('~') || /^[a-zA-Z]:/u.test(collapsed)) {
    return null
  }
  const segments = collapsed.split('/').filter((segment) => segment.length > 0 && segment !== '.')
  if (segments.length === 0) return null
  if (segments.some((segment) => segment === '..')) return null
  const [first] = segments
  if (first === undefined || first.toLowerCase() === FORBIDDEN_ROOT_SEGMENT) return null
  return segments.join('/')
}

/**
 * Whether the pair is unusable, because one root is the other or sits under it.
 *
 * A nested pair is not two settings but one with a shadow: a folder under both
 * roots would classify as whichever kind is tested first, so a design would be
 * listed as a composition or the reverse, depending on an order nobody chose.
 * The settings boundary refuses such a pair instead of storing an ambiguity.
 */
export function workRootsConflict(roots: WorkRoots): boolean {
  for (const kind of AUTHORED_WORK_KINDS) {
    const own = workRootForKind(roots, kind)
    for (const other of AUTHORED_WORK_KINDS) {
      if (other === kind) continue
      const sibling = workRootForKind(roots, other)
      if (own === sibling || sibling.startsWith(`${own}/`)) return true
    }
  }
  return false
}

/** The stored shape this module reads. Kept structural so config types need no import. */
export interface WorkRootsConfig {
  workRoots?: Partial<WorkRoots> | null
}

/**
 * The config's roots, with anything unusable replaced by its default.
 *
 * Reading is tolerant on purpose. A config file a future version wrote, a
 * hand-edited value, or a pair that nests arrives as a working app rather than as
 * a failed startup, and the two defaults are always a valid pair.
 */
export function workRootsFromConfig(config: WorkRootsConfig): WorkRoots {
  const design = normalizeWorkRoot(config.workRoots?.design) ?? DEFAULT_WORK_ROOTS.design
  const video = normalizeWorkRoot(config.workRoots?.video) ?? DEFAULT_WORK_ROOTS.video
  const roots: WorkRoots = { design, video }
  return workRootsConflict(roots) ? { ...DEFAULT_WORK_ROOTS } : roots
}

/**
 * Which session a project-relative folder belongs to, read from its root.
 *
 * A path under neither root claims no kind rather than defaulting to a design,
 * because the caller's fallback is its own evidence: the design service falls back
 * to the session tags, and the browser falls back to showing the tab as an
 * ordinary page. Answering "design" here would let an arbitrary previewed folder
 * arm the element inspector.
 */
export function authoredWorkKindOf(directory: string, roots: WorkRoots): AuthoredWorkKind | null {
  for (const kind of AUTHORED_WORK_KINDS) {
    const root = workRootForKind(roots, kind)
    if (directory === root || directory.startsWith(`${root}/`)) return kind
  }
  return null
}
