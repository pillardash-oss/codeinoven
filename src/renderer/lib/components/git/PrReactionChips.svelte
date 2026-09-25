<script lang="ts">
  /**
   * The reactions on one comment, as the chips a reader clicks.
   *
   * A chip is the reaction's own control: clicking one the reader already holds
   * takes it back, clicking one they do not adds it. That is GitHub's behaviour
   * and it is why a chip carries no separate remove affordance.
   *
   * Nothing renders when nobody has reacted: the picker in the comment's header
   * is where a reaction starts, and an empty row under every comment would cost
   * the conversation a line each for nothing.
   */
  import { Loader2 } from '@lucide/svelte'
  import { gitState } from '$lib/stores/git.svelte'
  import { prReactionBusyKey } from '$lib/stores/git-store-helpers'
  import type { PrReactionContent, PrReactionGroup } from '$shared/types'
  import { reactionOption, reactionTooltip } from './pr-reactions'

  interface Props {
    /** The comment these reactions belong to, as its GraphQL node id. */
    nodeId: string
    groups: PrReactionGroup[]
    /** React with this emoji, or take the reader's own reaction back. */
    onToggle: (content: PrReactionContent, add: boolean) => void
  }

  let { nodeId, groups, onToggle }: Props = $props()

  function busy(content: PrReactionContent): boolean {
    return gitState.isBusy(prReactionBusyKey(nodeId, content))
  }
</script>

{#if groups.length > 0}
  <div class="flex flex-wrap items-center gap-1 px-2.5 pb-2">
    {#each groups as group (group.content)}
      {@const option = reactionOption(group.content)}
      {@const label = option?.label ?? group.content}
      <button
        type="button"
        class="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full border px-2 text-[0.625rem] tabular-nums disabled:opacity-60 {group.viewerHasReacted
          ? 'border-primary/40 bg-primary/10 text-foreground'
          : 'border-border text-muted hover:bg-elevated hover:text-foreground'}"
        title={reactionTooltip(group, gitState.githubViewerLogin)}
        aria-label={group.viewerHasReacted
          ? `Remove your ${label} reaction, ${String(group.count)} in total`
          : `React with ${label}, ${String(group.count)} so far`}
        disabled={busy(group.content)}
        onclick={() => onToggle(group.content, !group.viewerHasReacted)}
      >
        <span aria-hidden="true">{option?.emoji ?? group.content}</span>
        {#if busy(group.content)}
          <Loader2 size={10} class="animate-spin" />
        {:else}
          <span>{group.count}</span>
        {/if}
      </button>
    {/each}
  </div>
{/if}
