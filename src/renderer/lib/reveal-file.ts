import { invoke } from '$lib/ipc.svelte'
import { normalizeCitationPath } from '$lib/agent-source-citations'
import { projectFilesWorkspace } from '$lib/stores/project-files.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import type { ProjectFileEntry } from '$shared/types'

async function ensureProjectFilesReady(projectId: string): Promise<void> {
  const activeThreadId = contextSidebarState.threadIdForProject(projectId)
  const selectedThreadId =
    workspaceState.selectedThread?.projectId === projectId ? workspaceState.selectedThread.id : ''
  const threadId = selectedThreadId || activeThreadId || ''

  // Citation clicks must be able to create the file surface themselves.
  // Prepare both reactive stores synchronously so Workspace can mount the
  // sidebar immediately while the directory IPC request continues.
  projectFilesWorkspace.ensureState(projectId)
  if (activeThreadId !== threadId) contextSidebarState.activateThread(projectId, threadId)
  contextSidebarState.openFiles(projectId, threadId)
  await projectFilesWorkspace.loadDirectory(projectId, '')
}

function relativeProjectPath(projectPath: string, citedPath: string): string {
  const root = normalizeCitationPath(projectPath)
  const target = normalizeCitationPath(citedPath)
  if (target === root) return ''
  return target.startsWith(`${root}/`) ? target.slice(root.length + 1) : target
}

async function revealEntry(
  projectId: string,
  entry: ProjectFileEntry,
  focusLine?: number
): Promise<void> {
  if (entry.kind === 'file') {
    await projectFilesWorkspace.revealFile(projectId, entry.path)
    await projectFilesWorkspace.openFile(projectId, entry.path, 'source', focusLine)
    return
  }
  await projectFilesWorkspace.revealDirectory(projectId, entry.path)
}

async function exactEntry(projectId: string, path: string): Promise<ProjectFileEntry | null> {
  if (!path) return { name: '', path: '', kind: 'directory' }
  if (path.startsWith('/') || path.split('/').includes('..')) return null
  try {
    const info = await invoke('projectFiles:info', projectId, path)
    return { name: info.name, path: info.path, kind: info.kind }
  } catch {
    return null
  }
}

export async function revealFileInAppTree(projectId: string, path: string): Promise<void> {
  const projectPath = workspaceState.activeProject?.path
  if (!projectPath) return

  await ensureProjectFilesReady(projectId)
  const relativePath = relativeProjectPath(projectPath, path)
  const entry = await exactEntry(projectId, relativePath)
  if (entry) await revealEntry(projectId, entry)
}

/**
 * Open a file citation in the app's file viewer. Citations are only rendered as
 * links once they are confirmed to exist on disk, so resolution is exact —
 * never a fuzzy name search that could open a different file (e.g. the wrong
 * `app.html` when several share a name). Agents that cite a path must prefix it
 * with the project's CWD so it resolves unambiguously.
 */
export async function revealCitationFile(
  projectId: string,
  citationPath: string,
  focusLine?: number
): Promise<void> {
  const projectPath = workspaceState.activeProject?.path
  if (!projectPath) return

  await ensureProjectFilesReady(projectId)

  let targetPath = citationPath
  if (focusLine === undefined) {
    const location = citationPath.match(/:(\d+)(?:-\d+)?$/u)
    if (location) {
      focusLine = Number(location[1])
      targetPath = citationPath.slice(0, -location[0].length)
    }
  }

  const relativePath = relativeProjectPath(projectPath, targetPath)
  const exact = await exactEntry(projectId, relativePath)
  if (exact) {
    await revealEntry(projectId, exact, focusLine)
  }
}
