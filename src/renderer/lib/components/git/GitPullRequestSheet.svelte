<script lang="ts">
  import { gitState } from '$lib/stores/git.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import Switch from '../ui/Switch.svelte'
  import { APP_SLUG } from '$shared/brand'
  import type { PullRequestCompare, PullRequestReference } from '$shared/types'
  import {
    ArrowRight,
    CheckCircle2,
    CircleCheck,
    CircleSlash,
    ExternalLink,
    Eye,
    GitPullRequest,
    Loader2,
    TriangleAlert
  } from '@lucide/svelte'

  interface Props {
    projectId: string
    onClose: () => void
    /** Fired once a pull request is actually created, so the list can refresh. */
    onCreated?: () => void
    /** Fired from the success screen to open the created PR inside the git panel. */
    onView?: (created: {
      reference: PullRequestReference
      head: string
      base: string
      draft: boolean
    }) => void
  }

  let { projectId, onClose, onCreated, onView }: Props = $props()

  let originIdentity = $state<{ owner: string; repo: string } | null>(null)
  let title = $state('')
  let body = $state('')
  let head = $state('')
  let base = $state('')
  let draft = $state(false)
  /** Push committed local changes to the head branch so they land in the PR. */
  let pushLocal = $state(true)
  /** Commit staged files first, using the PR title as the commit message. */
  let commitLocal = $state(false)
  let result: PullRequestReference | null = $state(null)
  let originError = $state('')
  let compare = $state<PullRequestCompare | null>(null)
  let comparing = $state(false)
  let compareError = $state('')
  let compareSequence = 0
  /** True while the commit → push → create sequence runs. */
  let submitting = $state(false)
  /** Set when the push was rejected: shows the pull/rebase recovery panel. */
  let pushRejected = $state(false)
  /** Which recovery action is running ('merge' | 'rebase'), to disable buttons. */
  let recoverMode = $state<'merge' | 'rebase' | null>(null)
  /** True while the panel is collapsed into the bottom-right dock. */
  let minimized = $state(false)

  const branch = $derived(gitState.status?.branch ?? null)
  const branches = $derived(gitState.branches.map((b) => b.name))
  const creating = $derived(gitState.isBusy('pr-create'))
  const hasStagedChanges = $derived(
    (gitState.status?.changes ?? []).some(
      (change) => change.staged && change.status !== 'conflicted'
    )
  )
  const sameBranch = $derived(canonicalBranch(head) === canonicalBranch(base))
  const headIsCurrent = $derived(canonicalBranch(head) === canonicalBranch(branch ?? ''))
  const willCreateCommit = $derived(commitLocal && hasStagedChanges && headIsCurrent)
  const hasChangesToPublish = $derived(compare?.hasChanges === true || willCreateCommit)
  const headInfo = $derived(gitState.branches.find((candidate) => candidate.name === head) ?? null)

  /**
   * Whether the local head has commits the remote lacks — a push is only
   * meaningful (and only possible) when this is true. When the head already
   * exists on GitHub and the local copy is up to date (or behind it), pushing
   * would be a pointless non-fast-forward rejection, so creation skips it.
   */
  const hasUnpushedHeadCommits = $derived(
    willCreateCommit || headInfo === null || headInfo.remote === null || headInfo.ahead > 0
  )

  /** Local-only commits must be pushed before GitHub can create the PR. */
  const canCreate = $derived(
    Boolean(originIdentity) &&
      Boolean(head) &&
      Boolean(base) &&
      !sameBranch &&
      Boolean(title.trim()) &&
      hasChangesToPublish &&
      (compare?.source !== 'local' || pushLocal) &&
      !creating &&
      !submitting &&
      recoverMode === null
  )

  function canonicalBranch(value: string): string {
    return value
      .replace(/^refs\/remotes\/origin\//u, '')
      .replace(/^refs\/heads\//u, '')
      .replace(/^origin\//u, '')
  }

  async function loadOrigin(): Promise<void> {
    try {
      const project = await invoke('project:get', projectId)
      if (!project?.path) return
      const url = await invoke('repository:remoteOrigin', project.path)
      const identity = parseRemoteIdentity(url ?? '')
      originIdentity = identity
    } catch {
      originError = 'Could not resolve the repository remote'
    }
  }

  function parseRemoteIdentity(url: string): { owner: string; repo: string } | null {
    const match = /(?:github\.com[:/])([^/]+)\/([^/.]+)(?:\.git)?\/?$/u.exec(url.trim())
    if (!match) return null
    const owner = match[1] ?? ''
    const repo = match[2] ?? ''
    return owner && repo ? { owner, repo } : null
  }

  /** Compare head against base; a stale response from an earlier selection is dropped. */
  async function runCompare(): Promise<void> {
    if (!originIdentity || !head || !base || sameBranch) return
    const sequence = ++compareSequence
    comparing = true
    compareError = ''
    pushRejected = false
    try {
      const snapshot = await gitState.comparePullRequests(
        projectId,
        originIdentity.owner,
        originIdentity.repo,
        base,
        head
      )
      if (sequence !== compareSequence) return
      if (snapshot) {
        compare = snapshot
        // Local-only heads must be pushed (GitHub can't see them yet); remote
        // heads only need a push when the local copy is ahead of the remote.
        pushLocal = snapshot.source === 'local' || hasUnpushedHeadCommits
      } else {
        compare = null
        compareError = 'Could not compare these branches.'
      }
    } catch (reason) {
      if (sequence !== compareSequence) return
      compare = null
      compareError = reason instanceof Error ? reason.message : 'Could not compare these branches.'
    } finally {
      if (sequence === compareSequence) comparing = false
    }
  }

  async function createPullRequest(): Promise<void> {
    if (!originIdentity || !head || !base || !canCreate || submitting) return
    submitting = true
    try {
      // Decided up front: after the commit below, the refreshed status clears
      // staged changes, which would make hasUnpushedHeadCommits flip to false.
      const commitMade = willCreateCommit
      const shouldPush = pushLocal && (commitMade || hasUnpushedHeadCommits)
      // 1. Commit staged files first, using the PR title as the message.
      if (commitMade) {
        await gitState.commit(projectId, `commit: ${title.trim()}`)
        if (gitState.error) return
      }
      // 2. Push local commits only when the head actually has something the
      //    remote doesn't — when the branch already exists on GitHub (and the
      //    local copy is behind it, e.g. a remote-to-remote PR), there is
      //    nothing to push and GitHub builds the PR from the remote refs, so
      //    skipping the push avoids a spurious non-fast-forward rejection.
      if (shouldPush) {
        const hasUpstream =
          gitState.branches.find((candidate) => candidate.name === head)?.remote != null
        const pushed = await gitState.push(projectId, !hasUpstream, 'origin', head)
        if (pushed === 'rejected') {
          pushRejected = true
          return
        }
        if (pushed === 'failed') return
      }
      // 3. Create the pull request.
      await finishCreate()
    } finally {
      submitting = false
    }
  }

  async function finishCreate(): Promise<void> {
    if (!originIdentity || !head || !base) return
    const reference = await gitState.createPullRequest(projectId, {
      title: title.trim(),
      body: body.trim() || undefined,
      head,
      base,
      draft
    })
    if (reference) {
      result = reference
      onCreated?.()
    }
  }

  /**
   * Pull the remote into the local head (merge or rebase), then retry the push
   * and finish creating the PR once integration is clean. Conflicts hand over
   * to the conflict UI; the half-merged tree is never auto-pushed.
   */
  async function recoverPush(mode: 'merge' | 'rebase'): Promise<void> {
    if (!originIdentity || !head || !base || recoverMode) return
    pushRejected = false
    recoverMode = mode
    try {
      await gitState.pullIntegrate(projectId, 'origin', head, mode === 'rebase')
      if (gitState.error || gitState.conflicted.length > 0) return
      const hasUpstream =
        gitState.branches.find((candidate) => candidate.name === head)?.remote != null
      const pushed = await gitState.push(projectId, !hasUpstream, 'origin', head)
      if (pushed === 'rejected') {
        pushRejected = true
        return
      }
      if (pushed === 'failed') return
      await finishCreate()
    } finally {
      recoverMode = null
    }
  }

  async function openInBrowser(url: string): Promise<void> {
    // Only ever hand off https URLs from the provider to the system browser.
    if (!/^https:\/\//u.test(url)) return
    await invoke('shell:openExternal', url)
    onClose()
  }

  $effect(() => {
    void loadOrigin()
  })

  $effect(() => {
    if (originIdentity && branches.length > 0) {
      if (!head) head = branch ?? branches[0]
      if (!base) base = branches.includes('main') ? 'main' : branches[0]
    }
  })

  $effect(() => {
    if (sameBranch) {
      compare = null
      compareError = ''
      compareSequence++
      return
    }
    if (originIdentity && head && base) void runCompare()
  })
</script>

<DockableModal
  open
  title="New pull request"
  {minimized}
  closable={Boolean(result)}
  onMinimize={() => (minimized = true)}
  {onClose}
  onExpand={() => (minimized = false)}
  dragLabel="Drag to move the pull request panel"
  storageKey={`${APP_SLUG}.pullRequestSheet.v1`}
>
  {#snippet dock()}
    <button
      class="flex cursor-pointer items-center gap-1.5 rounded-xl border bg-surface px-3 py-2 shadow-xl transition-colors hover:bg-elevated"
      title="Show pull request creation"
      aria-label="Show pull request creation"
      onclick={() => (minimized = false)}
    >
      {#if result}
        <CheckCircle2 size={14} class="shrink-0 text-success" />
        <span class="text-[11px] font-medium">PR #{result.number} created</span>
      {:else if submitting}
        <Loader2 size={14} class="shrink-0 animate-spin text-info" />
        <span class="text-[11px] font-medium">Creating pull request…</span>
      {:else}
        <GitPullRequest size={14} class="shrink-0 text-dimmed" />
        <span class="text-[11px] font-medium">New pull request</span>
      {/if}
    </button>
  {/snippet}

  <div class="space-y-3">
    {#if originError}
      <p
        class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-[10px] leading-relaxed text-danger"
      >
        {originError}
      </p>
    {:else if !originIdentity}
      <p
        class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-1.5 text-[10px] leading-relaxed text-warning"
      >
        No GitHub remote (origin) is configured for this project. Add the repository remote in the
        app's project settings first.
      </p>
    {/if}

    {#if result}
      {@const pr = result}
      <div class="rounded-lg border border-success/30 bg-success/10 px-3 py-2">
        <p class="text-[11px] font-medium text-success">Pull request #{pr.number} created</p>
        <p class="mt-0.5 truncate text-[10px] text-muted">{pr.title}</p>
        <div class="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[10px] font-medium text-on-primary hover:bg-primary-hover"
            title="Open this pull request in the Git panel"
            onclick={() => {
              onClose()
              onView?.({ reference: pr, head, base, draft })
            }}
          >
            <Eye size={12} />
            View PR
          </button>
          <button
            type="button"
            class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-[10px] font-medium text-foreground transition-colors hover:bg-elevated"
            title="Open this pull request on GitHub"
            onclick={() => void openInBrowser(pr.url)}
          >
            <ExternalLink size={12} />
            Open in browser
          </button>
        </div>
      </div>
    {:else}
      <!-- Compare first, like GitHub: pick the branches, then write about the change. -->
      <div class="rounded-lg border border-border bg-surface p-2.5">
        <div class="flex items-end gap-2">
          <div class="min-w-0 flex-1">
            <label
              class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
              for="pr-head"
            >
              Head (from)
            </label>
            <select
              id="pr-head"
              class="h-8 w-full cursor-pointer rounded-lg border border-border bg-elevated px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary disabled:opacity-50"
              bind:value={head}
              disabled={branches.length === 0}
            >
              {#each branches as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
          </div>
          <ArrowRight size={14} class="mb-2.5 shrink-0 text-primary" />
          <div class="min-w-0 flex-1">
            <label
              class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
              for="pr-base"
            >
              Base (into)
            </label>
            <select
              id="pr-base"
              class="h-8 w-full cursor-pointer rounded-lg border border-border bg-elevated px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary disabled:opacity-50"
              bind:value={base}
              disabled={branches.length === 0}
            >
              {#each branches as name (name)}
                <option value={name}>{name}</option>
              {/each}
            </select>
          </div>
        </div>
        <div class="mt-2 flex min-h-4 items-center gap-1.5 text-[10px]">
          {#if sameBranch}
            <CircleSlash size={12} class="shrink-0 text-dimmed" />
            <span class="text-dimmed"
              >The head and base are the same branch — pick a different head.</span
            >
          {:else if comparing}
            <Loader2 size={12} class="shrink-0 animate-spin text-dimmed" />
            <span class="text-dimmed">Comparing {head} into {base}</span>
          {:else if compareError}
            <TriangleAlert size={12} class="shrink-0 text-warning" />
            <span class="text-warning">{compareError}</span>
          {:else if compare && !compare.hasChanges}
            {#if willCreateCommit}
              <CircleCheck size={12} class="shrink-0 text-success" />
              <span class="text-success">The staged changes will be committed and pushed.</span>
            {:else}
              <CircleSlash size={12} class="shrink-0 text-dimmed" />
              <span class="text-dimmed">There isn't anything to compare.</span>
            {/if}
          {:else if compare}
            <CircleCheck size={12} class="shrink-0 text-success" />
            <span class="text-success">
              {compare.source === 'local' ? 'Local commits will be pushed' : 'Able to merge'} —
              {compare.aheadBy} ahead · {compare.behindBy} behind ·
              {compare.totalCommits} commit{compare.totalCommits === 1 ? '' : 's'} ·
              {compare.filesChanged} file{compare.filesChanged === 1 ? '' : 's'} changed
            </span>
          {/if}
        </div>
      </div>

      <div>
        <label
          class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
          for="pr-title"
        >
          Title
        </label>
        <input
          id="pr-title"
          class="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="Summary of the change"
          bind:value={title}
        />
      </div>

      <div>
        <label
          class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
          for="pr-body"
        >
          Description
        </label>
        <textarea
          id="pr-body"
          class="min-h-20 w-full resize-y rounded-lg border border-border bg-elevated px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground outline-none placeholder:text-dimmed focus:border-primary"
          placeholder="What does this change do?"
          bind:value={body}></textarea>
      </div>

      <div class="space-y-3 rounded-lg border border-border bg-surface p-2.5">
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <span class="text-[10px] text-muted">Push local changes</span>
            <p class="text-[9px] leading-relaxed text-dimmed">
              Push committed changes to
              <span class="font-mono text-foreground">{head}</span> so they're included in this pull
              request.
              {#if compare?.source === 'local'}
                This is required because the compared commits are not on GitHub yet.
              {/if}
            </p>
          </div>
          <Switch
            checked={pushLocal}
            onchange={(value) => (pushLocal = value)}
            aria-label="Push local changes"
          />
        </div>
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <span class="text-[10px] text-muted">Commit local changes</span>
            <p class="text-[9px] leading-relaxed text-dimmed">
              {hasStagedChanges
                ? headIsCurrent
                  ? `Commit staged files as commit: ${title.trim() || 'Title'} before pushing.`
                  : `Check out ${head} before committing staged files to it.`
                : 'No staged files to commit right now.'}
            </p>
          </div>
          <Switch
            checked={commitLocal}
            onchange={(value) => (commitLocal = value)}
            disabled={!hasStagedChanges || !headIsCurrent}
            aria-label="Commit local changes"
          />
        </div>
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <span class="text-[10px] text-muted">Create as draft</span>
            <p class="text-[9px] leading-relaxed text-dimmed">
              Drafts can't be merged until they're marked ready.
            </p>
          </div>
          <Switch
            checked={draft}
            onchange={(value) => (draft = value)}
            aria-label="Create as draft"
          />
        </div>
      </div>
    {/if}

    {#if pushRejected && !result}
      <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
        <div class="flex items-start gap-2">
          <TriangleAlert size={13} class="mt-0.5 shrink-0 text-warning" />
          <div class="min-w-0 flex-1">
            <p class="text-[10px] font-medium text-warning">Push blocked — branch has diverged</p>
            <p class="mt-0.5 text-[9px] leading-relaxed text-dimmed">
              The remote branch
              <span class="font-mono text-foreground">{head}</span> has commits you don't have locally,
              so Git won't let you push over them. Pull the remote changes in first — the pull request
              is created automatically afterwards.
            </p>
            {#if headIsCurrent}
              <div class="mt-2 flex items-center gap-1.5">
                <button
                  type="button"
                  class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-[10px] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
                  disabled={recoverMode !== null}
                  onclick={() => void recoverPush('rebase')}
                >
                  {#if recoverMode === 'rebase'}
                    <Loader2 size={11} class="animate-spin" />
                  {/if}
                  Rebase &amp; push
                </button>
                <button
                  type="button"
                  class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[10px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
                  disabled={recoverMode !== null}
                  onclick={() => void recoverPush('merge')}
                >
                  {#if recoverMode === 'merge'}
                    <Loader2 size={11} class="animate-spin" />
                  {/if}
                  Pull &amp; push
                </button>
              </div>
            {:else}
              <p class="mt-1 text-[9px] leading-relaxed text-dimmed">
                Check out <span class="font-mono text-foreground">{head}</span> first, then use Pull &amp;
                push to resolve this here.
              </p>
            {/if}
          </div>
        </div>
      </div>
    {/if}

    {#if gitState.error}
      <p
        class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-1.5 text-[10px] leading-relaxed text-danger"
      >
        {gitState.error}
      </p>
    {/if}
  </div>

  {#snippet footer()}
    {#if !result}
      <button
        type="button"
        class="cursor-pointer rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted hover:bg-elevated hover:text-foreground"
        onclick={onClose}
      >
        Cancel
      </button>
      <button
        type="button"
        class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
        disabled={!canCreate}
        title={!canCreate && compare?.source === 'local' && !pushLocal
          ? 'Push local changes to create this pull request'
          : !canCreate && compare !== null && !hasChangesToPublish
            ? 'There isn\u2019t anything to compare'
            : undefined}
        onclick={() => void createPullRequest()}
      >
        {#if creating || submitting}
          <Loader2 size={12} class="animate-spin" />
        {:else}
          <GitPullRequest size={12} />
        {/if}
        {submitting ? 'Creating pull request…' : 'Create pull request'}
      </button>
    {/if}
  {/snippet}
</DockableModal>
