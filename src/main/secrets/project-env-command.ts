/**
 * Resolve the project ENV of one command whose text is known before it runs.
 *
 * An action script and an agent's shell command are both described up front, so
 * this is the one place that turns that description into values: the launch's own
 * directory first, then every package the command `cd`s into, nearest last so the
 * package wins. Passing the command through also lets an inject rule narrow the
 * files it names, exactly as it does for a terminal line.
 */

import { actionEnvironmentDirectories } from '../../lib/project-env'
import type { LaunchEnvironmentContext, ProjectEnvService } from './project-env-service'

/** One command, in the place that will run it. */
export interface CommandEnvironmentContext extends LaunchEnvironmentContext {
  command: string
}

/**
 * Every value one command is admitted to.
 *
 * The root resolution already applies the files above the launch directory, so a
 * package is resolved on top of it rather than instead of it. A project with no
 * package group, or a command that names none, answers with the launch's own
 * values alone.
 */
export async function resolveCommandEnvironment(
  service: Pick<ProjectEnvService, 'environmentForLaunch' | 'listProjectEnv'>,
  context: CommandEnvironmentContext
): Promise<Record<string, string>> {
  const launch = await service.environmentForLaunch(context)
  const groups = (await service.listProjectEnv(context.projectId)).map((file) => file.group)
  let environment = launch.environment
  for (const group of actionEnvironmentDirectories(context.command, groups)) {
    const resolved = await service.environmentForLaunch({ ...context, directory: group })
    environment = { ...environment, ...resolved.environment }
  }
  return environment
}
