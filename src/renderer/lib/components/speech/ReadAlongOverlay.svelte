<script lang="ts">
  import type { SpeechSegment } from '../../../../lib/speech/types'
  import { spokenWordOffset } from '../../speech/read-along'

  interface Props {
    segments: SpeechSegment[]
    /** Index of the currently read block; -1 disables the highlight. */
    activeIndex: number
    /** Fraction (0..1) of the active block already spoken. */
    spokenProgress: number
    /** Extra text sizing classes, e.g. `text-sm` or `text-[0.8125rem]`. */
    textClass?: string
  }

  let { segments, activeIndex, spokenProgress, textClass = '' }: Props = $props()

  let container = $state<HTMLDivElement | null>(null)

  // Keep the block currently being read in view while the overlay advances.
  $effect(() => {
    if (activeIndex < 0 || !container) return
    container
      .querySelector('[data-speech-line="active"]')
      ?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  })
</script>

<div bind:this={container} class="flex flex-col gap-1.5 {textClass}">
  {#each segments as seg, i (seg.id)}
    {@const spokenOffset = i === activeIndex ? spokenWordOffset(seg.text, spokenProgress) : -1}
    <div
      class={i === activeIndex
        ? 'rounded-md border border-dashed border-info/40 bg-info/5 px-2.5 py-1.5 transition-colors'
        : 'px-2.5 py-1 opacity-80'}
      data-speech-line={i === activeIndex ? 'active' : undefined}
    >
      <span class="leading-relaxed">
        {#if spokenOffset > 0}
          <span class="rounded-sm bg-info/20 px-0.5 box-decoration-clone"
            >{seg.text.slice(0, spokenOffset)}</span
          >{seg.text.slice(spokenOffset)}
        {:else}
          {seg.text}
        {/if}
      </span>
    </div>
  {/each}
</div>
