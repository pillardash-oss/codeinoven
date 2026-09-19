<script lang="ts">
  import { GitFork, Loader2, Unplug } from '@lucide/svelte'
  import { gitState } from '$lib/stores/git.svelte'

  interface Props {
    repoState: 'loading' | 'git_unavailable' | 'not_git'
    preflightDetail: string
    onInitialize: () => void
  }

  let { repoState, preflightDetail, onInitialize }: Props = $props()
</script>

{#if repoState === 'loading'}
  <div class="flex items-center justify-center gap-2 py-10 text-xs text-dimmed">
    <Loader2 size={14} class="animate-spin" />
    Checking repository
  </div>
{:else if repoState === 'git_unavailable'}
  <div class="flex h-full flex-col items-center justify-center px-6 text-center">
    <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-elevated">
      <Unplug size={18} class="text-dimmed" />
    </div>
    <p class="text-xs font-medium text-muted">Git is not available</p>
    <p class="mt-1 max-w-[28ch] text-[0.625rem] leading-relaxed text-dimmed">
      Install Git for your operating system, then restart CodeInOven.
    </p>
    {#if preflightDetail}
      <p class="mt-2 max-w-[30ch] break-words font-mono text-[0.5625rem] text-dimmed">
        {preflightDetail}
      </p>
    {/if}
  </div>
{:else}
  <div class="flex h-full flex-col items-center justify-center px-6 text-center">
    <div class="mb-2 flex h-10 w-10 items-center justify-center rounded-full bg-elevated">
      <GitFork size={18} class="text-dimmed" />
    </div>
    <p class="text-xs font-medium text-muted">Not a Git repository</p>
    <p class="mt-1 max-w-[28ch] text-[0.625rem] leading-relaxed text-dimmed">
      Initialize a repository to track changes and manage pull requests.
    </p>
    <button
      type="button"
      class="mt-3 flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[0.6875rem] font-medium text-on-primary shadow-sm transition-colors hover:bg-primary-hover disabled:opacity-50"
      disabled={gitState.isBusy('init')}
      onclick={onInitialize}
    >
      {#if gitState.isBusy('init')}
        <Loader2 size={12} class="animate-spin" />
      {:else}
        <GitFork size={12} />
      {/if}
      Initialize repository
    </button>
  </div>
{/if}
