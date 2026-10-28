<script lang="ts">
  import CioMic from '@pdslng/cio-icon/CioMic.svelte'
  import CioVolume from '@pdslng/cio-icon/CioVolume.svelte'
  import CioVolumeX from '@pdslng/cio-icon/CioVolumeX.svelte'
  import CioDisplay from '@pdslng/cio-icon/CioDisplay.svelte'
  import { MEDIA_ACTIVITY_LABEL, type MediaActivity } from '$shared/media-activity'
  let {
    kind,
    size = 12,
    muted = false,
    decorative = false,
    label
  }: {
    kind: MediaActivity
    size?: number
    muted?: boolean
    decorative?: boolean
    label?: string
  } = $props()
  const description = $derived(label ?? MEDIA_ACTIVITY_LABEL[kind])
</script>

<span
  class="inline-flex shrink-0 items-center justify-center {kind === 'audio'
    ? 'text-info'
    : 'text-danger'}"
  role={decorative ? undefined : 'status'}
  title={decorative ? undefined : description}
  aria-label={decorative ? undefined : description}
  aria-hidden={decorative}
>
  {#if kind === 'microphone'}
    <CioMic {size} strokeWidth={2.5} aria-hidden="true" />
  {:else if kind === 'camera'}
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"><path d="M3 6h12v12H3zM15 10l6-4v12l-6-4" /></svg
    >
  {:else if kind === 'screen'}
    <CioDisplay {size} strokeWidth={2.5} aria-hidden="true" />
  {:else if muted}
    <CioVolumeX {size} strokeWidth={2.5} aria-hidden="true" />
  {:else}
    <CioVolume {size} strokeWidth={2.5} aria-hidden="true" />
  {/if}
</span>
