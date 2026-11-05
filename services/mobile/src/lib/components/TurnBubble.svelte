<script lang="ts">
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioEllipsisVertical from '@pdslng/cio-icon/CioEllipsisVertical.svelte'
  import { formatDateTime } from '#shared/date-time-format'
  import { drop } from '#lib/motion'

  /**
   * One thing the person said, as a single bubble. Its left edge is the mark's
   * own column: the control and the edge are the same object, exactly the
   * bubble's height, with the ellipsis centred in it. The sent time sits under
   * the bubble and is always on screen, because a phone has no hover to wait for.
   *
   * The menu is what a prompt can honestly do on this client: the service keeps
   * its own copy of what was said, so there is no edit or delete to offer here.
   */
  interface Props {
    body: string
    /** When it was sent, epoch milliseconds. */
    at: number
    /** Already formatted by the page, so this component owns no time arithmetic. */
    age: string
  }

  let { body, at, age }: Props = $props()

  let open = $state(false)
  let copied = $state(false)

  let stamp = $derived(formatDateTime(at))

  async function copy(withTime: boolean): Promise<void> {
    open = false
    const text = withTime ? `${body}\n\n${stamp}` : body
    try {
      await navigator.clipboard.writeText(text)
      copied = true
      setTimeout(() => (copied = false), 1400)
    } catch {
      // A browser that refuses the clipboard is not worth an error row: the
      // menu simply stays open so the attempt can be repeated.
      open = true
    }
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    const target = event.target
    if (target instanceof Element && target.closest('.turn-fold, .turn-menu')) return
    open = false
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape') open = false
  }}
/>

<div class="message-block">
  <button
    class="turn-fold"
    type="button"
    aria-haspopup="menu"
    aria-expanded={open}
    aria-label="Message actions"
    title="Message actions"
    onclick={() => (open = !open)}
  >
    <CioEllipsisVertical size={12} />
  </button>

  <p class="turn-user">{body}</p>
  <span class="turn-at" title={stamp}>{age}</span>

  {#if open}
    <div class="turn-menu" role="menu" aria-label="Message actions" transition:drop>
      <button class="turn-menu-item" type="button" role="menuitem" onclick={() => copy(false)}>
        {#if copied}<CioCheck size={13} class="tick" />{:else}<CioCopy size={13} />{/if}
        <span>Copy</span>
      </button>
      <button class="turn-menu-item" type="button" role="menuitem" onclick={() => copy(true)}>
        <CioCopy size={13} />
        <span>Copy with time</span>
      </button>
      <p class="turn-menu-note">{stamp}</p>
    </div>
  {/if}
</div>

<style>
  /* The bubble is two columns: the mark's edge, then the words. The mark stretches
     to the row's height, so it is exactly as tall as the bubble and never taller. */
  .message-block {
    position: relative;
    display: grid;
    grid-template-columns: 1.25rem minmax(0, 1fr);
    align-items: start;
    min-width: 0;
  }

  .turn-fold {
    grid-column: 1;
    grid-row: 1;
    align-self: stretch;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    border: 0;
    background: var(--color-surface);
    color: var(--color-dimmed);
    cursor: pointer;
    transition:
      color 120ms ease-out,
      background 120ms ease-out;
  }

  .turn-fold:hover,
  .turn-fold[aria-expanded='true'] {
    background: var(--color-elevated);
    color: var(--color-foreground);
  }

  .turn-user {
    grid-column: 2;
    grid-row: 1;
    margin: 0;
    min-width: 0;
    padding: 0.625rem 1rem 0.625rem 0.5rem;
    background: var(--color-surface);
    color: var(--color-foreground);
    font-size: 0.9375rem;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .turn-at {
    grid-column: 2;
    grid-row: 2;
    justify-self: end;
    padding: 0.25rem 0.5rem 0 0;
    font-size: 0.625rem;
    color: var(--color-dimmed);
    font-variant-numeric: tabular-nums;
  }

  /* The menu drops out of the mark's own column, under the bubble's top edge. */
  .turn-menu {
    position: absolute;
    top: 2.25rem;
    left: 1rem;
    z-index: 40;
    width: 11rem;
    padding: 0.25rem;
    border: 1px solid var(--color-border-strong);
    background: var(--color-surface);
  }

  .turn-menu-item {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.375rem 0.5rem;
    border: 0;
    background: transparent;
    color: var(--color-foreground);
    font: inherit;
    font-size: 0.8125rem;
    text-align: left;
    cursor: pointer;
  }

  .turn-menu-item:hover {
    background: var(--color-elevated);
  }

  .turn-menu-item :global(svg) {
    flex: none;
    width: 0.8125rem;
    height: 0.8125rem;
    color: var(--color-dimmed);
  }

  .turn-menu-item :global(.tick) {
    color: var(--color-success);
  }

  .turn-menu-note {
    margin: 0;
    padding: 0.25rem 0.5rem 0.125rem;
    font-size: 0.625rem;
    color: var(--color-dimmed);
  }
</style>
