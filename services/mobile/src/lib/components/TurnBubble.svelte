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
    if (target instanceof Element && target.closest('.turn-fold, .turn-user-menu')) return
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
    <div class="cpanel turn-user-menu" role="menu" aria-label="Message actions" transition:drop>
      <button class="turn-menu-item" type="button" role="menuitem" onclick={() => copy(false)}>
        {#if copied}<CioCheck size={13} class="tick" />{:else}<CioCopy size={13} />{/if}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
      <button class="turn-menu-item" type="button" role="menuitem" onclick={() => copy(true)}>
        <CioCopy size={13} />
        <span>Copy with time</span>
      </button>
    </div>
  {/if}
</div>
