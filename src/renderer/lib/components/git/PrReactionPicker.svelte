<script lang="ts">
  /**
   * The "add a reaction" control for one comment: GitHub's own eight reactions,
   * with the ones the reader already used lit up.
   *
   * It sits in the comment's header rather than under its body, because a
   * comment nobody has reacted to should not spend a line of the conversation on
   * the invitation. The chips themselves appear under the body once a reaction
   * exists, which is where a reader looks to see who agreed.
   */
  import { SmilePlus } from '@lucide/svelte'
  import { Popover } from 'bits-ui'
  import { gitState } from '$lib/stores/git.svelte'
  import { prReactionBusyKey } from '$lib/stores/git-store-helpers'
  import type { PrReactionContent, PrReactionGroup } from '$shared/types'
  import { reactionOptions } from './pr-reactions'

  interface Props {
    /** The comment being reacted to, as its GraphQL node id. */
    nodeId: string
    groups: PrReactionGroup[]
    /** React with this emoji, or take the reader's own reaction back. */
    onToggle: (content: PrReactionContent, add: boolean) => void
  }

  let { nodeId, groups, onToggle }: Props = $props()

  let open = $state(false)
  /** The reactions this reader already holds, so a click takes them back. */
  const mine = $derived(
    new Set(groups.filter((group) => group.viewerHasReacted).map((group) => group.content))
  )

  function busy(content: PrReactionContent): boolean {
    return gitState.isBusy(prReactionBusyKey(nodeId, content))
  }

  function choose(content: PrReactionContent): void {
    open = false
    onToggle(content, !mine.has(content))
  }
</script>

<Popover.Root bind:open>
  <Popover.Trigger
    class="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-dimmed hover:bg-overlay hover:text-foreground data-[state=open]:bg-overlay data-[state=open]:text-foreground"
    aria-label="Add a reaction"
    title="Add a reaction"
  >
    <SmilePlus size={13} />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      class="z-50 flex items-center gap-0.5 rounded-lg border border-border bg-surface p-1 shadow-xl"
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      role="dialog"
      aria-label="Add a reaction"
      tabindex={-1}
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      {#each reactionOptions() as option (option.content)}
        <button
          type="button"
          class="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-base leading-none transition-colors hover:bg-elevated disabled:opacity-50 {mine.has(
            option.content
          )
            ? 'bg-primary/10'
            : ''}"
          title={mine.has(option.content)
            ? `Remove your ${option.label} reaction`
            : `React with ${option.label}`}
          aria-label={mine.has(option.content)
            ? `Remove your ${option.label} reaction`
            : `React with ${option.label}`}
          disabled={busy(option.content)}
          onclick={() => choose(option.content)}
        >
          <span aria-hidden="true">{option.emoji}</span>
        </button>
      {/each}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>
