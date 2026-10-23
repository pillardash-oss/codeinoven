import { invoke } from '$lib/ipc.svelte'
import { isAbsoluteishPath } from '$shared/paths'
import { isAbsoluteCitationPath, normalizeCitationPath } from '$lib/agent-source-citations'
import {
  filePreviewFlags,
  canAnnotateDocument
} from '$lib/components/files/project-files-panel-preview'
import { revealInOsFileManager } from '$lib/os-file-manager'
import { projectFilesWorkspace, type ProjectFileView } from '$lib/stores/project-files.svelte'
import { citationPathsState } from '$lib/stores/citation-paths.svelte'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { workspaceState } from '$lib/stores/workspace.svelte'
import { toast } from 'svelte-sonner'
import { conversationWorkspaceDirectory, usesThreadWorkspaceMount } from '$shared/types'
import type { ProjectFileEntry } from '$shared/types'
import { fileUrlToPath } from '$lib/mime'

/**
 * The open conversation thread whose app-owned workspace directory a cited path
 * belongs to, with that path below the directory.
 *
 * A chat, an assistant task, and a browser tab each own an app-storage
 * directory mounted as their file tree (`chats-cwd/<threadId>`,
 * `assistant-cwd/<assistantId ?? threadId>`, `browser-cwd/<threadId>`). An agent
 * citing from one of them writes either the absolute path or, more often, the
 * path relative to the directory it is working in (`.cio/tmp/report.md`), and
 * both name the same entry. Only the conversation the view is showing can own
 * it - a tree mounts one directory at a time - so the open thread decides which
 * mount to strip.
 */
