<script lang="ts">
  import { GitCommit, Loader2 } from '@lucide/svelte'
  import type { GitCommitInfo, GitStatus } from '$shared/types'
  import type { GitPanelTabId } from '$lib/stores/git-panel-view.svelte'

  interface Props {
    repoState: 'loading' | 'git_unavailable' | 'not_git' | 'git'
    status: GitStatus | null
    selectedCommit: GitCommitInfo | null
    activeTab: GitPanelTabId
    stagedCount: number
    amendMode: boolean
    mergeAwaitsCompletion: boolean
    commitBusy: boolean
    commitMessage: string
    commitSelection: boolean
    onCommitInline: () => void
    onCommitMessageKeydown: (event: KeyboardEvent) => void
  }

  let {
    repoState,
    status,
    selectedCommit,
    activeTab,
    stagedCount,
    amendMode = $bindable(),
    mergeAwaitsCompletion,
    commitBusy,
    commitMessage = $bindable(),
    commitSelection = $bindable(),
    onCommitInline,
    onCommitMessageKeydown
  }: Props = $props()

  let commitTextarea = $state<HTMLTextAreaElement | null>(null)

  $effect(() => {
    if (commitSelection) {
      commitTextarea?.focus()
      commitSelection = false
    }
  })
</script>

<!-- Pinned composer: only once something is staged (or an amend was started from History).
     It stands down while a merge awaits completion, so the panel offers one next step
     instead of two   the merge bar below carries the commit that finishes it. -->
{#if repoState === 'git' && status && !selectedCommit && activeTab === 'changes' && (stagedCount > 0 || amendMode) && !mergeAwaitsCompletion}
  <div class="shrink-0 border-t border-border bg-surface">
    {#if amendMode}
      <div class="flex items-center gap-2 border-b border-border bg-warning/10 px-3 py-1.5">
        <GitCommit size={11} class="shrink-0 text-warning" />
        <p class="min-w-0 flex-1 text-[0.5625rem] leading-relaxed text-warning">
          Amending the most recent commit no new commit will be created.
        </p>
        <button
          type="button"
          class="shrink-0 rounded px-1.5 py-0.5 text-[0.5625rem] font-medium text-muted hover:bg-elevated"
          onclick={() => (amendMode = false)}
        >
          Cancel
        </button>
      </div>
    {/if}
    <div class="px-2 pt-2">
      <textarea
        bind:this={commitTextarea}
        class="min-h-11 w-full resize-none rounded-md border border-border bg-elevated px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
        placeholder={amendMode ? 'Amended commit message…' : 'Commit message…'}
        bind:value={commitMessage}
        onkeydown={onCommitMessageKeydown}></textarea>
    </div>
    <div class="flex items-center gap-1.5 px-2 py-2">
      <span class="flex-1"></span>
      <button
        type="button"
        class="flex h-7 items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-semibold text-on-primary shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-40"
        disabled={!commitMessage.trim() || commitBusy || (!amendMode && stagedCount === 0)}
        onclick={onCommitInline}
      >
        {#if commitBusy}
          <Loader2 size={11} class="animate-spin" />
        {:else}
          <GitCommit size={11} />
        {/if}
        {amendMode ? 'Amend commit' : `Commit${stagedCount > 0 ? ` (${stagedCount})` : ''}`}
      </button>
    </div>
  </div>
{/if}
