import type { GitStashEntry, GitStatus } from '../../../lib/types'
import type { GitServiceCore } from './git-service-core'

/**
 * Stashes: pushing the working tree aside, listing what is parked, and taking it
 * back or dropping it.
 */
export class GitServiceStashes {
  constructor(private readonly core: GitServiceCore) {}

  async stash(projectPath: string, message?: string, paths?: string[]): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        if (paths && paths.length > 0) {
          const safePaths = paths.map((path) => this.core.assertRelativePath(directory, path))
          const args = message ? ['push', '-m', message] : ['push']
          await this.core.client(directory).stash([...args, '--', ...safePaths])
        } else {
          const args = message ? ['push', '-m', message] : ['push']
          await this.core.client(directory).stash(args)
        }
      })
      return this.core.readStatus(directory)
    })
  }

  /** List stashes newest-first, e.g. `stash@{0}` → `stash@{n}`. */
  async listStashes(projectPath: string): Promise<GitStashEntry[]> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () => {
        const git = this.core.client(directory)
        const output = await git.raw(['stash', 'list', '--format=%gd%x00%gs%x00%ct%x00'])
        const raw = String(output)
        if (!raw.trim()) return []
        return raw
          .split('\n')
          .filter((line) => line.trim())
          .map((line) => {
            const [id, message, date, ...rest] = line.split('\0')
            if (!id) return null
            const fullMessage = message ?? (rest.length > 0 ? rest.join('\0') : '')
            const branchMatch = /^(?:WIP on|On) ([^:\s]+):/u.exec(fullMessage)
            return {
              id,
              message: fullMessage,
              branch: branchMatch?.[1] ?? null,
              date: Number.parseInt(date ?? '0', 10) * 1000 || Date.now()
            } satisfies GitStashEntry
          })
          .filter((entry): entry is GitStashEntry => entry !== null)
      })
    })
  }

  /** Restore a stash (defaults to the newest) and drop it when it applies cleanly. */
  async popStash(projectPath: string, id?: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        const args = id ? ['pop', id] : ['pop']
        await this.core.client(directory).stash(args)
      })
      return this.core.readStatus(directory)
    })
  }

  /** Discard a stash (defaults to the newest). */
  async dropStash(projectPath: string, id?: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        const args = id ? ['drop', id] : ['drop']
        await this.core.client(directory).stash(args)
      })
      return this.core.readStatus(directory)
    })
  }
}
