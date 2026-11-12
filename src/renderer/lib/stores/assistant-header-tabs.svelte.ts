import type { Assistant, Thread } from '$shared/types'

/**
 * The workspace's half of the assistant header strip.
 *
 * The strip lives in the app header, which is painted by the app shell, while the
 * threads and the actions that operate on them live in the workspace board. The
 * workspace publishes both here, so the header can name the open assistant's
 * threads without owning a second copy of the thread list or a second delete
 * path.
 */
export interface AssistantHeaderActions {
  /** Open one assistant thread exactly as its row did. */
  openThread: (thread: Thread) => void
  /** Delete one assistant thread, with the list cleanup the sidebar used. */
  deleteThread: (thread: Thread) => Promise<void>
  /** Rename one assistant thread, behind the shared rename dialog. */
  renameThread: (thread: Thread, newName: string) => Promise<void>
  /** Pin or unpin one assistant thread. */
  togglePinThread: (thread: Thread) => void
  /** Fork one assistant thread. */
  forkThread: (thread: Thread) => void
  /** Open one assistant thread's note panel. */
  openThreadNotes: (thread: Thread) => void
  /** Hide an assistant's Getting started thread, which cannot be deleted. */
  hideKnowledgeThread: (thread: Thread) => void
  /** Open the assistant's behaviour (knowledge) panel. */
  openAssistantBehaviour: (assistant: Assistant) => void
  /** Create a task inside an assistant. */
  createTask: (assistant: Assistant) => void
  /** Remove an assistant and everything it owns. */
  deleteAssistant: (assistantId: string) => Promise<void>
}

class AssistantHeaderTabsState {
  /**
   * Every assistant-space thread the workspace holds, tasks and the runs of their
   * executions alike. The strip narrows this to the open assistant and takes the
   * most recently active ones.
   */
  threads: Thread[] = $state([])

  #actions: AssistantHeaderActions | null = null

  publishThreads(threads: Thread[]): void {
    this.threads = threads
  }

  publishActions(actions: AssistantHeaderActions): void {
    this.#actions = actions
  }

  openThread(thread: Thread): void {
    this.#actions?.openThread(thread)
  }

  deleteThread(thread: Thread): Promise<void> {
    return this.#actions?.deleteThread(thread) ?? Promise.resolve()
  }

  renameThread(thread: Thread, newName: string): Promise<void> {
    return this.#actions?.renameThread(thread, newName) ?? Promise.resolve()
  }

  togglePinThread(thread: Thread): void {
    this.#actions?.togglePinThread(thread)
  }

  forkThread(thread: Thread): void {
    this.#actions?.forkThread(thread)
  }

  openThreadNotes(thread: Thread): void {
    this.#actions?.openThreadNotes(thread)
  }

  hideKnowledgeThread(thread: Thread): void {
    this.#actions?.hideKnowledgeThread(thread)
  }

  createTask(assistant: Assistant): void {
    this.#actions?.createTask(assistant)
  }

  openAssistantBehaviour(assistant: Assistant): void {
    this.#actions?.openAssistantBehaviour(assistant)
  }

  deleteAssistant(assistantId: string): Promise<void> {
    return this.#actions?.deleteAssistant(assistantId) ?? Promise.resolve()
  }
}

export const assistantHeaderTabs = new AssistantHeaderTabsState()
