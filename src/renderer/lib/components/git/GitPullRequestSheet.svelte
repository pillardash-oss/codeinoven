<script lang="ts">
  import { onDestroy } from 'svelte'
  import { DropdownMenu } from 'bits-ui'
  import { gitState } from '$lib/stores/git.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import Switch from '../ui/Switch.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { APP_SLUG } from '$shared/brand'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { modelKey } from '$lib/model-keys'
  import type {
    PullRequestCompare,
    PullRequestReference,
    ProviderCatalog,
    ThinkingLevel,
    ThreadSettings
  } from '$shared/types'
  import {
    ArrowRight,
    CheckCircle2,
    CircleCheck,
    CircleSlash,
    ExternalLink,
    Eye,
    GitPullRequest,
    Loader2,
    Sparkles,
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
    /** When provided, the docked state is owned by the global pr lifecycle store. */
    minimized?: boolean
    onMinimize?: () => void
    onExpand?: () => void
    /** Override the default localStorage key so multiple docked drafts don't collide. */
    storageKey?: string
  }

  let {
    projectId,
    onClose,
    onCreated,
    onView,
    minimized: minimizedProp,
    onMinimize: onMinimizeProp,
    onExpand: onExpandProp,
    storageKey: storageKeyProp
  }: Props = $props()

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
  /** True while the panel is collapsed into the bottom-right dock (local fallback). */
  let localMinimized = $state(false)
  const minimized = $derived(minimizedProp ?? localMinimized)

  function handleMinimize(): void {
    if (onMinimizeProp) onMinimizeProp()
    else localMinimized = true
  }

  function handleExpand(): void {
    if (onExpandProp) onExpandProp()
    else localMinimized = false
  }

  const effectiveStorageKey = $derived(storageKeyProp ?? `${APP_SLUG}.pullRequestSheet.v1`)

  // ─── Compose with agent ────────────────────────────────────────────────────
  /** True while the compose dropdown is open. */
  let composeOpen = $state(false)
  /** Phase of the compose flow, drives the dropdown's button label. */
  let composePhase = $state<'idle' | 'working' | 'complete' | 'recompose'>('idle')
  /** Model used for the compose agent — seeded from the last thread model. */
  let composeSettings = $state<ThreadSettings>({ ...threadSettings.lastUsed })
  /** Thread the compose prompt runs on (created lazily on first compose). */
  let composeThreadId = $state<string | null>(null)
  /** Directory where the compose agent writes its `compose.json`. */
  let composeDirectory = $state<string | null>(null)
  /** Branch selection the compose thread was created for — detects changes on recompose. */
  let composeHead = $state('')
  let composeBase = $state('')
  /** `updatedAt` of the last compose result we applied, so recompose waits for a fresh write. */
  let composeLastAppliedAt = $state(0)
  /** Latest compose error, shown inline in the dropdown. */
  let composeError = $state('')
  /** Timer that flips "Complete" → "Recompose" after a short pause. */
  let composeCompleteTimer: ReturnType<typeof setTimeout> | null = null
  /** Poller that waits for the agent's `compose.json` to appear. */
  let composePollTimer: ReturnType<typeof setInterval> | null = null

  const composeProviders = $derived<ProviderCatalog[]>(
    providerCatalog.cached(projectId) ?? providerCatalog.allCached()
  )

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
  /** An open PR for the exact head→base pair — GitHub rejects a duplicate with a 422. */
  const existingPr = $derived(compare?.existing ?? null)

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
      existingPr === null &&
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

  // ─── Compose with agent ────────────────────────────────────────────────────

  /** Extra context about local changes that will be pushed with the PR. */
  function localChangesContext(): string {
    const parts: string[] = []
    if (commitLocal && hasStagedChanges) {
      parts.push(
        'Staged local changes will be committed and pushed with this pull request, so include them in your summary.'
      )
    }
    if (pushLocal && hasUnpushedHeadCommits) {
      const ahead = headInfo?.ahead ?? 0
      parts.push(
        `The local \`${head}\` branch is ${ahead} commit${ahead === 1 ? '' : 's'} ahead of its remote and will be pushed with the PR, so cover those changes too.`
      )
    }
    return parts.join('\n')
  }

  function composePrompt(directory: string): string {
    const localChanges = localChangesContext()
    return [
      `Compose a pull request title and description for merging \`${head}\` into \`${base}\` in this repository.`,
      '',
      'Find the last set of commits on the head branch that are not yet part of the base branch:',
      `1. \`git fetch origin\``,
      `2. \`git log --oneline origin/${base}..origin/${head}\` (fall back to \`${base}..${head}\` if the refs are local-only).`,
      '',
      ...(localChanges ? [localChanges, ''] : []),
      'Then write a concise, human-readable pull request title (one line, imperative mood) and a',
      'description that summarizes what changed, why, and anything a reviewer should know. Do not',
      'overstate scope — only cover the changes in those commits.',
      '',
      `Write the result as JSON to \`${directory}/compose.json\` with exactly this shape:`,
      '{',
      '  "title": "The pull request title",',
      '  "description": "The pull request description"',
      '}',
      '',
      'Only write that file. Do not create the pull request, do not commit, and do not push.'
    ].join('\n')
  }

  function recomposePrompt(directory: string): string {
    const branchChanged = Boolean(
      composeHead && composeBase && (composeHead !== head || composeBase !== base)
    )
    const localChanges = localChangesContext()
    return [
      `The user is not satisfied with the composed title and description for merging \`${head}\` into \`${base}\`.`,
      ...(branchChanged
        ? [
            '',
            `The branch selection has changed since the previous compose — it was \`${composeHead}\` into \`${composeBase}\`.`,
            'Re-run the commit-range commands with the new branches so the summary matches them.'
          ]
        : []),
      ...(localChanges ? ['', localChanges] : []),
      '',
      'Improve on it: re-read the commit range, make the title sharper and the description',
      'clearer and more complete, then overwrite the JSON at',
      `\`${directory}/compose.json\` with the same shape.`,
      'Only write that file — do not create the pull request, commit, or push.'
    ].join('\n')
  }

  function clearComposeTimers(): void {
    if (composeCompleteTimer !== null) {
      clearTimeout(composeCompleteTimer)
      composeCompleteTimer = null
    }
    if (composePollTimer !== null) {
      clearInterval(composePollTimer)
      composePollTimer = null
    }
  }

  /** Apply a fresh compose report to the form (and, if the PR already exists, to GitHub). */
  async function applyComposeReport(report: {
    title: string
    description: string
    updatedAt: number | null
  }): Promise<void> {
    composeLastAppliedAt = report.updatedAt ?? Date.now()
    title = report.title
    body = report.description
    composeError = ''
    composePhase = 'complete'
    // If the PR was already created, push the improved title/description to
    // GitHub so the PR row and detail view reflect the recomposed content.
    if (result && originIdentity) {
      const updated = await gitState.updatePullRequest(
        projectId,
        originIdentity.owner,
        originIdentity.repo,
        result.number,
        report.title,
        report.description
      )
      if (updated) {
        result = { ...result, title: updated.title }
        onCreated?.()
      } else if (gitState.error) {
        composeError = gitState.error
      }
    }
    composeCompleteTimer = setTimeout(() => {
      composePhase = 'recompose'
      composeCompleteTimer = null
    }, 2000)
  }

  /** Poll for the agent's `compose.json` until a fresh result appears, then fill the form. */
  function pollForComposeResult(): void {
    clearComposeTimers()
    if (!composeThreadId) return
    const threadId = composeThreadId
    composePollTimer = setInterval(async () => {
      const report = await gitState.loadComposeReport(projectId, threadId)
      // Ignore the previous compose's file — recompose must wait for a NEWER
      // write so the loading state stays visible until the agent actually lands.
      if (!report || !report.title.trim()) return
      if (report.updatedAt !== null && report.updatedAt <= composeLastAppliedAt) return
      clearComposeTimers()
      await applyComposeReport(report)
    }, 1500)
  }

  /** Kick off the compose agent (or recompose on the same thread). */
  async function runCompose(): Promise<void> {
    if (!originIdentity || !head || !base || composePhase === 'working') return
    composeError = ''
    composePhase = 'working'
    try {
      const project = await invoke('project:get', projectId).catch(() => null)
      if (!project?.path) throw new Error('Could not resolve the project directory')

      if (!composeThreadId) {
        const thread = await invoke('thread:create', {
          projectId,
          providerId: composeSettings.harnessId,
          title: `Compose PR: ${head} → ${base}`,
          workingDirectory: project.path,
          settings: { ...composeSettings }
        }).catch(() => null)
        if (!thread) throw new Error('Could not create the compose thread')
        composeThreadId = thread.id
        composeDirectory = await gitState.createComposeWorkspace(projectId, thread.id)
        if (!composeDirectory) throw new Error('Could not prepare the compose workspace')
        composeHead = head
        composeBase = base
        composeLastAppliedAt = 0
        await threadMessages.send(
          projectId,
          thread.id,
          composeSettings,
          composePrompt(composeDirectory),
          [],
          undefined
        )
      } else {
        if (!composeDirectory) throw new Error('Compose workspace is missing')
        await threadMessages.send(
          projectId,
          composeThreadId,
          composeSettings,
          recomposePrompt(composeDirectory),
          [],
          undefined
        )
      }
      pollForComposeResult()
    } catch (reason) {
      composeError =
        reason instanceof Error ? reason.message : 'The compose agent could not be started'
      composePhase = 'idle'
    }
  }

  function chooseComposeModel(providerId: string, modelId: string, harnessId: string): void {
    composeSettings = {
      ...composeSettings,
      harnessId,
      providerId,
      modelId
    }
    threadSettings.commit(composeSettings)
  }

  function chooseComposeThinking(level: ThinkingLevel): void {
    composeSettings = {
      ...composeSettings,
      thinkingLevel: level
    }
    threadSettings.commit(composeSettings)
  }

  onDestroy(clearComposeTimers)

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
  onMinimize={handleMinimize}
  {onClose}
  onExpand={handleExpand}
  dragLabel="Drag to move the pull request panel"
  storageKey={effectiveStorageKey}
