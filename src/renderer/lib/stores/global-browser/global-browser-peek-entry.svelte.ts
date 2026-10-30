import type { BrowserViewBounds } from '$shared/ipc-contract'
import type { BrowserPeekPhase } from '$lib/components/browser/browser-peek-transition'
import type { GlobalBrowserTab } from '../global-browser-types'

/** One Peek Window: the page it shows, who owns it, and where it is in its flight. */
export interface GlobalBrowserPeek {
  tab: GlobalBrowserTab
  projectId: string
  threadId: string
  /** The thread whose conversation counts the peek as its own. */
  ownerThreadId: string
  phase: BrowserPeekPhase
  origin: BrowserViewBounds | null
  documentSeen: boolean
  landed: boolean
}

/**
 * The live record a Peek Window is held in.
 *
 * This belongs in a `.svelte.ts` module because it is `$state`: the record has to
 * be deeply reactive, so a phase change or a landing is what the surface
 * re-renders for. A rune only exists where the Svelte compiler runs, which means
 * `.svelte.ts` and nowhere else. The store split moved this expression into a
 * plain `.ts` module that kept the `$state(` call, so the compiler never touched
 * it and `$state` was simply an undefined identifier at runtime: every peek threw
 * before it was ever registered, which made Take a Peek and Option-click both a
 * click that did nothing at all.
 */
export function createPeek(input: {
  tab: GlobalBrowserTab
  projectId: string
  threadId: string
  ownerThreadId: string
  origin: BrowserViewBounds | null
}): GlobalBrowserPeek {
  const peek = $state({
    tab: input.tab,
    projectId: input.projectId,
    threadId: input.threadId,
    ownerThreadId: input.ownerThreadId,
    phase: 'opening' as BrowserPeekPhase,
    origin: input.origin,
    documentSeen: false,
    landed: false
  })
  return peek
}
