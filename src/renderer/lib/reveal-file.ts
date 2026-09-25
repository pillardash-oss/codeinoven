import { invoke } from '$lib/ipc.svelte'
import { isAbsoluteishPath } from '$shared/paths'
import { isAbsoluteCitationPath, normalizeCitationPath } from '$lib/agent-source-citations'
import {
  filePreviewFlags,
  canAnnotateDocument
} from '$lib/components/files/project-files-panel-preview'
import { projectFilesWorkspace, type ProjectFileView } from '$lib/stores/project-files.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { toast } from 'svelte-sonner'
import { INBOX_PROJECT_ID, usesThreadWorkspaceMount } from '$shared/types'
import type { ProjectFileEntry } from '$shared/types'
import { fileUrlToPath } from '$lib/mime'

/** App-storage directory (sibling of chats-cwd) holding every chat thread's
 *  own artifact scratch directory. Must match the main-process constant; kept
 *  as a literal here so the renderer never imports main-process modules. */
const CHATS_ARTIFACTS_DIRECTORY = 'chats-artifacts'

/** Whether an absolute path sits inside the given inbox thread's artifact
 *  directory, and the mount-relative path below that directory. */
function chatArtifactRelativePath(threadId: string, absolutePath: string): string | null {
  const normalized = normalizeCitationPath(absolutePath)
  const marker = `/${CHATS_ARTIFACTS_DIRECTORY}/${threadId}/`
  const index = normalized.indexOf(marker)
  if (index < 0) return null
  return normalized.slice(index + marker.length)
}

/** The inbox thread whose artifact directory contains this path, if any. */
function chatArtifactThreadForPath(projectId: string, absolutePath: string): string | null {
  if (projectId !== INBOX_PROJECT_ID) return null
  const threadId =
    workspaceState.selectedThread?.projectId === projectId ? workspaceState.selectedThread.id : null
  if (!threadId) return null
  return absolutePath.includes(`/${CHATS_ARTIFACTS_DIRECTORY}/${threadId}/`) ? threadId : null
}

async function ensureProjectFilesReady(projectId: string, mountThreadId?: string): Promise<void> {
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
  // Conversations browse their own app-owned workspace directory (a chat's
  // artifact directory, an assistant task's working directory); the mount must
  // be registered before the root listing resolves through the thread root.
  if (usesThreadWorkspaceMount(projectId)) {
    projectFilesWorkspace.setThreadMount(projectId, mountThreadId ?? (threadId || null))
  }
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
  focusLine?: number,
  view: ProjectFileView = 'source'
): Promise<void> {
  if (entry.kind === 'file') {
    await projectFilesWorkspace.revealFile(projectId, entry.path)
    await projectFilesWorkspace.openFile(projectId, entry.path, view, focusLine)
    return
  }
  await projectFilesWorkspace.revealDirectory(projectId, entry.path)
}

async function exactEntry(projectId: string, path: string): Promise<ProjectFileEntry | null> {
  if (!path) return { name: '', path: '', kind: 'directory' }
  if (isAbsoluteishPath(path) || path.split('/').includes('..')) return null
  try {
    const info = await projectFilesWorkspace.fileInfo(projectId, path)
    return { name: info.name, path: info.path, kind: info.kind }
  } catch {
    return null
  }
}

export async function revealFileInAppTree(projectId: string, path: string): Promise<void> {
  const chatThread = chatArtifactThreadForPath(projectId, path)
  const projectPath = chatThread ? '' : workspaceState.activeProject?.path
  if (!chatThread && !projectPath) return

  await ensureProjectFilesReady(projectId, chatThread ?? undefined)
  const relativePath = chatThread
    ? (chatArtifactRelativePath(chatThread, path) ?? '')
    : relativeProjectPath(projectPath ?? '', path)
  const entry = await exactEntry(projectId, relativePath)
  if (entry) await revealEntry(projectId, entry)
}

/**
 * Open a file in a project's own editor from a path main already resolved to that
 * project (`project:findFileOwner`). Unlike {@link revealFileInAppTree} the
 * relative path is given rather than derived from the *active* project, so an OS
 * hand-off opens correctly whichever project happens to be on screen. Returns
 * whether the file was opened, so the caller can fall back to the standalone
 * viewer when the path no longer resolves inside the project.
 *
 * `focusLine` places the caret on one line, which is what a pull request thread
 * needs: its path and line are the only way back to the code being discussed.
 */
