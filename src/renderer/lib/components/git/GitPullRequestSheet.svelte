<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { DropdownMenu } from 'bits-ui'
  import { GitState } from '$lib/stores/git.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import DockableModal from '../ui/DockableModal.svelte'
  import Switch from '../ui/Switch.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import { APP_SLUG } from '$shared/brand'
  import { threadSettings } from '$lib/stores/thread-settings.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { prComposeAgentSettings } from '$lib/stores/pr-compose-agent-settings.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { modelKey } from '$lib/model-keys'
  import {
    prLifecycleStore,
    type PrDockDescriptor,
    type PrDockStatus
  } from '$lib/stores/pr-lifecycle.svelte'
  import { getProjectIcon } from '$lib/project-icons'
  import { DEFAULT_SCOPE_BUCKET_ID, isOrchestrationChildThread } from '$shared/types'
  import { DEFAULT_THINKING_LEVEL, resolveDefaultThinkingLevel } from '$shared/thinking-presets'
  import { baseUrlProviderStore } from '$lib/stores/base-url-providers.svelte'
  import type {
    Project,
    PrComposeInput,
    PullRequestCompare,
    PullRequestReference,
    PullRequestSummary,
    ProviderCatalog,
    Thread,
    ThinkingLevel,
    ThreadSettings
  } from '$shared/types'
  import {
    ArrowRight,
    Bot,
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
    scopeBucketId?: string
    onClose: () => void
    /** Fired once a pull request is actually created, so the list can refresh. */
    onCreated?: () => void
    /** Fired from the success screen to open the created PR inside the git panel. */
    onView?: (pullRequest: PullRequestSummary) => void
    /** When provided, the docked state is owned by the global pr lifecycle store. */
    minimized?: boolean
    onMinimize?: () => void
    onExpand?: () => void
    /** Override the default localStorage key so multiple docked drafts don't collide. */
    storageKey?: string
    /** Set by the host (`PrDockHost`) so the sheet can drive its own dock chip. */
    draftId?: string
  }

  interface PrCreationPreferences {
    head?: string
    base?: string
  }

  let {
    projectId,
    scopeBucketId = DEFAULT_SCOPE_BUCKET_ID,
    onClose,
    onCreated,
    onView,
    minimized: minimizedProp,
    onMinimize: onMinimizeProp,
    onExpand: onExpandProp,
    storageKey: storageKeyProp,
    draftId
  }: Props = $props()

  /** This draft owns its Git state; active-thread navigation cannot replace it. */
  const gitState = new GitState()

  function preferencesStorageKey(): string {
    return `${APP_SLUG}.pullRequestPreferences.${projectId}.${scopeBucketId}.v1`
  }

  function loadPrCreationPreferences(): PrCreationPreferences {
    if (typeof window === 'undefined') return {}
    try {
      const raw = window.localStorage.getItem(preferencesStorageKey())
      if (!raw) return {}
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
      const record = parsed as Record<string, unknown>
      return {
        ...(typeof record['head'] === 'string' ? { head: record['head'] } : {}),
        ...(typeof record['base'] === 'string' ? { base: record['base'] } : {})
      }
    } catch {
      return {}
    }
  }

  function persistPrCreationPreferences(update: PrCreationPreferences): void {
    if (typeof window === 'undefined') return
    try {
      const current = loadPrCreationPreferences()
      window.localStorage.setItem(
        preferencesStorageKey(),
        JSON.stringify({ ...current, ...update })
      )
    } catch {
      // Preference storage is a convenience; unavailable storage must not block PR creation.
    }
  }

  const initialPreferences = loadPrCreationPreferences()

  /** Project identity used for the header chip and the dock chip. */
  let projectMeta = $state<Project | null>(null)
  let projectIconUrl = $state<string | null>(null)
  const resolvedProjectIcon = $derived(
    projectMeta ? getProjectIcon(projectMeta, projectIconUrl ?? undefined) : null
  )
  let originIdentity = $state<{ owner: string; repo: string } | null>(null)
  let title = $state('')
  let body = $state('')
  let head = $state(initialPreferences.head ?? '')
  let base = $state(initialPreferences.base ?? '')
  let draft = $state(false)
  /** Push unpublished commits from the local head before creating the pull request. */
  let pushLocalCommits = $state(true)
  /** Commit staged and untracked files on the current head before creating the pull request. */
  let commitPendingFiles = $state(false)
  let result: PullRequestReference | null = $state(null)
  let originError = $state('')
  let compare = $state<PullRequestCompare | null>(null)
  let comparing = $state(false)
  let compareError = $state('')
  let compareSequence = 0
  let initialCompareStarted = false
  /** True while the commit → push → create sequence runs. */
  let submitting = $state(false)
  /** Set when the push was rejected: shows the pull/rebase recovery panel. */
  let pushRejected = $state(false)
  /** Git's output for the latest rejected push, available on demand in the recovery panel. */
  let pushErrorDetails = $state('')
  /** A failed commit, push, or PR creation owned by this submission attempt. */
  let createError = $state('')
  /** Which recovery action is running ('merge' | 'rebase'), to disable buttons. */
  let recoverMode = $state<'merge' | 'rebase' | null>(null)
  /** True while a prepared divergence-resolution thread is being opened. */
  let openingResolveThread = $state(false)
  let resolveThreadError = $state('')
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

  const effectiveStorageKey = $derived(
    storageKeyProp ? `${storageKeyProp}.tall-v2` : `${APP_SLUG}.pullRequestSheet.tall-v2`
  )

  // ─── Compose with agent ────────────────────────────────────────────────────
  /** True while the compose dropdown is open. */
  let composeOpen = $state(false)
  /** Phase of the compose flow, drives the dropdown's button label. */
  let composePhase = $state<'idle' | 'working' | 'complete' | 'recompose'>('idle')
  /** Latest compose error, shown inline in the dropdown. */
  let composeError = $state('')
  /** Timer that flips "Complete" → "Recompose" after a short pause. */
  let composeCompleteTimer: ReturnType<typeof setTimeout> | null = null

  const composeProviders = $derived<ProviderCatalog[]>(
    providerCatalog.cached(projectId) ?? providerCatalog.allCached()
  )

  const branch = $derived(gitState.status?.branch ?? null)
  const branches = $derived([
    ...new Set(
      gitState.branches
        .filter((candidate) => candidate.kind === 'local' || candidate.remote === 'origin')
        .map((candidate) => candidate.name)
    )
  ])
  const creating = $derived(gitState.isBusy('pr-create'))
  const committableChanges = $derived(
    (gitState.status?.changes ?? []).filter((change) => change.status !== 'conflicted')
  )
  const hasLocalWorktreeChanges = $derived(committableChanges.length > 0)
  const pendingCommitChanges = $derived(
    committableChanges.filter((change) => change.staged || change.status === 'untracked')
  )
  const hasPendingCommitChanges = $derived(pendingCommitChanges.length > 0)
  const sameBranch = $derived(canonicalBranch(head) === canonicalBranch(base))
  const headIsCurrent = $derived(canonicalBranch(head) === canonicalBranch(branch ?? ''))
  const willCreateCommit = $derived(commitPendingFiles && hasPendingCommitChanges && headIsCurrent)
  const hasChangesToPublish = $derived(compare?.hasChanges === true || willCreateCommit)
  const headInfo = $derived(
    gitState.branches.find((candidate) => candidate.kind === 'local' && candidate.name === head) ??
      gitState.branches.find(
        (candidate) => candidate.kind === 'remote' && candidate.name === head
      ) ??
      null
  )
  /** An open PR for the exact head→base pair — GitHub rejects a duplicate with a 422. */
  const existingPr = $derived(compare?.existing ?? null)
  const composeWorking = $derived(composePhase === 'working')
  const composeSucceeded = $derived(composePhase === 'complete' || composePhase === 'recompose')
  const dockHasIssue = $derived(
    Boolean(
      originError ||
      compareError ||
      composeError ||
      createError ||
      gitState.error ||
      pushRejected ||
      existingPr
    )
  )

  /** Live state reported to the host dock chip. */
  const dockStatus = $derived<PrDockStatus>(
    result
      ? 'created'
      : composeWorking || creating || submitting
        ? 'working'
        : dockHasIssue
          ? 'attention'
          : composeSucceeded
            ? 'composed'
            : 'draft'
  )
  function prDockTitle(pr: PullRequestReference | null, currentTitle: string): string {
    if (pr) return `PR #${pr.number}`
    const trimmed = currentTitle.trim()
    return trimmed.length > 0 ? trimmed : 'New pull request'
  }
  const dockTitle = $derived(prDockTitle(result, title))
  const dockProjectName = $derived(projectMeta?.name ?? '')

  // The sheet lives inside `PrDockHost`'s `{#each store.drafts}`, so writing the
  // store from a bare effect would re-render the host, re-run this effect and
  // write again — a read/write cycle. Reading back the current descriptor and
  // writing only when a field actually changed makes the sync idempotent.
  $effect(() => {
    if (!draftId) return
    const next: PrDockDescriptor = {
      projectName: dockProjectName,
      iconUrl: resolvedProjectIcon,
      status: dockStatus,
      title: dockTitle
    }
    const current = prLifecycleStore.dockFor(draftId)
    if (!current) return
    if (
      current.projectName === next.projectName &&
      current.iconUrl === next.iconUrl &&
      current.status === next.status &&
      current.title === next.title
    ) {
      return
    }
    prLifecycleStore.updateDock(draftId, next)
  })

  /**
   * Whether the local head has commits the remote lacks — a push is only
   * meaningful (and only possible) when this is true. When the head already
   * exists on GitHub and the local copy is up to date (or behind it), pushing
   * would be a pointless non-fast-forward rejection, so creation skips it.
   */
  const hasUnpushedHeadCommits = $derived(
    willCreateCommit ||
      (headInfo?.kind === 'local' && (headInfo.remote === null || headInfo.ahead > 0))
  )

  /** Local-only commits must be pushed before GitHub can create the PR. */
  const canCreate = $derived(
    Boolean(originIdentity) &&
      Boolean(head) &&
      Boolean(base) &&
      !sameBranch &&
      Boolean(title.trim()) &&
      hasChangesToPublish &&
      (compare?.source !== 'local' || pushLocalCommits) &&
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

  function uncategorizedCommitMessage(date: Date): string {
    const pad = (value: number): string => value.toString().padStart(2, '0')
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    return `Uncategorized commit ${day} ${time}`
  }

  function createdPullRequestSummary(reference: PullRequestReference): PullRequestSummary {
    const now = new Date().toISOString()
    return {
      ...reference,
      state: 'open',
      draft,
      authorLogin: '',
      headRef: head,
      baseRef: base,
      createdAt: now,
      updatedAt: now,
      comments: 0
    }
  }

  async function loadOrigin(): Promise<void> {
    try {
      const project = await invoke('project:get', projectId)
      if (!project?.path) return
      projectMeta = project
      if (project.icon) {
        const url = await invoke('project:getIcon', projectId).catch(() => null)
        projectIconUrl = url ?? null
      }
      await gitState.refresh(projectId)
      const url = gitState.remotes.find((remote) => remote.name === 'origin')?.url ?? null
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
    if (!originIdentity || !head || !base) return
    const sequence = ++compareSequence
    compare = null
    compareError = ''
    pushRejected = false
    pushErrorDetails = ''
    createError = ''
    if (sameBranch) {
      comparing = false
      return
    }
    comparing = true
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

  function changeHead(event: Event): void {
    const select = event.currentTarget
    if (!(select instanceof HTMLSelectElement) || select.value === head) return
    head = select.value
    void runCompare()
  }

  function changeBase(event: Event): void {
    const select = event.currentTarget
    if (!(select instanceof HTMLSelectElement) || select.value === base) return
    base = select.value
    void runCompare()
  }

  async function createPullRequest(): Promise<void> {
    if (!originIdentity || !head || !base || !canCreate || submitting) return
    // Submission owns the status area from this point. Invalidate an in-flight
    // comparison so a slow response cannot leave its spinner over a push error.
    compareSequence++
    comparing = false
    pushRejected = false
    pushErrorDetails = ''
    createError = ''
    submitting = true
    try {
      // Decided up front: after the commit below, the refreshed status clears
      // staged changes, which would make hasUnpushedHeadCommits flip to false.
      const commitMade = willCreateCommit
      const shouldPush =
        pushLocalCommits && headInfo?.kind === 'local' && (commitMade || hasUnpushedHeadCommits)
      // 1. Commit the current index plus untracked files, leaving unstaged edits alone.
      if (commitMade) {
        const untrackedPaths = pendingCommitChanges
          .filter((change) => change.status === 'untracked')
          .map((change) => change.path)
        if (untrackedPaths.length > 0) {
          await gitState.stage(projectId, [...new Set(untrackedPaths)])
          if (gitState.error) {
            createError = gitState.error
            return
          }
        }
        await gitState.commit(projectId, uncategorizedCommitMessage(new Date()))
        if (gitState.error) {
          createError = gitState.error
          return
        }
      }
      // 2. Push local commits only when the head actually has something the
      //    remote doesn't — when the branch already exists on GitHub (and the
      //    local copy is behind it, e.g. a remote-to-remote PR), there is
      //    nothing to push and GitHub builds the PR from the remote refs, so
      //    skipping the push avoids a spurious non-fast-forward rejection.
      if (shouldPush) {
        const hasUpstream = headInfo?.kind === 'local' && headInfo.remote === 'origin'
        const pushed = await gitState.push(projectId, !hasUpstream, 'origin', head)
        if (pushed.status === 'rejected') {
          pushRejected = true
          pushErrorDetails = pushed.message
          return
        }
        if (pushed.status === 'failed') {
          createError = pushed.message
          return
        }
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
      persistPrCreationPreferences({ head, base })
      result = reference
      onCreated?.()
    } else if (!gitState.githubPermission) {
      createError = gitState.error ?? 'GitHub did not create the pull request. Try again.'
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
    pushErrorDetails = ''
    createError = ''
    recoverMode = mode
    try {
      await gitState.pullIntegrate(projectId, 'origin', head, mode)
      if (gitState.error) {
        createError = gitState.error
        return
      }
      if (gitState.conflicted.length > 0) return
      const hasUpstream = headInfo?.kind === 'local' && headInfo.remote === 'origin'
      const pushed = await gitState.push(projectId, !hasUpstream, 'origin', head)
      if (pushed.status === 'rejected') {
        pushRejected = true
        pushErrorDetails = pushed.message
        return
      }
      if (pushed.status === 'failed') {
        createError = pushed.message
        return
      }
      await finishCreate()
    } finally {
      recoverMode = null
    }
  }

  function divergenceResolutionPrompt(): string {
    return [
      `Resolve the blocked pull request push for branch \`${head}\` into \`${base}\`.`,
      '',
      `The app reported that \`origin/${head}\` has commits missing from the local \`${head}\` branch, so a normal push was rejected.`,
      '',
      'Inspect the repository state and resolve the divergence safely:',
      `1. Check out \`${head}\` if it is not already active.`,
      `2. Fetch \`origin\` and compare \`${head}\` with \`origin/${head}\`.`,
      '3. Reconcile both histories without discarding local or remote commits and without force-pushing.',
      '4. Resolve any conflicts, run the relevant checks, and push the branch normally.',
      '',
      'Do not create the pull request. The draft remains open in the Git panel so the user can finish it there after the branch is synchronized.',
      'Explain what caused the divergence and what you changed.'
    ].join('\n')
  }

  /** Open a normal project thread with the blocked-push evidence prefilled. */
  async function resolveDivergenceWithAgent(): Promise<void> {
    if (!head || !base || openingResolveThread) return
    openingResolveThread = true
    resolveThreadError = ''
    try {
      const project = await invoke('project:get', projectId).catch(() => null)
      if (!project) throw new Error('Could not open this project for the agent')
      const settings = { ...threadSettings.lastUsed }
      const thread = await invoke('thread:create', {
        projectId,
        providerId: settings.harnessId,
        title: `Resolve diverged branch ${head}`,
        workingDirectory: project.path,
        settings
      }).catch(() => null)
      if (!thread) throw new Error('Could not create the resolution thread')
      rendererRecovery.setDraft(projectId, thread.id, divergenceResolutionPrompt(), [], [])
      workspaceState.openThread(thread, project)
      handleMinimize()
    } catch (reason) {
      resolveThreadError =
        reason instanceof Error ? reason.message : 'Could not open the resolution thread'
    } finally {
      openingResolveThread = false
    }
  }

  async function openInBrowser(url: string): Promise<void> {
    // Only ever hand off https URLs from the provider to the system browser.
    if (!/^https:\/\//u.test(url)) return
    await invoke('shell:openExternal', url)
    onClose()
  }

  async function openProjectFirstThread(): Promise<void> {
    if (!projectMeta) return
    const allThreads: Thread[] = await invoke('thread:listAll').catch(() => [])
    const firstThread = allThreads
      .filter((thread) => thread.projectId === projectId && !thread.archived)
      .filter((thread) => !isOrchestrationChildThread(thread))
      .sort((a, b) => b.lastActivity - a.lastActivity)[0]
    if (!firstThread) return
    workspaceState.openThread(firstThread, projectMeta, projectIconUrl)
  }

  // ─── Compose with agent ────────────────────────────────────────────────────

  function composeInput(recomposing: boolean): PrComposeInput {
    const includeWorkingTree = headIsCurrent && hasLocalWorktreeChanges
    const source: PrComposeInput['source'] =
      includeWorkingTree || hasUnpushedHeadCommits ? 'local' : (compare?.source ?? 'remote')
    return {
      base,
      head,
      source,
      includeWorkingTree,
      ...(recomposing ? { currentTitle: title, currentDescription: body } : {})
    }
  }

  function clearComposeTimers(): void {
    if (composeCompleteTimer !== null) {
      clearTimeout(composeCompleteTimer)
      composeCompleteTimer = null
    }
  }

  /** Apply a fresh compose report to the form (and, if the PR already exists, to GitHub). */
  async function applyComposeReport(report: { title: string; description: string }): Promise<void> {
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

  /**
   * PR copy is a direct virtual task and must never enter an Engineering
   * lifecycle. It is an ephemeral one-shot session, so it always runs in the
   * low-exposure `auto_review` permission mode regardless of what the last-used
   * or persisted thread-level permission was — never `full_access`.
   */
  function composeVirtualTaskSettings(): ThreadSettings | null {
    const selection = prComposeAgentSettings.selection
    if (!selection) return null
    return {
      harnessId: selection.harnessId,
      providerId: selection.providerId,
      modelId: selection.modelId,
      thinkingLevel: selection.thinkingLevel,
      inferenceMode: 'normal',
      permissionLevel: 'auto_review',
      engineeringMode: false,
      assignmentMode: false,
      loopMode: false,
      fileSystemMode: false
    }
  }

  /** Kick off a fresh disposable compose or recompose task. */
  async function runCompose(): Promise<void> {
    if (!originIdentity || !head || !base || composePhase === 'working') return
    const recomposing = composePhase === 'recompose'
    clearComposeTimers()
    composeError = ''
    composePhase = 'working'
    try {
      const settings = composeVirtualTaskSettings()
      if (!settings) throw new Error('Choose a model for Compose PR first')
      const virtualTaskId = crypto.randomUUID()
      const report = await gitState.composeWithAgent(
        projectId,
        virtualTaskId,
        settings,
        composeInput(recomposing)
      )
      if (!report) {
        throw new Error(gitState.error ?? 'The PR compose agent did not return a result')
      }
      await applyComposeReport(report)
    } catch (reason) {
      composeError =
        reason instanceof Error ? reason.message : 'The compose agent could not be started'
      composePhase = 'idle'
    }
  }

  function chooseComposeModel(providerId: string, modelId: string, harnessId: string): void {
    const provider = composeProviders.find(
      (candidate) => candidate.harnessId === harnessId && candidate.id === providerId
    )
    const model = provider?.models.find((candidate) => candidate.id === modelId)
    const thinkingLevel =
      resolveDefaultThinkingLevel(
        model?.thinkingPresets,
        baseUrlProviderStore.defaultThinkingLevel(harnessId, providerId, modelId),
        prComposeAgentSettings.selection?.thinkingLevel
      ) ??
      prComposeAgentSettings.selection?.thinkingLevel ??
      DEFAULT_THINKING_LEVEL
    prComposeAgentSettings.selectModel({
      harnessId,
      providerId,
      modelId,
      thinkingLevel
    })
    composeError = ''
  }

  function chooseComposeThinking(level: ThinkingLevel): void {
    prComposeAgentSettings.selectThinking(level)
  }

  onDestroy(clearComposeTimers)

  function initializeBranchSelection(): void {
    if (!originIdentity || branches.length === 0) return
    if (!head || !branches.includes(head)) {
      head = branch && branches.includes(branch) ? branch : branches[0]
    }
    if (!base || !branches.includes(base)) {
      base = branches.includes('main') ? 'main' : branches[0]
    }
    if (head && base && !initialCompareStarted) {
      initialCompareStarted = true
      void runCompare()
    }
  }

  onMount(() => {
    gitState.activate(projectId, scopeBucketId)
    void loadOrigin().then(initializeBranchSelection)
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
  defaultHeight={680}
>
  {#snippet headerPrefix()}
    {#if dockProjectName}
      <button
        class="flex min-w-0 max-w-48 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-elevated py-0.5 pr-2.5 pl-1 transition-colors hover:bg-overlay"
        title={`Open first thread in ${dockProjectName}`}
        aria-label={`Open first thread in ${dockProjectName}`}
        onclick={() => void openProjectFirstThread()}
      >
        {#if resolvedProjectIcon}
          <img src={resolvedProjectIcon} alt="" class="h-4 w-4 shrink-0 rounded" />
        {:else}
          <GitPullRequest size={13} class="shrink-0 text-dimmed" aria-hidden="true" />
        {/if}
        <span class="truncate text-[10px] font-semibold text-foreground">{dockProjectName}</span>
      </button>
    {/if}
  {/snippet}

  {#snippet dock()}
    {#if !draftId}
      <!-- When the host drives the dock, PrDockHost renders the unified chip row. -->
      <button
        class="flex cursor-pointer items-center gap-1.5 rounded-xl border bg-surface px-3 py-2 shadow-xl transition-colors hover:bg-elevated"
        title="Show pull request creation"
        aria-label="Show pull request creation"
        onclick={handleExpand}
      >
        {#if result}
          <span
            class="flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-semibold text-success"
          >
            <CheckCircle2 size={10} aria-hidden="true" />
            Created
          </span>
          <span class="text-[11px] font-medium">PR #{result.number}</span>
        {:else if composeWorking || creating || submitting}
          <Loader2 size={14} class="shrink-0 animate-spin text-info" />
          <span class="text-[11px] font-medium">
            {composeWorking ? 'Composing pull request…' : 'Creating pull request…'}
          </span>
        {:else if dockHasIssue}
          <span
            class="flex items-center gap-1 rounded-full bg-warning/15 px-1.5 py-0.5 text-[9px] font-semibold text-warning"
          >
            <TriangleAlert size={10} aria-hidden="true" />
            Needs attention
          </span>
          <span class="text-[11px] font-medium">New pull request</span>
        {:else if composeSucceeded}
          <span
            class="flex items-center gap-1 rounded-full bg-success/15 px-1.5 py-0.5 text-[9px] font-semibold text-success"
          >
            <CircleCheck size={10} aria-hidden="true" />
            Composed
          </span>
          <span class="text-[11px] font-medium">New pull request</span>
        {:else}
          <GitPullRequest size={14} class="shrink-0 text-dimmed" />
          <span class="text-[11px] font-medium">New pull request</span>
        {/if}
      </button>
    {/if}
  {/snippet}

  <div class={result ? 'flex min-h-full items-center justify-center' : 'space-y-3'}>
    {#if !result}
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
        <div class="space-y-1.5">
          {#if composeError}
            <p
              class="flex items-start gap-1.5 rounded-lg border border-warning/30 bg-warning/10 px-2.5 py-1.5 text-[9px] leading-relaxed text-warning"
              role="alert"
            >
              <TriangleAlert size={11} class="mt-0.5 shrink-0" aria-hidden="true" />
              <span>{composeError}</span>
            </p>
          {/if}
          <div class="flex items-center justify-between gap-2">
            <p class="text-[10px] text-muted">Let the agent draft the PR for you.</p>
            <DropdownMenu.Root bind:open={composeOpen}>
              <DropdownMenu.Trigger
                class="flex h-7 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-2.5 text-[10px] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
                aria-label={prComposeAgentSettings.selection
                  ? 'Compose with agent'
                  : 'Choose a model for Compose PR'}
                title={prComposeAgentSettings.selection
                  ? 'Compose the title and description with an agent'
                  : 'Choose the model Compose PR will reuse'}
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
                  <span>
                    {prComposeAgentSettings.selection
                      ? composePhase === 'recompose'
                        ? 'Recompose'
                        : 'Compose with agent'
                      : 'Choose compose model'}
                  </span>
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
                    {#if !prComposeAgentSettings.selection}
                      <p
                        class="rounded-lg border border-border bg-elevated px-2.5 py-2 text-[10px] leading-relaxed text-muted"
                      >
                        Choose a model for Compose PR. This choice is kept separate from every
                        thread and reused until you change it.
                      </p>
                    {/if}
                    <div>
                      <p
                        class="mb-1 px-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted"
                      >
                        Compose model
                      </p>
                      <ModelPicker
                        providers={composeProviders}
                        {projectId}
                        harnessId={prComposeAgentSettings.selection?.harnessId ?? ''}
                        providerId={prComposeAgentSettings.selection?.providerId ?? ''}
                        modelId={prComposeAgentSettings.selection?.modelId ?? ''}
                        label={prComposeAgentSettings.selection ? undefined : 'Choose a model'}
                        favoriteModels={rendererRecovery.favoriteModels}
                        recentModels={rendererRecovery.recentModels}
                        onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
                        side="top"
                        variant="action"
                        onSelect={chooseComposeModel}
                        thinkingLevel={prComposeAgentSettings.selection?.thinkingLevel ?? null}
                        onSelectThinking={chooseComposeThinking}
                        onToggleFavorite={(providerId, modelId, harnessId) =>
                          rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
                        onReorderFavorite={(draggedKey, targetKey, position) =>
                          rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
                      />
                    </div>
                    <button
                      type="button"
                      class="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:cursor-default disabled:opacity-50"
                      disabled={composePhase === 'working' || !prComposeAgentSettings.selection}
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
        </div>
      {/if}
    {/if}

    {#if result}
      {@const pr = result}
      <div
        class="w-full max-w-sm rounded-xl border border-success/30 bg-success/10 px-6 py-7 text-center"
      >
        <div
          class="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-success/15 text-success"
        >
          <CheckCircle2 size={24} aria-hidden="true" />
        </div>
        <p class="mt-3 text-sm font-semibold text-success">Pull request #{pr.number} created</p>
        <p class="mt-1 truncate text-[11px] text-muted">{pr.title}</p>
        <div class="mt-5 flex items-center justify-center gap-2">
          <button
            type="button"
            class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover"
            title="Open this pull request in the Git panel"
            onclick={() => {
              onClose()
              onView?.(createdPullRequestSummary(pr))
            }}
          >
            <Eye size={12} />
            View PR
          </button>
          <button
            type="button"
            class="flex h-8 cursor-pointer items-center gap-1.5 rounded-lg border border-border bg-surface px-3 text-[11px] font-medium text-foreground transition-colors hover:bg-elevated"
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
              value={head}
              disabled={branches.length === 0}
              onchange={changeHead}
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
              value={base}
              disabled={branches.length === 0}
              onchange={changeBase}
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
                  title="Open the existing pull request in the Git panel"
                  onclick={() => {
                    onClose()
                    onView?.(existingPr)
                  }}
                >
                  <Eye size={11} />
                  View PR #{existingPr.number}
                </button>
              </div>
            </div>
          </div>
        {/if}
      </div>

      {#if pushRejected}
        <div class="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2.5">
          <div class="flex items-start gap-2">
            <TriangleAlert size={14} class="mt-0.5 shrink-0 text-warning" />
            <div class="min-w-0 flex-1">
              <p class="text-[10px] font-semibold text-warning">
                Push blocked — branch has diverged
              </p>
              <p class="mt-0.5 text-[9px] leading-relaxed text-dimmed">
                The remote branch
                <span class="font-mono text-foreground">{head}</span> has commits you don't have locally,
                so Git won't let you push over them. Pull the remote changes in first — the pull request
                is created automatically afterwards.
              </p>
              {#if pushErrorDetails}
                <details class="mt-2 text-[9px] text-dimmed">
                  <summary class="cursor-pointer select-none font-medium text-foreground">
                    Show Git error
                  </summary>
                  <pre
                    class="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-elevated p-2 font-mono text-[9px] leading-relaxed text-danger">{pushErrorDetails}</pre>
                </details>
              {/if}
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
                  Check out <span class="font-mono text-foreground">{head}</span> first, then use Pull
                  &amp; push to resolve this here.
                </p>
              {/if}
            </div>
          </div>
          <div class="mt-2 border-t border-warning/20 pt-2">
            {#if resolveThreadError}
              <p class="mb-2 text-[9px] leading-relaxed text-danger">{resolveThreadError}</p>
            {/if}
            <button
              type="button"
              class="flex h-8 w-full cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-warning/40 bg-surface px-3 text-[10px] font-medium text-foreground transition-colors hover:bg-elevated disabled:cursor-default disabled:opacity-50"
              title="Open a new thread with this branch-divergence issue prefilled"
              disabled={openingResolveThread}
              onclick={() => void resolveDivergenceWithAgent()}
            >
              {#if openingResolveThread}
                <Loader2 size={12} class="animate-spin" />
              {:else}
                <Bot size={12} />
              {/if}
              Resolve with agent
            </button>
          </div>
        </div>
      {/if}

      {#if createError}
        <div class="rounded-lg border border-danger/20 bg-danger/10 px-3 py-2.5" role="alert">
          <div class="flex items-start gap-2">
            <TriangleAlert size={14} class="mt-0.5 shrink-0 text-danger" />
            <div class="min-w-0">
              <p class="text-[10px] font-semibold text-danger">Pull request was not created</p>
              <p
                class="mt-0.5 whitespace-pre-wrap break-words text-[9px] leading-relaxed text-danger"
              >
                {createError}
              </p>
              <p class="mt-1 text-[9px] leading-relaxed text-dimmed">
                Fix the Git error, then choose Create pull request to try again.
              </p>
            </div>
          </div>
        </div>
      {/if}

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
            <span class="text-[10px] text-muted">Push local commits</span>
            <p class="text-[9px] leading-relaxed text-dimmed">
              Push unpublished commits on
              <span class="font-mono text-foreground">{head}</span> before creating the pull request.
            </p>
          </div>
          <Switch
            checked={pushLocalCommits}
            onchange={(value) => (pushLocalCommits = value)}
            aria-label="Push local commits"
          />
        </div>
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0">
            <span class="text-[10px] text-muted">Commit staged and untracked files</span>
            <p class="text-[9px] leading-relaxed text-dimmed">
              {hasPendingCommitChanges
                ? headIsCurrent
                  ? 'Create an uncategorized commit dated at submission time.'
                  : `Check out ${head} before committing files to it.`
                : 'No staged or untracked files to commit right now.'}
            </p>
          </div>
          <Switch
            checked={commitPendingFiles}
            onchange={(value) => (commitPendingFiles = value)}
            disabled={!hasPendingCommitChanges || !headIsCurrent}
            aria-label="Commit staged and untracked files"
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

    {#if gitState.error && !result && !composeError && !createError}
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
          : !canCreate && compare?.source === 'local' && !pushLocalCommits
            ? 'Push local commits to create this pull request'
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
