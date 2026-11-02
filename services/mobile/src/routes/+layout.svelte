<script lang="ts">
  import type { Snippet } from 'svelte'
  import { page } from '$app/state'
  import { session } from '#lib/stores/session.svelte'
  import BottomNav from '#lib/components/BottomNav.svelte'
  import '../app.css'

  /**
   * The shell draws one frame for every screen and decides which chrome belongs
   * to it. A conversation is read full height, so it hides the navigation instead
   * of stacking a composer above it.
   */

  let { children }: { children: Snippet } = $props()

  let path = $derived(page.url.pathname)
  let showNav = $derived(
    session.phase === 'authenticated' && path !== '/sign-in' && !/^\/threads\/[^/]+$/.test(path)
  )
</script>

<div class="app">
  {@render children()}
  {#if showNav}
    <BottomNav />
  {/if}
</div>
