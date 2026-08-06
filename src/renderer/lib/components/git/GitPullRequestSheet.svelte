<script lang="ts">
  import { gitState } from '$lib/stores/git.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import Modal from '../ui/Modal.svelte'
  import Switch from '../ui/Switch.svelte'
  import type { PrMergeMethod, PullRequestReference } from '$shared/types'
  import { ExternalLink, GitPullRequest, Loader2, Merge } from '@lucide/svelte'

  interface Props {
    projectId: string
    onClose: () => void
  }

  let { projectId, onClose }: Props = $props()

  type PrMode = 'create' | 'merge'

  let mode = $state<PrMode>('create')
  let originIdentity = $state<{ owner: string; repo: string } | null>(null)
  let title = $state('')
  let body = $state('')
  let base = $state('main')
  let draft = $state(false)
  let prNumber = $state('')
  let method = $state<PrMergeMethod>('squash')
  let result: PullRequestReference | null = $state(null)
  let originError = $state('')

  const branch = $derived(gitState.status?.branch ?? null)
  const creating = $derived(gitState.isBusy('pr-create'))
  const merging = $derived(gitState.isBusy('pr-merge'))

  async function loadOrigin(): Promise<void> {
    try {
      const project = await invoke('project:get', projectId)
      if (!project?.path) return
      const url = await invoke('repository:remoteOrigin', project.path)
      const identity = parseRemoteIdentity(url ?? '')
      originIdentity = identity
      if (identity && !base.trim()) base = 'main'
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

  async function createPullRequest(): Promise<void> {
    if (!originIdentity || !branch) return
    const reference = await gitState.createPullRequest(projectId, {
      title: title.trim(),
      body: body.trim() || undefined,
      head: branch,
      base: base.trim() || 'main',
      draft
    })
    if (reference) result = reference
  }

  async function mergePullRequest(): Promise<void> {
    const number = Number.parseInt(prNumber, 10)
    if (!originIdentity || !Number.isSafeInteger(number) || number <= 0) return
    const reference = await gitState.mergePullRequest(
      projectId,
      originIdentity.owner,
      originIdentity.repo,
      number,
      method
    )
    if (reference) result = reference
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
</script>

<Modal open title="Pull request" {onClose} size="lg">
  <div class="space-y-3">
    <div
      class="flex items-center rounded-md bg-elevated p-0.5"
      role="group"
      aria-label="Pull request action"
    >
      <button
        type="button"
        class={[
          'flex h-6 flex-1 items-center justify-center gap-1.5 rounded px-2.5 text-[10px] font-medium transition-colors',
          mode === 'create' ? 'bg-overlay text-foreground' : 'text-muted hover:text-foreground'
        ]}
        aria-pressed={mode === 'create'}
        onclick={() => (mode = 'create')}
      >
        <GitPullRequest size={12} />
        Create
      </button>
      <button
        type="button"
        class={[
          'flex h-6 flex-1 items-center justify-center gap-1.5 rounded px-2.5 text-[10px] font-medium transition-colors',
          mode === 'merge' ? 'bg-overlay text-foreground' : 'text-muted hover:text-foreground'
        ]}
        aria-pressed={mode === 'merge'}
        onclick={() => (mode = 'merge')}
      >
        <Merge size={12} />
        Merge
      </button>
    </div>

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
        No GitHub remote (origin) is configured for this project. Add one in the Git panel's Sync
        section first.
      </p>
    {/if}

    {#if result}
      {@const pr = result}
      <div class="rounded-lg border border-success/30 bg-success/10 px-3 py-2">
        <p class="text-[11px] font-medium text-success">Pull request #{pr.number}</p>
        <p class="mt-0.5 truncate text-[10px] text-muted">{pr.url}</p>
        <div class="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            class="flex h-7 items-center gap-1.5 rounded-lg bg-primary px-2.5 text-[10px] font-medium text-on-primary hover:bg-primary-hover"
            onclick={() => void openInBrowser(pr.url)}
          >
            <ExternalLink size={12} />
            Open in browser
          </button>
          <button
            type="button"
            class="rounded-md px-2 py-1 text-[10px] font-medium text-muted hover:bg-elevated"
            onclick={onClose}
          >
            Done
          </button>
        </div>
      </div>
    {:else if mode === 'create'}
      <div class="space-y-2">
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
        <div class="grid grid-cols-2 gap-2">
          <div>
            <label
              class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
              for="pr-head"
            >
              Head (from)
            </label>
            <input
              id="pr-head"
              class="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[11px] text-foreground outline-none disabled:opacity-50"
              value={branch ?? ''}
              disabled
              readonly
            />
          </div>
          <div>
            <label
              class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
              for="pr-base"
            >
              Base (into)
            </label>
            <input
              id="pr-base"
              class="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
              placeholder="main"
              bind:value={base}
            />
          </div>
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
        <div class="flex items-center justify-between gap-2">
          <span class="text-[10px] text-muted">Create as draft</span>
          <Switch
            checked={draft}
            onchange={(value) => (draft = value)}
            aria-label="Create as draft"
          />
        </div>
      </div>
    {:else}
      <div class="space-y-2">
        <div>
          <label
            class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
            for="pr-number"
          >
            Pull request number
          </label>
          <input
            id="pr-number"
            class="h-8 w-full rounded-lg border border-border bg-elevated px-2.5 font-mono text-[11px] text-foreground outline-none placeholder:text-dimmed focus:border-primary"
            placeholder="e.g. 42"
            inputmode="numeric"
            bind:value={prNumber}
          />
        </div>
        <div>
          <label
            class="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-muted"
            for="pr-method"
          >
            Merge method
          </label>
          <select
            id="pr-method"
            class="h-8 w-full rounded-lg border border-border bg-elevated px-2 font-mono text-[11px] text-foreground outline-none focus:border-primary"
            bind:value={method}
          >
            <option value="merge">Merge commit</option>
            <option value="squash">Squash and merge</option>
            <option value="rebase">Rebase and merge</option>
          </select>
        </div>
        <p class="text-[10px] leading-relaxed text-muted">
          Merging closes the pull request on GitHub. Your local branch is left untouched.
        </p>
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
      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="rounded-lg px-3 py-1.5 text-[11px] font-medium text-muted hover:bg-elevated hover:text-foreground"
          onclick={onClose}
        >
          Cancel
        </button>
        {#if mode === 'create'}
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            disabled={!originIdentity || !branch || !title.trim() || creating}
            onclick={() => void createPullRequest()}
          >
            {#if creating}
              <Loader2 size={12} class="animate-spin" />
            {:else}
              <GitPullRequest size={12} />
            {/if}
            Create pull request
          </button>
        {:else}
          <button
            type="button"
            class="flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-on-primary transition-colors hover:bg-primary-hover disabled:opacity-50"
            disabled={!originIdentity || !prNumber.trim() || merging}
            onclick={() => void mergePullRequest()}
          >
            {#if merging}
              <Loader2 size={12} class="animate-spin" />
            {:else}
              <Merge size={12} />
            {/if}
            Merge pull request
          </button>
        {/if}
      </div>
    {/if}
  {/snippet}
</Modal>
