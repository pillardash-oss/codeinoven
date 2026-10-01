<script lang="ts">
  import { Volume2 } from '@lucide/svelte'

  interface Props {
    /** Action-specific description, used for both `title` and `aria-label`. */
    label?: string
    size?: number
  }

  let { label = 'Playing audio', size = 13 }: Props = $props()
</script>

<!-- Shares the thread row's recording-indicator slot, in the same 14px box, so a
     thread that is playing sound and a thread that is listening sit in the same
     place. The glyph is a speaker rather than the recorder's pulse: one means
     sound coming out and the other means sound going in, and a dot for both left
     the row saying the same thing about two different states. -->
<span
  class="speaking-indicator flex h-3.5 w-3.5 shrink-0 items-center justify-center"
  role="status"
  aria-label={label}
  title={label}
>
  <Volume2 {size} strokeWidth={2.5} class="text-info" aria-hidden="true" />
</span>

<style>
  /* A slow breathe, because nothing else in this slot changes while audio plays:
     a still icon cannot say "now", and the slot's only other cue is that it is
     occupied at all. */
  @keyframes cio-speaking-breathe {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0.4;
    }
  }

  .speaking-indicator {
    animation: cio-speaking-breathe 1.4s ease-in-out infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .speaking-indicator {
      animation: none;
    }
  }
</style>
