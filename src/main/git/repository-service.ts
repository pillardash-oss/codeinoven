import { execFile } from 'child_process'
import type { ExecFileException } from 'child_process'
import { realpath, stat } from 'fs/promises'
import { resolve } from 'path'
import type { RepositoryPreflightResult } from '../../lib/types'
import { Logger } from '../system/logger'

interface GitCommandResult {
  stdout: string
  stderr: string
}

interface GitCommandFailure {
  error: ExecFileException
  stderr: string
}

export class RepositoryService {
  async preflight(projectPath: string): Promise<RepositoryPreflightResult> {
    const validatedPath = await this.validateLocalDirectory(projectPath)

    try {
      const result = await this.runGit(['-C', validatedPath, 'rev-parse', '--show-toplevel'])
      const repositoryRoot = result.stdout.trim()
      const canonicalRepositoryRoot = repositoryRoot
        ? await realpath(repositoryRoot)
        : validatedPath

      return {
        status: 'git',
        projectPath: validatedPath,
        repositoryRoot: canonicalRepositoryRoot
      }
    } catch (failure) {
      const commandFailure = failure as GitCommandFailure
      const detail = commandFailure.stderr.trim() || commandFailure.error.message

      if (this.isGitUnavailable(commandFailure.error)) {
        Logger.info('Git is unavailable during repository preflight:', validatedPath)
        return {
          status: 'git_unavailable',
          projectPath: validatedPath,
          detail
        }
      }

      return {
        status: 'not_git',
        projectPath: validatedPath,
        detail
      }
    }
  }

  async initialize(projectPath: string): Promise<RepositoryPreflightResult> {
    const validatedPath = await this.validateLocalDirectory(projectPath)

    try {
      await this.runGit(['-C', validatedPath, 'init'])
    } catch (failure) {
      const commandFailure = failure as GitCommandFailure
      const detail = commandFailure.stderr.trim() || commandFailure.error.message

      if (this.isGitUnavailable(commandFailure.error)) {
        Logger.info('Git is unavailable during repository initialization:', validatedPath)
        return {
          status: 'git_unavailable',
          projectPath: validatedPath,
          detail
        }
      }

      Logger.error('Repository initialization failed:', validatedPath, detail)
      throw new Error(`Unable to initialize Git repository: ${detail}`, { cause: failure })
    }

    Logger.info('Initialized Git repository:', validatedPath)
    return this.preflight(validatedPath)
  }

  /**
   * Resolve the current git branch name for the repository at the given path.
   * Returns null when the directory is not a git repository or git is unavailable.
   */
  async getCurrentBranch(projectPath: string): Promise<string | null> {
    try {
      const validatedPath = await this.validateLocalDirectory(projectPath)
      const result = await this.runGit(['-C', validatedPath, 'rev-parse', '--abbrev-ref', 'HEAD'])
      const branch = result.stdout.trim()
      return branch || null
    } catch {
      return null
    }
  }

  /**
   * Resolve the git remote `origin` URL for the repository at the given path.
   * Returns null when there is no origin, the directory is not a git
   * repository, or git is unavailable.
   */
  async getRemoteOrigin(projectPath: string): Promise<string | null> {
    try {
      const validatedPath = await this.validateLocalDirectory(projectPath)
      const result = await this.runGit(['-C', validatedPath, 'remote', 'get-url', 'origin'])
      const url = result.stdout.trim()
      return url || null
    } catch {
      return null
    }
  }

  private async validateLocalDirectory(projectPath: string): Promise<string> {
    const candidate = projectPath.trim()
    if (!candidate) {
      throw new Error('Project path is required')
    }

    const absolutePath = resolve(candidate)

    let metadata
    try {
      metadata = await stat(absolutePath)
    } catch {
      throw new Error(`Project directory does not exist: ${absolutePath}`)
    }

    if (!metadata.isDirectory()) {
      throw new Error(`Project path is not a directory: ${absolutePath}`)
    }

    return realpath(absolutePath)
  }

  private runGit(args: string[]): Promise<GitCommandResult> {
    return new Promise((resolveCommand, rejectCommand) => {
      execFile('git', args, { encoding: 'utf8', windowsHide: true }, (error, stdout, stderr) => {
        if (error) {
          rejectCommand({ error, stderr } satisfies GitCommandFailure)
          return
        }

        resolveCommand({ stdout, stderr })
      })
    })
  }

  private isGitUnavailable(error: ExecFileException): boolean {
    return typeof error.code === 'string'
  }
}
