import { invoke } from '$lib/ipc.svelte'
import { fileUrlToPath, pathToFileUrl } from '$lib/mime'
import { speechController } from '$lib/speech/speech-controller.svelte'
import { reportError } from '$lib/stores/app-errors.svelte'
import { assistants } from '$lib/stores/assistants.svelte'
import { chatDraft } from '$lib/stores/chat-draft'
import { contextSidebarState } from '$lib/stores/context-sidebar.svelte'
import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
import { scopeState } from '$lib/stores/scope.svelte'
import { threadMessages } from '$lib/stores/thread-messages.svelte'
import { threadProjectFilterState } from '$lib/stores/thread-project-filter.svelte'
import { threadSettings } from '$lib/stores/thread-settings.svelte'
import { threadUnreadIntent } from '$lib/stores/thread-unread-intent'
import {
  findEmptyNewThread,
  pinnedThreadSort,
  splitTimelineThreads,
  threadSort,
  threadVisitKey,
  workspaceState
} from '$lib/stores/workspace.svelte'
import { logRendererError } from '$lib/system/renderer-logger'
import { settingsForNewChat, threadWithInheritedSettings } from '$lib/thread-settings-inheritance'
import { toPosixPath } from '$shared/paths'
import { withDefaultAssistantPrimary } from '$shared/assistant-agents'
import type { Project, PromptAttachment, Assistant, Thread, ThreadSettings } from '$shared/types'
import {
  ASSISTANT_PLACEHOLDER_NAME,
  ASSISTANT_SPACE_ID,
  DEFAULT_THREAD_TITLE,
  DRAFT_CHAT_THREAD_ID,
  INBOX_PROJECT_ID
} from '$shared/types'

import { SvelteMap, SvelteSet } from 'svelte/reactivity'
import type { NewAssistantDraft } from '../../assistant/assistant-create'
import type { Workspace } from './Workspace-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the Workspace board. */
export class WorkspaceMarkThreadReadAndApply extends BoardUnit<Workspace> {
  constructor(root: Workspace) {
    super(root)
  }
  /** Remounts the empty-state chats composer to restore a failed first send. */
  chatsComposerRestoreKey = $state(0)

  /**
   * The threads the user is writing into: unsent typed content, attachments and
   * references, plus a live voice capture.
   *
   * The narrower of the two composer sets, and the one that earns the Threads
   * view's Drafts section: a message already sent and waiting behind a turn is a
   * finished action, so it stays out of this set and out of that section. A live
   * dictation counts as writing, because from the first mic press through
   * transcription the user is composing with their voice.
   */
  typingThreadKeys = $derived.by(() => {
    const keys = new SvelteSet<string>()
    // Only threads that actually hold unsent content belong here, and the draft
    // Store is the authority on which those are. Scanning every thread instead
    // asked `hasTypedContent` about each one, which materialized an empty draft
    // entry (six arrays) per thread and subscribed to a draft slot per thread,
    // on every keystroke. A stored entry is dropped the moment it holds nothing,
    // and the check keeps the set honest if one is ever kept empty.
    for (const ref of rendererRecovery.listDraftThreadRefs()) {
      if (!rendererRecovery.hasTypedContent(ref.projectId, ref.threadId)) continue
      keys.add(`${ref.projectId}:${ref.threadId}`)
    }
    // Only one scope captures at a time, so the thread scan below costs nothing
    // with the mic closed.
    if (speechController.capturingScope) {
      for (const t of this.root.createThreadInProject.allThreads) {
        if (!t.archived && speechController.isCapturingThread(t.id)) {
          keys.add(threadVisitKey(t))
        }
      }
    }
    return keys
  })

  /** Threads holding any unsent composer content stay pinned at the top of their list,
      even after the user navigates away, so they are easy to find mid-task. Wider
      than `typingThreadKeys`: a queued message counts here too, because it is
      still waiting on the thread. An active voice capture counts as draft
      activity, so draft status drives sort order regardless of whether the user
      is typing or dictating. */
  draftThreadKeys = $derived.by(() => {
    const keys = new SvelteSet(this.typingThreadKeys)
    for (const ref of rendererRecovery.queuedMessageThreads()) {
      keys.add(`${ref.projectId}:${ref.threadId}`)
    }
    return keys
  })

  // ─── Derived ─────────────────────────────────────────────────────────────

