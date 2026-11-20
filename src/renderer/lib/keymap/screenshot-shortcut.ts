import { invoke } from '$lib/ipc.svelte'
import { showToastWarning } from '$lib/stores/app-errors.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import { acceleratorForKeys } from './screenshot-accelerator'

/**
 * Hand the region-screenshot chord to the main process.
 *
 * The capture starts while another app may own the keyboard, which is why the
 * chord is registered system-wide instead of handled by a window. Resolution of
 * the keymap tokens lives in `screenshot-accelerator`, so this module is only
 * the publishing half: what main answers, and what the user is told when it
 * cannot claim the chord.
 */

let warnedReason: string | null = null

/**
 * Publish the effective chord, and explain a refusal once.
 *
 * A chord the system already owns is a dead shortcut, and silence would make the
 * keymap row look bound while nothing happens. The warning is said once per
 * reason, so a config sync or a window reload does not repeat it.
 */
export function publishScreenshotShortcut(keys: readonly string[]): void {
  const accelerator = acceleratorForKeys(keys)
  void invoke('screenshot:setShortcut', accelerator)
    .then((result) => {
      if (
        result.registered ||
        !result.reason ||
        result.reason === 'unbound' ||
        result.reason === 'unsupported-platform'
      ) {
        warnedReason = null
        return
      }
      if (warnedReason === result.reason) return
      warnedReason = result.reason
      showToastWarning('The screenshot shortcut could not be claimed', {
        id: 'screenshot-shortcut-unavailable',
        description:
          result.reason === 'in-use'
            ? 'Another app already owns this chord. Choose a different one in Settings › Keymap.'
            : 'This chord cannot be registered system-wide. Choose another one in Settings › Keymap.',
        duration: 10_000
      })
    })
    .catch((error: unknown) => {
      logRendererError('The screenshot shortcut could not be registered', error)
    })
}
