<script lang="ts">
  import { Pin } from '@lucide/svelte'
  import { pickColorForSeed } from '$lib/project-colors'
  import type { ScopeBucket } from '$shared/types'

  interface Props {
    bucket: ScopeBucket
    size?: 'sm' | 'xs'
  }

  let { bucket, size = 'xs' }: Props = $props()

  /** Scopes are identified by colour only — no icons. The deterministic picked
   *  colour is the fallback when no explicit bucket colour is persisted. */
  let color = $derived(bucket.color ?? pickColorForSeed(bucket.id))
  /** Washed-out tint of the scope colour. */
  let wash = $derived(`color-mix(in srgb, ${color} 16%, var(--color-raised))`)
</script>

<code
  class="flex items-center gap-1 rounded-md bg-raised font-mono font-normal text-foreground {size ===
  'xs'
    ? 'px-1.5 py-0.5 text-[0.625rem]'
    : 'px-2.5 py-1 text-xs'}"
  style:background-color={wash}
>
  {#if bucket.pinned}
    <span
      class="shrink-0 text-accent"
      role="img"
      aria-label="Pinned scope: threads never auto-clean and do not count toward the thread limit"
      title="Pinned scope: threads never auto-clean and do not count toward the thread limit"
    >
      <Pin size={size === 'xs' ? 9 : 11} />
    </span>
  {/if}
  <span class="min-w-0 max-w-40 truncate">{bucket.name}</span>
</code>