  pinnedThreads = $derived(
    this.root.createThreadInProject.allThreads
      .filter(
        (t) =>
          t.pinned &&
          !t.archived &&
          t.projectId !== INBOX_PROJECT_ID &&
          // Assistant tasks live only in Assistant View: a pinned assistant
          // thread (every assistant's knowledge thread is pinned) must never surface
          // in the Projects sidebar's pinned section.
          t.projectId !== ASSISTANT_SPACE_ID
      )
      .sort((a, b) => pinnedThreadSort(a, b, this.draftThreadKeys))
  )

  pinnedProjects = $derived(this.root.mergeThreadsInList.visibleProjects.filter((p) => p.pinned))

  // ─── Assistant space ──────────────────────────────────────────────────────
  /** The hidden assistant container (assistant tasks live here). */
  assistantProject = $derived(
    this.root.createThreadInProject.projects.find((project) => project.id === ASSISTANT_SPACE_ID) ??
      null
  )

  /** Assistant tasks, most recent activity first. A run is not a task, so the
   *  sidebar, the shortcuts, and the panel never treat one as a task. */
  assistantTasks = $derived(
    this.root.mergeThreadsInList.assistantThreads
      .filter((thread) => !thread.assistantTaskId)
      .sort((a, b) => b.lastActivity - a.lastActivity)
  )

  threadsByProject = $derived.by(() => {
    const map = new SvelteMap<string, Thread[]>()
    for (const t of this.root.createThreadInProject.allThreads) {
      // Bookmarks stay in their project's strip in Projects view. Other pinned
      // threads live exclusively in the Pinned section.
      if (t.archived || (t.pinned && !t.bookmarked)) continue
      const list = map.get(t.projectId) ?? []
      list.push(t)
      map.set(t.projectId, list)
    }
    // Working threads first, then by activity
    for (const list of map.values()) {
      list.sort((a, b) => threadSort(a, b, this.draftThreadKeys))
    }
    return map
  })

  /** Pinned standalone chats (inbox project), ordered newest-pinned first. */
  pinnedInboxThreads = $derived(
    this.root.createThreadInProject.allThreads
      .filter((t) => t.projectId === INBOX_PROJECT_ID && !t.archived && t.pinned)
      .sort((a, b) => pinnedThreadSort(a, b, this.draftThreadKeys))
  )

  /** Non-pinned standalone chats (inbox project), working first then by activity. */
  standaloneThreads = $derived(
    this.root.createThreadInProject.allThreads
      .filter((t) => t.projectId === INBOX_PROJECT_ID && !t.archived && !t.pinned)
      .sort((a, b) => threadSort(a, b, this.draftThreadKeys))
  )

  /** Threads mode: the filtered active threads as the two lists the timeline
   *  renders   the pinned rows that open the view, then every row that carries
   *  its own status, ordered by status and then by the row's own place in it. An
   *  empty project-filter selection means all projects. */
  timelineLists = $derived.by(() =>
    splitTimelineThreads(
      this.root.createThreadInProject.allThreads.filter(
        (t) =>
          !t.archived &&
          t.projectId !== INBOX_PROJECT_ID &&
          // Assistant tasks are Assistant View's own rows, never the Threads
          // timeline's, so a pinned knowledge thread cannot appear among them.
          t.projectId !== ASSISTANT_SPACE_ID &&
          threadProjectFilterState.matches(t.projectId)
      ),
      this.draftThreadKeys
    )
  )

  /** Every thread the Threads timeline lists, before its project filter. */
  timelineThreads = $derived(
    this.root.createThreadInProject.allThreads.filter(
      (thread) =>
        !thread.archived &&
        thread.projectId !== INBOX_PROJECT_ID &&
        thread.projectId !== ASSISTANT_SPACE_ID
    )
  )

