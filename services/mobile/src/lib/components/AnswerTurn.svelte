<script lang="ts">
  import CioActivity from '@pdslng/cio-icon/CioActivity.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioClock from '@pdslng/cio-icon/CioClock.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import VendorMark from './VendorMark.svelte'
  import { formatDateTime } from '#shared/date-time-format'
  import { drop } from '#lib/motion'

  /**
   * One answer. The prose is what the oven wrote; the foot of the turn states
   * what wrote it, the harness and the model the thread runs on, and the one mark
   * for what can be done with it: copy the text, or read the turn's own numbers.
   *
   * The line above the answer belongs to the run's Working Trace. The service a
   * turn arrives from carries a role, a body, a sequence and a time and no steps,
   * so this screen draws no trace rather than inventing one.
   */
  interface Props {
    body: string
    at: number
    age: string
    seq: number
    /** What the thread runs on; both are optional in the store. */
    model: string | null
    harness: string | null
  }

  let { body, at, age, seq, model, harness }: Props = $props()

  let open = $state(false)
  let statsOpen = $state(false)
  let copied = $state(false)

  let stamp = $derived(formatDateTime(at))
  let words = $derived(
    body
      .trim()
      .split(/\s+/)
      .filter((word) => word.length > 0).length
  )

  let paragraphs = $derived(
    body
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
  )

  async function copy(): Promise<void> {
    open = false
    try {
      await navigator.clipboard.writeText(body)
      copied = true
      setTimeout(() => (copied = false), 1400)
    } catch {
      open = true
    }
  }

  function showStats(): void {
    open = false
    statsOpen = !statsOpen
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    const target = event.target
    if (target instanceof Element && target.closest('.turn-more, .turn-menu, .turn-stats')) return
    open = false
    statsOpen = false
  }}
  onkeydown={(event) => {
    if (event.key !== 'Escape') return
    open = false
    statsOpen = false
  }}
/>

<article class="turn">
  <div class="answer">
    {#each paragraphs as paragraph, index (index)}
      <p>{paragraph}</p>
    {/each}
  </div>

  <div class="turn-foot">
    <span class="turn-attrib">
      {#if harness}
        <span class="tm-harness" title={`Harness: ${harness}`}>
          <VendorMark name={harness} size={14} />
          {harness}
        </span>
        <span class="tm-sep" aria-hidden="true">·</span>
      {/if}
      {#if model}
        <span class="tm-model" title={`Model: ${model}`}>
          <VendorMark name={model} size={11} />
          <span>{model}</span>
        </span>
      {/if}
      <span class="tm-badge" title={stamp}>
        <CioClock size={9} />
        {age}
      </span>
    </span>

    <button
      class="turn-more"
      type="button"
      aria-haspopup="menu"
      aria-expanded={open || statsOpen}
      aria-label="Response actions"
      title="Response actions"
      onclick={() => (open = !open)}
    >
      <CioEllipsis size={14} />
    </button>

    {#if open}
      <div class="cpanel turn-menu" role="menu" aria-label="Response actions" transition:drop>
        <button class="turn-menu-item" type="button" role="menuitem" onclick={copy}>
          {#if copied}<CioCheck size={13} class="tick" />{:else}<CioCopy size={13} />{/if}
          <span>{copied ? 'Copied' : 'Copy'}</span>
        </button>
        <button class="turn-menu-item" type="button" role="menuitem" onclick={showStats}>
          <CioActivity size={13} />
          <span>Stats</span>
        </button>
      </div>
    {/if}

    {#if statsOpen}
      <div class="cpanel turn-stats" role="dialog" aria-label="Turn stats" transition:drop>
        <p class="turn-menu-info-title">This turn</p>
        <dl>
          <div>
            <dt>Written</dt>
            <dd>{stamp}</dd>
          </div>
          <div>
            <dt>Words</dt>
            <dd>{words.toLocaleString()}</dd>
          </div>
          <div>
            <dt>Position</dt>
            <dd>{seq}</dd>
          </div>
          {#if model}<div>
              <dt>Model</dt>
              <dd>{model}</dd>
            </div>{/if}
          {#if harness}<div>
              <dt>Harness</dt>
              <dd>{harness}</dd>
            </div>{/if}
        </dl>
      </div>
    {/if}
  </div>
</article>