>
  {#snippet dock()}
    <button
      class="flex cursor-pointer items-center gap-1.5 rounded-xl border bg-surface px-3 py-2 shadow-xl transition-colors hover:bg-elevated"
      title="Show pull request creation"
      aria-label="Show pull request creation"
      onclick={handleExpand}
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

    {#if originIdentity && !sameBranch && head && base}
      <div class="flex items-center justify-between gap-2">
        <p class="text-[10px] text-muted">Let the agent draft the PR for you.</p>
        <DropdownMenu.Root bind:open={composeOpen}>
          <DropdownMenu.Trigger
            class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-[10px] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
            aria-label="Compose with agent"
            title="Compose the title and description with an agent"
            disabled={composePhase === 'working'}
          >
            {#if composePhase === 'working'}
              <Loader2 size={11} class="animate-spin" />
              <span>Composing…</span>
            {:else if composePhase === 'complete'}
              <CircleCheck size={11} class="text-success" />
              <span>Complete</span>
            {:else}
              <Sparkles size={11} />
              <span>{composePhase === 'recompose' ? 'Recompose' : 'Compose with agent'}</span>
            {/if}
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              side="bottom"
              align="end"
              sideOffset={6}
              collisionPadding={8}
              class="z-50 w-72 rounded-xl border border-border bg-surface p-2 shadow-xl"
            >
              <div class="space-y-1.5">
                <div>
                  <p
                    class="mb-1 px-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted"
                  >
                    Compose model
                  </p>
                  <ModelPicker
                    providers={composeProviders}
                    {projectId}
                    harnessId={composeSettings.harnessId}
                    providerId={composeSettings.providerId}
                    modelId={composeSettings.modelId}
                    favoriteModels={rendererRecovery.favoriteModels}
                    recentModels={rendererRecovery.recentModels}
                    side="top"
                    variant="action"
                    onSelect={chooseComposeModel}
                    thinkingLevel={composeSettings.thinkingLevel}
                    onSelectThinking={chooseComposeThinking}
                    onToggleFavorite={(providerId, modelId, harnessId) =>
                      rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
                    onReorderFavorite={(draggedKey, targetKey, position) =>
                      rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
                  />
                </div>
                {#if composeError}
                  <p
                    class="rounded-lg border border-danger/20 bg-danger/10 px-2 py-1 text-[9px] leading-relaxed text-danger"
                  >
                    {composeError}
                  </p>
                {/if}
                <button
                  type="button"
                  class="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
                  disabled={composePhase === 'working'}
                  onclick={() => void runCompose()}
                >
                  {#if composePhase === 'working'}
                    <Loader2 size={12} class="animate-spin" />
                    <span>Composing…</span>
                  {:else if composePhase === 'complete'}
                    <CircleCheck size={12} />
                    <span>Complete</span>
                  {:else}
                    <Sparkles size={12} />
                    <span>{composePhase === 'recompose' ? 'Recompose' : 'Compose'}</span>
                  {/if}
                </button>
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </div>
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
        {#if existingPr}
          <div class="mt-2 rounded-lg border border-warning/30 bg-warning/10 px-3 py-2">
            <div class="flex items-start gap-2">
              <TriangleAlert size={13} class="mt-0.5 shrink-0 text-warning" />
              <div class="min-w-0 flex-1">
                <p class="text-[10px] font-medium text-warning">
                  A pull request already exists for {head} into {base}
                </p>
                <p class="mt-0.5 text-[9px] leading-relaxed text-dimmed">
                  #{existingPr.number} — {existingPr.title} GitHub won't allow a second open PR for the
                  same branches, so creation is disabled.
                </p>
                <button
                  type="button"
                  class="mt-2 flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-[10px] font-medium text-foreground transition-colors hover:bg-elevated"
                  title="Open the existing pull request on GitHub"
                  onclick={() => void openInBrowser(existingPr.url)}
                >
                  <ExternalLink size={11} />
                  Open PR #{existingPr.number}
                </button>
              </div>
            </div>
          </div>
        {/if}
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
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void createPullRequest()
            }
          }}
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
          bind:value={body}
          onkeydown={(event: KeyboardEvent) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void createPullRequest()
            }
          }}></textarea>
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
        title={!canCreate && existingPr
          ? 'A pull request already exists for these branches'
          : !canCreate && compare?.source === 'local' && !pushLocal
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