  /**
   * Whether the active view's left sidebar has anything to show.
   *
   * Emptiness is judged on the view's own lists before any search or project
   * filter, because collapsing the sidebar over a filter the user applied would
   * take away the very control they filtered with. A first page that has not
   * landed yet is not content either: a view with nothing in it paints no panel
   * and offers no toggle row, so the panel arrives together with the rows that
   * justify it instead of standing empty for the length of the load, which is
   * exactly the shape a project-less or chat-less view starts in.
   */
  workspaceSidebarHasContent = $derived.by(() => {
    if (workspaceState.specStudioOpen) return true
    if (this.root.props.mode === 'assistant') {
      // A run is content too: a thread opened from a notification can be a run
      // whose task sits beyond the bounded recent slice, and its row must still
      // have a sidebar to appear in.
      return (
        this.root.mergeThreadsInList.assistantList.length > 0 ||
        this.assistantTasks.length > 0 ||
        this.root.mergeThreadsInList.assistantRuns.length > 0
      )
    }
    if (this.root.props.mode === 'chats') {
      return this.pinnedInboxThreads.length > 0 || this.standaloneThreads.length > 0
    }
    if (this.root.props.mode === 'threads') return this.timelineThreads.length > 0
    // Projects: the tree needs a project or a thread, and the scoped stage board
    // docks its own rail over it.
    return (
      Boolean(scopeState.sidebarContext) ||
      this.pinnedProjects.length > 0 ||
      this.root.mergeThreadsInList.regularProjects.length > 0 ||
      this.pinnedThreads.length > 0
    )
  })

  /**
   * Whether the left sidebar is painted at all. A sidebar with nothing in it is
   * not rendered, so no dock and no edge-hover overlay offer a panel with no
   * content.
   */
  workspaceSidebarVisible = $derived(this.workspaceSidebarHasContent)

  /**
   * Manual reorder of the sidebar pinned section. Pin order is one shared
   * global sequence across every project group, so a drop relative to any
   * thread   same project or not   inserts the dragged thread at that point in
   * the global order. Visually the thread stays in its own project group and
   * lands at the group edge nearest the drop (top when dropped above a higher
   * group, bottom when dropped below a lower one). Rewrites pinned_at so the
   * first thread is most-recently pinned (top), applied optimistically so the
   * section reorders the moment the user drops.
   */
  async handlePinnedThreadMove(
    draggedId: string,
    targetId: string,
    position: 'before' | 'after'
  ): Promise<void> {
    const pinnedIds = this.pinnedThreads.map((t) => t.id)
    const fromIdx = pinnedIds.indexOf(draggedId)
    const toIdx = pinnedIds.indexOf(targetId)
    if (fromIdx === -1 || toIdx === -1) return

    pinnedIds.splice(fromIdx, 1)
    const adjustedTo = pinnedIds.indexOf(targetId)
    if (adjustedTo === -1) return
    pinnedIds.splice(position === 'before' ? adjustedTo : adjustedTo + 1, 0, draggedId)

    // Optimistic: assign new pinned_at immediately so the pinned section
    // reorders on drop, before the persisted result returns.
    const base = Date.now()
    this.root.createThreadInProject.allThreads = this.root.createThreadInProject.allThreads.map(
      (t) => {
        const index =
          t.pinned && !t.archived && t.projectId !== INBOX_PROJECT_ID ? pinnedIds.indexOf(t.id) : -1
        return index !== -1 ? { ...t, pinnedAt: base - index } : t
      }
    )

    const updated = await invoke('thread:reorderPinnedGlobal', pinnedIds)
    for (const t of updated) {
      this.root.createThreadInProject.upsertThreadInList(t)
    }
  }

  // ─── Thread actions ──────────────────────────────────────────────────────

  /** A client-side id for an optimistic thread, so the row mounts before the
   *  create round trip and keeps the same id once the server confirms it. */
  newOptimisticThreadId(): string {
    const bytes = new Uint8Array(12)
    crypto.getRandomValues(bytes)
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
  }

  /** The hidden inbox project when it is already loaded. Chats live in it, but a
   *  launch that never held one does not have it yet, so the create path asks the
   *  main process for it instead. */
  inboxProject(): Project | null {
    return (
      this.root.createThreadInProject.projects.find(
        (candidate) => candidate.id === INBOX_PROJECT_ID
      ) ?? null
    )
  }

  /** The chat a new chat is minted from: the thread in focus when it is a chat. */
  selectedChatThread(): Thread | null {
    const selected = workspaceState.selectedThread
    return selected?.projectId === INBOX_PROJECT_ID ? selected : null
  }

