import { buildChangeBreakdown, type ChangeBreakdownFile } from '$shared/change-breakdown'
import type { ChangeCardMessage, ChangeCardSummary } from './run-changes-summary'

/**
 * This module executes inside a dedicated worker, but the app's tsconfig loads
 * the DOM library, where `self` is a Window whose `postMessage` has no
 * transfer-list overload (its second argument is a target origin). Declaring
 * the worker-side surface the module actually uses keeps the transferred
 * bitmap buffer type-checked instead of casting the call to `never`.
 */
interface ChangeSummaryWorkerScope {
  onmessage: ((event: MessageEvent<ChangeCardMessage>) => void) | null
  postMessage(message: unknown, transfer?: Transferable[]): void
}
const workerScope = self as unknown as ChangeSummaryWorkerScope

const restored = new Set<string>()
const summary: ChangeCardSummary = {
  additions: 0,
  deletions: 0,
  edited: true,
  partial: false,
  remaining: false,
  restored: new Uint8Array()
}
const paths = new Map<string, ChangeBreakdownFile>()
let pathChars = 0
let classify = false
let changeIndex = 0
let restoredChars = 0
workerScope.onmessage = (event: MessageEvent<ChangeCardMessage>): void => {
  try {
    const message = event.data
    if ('totalChanges' in message) {
      classify = message.classify ?? false
      if (message.totalChanges > 8_000_000)
        throw new Error('Change summary exceeds the preview limit.')
      summary.restored = new Uint8Array(Math.ceil(message.totalChanges / 8))
    } else if ('restored' in message) {
      for (const path of message.restored) {
        if (restored.has(path)) continue
        restoredChars += path.length
        if (restored.size >= 65_536 || restoredChars > 4 * 1024 * 1024) {
          throw new Error(
            'Restore summary exceeds the preview limit. Review changes in the Changes panel.'
          )
        }
        restored.add(path)
      }
    } else if ('changes' in message) {
      for (const change of message.changes) {
        if (classify && !paths.has(change.path)) {
          pathChars += change.path.length
          if (paths.size >= 65536 || pathChars > 8 * 1024 * 1024)
            throw new Error('File breakdown exceeds the preview limit.')
          paths.set(change.path, {
            path: change.path,
            additions: change.additions,
            deletions: change.deletions
          })
        }
        summary.additions += change.additions
        summary.deletions += change.deletions
        summary.edited &&= change.edited
        summary.partial ||= change.partial
        const undone = restored.has(change.path)
        summary.remaining ||= !undone
        if (undone) summary.restored[changeIndex >>> 3] |= 1 << (changeIndex & 7)
        changeIndex += 1
      }
    } else {
      if (classify) summary.breakdown = buildChangeBreakdown([...paths.values()])
      workerScope.postMessage({ summary }, [summary.restored.buffer])
      return
    }
    workerScope.postMessage({})
  } catch (reason) {
    workerScope.postMessage({
      error: reason instanceof Error ? reason.message : 'Change summary failed.'
    })
  }
}
