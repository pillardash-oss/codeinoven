import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import { invoke } from '$lib/ipc.svelte'
import { claimInlineEscape } from '$lib/stores/page-surface.svelte'
import { threadComposerTag } from './composer-tag'
import { taggedThreads } from '$lib/stores/tagged-threads.svelte'
import {
  cioSearchVisibility,
  isEntryHiddenByVisibility
} from '$lib/stores/cio-search-visibility.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import {
  composerMentionQuery,
  composerAssistantTagToken,
  COMPOSER_BUILT_IN_TAGS,
  type ComposerAssistantTag,
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
  /**
   * Assistants and assistant threads this composer may tag. Assistant View
   * supplies them; every other composer leaves them out, so tagging an
   * assistant or its thread is offered only where the Assistant tab is open.
   */
  getAssistantTags?: () => readonly ComposerAssistantTag[]
}

/** Whether an assistant tag row answers this (already lower-cased) query. */
function assistantTagMatches(tag: ComposerAssistantTag, query: string): boolean {
  if (!query) return true
  return (
    tag.name.toLocaleLowerCase().includes(query) ||
    tag.detail.toLocaleLowerCase().includes(query) ||
    tag.keywords.some((keyword) => keyword.includes(query))
  )
}

/**
 * `@` mention menu state and the debounced project-file/task/utility search
 * behind it. The search resolves against the live props through the getters so
 * the state survives the host's prop updates.
 */