  /**
   * Start a fresh standalone chat. A chat is a project-less thread, so this
   * behaves exactly like a project's New thread: the blank row goes into the
   * Chats sidebar on the same tick as the click and opens, and its label follows
   * what the user types through the shared draft-label path. A blank chat already
   * sitting there is reused instead of stacking a second empty row beside it.
   */
  startNewChat(): void {
    const existing = findEmptyNewThread(
      this.root.createThreadInProject.allThreads,
      INBOX_PROJECT_ID,
      undefined
    )
    // A blank row that predates this click is refreshed from the chat in focus,
    // so a reused row never stands on the Oven it happened to be created with.
    const source = existing ? this.selectedChatThread() : null
    const inherited = source?.settings ? settingsForNewChat(source, threadSettings.lastUsed) : null
    if (existing) {
      const thread = inherited ? threadWithInheritedSettings(existing, inherited) : existing
      threadMessages.seedEmpty(INBOX_PROJECT_ID, existing.id)
      this.root.createThreadInProject.upsertThreadInList(thread)
      if (inherited) {
        void invoke('thread:updateSettings', INBOX_PROJECT_ID, existing.id, inherited)
          .then((updated) => this.root.createThreadInProject.upsertThreadInList(updated))
          .catch(() => {})
      }
      // The blank row is already the chat the click asked for.
      if (workspaceState.selectedThread?.id === existing.id) {
        workspaceState.requestFocusComposer()
        return
      }
      workspaceState.openThread(thread, this.inboxProject())
      return
    }
    this.openNewChatThread()
  }

  /**
   * Put a blank chat row in the Chats sidebar and open it, mirroring a project's
   * optimistic New thread: the row mounts on the same tick and the server
   * confirms it in the background under the same id, so nothing typed while the
   * create round trip is in flight is lost.
   */
  openNewChatThread(): void {
    const optimisticId = this.newOptimisticThreadId()
    const settings = settingsForNewChat(this.selectedChatThread(), threadSettings.lastUsed)
    const optimisticThread: Thread = {
      id: optimisticId,
      projectId: INBOX_PROJECT_ID,
      providerId: 'pi',
      title: DEFAULT_THREAD_TITLE,
      titleSource: 'default',
      status: 'created',
      pinned: false,
      archived: false,
      read: true,
      settings,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastActivity: Date.now(),
      workingDirectory: ''
    }
    this.root.createThreadInProject.upsertThreadInList(optimisticThread)
    threadMessages.seedEmpty(INBOX_PROJECT_ID, optimisticId)
    workspaceState.openThread(optimisticThread, this.inboxProject())
    void this.persistNewChatThread(optimisticId, settings)
  }

  async persistNewChatThread(optimisticId: string, settings: ThreadSettings): Promise<void> {
    try {
      // The inbox project is created on demand, so a launch that has never held
      // a chat has to ask for it before the thread can be persisted into it.
      const inbox = this.inboxProject() ?? (await invoke('project:ensureInbox'))
      const created = await invoke('thread:create', {
        id: optimisticId,
        projectId: INBOX_PROJECT_ID,
        providerId: 'pi',
        title: DEFAULT_THREAD_TITLE,
        workingDirectory: '',
        settings
      })
      this.root.createThreadInProject.upsertThreadInList(created)
      if (workspaceState.selectedThread?.id === optimisticId) {
        workspaceState.openThread(created, inbox)
      }
    } catch (error) {
      // Creation failed   drop the optimistic row so the view never strands on a
      // phantom chat, and fall back to the thread-less welcome composer.
      const index = this.root.createThreadInProject.allThreads.findIndex(
        (candidate) => candidate.id === optimisticId
      )
      if (index !== -1) this.root.createThreadInProject.allThreads.splice(index, 1)
      if (workspaceState.selectedThread?.id === optimisticId) {
        workspaceState.clearThread()
      }
      reportError(error, 'The new chat could not be created.')
    }
  }

  /** Create a standalone (project-less) chat thread inside the hidden inbox. */
  async createInboxThread(): Promise<{ thread: Thread; inbox: Project }> {
    const inbox = await invoke('project:ensureInbox')
    const thread = await invoke('thread:create', {
      projectId: inbox.id,
      providerId: 'pi',
      title: DEFAULT_THREAD_TITLE,
      workingDirectory: '',
      settings: settingsForNewChat(this.selectedChatThread(), threadSettings.lastUsed)
    })
    return { thread, inbox }
  }

  /**
   * In-flight creation of the welcome composer's inbox thread. The draft
   * hand-off (first keystroke) and the first send share it, so a send landing
   * while the hand-off is still creating the thread can never make a second
   * one   both wait for the same thread and open it.
   */
  welcomeChatThreadPromise: Promise<{ thread: Thread; inbox: Project }> | null = $state(null)

