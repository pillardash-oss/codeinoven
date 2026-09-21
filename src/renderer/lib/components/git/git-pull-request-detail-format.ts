import { Check, CircleDot, CircleSlash, X } from '@lucide/svelte'
import type {
  PrCommentKind,
  PrCommentSide,
  PullRequestBundle,
  PullRequestCheck,
  PullRequestFile,
  PullRequestReview,
  PullRequestReviewComment,
  PullRequestReviewThread
} from '$shared/types'
import { githubDisplayLogin } from '$lib/format/github-login'

export type ConversationEntryKind = 'description' | 'comment' | 'review' | 'inline'

/**
 * One row of the conversation, with everything its actions need already
 * resolved from whichever provider shape it came from.
 */
export interface ConversationEntry {
  key: string
  author: string
  /** The author's picture as the provider declared it, preferred over the login. */
  avatarUrl: string | null
  /** True for app accounts, which GitHub labels with a `Bot` badge. */
  isBot: boolean
  at: string
  /** Last edit time, or null when the entry has never been edited. */
  updatedAt: string | null
  body: string
  kind: ConversationEntryKind
  meta?: string
  /**
   * The login this comment answers, for one inside an inline thread. Null for a
   * comment that opened its thread and for every entry outside one, which is what
   * lets a row say whose answer it is rather than leaving the indent to imply it.
   */
  repliesTo: string | null
  /**
   * The unified diff hunk GitHub showed when an inline comment was written, or
   * null for every other entry. It is the code the comment is talking about, and
   * unlike the live file it still shows that code after the line has gone
   * outdated, which is exactly when a reader needs it.
   */
  diffHunk: string | null
  /** Permalink GitHub itself uses for this exact entry. */
  url: string
  /**
   * Provider id of the comment, or null for the description.
   *
   * The description is not a comment: it is a field on the pull request, so it
   * is edited through the pull request update instead of a comment endpoint, and
   * GitHub offers no delete or hide for it at all. Null is what a row reads to
   * know which of the two it is, rather than a flag that could disagree.
   */
  commentId: number | null
  /** Which collection `commentId` lives in. Meaningless when it is null. */
  commentKind: PrCommentKind
  /** GraphQL id, the only handle GitHub's minimise mutation accepts. */
  nodeId: string | null
}

/**
 * One inline review thread: the comment that opened it and every answer to it,
 * under the file and the diff GitHub showed when it was written.
 *
 * GitHub files a reply inside its parent's thread rather than beside it, and the
 * thread is what a reader actually reasons about: the code, then the argument
 * about it. Reading the same comments as a flat stream loses both halves, which
 * is why the thread, not the comment, is the unit the reader renders.
 */
export interface ReviewThread {
  key: string
  path: string
  /** Line in the file the thread anchors to; null once the thread is outdated. */
  line: number | null
  /**
   * Which file `line` numbers, as the opening comment declared it. A thread on a
   * removed line is anchored in the file before the change, and reading its line
   * against the file after it would point at a different line entirely.
   */
  side: PrCommentSide | null
  /** The comment that opened the thread, then its replies in arrival order. */
  comments: ConversationEntry[]
  /**
   * GraphQL node id of the thread itself, or null when the read did not reach
   * GitHub's `reviewThreads`. Without it the thread cannot be settled, so the
   * reader hides the action rather than offering one that cannot land.
   */
  threadNodeId: string | null
  /** True once the thread is settled, which only GitHub's thread node reports. */
  resolved: boolean
}

/**
 * The diff a thread is about, which is the hunk GitHub attached to the comment
 * that opened it. Read from the thread rather than stored twice, so the code a
 * thread shows and the code its comments were written against cannot disagree.
 */
export function threadDiffHunk(thread: ReviewThread): string | null {
  return thread.comments[0]?.diffHunk ?? null
}

/**
 * One unit of the conversation stream.
 *
 * A submitted review is one unit with its inline threads inside it: GitHub shows
 * a review's summary beside the threads that review wrote, and splitting the two
 * is what made the flat stream unreadable. Threads whose review the provider did
 * not return still stay readable, which is what the `threads` unit is for.
 */
export type ConversationNode =
  | { kind: 'description'; key: string; at: string; entry: ConversationEntry }
  | { kind: 'comment'; key: string; at: string; entry: ConversationEntry }
  | { kind: 'review'; key: string; at: string; entry: ConversationEntry; threads: ReviewThread[] }
  | { kind: 'threads'; key: string; at: string; threads: ReviewThread[] }