export async function openProjectFileFromAbsolutePath(
  projectId: string,
  relativePath: string,
  focusLine?: number
): Promise<boolean> {
  // Resolve on disk before preparing anything: a path that no longer exists must
  // not switch the project's file surface on.
  const entry = await exactEntry(projectId, relativePath)
  if (!entry) return false
  await ensureProjectFilesReady(projectId)
  await revealEntry(projectId, entry, focusLine)
  return true
}

/**
 * Bring one document on screen to be annotated: reveal it in the project's file
 * tree and open it in the annotate view, which is the only surface that draws a
 * document annotation's passage and note. Returns whether the document was
 * opened, so the caller can report one that has since been deleted instead of
 * opening an empty editor for it.
 *
 * A file that cannot carry a note is opened in its source view instead: only
 * rendered Markdown has selectable text to anchor an annotation to, so a document
 * renamed out from under an annotation still opens, just not as an annotator.
 */
export async function revealAnnotatedDocument(projectId: string, path: string): Promise<boolean> {
  if (!path || isAbsoluteishPath(path) || path.split('/').includes('..')) return false
  // Prepare the file surface before probing the path: a conversation's tree is
  // mounted on its own workspace directory, and the probe resolves through that
  // mount. The cost of preparing for a deleted document is a visible file tree,
  // which is also where the reader learns it is gone.
  await ensureProjectFilesReady(projectId)
  const entry = await exactEntry(projectId, path)
  if (!entry || entry.kind !== 'file') return false
  const view: ProjectFileView = canAnnotateDocument(filePreviewFlags(entry.path))
    ? 'annotate'
    : 'source'
  await revealEntry(projectId, entry, undefined, view)
  // `openFile` focuses a document that is already open without touching its
  // view, so a document the reader left in the diff or source view still has to
  // be pointed at the annotator.
  projectFilesWorkspace.setViewForPath(projectId, entry.path, view)
  return true
}

/** Route an explicit local file URL to the in-app tree or the OS file manager. */
export async function revealLocalFile(projectId: string | undefined, url: string): Promise<void> {
  if (!projectId || !url.startsWith('file://')) return

  const absolutePath = fileUrlToPath(url)
  // A generated chat artifact lives in the thread's own directory: reveal it
  // inside the chat's mounted tree even though no project path is active.
  const chatThread = chatArtifactThreadForPath(projectId, absolutePath)
  if (chatThread) {
    await revealFileInAppTree(projectId, absolutePath)
    return
  }

  const projectPath = workspaceState.activeProject?.path
  if (!projectPath) return

  const normalizedProjectPath = normalizeCitationPath(projectPath)
  const normalizedFilePath = normalizeCitationPath(absolutePath)
  if (
    normalizedFilePath === normalizedProjectPath ||
    normalizedFilePath.startsWith(`${normalizedProjectPath}/`)
  ) {
    await revealFileInAppTree(projectId, absolutePath)
    return
  }

  const revealed = await invoke('shell:revealExternalPath', absolutePath).catch(() => false)
  if (!revealed) {
    toast.error('This local file is outside the active project or no longer exists.')
  }
}

/**
 * Open a file citation in the app's file viewer. Citations are only rendered as
 * links once they are confirmed to exist on disk, so resolution is exact  
 * never a fuzzy name search that could open a different file (e.g. the wrong
 * `app.html` when several share a name). Agents that cite a path must prefix it
 * with the project's CWD so it resolves unambiguously.
 */
export async function revealCitationFile(
  projectId: string,
  citationPath: string,
  focusLine?: number
): Promise<void> {
  // A chat artifact citation (absolute path inside the thread's artifact
  // directory) resolves against the mounted chat tree, not a project root.
  const chatThread =
    chatArtifactThreadForPath(projectId, citationPath) ??
    (projectId === INBOX_PROJECT_ID && workspaceState.selectedThread?.projectId === projectId
      ? workspaceState.selectedThread.id
      : null)
  if (chatThread && citationPath.includes(`/${CHATS_ARTIFACTS_DIRECTORY}/${chatThread}/`)) {
    await revealFileInAppTree(projectId, citationPath)
    return
  }

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
    return
  }
  // Absolute citation outside the project root (e.g. Codex citations to files
  // the user supplied)   reveal in the OS file manager. `shell:revealExternalPath`
  // is a reveal-only probe: the path must exist and no content is read, so no
  // scope grant is required.
  if (isAbsoluteCitationPath(targetPath)) {
    const revealed = await invoke('shell:revealExternalPath', targetPath).catch(() => false)
    if (!revealed) {
      toast.error('This local file is outside the active project or no longer exists.')
    }
  }
}