  ensureWelcomeChatThread(): Promise<{ thread: Thread; inbox: Project }> {
    if (!this.welcomeChatThreadPromise) {
      this.welcomeChatThreadPromise = this.createInboxThread().finally(() => {
        this.welcomeChatThreadPromise = null
      })
    }
    return this.welcomeChatThreadPromise
  }

  /** Create a standalone (project-less) chat from the composer's first message. */
  async createStandaloneChat(message: string, files: PromptAttachment[] = []): Promise<void> {
    const msg = message.trim()
    if (!msg && files.length === 0) return

    // Publish the hand-off before awaiting the thread: when a draft hand-off is
    // already creating it, ThreadView mounts for that same thread and picks the
    // message up, instead of a second thread being created here.
    let staged = files
    chatDraft.message = msg
    chatDraft.attachments = staged
    try {
      const { thread, inbox } = await this.ensureWelcomeChatThread()
      // The chat exists, so everything the composer staged before it did is
      // moved into that chat's own scratch path before the message goes.
      staged = await this.adoptDraftAttachments(thread.id, staged)
      chatDraft.attachments = staged
      // Seed the empty conversation so the composer renders on the first frame
      // and the hand-off message is sent without a loading flash.
      threadMessages.seedEmpty(INBOX_PROJECT_ID, thread.id)
      this.root.createThreadInProject.upsertThreadInList(thread)
      workspaceState.openThread(thread, inbox)
    } catch (error) {
      chatDraft.message = ''
      chatDraft.attachments = []
      // The thread was never created, so the message cannot appear anywhere.
      // Put it back in the composer so the user doesn't lose their first message.
      rendererRecovery.setDraft(INBOX_PROJECT_ID, DRAFT_CHAT_THREAD_ID, msg, staged)
      this.chatsComposerRestoreKey += 1
      reportError(error, 'The chat could not be started.')
    }
  }

  /**
   * Move everything the welcome composer staged before its chat existed into
   * that chat's own scratch path, and answer the composer's attachment list
   * repointed at the moved files.
   *
   * The composer has no thread while the draft is only a draft, so it stages
   * into a transient scope; the chat's scratch path is the one place its files
   * belong, so the hand-off moves them there rather than leaving them in a
   * directory no conversation owns. Best-effort: a failure leaves the files
   * where they are, where they stay readable and deletable.
   */
  async adoptDraftAttachments(
    threadId: string,
    files: PromptAttachment[]
  ): Promise<PromptAttachment[]> {
    try {
      // Run even with no chip attached: a file the user dropped and then
      // removed from the composer is still staged, and it belongs to this chat
      // rather than to a scope no conversation owns.
      const moves = await invoke('attachment:adoptDraft', threadId)
      if (moves.length === 0) return files
      // Both sides of the lookup are compared in POSIX form: a Windows move
      // answers with `\` separators while the chip's URL decodes to `/`.
      const targets = new SvelteMap(moves.map((move) => [toPosixPath(move.from), move.to]))
      return files.map((file) => {
        const target = targets.get(toPosixPath(fileUrlToPath(file.url)))
        return target ? { ...file, url: pathToFileUrl(target) } : file
      })
    } catch (error) {
      reportError(error, 'The draft files could not be moved into the new chat.')
      return files
    }
  }

  /**
   * Turn the welcome composer's unsent draft into a real inbox thread so the
   * chat surfaces in the Chats sidebar as a draft, exactly like a project's
   * New thread row. The draft is read again after the thread exists, so words
   * typed while it was being created are carried over, then it is moved off the
   * welcome composer and onto the thread before that thread mounts. Nothing is
   * sent: the draft stays a draft, and the next New chat starts another one.
   */
  async startChatDraft(): Promise<void> {
    const draft = rendererRecovery.draftFor(INBOX_PROJECT_ID, DRAFT_CHAT_THREAD_ID)
    const attachments = rendererRecovery.attachmentsFor(INBOX_PROJECT_ID, DRAFT_CHAT_THREAD_ID)
    if (!draft.trim() && attachments.length === 0) return

    try {
      const { thread, inbox } = await this.ensureWelcomeChatThread()
      // The thread is seeded empty so its conversation renders the composer on
      // the first frame   the welcome composer never flashes a loading state.
      threadMessages.seedEmpty(INBOX_PROJECT_ID, thread.id)
      // The chat exists, so its own scratch path now owns what the composer
      // staged before it did. Re-read: the composer is authoritative and may
      // have taken more keystrokes (or been cleared by a send) while the thread
      // was created.
      const adopted = await this.adoptDraftAttachments(
        thread.id,
        rendererRecovery.attachmentsFor(INBOX_PROJECT_ID, DRAFT_CHAT_THREAD_ID)
      )
      rendererRecovery.setDraft(
        INBOX_PROJECT_ID,
        thread.id,
        rendererRecovery.draftFor(INBOX_PROJECT_ID, DRAFT_CHAT_THREAD_ID),
        adopted
      )
      rendererRecovery.clearDraft(INBOX_PROJECT_ID, DRAFT_CHAT_THREAD_ID)
      this.root.createThreadInProject.upsertThreadInList(thread)
      workspaceState.openThread(thread, inbox)
    } catch (error) {
      // The draft stays in the welcome composer, so nothing the user typed is lost.
      reportError(error, 'The chat draft could not be saved.')
    }
  }

