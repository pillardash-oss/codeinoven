/**
 * The last thing the preamble does: tell the app what it had to repair.
 *
 * The app has no window into a worker's globals, so the preamble publishes what it
 * did into the extension's own storage, where any extension page can read it back as
 * `chrome.storage.local.get('__cioCompatReport')`. A capability report built from
 * that is honest about what this runtime could not provide, instead of an extension
 * screen quietly missing a feature.
 *
 * Both the delay and the second pass are deliberate: an extension page can open
 * before the worker's own startup work has finished, and a report read at 1.5s that
 * is missing the last namespace would be read as absent capability.
 */
import { chromeApi, namespaceOf, state } from './context.ts'

/** Write the report the app reads, once. */
export function publishCompatReport(): void {
  try {
    const storage = namespaceOf(chromeApi, 'storage')
    const local = storage ? namespaceOf(storage as Record<string, unknown>, 'local') : undefined
    const set = local ? local['set'] : undefined
    if (typeof set === 'function') {
      ;(set as (values: Record<string, unknown>) => void).call(local, {
        __cioCompatReport: JSON.parse(JSON.stringify(state))
      })
    }
  } catch (error) {
    state.errors.push('publish: ' + String(error))
  }
}

/** Schedule the two publishes the app reads its capability report from. */
export function installPublisher(): void {
  state.preambleAt = Date.now()
  setTimeout(publishCompatReport, 1500)
  setTimeout(publishCompatReport, 4000)
}
