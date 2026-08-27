<script lang="ts">
  interface Props {
    label?: string
    decorative?: boolean
    /** Visual tone: dictation (danger red) or text-to-speech (info blue). */
    tone?: 'recording' | 'speech'
  }

  let { label = 'Listening', decorative = false, tone = 'recording' }: Props = $props()
</script>

<span
  class="recording-wrap {tone === 'speech' ? 'indicator-speech' : ''}"
  role={decorative ? undefined : 'status'}
  aria-label={decorative ? undefined : label}
  aria-hidden={decorative}
  title={decorative ? undefined : label}
>
  <span class="recording-dot"></span>
  <span class="recording-ping"></span>
</span>

<style>
  @keyframes cio-record-ping {
    0% {
      transform: scale(1);
      opacity: 0.45;
    }
    75%,
    100% {
      transform: scale(1.9);
      opacity: 0;
    }
  }

  .recording-wrap {
    position: relative;
    display: flex;
    width: 14px;
    height: 14px;
    align-items: center;
    justify-content: center;
  }

  .recording-dot {
    width: 10px;
    height: 10px;
    border-radius: 9999px;
    background: var(--color-danger);
    animation: cio-record-pulse 1.1s ease-in-out infinite;
  }

  .recording-ping {
    position: absolute;
    inset: 0;
    border-radius: 9999px;
    background: var(--color-danger);
    animation: cio-record-ping 1.35s cubic-bezier(0, 0, 0.2, 1) infinite;
  }

  .indicator-speech .recording-dot,
  .indicator-speech .recording-ping {
    background: var(--color-info);
  }

  @keyframes cio-record-pulse {
    0%,
    100% {
      transform: scale(1);
      opacity: 1;
    }
    50% {
      transform: scale(1.15);
      opacity: 0.78;
    }
  }
</style>