  /** In-flight mark-read requests keyed by `projectId:threadId`. A thread that
   *  is already being marked read is never re-requested, but a failure clears
   *  its key so a later interaction can retry. */
  pendingReadThreads = new SvelteSet<string>()

  /** One delayed retry per failed mark-read, keyed the same way. */
  readRetryTimers = new SvelteMap<string, ReturnType<typeof setTimeout>>()

  /** Push a read snapshot into every sidebar store (regular list, scope board,
   *  selected thread) so the row badge settles in the same tick instead of
   *  waiting on the backend's own broadcast round-trip. */
  applyThreadRead(thread: Thread): void {
    this.root.createThreadInProject.upsertThreadInList(thread)
    scopeState.updateThread(thread)
    if (workspaceState.selectedThread?.id === thread.id) {
      workspaceState.updateThread(thread)
    }
  }

  /** Mark a thread read through the backend and apply the confirmed snapshot.
   *  A failed or lost request must never leave a thread the user has already
   *  interacted with stuck on unread, so an unconfirmed read still applies
   *  locally (the next `thread:updated` broadcast reconciles any drift), and
   *  the request retries once after a short delay before the failure is
   *  surfaced to the durable log. */
  async markThreadReadAndApply(projectId: string, threadId: string): Promise<void> {
    const key = `${projectId}:${threadId}`
    try {
      const updated = await invoke('thread:markRead', projectId, threadId)
      if (updated.read) {
        this.applyThreadRead(updated)
        return
      }
      // The backend answered but did not flip the flag (e.g. the thread row was
      // momentarily invisible through the worker read). Retry once.
      const retried = await invoke('thread:markRead', projectId, threadId)
      this.applyThreadRead(retried.read ? retried : { ...retried, read: true })
      if (!retried.read) {
        logRendererError(
          `Thread mark-read did not settle on the backend: thread ${threadId} in project ${projectId} stayed unread after retry`
        )
      }
    } catch (error) {
      // The backend never confirmed. Schedule one delayed retry so a transient
      // IPC or worker failure cannot leave the badge stuck on unread; clear the
      // pending key first so the retry is not gated as a duplicate.
      this.pendingReadThreads.delete(key)
      if (this.readRetryTimers.has(key)) return
      this.readRetryTimers.set(
        key,
        setTimeout(() => {
          this.readRetryTimers.delete(key)
          void this.markThreadReadAndApply(projectId, threadId).catch((retryError) => {
            logRendererError('Thread mark-read retry failed', retryError)
          })
        }, 2000)
      )
      logRendererError('Thread mark-read request failed; scheduled a retry', error)
    }
  }

  /** Entry point that gates duplicate in-flight requests per thread. */
  requestThreadRead(projectId: string, threadId: string): void {
    // A deliberate unread mark outranks the automatic settle: keep the thread
    // unread until the user opens it again (see `threadUnreadIntent`).
    if (threadUnreadIntent.has(threadId)) return
    const key = `${projectId}:${threadId}`
    if (this.pendingReadThreads.has(key)) return
    this.pendingReadThreads.add(key)
    void this.markThreadReadAndApply(projectId, threadId)
      .catch(() => undefined)
      .finally(() => this.pendingReadThreads.delete(key))
  }

  markThreadReadAfterPaint(thread: Thread): void {
    if (thread.read) return
    window.requestAnimationFrame(() => {
      window.setTimeout(() => {
        this.requestThreadRead(thread.projectId, thread.id)
      }, 0)
    })
  }

