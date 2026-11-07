<script lang="ts">
  import { onMount } from 'svelte'
  import type { Snippet } from 'svelte'
  import { onNavigate } from '$app/navigation'
  import { page } from '$app/state'
  import { session } from '#lib/stores/session.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import Dock from '#lib/components/Dock.svelte'
  import NewThreadSheet from '#lib/components/NewThreadSheet.svelte'
  import { DOUBLE_TAP_MS, planNewThread, startNewThread } from '#lib/new-thread'
  import { showsDock, screenMotion } from '#lib/navigation'
  import { prefersLessMotion, SCREEN_MOTION } from '#lib/motion'
  import { appearance } from '#lib/stores/appearance.svelte'
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

  /**
   * A screen change follows the direction it was opened from. Panels are the root,
   * a conversation is one step under the list it was opened from, and a screen
   * opened from either is one step further, so it pushes in over its parent and
   * its parent returns the way it came. Moving between two panels runs the way the
   * dock reads, and the two readings of the work list turn in place.
   *
   * The browser snapshots both screens as images and animates those, so the slide
   * costs no layout and nothing in either screen can reflow. Which animation each
   * snapshot gets travels as an inherited custom property: ancestor-qualified
   * selectors never reach the view-transition pseudo-elements, so a data attribute
   * on the document could not choose them.
   */
  onNavigate((navigation) => {
    if (!document.startViewTransition || prefersLessMotion()) return
    const from = navigation.from?.url.pathname ?? ''
    const to = navigation.to?.url.pathname ?? ''
    const motion = screenMotion(from, to)
    if (motion === 'none') return
    const plan = SCREEN_MOTION[motion]

    const root = document.documentElement
    root.style.setProperty('--screen-in', plan.in)
    root.style.setProperty('--screen-out', plan.out)
    root.style.setProperty('--screen-ms', `${plan.ms}ms`)
    root.style.setProperty('--screen-ease', plan.ease)
    // A second change can start before this one has finished, and it owns the
    // properties by then, so the slower transition only clears what is still its
    // own.
    const clear = (): void => {
      if (root.style.getPropertyValue('--screen-in') !== plan.in) return
      root.style.removeProperty('--screen-in')
      root.style.removeProperty('--screen-out')
      root.style.removeProperty('--screen-ms')
      root.style.removeProperty('--screen-ease')
    }

    return new Promise<void>((resolve) => {
      const transition = document.startViewTransition(async () => {
        resolve()
        try {
          await navigation.complete
        } catch {
          // A navigation the reader abandoned before it landed has no new screen
          // to draw, and the frame it left behind is already gone.
        }
      })
      void transition.finished.then(clear, clear)
    })
  })

  /** Mounted on first use, so no screen asks for the project list it does not need. */
  let newThreadOpen = $state(false)
  let newThreadReady = $state(false)
  /** A press waiting to find out whether a second one is coming. */
  let tapTimer: ReturnType<typeof setTimeout> | null = null
  let starting = $state(false)

  onMount(() => {
    // The reader's appearance is written before the boot frame goes, so the first
    // screen is drawn in the face and size they chose.
    appearance.restore()
    appearance.apply()
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
  /**
   * The dock is the panels' own foot. A screen opened from one of them says so in
   * its header and leads back from there, so it never wears the navigation it was
   * reached through.
   */
  let showDock = $derived(signedIn && showsDock(path))

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
