<script lang="ts">
  import CioMic from '@pdslng/cio-icon/CioMic.svelte'
  let { label = 'Listening', decorative = false }: { label?: string; decorative?: boolean } =
    $props()
</script>

<span
  class="flex items-center justify-center text-danger"
  role={decorative ? undefined : 'status'}
  aria-label={decorative ? undefined : label}
  aria-hidden={decorative}
  title={decorative ? undefined : label}
>
  <CioMic size={12} aria-hidden="true" />
</span>
