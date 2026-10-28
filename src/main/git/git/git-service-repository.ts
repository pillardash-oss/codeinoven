import type { GitIdentity, GitStatus } from '../../../lib/types'
import type { GitServiceCore } from './git-service-core'

/**
 * The repository itself: creating it, and the identity its commits are authored
 * with.
 */
export class GitServiceRepository {
  constructor(private readonly core: GitServiceCore) {}

  async initialize(projectPath: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await this.core.client(directory).init({ '--initial-branch': 'main' })
      })
      return this.core.readStatus(directory)
    })
  }

  async getIdentity(projectPath: string): Promise<GitIdentity> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.readIdentity(directory)
    })
  }

  /** Non-queued identity read   only safe inside a queued task. */
  private async readIdentity(directory: string): Promise<GitIdentity> {
    return this.core.wrapError(directory, 'read', async () => {
      const git = this.core.client(directory)
      const [name, email] = await Promise.all([
        git.raw(['config', 'user.name']).catch(() => ''),
        git.raw(['config', 'user.email']).catch(() => '')
      ])
      const safeName = name.trim() || null
      const safeEmail = email.trim() || null
      return {
        name: safeName,
        email: safeEmail,
        configured: Boolean(safeName && safeEmail)
      }
    })
  }

  async setIdentity(projectPath: string, name: string, email: string): Promise<GitIdentity> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(directory, 'mutation', async () => {
        const git = this.core.client(directory)
        await git.raw(['config', 'user.name', name])
        await git.raw(['config', 'user.email', email])
      })
      return this.readIdentity(directory)
    })
  }
}
