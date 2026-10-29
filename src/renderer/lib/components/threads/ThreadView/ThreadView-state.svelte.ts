import { isMacPlatform } from '$lib/shortcut-display'
import { createReadingColumn } from '$lib/reading-column.svelte'
import { formatKeyCombo } from '$lib/keymap/keymap'
import { keymapState } from '$lib/keymap/keymap-state.svelte'
import { CONVERSATION_METADATA_ICONS } from '../conversation-metadata-badges'
import ChatComposer from '../../chats/ChatComposer.svelte'
import { COMPOSER_DRAFT_SELECTOR } from '../../chats/chat-composer-draft-surface'
import { findNavState } from '$lib/stores/find-nav.svelte'
import { FileBlobUrlManager } from '$lib/media-urls.svelte'
import type { ActionSource } from '$lib/actions'
import { workspaceState } from '$lib/stores/workspace.svelte'

import { ASSISTANT_PLACEHOLDER_NAME } from '$shared/types'
import type { Thread, AgentSessionStatus, AssignmentTask } from '$shared/types'
import { APP_NAME } from '$shared/brand'
import { responseElementFor } from '../thread-response-ranges'
import type { ThreadView } from './ThreadView-board.svelte'
import { BoardUnit } from '$lib/components/board-unit'
/** One concern of the ThreadView board. */
export class ThreadViewState extends BoardUnit<ThreadView> {
  constructor(root: ThreadView) {
    super(root)
  }
  ThinkingMetadataIcon = CONVERSATION_METADATA_ICONS.thinking

  AccountMetadataIcon = CONVERSATION_METADATA_ICONS.account

  LocalMetadataIcon = CONVERSATION_METADATA_ICONS.local

  /**
   * Open the thread a tag chip or badge names: `thread:<id>` is that thread,
   * `assistant:<id>` is its Getting started conversation, or its newest thread
   * when the assistant has no authoring conversation left.
   */
  openAssistantTag(reference: string): void {
    if (!this.root.props.assistantSpaceThreads || !this.root.props.onOpenAssistantThread) return
    if (reference.startsWith('thread:')) {
      const id = reference.slice('thread:'.length)
      const target = this.root.props.assistantSpaceThreads.find((entry) => entry.id === id)
      if (target) this.root.props.onOpenAssistantThread(target)
      return
    }
    if (!reference.startsWith('assistant:')) return
    const assistantId = reference.slice('assistant:'.length)
    const owned = this.root.props.assistantSpaceThreads.filter(
      (entry) => entry.assistantId === assistantId
    )
    const setup = owned.find((entry) => entry.assistantGettingStarted)
    const target =
      setup ??
      owned.reduce<Thread | null>(
        (newest, entry) => (!newest || entry.lastActivity > newest.lastActivity ? entry : newest),
        null
      )
    if (target) this.root.props.onOpenAssistantThread(target)
  }

  /** When this view attached. A prompt is only brand new to this view when it was
   *  created after this stamp: a message that predates it is history this view
   *  mounted, and history must not play the arrival it never had (see
   *  `promptArrive`). The view is keyed by thread, so a switch stamps again. */
  viewAttachedAt = Date.now()

  /** Pending post-mount idle prefetch of the history; cancelled on teardown. */
  historyPrefetchHandle: number | null = $state(null)

  applicationActionSource = {
    id: 'application',
    label: APP_NAME,
    kind: 'app'
  } satisfies ActionSource

  /** Global-layer skills shared by every project and harness. */
  globalSkillActionSource = {
    id: 'global-skills',
    label: 'Global',
    kind: 'app'
  } satisfies ActionSource

  /**
   * Drop a stored window the account's model no longer offers, so the dropdown's
   * selected value, the meter, and the turn's budget cannot disagree. The guard
   * keeps one write per stale value instead of repeating it on every flush.
   */
  reconciledContextWindow = ''

  /** Minimum quiet time before the rendered battery settles mid-turn. */
  CONTEXT_USAGE_SETTLE_MS = 6000

  contextUsageSettleTimer: ReturnType<typeof setTimeout> | undefined = undefined

  /**
   * Where the conversation's page column starts, reported to the header so the
   * thread's name sits on the same line as the text the reader is reading.
   *
   * A studio that takes the pane hides this conversation rather than replacing it
   * (see the visibility pane at the bottom of this view), and a hidden surface keeps
   * the coordinate it measured while it was on screen. That is what holds the name
   * still through the toggle: it neither jumps to the chrome nor to a column nobody
   * chose.
   */
  conversationColumn = createReadingColumn()

  threadViewElement = $state<HTMLDivElement | null>(null)

  imageUrls = new FileBlobUrlManager()

