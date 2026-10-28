<script lang="ts">
  import MediaActivityIndicator from './MediaActivityIndicator.svelte'
  import { MEDIA_ACTIVITY_LABEL, type MediaActivity } from '$shared/media-activity'
  let {
    activities,
    label,
    size = 12
  }: { activities: readonly MediaActivity[]; label?: string; size?: number } = $props()
</script>

<span class="inline-flex shrink-0 items-center gap-0.5">
  {#each activities as kind (kind)}
    <MediaActivityIndicator
      {kind}
      {size}
      label={label ? `${label}: ${MEDIA_ACTIVITY_LABEL[kind]}` : undefined}
    />
  {/each}
</span>
