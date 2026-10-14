import { SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { isEntryHiddenByVisibility } from '$lib/stores/cio-search-visibility.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import {
  composerMentionQuery,
  COMPOSER_BUILT_IN_TAGS,
  type ComposerMentionEntry
} from './composer-mentions'
import {
  matchProjectEntry,
  resolveBuiltInTag,
  splitTypedMentionQuery,
  typedComposerMentions
} from './composer-mention-resolution'
import type { AssignmentTask, ProjectFileEntry, PromptProjectReference } from '$shared/types'

/** Same ceiling the manual mention picker enforces, so auto-targeting cannot
 *  attach more references than picking them by hand could. */
const MAX_PROJECT_REFERENCES = 20

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
      const utilityEntries: ComposerMentionEntry[] = COMPOSER_BUILT_IN_TAGS.filter(
        (tag) =>
          !normalizedQuery ||
          tag.id.includes(normalizedQuery) ||
          tag.keywords.some((keyword) => keyword.includes(normalizedQuery))
      ).map((entry) => ({ type: 'utility', entry }))
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

  /**
   * Resolve the `@` tags a user typed but never picked from the dropdown.
   *
   * A token that names exactly one known built-in tag or project entry is
   * rewritten to its canonical form and, for a project entry, gains the same
   * reference a pick would have added. Exempt positions and ambiguous or
   * unknown tokens are left exactly as typed. Returns the resolved text plus
   * the references to append; the caller owns applying both.
   */
  async function resolveTypedTargets(
    text: string,
    existingReferences: readonly PromptProjectReference[]
  ): Promise<{ text: string; references: PromptProjectReference[] }> {
    const mentions = typedComposerMentions(text)
    if (mentions.length === 0) return { text, references: [] }

    const knownTokens = new SvelteSet(existingReferences.map((reference) => `@${reference.path}`))
    const added: PromptProjectReference[] = []
    const addedPaths = new SvelteSet<string>()
    const replacements: Array<{ start: number; value: string; length: number }> = []
    const projectId = options.getFileTagProjectId()
    const scopeBucketId = projectId ? workspaceState.activeScopeBucketIdFor(projectId) : undefined

    /** The single visible project entry a typed name resolves to, or null. */
    const matchTypedFile = async (typedName: string): Promise<ProjectFileEntry | null> => {
      if (!projectId) return null
      try {
        const files = (
          await invoke('projectFiles:search', projectId, typedName, 'all', scopeBucketId)
        ).filter((file) => !isEntryHiddenByVisibility(file.path, file.ignored))
        return matchProjectEntry(typedName, files)
      } catch {
        return null
      }
    }

    for (const mention of mentions) {
      if (knownTokens.has(mention.token)) continue
      const { name, suffix } = splitTypedMentionQuery(mention.query)

      const builtIn = resolveBuiltInTag(mention.query)
      if (builtIn) {
        const value = `${builtIn.token}${suffix}`
        if (value !== mention.token) {
          replacements.push({ start: mention.start, value, length: mention.token.length })
        }
        continue
      }

      if (!projectId || name.length < 2) continue
      if (existingReferences.length + added.length >= MAX_PROJECT_REFERENCES) continue
      const entry = await matchTypedFile(name)
      if (!entry) continue
      const token = `@${entry.path}`
      if (knownTokens.has(token) || addedPaths.has(entry.path)) continue
      added.push({ id: crypto.randomUUID(), name: entry.name, path: entry.path, kind: entry.kind })
      addedPaths.add(entry.path)
      replacements.push({
        start: mention.start,
        value: `${token}${suffix}`,
        length: mention.token.length
      })
    }

    if (replacements.length === 0) return { text, references: [] }
    let next = text
    for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) {
      next =
        next.slice(0, replacement.start) +
        replacement.value +
        next.slice(replacement.start + replacement.length)
    }
    return { text: next, references: added }
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
    resolveTypedTargets,
    dispose
  }
}
