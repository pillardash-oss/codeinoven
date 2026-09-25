<script lang="ts">
  import { ChevronDown, GitCompareArrows, GitPullRequestArrow, Loader2 } from '@lucide/svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { GitSyncDirection } from '$shared/types'

  interface Props {
    /** A sync operation is in flight, so the button reports the wait. */
    busy: boolean
    /** Another remote operation is running, or the worktree has conflicts to resolve first. */
    blocked: boolean
    /** Start the main-branch flow, which knows both ends already. */
    onSync: (direction: GitSyncDirection) => void
    /** Open the peer chooser, for any other checkout or branch in the project. */
    onPickPeer: (direction: GitSyncDirection) => void
  }

  let { busy, blocked, onSync, onPickPeer }: Props = $props()

  const itemClass =
    'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated data-disabled:pointer-events-none data-disabled:opacity-40'
</script>

<!--
  Sync is one job seen from two sides, whatever the other end is, so every
  direction lives in one menu. The two "main" entries stay separate because they
  are the common case and need no chooser; the other two open the peer chooser
  for any worktree or branch the project has.

  The Git panel renders this only for a managed worktree scope, so "main" here is
  always the project root, a different checkout: from the project root itself
  "sync with main" would be a sync with this very checkout.
-->
<DropdownMenu.Root>
  <DropdownMenu.Trigger
    class="flex h-6 shrink-0 items-center gap-1 rounded-sm bg-elevated px-1.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-raised disabled:cursor-default disabled:opacity-40 data-[state=open]:bg-raised"
    disabled={blocked}
    title="Sync this checkout with another branch or worktree"
    aria-label="Sync this checkout with another branch or worktree"
  >
    {#if busy}
      <Loader2 size={11} class="animate-spin" aria-hidden="true" />
    {:else}
      <GitCompareArrows size={11} aria-hidden="true" />
    {/if}
    <span class="sync-label">Sync</span>
    <ChevronDown size={10} class="shrink-0 text-dimmed" aria-hidden="true" />
  </DropdownMenu.Trigger>
  <DropdownMenu.Portal>
    <DropdownMenu.Content
      side="bottom"
      align="end"
      sideOffset={4}
      collisionPadding={8}
      class="z-50 w-60 overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-xl"
    >
      <DropdownMenu.Item class={itemClass} disabled={blocked} onSelect={() => onSync('from')}>
        <GitCompareArrows size={12} class="shrink-0 text-dimmed" aria-hidden="true" />
        Sync from main
      </DropdownMenu.Item>
      <DropdownMenu.Item class={itemClass} disabled={blocked} onSelect={() => onSync('to')}>
        <GitPullRequestArrow size={12} class="shrink-0 text-dimmed" aria-hidden="true" />
        Sync to main
      </DropdownMenu.Item>
      <DropdownMenu.Separator class="my-1 h-px bg-border" />
      <DropdownMenu.Item class={itemClass} disabled={blocked} onSelect={() => onPickPeer('from')}>
        <GitPullRequestArrow size={12} class="shrink-0 text-dimmed" aria-hidden="true" />
        Sync from branch…
      </DropdownMenu.Item>
      <DropdownMenu.Item class={itemClass} disabled={blocked} onSelect={() => onPickPeer('to')}>
        <GitPullRequestArrow size={12} class="shrink-0 text-dimmed" aria-hidden="true" />
        Sync to branch…
      </DropdownMenu.Item>
    </DropdownMenu.Content>
  </DropdownMenu.Portal>
</DropdownMenu.Root>

<style>
  /*
    The Git panel's header row is the query container
    (`container: git-header / inline-size` in GitStatusPanel.svelte), and it
    declares the breakpoint its own view actions compress at. The word goes first
    here too: the glyph, the tooltip and the menu items all still say what this
    is, and the panel is at its narrowest exactly when the row has no room.
  */
  @container git-header (max-width: 520px) {
    .sync-label {
      display: none;
    }
  }
</style>
