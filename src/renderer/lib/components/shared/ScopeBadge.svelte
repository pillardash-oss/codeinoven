<script lang="ts">
  import { getIconSvgDataUrl, generateInitialsIconSvg } from '$lib/project-svg-icons'
  import { pickColorForSeed } from '$lib/project-colors'
  import type { ScopeBucket } from '$shared/types'

  interface Props {
    bucket: ScopeBucket
    size?: 'sm' | 'xs'
  }

  let { bucket, size = 'xs' }: Props = $props()

  let color = $derived(bucket.color ?? pickColorForSeed(bucket.id))
</script>

<code
  class="flex items-center gap-1 rounded-md bg-raised font-mono font-normal text-foreground {size ===
  'xs'
    ? 'px-1.5 py-0.5 text-[10px]'
    : 'px-2.5 py-1 text-xs'}"
  style:background-color={bucket.color
    ? `color-mix(in srgb, ${bucket.color} 16%, var(--color-raised))`
    : undefined}
>
  {#if bucket.iconType}
    <img
      src={getIconSvgDataUrl(bucket.iconType, color)}
      alt=""
      class="shrink-0 object-contain {size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'}"
      draggable="false"
    />
  {:else if bucket.color}
    <img
      src={generateInitialsIconSvg(bucket.name, color)}
      alt=""
      class="shrink-0 object-contain {size === 'xs' ? 'h-3 w-3' : 'h-3.5 w-3.5'}"
      draggable="false"
    />
  {/if}
  {bucket.name}
</code>