function conversationWorkspaceTarget(
  projectId: string,
  citedPath: string
): { threadId: string; relativePath: string } | null {
  if (!usesThreadWorkspaceMount(projectId)) return null
  const thread = workspaceState.selectedThread
  if (!thread || thread.projectId !== projectId) return null
  const directory = conversationWorkspaceDirectory(projectId, thread.id, thread.assistantId)
  if (!directory) return null
  const normalized = normalizeCitationPath(citedPath)
  if (!normalized) return null
  if (!isAbsoluteCitationPath(normalized)) return { threadId: thread.id, relativePath: normalized }
  const marker = `/${directory}/`
  const index = normalized.indexOf(marker)
  if (index < 0) return null
  return { threadId: thread.id, relativePath: normalized.slice(index + marker.length) }
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
  // workspace directory, an assistant task's working directory); the mount must
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

/** Whether a normalized path is a directory root itself or lives below it. */
function insideRoot(root: string, path: string): boolean {
  const normalizedRoot = normalizeCitationPath(root)
  if (!normalizedRoot) return false
  const target = normalizeCitationPath(path)
  return target === normalizedRoot || target.startsWith(`${normalizedRoot}/`)
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

/**
 * Reveal one path from a surface that lists files the app does not necessarily
 * own: a conversation source row, an attachment, a generated artifact, a cited
 * path.
 *
 * A click on such a row can never assume the file lives inside the project that
 * happens to be on screen: users attach files and agents cite files from
 * anywhere on disk, while the app tree mounts exactly one directory at a time.
 * The surface is therefore chosen from where the path actually lives - the
 * conversation's own app-owned workspace directory, then the active project's
 * root, and otherwise the OS file manager. `shell:revealExternalPath` is a
 * reveal-only probe (the path must exist, no content is read, no scope grant
 * needed), so an outside file opens in Finder/Explorer instead of a click that
 * does nothing. A path no tree can show and the OS cannot find is reported.
 */
export async function revealSourceFilePath(
  projectId: string | undefined,
  absolutePath: string
): Promise<void> {
  if (!absolutePath) return
  if (projectId && conversationWorkspaceTarget(projectId, absolutePath)) {
    await revealFileInAppTree(projectId, absolutePath)
    return
  }
  const activeProject = workspaceState.activeProject
  if (activeProject && insideRoot(activeProject.path, absolutePath)) {
    await revealFileInAppTree(activeProject.id, absolutePath)
    return
  }
  if (!isAbsoluteishPath(absolutePath)) return
  const revealed =
    (await revealInOsFileManager(absolutePath)) ||
    (await invoke('shell:revealExternalPath', absolutePath).catch(() => false))
  if (!revealed) {
    toast.error('This local file is outside the active project or no longer exists.')
  }
}

export async function revealFileInAppTree(projectId: string, path: string): Promise<void> {
  const conversation = conversationWorkspaceTarget(projectId, path)
  const projectPath = conversation ? '' : workspaceState.activeProject?.path
  if (!conversation && !projectPath) return
  // The app tree mounts the active project root or one conversation workspace
  // directory, so an absolute path outside it can never resolve below the root:
  // strip-to-relative turns it into the absolute path itself and the reveal ends
  // in silence. Reveal such a path where it actually lives instead.
  if (!conversation && isAbsoluteishPath(path) && !insideRoot(projectPath ?? '', path)) {
    await revealSourceFilePath(projectId, path)
    return
  }

  await ensureProjectFilesReady(projectId, conversation?.threadId)
  const relativePath = conversation
    ? conversation.relativePath
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
 * Reveal a file main already resolved to a project (`project:findFileOwner`) in
 * that project's own file tree. Like {@link openProjectFileFromAbsolutePath} the
 * relative path is given rather than derived from the *active* project, so a
 * reveal lands in the right tree whichever project happens to be on screen.
 * Returns whether the entry resolved, so the caller can fall back to the OS file
 * manager instead of leaving a click with no visible result.
 */
export async function revealProjectFileFromAbsolutePath(
  projectId: string,
  relativePath: string
): Promise<boolean> {
  const entry = await exactEntry(projectId, relativePath)
  if (!entry) return false
  await ensureProjectFilesReady(projectId)
  await revealEntry(projectId, entry)
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

/**
 * The project-relative reading of a `file://` URL's path, when it has one.
 *
 * Agents spell a project file as `file:///.cio/videos/launch/index.html` as
 * readily as they spell it `file://apps/marketing/src/app.html`, and read as a
 * URL the former starts at the machine's filesystem root. Dropping the leading
 * slash turns it back into the path its author meant; a URL that already names
 * a project-relative path is returned unchanged.
 */
function projectRelativeFileUrlPath(absolutePath: string): string | null {
  const normalized = normalizeCitationPath(absolutePath)
  if (!normalized || normalized.includes('..')) return null
  const relative = normalized.startsWith('/') ? normalized.slice(1) : normalized
  return relative.length > 0 ? relative : null
}

/** Route an explicit local file URL to the in-app tree or the OS file manager. */
export async function revealLocalFile(projectId: string | undefined, url: string): Promise<void> {
  if (!projectId || !url.startsWith('file://')) return
  const absolutePath = fileUrlToPath(url)
  // A link only counts as a project file once the store confirmed the path
  // exists inside the mount, so a real `file:///Users/...` URL outside the
  // project is never mistaken for one and never prepares a file tree it has no
  // entry in. Clicking a path that resolves nowhere still reports it through
  // `revealSourceFilePath` instead of leaving the click with no result.
  const projectRelative = projectRelativeFileUrlPath(absolutePath)
  if (projectRelative && citationPathsState.isValidPath(projectRelative)) {
    await revealCitationFile(projectId, projectRelative)
    return
  }
  await revealSourceFilePath(projectId, absolutePath)
}

/**
 * Reveal one attachment file on disk: a composer attachment, or the same file
 * once it has been sent as a message.
 *
 * Main decides whether the file sits inside a project root, because attachments
 * live in app scratch space rather than in the project's own tree: a local
 * project keeps them in `.cio/tmp/attachments/<threadId>`, a chat keeps them
 * under the config root. A file inside a project root is revealed in that
 * project's file tree; every other existing file goes to the OS file manager,
 * which is the only surface that can show it. `shell:revealExternalPath` takes
 * an existing absolute path and never reads its contents, so no scope grant is
 * needed for that half.
 *
 * Both probes are existence-based, so a file neither tree can show is reported
 * as gone: that is what a deleted or moved attachment looks like.
 */
export async function revealAttachmentFile(url: string): Promise<void> {
  if (!url.startsWith('file://')) return

  const absolutePath = fileUrlToPath(url)
  const owner = await invoke('project:findFileOwner', absolutePath).catch(() => null)
  if (owner) {
    const revealed = await revealProjectFileFromAbsolutePath(
      owner.projectId,
      owner.relativePath
    ).catch(() => false)
    if (revealed) return
  }

  const revealed = await invoke('shell:revealExternalPath', absolutePath).catch(() => false)
  if (!revealed) {
    toast.info("File doesn't exist, it may have been deleted.")
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
  // A path inside a conversation's own workspace directory (a chat's, an
  // assistant task's, a browser tab's) resolves against that conversation's
  // mounted tree, not a project root - and those containers have no project
  // path at all.
  if (conversationWorkspaceTarget(projectId, citationPath)) {
    await revealFileInAppTree(projectId, citationPath)
    return
  }

  const projectPath = workspaceState.activeProject?.path
  if (!projectPath) return

  let targetPath = citationPath
  if (focusLine === undefined) {
    const location = citationPath.match(/:(\d+)(?:-\d+)?$/u)
    if (location) {
      focusLine = Number(location[1])
      targetPath = citationPath.slice(0, -location[0].length)
    }
  }

  // An absolute citation outside the project root (a file the user supplied, a
  // sibling checkout, app scratch space) is resolved before the project tree is
  // prepared: opening that tree and failing inside it is what made an outside
  // click look like a broken in-project reveal.
  if (isAbsoluteCitationPath(targetPath) && !insideRoot(projectPath, targetPath)) {
    await revealSourceFilePath(projectId, targetPath)
    return
  }

  await ensureProjectFilesReady(projectId)

  const relativePath = relativeProjectPath(projectPath, targetPath)
  const exact = await exactEntry(projectId, relativePath)
  if (exact) {
    await revealEntry(projectId, exact, focusLine)
    return
  }
  // An absolute path the tree could not resolve still exists on disk: reveal it
  // in the OS file manager rather than leaving the click with no result.
  if (isAbsoluteCitationPath(targetPath)) {
    const revealed =
      (await revealInOsFileManager(targetPath)) ||
      (await invoke('shell:revealExternalPath', targetPath).catch(() => false))
    if (!revealed) {
      toast.error('This local file is outside the active project or no longer exists.')
    }
  }
}
