<script lang="ts">
  import MediaActivityTrail from '$lib/components/speech/MediaActivityTrail.svelte'
  import type { MediaActivity } from '$shared/media-activity'
  let {
    label,
    recording = false,
    activities
  }: { label: string; recording?: boolean; activities?: readonly MediaActivity[] } = $props()
</script>

<span
  class="absolute -bottom-2 -right-2 flex min-h-3.5 items-center justify-center border border-border bg-elevated shadow-sm"
>
  <MediaActivityTrail
    activities={activities ?? [recording ? 'microphone' : 'audio']}
    {label}
    size={10}
  />
</span>
