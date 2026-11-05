<script lang="ts">
  import { onMount } from 'svelte'
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import { session } from '#lib/stores/session.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import Dock from '#lib/components/Dock.svelte'
  import NewThreadSheet from '#lib/components/NewThreadSheet.svelte'
  import { DOUBLE_TAP_MS, planNewThread, startNewThread } from '#lib/new-thread'
  import { syncSystemBars } from '#lib/system-bars'
  import '../app.css'

  /**
   * The shell draws one frame for every screen and decides which chrome belongs
   * to it. A conversation is read full height, so it keeps the dock out of the
   * way instead of stacking a bar over the composer.
   *
   * The foot of a panel is two floating pieces, never one bar: the dock carries
   * navigation, the square beside it carries the account, and the gap between
   * them is what keeps the row readable.
   */

  let { children }: { children: Snippet } = $props()

  /** Mounted on first use, so no screen asks for the project list it does not need. */
  let newThreadOpen = $state(false)
  let newThreadReady = $state(false)
  /** A press waiting to find out whether a second one is coming. */
  let tapTimer: ReturnType<typeof setTimeout> | null = null
  let starting = $state(false)

  onMount(() => {
    // The boot frame in app.html has done its job once the shell is on screen.
    document.getElementById('boot')?.remove()
    void syncSystemBars()
    // The bar follows the system while the app is following it.
    const scheme = globalThis.matchMedia?.('(prefers-color-scheme: dark)')
    const follow = (): void => void syncSystemBars()
    scheme?.addEventListener('change', follow)
    return () => scheme?.removeEventListener('change', follow)
  })

  let path = $derived(page.url.pathname)
  let signedIn = $derived(session.phase === 'authenticated')
  let showDock = $derived(signedIn && path !== '/sign-in' && !/^\/threads\/[^/]+$/.test(path))

  /**
   * The chooser is the fallback, never the flow: it opens when there is a choice
   * to make or when the service refused a direct start, and it reports why.
   */
  function openChooser(): void {
    newThreadReady = true
    newThreadOpen = true
  }

  async function startIn(projectId: string): Promise<void> {
    if (starting) return
    starting = true
    try {
      await startNewThread(projectId)
    } catch {
      // A thread the service would not start is the chooser's news to tell: the
      // sheet carries the message and the project's own error.
      openChooser()
    } finally {
      starting = false
    }
  }

  /**
   * One tap reads what the panel means and opens the chooser when there is a
   * choice; a second tap inside the window skips ahead and starts in the project
   * in hand.
   */
  async function onNewThread(): Promise<void> {
    if (tapTimer !== null) {
      clearTimeout(tapTimer)
      tapTimer = null
      const plan = await planNewThread({ onChats: path.startsWith('/chats') }).catch(() => null)
      if (plan?.projectId) await startIn(plan.projectId)
      else openChooser()
      return
    }
    tapTimer = setTimeout(() => {
      tapTimer = null
      void openForSingleTap()
    }, DOUBLE_TAP_MS)
  }

  async function openForSingleTap(): Promise<void> {
    const onChats = path.startsWith('/chats')
    const plan = await planNewThread({ onChats }).catch(() => null)
    if (!plan) {
      openChooser()
      return
    }
    if (plan.intent === 'direct' && plan.projectId) {
      await startIn(plan.projectId)
      return
    }
    openChooser()
  }
</script>

<div class="app" data-dock={showDock}>
  {@render children()}
  {#if showDock}
    <div class="bottombar">
      <Dock />
      <button
        class="fab"
        type="button"
        aria-label="New thread"
        title="New thread: tap twice to start in the project in hand"
        aria-busy={starting}
        onclick={() => void onNewThread()}
      >
        <CioPlus size={20} />
      </button>
    </div>
  {/if}
</div>

{#if newThreadReady}
  <NewThreadSheet open={newThreadOpen} onclose={() => (newThreadOpen = false)} />
{/if}