  // ─── Assistant actions ────────────────────────────────────────────────────
  openAssistantTask(task: Thread): void {
    this.root.createThreadInProject.upsertThreadInList(task)
    workspaceState.openThread(task, this.assistantProject)
  }

  /** Create an assistant and seed its "Getting started" task, then open its panel. */
  async createAssistant(draft: NewAssistantDraft): Promise<void> {
    if (!this.assistantProject) return
    // No model prompt: the primary is the model the user is already working on,
    // so creating an assistant never blocks on a pick. Fallbacks are added later
    // from the panel's Agents tab, which the agent points the user at.
    const agents = withDefaultAssistantPrimary(
      { fallbacks: [] },
      this.root.mergeThreadsInList.currentAssistantModelSelection()
    )
    const assistant = await assistants.createAssistant({
      name: draft.name,
      description: draft.description || undefined,
      agents
    })
    // The seed task is created already inside the assistant: a follow-up regroup
    // would race the creation broadcast and leave the task outside it.
    await this.root.createThreadInProject.createThreadInProject(this.assistantProject, undefined, {
      assistantId: assistant.id,
      gettingStarted: true
    })
    await this.root.mergeThreadsInList.applyAssistantModelToTask(
      workspaceState.selectedThread,
      assistant
    )
    await this.openAssistantKnowledgeFor(assistant)
    // The assistant was given its name and description on the form, so it opens
    // the conversation itself: it greets them by name, asks how they want it to
    // behave and what to call them, and says where a task goes. A failed opening
    // turn is not fatal, because the conversation is open and the user can send the
    // first message.
    try {
      await assistants.startManualSetup(assistant.id)
    } catch (error) {
      reportError(error, 'The assistant could not introduce itself')
    }
  }

  /**
   * Create an assistant by talking to it.
   *
   * It exists straight away with nothing known about it, its Getting started
   * conversation is seeded exactly like the form's, and the app posts the opening
   * turn: the user reads one line saying a new assistant is being created, and the
   * model is told to run the setup conversation, starting with the name. It wears
   * a placeholder name and a colour of its own from that moment, and the name the
   * user gives it in the conversation is written onto it as the answer lands, so
   * every surface renames itself there and then rather than at the recap.
   */
  async createAssistantViaChat(): Promise<void> {
    if (!this.assistantProject) return
    const agents = withDefaultAssistantPrimary(
      { fallbacks: [] },
      this.root.mergeThreadsInList.currentAssistantModelSelection()
    )
    const assistant = await assistants.createAssistant({
      name: ASSISTANT_PLACEHOLDER_NAME,
      agents
    })
    await this.root.createThreadInProject.createThreadInProject(this.assistantProject, undefined, {
      assistantId: assistant.id,
      gettingStarted: true
    })
    await this.root.mergeThreadsInList.applyAssistantModelToTask(
      workspaceState.selectedThread,
      assistant
    )
    await this.openAssistantKnowledgeFor(assistant)
    try {
      await assistants.startChatSetup(assistant.id)
    } catch (error) {
      // The assistant exists and its conversation is open, so a failed opening
      // turn is not fatal: the user can send the first message themselves.
      reportError(error, 'The first question could not be asked')
    }
  }

  /** Open the knowledge panel for an assistant, creating a first task if it has none. */
  async openAssistantKnowledgeFor(assistant: Assistant): Promise<void> {
    let anchor =
      this.assistantTasks.find((task) => task.assistantId === assistant.id) ??
      (workspaceState.selectedThread?.projectId === ASSISTANT_SPACE_ID
        ? workspaceState.selectedThread
        : undefined)
    if (!anchor) {
      // An assistant whose only task is a hidden knowledge thread still has an anchor:
      // ask the main process for it, because hidden rows never reach the
      // hydrated thread list the sidebar renders from.
      anchor = (await invoke('assistant:knowledgeThread', assistant.id)) ?? undefined
    }
    if (!anchor) {
      if (!this.assistantProject) return
      await this.root.createThreadInProject.createThreadInProject(
        this.assistantProject,
        undefined,
        { assistantId: assistant.id }
      )
      const created = workspaceState.selectedThread
      if (!created) return
      this.root.createThreadInProject.upsertThreadInList(created)
      anchor = created
    }
    contextSidebarState.openAssistantKnowledge(
      ASSISTANT_SPACE_ID,
      anchor.id,
      assistant.id,
      assistant.name
    )
  }
}