/**
 * Conversation as GitHub organises it: the description, then a chronological
 * stream in which each submitted review carries its own inline threads.
 *
 * Each entry also carries everything the per-comment actions need: the
 * provider's own permalink, the id and collection a mutation addresses, the
 * GraphQL node id hiding needs, and the author's declared picture. Assembling
 * that here means the rows and the menus read one shape instead of each of them
 * reaching back into the bundle and guessing which provider field applies.
 */
export function buildConversation(bundle: PullRequestBundle | undefined): ConversationNode[] {
  if (!bundle) return []
  const nodes: ConversationNode[] = []
  // The description is the pull request itself and holds the top of the stream.
  // It is built apart from the rest because it is the one unit no timestamp
  // orders: without a body there is no description at all, and the first thing
  // anyone actually said takes the top instead.
  const description: ConversationNode[] = bundle.detail.body.trim()
    ? [
        {
          kind: 'description',
          key: 'body',
          at: bundle.detail.createdAt,
          entry: {
            key: 'body',
            author: bundle.detail.authorLogin,
            avatarUrl: bundle.detail.authorAvatarUrl ?? null,
            isBot: bundle.detail.authorIsBot === true,
            at: bundle.detail.createdAt,
            updatedAt: null,
            body: bundle.detail.body,
            kind: 'description',
            repliesTo: null,
            diffHunk: null,
            url: bundle.detail.url,
            commentId: null,
            commentKind: 'issue',
            nodeId: null
          }
        }
      ]
    : []

  for (const comment of bundle.comments) {
    nodes.push({
      kind: 'comment',
      key: `c${comment.id}`,
      at: comment.createdAt,
      entry: {
        key: `c${comment.id}`,
        author: comment.authorLogin,
        avatarUrl: comment.authorAvatarUrl,
        isBot: comment.authorIsBot,
        at: comment.createdAt,
        updatedAt: comment.updatedAt,
        body: comment.body,
        kind: 'comment',
        repliesTo: null,
        diffHunk: null,
        url: comment.url,
        commentId: comment.id,
        commentKind: 'issue',
        nodeId: comment.nodeId
      }
    })
  }

  const threads = buildThreads(bundle.reviewComments, bundle.files, bundle.reviewThreads)
  const threadsByReview = new Map<number, ReviewThread[]>()
  const unclaimed: ReviewThread[] = []
  for (const thread of threads) {
    const reviewId = threadReviewId(thread, bundle.reviewComments)
    if (reviewId === null || !bundle.reviews.some((review) => review.id === reviewId)) {
      unclaimed.push(thread)
      continue
    }
    const claimed = threadsByReview.get(reviewId)
    if (claimed) claimed.push(thread)
    else threadsByReview.set(reviewId, [thread])
  }

  for (const review of bundle.reviews) {
    nodes.push({
      kind: 'review',
      key: `r${review.id}`,
      at: review.submittedAt,
      entry: reviewEntry(review),
      threads: threadsByReview.get(review.id) ?? []
    })
  }
  if (unclaimed.length > 0) {
    nodes.push({
      kind: 'threads',
      key: 'threads',
      at: earliestCommentAt(unclaimed),
      threads: unclaimed
    })
  }

  // The description holds the top; every other unit reads in the order it
  // happened. `sort` is stable, which keeps two units submitted in the same
  // second in the order the provider listed them.
  return [...description, ...nodes.sort((a, b) => parseAt(a.at) - parseAt(b.at))]
}

/**
 * Group inline comments into threads: each opening comment with the answers
 * below it, in the diff's own order.
 *
 * The diff order is the provider's file order, so threads read down the pull
 * request the way its patch does rather than alphabetically, which is the order
 * GitHub itself shows them in.
 */
