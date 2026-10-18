import { invoke } from '$lib/ipc.svelte'

/**
 * Ask main to boot the local embedding model now.
 *
 * That model is what ranks the spotlight's thread search by meaning, and it is
 * kept resident for five minutes after its last use, so the first Cmd+K search
 * after a pause would otherwise find it cold and pay its load before it could
 * rank. Warming on the Cmd+K keystroke, and again when a thread-search screen
 * opens, keeps the boot behind the user's typing instead of in front of their
 * results. Main ignores the call unless intent search is enabled with a model
 * the local runtime can load.
 */
export function warmIntentSearch(): void {
  void invoke('search:warm').catch(() => undefined)
}
