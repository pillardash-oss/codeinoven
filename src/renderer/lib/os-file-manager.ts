/**
 * The OS file-manager surface for a path the app already owns.
 *
 * Every "show me this in the file manager" affordance goes through here so the
 * call and the platform-specific label exist once. `shell:revealPath`
 * re-validates the path in main against the approved roots (registered project
 * directories, healthy managed worktree checkouts, app artifact roots and
 * user-selected directories); it resolves to `false` instead of throwing when
 * the path is missing or outside those roots, so a caller can report the
 * refusal instead of assuming the reveal happened.
 */

import { invoke } from '$lib/ipc.svelte'
import { isMacPlatform } from '$lib/keymap/keymap'

/** Label for the reveal action on this platform, as the OS names its own UI. */
export function osFileManagerLabel(): string {
  return isMacPlatform() ? 'Reveal in File Manager' : 'Show in Explorer'
}

/** Reveal an absolute path in the OS file manager; false when main refuses it. */
export async function revealInOsFileManager(absolutePath: string): Promise<boolean> {
  return await invoke('shell:revealPath', absolutePath).catch(() => false)
}
