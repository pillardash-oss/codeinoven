import { type MainView } from '$lib/stores/renderer-recovery.svelte'

export type View = MainView

/** The spotlight is one surface, not four. `actions` is its home screen; the
 *  other three open from it and only ever show inside the same shell. */
export type SpotlightScreenId =
  'actions' | 'files' | 'threads' | 'chats' | 'assistants' | 'browser' | 'projects'
