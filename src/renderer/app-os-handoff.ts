import { toast } from 'svelte-sonner'
import { invoke } from '$lib/ipc.svelte'
import { openProjectFileFromAbsolutePath } from '$lib/reveal-file'
import { captureError, showToastError } from '$lib/stores/app-errors.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { showOpenedFiles } from '$lib/stores/standalone-files.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import type { MainView } from '$lib/stores/renderer-recovery'
import type { OpenedPath, Project } from '$shared/types'

export interface OsHandoffDeps {
  navigate: (view: MainView) => void
  onProjectCreated: (project: Project) => Promise<void>
}

/**
 * OS "Open in CodeInOven" hand-off (Finder/Explorer "Open With", a drop on the
 * Dock/taskbar icon, or a launch argument).
 *
 * Folders become projects, or focus the project that already owns that folder
 * so the same folder is never registered twice. Single files open on their own
 * in the standalone viewer.
 */
export async function handleOpenedPaths(paths: OpenedPath[], deps: OsHandoffDeps): Promise<void> {
  if (!Array.isArray(paths) || paths.length === 0) return
  const files = paths.filter((entry) => entry.kind === 'file')
  if (files.length > 0) await openFilesFromOs(files, deps)
  for (const directory of paths) {
    if (directory.kind === 'directory') await openDirectoryAsProject(directory, deps)
  }
}

/**
 * Route the files from one OS hand-off. A file that already lives inside a
 * project opens in that project's own editor (file tree, scopes, save flow),
 * because that is where the user expects to find it; every other file opens in
 * the standalone viewer, where it is editable against the grant the hand-off
 * registered. A file whose project-relative path no longer resolves falls back
 * to the viewer so the hand-off is never silently dropped.
 */
async function openFilesFromOs(files: OpenedPath[], deps: OsHandoffDeps): Promise<void> {
  const loose: OpenedPath[] = []
  for (const file of files) {
    const owner = await invoke('project:findFileOwner', file.path).catch(() => null)
    if (!owner) {
      loose.push(file)
      continue
    }
    const project = await invoke('project:get', owner.projectId).catch(() => null)
    if (!project) {
      loose.push(file)
      continue
    }
    focusProject(project, deps)
    const opened = await openProjectFileFromAbsolutePath(owner.projectId, owner.relativePath).catch(
      () => false
    )
    if (!opened) loose.push(file)
  }
  if (loose.length > 0) showOpenedFiles(loose)
}

/**
 * Show a project in the workspace: navigate to it and open its most recent
 * thread, so a file opened into the project is actually on screen.
 */
function focusProject(project: Project, deps: OsHandoffDeps): void {
  deps.navigate('projects')
  const thread = scopeState.allScopeThreads
    .filter((candidate) => candidate.projectId === project.id && !candidate.archived)
    .sort((left, right) => right.lastActivity - left.lastActivity)[0]
  if (thread) {
    workspaceState.openThread(thread, project)
  } else {
    workspaceState.clearThread()
    workspaceState.activeProject = project
  }
}

/** Focus the project that already covers an opened folder. */
function focusOpenedProject(project: Project, deps: OsHandoffDeps): void {
  focusProject(project, deps)
  toast.info(`${project.name} is already a project`, {
    description: 'Opened the existing project instead of adding the folder twice.'
  })
}

async function openDirectoryAsProject(directory: OpenedPath, deps: OsHandoffDeps): Promise<void> {
  try {
    const existing = await invoke('project:findByPath', directory.path)
    if (existing) {
      focusOpenedProject(existing, deps)
      return
    }
    // A folder that is not a git repository is registered with manual change
    // tracking instead of interrupting the OS hand-off with the
    // tracking-setup dialog; the mode stays editable from Edit project.
    const preflight = await invoke('repository:preflight', directory.path).catch(() => null)
    const project = await invoke('project:create', {
      name: directory.name,
      path: directory.path,
      source: 'local',
      changeTrackingMode: preflight?.status === 'git' ? 'git' : 'manual'
    })
    deps.navigate('projects')
    await deps.onProjectCreated(project)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'The folder could not be opened'
    captureError(message)
    showToastError(message)
  }
}
