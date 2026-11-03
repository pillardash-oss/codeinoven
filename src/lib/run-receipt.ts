import type {
  AgentToolStatus,
  RunReceipt,
  RunReceiptBounds,
  RunReceiptCheck,
  RunReceiptCommit,
  RunReceiptFile,
  RunReceiptState,
  RunReceiptTotals
} from './types'
import { DEFAULT_RUN_RECEIPT_BOUNDS } from './types'

/**
 * Pure shaping for a run receipt.
 *
 * Everything here is a fact the main process already read: commits from one
 * bounded log read, files from one range diff, checks from the tool calls the
 * run actually made. Nothing in this module guesses, so a receipt can never
 * claim a number that no read produced.
 *
 * Kept free of Git, IPC and the DOM so the same rules are unit-testable and a
 * renderer can never re-summarise differently from main.
 */

/**
 * Shell-shaped tool names the run's checks are drawn from, normalized the way
 * the chat engine normalizes them (lowercase, alphanumerics only).
 */
const SHELL_TOOLS = new Set([
  'bash',
  'commandexecution',
  'execute',
  'executecommand',
  'execcommand',
  'localllmshell',
  'runcommand',
  'shell',
  'terminal'
])

/** Normalize a tool name for comparison, matching `normalizedToolName` in chat. */
function normalizedToolName(tool: string): string {
  return tool.toLowerCase().replaceAll(/[^a-z0-9]/gu, '')
}

/** Whether one tool call ran a shell command the receipt can report as a check. */
export function isShellToolName(tool: string): boolean {
  return SHELL_TOOLS.has(normalizedToolName(tool))
}

