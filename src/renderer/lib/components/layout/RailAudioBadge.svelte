<script lang="ts">
  import CioVolume from '$lib/components/icons/cio/CioVolume.svelte'

  let { label }: { label: string } = $props()
</script>

<span
  class="absolute -bottom-2 -right-2 flex h-3.5 w-3.5 items-center justify-center border border-border bg-elevated text-info shadow-sm"
  role="status"
  aria-label={`${label} is playing audio`}
  title={`${label} is playing audio`}
>
  <CioVolume size={9} strokeWidth={2.6} aria-hidden="true" />
</span>
