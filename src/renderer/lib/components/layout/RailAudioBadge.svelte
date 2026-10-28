<script lang="ts">
  import MediaActivityTrail from '$lib/components/speech/MediaActivityTrail.svelte'
  import type { MediaActivity } from '$shared/media-activity'
  let {
    label,
    recording = false,
    activities
  }: { label: string; recording?: boolean; activities?: readonly MediaActivity[] } = $props()
</script>

<!--
  The mark sits on the item's own bottom-right corner, inside the rail's width,
  and it is padded so the glyph is never clipped by the badge's border.
  A wider offset made the mark hang into the gap below its item (and past the
  rail's right edge), where it read as belonging to the next item, and the bare
  box cut the bottom of the microphone's stand.
-->
<span
  class="absolute -bottom-1 right-0 flex min-h-3.5 items-center justify-center border border-border bg-elevated p-0.5 shadow-sm"
>
  <MediaActivityTrail
    activities={activities ?? [recording ? 'microphone' : 'audio']}
    {label}
    size={10}
  />
</span>
