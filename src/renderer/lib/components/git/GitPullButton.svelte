<script lang="ts">
  /**
   * The Pull control: one button that pulls, split at its right edge into the
   * strategies it can pull with.
   *
   * The left half is the action the saved default describes; the right edge
   * opens the three strategies, so a user who wants a different reconciliation
   * once does not have to go through Settings. Picking one also saves it as the
   * default, which is why the row marks the saved one: what the menu shows and
   * what the wide half will do are never a surprise.
   */
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import { DropdownMenu } from 'bits-ui'
  import type { GitPullPreference, GitPullStrategy } from '$shared/types'
  import { PULL_STRATEGY_OPTIONS, pullStrategyLabel } from './git-pull-copy'

  interface Props {
    /** Commits waiting on the remote, from the last fetch. */
    behind: number
    /** A pull is in flight, so the wide half reports the wait. */
    busy: boolean
    /** Another remote action is running, so neither half may start one. */
    blocked: boolean
    /** The strategy the wide half pulls with, and the one the menu marks. */
    preference: GitPullPreference
    /** Start a pull with the saved preference. */
    onPull: () => void
    /** Start a pull with this strategy, which also becomes the saved preference. */
    onPullWith: (strategy: GitPullStrategy) => void
    /** Save `ask`, so the next pull opens the chooser again. */
    onAskEveryPull: () => void
  }

  let { behind, busy, blocked, preference, onPull, onPullWith, onAskEveryPull }: Props = $props()

  /** The strategy the wide half uses when no `ask` preference is saved. */
  const savedStrategy = $derived<GitPullStrategy | null>(preference === 'ask' ? null : preference)

  const label = $derived(`Pull ${String(behind)} commit${behind === 1 ? '' : 's'} from the remote`)
  const description = $derived(
    savedStrategy
      ? `${label} with ${pullStrategyLabel(savedStrategy).toLowerCase()}`
      : `${label}; you will pick a strategy`
  )

  const itemClass =
    'flex cursor-pointer items-center gap-2 px-3 py-1.5 text-[0.6875rem] text-foreground outline-none data-highlighted:bg-elevated'
</script>

<!--
  The two halves are one control: they share a height, a surface and no gap, and
  the split is a single divider at the right edge. The menu is wider than its
  trigger on purpose, so the strategies are readable while the button stays
  inside the row it shares with Push.
-->
<div class="flex h-6 min-w-0 flex-1 items-stretch">
  <button
    type="button"
    class="flex h-6 min-w-0 flex-1 items-center justify-center gap-1 bg-elevated px-1.5 text-[0.625rem] font-medium text-foreground transition-colors hover:bg-raised disabled:cursor-default disabled:opacity-40"
    title={description}
    disabled={blocked}
    onclick={onPull}
  >
    {#if busy}
      <CioSpinner size={11} class="animate-spin" aria-hidden="true" />
    {:else}
      <CioDownload size={11} aria-hidden="true" />
    {/if}
    <span class="min-w-0 truncate">Pull {behind}</span>
  </button>
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="flex h-6 w-5 shrink-0 cursor-pointer items-center justify-center border-l border-border bg-elevated text-dimmed transition-colors hover:bg-raised hover:text-foreground disabled:cursor-default disabled:opacity-40 data-[state=open]:bg-raised"
      title="Pull with another strategy, saved as your default"
      aria-label="Pull with another strategy, saved as your default"
      disabled={blocked}
    >
      <CioChevronDown size={10} aria-hidden="true" />
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content
        side="bottom"
        align="end"
        sideOffset={4}
        collisionPadding={8}
        class="z-50 w-64 overflow-hidden border border-border bg-surface py-1 shadow-xl"
      >
        <p class="px-3 pb-1 pt-1.5 text-[0.5625rem] font-medium text-dimmed">
          Pull with, and remember it
        </p>
        {#each PULL_STRATEGY_OPTIONS as option (option.value)}
          {@const current = option.value === savedStrategy}
          <DropdownMenu.Item class={itemClass} onSelect={() => onPullWith(option.value)}>
            <span class="flex min-w-0 flex-1 flex-col">
              <span class="truncate">{option.label}</span>
              <span class="truncate text-[0.5625rem] text-dimmed" title={option.note}>
                {option.note}
              </span>
            </span>
            {#if current}
              <CioCheck size={11} class="shrink-0 text-primary" aria-hidden="true" />
              <span class="sr-only">Your saved default</span>
            {/if}
          </DropdownMenu.Item>
        {/each}
        <DropdownMenu.Separator class="my-1 h-px bg-border" />
        <!--
          The preference is always one of four states, so the menu marks one of
          them even when nothing is saved: a chooser every pull is a choice, not
          the absence of one.
        -->
        <DropdownMenu.Item class={itemClass} onSelect={onAskEveryPull}>
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="truncate">Ask every time</span>
            <span class="truncate text-[0.5625rem] text-dimmed">
              The same preference Settings offers: choose the strategy as you pull.
            </span>
          </span>
          {#if preference === 'ask'}
            <CioCheck size={11} class="shrink-0 text-primary" aria-hidden="true" />
            <span class="sr-only">Your saved default</span>
          {/if}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
</div>
