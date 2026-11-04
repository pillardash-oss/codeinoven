<script lang="ts">
  import { onMount } from 'svelte'
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import { session } from '#lib/stores/session.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import Dock from '#lib/components/Dock.svelte'
  import NewThreadSheet from '#lib/components/NewThreadSheet.svelte'
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
        title="New thread"
        onclick={() => {
          newThreadReady = true
          newThreadOpen = true
        }}
      >
        <CioPlus size={20} />
      </button>
    </div>
  {/if}
</div>

{#if newThreadReady}
  <NewThreadSheet open={newThreadOpen} onclose={() => (newThreadOpen = false)} />
{/if}
