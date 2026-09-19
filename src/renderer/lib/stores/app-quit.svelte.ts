/**
 * The renderer's view of "this app is quitting".
 *
 * The main process tells every window about a confirmed quit through
 * `window:beforeQuit`, then runs its shutdown pipeline: remote mode, PTYs,
 * schedulers, the chat engine, and finally the database. The window stays alive
 * for that whole pipeline (Electron only closes it at the pipeline's final
 * `app.quit()`), so any renderer work that keeps reading storage schedules
 * itself into a moment when the database is already closed. That surfaces as a
 * rejected invoke against torn-down storage plus an error line in the main log;
 * the durable-stream poll on a working thread (`thread:loadStreamParts`, once a
 * second) is the one that has been observed doing it.
 *
 * Repeating background reads therefore check this signal and stop, which is
 * what the `window:beforeQuit` contract already asks of the renderer. One-shot
 * user-intent work is deliberately not gated: draft commits and unsaved-file
 * saves must still land during the grace period the main process waits out
 * before it closes storage.
 *
 * Latched, never reset: the signal can only turn on, because the pipeline it
 * announces always ends in process exit.
 */

let appQuitting = $state(false)

export const appQuitState = {
  /** True once this renderer has been told the app is quitting. */
  get quitting(): boolean {
    return appQuitting
  },

  /** Latched from the `window:beforeQuit` subscription in App.svelte. */
  markQuitting(): void {
    appQuitting = true
  }
}
