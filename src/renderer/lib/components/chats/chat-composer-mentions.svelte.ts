import { invoke } from '$lib/ipc.svelte'
import { isEntryHiddenByVisibility } from '$lib/stores/cio-search-visibility.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { composerMentionQuery, type ComposerMentionEntry } from './composer-mentions'
import type { AssignmentTask } from '$shared/types'

export interface ComposerMentionSearchOptions {
  getAssignmentTasks: () => AssignmentTask[]
  getFileTagProjectId: () => string | undefined
}

/**
 * `@` mention menu state and the debounced project-file/task/utility search
 * behind it. The search resolves against the live props through the getters so
 * the state survives the host's prop updates.
 */
export function createComposerMentionSearch(options: ComposerMentionSearchOptions) {
  let entries = $state<ComposerMentionEntry[]>([])
  let query = $state('')
  let open = $state(false)
  let index = $state(0)
  let requestId = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined

  async function update(nextValue: string): Promise<void> {
    const nextQuery = composerMentionQuery(nextValue)
    if (nextQuery === null) {
      open = false
      return
    }
    const currentRequestId = ++requestId
    try {
      const normalizedQuery = nextQuery.trim().toLocaleLowerCase()
      const utilityEntries: ComposerMentionEntry[] =
        !normalizedQuery || 'cio-utility'.includes(normalizedQuery)
          ? [
              {
                type: 'utility',
                entry: {
                  id: 'cio-utility',
                  name: '@cio-utility',
                  description:
                    'Set up a skill, MCP server, or plugin, or debug an app issue with a CodeInOven agent.'
                }
              }
            ]
          : []
      const taskEntries: ComposerMentionEntry[] = options
        .getAssignmentTasks()
        .filter((task) => {
          if (!normalizedQuery) return true
          return [task.title, task.description, task.id, task.workerName]
            .filter((value): value is string => typeof value === 'string')
            .some((value) => value.toLocaleLowerCase().includes(normalizedQuery))
        })
        .map((entry) => ({ type: 'task', entry }))
      const fileTagProjectId = options.getFileTagProjectId()
      const files = fileTagProjectId
        ? (
            await invoke(
              'projectFiles:search',
              fileTagProjectId,
              nextQuery,
              'all',
              workspaceState.activeScopeBucketIdFor(fileTagProjectId)
            )
          ).filter((entry) => !isEntryHiddenByVisibility(entry.path, entry.ignored))
        : []
      const nextEntries: ComposerMentionEntry[] = [
        ...utilityEntries,
        ...taskEntries,
        ...files.map((entry) => ({ type: 'project' as const, entry }))
      ]
      if (currentRequestId !== requestId) return
      query = nextQuery
      entries = nextEntries.slice(0, 40)
      index = 0
      open = true
    } catch {
      if (currentRequestId === requestId) open = false
    }
  }

  function schedule(textBeforeCaret: string): void {
    clearTimeout(searchTimer)
    if (composerMentionQuery(textBeforeCaret) === null) {
      requestId += 1
      open = false
      return
    }
    searchTimer = setTimeout(() => void update(textBeforeCaret), 120)
  }

  function dispose(): void {
    clearTimeout(searchTimer)
  }

  return {
    get entries() {
      return entries
    },
    get query() {
      return query
    },
    get open() {
      return open
    },
    set open(value: boolean) {
      open = value
    },
    get index() {
      return index
    },
    set index(value: number) {
      index = value
    },
    update,
    schedule,
    dispose
  }
}