export function createComposerMentionSearch(options: ComposerMentionSearchOptions) {
  let entries = $state.raw<ComposerMentionEntry[]>([])
  let query = $state('')
  let openState = $state(false)
  let index = $state(0)
  let requestId = 0
  let searchTimer: ReturnType<typeof setTimeout> | undefined
  let escapeClaim: (() => void) | null = null

  /**
   * Thread tags found in another project, by their token.
   *
   * A tag picked from the cross-project search is not in the composer's own tag
   * list, and a token is only an id: without the tag it came from, the draft
   * would draw `@thread:<id>` and lose the title and the project icon the user
   * picked. Every thread the search has shown is kept, so any of those tokens
   * still reads as its thread.
   */
  const knownThreadTags = new SvelteMap<string, ComposerAssistantTag>()

  /** Whether a typed query may span spaces: only thread search makes it useful. */
  function spacesAllowed(): boolean {
    return cioSearchVisibility.includeThreads
  }

  /**
   * Publish the menu's open state.
   *
   * While it is open the menu owns Escape: the key closes the suggestions
   * instead of reaching the recording or the running turn behind them, so this
   * is the one place that flips the flag.
   */
  function setOpen(value: boolean): void {
    if (value === openState) return
    openState = value
    if (value) {
      escapeClaim ??= claimInlineEscape('composer-mentions')
      return
    }
    escapeClaim?.()
    escapeClaim = null
  }

  async function update(nextValue: string): Promise<void> {
    const nextQuery = composerMentionQuery(nextValue, { allowSpaces: spacesAllowed() })
    if (nextQuery === null) {
      requestId += 1
      setOpen(false)
      return
    }
    const currentRequestId = ++requestId
    // A space in the query is a thread title, never a file path: only thread
    // search spans them, and only while that switch is on.
    const spacedQuery = nextQuery.includes(' ')
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
      // Kept as tags rather than as menu entries: the thread search below reads
      // their ids, and a widened `ComposerMentionEntry` union would only carry
      // file and task rows that have no id at all.
      const assistantTags = (options.getAssistantTags?.() ?? []).filter(
        (tag) =>
          (tag.kind !== 'thread' || cioSearchVisibility.includeThreads) &&
          assistantTagMatches(tag, normalizedQuery)
      )
      const assistantEntries: ComposerMentionEntry[] = assistantTags.map((entry) => ({
        type: 'assistant' as const,
        entry
      }))
      const localEntries = [...utilityEntries, ...assistantEntries, ...taskEntries]
      // A query that spans spaces says a thread title is being typed, and a
      // title that matched nothing local may still match a thread or a file, so
      // the empty local list waits for the search below instead of flashing a
      // menu the search is about to fill.
      query = nextQuery
      if (!spacedQuery || localEntries.length > 0) {
        entries = localEntries.slice(0, 40)
        index = 0
        setOpen(true)
      }
      const fileTagProjectId = options.getFileTagProjectId()
      const filesPromise = fileTagProjectId
        ? invoke(
            'projectFiles:search',
            fileTagProjectId,
            nextQuery,
            'all',
            workspaceState.activeScopeBucketIdFor(fileTagProjectId)
          )
            .then((files) =>
              files.filter((entry) => !isEntryHiddenByVisibility(entry.path, entry.ignored))
            )
            .catch(() => [])
        : []
      const [files, threadResults] = await Promise.all([
        filesPromise,
        cioSearchVisibility.includeThreads && normalizedQuery
          ? invoke('threads:search', nextQuery, { family: 'projects', limit: 20 }).catch(() => [])
          : Promise.resolve([])
      ])
      const knownThreadIds = new SvelteSet(
        assistantTags.filter((tag) => tag.kind === 'thread').map((tag) => tag.id)
      )
      // The chip a sent message draws needs the title of the thread its token
      // names, and this search is the only place that saw it.
      taggedThreads.remember(threadResults.map(({ thread }) => thread))
      const threadEntries: ComposerMentionEntry[] = threadResults
        .filter(({ thread }) => !knownThreadIds.has(thread.id))
        .map(({ thread }) => {
          const project = scopeState.projects.find((entry) => entry.id === thread.projectId)
          const tag = threadComposerTag(thread, project)
          knownThreadTags.set(composerAssistantTagToken(tag), tag)
          return { type: 'assistant', entry: tag }
        })
      const nextEntries: ComposerMentionEntry[] = [
        ...utilityEntries,
        ...assistantEntries,
        ...taskEntries,
        ...threadEntries,
        ...files.map((entry) => ({ type: 'project' as const, entry }))
      ]
      if (currentRequestId !== requestId) return
      query = nextQuery
      if (spacedQuery && nextEntries.length === 0) {
        // The space carried the query past its tag and onto prose: nothing here
        // names a tag any more, so the menu closes instead of covering the
        // conversation while the sentence is finished.
        setOpen(false)
        return
      }
      entries = nextEntries.slice(0, 40)
      index = 0
      setOpen(true)
    } catch {
      // Keep the local suggestions already published above on file lookup failure.
    }
  }

  function schedule(textBeforeCaret: string): void {
    clearTimeout(searchTimer)
    if (composerMentionQuery(textBeforeCaret, { allowSpaces: spacesAllowed() }) === null) {
      requestId += 1
      setOpen(false)
      return
    }
    requestId += 1
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

    const fileMatches = new SvelteMap<string, Promise<ProjectFileEntry | null>>()
    const deadline = Date.now() + 1_500

    /** The single visible project entry a typed name resolves to, or null. */
    const matchTypedFile = async (typedName: string): Promise<ProjectFileEntry | null> => {
      if (!projectId || Date.now() >= deadline) return null
      const cached = fileMatches.get(typedName)
      if (cached) return cached
      const lookup = (async (): Promise<ProjectFileEntry | null> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const files = (
            await Promise.race([
              invoke('projectFiles:search', projectId, typedName, 'all', scopeBucketId),
              new Promise<ProjectFileEntry[]>((resolve) => {
                timer = setTimeout(() => resolve([]), Math.max(0, deadline - Date.now()))
              })
            ])
          ).filter((file) => !isEntryHiddenByVisibility(file.path, file.ignored))
          return matchProjectEntry(typedName, files)
        } catch {
          return null
        } finally {
          clearTimeout(timer)
        }
      })()
      fileMatches.set(typedName, lookup)
      return lookup
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
    requestId += 1
    escapeClaim?.()
    escapeClaim = null
    openState = false
  }

  return {
    get entries() {
      return entries
    },
    get query() {
      return query
    },
    get open() {
      return openState
    },
    set open(value: boolean) {
      if (!value) {
        clearTimeout(searchTimer)
        requestId += 1
      }
      setOpen(value)
    },
    /**
     * Thread tags this search found in any project, by the token a draft
     * carries. The composer draws a badge for each of these the draft still
     * names, so a picked thread keeps its title and its project icon.
     */
    get knownThreadTags() {
      return [...knownThreadTags.values()]
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
