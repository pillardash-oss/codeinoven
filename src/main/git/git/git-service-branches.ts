import type { SimpleGit } from 'simple-git'
import type { GitBranchInfo, GitRemoteUpdate, GitStatus } from '../../../lib/types'
import type { GitServiceCore } from './git-service-core'
import {
  REMOTE_REF_PREFIX,
  REMOTE_UPDATE_FORMAT,
  REMOTE_UPDATE_LIMIT,
  parseRemoteUpdates
} from './git-service-remote-updates'
import { parseBranchRefs, worktreeBranchPaths } from './git-service-status'

/**
 * Branches: listing them with their upstream and worktree, switching to them,
 * creating and deleting them locally and on a remote.
 */
export class GitServiceBranches {
  constructor(private readonly core: GitServiceCore) {}

  async listBranches(projectPath: string): Promise<GitBranchInfo[]> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () => {
        const git = this.core.client(directory)
        const [output, remotes, worktreeRaw] = await Promise.all([
          git.raw([
            'for-each-ref',
            '--format=%(refname)%09%(refname:short)%09%(HEAD)%09%(upstream:short)%09%(upstream:remotename)%09%(upstream:track)%09%(symref)',
            'refs/heads',
            'refs/remotes'
          ]),
          git.getRemotes(),
          git.raw(['worktree', 'list', '--porcelain', '-z']).catch(() => '')
        ])
        return parseBranchRefs(
          Array.isArray(output) ? output.join('\n') : output,
          remotes.map(({ name }) => name),
          worktreeBranchPaths(
            Array.isArray(worktreeRaw) ? worktreeRaw.join('\0') : worktreeRaw,
            directory
          )
        )
      })
    })
  }

  /**
   * The remote's actual default branch (e.g. "nightly" instead of "main"),
   * resolved from origin/HEAD rather than guessed from branch names.
   */
  async getDefaultBranch(projectPath: string): Promise<string | null> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () => {
        const git = this.core.client(directory)
        try {
          const ref = await git.raw(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
          const name = String(ref).trim()
          const prefix = 'origin/'
          if (name.startsWith(prefix)) return name.slice(prefix.length)
          return name || null
        } catch {
          return null
        }
      })
    })
  }

  async checkout(projectPath: string, branch: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await this.core.client(directory).checkout(branch)
      })
      return this.core.readStatus(directory)
    })
  }

  async createBranch(projectPath: string, name: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await this.core.client(directory).checkoutLocalBranch(name)
      })
      return this.core.readStatus(directory)
    })
  }

  async createTrackingBranch(
    projectPath: string,
    remote: string,
    branch: string,
    localName: string
  ): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        await this.core
          .client(directory)
          .raw(['checkout', '--track', '-b', localName, `${remote}/${branch}`])
      })
      return this.core.readStatus(directory)
    })
  }

  async deleteBranch(projectPath: string, name: string, force = false): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      await this.core.wrapError(projectPath, 'mutation', async () => {
        const git = this.core.client(directory)
        // Tolerate git's ambiguous short spelling: when a tag shares the branch
        // name, `refname:short` renders `heads/<name>` and `git branch -d` on
        // that spelling fails with "branch not found".
        const resolves = await git
          .raw(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
          .then(
            () => true,
            () => false
          )
        const branchName =
          resolves || !name.startsWith('heads/') ? name : name.slice('heads/'.length)
        await this.removeWorktreesForBranch(git, branchName)
        await git.deleteLocalBranch(branchName, force)
      })
      return this.core.readStatus(directory)
    })
  }

  /** `git push <remote> --delete <name>` removes a branch from a remote. */
  async deleteRemoteBranch(projectPath: string, remote: string, name: string): Promise<GitStatus> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      // A remote mutation, like a push: it publishes against refs a fetch may be
      // in the middle of pruning, so it takes the remote lane.
      await this.core.enqueueRemote(projectPath, () =>
        this.core.wrapError(projectPath, 'mutation', async () => {
          const git = this.core.client(directory)
          await git.push([remote, '--delete', name])
        })
      )
      return this.core.readStatus(directory)
    })
  }

  /**
   * Git refuses `branch -d` while the branch is checked out in any worktree.
   * Remove clean owning worktrees and prune stale registrations so the delete
   * succeeds; a dirty live worktree keeps blocking and surfaces git's error.
   */
  private async removeWorktreesForBranch(git: SimpleGit, name: string): Promise<void> {
    let listing: string
    try {
      listing = await git.raw(['worktree', 'list', '--porcelain'])
    } catch {
      return
    }
    const target = `refs/heads/${name}`
    const lines = listing.split('\n')
    const paths: string[] = []
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].startsWith('worktree ')) continue
      const path = lines[index].slice('worktree '.length)
      const branch = lines
        .slice(index + 1, index + 5)
        .find((line) => line.startsWith('branch '))
        ?.slice('branch '.length)
      if (branch === target) paths.push(path)
    }
    for (const path of paths) {
      await git.raw(['worktree', 'remove', path]).catch(async () => {
        // Path already gone or dirty   prune clears stale registrations; a
        // live dirty worktree stays registered and the branch delete reports it.
        await git.raw(['worktree', 'prune']).catch(() => undefined)
      })
    }
  }

  /**
   * Every movement of the current branch's upstream ref, newest first.
   *
   * Read from git's reflog for that remote-tracking ref, which is the only
   * native record of when commits actually reached the remote (a commit's own
   * dates say when it was written, not when it was published). Each entry names
   * the commit the ref moved to, so the history view can draw where one push
   * ended and the next began.
   *
   * Returns an empty list rather than failing whenever the answer is simply
   * unknown: no upstream, an upstream that is not a remote-tracking ref, or a
   * ref whose reflog was never written or has expired.
   */
  async remoteUpdates(projectPath: string): Promise<GitRemoteUpdate[]> {
    return this.core.enqueue(projectPath, async () => {
      const directory = await this.core.repo(projectPath)
      return this.core.wrapError(projectPath, 'read', async () => {
        const git = this.core.client(directory)
        // The full name, so a branch that tracks another *local* branch (where
        // `branch.<name>.remote` is `.`) is not mistaken for a remote. Such a
        // ref's reflog records local commits, which are not pushes at all.
        const upstream = await git
          .raw(['rev-parse', '--symbolic-full-name', '@{upstream}'])
          .catch(() => '')
        const fullRef = upstream.trim()
        if (!fullRef.startsWith(REMOTE_REF_PREFIX)) return []
        const ref = fullRef.slice(REMOTE_REF_PREFIX.length)
        try {
          const raw = await git.raw([
            'reflog',
            'show',
            '-n',
            String(REMOTE_UPDATE_LIMIT),
            '--date=iso-strict',
            `--format=${REMOTE_UPDATE_FORMAT}`,
            fullRef
          ])
          return parseRemoteUpdates(ref, raw)
        } catch {
          // No reflog for this ref: the clone never fetched (or reflog writing
          // is off). The history view then falls back to its plain boundary.
          return []
        }
      })
    })
  }
}
