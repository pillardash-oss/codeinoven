import type { IpcHandlerContext } from '../context'

/** Open a project in the user's preferred editor. */
export function registerProjectEditorHandlers(ctx: IpcHandlerContext): void {
  const { storage, projectManager, editorService, privileged } = ctx

  privileged('project:openInEditor', async (_event, projectId: string) => {
    const project = await projectManager.getProject(projectId)
    if (!project?.path) return

    const config = await storage.getConfig()
    await editorService.openInEditor(config.preferredEditor, project.path)
  })
}
