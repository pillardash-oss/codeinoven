<script lang="ts">
  import ReadAlongOverlay from '../speech/ReadAlongOverlay.svelte'
  import type { SpeechSegment } from '$shared/speech/types'

  interface Props {
    /** Blocks of the document being spoken, in playback order. */
    segments: SpeechSegment[]
    /** Index of the block being read; -1 turns the highlight off. */
    activeIndex: number
    /** Fraction (0..1) of the active block already spoken. */
    spokenProgress: number
  }

  let { segments, activeIndex, spokenProgress }: Props = $props()
</script>

<!-- The viewer body while this document is spoken. The read-along stands in for
     the file so the reader follows the line being read instead of hunting for it
     in the source; it is transient, and the file returns when playback ends.
     Text size and padding match the annotated document view. -->
<div class="min-h-0 flex-1 overflow-auto px-4 py-3" data-region="read-along">
  <ReadAlongOverlay {segments} {activeIndex} {spokenProgress} textClass="text-sm" />
</div>
