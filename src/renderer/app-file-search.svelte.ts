import { SvelteMap } from 'svelte/reactivity'
import type { ActionDefinition, ActionSelection } from '$lib/actions'
import { invoke } from '$lib/ipc.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import {
  getInlineFileTypeIconDataUri,
  getInlineFolderTypeIconDataUri
} from '$lib/components/files/file-type-icons'
import { actionId } from './app-palette-actions'

interface FileSearchTarget {
  projectId: string
  path: string
  kind: 'file' | 'directory'
}

const SEARCH_DEBOUNCE_MS = 160
const MIN_QUERY_LENGTH = 2
const MAX_RESULTS = 60

/**
 * Reactive state machine behind the cross-project file search palette: scoped
 * project selection, debounced fan-out search, and opening the picked file.
 */
export class FileSearchPaletteController {
  paletteOpen = $state(false)
  actions = $state<ActionDefinition[]>([])
  loading = $state(false)
  /** Scoped project ids for the footer picker; empty = all projects. */
  projectIds = $state<string[]>([])

  private timer: number | null = null
  private request = 0
  private lastQuery = ''
  private readonly targets = new SvelteMap<ActionDefinition['id'], FileSearchTarget>()

  reset(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    this.request++
    this.loading = false
    this.actions = []
    this.targets.clear()
    this.projectIds = []
    this.lastQuery = ''
  }

  openPalette(): void {
    this.reset()
    this.paletteOpen = true
  }

  close(): void {
    this.paletteOpen = false
    this.reset()
  }

  handleQuery(query: string): void {
    this.lastQuery = query
    if (this.timer !== null) window.clearTimeout(this.timer)
    const request = ++this.request
    const normalized = query.trim()
    if (normalized.length < MIN_QUERY_LENGTH) {
      this.loading = false
      this.actions = []
      this.targets.clear()
      return
    }

    this.loading = true
    this.timer = window.setTimeout(() => {
      this.timer = null
      void this.search(normalized, request)
    }, SEARCH_DEBOUNCE_MS)
  }

  /** Re-run the in-flight search immediately when the project scope changes. */
  setScope(projectIds: string[]): void {
    this.projectIds = projectIds
    if (!this.paletteOpen || this.lastQuery.trim().length < MIN_QUERY_LENGTH) return
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
    const request = ++this.request
    this.loading = true
    void this.search(this.lastQuery.trim(), request)
  }

  select(selection: ActionSelection): void {
    const target = this.targets.get(selection.action.id)
    if (!target) return
    this.close()
    workspaceState.requestProjectFileOpen(target.projectId, target.path, target.kind)
  }

  private async search(query: string, request: number): Promise<void> {
    const selectedIds = this.projectIds
    const projects = scopeState.projectRecords.filter(
      (project) =>
        !project.hidden &&
        project.source === 'local' &&
        project.path &&
        (selectedIds.length === 0 || selectedIds.includes(project.id))
    )
    const projectResults = await Promise.all(
      projects.map(async (project) => {
        try {
          const entries = await invoke(
            'projectFiles:search',
            project.id,
            query,
            'all',
            workspaceState.activeScopeBucketIdFor(project.id)
          )
          return { project, entries: entries.slice(0, 12) }
        } catch {
          return { project, entries: [] }
        }
      })
    )
    if (request !== this.request || !this.paletteOpen) return

    const resolved = await Promise.all(
      projectResults.flatMap(({ project, entries }) =>
        entries.map(async (entry) => ({
          project,
          entry,
          iconUri:
            entry.kind === 'directory'
              ? await getInlineFolderTypeIconDataUri(entry.name)
              : await getInlineFileTypeIconDataUri(entry.path)
        }))
      )
    )
    if (request !== this.request || !this.paletteOpen) return

    const targets = new SvelteMap<ActionDefinition['id'], FileSearchTarget>()
    const actions: ActionDefinition[] = []
    for (const { project, entry, iconUri } of resolved) {
      const id = actionId(`file:${project.id}:${entry.path}`)
      targets.set(id, { projectId: project.id, path: entry.path, kind: entry.kind })
      actions.push({
        id,
        title: entry.name,
        description: `${project.name} · ${entry.path}`,
        category: 'file',
        source: {
          id: `project:${project.id}`,
          label: project.name,
          kind: 'app',
          ...(project.color ? { color: project.color } : {})
        },
        iconUri,
        keywords: [project.name, entry.path, entry.name]
      })
    }
    this.targets.clear()
    for (const [id, target] of targets) this.targets.set(id, target)
    this.actions = actions.slice(0, MAX_RESULTS)
    this.loading = false
  }
}