  /**
   * Whether an emptied selection happened inside the responses.
   *
   * A caret that has moved into a field is not the user clearing this highlight:
   * the comment editor takes focus the moment the menu opens a comment, and a
   * menu that closed on that would take the actions away from the comment being
   * written. A selection that emptied inside a response is the highlight being
   * cleared, and closes the menu.
   */
  selectionTouchesResponses(): boolean {
    const selection = document.getSelection()
    if (!selection) return true
    return (
      responseElementFor(selection.anchorNode) !== null ||
      responseElementFor(selection.focusNode) !== null
    )
  }

  planningResumeRequested = false

  /** Turning the Independent Audit switch off undocks the coordinator AND
   *  closes the sidebar shell that the switch opened. Tracked per thread so a
   *  thread switch never closes another thread's coordinator tab. */
  independentCoordinatorThreadId = $state<string | null>(null)

  // ─── Agent session lifecycle ─────────────────────────────────────────────

  unsubscribe: (() => void) | null = $state(null)

  unsubscribeThreadUpdated: (() => void) | null = $state(null)

  unsubscribeRemoteEvents: (() => void) | null = $state(null)

  unsubscribeLifecycleInheritance: (() => void) | null = $state(null)

  // ─── Message queue & steer  ───────────────────────────────────────────────

  /** Shortcut label for the steer combo   macOS shows ⌘⇧, others Ctrl+Shift+. */
  steerModifierLabel = isMacPlatform() ? '⌘⇧' : 'Ctrl+Shift+'

  queuedStartAfterPickerOpen = $state(false)

  /** Baseline captured at mount. A focus request that was issued *before* this
   *  conversation mounted is already satisfied by the composer's own autofocus,
   *  so only requests that arrive afterwards may remount the composer. Starting
   *  from zero made every thread switch remount ChatComposer a second time the
   *  moment the first focus request of the session had ever been issued. */
  prevFocusComposerCount = workspaceState.focusComposerCount

  /** The mounted composer, used to focus the editor in place (no remount). */
  composer: ChatComposer | undefined = $state(undefined)

  /** Baseline captured at mount so only new requests focus   opening a thread
   *  via the sidebar must not steal focus from wherever the user clicked. */
  focusComposerEditorBaseline = $state(workspaceState.focusComposerEditorCount)

  showBankedResetConfirm = $state(false)

  /**
   * Whether the assistant still wears the name the create flow had to store.
   * Nothing about an assistant built by talking is known at first, so the copy
   * that would otherwise greet it by name says what is happening instead.
   */
  assistantUnnamed = $derived(this.root.props.assistantName === ASSISTANT_PLACEHOLDER_NAME)

  /**
   * The app's own shortcut for starting a task with an assistant, for the copy
   * that sends the user to a new task rather than a message in this thread.
   */
  assistantNewTaskShortcut = $derived(formatKeyCombo(keymapState.keysFor('assistant-new-task')))

  assignmentWorkerAttentionStatus(
    task: AssignmentTask,
    worker: Thread
  ): Extract<AgentSessionStatus, { state: 'error' }> {
    const message = task.report?.summary ?? 'The Assignment worker needs attention.'
    return {
      state: 'error',
      issue: {
        kind: 'unknown',
        message,
        rawError: message,
        harnessId: worker.settings?.harnessId ?? 'unknown',
        retryable: true
      }
    }
  }

  /** What "find in conversation" reads: every message plus the composer's own
   *  draft, so a word can be located in what was said and in what is being
   *  written. The draft lives in the bottom chrome rather than the transcript
   *  scroller, which is why the surface is searched as a whole instead of just
   *  its scrolling message list. */
  CONVERSATION_FIND_SELECTOR = `[data-conversation-searchable], ${COMPOSER_DRAFT_SELECTOR}`

  closeFind(): void {
    findNavState.closeConversationFind()
  }

  /** Thread whose foreign run this view marked working, so the same view clears
   *  it and never clears a run this instance's own session owns. */
  foreignRunMarkedKey = ''

  /** How many durable parts one trace mounts while it fills its own step list.
   *  The rows are one-line fold controls whose content renders only on open, so
   *  the whole list is what the reader wants at a glance; the cap keeps a
   *  monster turn from mounting without end. */
  EAGER_STREAM_PARTS_CAP = 400

  // The transcript can advance to a new turn without this view ever observing
  // the boundary (a queued message, an auto-retry, an assistant, or another app
  // instance running the turn). The live poll above only runs while this view
  // believes the thread is busy, so re-read the durable snapshot the moment the
  // transcript's turn anchor actually changes. The guard that feeds the task
  // card then decides whether the snapshot still applies, which is what keeps a
  // second instance and an unwatched thread from showing the previous turn's
  // list. The first anchor this view sees is left to the mount read, which owns
  // the initial snapshot.
  todoAnchorLastRead: number | null = $state(null)
}
