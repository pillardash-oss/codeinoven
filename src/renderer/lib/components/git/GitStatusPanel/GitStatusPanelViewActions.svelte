<script lang="ts">
  import CioArchive from '@pdslng/cio-icon/CioArchive.svelte'
  import CioBellOff from '@pdslng/cio-icon/CioBellOff.svelte'
  import CioBookmark from '@pdslng/cio-icon/CioBookmark.svelte'
  import CioBookmarkCheck from '@pdslng/cio-icon/CioBookmarkCheck.svelte'
  import CioCheckCheck from '@pdslng/cio-icon/CioCheckCheck.svelte'
  import CioCommit from '@pdslng/cio-icon/CioCommit.svelte'
  import CioExternalLink from '@pdslng/cio-icon/CioExternalLink.svelte'
  import CioFolderGit from '@pdslng/cio-icon/CioFolderGit.svelte'
  import CioGitGraph from '@pdslng/cio-icon/CioGitGraph.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioPlus from '@pdslng/cio-icon/CioPlus.svelte'
  import CioPullRequest from '@pdslng/cio-icon/CioPullRequest.svelte'
  import CioTabSettings from '@pdslng/cio-icon/CioTabSettings.svelte'
  import { githubNotificationSettingsUrl } from '$lib/github-references'
  import { openInBrowser } from '$lib/open-in-browser'
  import { gitState } from '$lib/stores/git.svelte'
  import { githubNotifications } from '$lib/stores/github-notifications.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import type { GitPanelTabId } from '$lib/stores/git-panel-view.svelte'
  import type { GitCommitInfo, GitHubNotification, PullRequestSummary } from '$shared/types'

  interface Props {
    activeTab: GitPanelTabId
    selectedCommit: GitCommitInfo | null
    isHeadCommit: boolean
    changesView: 'list' | 'tree'
    onRequestCreateBranch: () => void
    selectedPullRequest: PullRequestSummary | null
    deploymentsExternal: { url: string; title: string } | null
    openNotification: GitHubNotification | null
    notificationActionClass: string
    notificationBusy: boolean
    githubConnected: boolean
    projectId: string
    threadId: string
    scopeBucketId: string
    startAmend: () => void
    openPullRequestFullscreen: (pr: PullRequestSummary | null) => void
  }

  let {
    activeTab,
    selectedCommit,
    isHeadCommit,
    changesView = $bindable(),
    onRequestCreateBranch,
    selectedPullRequest,
    deploymentsExternal,
    openNotification,
    notificationActionClass,
    notificationBusy,
    githubConnected,
    projectId,
    threadId,
    scopeBucketId,
    startAmend,
    openPullRequestFullscreen
  }: Props = $props()
</script>

