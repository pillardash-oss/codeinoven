import type { GitState } from '../git.svelte'
import { GitStateRuntime } from './git-runtime'
import { GitStateQueries } from './git-queries'
import { GitStateLifecycle } from './git-lifecycle'
import { GitStatePanels } from './git-panels'
import { GitStateStorage } from './git-storage'
import { GitStateCommands } from './git-commands'

/** The concern units a GitState delegates to, built once in its constructor. */
export function buildGitStateUnits(engine: GitState) {
  return {
    runtime: new GitStateRuntime(engine),
    queries: new GitStateQueries(engine),
    lifecycle: new GitStateLifecycle(engine),
    panels: new GitStatePanels(engine),
    storage: new GitStateStorage(engine),
    commands: new GitStateCommands(engine)
  } as const
}

export type GitStateUnits = ReturnType<typeof buildGitStateUnits>