function buildThreads(
  comments: PullRequestReviewComment[],
  files: PullRequestFile[],
  threadStates: PullRequestReviewThread[]
): ReviewThread[] {
  const threadOf = new Map<number, ReviewThread>()
  const roots: ReviewThread[] = []
  for (const comment of comments) {
    // A reply whose parent the provider did not return would otherwise be
    // dropped; treating it as a thread root keeps every comment readable.
    const parentId = comment.inReplyToId
    if (parentId !== null && comments.some((candidate) => candidate.id === parentId)) continue
    const thread: ReviewThread = {
      key: `t${comment.id}`,
      path: comment.path,
      line: comment.line,
      side: comment.side,
      comments: [reviewCommentEntry(comment)],
      threadNodeId: null,
      resolved: false
    }
    threadOf.set(comment.id, thread)
    roots.push(thread)
  }

  for (const comment of comments) {
    const parentId = comment.inReplyToId
    if (parentId === null) continue
    const thread = threadOf.get(parentId) ?? threadOf.get(rootIdOf(parentId, comments))
    if (!thread) continue
    const parent = comments.find((candidate) => candidate.id === parentId)
    thread.comments.push(reviewCommentEntry(comment, parent?.authorLogin ?? null))
    threadOf.set(comment.id, thread)
  }

  // A thread is read in the order its replies arrived, whatever order the
  // provider listed them in. The opening comment stays where it is: a reply that
  // carries an earlier timestamp is a provider oddity, not a new thread head.
  for (const thread of roots) {
    const [root, ...replies] = thread.comments
    if (!root) continue
    thread.comments = [root, ...replies.sort((a, b) => parseAt(a.at) - parseAt(b.at))]
    // Resolution is attached by the comment ids the thread holds, because the
    // thread's node id is the only thing GitHub's mutation accepts and the
    // comments are the only thing the two reads share.
    const state = threadStates.find((candidate) =>
      thread.comments.some(
        (comment) => comment.commentId !== null && candidate.commentIds.includes(comment.commentId)
      )
    )
    if (state) {
      thread.threadNodeId = state.nodeId
      thread.resolved = state.isResolved
    }
  }

  return roots.sort((a, b) => {
    const aIndex = filePosition(a.path, files)
    const bIndex = filePosition(b.path, files)
    if (aIndex !== bIndex) return aIndex - bIndex
    if (a.path !== b.path) return a.path.localeCompare(b.path)
    return (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER)
  })
}

/** Where a file sits in the pull request's patch, or last when it is not part of it. */
function filePosition(path: string, files: PullRequestFile[]): number {
  const index = files.findIndex((file) => file.path === path)
  return index < 0 ? Number.MAX_SAFE_INTEGER : index
}

/** The thread's opening comment id; the key is that id with its `t` marker. */
function threadRootId(thread: ReviewThread): number {
  return Number(thread.key.slice(1))
}

/** The root a comment's thread starts from, walking up a chain of replies. */
function rootIdOf(commentId: number, comments: PullRequestReviewComment[]): number {
  let current = commentId
  const seen = new Set<number>([current])
  for (;;) {
    const parent = comments.find((comment) => comment.id === current)?.inReplyToId ?? null
    if (parent === null || seen.has(parent)) return current
    seen.add(parent)
    current = parent
  }
}

/** The review a thread was submitted with, as its opening comment declares it. */
function threadReviewId(thread: ReviewThread, comments: PullRequestReviewComment[]): number | null {
  const rootId = threadRootId(thread)
  return comments.find((comment) => comment.id === rootId)?.reviewId ?? null
}

/** When a set of threads first said anything, for its place in the stream. */
function earliestCommentAt(threads: ReviewThread[]): string {
  let earliest = ''
  for (const thread of threads) {
    for (const comment of thread.comments) {
      if (!earliest || parseAt(comment.at) < parseAt(earliest)) earliest = comment.at
    }
  }
  return earliest
}

