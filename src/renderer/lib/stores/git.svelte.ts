import { invoke, subscribe } from '$lib/ipc.svelte'
import type {
  GitBranchInfo,
  GitCredentialStatus,
  GitDiff,
  GitIdentity,
  GitRemoteInfo,
  GitStatus,
  MergeSummary
} from '$shared/types'

/** One in-flight git operation, tracked per project for busy/disabled UI. */
export type GitOperation =
  | 'refresh'
  | 'stage'
  | 'unstage'
  | 'commit'
  | 'init'
  | 'checkout'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'merge'
  | 'rebase'
  | 'stash'
  | 'abortMerge'
  | 'abortRebase'
  | 'pr-create'
  | 'pr-merge'

function errorMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  return error.message
    .replace(/^Error invoking remote method '[^']+': Error:\s*/u, '')
    .replace(/^Error:\s*/u, '')
}

/**
 * Per-project git runtime state, refreshed on panel activation, after every
 * app-driven mutation, and after agent turns land (`checkpoint.updated`).
 */
class GitState {
  status: GitStatus | null = $state(null)
  branches: GitBranchInfo[] = $state([])
  remotes: GitRemoteInfo[] = $state([])
  identity: GitIdentity | null = $state(null)
  credentialStatus: GitCredentialStatus | null = $state(null)
  busy: Record<string, boolean> = $state({})
  error: string | null = $state(null)

  private subscriptions = new Set<string>()

  get conflicted(): string[] {
    return this.status?.conflicted ?? []
  }

  get clean(): boolean {
    return this.status?.clean ?? true
  }

  get branch(): string | null {
    return this.status?.branch ?? null
  }

  isBusy(operation: GitOperation | GitOperation[]): boolean {
    const operations = Array.isArray(operation) ? operation : [operation]
    return operations.some((name) => this.busy[name] === true)
  }

  markBusy(operation: GitOperation, busy: boolean): void {
    this.busy = { ...this.busy, [operation]: busy }
  }