/** The command text a shell tool call carried, or `null` when it had none. */
export function commandFromToolInput(input: Record<string, unknown>): string | null {
  for (const key of ['command', 'cmd', 'script']) {
    const value = input[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
  }
  return null
}

/** One tool call, as much of it as a receipt needs. */
export interface RunReceiptToolCall {
  tool: string
  status: AgentToolStatus
  input: Record<string, unknown>
  output?: string
  error?: string
  metadata?: Record<string, unknown>
}

/** A command's own output, cut to a tail that names its own cut. */
export function boundedTail(text: string | undefined, maxChars: number): string | undefined {
  if (!text) return undefined
  const trimmed = text.trimEnd()
  if (trimmed.length === 0) return undefined
  if (trimmed.length <= maxChars) return trimmed
  // Cut on a line boundary when one exists, so the tail never starts mid-word.
  const slice = trimmed.slice(trimmed.length - maxChars)
  const firstBreak = slice.indexOf('\n')
  const bounded = firstBreak === -1 ? slice : slice.slice(firstBreak + 1)
  return `… ${bounded}`
}

/** The exit code a harness reported for a call, when it reported one. */
function exitCodeFromMetadata(metadata: Record<string, unknown> | undefined): number | undefined {
  if (!metadata) return undefined
  for (const key of ['exitCode', 'exit_code']) {
    const value = metadata[key]
    if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  }
  return undefined
}

/**
 * Checks from the calls a run made.
 *
 * A call that never reached a terminal state is not a check: a pending or
 * running command has no outcome, and reporting one would put a status on work
 * that has not happened. A run whose turns were prose only therefore produces
 * an empty list rather than a hopeful one.
 */
export function checksFromToolCalls(
  calls: readonly RunReceiptToolCall[],
  bounds: RunReceiptBounds = DEFAULT_RUN_RECEIPT_BOUNDS
): { checks: RunReceiptCheck[]; total: number; truncated: boolean } {
  const checks: RunReceiptCheck[] = []
  for (const call of calls) {
    if (!isShellToolName(call.tool)) continue
    const command = commandFromToolInput(call.input)
    if (!command) continue
    if (call.status !== 'completed' && call.status !== 'error' && call.status !== 'aborted')
      continue
    const exitCode = exitCodeFromMetadata(call.metadata)
    const outcome: RunReceiptCheck['outcome'] =
      call.status === 'completed' && (exitCode === undefined || exitCode === 0)
        ? 'passed'
        : call.status === 'aborted'
          ? 'aborted'
          : 'failed'
    const tail = boundedTail(call.output ?? call.error, bounds.checkTail)
    checks.push({
      command,
      outcome,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(tail === undefined ? {} : { tail })
    })
  }
  return {
    checks: checks.slice(0, bounds.checks),
    total: checks.length,
    truncated: checks.length > bounds.checks
  }
}

/** Line totals for one list of changed files. */
export function summarizeFiles(files: readonly RunReceiptFile[]): RunReceiptTotals {
  let additions = 0
  let deletions = 0
  for (const file of files) {
    additions += file.binary ? 0 : file.additions
    deletions += file.binary ? 0 : file.deletions
  }
  return { count: files.length, additions, deletions }
}

/** The input a receipt is shaped from: facts the service already read. */
export interface RunReceiptInput {
  state: RunReceiptState
  projectId: string
  threadId: string
  scope: RunReceipt['scope']
  baseSha: string | null
  headSha: string | null
  commits?: RunReceiptCommit[]
  files?: RunReceiptFile[]
  uncommitted?: RunReceiptFile[]
  checks?: RunReceiptCheck[]
  truncated?: Partial<RunReceipt['truncated']>
  reason?: string
  readAt: number
}

/**
 * Assemble a total receipt.
 *
 * Every list defaults to empty and every flag defaults to false, so a receipt
 * always answers every question a renderer asks. Totals are derived here and
 * nowhere else, which is what keeps main and the block from disagreeing.
 */
export function shapeRunReceipt(input: RunReceiptInput): RunReceipt {
  const commits = input.commits ?? []
  const files = input.files ?? []
  const uncommitted = input.uncommitted ?? []
  const checks = input.checks ?? []
  const checkCounts = { passed: 0, failed: 0, aborted: 0 }
  for (const check of checks) checkCounts[check.outcome] += 1
  return {
    state: input.state,
    projectId: input.projectId,
    threadId: input.threadId,
    scope: input.scope,
    baseSha: input.baseSha,
    headSha: input.headSha,
    commits,
    files,
    uncommitted,
    checks,
    totals: summarizeFiles(files),
    uncommittedTotals: summarizeFiles(uncommitted),
    checkCounts,
    truncated: {
      commits: input.truncated?.commits ?? false,
      files: input.truncated?.files ?? false,
      uncommitted: input.truncated?.uncommitted ?? false
    },
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    readAt: input.readAt
  }
}

/** `+240 −38` style line counts, with a sign only where a count is non-zero. */
export function formatLineCounts(totals: RunReceiptTotals): string {
  if (totals.count === 0) return 'none'
  const parts: string[] = []
  if (totals.additions > 0) parts.push(`+${totals.additions}`)
  if (totals.deletions > 0) parts.push(`−${totals.deletions}`)
  return parts.length > 0 ? parts.join(' ') : 'no line changes'
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`
}

/**
 * The one line a folded receipt shows, and the one a screen reader hears.
 *
 * It states what the run did rather than what is in the checkout: commits it
 * made, files it changed, lines it added and removed, and the checks that ran.
 * A non-ready state says so from the same function, so the fold headline can
 * never claim a finished run for one that is parked or unbased.
 */
export function receiptSummaryLine(receipt: RunReceipt): string {
  if (receipt.state === 'running') return 'Run in progress'
  if (receipt.state === 'no-base') return 'No starting commit recorded'
  if (receipt.state === 'parked') return receipt.reason ? `Parked: ${receipt.reason}` : 'Parked'
  if (receipt.state === 'error')
    return receipt.reason ? `Could not read: ${receipt.reason}` : 'Could not read'
  const parts: string[] = []
  if (receipt.totals.count > 0) {
    parts.push(
      `${plural(receipt.totals.count, 'file', 'files')} ${formatLineCounts(receipt.totals)}`
    )
  } else {
    parts.push('No files changed')
  }
  if (receipt.commits.length > 0) parts.push(plural(receipt.commits.length, 'commit', 'commits'))
  if (receipt.checks.length > 0) {
    const { passed, failed } = receipt.checkCounts
    parts.push(
      failed > 0
        ? `${plural(failed, 'check', 'checks')} failed`
        : `${plural(passed, 'check', 'checks')} passed`
    )
  }
  if (receipt.uncommittedTotals.count > 0) {
    parts.push(`${receipt.uncommittedTotals.count} uncommitted`)
  }
  return parts.join(' · ')
}
