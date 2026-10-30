import { readFile } from 'fs/promises'
import { join } from 'path'
import { validateEntityId } from '../../ipc/ipc-validation'
import type { AgentArtifact, ImageDescriptorErrorRequest } from '../../../lib/types'
import { ensureFeatureSlug, featureArtifactDirectory } from '../../../lib/project-artifacts'
import type { ChatEngine } from '../chat-engine'

/** ChatEngine media-artifacts: one concern, moved verbatim from the composition root. */
export class ChatEngineMediaArtifacts {
  constructor(private readonly host: ChatEngine) {}

  /** Read one plan/progress artifact, or null when it is absent or empty. */
  async readPlanArtifact(path: string): Promise<{ text: string; path: string } | null> {
    try {
      const text = await readFile(path, 'utf8')
      return text.trim() ? { text, path } : null
    } catch {
      return null
    }
  }

  async listArtifacts(projectId: string, threadId: string): Promise<AgentArtifact[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    await this.host.threadCreation?.awaitReady(threadId)
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) return []
    const messages = await this.host.loadMessages(projectId, threadId)
    const projectPath = await this.host.units['turns'].resolveProjectPath(projectId)
    return this.host.state.generatedArtifactService.artifactsFor(thread, projectPath, messages)
  }

  /** List unresolved image-descriptor errors for renderer reconnect recovery. */
  async listImageDescriptorErrors(
    projectId: string,
    threadId: string
  ): Promise<ImageDescriptorErrorRequest[]> {
    projectId = validateEntityId(projectId, 'Project ID')
    threadId = validateEntityId(threadId, 'Thread ID')
    return [...this.host.state.pendingImageDescriptorDecisions.values()]
      .filter(
        (pending) => pending.projectId === projectId && pending.request.surfaceThreadId === threadId
      )
      .map((pending) => pending.request)
  }

  async artifactRef(projectId: string, threadId: string, file: string): Promise<string> {
    const featureSlug = await ensureFeatureSlug(this.host.database, projectId, threadId)
    return join(featureArtifactDirectory(featureSlug), file)
  }
}
