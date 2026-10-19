import { diffDetails } from './file-diff'
import type { DiffWorkerInput, DiffWorkerReply } from './file-diff-async'

// Bound both the algorithm's allocations and the structured-clone result.
const MAX_SOURCE_LINES = 20_000

self.onmessage = (event: MessageEvent<DiffWorkerInput>): void => {
  const input = event.data
  try {
    for (const source of [input.before, input.after]) {
      let lines = 1
      for (let index = 0; index < (source?.length ?? 0); index += 1) {
        if (source?.charCodeAt(index) === 10 && ++lines > MAX_SOURCE_LINES) {
          throw new Error(
            'This file exceeds the diff preview line limit. Open the file to inspect it.'
          )
        }
      }
    }
    const details = diffDetails(
      input.before,
      input.after,
      input.beforeStartLine,
      input.afterStartLine
    )
    const reply: DiffWorkerReply = { details }
    self.postMessage(reply)
  } catch (reason) {
    const reply: DiffWorkerReply = {
      error: reason instanceof Error ? reason.message : 'Diff computation failed.'
    }
    self.postMessage(reply)
  }
}
