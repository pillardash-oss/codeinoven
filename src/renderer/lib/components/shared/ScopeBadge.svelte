<script lang="ts">
  import { Pin } from '@lucide/svelte'
  import { pickColorForSeed } from '$lib/project-colors'
  import type { ScopeBucket } from '$shared/types'

  interface Props {
    /** Scope on the board. Omit it together with `name` only for a scope that
     *  does not exist yet, such as a worker worktree created at dispatch. */
    bucket?: ScopeBucket
    /** Label for a scope that is not on the board yet; also seeds its colour. */
    name?: string
    size?: 'sm' | 'xs'
    /**
     * `chip` is the standalone badge   a washed fill behind the label   for
     * dense lists. `mark` is the composer shoe's identity marker: the scope's
     * colour becomes a bar beside the label, because the shoe's card is the
     * only surface there and a scope must never read as a card inside a card.
     */
    variant?: 'chip' | 'mark'
  }

  let { bucket, name, size = 'xs', variant = 'chip' }: Props = $props()

  let label = $derived(bucket?.name ?? name ?? 'Scope')
  /** Scopes are identified by colour only   no icons. The deterministic picked
   *  colour is the fallback when no explicit bucket colour is persisted, and the
   *  only colour source for a scope that is not on the board yet. */
  let color = $derived(bucket?.color ?? pickColorForSeed(bucket?.id ?? label))
  /** Washed-out tint of the scope colour. */
  let wash = $derived(`color-mix(in srgb, ${color} 16%, var(--color-raised))`)
</script>

<!-- `min-w-0` is what lets the badge give up room: without it the badge keeps its
     min-content width, so a tight row pushes it out of its own box and over
     whatever follows (the composer shoe's project icon, for one). -->
{#if variant === 'mark'}
  <code class="flex min-w-0 items-center gap-1.5 font-mono font-normal text-foreground">
    <span class="h-3 w-0.5 shrink-0" style:background-color={color} aria-hidden="true"></span>
    {#if bucket?.pinned}
      <span
        class="shrink-0 text-accent"
        role="img"
        aria-label="Pinned scope: threads never auto-clean and do not count toward the thread limit"
        title="Pinned scope: threads never auto-clean and do not count toward the thread limit"
      >
        <Pin size={size === 'xs' ? 9 : 11} />
      </span>
    {/if}
    <span class="scope-badge-label min-w-0 max-w-40 truncate">{label}</span>
  </code>
{:else}
  <code
    class="flex min-w-0 items-center gap-1 rounded-md bg-raised font-mono font-normal text-foreground {size ===
    'xs'
      ? 'px-1.5 py-0.5 text-[0.625rem]'
      : 'px-2.5 py-1 text-xs'}"
    style:background-color={wash}
  >
    {#if bucket?.pinned}
      <span
        class="shrink-0 text-accent"
        role="img"
        aria-label="Pinned scope: threads never auto-clean and do not count toward the thread limit"
        title="Pinned scope: threads never auto-clean and do not count toward the thread limit"
      >
        <Pin size={size === 'xs' ? 9 : 11} />
      </span>
    {/if}
    <span class="scope-badge-label min-w-0 max-w-40 truncate">{label}</span>
  </code>
{/if}