{#if activeTab === 'changes'}
  {@render changesViewToggle()}
  {#if selectedCommit && isHeadCommit}
    <button
      type="button"
      class="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
      title="Amend the latest commit message"
      aria-label="Amend the latest commit message"
      disabled={gitState.isBusy('reset') || gitState.isBusy('amend')}
      onclick={startAmend}
    >
      <CioGitGraph size={12} aria-hidden="true" />
      <span class="view-action-label">Amend</span>
    </button>
  {/if}
{:else if activeTab === 'branches'}
  <button
    type="button"
    class="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
    title="Create a branch from the current one"
    aria-label="Create a branch from the current one"
    onclick={onRequestCreateBranch}
  >
    <CioPlus size={12} aria-hidden="true" />
    <span class="view-action-label">New branch</span>
  </button>
{:else if activeTab === 'pulls'}
  {#if selectedPullRequest}
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Open this pull request in the full screen reader"
      aria-label="Open this pull request in the full screen reader"
      onclick={() => openPullRequestFullscreen(selectedPullRequest)}
    >
      <CioMaximize size={12} aria-hidden="true" />
    </button>
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Open this pull request on GitHub"
      aria-label="Open this pull request on GitHub"
      data-external-url={selectedPullRequest?.url ?? ''}
      onclick={() => void openInBrowser(selectedPullRequest?.url ?? '')}
    >
      <CioExternalLink size={12} aria-hidden="true" />
    </button>
  {:else}
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Open the pull request list in the full screen reader"
      aria-label="Open the pull request list in the full screen reader"
      onclick={() => openPullRequestFullscreen(null)}
    >
      <CioMaximize size={12} aria-hidden="true" />
    </button>
    <button
      type="button"
      class="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground"
      title="Create a pull request"
      aria-label="Create a pull request"
      onclick={() => prLifecycleStore.open(projectId, threadId, scopeBucketId)}
    >
      <CioPullRequest size={12} aria-hidden="true" />
      <span class="view-action-label">New PR</span>
    </button>
  {/if}
{:else if activeTab === 'deployments' && deploymentsExternal}
  <button
    type="button"
    class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
    title={deploymentsExternal.title}
    aria-label={deploymentsExternal.title}
    data-external-url={deploymentsExternal.url}
    onclick={() => void openInBrowser(deploymentsExternal.url)}
  >
    <CioExternalLink size={12} aria-hidden="true" />
  </button>
{:else if activeTab === 'notifications'}
  {#if openNotification}
    <!--
      The actions the notification itself offers, in the header's action group
      where every other view keeps its own. Opening a notification marks it
      read, which is what github.com does too, so there is no read action here:
      there would be nothing left for it to do by the time it could be pressed.
    -->
    <button
      type="button"
      class={notificationActionClass}
      title={openNotification.done ? 'Restore to inbox' : 'Mark as done'}
      aria-label={openNotification.done
        ? 'Restore notification to inbox'
        : 'Mark notification as done'}
      disabled={notificationBusy}
      onclick={() => void githubNotifications.setDone(openNotification.id, !openNotification?.done)}
    >
      {#if openNotification.done}
        <CioArchive size={12} aria-hidden="true" />
      {:else}
        <CioArchive size={12} aria-hidden="true" />
      {/if}
    </button>
    <button
      type="button"
      class={notificationActionClass}
      title="Unsubscribe from this thread"
      aria-label="Unsubscribe from this notification thread"
      disabled={notificationBusy}
      onclick={() => void githubNotifications.unsubscribe(openNotification.id)}
    >
      <CioBellOff size={12} aria-hidden="true" />
    </button>
    <button
      type="button"
      class={notificationActionClass}
      title={openNotification.saved ? 'Remove from saved' : 'Save notification'}
      aria-label={openNotification.saved ? 'Remove notification from saved' : 'Save notification'}
      disabled={notificationBusy}
      onclick={() =>
        void githubNotifications.setSaved(openNotification.id, !openNotification?.saved)}
    >
      {#if openNotification.saved}
        <CioBookmarkCheck size={12} class="text-primary" aria-hidden="true" />
      {:else}
        <CioBookmark size={12} aria-hidden="true" />
      {/if}
    </button>
    <button
      type="button"
      class={notificationActionClass}
      title="Open on GitHub"
      aria-label="Open notification on GitHub"
      data-external-url={openNotification.url ?? ''}
      onclick={() => void openInBrowser(openNotification?.url ?? '')}
    >
      <CioExternalLink size={12} aria-hidden="true" />
    </button>
  {:else}
    <button
      type="button"
      class="flex h-6 shrink-0 items-center gap-1 px-1.5 text-[0.625rem] font-medium text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-default disabled:opacity-40"
      title="Mark all notifications as read"
      aria-label="Mark all notifications as read"
      disabled={!githubConnected ||
        githubNotifications.tab !== 'inbox' ||
        githubNotifications.busyThreadId !== null}
      onclick={() => void githubNotifications.markAllRead()}
    >
      <CioCheckCheck size={12} aria-hidden="true" />
      <span class="view-action-label">Mark all read</span>
    </button>
    <button
      type="button"
      class="flex h-6 w-6 shrink-0 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
      title="Open GitHub notification settings"
      aria-label="Open GitHub notification settings"
      data-external-url={githubNotificationSettingsUrl()}
      onclick={() => void openInBrowser(githubNotificationSettingsUrl())}
    >
      <CioTabSettings size={12} aria-hidden="true" />
    </button>
  {/if}
{/if}

{#snippet changesViewToggle()}
  <div
    class="flex shrink-0 items-center gap-0.5 border border-border bg-elevated p-0.5"
    role="tablist"
    aria-label="Changed files layout"
  >
    <button
      type="button"
      class={[
        'flex h-5 shrink-0 items-center gap-1 px-1.5 text-[0.625rem] font-medium transition-colors',
        changesView === 'list'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'
      ]}
      role="tab"
      aria-selected={changesView === 'list'}
      title="Show the changed files as a flat list"
      aria-label="Show the changed files as a flat list"
      onclick={() => (changesView = 'list')}
    >
      <CioCommit size={12} aria-hidden="true" />
      <span class="view-action-label">List</span>
    </button>
    <button
      type="button"
      class={[
        'flex h-5 shrink-0 items-center gap-1 px-1.5 text-[0.625rem] font-medium transition-colors',
        changesView === 'tree'
          ? 'bg-surface text-foreground shadow-sm'
          : 'text-muted hover:text-foreground'
      ]}
      role="tab"
      aria-selected={changesView === 'tree'}
      title="Show the changed files as a folder tree"
      aria-label="Show the changed files as a folder tree"
      onclick={() => (changesView = 'tree')}
    >
      <CioFolderGit size={12} aria-hidden="true" />
      <span class="view-action-label">Tree</span>
    </button>
  </div>
{/snippet}

<style>
  @container git-header (max-width: 520px) {
    .view-action-label {
      display: none;
    }
  }
</style>
