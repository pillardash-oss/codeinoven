import { Logger } from '../../system/logger'
import { broadcastThreadUpdate } from '../thread-events'
import { resolveCitedEntries } from '../cited-entries-service'
import { CITE_ENTRY_LIMIT, normalizeCitedPath, type CitedEntry } from '../../../lib/cited-work'
import { assistantReportIsTerminal } from '../../../lib/assistant-reports'
import { conversationWorkspaceDirectory } from '../../../lib/types'
import type { AgentMessage, Thread, ThreadStatus } from '../../../lib/types'
import { rawErrorMessage } from './chat-engine-errors'
import type { ChatEngine } from '../chat-engine'

/**
 * ChatEngine citations: the work a turn cites, and the cards it leaves behind.
 *
 * A turn knows what it produced and the app does not, so the announcing belongs
 * to the turn: it cites its reports, documents and folders through the app-owned
 * `cio:cite-report` capability, and this unit turns those paths into the cards
 * the conversation shows once the turn settles. Nothing is inferred from the
 * answer, so an ordinary reply leaves no card and a turn that built a folder of
 * scripts does not have to describe where it lives.
 */
export class ChatEngineCitations {
  constructor(private readonly host: ChatEngine) {}

  /**
   * Hold the paths a turn cited for its own settle.
   *
   * Resolving them here as well is what makes the tool honest while the turn is
   * still running: the reply names what will actually appear, so a turn learns
   * about a typo in a path before it writes its answer rather than after the
   * cards silently shrink.
   */
  async citeWork(
    projectId: string,
    threadId: string,
    paths: readonly string[]
  ): Promise<{ cited: Array<Pick<CitedEntry, 'name' | 'path' | 'kind'>>; missing: string[] }> {
    const thread = await this.host.threadManager.getThread(projectId, threadId)
    if (!thread) throw new Error(`Thread not found: ${threadId}`)
    const requested = paths
      .map((path) => normalizeCitedPath(path))
      .filter((path): path is string => path !== null)
    const root = await this.workspaceRoot(thread)
    const resolved = root ? await resolveCitedEntries(root, requested) : []
    const resolvedPaths = new Set(resolved.map((entry) => entry.path))
    const missing = requested.filter((path) => !resolvedPaths.has(path))

    const declared = this.host.state.declaredCitations.get(thread.id) ?? []
    const merged = new Set(declared)
    for (const entry of resolved) merged.add(entry.path)
    this.host.state.declaredCitations.set(thread.id, [...merged].slice(0, CITE_ENTRY_LIMIT))
    return {
      cited: resolved.map((entry) => ({
        name: entry.name,
        path: entry.path,
        kind: entry.kind
      })),
      missing
    }
  }

  /** Drop anything an earlier, unsettled turn cited on this thread. */
  clearCitedPaths(threadId: string): void {
    this.host.state.declaredCitations.delete(threadId)
  }

  /**
   * Publish the cards for one settled turn: what it cited, plus the report the
   * app filed on its behalf.
   *
   * The report is the exception because its path is app-owned: the app chooses
   * the file name and writes it after the turn ends, so the run cannot cite it
   * and the file would otherwise be one more thing the reader has to go looking
   * for. Everything else reaches the conversation only because the turn said so.
   */
  async publishCitedWork(
    thread: Thread,
    turnAssistant: AgentMessage | undefined,
    status: ThreadStatus
  ): Promise<void> {
    const filed = await this.host.units['assistant-authoring'].captureAssistantReport(
      thread,
      turnAssistant,
      status
    )
    const declared = this.host.state.declaredCitations.get(thread.id) ?? []
    this.host.state.declaredCitations.delete(thread.id)
    if (declared.length === 0 && !filed) return
    if (!assistantReportIsTerminal(status)) return

    try {
      const root = await this.workspaceRoot(thread)
      if (!root) return
      const entries = await resolveCitedEntries(root, declared)
      if (filed) {
        const [filedEntry] = await resolveCitedEntries(root, [filed.citation])
        if (filedEntry) {
          const already = entries.some((entry) => entry.path === filedEntry.path)
          if (!already) entries.unshift({ ...filedEntry, name: filed.title })
        }
      }
      if (entries.length === 0) return
      await this.publishEntries(thread, entries)
    } catch (error) {
      Logger.error('Cited work could not be published to its thread', {
        threadId: thread.id,
        error: rawErrorMessage(error)
      })
    }
  }

  private async publishEntries(thread: Thread, entries: CitedEntry[]): Promise<void> {
    const at = Date.now()
    const id = `cio-cited-work-${thread.id}-${at}`
    const message: AgentMessage = {
      id,
      role: 'assistant',
      inlineArtifact: true,
      origin: 'orchestrator',
      visibility: 'conversation',
      parts: entries.map((entry, index) => ({
        type: 'cited' as const,
        id: `${id}-${index}`,
        messageID: id,
        name: entry.name,
        path: entry.path,
        kind: entry.kind,
        modifiedAt: entry.modifiedAt
      })),
      createdAt: at,
      completedAt: at
    }
    await this.host.threadManager.upsertMessages(thread.projectId, thread.id, [message])
    broadcastThreadUpdate(thread)
  }

  /** The directory a thread's cited paths resolve against, or null when it has none. */
  private async workspaceRoot(thread: Thread): Promise<string | null> {
    const directory = conversationWorkspaceDirectory(
      thread.projectId,
      thread.id,
      thread.assistantId
    )
    if (directory) {
      await this.host.storage.ensureDirectory(directory)
      return this.host.storage.resolve(directory)
    }
    try {
      return await this.host.units['turns'].resolveProjectPath(thread.projectId)
    } catch (error) {
      Logger.error('A cited path had no workspace to resolve against', {
        threadId: thread.id,
        error: rawErrorMessage(error)
      })
      return null
    }
  }
}