  /** Subscribe to agent turn completion so the panel reflects external changes. */
  ensureProjectEvents(projectId: string): void {
    if (this.subscriptions.has(projectId)) return
    this.subscriptions.add(projectId)
    subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as { type: string; projectId?: string } | undefined
      if (event?.type === 'checkpoint.updated' && event.projectId === projectId) {
        void this.refresh(projectId)
      }
    })
  }

  async refresh(projectId: string): Promise<void> {
    this.markBusy('refresh', true)
    this.error = null
    try {
      const [status, branches, identity, remotes, credentialStatus] = await Promise.all([
        invoke('git:status', projectId),
        invoke('git:branches', projectId),
        invoke('git:getIdentity', projectId),
        invoke('git:remotes', projectId).catch(() => [] as GitRemoteInfo[]),
        invoke('git:getCredentialStatus', projectId).catch(() => null as GitCredentialStatus | null)
      ])
      this.status = status
      this.branches = branches
      this.identity = identity
      this.remotes = remotes
      this.credentialStatus = credentialStatus
    } catch (reason) {
      this.error = errorMessage(reason, 'Git status could not be loaded')
      this.status = null
    } finally {
      this.markBusy('refresh', false)
    }
  }

  async stage(projectId: string, paths: string[]): Promise<void> {
    this.markBusy('stage', true)
    this.error = null
    try {
      this.status = await invoke('git:stage', projectId, paths)
    } catch (reason) {
      this.error = errorMessage(reason, 'Files could not be staged')
    } finally {
      this.markBusy('stage', false)
    }
  }

  async unstage(projectId: string, paths: string[]): Promise<void> {
    this.markBusy('unstage', true)
    this.error = null
    try {
      this.status = await invoke('git:unstage', projectId, paths)
    } catch (reason) {
      this.error = errorMessage(reason, 'Files could not be unstaged')
    } finally {
      this.markBusy('unstage', false)
    }
  }

  async commit(projectId: string, message: string): Promise<void> {
    this.markBusy('commit', true)
    this.error = null
    try {
      this.status = await invoke('git:commit', projectId, message)
    } catch (reason) {
      this.error = errorMessage(reason, 'Commit failed')
    } finally {
      this.markBusy('commit', false)
    }
  }

  async initialize(projectId: string): Promise<void> {
    this.markBusy('init', true)
    this.error = null
    try {
      this.status = await invoke('git:init', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Repository could not be initialized')
    } finally {
      this.markBusy('init', false)
    }
  }

  async checkout(projectId: string, branch: string): Promise<void> {
    this.markBusy('checkout', true)
    this.error = null
    try {
      this.status = await invoke('git:checkout', projectId, branch)
      await this.refresh(projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Checkout failed')
    } finally {
      this.markBusy('checkout', false)
    }
  }

  async setIdentity(projectId: string, name: string, email: string): Promise<void> {
    this.error = null
    try {
      this.identity = await invoke('git:setIdentity', projectId, { name, email })
    } catch (reason) {
      this.error = errorMessage(reason, 'Identity could not be saved')
    }
  }

  async getDiff(projectId: string, path: string, staged: boolean): Promise<GitDiff> {
    return invoke('git:diff', projectId, path, staged)
  }

  async fetch(projectId: string): Promise<void> {
    this.markBusy('fetch', true)
    this.error = null
    try {
      this.status = await invoke('git:fetch', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Fetch failed')
    } finally {
      this.markBusy('fetch', false)
    }
  }

  async pull(projectId: string): Promise<void> {
    this.markBusy('pull', true)
    this.error = null
    try {
      this.status = await invoke('git:pull', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Pull failed')
    } finally {
      this.markBusy('pull', false)
    }
  }

  async push(
    projectId: string,
    setUpstream: boolean,
    remote?: string,
    branch?: string
  ): Promise<void> {
    this.markBusy('push', true)
    this.error = null
    try {
      this.status = await invoke('git:push', projectId, { setUpstream, remote, branch })
    } catch (reason) {
      this.error = errorMessage(reason, 'Push failed')
    } finally {
      this.markBusy('push', false)
    }
  }

  async addRemote(projectId: string, name: string, url: string): Promise<void> {
    this.error = null
    try {
      this.remotes = await invoke('git:addRemote', projectId, name, url)
    } catch (reason) {
      this.error = errorMessage(reason, 'Remote could not be added')
    }
  }

  async removeRemote(projectId: string, name: string): Promise<void> {
    this.error = null
    try {
      this.remotes = await invoke('git:removeRemote', projectId, name)
    } catch (reason) {
      this.error = errorMessage(reason, 'Remote could not be removed')
    }
  }

  async setCredential(projectId: string, token: string): Promise<void> {
    this.error = null
    try {
      this.credentialStatus = await invoke('git:setCredential', projectId, token)
    } catch (reason) {
      this.error = errorMessage(reason, 'Credential could not be stored')
    }
  }

  async removeCredential(projectId: string): Promise<void> {
    this.error = null
    try {
      this.credentialStatus = await invoke('git:removeCredential', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Credential could not be removed')
    }
  }

  async merge(projectId: string, target: string): Promise<MergeSummary | null> {
    this.markBusy('merge', true)
    this.error = null
    try {
      const summary = await invoke('git:merge', projectId, target)
      this.status = await invoke('git:status', projectId)
      return summary
    } catch (reason) {
      this.error = errorMessage(reason, 'Merge failed')
      return null
    } finally {
      this.markBusy('merge', false)
    }
  }

  async rebase(projectId: string, target: string): Promise<MergeSummary | null> {
    this.markBusy('rebase', true)
    this.error = null
    try {
      const summary = await invoke('git:rebase', projectId, target)
      this.status = await invoke('git:status', projectId)
      return summary
    } catch (reason) {
      this.error = errorMessage(reason, 'Rebase failed')
      return null
    } finally {
      this.markBusy('rebase', false)
    }
  }

  async abortMerge(projectId: string): Promise<void> {
    this.markBusy('abortMerge', true)
    this.error = null
    try {
      this.status = await invoke('git:abortMerge', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Merge abort failed')
    } finally {
      this.markBusy('abortMerge', false)
    }
  }

  async abortRebase(projectId: string): Promise<void> {
    this.markBusy('abortRebase', true)
    this.error = null
    try {
      this.status = await invoke('git:abortRebase', projectId)
    } catch (reason) {
      this.error = errorMessage(reason, 'Rebase abort failed')
    } finally {
      this.markBusy('abortRebase', false)
    }
  }

  async stash(projectId: string, message?: string): Promise<void> {
    this.markBusy('stash', true)
    this.error = null
    try {
      this.status = await invoke('git:stash', projectId, message)
    } catch (reason) {
      this.error = errorMessage(reason, 'Stash failed')
    } finally {
      this.markBusy('stash', false)
    }
  }
}

export const gitState = new GitState()