/** Parse a provider timestamp, treating a missing one as the beginning of time. */
function parseAt(value: string): number {
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function reviewEntry(review: PullRequestReview): ConversationEntry {
  return {
    key: `r${review.id}`,
    author: review.authorLogin,
    avatarUrl: review.authorAvatarUrl,
    isBot: review.authorIsBot,
    at: review.submittedAt,
    updatedAt: null,
    body: review.body,
    kind: 'review',
    meta: review.state.replace(/_/gu, ' ').toLowerCase(),
    repliesTo: null,
    diffHunk: null,
    url: review.url,
    commentId: null,
    commentKind: 'issue',
    nodeId: review.nodeId
  }
}

function reviewCommentEntry(
  comment: PullRequestReviewComment,
  repliesTo: string | null = null
): ConversationEntry {
  return {
    key: `rc${comment.id}`,
    author: comment.authorLogin,
    avatarUrl: comment.authorAvatarUrl,
    isBot: comment.authorIsBot,
    at: comment.createdAt,
    updatedAt: comment.updatedAt,
    body: comment.body,
    kind: 'inline',
    meta: comment.line === null ? comment.path : `${comment.path}:${comment.line}`,
    repliesTo,
    diffHunk: comment.diffHunk,
    url: comment.url,
    commentId: comment.id,
    commentKind: 'review',
    nodeId: comment.nodeId
  }
}

/** How many comments the stream renders, for the view switcher's count. */
export function conversationEntryCount(nodes: ConversationNode[]): number {
  let count = 0
  for (const node of nodes) {
    if (node.kind === 'threads') {
      count += countThreadComments(node.threads)
      continue
    }
    if (node.kind === 'review') {
      // A bare approval is still a verdict, and a review's threads count even
      // when its own summary says nothing.
      count += 1 + countThreadComments(node.threads)
      continue
    }
    if (hasBody(node.entry)) count += 1
  }
  return count
}

function countThreadComments(threads: ReviewThread[]): number {
  let count = 0
  for (const thread of threads) count += thread.comments.filter(hasBody).length
  return count
}

function hasBody(entry: ConversationEntry): boolean {
  return entry.body.trim().length > 0
}

/** Human label for a conversation entry's badge. */
export function conversationKindLabel(kind: ConversationEntryKind, meta?: string): string {
  if (kind === 'description') return 'Description'
  if (kind === 'inline') return 'Inline comment'
  if (kind === 'review') return reviewVerdictLabel(meta ?? '')
  return 'Comment'
}

/**
 * Wording for a review verdict.
 *
 * GitHub's `COMMENTED` is a review that only left notes, so it says what the
 * reviewer did rather than pretending to be a verdict.
 */
export function reviewVerdictLabel(state: string): string {
  if (state === 'approved') return 'Approved'
  if (state === 'changes requested') return 'Changes requested'
  if (state === 'dismissed') return 'Dismissed'
  if (state === 'commented') return 'Reviewed'
  return state || 'Review'
}

/** Badge colour for the pill that sits beside an author's name. */
export function reviewBadgeClass(meta: string | undefined): string {
  if (meta === 'approved') return 'bg-success/10 text-success'
  if (meta === 'changes requested') return 'bg-warning/10 text-warning'
  return 'bg-elevated text-dimmed'
}

/** One rendered line of a diff, with the file lines it exists at. */
export interface HunkLine {
  /** The line as the provider sent it, its `+`/`-`/`space` marker included. */
  text: string
  /** Line in the file before the change; null for a line only the new file has. */
  oldNumber: number | null
  /** Line in the file after the change; null for a line only the old file has. */
  newNumber: number | null
  /** True for the line the comment is anchored to. */
  anchor: boolean
  /**
   * True for the marker row standing in for lines the window skipped. Without it
   * two hunks would read as if they were adjacent in the file.
   */
  gap: boolean
}

/** The slice of a diff a reader sees, and where its lines were read from. */
export interface DiffContext {
  lines: HunkLine[]
  /**
   * True when the lines came from the file's own patch rather than from the hunk
   * GitHub attached to the comment. The patch is what carries the lines after the
   * commented one, which GitHub's `diff_hunk` never does.
   */
  fromPatch: boolean
}

/** Lines of context shown above and below an anchored line. */
export const DIFF_CONTEXT_LINES = 4

/** The file's own patch, which is where lines after an anchored line come from. */
export function filePatchFor(files: PullRequestFile[], path: string): string | null {
  return files.find((file) => file.path === path)?.patch ?? null
}

/**
 * The code a comment is about: the lines around its anchor, read from the file's
 * own patch when the surface has one and from GitHub's comment hunk when it does
 * not.
 *
 * The hunk GitHub attaches to an inline comment ends on the commented line, so on
 * its own it can only ever show what came before. The file's patch is the same
 * change with the later lines intact, which is why it is preferred: the reader
 * gets the code either side of the line instead of a window that stops there.
 *
 * A `context` of null removes the window entirely, which is what the Files view
 * asks for when it renders a whole patch.
 */
export function diffContext(input: {
  /** The file's whole patch, when the surface has it. */
  patch?: string | null
  /** The hunk GitHub attached to a comment, the fallback when the patch cannot place the anchor. */
  hunk?: string | null
  anchor?: number | null
  side?: PrCommentSide | null
  /** Lines shown each side of the anchor; null shows everything. */
  context?: number | null
}): DiffContext {
  const {
    patch = null,
    hunk = null,
    anchor = null,
    side = 'right',
    context = DIFF_CONTEXT_LINES
  } = input
  const patchDiff = parseDiff(patch)
  const hunkDiff = parseDiff(hunk)

  // Nothing to point at. The Files view wants everything it was given; an inline
  // comment whose line went outdated keeps the tail of its hunk, which ends on
  // the line it was written about.
  if (anchor === null) {
    if (context === null) {
      return patchDiff.lines.length > 0
        ? { lines: patchDiff.lines, fromPatch: true }
        : { lines: hunkDiff.lines, fromPatch: false }
    }
    return { lines: tail(hunkDiff.lines, context * 2 + 1), fromPatch: false }
  }

  const fromPatch = windowAround(patchDiff, anchor, side, context)
  if (fromPatch) return { lines: fromPatch, fromPatch: true }
  const fromHunk = windowAround(hunkDiff, anchor, side, context)
  return { lines: fromHunk ?? [], fromPatch: false }
}

/**
 * The window around one anchored line, or null when the text cannot place it.
 *
 * A skipped stretch of file is marked with a gap row rather than silently joined,
 * so the reader never reads two unrelated regions as consecutive lines.
 */
function windowAround(
  diff: ParsedDiff,
  anchor: number,
  side: PrCommentSide | null,
  context: number | null
): HunkLine[] | null {
  const anchorIndex = diff.lines.findLastIndex((line) => lineNumber(line, side) === anchor)
  if (anchorIndex < 0) return null
  const reach = Math.max(context ?? 0, 0)
  const first = context === null ? 0 : Math.max(0, anchorIndex - reach)
  const last =
    context === null ? diff.lines.length - 1 : Math.min(diff.lines.length - 1, anchorIndex + reach)
  const window: HunkLine[] = []
  for (let index = first; index <= last; index += 1) {
    const line = diff.lines[index]
    if (!line) continue
    if (window.length > 0 && diff.hunkOf[index] !== diff.hunkOf[index - 1]) {
      window.push({ text: '', oldNumber: null, newNumber: null, anchor: false, gap: true })
    }
    window.push(line)
  }
  return window.map((line) => ({ ...line, anchor: !line.gap && lineNumber(line, side) === anchor }))
}

/** The last `count` lines, for a comment whose anchor has left the diff. */
function tail(lines: HunkLine[], count: number): HunkLine[] {
  return lines.slice(Math.max(0, lines.length - Math.max(count, 1)))
}

/** The number a line is known by on the side the comment anchored to. */
function lineNumber(line: HunkLine, side: PrCommentSide | null): number | null {
  return side === 'left' ? line.oldNumber : line.newNumber
}

/** A diff read into numbered lines, with the hunk each line came from. */
interface ParsedDiff {
  lines: HunkLine[]
  /** Index of the hunk each line belongs to, so a window can mark a jump. */
  hunkOf: number[]
}

/**
 * Read a unified diff into lines that know their own file line numbers.
 *
 * Context and added lines advance the new file's counter while removed lines do
 * not, which is what makes the `+c,d` in a hunk header meaningful and what lets
 * the reader be pointed at the exact line a comment is about.
 */
function parseDiff(text: string | null): ParsedDiff {
  if (!text) return { lines: [], hunkOf: [] }
  const lines: HunkLine[] = []
  const hunkOf: number[] = []
  let oldNumber = 0
  let newNumber = 0
  let hunkIndex = -1
  let inHunk = false
  for (const row of text.split('\n')) {
    if (row.startsWith('@@')) {
      const start = hunkStartLineNumbers(row)
      oldNumber = start.old
      newNumber = start.new
      hunkIndex += 1
      inHunk = true
      continue
    }
    // The header is the first thing GitHub sends; anything ahead of it is not code.
    if (!inHunk) continue
    // The `\ No newline at end of file` marker belongs to the line above it and
    // has a number of its own on neither side.
    if (row.startsWith('\\')) {
      lines.push({ text: row, oldNumber: null, newNumber: null, anchor: false, gap: false })
      hunkOf.push(hunkIndex)
      continue
    }
    if (row.startsWith('-')) {
      lines.push({ text: row, oldNumber, newNumber: null, anchor: false, gap: false })
      hunkOf.push(hunkIndex)
      oldNumber += 1
      continue
    }
    if (row.startsWith('+')) {
      lines.push({ text: row, oldNumber: null, newNumber, anchor: false, gap: false })
      hunkOf.push(hunkIndex)
      newNumber += 1
      continue
    }
    // Context exists in both files, and the two counters only stay level while
    // nothing has been added or removed ahead of it.
    lines.push({ text: row, oldNumber, newNumber, anchor: false, gap: false })
    hunkOf.push(hunkIndex)
    oldNumber += 1
    newNumber += 1
  }
  return { lines, hunkOf }
}

/** The line numbers a hunk header starts at, one per side of the change. */
function hunkStartLineNumbers(header: string): { old: number; new: number } {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/u.exec(header)
  return match ? { old: Number(match[1]), new: Number(match[2]) } : { old: 1, new: 1 }
}

/**
 * Whether the viewer may rewrite this entry.
 *
 * GitHub gives a comment body to its author and the description to the pull
 * request's author, and nothing else. A submitted review is never editable, so
 * it stays excluded however the logins compare.
 */
export function canEditConversationEntry(
  entry: ConversationEntry,
  viewerLogin: string | null,
  pullAuthorLogin: string
): boolean {
  if (entry.kind === 'review') return false
  return entry.commentId === null ? viewerLogin === pullAuthorLogin : viewerLogin === entry.author
}

/** GitHub allows deleting a comment you wrote, and never a description. */
export function canDeleteConversationEntry(
  entry: ConversationEntry,
  viewerLogin: string | null
): boolean {
  return entry.commentId !== null && viewerLogin === entry.author
}

/** Hiding needs a node id, which a description does not expose here. */
export function canHideConversationEntry(entry: ConversationEntry): boolean {
  return entry.nodeId !== null
}

/** The quote-reply block GitHub builds from a comment's body. */
export function conversationQuoteBlock(entry: ConversationEntry): string {
  const quoted = entry.body
    .trim()
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n')
  // The attribution is a mention, so it takes the display login: an app account's
  // raw `name[bot]` would put GitHub's suffix where the handle belongs, and square
  // brackets are markdown link syntax.
  return `> **@${githubDisplayLogin(entry.author)}** wrote:\n>\n${quoted}\n\n`
}

export function checkIcon(check: PullRequestCheck): typeof Check {
  if (check.status !== 'completed') return CircleDot
  if (check.conclusion === 'success') return Check
  if (check.conclusion === 'skipped' || check.conclusion === 'neutral') return CircleSlash
  return X
}

export function checkClass(check: PullRequestCheck): string {
  if (check.status !== 'completed') return 'text-warning'
  if (check.conclusion === 'success') return 'text-success'
  if (check.conclusion === 'skipped' || check.conclusion === 'neutral') return 'text-dimmed'
  return 'text-danger'
}

/**
 * A check that finished without succeeding, which is the only kind a re-run can
 * help. Shares its branch shape with `checkClass`, which paints the same set
 * red, but answers a different question: "can a re-run fix this?"
 */
export function checkFailed(check: PullRequestCheck): boolean {
  if (check.status !== 'completed') return false
  return (
    check.conclusion !== 'success' &&
    check.conclusion !== 'skipped' &&
    check.conclusion !== 'neutral'
  )
}

/** Stable key for one check row, shared by the list key and the log cache. */
export function checkKey(check: PullRequestCheck): string {
  return check.name + (check.url ?? '')
}

/** Human wording for a check's progress, so `in_progress` is not shown raw. */
export function checkStateLabel(check: PullRequestCheck): string {
  if (check.status !== 'completed') return check.status.replace('_', ' ')
  return check.conclusion ?? 'done'
}

/** Colorize a unified patch the way the rest of the app renders diffs. */
export function patchLineClass(line: string): string {
  if (line.startsWith('@@')) return 'text-primary'
  if (line.startsWith('+')) return 'bg-success/10 text-success'
  if (line.startsWith('-')) return 'bg-danger/10 text-danger'
  return 'text-muted'
}

/** Name the two failures a reader can actually act on, then quote the rest. */
export function checkLogMessage(reason: unknown): string {
  const text = reason instanceof Error ? reason.message : ''
  if (/HTTP 404/u.test(text)) return 'This job has not published a log yet.'
  if (/HTTP (401|403)/u.test(text)) return 'Your GitHub access cannot read this job log.'
  return text || 'The log could not be loaded.'
}
