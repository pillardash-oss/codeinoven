<script lang="ts">
  import CioChat from '@pdslng/cio-icon/CioChat.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import CioRefresh from '@pdslng/cio-icon/CioRefresh.svelte'
  import CioSearch from '@pdslng/cio-icon/CioSearch.svelte'
  import CioServer from '@pdslng/cio-icon/CioServer.svelte'
  import { api } from '#lib/api/client'
  import {
    compactTokens,
    filledCells,
    formatCost,
    formatCount,
    meterLevel,
    usagePercent
  } from '#lib/composer-choice'
  import type { ComposerPanel } from './panel'
  import type { Oven, Thread, ThreadUsage } from '#lib/api/types'

  /**
   * The shoe: the line under the composer that states what the message writes
   * into, where it runs, and what the context has left. Every segment is the
   * app's own control, and every panel is anchored to the segment that owns it.
   */
  interface Props {
    thread: Thread | null
    usage: ThreadUsage | null
    usagePhase: 'idle' | 'loading' | 'ready' | 'error'
    /** The panel this shoe has open, owned by the composer so only one opens. */
    open: ComposerPanel
    resetting?: boolean
    ontoggle: (panel: ComposerPanel) => void
    onpickoven: (ovenId: string | null) => void
    onreset: () => void
    onreloadusage: () => void
  }

  let {
    thread,
    usage,
    usagePhase,
    open,
    resetting = false,
    ontoggle,
    onpickoven,
    onreset,
    onreloadusage
  }: Props = $props()

  let ovens = $state<Oven[]>([])
  let ovensPhase = $state<'idle' | 'loading' | 'ready' | 'error'>('idle')
  let query = $state('')

  let percent = $derived(usagePercent(usage))
  let filled = $derived(filledCells(percent))
  let level = $derived(usage ? meterLevel(usage.used, usage.window) : 'ok')
  let ovenName = $derived(
    thread?.ovenId ? (ovens.find((oven) => oven.id === thread?.ovenId)?.name ?? 'Oven') : 'Local'
  )
  let visibleOvens = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    if (needle.length === 0) return ovens
    return ovens.filter((oven) => oven.name.toLowerCase().includes(needle))
  })

  /** The list is read the first time the picker opens and kept for the screen. */
  async function toggleOvens(): Promise<void> {
    const opening = open !== 'oven'
    ontoggle('oven')
    if (!opening || ovensPhase !== 'idle') return
    ovensPhase = 'loading'
    try {
      ovens = await api.ovens()
      ovensPhase = 'ready'
    } catch {
      ovensPhase = 'error'
    }
  }

  function choose(ovenId: string | null): void {
    onpickoven(ovenId)
    ontoggle(null)
  }
</script>

<div class="composer-shoe">
  <div class="composer-shoe-card">
    <span class="shoe-seg shoe-scope" title="Writes into this chat">
      <CioChat size={12} />
      <span>Chat</span>
    </span>
    <span class="shoe-sep" aria-hidden="true"></span>

    <div class="cpanel-holder">
      <button
        class="shoe-seg shoe-oven"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open === 'oven'}
        aria-controls="oven-menu"
        aria-label={`Oven: ${ovenName}`}
        title="Choose the Oven for this thread"
        onclick={toggleOvens}
      >
        {#if thread?.ovenId}
          <CioServer size={12} />
        {:else}
          <CioDisplay size={12} />
        {/if}
        <span>{ovenName}</span>
        <span class="chev"><CioChevronDown size={11} /></span>
      </button>

      {#if open === 'oven'}
        <div class="cpanel oven-menu" id="oven-menu" role="menu" aria-label="Choose Oven">
          <div class="oven-search">
            <CioSearch size={13} />
            <input
              bind:value={query}
              type="text"
              placeholder="Search Ovens…"
              aria-label="Search Ovens"
            />
          </div>
          <div class="oven-list">
            <button
              class="oven-item"
              type="button"
              role="menuitemradio"
              aria-checked={!thread?.ovenId}
              title="Run on this machine"
              onclick={() => choose(null)}
            >
              <CioDisplay size={12} />
              <span class="ov-name">Local</span>
              <span class="ov-tag">Local</span>
            </button>
            {#if ovensPhase === 'loading'}
              <p class="cpanel-caption">Reading the Ovens…</p>
            {:else if ovensPhase === 'error'}
              <p class="cpanel-caption">The Ovens could not be read.</p>
            {:else}
              {#each visibleOvens as oven (oven.id)}
                <button
                  class="oven-item"
                  type="button"
                  role="menuitemradio"
                  aria-checked={thread?.ovenId === oven.id}
                  title={`Run on ${oven.name}`}
                  onclick={() => choose(oven.id)}
                >
                  <CioServer size={12} />
                  <span class="ov-name">{oven.name}</span>
                  <span class="ov-tag">SSH</span>
                </button>
              {/each}
              {#if ovensPhase === 'ready' && visibleOvens.length === 0}
                <p class="cpanel-caption">No Oven matches that search.</p>
              {/if}
            {/if}
          </div>
        </div>
      {/if}
    </div>

    {#if usage && usage.window > 0}
      <button
        class="meter"
        type="button"
        data-level={level}
        aria-haspopup="dialog"
        aria-expanded={open === 'usage'}
        aria-label={`Context ${percent} percent used`}
        title="Context and usage"
        onclick={() => ontoggle('usage')}
      >
        <span class="cells" aria-hidden="true">
          {#each [0, 1, 2, 3] as cell (cell)}
            <i data-fill={cell < filled}></i>
          {/each}
        </span>
        <span>{percent}%</span>
      </button>

      {#if open === 'usage'}
        <div class="cpanel usage-panel" role="dialog" aria-label="Context and usage">
          <div class="usage-head">
            <span class="usage-ring" aria-hidden="true">{percent}<small>%</small></span>
            <span class="usage-head-text">
              <b>Context</b>
              <span>{percent}% of {compactTokens(usage.window)}</span>
            </span>
          </div>
          <dl>
            <div>
              <dt>Used</dt>
              <dd>{formatCount(usage.used)}</dd>
            </div>
            <div>
              <dt>Left before compact</dt>
              <dd>{formatCount(usage.leftBeforeCompact)}</dd>
            </div>
            <div>
              <dt>This turn</dt>
              <dd>
                {compactTokens(usage.thisTurn.input)} in · {compactTokens(usage.thisTurn.output)} out
              </dd>
            </div>
            <div>
              <dt>Rate</dt>
              <dd>{Math.round(usage.rate)} tok/s</dd>
            </div>
            <div>
              <dt>Cost so far</dt>
              <dd>{formatCost(usage.costMicros)}</dd>
            </div>
          </dl>
          <button
            class="usage-reset"
            type="button"
            disabled={resetting}
            title="Start the context reading again from zero"
            onclick={onreset}
          >
            <CioRefresh size={11} />
            {resetting ? 'Resetting…' : 'Reset usage'}
          </button>
        </div>
      {/if}
    {:else if usagePhase === 'error'}
      <button
        class="meter"
        type="button"
        aria-label="Context usage could not be read, try again"
        title="Context usage could not be read, try again"
        onclick={onreloadusage}
      >
        <span>—</span>
      </button>
    {/if}
  </div>
</div>
