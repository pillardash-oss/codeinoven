<script lang="ts">
  interface Props {
    label?: string
    decorative?: boolean
  }

  let { label = 'Transcribing', decorative = false }: Props = $props()
</script>

<!-- Three animated amber bars — the same voice-activity waveform the composer
     mic shows, reused wherever a live transcription needs representing. -->
<span
  class="wave-wrap"
  role={decorative ? undefined : 'status'}
  aria-label={decorative ? undefined : label}
  aria-hidden={decorative}
  title={decorative ? undefined : label}
>
  <span class="wave-bar"></span>
  <span class="wave-bar wave-bar-delay-1"></span>
  <span class="wave-bar wave-bar-delay-2"></span>
</span>

<style>
  @keyframes cio-wave-bars {
    0%,
    100% {
      height: 3px;
    }
    50% {
      height: 12px;
    }
  }

  .wave-wrap {
    display: flex;
    height: 12px;
    align-items: center;
    gap: 2px;
  }

  .wave-bar {
    display: block;
    width: 2px;
    height: 6px;
    border-radius: 1px;
    background: var(--color-warning);
    animation: cio-wave-bars 0.9s ease-in-out infinite;
  }

  .wave-bar-delay-1 {
    animation-delay: 0.15s;
  }

  .wave-bar-delay-2 {
    animation-delay: 0.3s;
  }
</style>
