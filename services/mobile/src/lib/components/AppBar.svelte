<script lang="ts">
  import type { Snippet } from 'svelte'
  import CioBack from '@pdslng/cio-icon/CioBack.svelte'

  /**
   * The screen header: a title with an optional count, and the screen's own
   * actions as a snippet. The bar is where the safe area is spent, so nothing
   * below it has to know about the notch.
   */
  interface Props {
    title: string
    count?: number | null
    /** A back control replaces the title's left padding, as the design draws it. */
    back?: { href: string; label: string } | null
    actions?: Snippet
    /** Draw the hairline under the bar even before the list scrolls. */
    ruled?: boolean
  }

  let { title, count = null, back = null, actions, ruled = false }: Props = $props()
</script>

<header class={['bar', { talk: back !== null || ruled }]}>
  <div class="bar-row">
    {#if back}
      <a class="menu-btn" href={back.href} aria-label={back.label} title={back.label}>
        <CioBack size={20} />
      </a>
    {/if}
    <div class="bar-title">
      <h1>
        {title}
        {#if count !== null && count !== undefined}<span class="count">{count}</span>{/if}
      </h1>
    </div>
    {#if actions}
      <div class="actions">{@render actions()}</div>
    {/if}
  </div>
</header>
