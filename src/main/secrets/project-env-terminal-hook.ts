/**
 * Bind a project's inject rules to one interactive terminal.
 *
 * The terminal env hook in `system/terminal-env-hook` knows how to talk to a shell
 * but nothing about secrets. This module is the bridge: at spawn it asks the env
 * service what waits for a command, and for each line the shell announces it asks
 * only for the names that a rule admits in that line's directory.
 *
 * The directory is taken from the shell's own `$PWD`, so `cd packages/api` typed
 * inside the terminal changes which env group a rule is compared against, exactly
 * as it would for a managed action. A shell inside a worktree (a cwd outside the
 * project directory) keeps the directory the session was opened for.
 */

import {
  installTerminalEnvHook,
  type TerminalEnvHookRequest,
  type TerminalEnvHookSession
} from '../system/terminal-env-hook'
import { projectRelativeDirectory, type LaunchEnvironmentContext } from './project-env-service'
import type { ProjectEnvService } from './project-env-service'

/** What one terminal already knows about the process it is about to start. */
export interface ProjectEnvTerminalContext {
  sessionId: string
  shell: string
  projectId: string
  threadId: string
  cwd: string
  directory: string
}

export interface ProjectEnvTerminalHookDependencies {
  service: Pick<ProjectEnvService, 'interactiveEnvironment' | 'deferredEnvironment'>
  /** Absolute path of a project, or null when it has no local checkout. */
  resolveProjectPath: (projectId: string) => Promise<string | null>
  /** Where session directories live. Defaults to the app's own data root. */
  hookRoot?: string
}

/**
 * A hook factory for `PtyService`, or undefined for a project with no rules.
 *
 * Returning null from the factory keeps the terminal on the plain spawn: a shell
 * with nothing to defer needs no startup file, no watcher and no per-command wait.
 */
export function projectEnvTerminalHook(
  dependencies: ProjectEnvTerminalHookDependencies
): (context: ProjectEnvTerminalContext) => Promise<TerminalEnvHookSession | null> {
  return async (context) => {
    const launch: LaunchEnvironmentContext = {
      projectId: context.projectId,
      threadId: context.threadId,
      cwd: context.cwd,
      directory: context.directory
    }
    const interactive = await dependencies.service.interactiveEnvironment(launch)
    if (interactive.deferred.length === 0) return null
    const projectRoot = await dependencies.resolveProjectPath(context.projectId)

    const request: TerminalEnvHookRequest = {
      sessionId: context.sessionId,
      shell: context.shell,
      deferred: interactive.deferred,
      environment: interactive.environment,
      ...(dependencies.hookRoot ? { root: dependencies.hookRoot } : {}),
      resolve: async ({ pwd, command }) => {
        const inside = projectRoot ? projectRelativeDirectory(projectRoot, pwd) : null
        const directory = inside === null || inside === undefined ? context.directory : inside
        const resolved = await dependencies.service.deferredEnvironment(
          { ...launch, cwd: pwd || context.cwd, directory, command },
          interactive.deferred
        )
        return resolved.environment
      }
    }
    return installTerminalEnvHook(request)
  }
}
