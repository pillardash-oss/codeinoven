<script lang="ts">
  import CioActivity from '@pdslng/cio-icon/CioActivity.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioCpu from '@pdslng/cio-icon/CioCpu.svelte'
  import CioEllipsis from '@pdslng/cio-icon/CioEllipsis.svelte'
  import CioHarness from '@pdslng/cio-icon/CioHarness.svelte'
  import Sheet from './Sheet.svelte'
  import { formatDateTime } from '#shared/date-time-format'
  import { drop } from '#lib/motion'

  /**
   * One answer. The prose is what the oven wrote; the foot of the turn states
   * what wrote it   the model and the harness the thread runs on   and the one
   * mark for what can be done with it: copy the text, or read the turn's own
   * numbers.
   *
   * The numbers are measured from the message the service returned, not invented:
   * when it was written, how many characters and words it holds, and which
   * position in the transcript it takes. Tool calls are not part of the service
   * contract yet, so this screen has no working trace to compose them into; a
   * trace header would have to invent its steps, which is worse than its absence.
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
    statsOpen = true
  }
</script>

<svelte:window
  onpointerdown={(event) => {
    const target = event.target
    if (target instanceof Element && target.closest('.turn-more, .turn-menu')) return
    open = false
  }}
  onkeydown={(event) => {
    if (event.key === 'Escape') open = false
  }}
/>

<article class="turn">
  <div class="answer">
    {#each body
      .split(/\n{2,}/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0) as paragraph, index (index)}
      <p>{paragraph}</p>
    {/each}
  </div>

  <div class="turn-foot">
    <span class="turn-attrib">
      {#if harness}
        <span class="tm-chip" title={`Harness: ${harness}`}>
          <CioHarness size={12} />
          <span>{harness}</span>
        </span>
      {/if}
      {#if harness && model}<span class="tm-sep" aria-hidden="true">·</span>{/if}
      {#if model}
        <span class="tm-chip" title={`Model: ${model}`}>
          <CioCpu size={12} />
          <span>{model}</span>
        </span>
      {/if}
      <span class="tm-time" title={stamp}>{age}</span>
    </span>

    <button
      class="turn-more"
      type="button"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label="Response actions"
      title="Response actions"
      onclick={() => (open = !open)}
    >
      <CioEllipsis size={14} />
    </button>

    {#if open}
      <div class="turn-menu" role="menu" aria-label="Response actions" transition:drop>
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
  </div>
</article>

<Sheet open={statsOpen} onclose={() => (statsOpen = false)} placement="bottom" label="Turn stats">
  <div class="sheet-grab"></div>
  <div class="sheet-head">
    <h2>This turn</h2>
    <button type="button" onclick={() => (statsOpen = false)}>Done</button>
  </div>
  <div class="stats-body">
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
</Sheet>

<style>
  .turn {
    max-width: 100%;
    min-width: 0;
  }

  .answer {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .answer p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  /* The foot of the turn: what wrote it on the left, what can be done with it on
     the right. A phone has no hover, so the attribution is always readable. */
  .turn-foot {
    position: relative;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
  }

  .turn-attrib {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    min-width: 0;
    font-size: 0.625rem;
    color: var(--color-dimmed);
    white-space: nowrap;
  }

  .tm-chip {
    display: flex;
    align-items: center;
    gap: 0.25rem;
    min-width: 0;
  }

  .tm-chip span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tm-chip :global(svg) {
    flex: none;
    width: 0.75rem;
    height: 0.75rem;
  }

  .tm-time {
    flex: none;
    font-variant-numeric: tabular-nums;
  }

  .turn-more {
    flex: none;
    display: grid;
    place-items: center;
    width: 1.75rem;
    height: 1.75rem;
    margin-left: auto;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--color-dimmed);
    cursor: pointer;
    transition:
      background 120ms ease-out,
      color 120ms ease-out;
  }

  .turn-more:hover,
  .turn-more[aria-expanded='true'] {
    background: var(--color-elevated);
    color: var(--color-foreground);
  }

  /* It opens upward out of its own mark, over the response it belongs to. */
  .turn-menu {
    position: absolute;
    right: 0;
    bottom: calc(100% + 0.25rem);
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

  .stats-body {
    padding: 0.5rem var(--gutter)
      calc(0.75rem + var(--safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)));
  }

  .stats-body dl {
    margin: 0;
    border: 1px solid var(--color-border);
    background: var(--color-app);
    padding: 0.5rem 0.625rem;
  }

  .stats-body dl div {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.125rem 0;
    font-size: 0.8125rem;
  }

  .stats-body dt {
    color: var(--color-dimmed);
  }

  .stats-body dd {
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--color-foreground);
    font-variant-numeric: tabular-nums;
  }
</style>
