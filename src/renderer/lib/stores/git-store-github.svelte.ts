import { invoke } from '$lib/ipc.svelte'
import type { GitHubAuthStatus, GitHubDeviceCode, GitHubPollResult } from '$shared/types'
import { errorMessage } from './git-store-helpers'

/**
 * Fallback when a status call itself fails. `configured` describes the build (a
 * GitHub App client ID is compiled into it), which a failed call says nothing
 * about, so it stays true: reporting `false` would hide the sign-in button and
 * leave the user with no way back to GitHub.
 */
const GITHUB_STATUS_UNAVAILABLE: GitHubAuthStatus = { connected: false, configured: true }

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
    } catch (reason) {
      this.setViewerLogin(null)
      this.setError(errorMessage(reason, 'GitHub status could not be loaded'))
      return GITHUB_STATUS_UNAVAILABLE
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
      // The sign-out did not run, so report what GitHub auth is actually doing
      // rather than inventing a signed-out state the main process never reached.
      return await this.githubAuthStatus()
    }
  }
}
