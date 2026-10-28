import type { GitRemoteInfo, GitStatus } from '../../../lib/types'
import type { GitServiceCore } from './git-service-core'

/**
 * Remotes: their configuration, and the two fetch operations that refresh
 * remote-tracking refs. Both run on the remote lane only.
 */
export class GitServiceRemotes {
  constructor(private readonly core: GitServiceCore) {}

  // ─── Remotes & sync (Phase 2) ────────────────────────────────────────────

  async listRemotes(projectPath: string): Promise<GitRemoteInfo[]> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.readRemotes(directory)
    })
  }

  async addRemote(projectPath: string, name: string, url: string): Promise<GitRemoteInfo[]> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await this.core.client(directory).addRemote(name, url)
      })
      return this.core.readRemotes(directory)
    })
  }

  /** `git remote set-url <name> <url>`   update an existing remote's URL. */
  async setRemoteUrl(projectPath: string, name: string, url: string): Promise<GitRemoteInfo[]> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await this.core.client(directory).remote(['set-url', name, url])
      })
      return this.core.readRemotes(directory)
    })
  }

  async removeRemote(projectPath: string, name: string): Promise<GitRemoteInfo[]> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await this.core.client(directory).removeRemote(name)
      })
      return this.core.readRemotes(directory)
    })
  }

  /**
   * Refresh every remote-tracking ref. Runs on the remote lane, so it is queued
   * behind other remote round trips and behind nothing else: the status read at
   * the end of this task is the only local git it does, and that read never
   * takes a lock.
   */
  async fetch(projectPath: string): Promise<GitStatus> {
    return this.core.enqueueRemote(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        // Prune so remote-tracking refs for branches deleted on the server
        // disappear here too. A plain fetch only ever adds refs, which left
        // deleted branches listed under Remote forever.
        await this.core.client(directory).fetch(['--prune'])
      })
      return this.core.readStatus(directory)
    })
  }

  /** Updates just one branch's remote-tracking ref   doesn't touch the working tree. */
  async fetchBranch(projectPath: string, remote: string, branch: string): Promise<GitStatus> {
    return this.core.enqueueRemote(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await this.core.client(directory).fetch(remote, branch)
      })
      return this.core.readStatus(directory)
    })
  }
}
