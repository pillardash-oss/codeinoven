import { invoke } from '$lib/ipc.svelte'
import type { GitHubAuthStatus, GitHubDeviceCode, GitHubPollResult } from '$shared/types'
import { errorMessage } from './git-store-helpers'

/** GitHub account auth calls, kept apart from the repository git operations. */
export class GitGitHubAuth {
  constructor(
    private readonly setError: (message: string | null) => void,
    private readonly setViewerLogin: (login: string | null) => void
  ) {}

  async githubAuthStatus(): Promise<GitHubAuthStatus> {
    try {
      const status = await invoke('github:authStatus')
      this.setViewerLogin(status.connected ? (status.user?.login ?? null) : null)
      return status
    } catch {
      return { connected: false, configured: false }
    }
  }

  async startGitHubDeviceFlow(): Promise<GitHubDeviceCode | null> {
    try {
      return await invoke('github:startDeviceFlow')
    } catch (reason) {
      this.setError(errorMessage(reason, 'GitHub sign-in could not be started'))
      return null
    }
  }

  async pollGitHubDeviceCode(deviceCode: string): Promise<GitHubPollResult> {
    try {
      return await invoke('github:poll', deviceCode)
    } catch (reason) {
      const message = errorMessage(reason, 'GitHub sign-in check failed')
      return { status: 'error', message }
    }
  }

  async logoutGitHub(): Promise<GitHubAuthStatus> {
    try {
      const status = await invoke('github:logout')
      // During a renderer hot reload, an older main process may still implement
      // the historical void response. Refresh status instead of dereferencing it.
      return status ?? (await this.githubAuthStatus())
    } catch (reason) {
      this.setError(errorMessage(reason, 'GitHub sign-out failed'))
      return { connected: false, configured: false }
    }
  }
}
