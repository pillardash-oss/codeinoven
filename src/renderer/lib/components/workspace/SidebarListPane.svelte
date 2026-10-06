<script lang="ts">
  import { onMount, type Snippet } from 'svelte'
  import { cancelDeferredWork, scheduleDeferredWork } from '$lib/deferred-work'

  interface Props {
    /**
     * Whether the list inside is the one the shell is showing.
     *
     * A pane that has been on screen stays mounted, hidden, while another view
     * is. The sidebar's lists are the same thread rows the app already holds in
     * memory, and tearing one down to build the next one costs every row
     * component in it: moving between Projects, Threads and Scoped used to
     * rebuild a few hundred rows per switch, which is what made the switch take
     * around a second with a few hundred threads. Switching is a visibility flip
     * instead.
     */
    visible: boolean
    /** Names the list. Distinguishes the panes in the DOM and in tests. */
    name: string
    children: Snippet
  }

  let { visible, name, children }: Props = $props()

  /**
   * Whether this list has ever been on screen (or preloaded ahead of a switch).
   *
   * Captured rather than derived so the pane the shell opens on renders in the
   * same flush, and latched rather than derived so leaving the view never
   * unmounts it.
   */
  // svelte-ignore state_referenced_locally
  let shown = $state(visible)
  $effect(() => {
    // A latch, not a derivation: the effect exists to remember that this view
    // has been shown, and there is nothing to derive it from.
    if (visible) shown = true
  })

  // A pane that is not on screen yet mounts its list in the shell's first idle
  // window rather than on the frame the user switches to it. That is the same
  // mount a switch used to pay for, moved to a moment where it cannot delay the
  // view the user asked for, so the first switch of a session is already a
  // visibility flip.
  onMount(() => {
    if (visible) return
    const key = `sidebar-pane:${name}`
    scheduleDeferredWork(key, () => (shown = true), { timeoutMs: 600 })
    return () => cancelDeferredWork(key)
  })
</script>

<!-- The wrapper generates no box of its own: `contents` keeps every pane's
     list a layout child of the sidebar's scroller, exactly where it sat before
     the panes existed (the scoped pane's `h-full` measures against the scroller,
     and the lists' sibling spacing stays intact). Hidden panes are taken out of
     layout, out of the accessibility tree and out of the focus order, so a
     hidden list is inert with no pointer-events or tabindex bookkeeping. -->
<div class={visible ? 'contents' : 'hidden'} hidden={!visible} data-sidebar-pane={name}>
  {#if shown}
    {@render children()}
  {/if}
</div>
