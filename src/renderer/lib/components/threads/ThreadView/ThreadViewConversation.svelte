<script lang="ts">
  import type { ThreadView as ThreadViewBoard } from './ThreadView-board.svelte'
  import { perfSpan } from '$lib/perf-trace'
  import CioAudioLines from '@pdslng/cio-icon/CioAudioLines.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioFileText from '@pdslng/cio-icon/CioFileText.svelte'
  import CioFolderInput from '@pdslng/cio-icon/CioFolderInput.svelte'
  import CioFork from '@pdslng/cio-icon/CioFork.svelte'
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import CioArrowLeft from '@pdslng/cio-icon/CioArrowLeft.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import CioZap from '@pdslng/cio-icon/CioZap.svelte'
  import ConversationSkeleton from './ConversationSkeleton.svelte'
  import ThreadViewConversationCompletedTurnTrace from './ThreadViewConversation/ThreadViewConversation-completed-turn-trace.svelte'
  import ThreadViewConversationGroupTraceBubble from './ThreadViewConversation/ThreadViewConversation-group-trace-bubble.svelte'
  import ThreadViewConversationLiveTurnTrace from './ThreadViewConversation/ThreadViewConversation-live-turn-trace.svelte'
  import ThreadViewConversationTurnTrace from './ThreadViewConversation/ThreadViewConversation-turn-trace.svelte'
  import {
    groupSpeakerFor,
    groupSpeakerForThread
  } from './ThreadViewConversation/ThreadViewConversation-speakers'
  import { formatDurationMs } from '$lib/format/duration'
  import { promptLanding } from '../../chats/chat-composer-prompt-flight.svelte'
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import { CONVERSATION_METADATA_BADGE_CLASS } from '../conversation-metadata-badges'
  import FileTypeIcon from '../../files/FileTypeIcon.svelte'
  import FolderTypeIcon from '../../files/FolderTypeIcon.svelte'
  import ClampedText from '../../shared/ClampedText.svelte'
  import RichMarkdownEditor from '../../shared/RichMarkdownEditor.svelte'
  import VoiceInputButton from '../../speech/VoiceInputButton.svelte'
  import SpeechPlaybackButton from '../../speech/SpeechPlaybackButton.svelte'
  import { speechController } from '../../../speech/speech-controller.svelte'
  import WorkingTrace from '../WorkingTrace.svelte'
  import GroupReplyBubble from '../GroupReplyBubble.svelte'
  import TraceActivityLine from '../TraceActivityLine.svelte'
  import { loadCachedPanelModule, PANEL_KEYS } from '$lib/lazy-panel'
  import { runReceiptState } from '$lib/stores/run-receipt.svelte'
  import { isBoundAssistantTask } from '$shared/bound-scope'
  import ThinkingOrb from '$lib/thinking-orb/ThinkingOrb.svelte'
  import InlineMediaFigure from '../InlineMediaFigure.svelte'
  import InlineImageFigure from '../InlineImageFigure.svelte'
  import CitedEntryCard from '../CitedEntryCard.svelte'
  import type { CitedEntry } from '$shared/cited-work'
  import AuditGeneratedCard from '../AuditGeneratedCard.svelte'
  import DeferredMarkdownView from '../../markdown/DeferredMarkdownView.svelte'
  import FileCitationContextMenu from '../../markdown/FileCitationContextMenu.svelte'
  import { attachmentPreviewKind, isImageMime, isVideoMime, isAudioMime } from '$lib/mime'
  import { fastVariantForModelId } from '$shared/fast-inference'
  import AgentIcon from '$lib/agent-icons/AgentIcon.svelte'
  import VendorIcon from '$lib/vendor-icons/VendorIcon.svelte'
  import { getIconSvgDataUrl } from '$lib/project-svg-icons'
  import { getCustomSvgDataUrl } from '../../../../../lib/custom-svg-tint'
  import { assistants } from '$lib/stores/assistants.svelte'
  import { appConfigState } from '$lib/stores/app-config.svelte'
  import CioUserMark from '$lib/components/icons/cio/CioUserMark.svelte'
  import ThreadMessageSpeaker from '../ThreadMessageSpeaker.svelte'
  import DelegatedAttentionStack from '../DelegatedAttentionStack.svelte'
  import CioReplyMark from '$lib/components/icons/cio/CioReplyMark.svelte'
  import ThreadContainerMark from '../ThreadContainerMark.svelte'
  import { ASSISTANT_SPACE_ID, isGroupThread } from '$shared/types'
  import { openThreadById } from '$lib/threads/open-thread-by-id'
  import {
    conversationAnswerText,
    conversationProseText,
    conversationQuoteExcerpt
  } from '../conversation-text'
  import MessageTimestamp from '$lib/components/shared/MessageTimestamp.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { modelKey } from '$lib/model-keys'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { logRendererDev } from '$lib/system/renderer-logger'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import type { AgentMessage, AgentPart, DirectReplyTarget } from '$shared/types'
  import { formatTokenRate } from '$lib/token-rate.svelte'
  import {
    auditReportForTurn,
    changesBeforeSteer,
    getTurnFinalText,
    isActivityOnlyUserMessage,
    turnStartIndexForEnd,
    type TraceSegmentLayout
  } from '../thread-turn-parts'
  import {
    explicitMessagePresentation,
    inlineFileTagsForMessage,
    messageHarnessName,
    messageModelLabel,
    messageProvider,
    messageText,
    messageThinkingLevel,
    messageTokenRate,
    resolveMessageHarnessId
  } from '../thread-message-presentation'

  import type { Attachment } from 'svelte/attachments'

  /** The board the surface built, and the few values only it can build. */
  let { board }: { board: ThreadViewBoard } = $props()

  /**
   * What the transcript costs to build.
   *
   * It sits inside the thread's shell (`thread.shell`), and on its own it is the
   * difference between a thread that appears and a thread that appears with its
   * conversation in it. Timed to the moment its scroller is in the tree.
   */
  const buildSpan = perfSpan('thread.conversation')

  /** The transcript's scroller is in the tree: its build is done. */
  function conversationBuilt(): void {
    buildSpan.end('ok', { threadId: board.handleAgentEvent.thread.id })
  }

  /**
   * The run thread a receipt belongs to, when this conversation is one.
   *
   * A receipt describes what *a run* did, so only a bound run thread carries one:
   * an ordinary project thread's work is already shown by the rail's Changes, and
   * an assistant task without a binding has no checkout to describe.
   */
  let receiptThread = $derived.by(() => {
    const thread = board.handleAgentEvent.thread
    return isBoundAssistantTask(thread) && thread.assistantTaskId ? thread : null
  })

  /**
   * Whether this conversation is a group thread, and therefore has to name its
   * speakers.
   *
   * An ordinary thread has exactly one implied assistant author and one implied
   * human, so it keeps the plain transcript it always had: its rows read as the
   * dialogue they are, and a name over every message would be noise. A group
   * thread holds several assistants, so a reply that does not say who spoke is
   * unattributable, and the transcript signs both sides like a group chat.
   */
  const groupThread = $derived(isGroupThread(board.handleAgentEvent.thread))

  /**
   * Whether a group turn's slice draws itself where it belongs.
   *
   * Three owners exist for one turn's work: the bubble that closes it, the
   * trailing live bubble while a single uncut turn runs, and the slices at their
   * own mount points. A slice draws itself when its turn was cut by an answered
   * question (so the answer card sits between the work that asked it and the
   * work it unblocked), and when nothing else draws it at all, which is the
   * steered or interrupted turn that never wrote a closing answer. A live uncut
   * turn is the trailing bubble's, so its slice stands down until it settles.
   */
  function groupSliceDraws(segment: TraceSegmentLayout): boolean {
    if (segment.boundaries.length > 0) return true
    const messages = board.loadOlderMessages.messages
    const turnEnd =
      board.pollStreamParts.transcriptIndex.turnEnd[segment.turnStart] ?? segment.turnStart
    const closing = getTurnFinalText(
      messages,
      turnEnd,
      board.pollStreamParts.isTransparentTurnMessage
    )
    if (closing) return false
    if (
      segment.turnStart === board.buildSpecActionPrompt.latestTurnInfo.startIndex &&
      board.pollStreamParts.conversationBusy
    )
      return false
    return true
  }

  /**
   * The live work of a group turn that has not written its answer yet.
   *
   * A group reply is drawn from the row that closes the turn, and a streaming
   * run mirrors a new assistant row for every step, so that closing row moves
   * the whole time. A bubble anchored to it is torn down and rebuilt on each
   * step, which resets the trace body's scroll to its top and reads as the work
   * vanishing and starting over. The live work is therefore drawn once, below
   * the turn's rows, where it is a single element for the whole run: the reader
   * can tail it, and a new step appends instead of replacing everything above.
   *
   * Null while the reply owns its own drawing: a closing answer exists (the row
   * that closes the turn draws the same work inside its bubble), or the turn is
   * not the active one (a newer prompt has opened a turn of its own, which the
   * pending-turn path above handles).
   */
  const liveGroupTrace = $derived.by(() => {
    if (!groupThread) return null
    if (!board.pollStreamParts.conversationBusy) return null
    if (!board.buildSpecActionPrompt.latestTurnInfo.active) return null
    const messages = board.loadOlderMessages.messages
    const last = messages.length - 1
    if (last < 0) return null
    const closing = getTurnFinalText(messages, last, board.pollStreamParts.isTransparentTurnMessage)
    if (closing) return null
    // A turn the reader answered is drawn slice by slice at its own mount
    // points, so the live work has a place on both sides of the answer card and
    // this single bubble would show all of it again below the answer.
    if (
      board.pollStreamParts.turnHasAnswerCuts(board.buildSpecActionPrompt.latestTurnInfo.startIndex)
    )
      return null
    return { parts: board.pollStreamParts.latestTurnRenderableParts }
  })

  /**
   * The same text rule the answer uses, applied to whatever the trace draws.
   *
   * An assistant run wraps its update in the app's `<assistant_result>` boundary.
   * The closing answer already reads only the text inside it; a step's text in
   * the working trace must read the same way, or the envelope itself shows up in
   * a chat that is meant to be readable.
   */
  const textScope = $derived({
    assistantMode: board.props.assistantMode,
    groupThread,
    authoringThread: board.abortRun.assistantAuthoringThread
  })

  /**
   * The newest words a live step left behind, read the same way the answer is.
   *
   * The activity line under the transcript draws that prose before the answer
   * exists, so it can hold the app's own `<assistant_result>` boundary while the
   * run is still working. A run that has not opened its result yet says nothing
   * here, and the line reports what the agent is doing instead. The trace itself
   * reads its work through the same rule, from `conversationTraceOutput`.
   */
  function conversationLiveProse(text: string): string {
    return conversationProseText(textScope, text)
  }

  /**
   * What a group thread signs the user's own messages with.
   *
   * It is the name the user asked Don to call them, and "You" until they answer:
   * the question is asked in Don's thread on first launch, but an older thread
   * must still read as a conversation while it is unanswered.
   */
  const userName = $derived(appConfigState.userPreferredName.trim() || 'You')

  /**
   * The conversation one group reply came from.
   *
   * A reply written into a group since messages started carrying it names the
   * thread it spoke from. A reply written before that keeps it in its own id: a
   * delegated answer is `don-delegation-<runThreadId>` (and its paused line
   * `-status`), and a group reply from an assistant is
   * `group-chat-reply-<runThreadId>-<timestamp>`. Reading the id is what makes
   * an answer that was already in the transcript answerable, instead of waiting
   * for the next one.
   */
  function sourceThreadIdFor(msg: AgentMessage): string | null {
    if (msg.author?.threadId) return msg.author.threadId
    const delegationPrefix = 'don-delegation-'
    if (msg.id.startsWith(delegationPrefix)) {
      const id = msg.id.slice(delegationPrefix.length).replace(/-status$/u, '')
      return id.length > 0 ? id : null
    }
    const chatReply = /^group-chat-reply-(.+)-\d+$/u.exec(msg.id)
    return chatReply?.[1] ?? null
  }

  /**
   * The conversation one group bubble came from, as a reply target.
   *
   * Every assistant reply in a group is answerable: the words go to the thread
   * that spoke them, never to the group's own assistant, so a peer's report is
   * answered in the conversation that is doing the work. The host's own reply
   * has no other thread, so it answers into this conversation: replying to Don
   * is chatting with Don. The project is the thread's own where the message
   * names it, the known list where it lives beside this one, and the open
   * conversation's project as the last honest answer for an archived child.
   */
  function replyTargetFor(msg: AgentMessage): DirectReplyTarget | null {
    if (!groupThread || msg.role !== 'assistant') return null
    const openThread = board.handleAgentEvent.thread
    const threadId = sourceThreadIdFor(msg) ?? openThread.id
    const known = board.props.assistantSpaceThreads?.find((thread) => thread.id === threadId)
    const projectId = msg.author?.projectId ?? known?.projectId ?? openThread.projectId
    if (!projectId) return null
    const speaker = groupSpeakerFor(openThread, msg)
    const title =
      threadId === openThread.id
        ? (openThread.title ?? 'this conversation')
        : (known?.title ?? speaker?.name ?? msg.author?.name ?? 'that conversation')
    // The `@thread:` marker is how the group links back to the run's own thread;
    // it is not part of what the speaker said, so a quote never carries it. The
    // quote is prose, read through the same rule as the answer it came from, so
    // the run's transport boundary can never open a quote.
    const excerpt = conversationQuoteExcerpt(
      conversationAnswerText(textScope, messageText(msg).replace(/@thread:\S+/gu, ' '))
    )
    return {
      projectId,
      threadId,
      title,
      speakerName: speaker?.name ?? msg.author?.name ?? title,
      messageId: msg.id,
      excerpt
    }
  }

  /**
   * Attach one group bubble to the composer, so the next message answers it.
   *
   * Only the container is a door. A double click inside the prose is how the
   * user selects a word, so a live selection (or a click that landed in the
   * action row) leaves the transcript alone.
   */
  function beginReply(event: MouseEvent, msg: AgentMessage): void {
    if (!groupThread) return
    if ((window.getSelection()?.toString() ?? '').length > 0) return
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest('[data-message-actions], [data-message-speaker]')) return
    const target = replyTargetFor(msg)
    if (target) board.directReply.attach(target)
  }

  /**
   * The receipt is read once per range. A running run reads its state, and a run
   * that settles re-reads exactly once, which is the app's own settle signal
   * doing the invalidation instead of a timer. The store owns the dedupe, so this
   * body only reports what the thread looks like right now.
   */
  $effect(() => {
    const thread = receiptThread
    const bound = thread?.boundScope
    if (!thread || !bound) return
    const settled =
      thread.status === 'completed' ||
      thread.status === 'failed' ||
      thread.status === 'working-paused'
    runReceiptState.sync(bound.projectId, thread.id, bound.scopeBucketId, settled, thread.updatedAt)
  })

  /**
   * Decide, once per distinct state, whether the transcript's final turn drew
   * its file-changes card.
   *
   * "The card is not showing" cannot be answered from the database or from the
   * index alone: both can be right while the branch that draws it never renders.
   * This reports the gate exactly as the markup evaluates it for the last
   * message, so the next report names the condition that failed.
   */
  let lastCardReport = ''
  function reportTailCard(state: Record<string, unknown>): void {
    const key = JSON.stringify(state)
    if (key === lastCardReport) return
    lastCardReport = key
    logRendererDev(`Turn cards: gate ${key}`)
  }

  /**
   * The column the header's thread name aligns to, when this surface is the one
   * the header names.
   *
   * A no-op for an embedded surface (a quick chat, the browser rail's chat): the
   * header keeps its name on the workspace's own conversation, so an embedded
   * page that reported its column moved the name into the panel that opened
   * beside it instead of leaving it on the page the user is reading.
   */
  const noopAttachment: Attachment<HTMLElement> = () => {}
  const readingColumn = $derived(
    board.props.ownsReadingColumn ? board.state.conversationColumn.attachment : noopAttachment
  )

  /**
   * The newest message that carries cited work, and what it cites.
   *
   * A turn's report is published as its own app-owned row once the turn settles,
   * which lands after the turn's own messages. When that same turn also changed
   * files, the row belongs *inside* the turn's changes card instead of floating
   * under it, so the reader sees one outcome rather than two surfaces that
   * describe the same turn.
   */
  const citedTail = $derived.by(() => {
    const messages = board.loadOlderMessages.messages
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (!message?.inlineArtifact) continue
      const entries: CitedEntry[] = []
      for (const part of message.parts) {
        if (part.type !== 'cited') continue
        entries.push({
          name: part.name,
          path: part.path,
          kind: part.kind,
          modifiedAt: part.modifiedAt,
          ...(part.work ? { work: part.work } : {})
        })
      }
      if (entries.length === 0) continue
      return { messageId: message.id, index, entries }
    }
    return null
  })

  /** Whether the changes card of a turn is drawn at this message index. */
  function changesCardAt(absIndex: number): boolean {
    if (board.props.chatMode) return false
    const index = board.pollStreamParts.transcriptIndex
    const checkpoint = index.checkpoint[absIndex] ?? null
    if (!checkpoint || checkpoint.changes.length === 0) return false
    return index.checkpointCard[absIndex] ?? false
  }

  /**
   * The cited entries a changes card at `absIndex` should draw itself.
   *
   * Only the turn that closed after the card: a cited row earlier in the
   * transcript belongs to a turn of its own, and a user message in between means
   * the reader asked something new, so that row keeps its own card.
   */
  function citedForCard(absIndex: number): CitedEntry[] {
    const tail = citedTail
    if (!tail || tail.index <= absIndex) return []
    const between = board.loadOlderMessages.messages.slice(absIndex + 1, tail.index)
    if (between.some((message) => message.role === 'user')) return []
    return tail.entries
  }

  /**
   * Whether the changes card of the turn that produced this cited row drew it.
   *
   * The row is hidden only when a card above it actually took the rows: a turn
   * that cited work without changing files has no card, and its report must keep
   * its own.
   */
  function citedRowAbsorbed(messageId: string): boolean {
    const tail = citedTail
    if (!tail || tail.messageId !== messageId) return false
    const messages = board.loadOlderMessages.messages
    for (let index = tail.index - 1; index >= 0; index -= 1) {
      const message = messages[index]
      if (!message) continue
      if (message.role === 'user') return false
      if (changesCardAt(index)) return true
    }
    return false
  }
</script>

<div
  bind:this={board.loadOlderMessages.scrollEl}
  class="conversation-scroll conversation-gutter relative min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-6 pb-20 {board
    .composerScope.centeredComposer
    ? 'hidden'
    : ''}"
  onscroll={board.loadOlderMessages.onScroll}
  onwheel={board.composerScope.onWheel}
  onpointerup={board.sources.handleResponsePointerUp}
  role="log"
  aria-label="Conversation"
  data-region={board.submitSpecDecision.showSpecStudio ? undefined : 'conversation'}
  {@attach conversationBuilt}
>
  <div
    class="mx-auto flex min-h-full w-full min-w-0 max-w-3xl flex-col justify-end gap-4 pt-6"
    {@attach readingColumn}
  >
    {#if !board.sources.loaded && board.composerScope.visibleMessages.length === 0}
      {#if board.loadOlderMessages.loadError}
        <!-- A failed read is information, not a permanent spinner: the
             conversation could not be fetched, so say so and offer the retry. -->
        <div class="flex flex-col items-start gap-2 py-8 text-sm" role="alert">
          <p class="text-danger">The conversation could not be loaded.</p>
          <p class="text-xs break-words text-dimmed">{board.loadOlderMessages.loadError}</p>
          <button
            type="button"
            class="mt-1 border border-border bg-surface px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-elevated"
            onclick={() => board.loadOlderMessages.retryLoad()}
          >
            Retry
          </button>
        </div>
      {:else}
        <!-- A skeleton of the transcript, in the transcript's own container, is
             the loading state: a spinner on one line reads as a container that
             failed to fill, and it also collapsed the column's height before the
             messages arrived. -->
        <ConversationSkeleton />
      {/if}
    {:else}
      {#if board.unmirroredTraceStartTime.hasOlderMessages}
        <div
          class="flex justify-center pb-2"
          {@attach board.studioTemporaryChatContext.trackHistoryHead}
          {@attach board.loadOlderMessages.watchHistoryHead}
        >
          <button
            type="button"
            class="px-3 py-1.5 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground disabled:opacity-60"
            disabled={board.loadOlderMessages.loadingOlderMessages}
            onclick={() => void board.loadOlderMessages.loadOlderMessages()}
          >
            {board.loadOlderMessages.loadingOlderMessages
              ? 'Loading earlier messages…'
              : 'Load earlier messages'}
          </button>
        </div>
      {/if}
      <!-- Messages -->
      <!--
            One chip for every attachment a message carries that is not an image
            thumbnail. The icon is the only difference between the kinds, so it
            travels as a value rather than as three copies of the same button.
          -->
      {#snippet filePartChip(
        name: string,
        kind: 'video' | 'audio' | 'renderable' | 'opaque',
        action: string,
        onclick: () => void
      )}
        <button
          type="button"
          class="flex cursor-pointer items-center gap-1.5 border border-border bg-elevated px-2 py-1 text-[0.75rem] text-muted transition-colors hover:bg-elevated/80 hover:text-foreground"
          title={action}
          aria-label={action}
          {onclick}
        >
          {#if kind === 'video'}
            <CioClapper size={11} class="shrink-0" />
          {:else if kind === 'audio'}
            <CioAudioLines size={11} class="shrink-0" />
          {:else if kind === 'renderable'}
            <FileTypeIcon path={name} size={12} class="shrink-0" />
          {:else}
            <CioFileText size={11} class="shrink-0" />
          {/if}
          <span class="max-w-32 truncate">{name}</span>
        </button>
      {/snippet}
      {#each board.composerScope.visibleMessages as msg, msgIndex (msg.id)}
        {@const absIndex =
          msgIndex +
          (board.loadOlderMessages.messages.length - board.composerScope.visibleMessages.length)}
        <!-- The work of the turn a steer interrupted sits directly above the
                 message that closed it, which is the order the run was lived in:
                 prompt, its trace, the steer, then the next turn's trace. A group
                 reply closes on the assistant row that ends its turn, so a turn a
                 steer cut short has no reply bubble of its own: its work lives
                 here, above the steer, and must not vanish into the next bubble. -->
        {#if !groupThread || msg.role !== 'assistant'}
          {#each board.pollStreamParts.completedTurnViews.filter((view) => view.anchorId === msg.id) as view (view.turn.endTs)}
            <ThreadViewConversationCompletedTurnTrace {board} turn={view.turn} />
          {/each}
        {/if}
        <!-- A steer still held under the running trace: its work is the
                 interrupted turn's, so that trace renders above the message. -->
        {#if !groupThread && absIndex === board.buildSpecActionPrompt.heldSteerAbsIndex && !board.pollStreamParts.turnAboveHasAssistantRow(absIndex)}
          <ThreadViewConversationLiveTurnTrace
            {board}
            traceParts={board.composerScope.unmirroredTraceParts}
            traceBusy
            latestOnly
          />
        {/if}
        {@const citedParts = msg.parts.filter(
          (part): part is Extract<AgentPart, { type: 'cited' }> => part.type === 'cited'
        )}
        {#if msg.inlineArtifact && citedRowAbsorbed(msg.id)}
          <!-- The turn's report rows are drawn by its changes card above, so this
               row has nothing left of its own to say. -->
        {:else if msg.inlineArtifact}
          <div id={`msg-${msg.id}`} class="message-block min-w-0 w-full space-y-2">
            {#each msg.parts as part (part.id)}
              {#if part.type === 'text'}
                <DeferredMarkdownView
                  text={part.text}
                  citationThread={board.unmirroredTraceStartTime.citationThreadContext}
                  annotationScope={{
                    projectId: board.handleAgentEvent.thread.projectId,
                    threadId: board.handleAgentEvent.thread.id
                  }}
                />
              {:else if part.type === 'file' && isImageMime(part.mime)}
                <!-- An artifact picture is shown plain here: its marks, its
                         pen and its numbered badges are drawn in the expanded
                         viewer, which is what its expand affordance opens. -->
                <InlineImageFigure
                  url={part.url}
                  mime={part.mime}
                  filename={part.filename ?? 'Image'}
                  imageUrls={board.state.imageUrls}
                  onExpand={() => board.editVideoNote.openMessageViewer(msg, part)}
                />
              {:else if part.type === 'file' && isVideoMime(part.mime)}
                <InlineMediaFigure
                  src={part.url}
                  kind="video"
                  filename={part.filename ?? 'Video'}
                  onExpand={(startAt, playing) =>
                    board.editVideoNote.openMessageViewer(msg, part, startAt, playing)}
                />
              {:else if part.type === 'file' && isAudioMime(part.mime)}
                <InlineMediaFigure
                  src={part.url}
                  kind="audio"
                  filename={part.filename ?? 'Media'}
                  onExpand={() => board.editVideoNote.openMessageViewer(msg, part)}
                />
              {:else if part.type === 'cited' && citedParts[0]?.id === part.id}
                <CitedEntryCard
                  entries={citedParts.map((cited) => ({
                    name: cited.name,
                    path: cited.path,
                    kind: cited.kind,
                    modifiedAt: cited.modifiedAt,
                    ...(cited.work ? { work: cited.work } : {})
                  }))}
                  projectId={board.handleAgentEvent.thread.projectId}
                  threadId={board.handleAgentEvent.thread.id}
                />
              {/if}
            {/each}
          </div>
        {:else if msg.role === 'user'}
          {#if !board.unmirroredTraceStartTime.isAssignmentAuditorThread && !isActivityOnlyUserMessage(msg)}
            <!-- The whole block travels, the ledger row and the action row
                     that hangs under it: a prompt the reader just sent flies here
                     from the box they typed it in, while history (and a message
                     the view mounts for a jump) appears where it belongs. Both
                     motions are transform and opacity only, so the reader's scroll
                     position and the tail lock never wait on them
                     (`promptLanding`). -->
            <div
              id={`msg-${msg.id}`}
              class="message-block group flex min-w-0 flex-col"
              in:promptLanding={{
                createdAt: msg.createdAt,
                viewAttachedAt: board.state.viewAttachedAt
              }}
            >
              {#if board.currentWorkingTraceAttribution.editingMessageId === msg.id}
                <RichMarkdownEditor
                  bind:this={board.currentWorkingTraceAttribution.messageEditEditor}
                  bind:value={board.currentWorkingTraceAttribution.editingText}
                  class="w-full bg-surface px-4 py-2.5 text-sm whitespace-pre-wrap text-foreground ring-2 ring-info/60 outline-none"
                  ariaLabel="Edit message"
                  onSubmit={() =>
                    void board.currentWorkingTraceAttribution.submitEditedMessage(msg)}
                />
                <div class="mt-1.5 flex items-center justify-end gap-1.5" data-voice-trigger-root>
                  <button
                    class="px-2.5 py-1 text-xs text-muted transition-colors hover:bg-elevated hover:text-foreground"
                    title="Discard the edit"
                    onclick={board.currentWorkingTraceAttribution.cancelEdit}
                  >
                    Cancel
                  </button>
                  <VoiceInputButton
                    targetId={`message-edit-${board.handleAgentEvent.thread.id}-${msg.id}`}
                    getTarget={board.currentWorkingTraceAttribution.messageEditSpeechTarget}
                    scope={{
                      kind: 'project',
                      projectId: board.handleAgentEvent.thread.projectId
                    }}
                    disabled={board.switchProject.busy}
                    triggerPriority={8}
                  />
                  <button
                    class="bg-primary px-2.5 py-1 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50"
                    title="Send the edited message   replaces the conversation from here down"
                    disabled={board.switchProject.busy ||
                      !board.currentWorkingTraceAttribution.editingText.trim()}
                    onclick={() => board.currentWorkingTraceAttribution.submitEditedMessage(msg)}
                  >
                    Send
                  </button>
                </div>
              {:else}
                {@const previousTurnAudit = board.editVideoNote.getPreviousTurnAudit(absIndex)}
                {@const explicitPresentation = explicitMessagePresentation(msg)}
                {#if previousTurnAudit && !groupThread}
                  <div class="mb-1 flex items-center gap-1.5 self-end text-[0.625rem] text-dimmed">
                    <span>Previous turn completed</span>
                    <span>·</span>
                    <span class="tabular-nums">{formatDurationMs(previousTurnAudit.duration)}</span>
                    <span>·</span>
                    <MessageTimestamp at={previousTurnAudit.endTime} />
                  </div>
                {/if}
                {@const inlineTags = inlineFileTagsForMessage(
                  msg,
                  board.props.assistantSpaceThreads
                    ? {
                        threads: board.props.assistantSpaceThreads,
                        assistants: assistants.assistants,
                        assistantIcons: assistants.iconUrls
                      }
                    : undefined
                )}
                {@const inlinedPaths = new Set(inlineTags.map((tag) => tag.token.slice(1)))}
                {@const leftoverReferences = (msg.projectReferences ?? []).filter(
                  (reference) => !inlinedPaths.has(reference.path)
                )}
                {@const replyParts = msg.parts.filter(
                  (part): part is Extract<AgentPart, { type: 'reply' }> => part.type === 'reply'
                )}
                <!-- The user's own message reads as a ledger row: only its
                         left edge is drawn, a 2px accent against the transcript,
                         and every corner is square. -->
                <div
                  class={groupThread
                    ? 'ml-auto w-fit max-w-[85%] border border-border bg-elevated px-3.5 py-2.5 text-sm text-foreground'
                    : 'w-full border-l-2 border-l-foreground bg-surface px-4 py-2.5 text-sm text-foreground'}
                  data-conversation-searchable
                >
                  <!-- A group thread signs the user's own messages too, with the
                       same 16px mark an assistant reply wears, so both sides of
                       the conversation read as speakers. The bubble sits on the
                       right, the way a chat puts the person speaking. -->
                  {#if groupThread}
                    <div
                      class="mb-2 flex min-w-0 items-center justify-end gap-1.5 text-[0.6875rem]"
                    >
                      <span class="truncate font-medium text-foreground">{userName}</span>
                      <CioUserMark name={userName} />
                    </div>
                  {/if}
                  {#if replyParts.length > 0}
                    <div class="mb-2 flex flex-col gap-1">
                      {#each replyParts as part (part.id)}
                        <!-- The quote is the way back to the words being answered:
                             the reply is still in this transcript, so opening the
                             quote scrolls to it and marks it. -->
                        <button
                          type="button"
                          class="flex w-full max-w-full items-start gap-2 border-l-2 border-accent/60 bg-app px-2 py-1.5 text-left transition-colors hover:bg-elevated"
                          title={`Go to the reply from ${part.speakerName} in ${part.title}`}
                          aria-label={`Go to the reply from ${part.speakerName} in ${part.title}`}
                          onclick={() => void board.directReply.reveal(part.repliedMessageId)}
                        >
                          <CioReplyMark size={11} class="mt-0.5 shrink-0 text-accent" />
                          <span class="min-w-0">
                            <span class="block truncate text-[0.6875rem] text-muted">
                              {part.speakerName} · {part.title}
                            </span>
                            <span class="line-clamp-2 block text-[0.75rem] text-foreground">
                              {conversationQuoteExcerpt(part.excerpt)}
                            </span>
                          </span>
                        </button>
                      {/each}
                    </div>
                  {/if}
                  {#if leftoverReferences.length}
                    <div class="mb-2 flex flex-wrap gap-1.5">
                      {#each leftoverReferences as reference (reference.id)}
                        <span
                          class="inline-flex max-w-full items-center gap-1.5 border border-border bg-elevated px-2 py-1 text-[0.75rem]"
                          title="Tagged {reference.kind}: {reference.path}"
                        >
                          {#if reference.kind === 'directory'}
                            <FolderTypeIcon name={reference.name} size={12} class="shrink-0" />
                          {:else}
                            <FileTypeIcon path={reference.path} size={12} class="shrink-0" />
                          {/if}
                          <span class="max-w-56 truncate font-medium text-foreground">
                            {reference.name}
                          </span>
                        </span>
                      {/each}
                    </div>
                  {/if}
                  {#if msg.references?.length}
                    <!-- Read once, so the chip that opens the reader and the
                         reader's own sibling list are the same array: a closure
                         cannot keep the narrowing a reactive `msg.references`
                         read loses. -->
                    {@const references = msg.references}
                    <div class="mb-2 flex flex-wrap gap-1.5">
                      {#each references as reference (reference.id)}
                        {#if reference.kind !== 'thread'}
                          <!-- The chip truncates the excerpt it stands for, so
                               reading it back is a click: the passage and its
                               comment open in the same lightbox a text attachment
                               uses. Hovering still names the act, not the text. -->
                          <button
                            type="button"
                            class="inline-flex max-w-full cursor-pointer items-center gap-1.5 border border-accent/30 bg-accent/10 px-2 py-1 text-left text-[0.75rem] transition-colors hover:bg-accent/20"
                            title={`Read ${reference.label}`}
                            aria-label={`Read ${reference.label}`}
                            onclick={() =>
                              board.studioTemporaryChatContext.openReferencePreview(
                                references,
                                reference
                              )}
                          >
                            <CioMessage size={11} class="shrink-0 text-accent" />
                            <span class="font-medium text-foreground">{reference.label}</span>
                            <span class="max-w-56 truncate text-muted">{reference.text}</span>
                            {#if reference.comment}
                              <span class="max-w-48 truncate italic text-foreground">
                                “{reference.comment}”
                              </span>
                            {/if}
                          </button>
                        {:else}
                          <!-- A whole conversation attached as context: the chip
                               names it and opens it in its own thread page, which
                               is where the reader checks what the turn was given.
                               It wears its container's mark, the same one the
                               composer drew for it before the send. -->
                          {@const attachedThreadId = reference.threadId ?? reference.id}
                          {@const attachedProjectId =
                            reference.projectId ?? board.handleAgentEvent.thread.projectId}
                          {@const attachedAssistantId =
                            attachedProjectId === ASSISTANT_SPACE_ID
                              ? (board.props.assistantSpaceThreads?.find(
                                  (thread) => thread.id === attachedThreadId
                                )?.assistantId ?? null)
                              : null}
                          <button
                            type="button"
                            class="inline-flex max-w-full cursor-pointer items-center gap-1.5 border border-info/30 bg-info/10 px-2 py-1 text-left text-[0.75rem] transition-colors hover:bg-info/20"
                            title={`Open ${reference.label}`}
                            aria-label={`Open ${reference.label}`}
                            onclick={() => void openThreadById(attachedProjectId, attachedThreadId)}
                          >
                            <ThreadContainerMark
                              projectId={attachedProjectId}
                              assistantId={attachedAssistantId}
                              size={11}
                              class="text-info"
                            />
                            <span class="max-w-56 truncate font-medium text-foreground">
                              {reference.label}
                            </span>
                          </button>
                        {/if}
                      {/each}
                    </div>
                  {/if}
                  {#if explicitPresentation}
                    <p class="mb-1 text-xs italic text-muted">
                      {explicitPresentation.action}
                    </p>
                  {/if}
                  {#if !explicitPresentation || explicitPresentation.body}
                    <!-- The authored text is height-clamped: a very long
                             prompt keeps its opening lines behind an explicit
                             reveal for the rest. Attachments are drawn below,
                             outside the clamp, so they are never folded away. -->
                    <ClampedText
                      expanded={board.expandedMessageBodies.expandedMessageBodies.has(msg.id)}
                      clamp={!board.unmirroredTraceStartTime.showFind}
                      label="message"
                      onToggle={(next) =>
                        board.expandedMessageBodies.toggleMessageBody(msg.id, next)}
                    >
                      <DeferredMarkdownView
                        text={explicitPresentation
                          ? (explicitPresentation.body ?? '')
                          : messageText(msg)}
                        citationThread={board.unmirroredTraceStartTime.citationThreadContext}
                        annotationScope={{
                          projectId: board.handleAgentEvent.thread.projectId,
                          threadId: board.handleAgentEvent.thread.id
                        }}
                        inlineFileTags={explicitPresentation ? undefined : inlineTags}
                        onOpenAssistantTag={board.state.openAssistantTag}
                        onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
                        onOpenLocalFile={(url) =>
                          void board.unmirroredTraceStartTime.openFilePart(url)}
                      />
                    </ClampedText>
                  {/if}
                  {#if msg.parts.some((p) => p.type === 'file')}
                    {@const fileParts = msg.parts.filter((p) => p.type === 'file')}
                    {@const imageParts = fileParts.filter(
                      (p): p is Extract<AgentPart, { type: 'file' }> => isImageMime(p.mime)
                    )}
                    {@const otherParts = fileParts.filter(
                      (p): p is Extract<AgentPart, { type: 'file' }> => !isImageMime(p.mime)
                    )}
                    <!-- Attached images render large and inline (two-up
                             on wide transcripts), each expanding into the
                             fullscreen viewer with sibling navigation. -->
                    {#if imageParts.length > 0}
                      <div
                        class="mt-2 grid grid-cols-1 gap-2 border-t border-border pt-2 xl:grid-cols-2"
                      >
                        {#each imageParts as part (part.id)}
                          <FileCitationContextMenu
                            projectId={board.handleAgentEvent.thread.projectId}
                            citation={board.composerScope.citationForFilePart(part)}
                          >
                            <InlineImageFigure
                              url={part.url}
                              mime={part.mime}
                              filename={part.filename ?? part.url.split('/').pop() ?? 'image'}
                              imageUrls={board.state.imageUrls}
                              onExpand={() => board.editVideoNote.openMessageViewer(msg, part)}
                            />
                          </FileCitationContextMenu>
                        {/each}
                      </div>
                    {/if}
                    {#if otherParts.length > 0}
                      <div class="mt-2 flex flex-wrap gap-1.5 border-t border-border pt-2">
                        {#each otherParts as part (part.id)}
                          {@const mediaKind = isVideoMime(part.mime)
                            ? 'video'
                            : isAudioMime(part.mime)
                              ? 'audio'
                              : null}
                          <!-- Kinds with no inline thumbnail but a preview we
                                   can render: PDF, document, Markdown, text. -->
                          {@const renderable =
                            !mediaKind &&
                            Boolean(attachmentPreviewKind(part.mime, part.filename ?? ''))}
                          {@const partName = part.filename ?? part.url.split('/').pop() ?? 'file'}
                          {#if mediaKind}
                            <FileCitationContextMenu
                              projectId={board.handleAgentEvent.thread.projectId}
                              citation={board.composerScope.citationForFilePart(part)}
                            >
                              {@render filePartChip(
                                partName,
                                mediaKind,
                                `Preview ${partName}`,
                                () => board.editVideoNote.openMessageViewer(msg, part)
                              )}
                            </FileCitationContextMenu>
                          {:else if renderable}
                            <FileCitationContextMenu
                              projectId={board.handleAgentEvent.thread.projectId}
                              citation={board.composerScope.citationForFilePart(part)}
                            >
                              {@render filePartChip(
                                partName,
                                'renderable',
                                `Preview ${partName}`,
                                () => board.editVideoNote.openMessageViewer(msg, part)
                              )}
                            </FileCitationContextMenu>
                          {:else}
                            <FileCitationContextMenu
                              projectId={board.handleAgentEvent.thread.projectId}
                              citation={board.composerScope.citationForFilePart(part)}
                            >
                              {@render filePartChip(partName, 'opaque', `Reveal ${partName}`, () =>
                                board.composerScope.revealSentAttachment(part)
                              )}
                            </FileCitationContextMenu>
                          {/if}
                        {/each}
                      </div>
                    {/if}
                  {/if}
                </div>
                {@const steerHeld = threadMessages.isSteerHeld(
                  board.handleAgentEvent.thread.projectId,
                  board.pollStreamParts.conversationId,
                  msg.id
                )}
                {@const unsent = Boolean(msg.error) && msg.role === 'user'}
                {@const recall = steerHeld
                  ? {
                      ariaLabel: 'Recall steered message   the agent has not taken it yet',
                      title: 'Recall   the agent never receives a steered message this is recalled',
                      run: () => void board.pollStreamParts.undoHeldSteer(msg)
                    }
                  : unsent
                    ? {
                        ariaLabel: 'Recall message   it never reached the agent',
                        title: 'Recall   take the words back into the composer and send again',
                        run: () => void board.pollStreamParts.recallUnsentMessage(msg)
                      }
                    : null}
                <!-- A message the agent has not settled on keeps its recall control
                     visible: it is the one action that matters while the words are
                     still the user's, and hiding it behind hover made the undo
                     window impossible to find. The hover actions slide in to its
                     left instead, so the timestamp never drifts away from it. -->
                <div
                  class="mt-1 flex items-center gap-1.5 self-end transition-opacity {recall
                    ? 'opacity-100'
                    : 'opacity-0 group-hover:opacity-100'}"
                >
                  <div
                    class="flex items-center gap-0.5 transition-opacity {recall
                      ? 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'
                      : ''}"
                  >
                    <button
                      class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                      aria-label="Copy message"
                      title="Copy"
                      onclick={() => board.composerScope.copyMessage(msg)}
                    >
                      {#if board.composerScope.copiedMessageId === msg.id}
                        <CioCheck size={12} class="text-success" />
                      {:else}
                        <CioCopy size={12} />
                      {/if}
                    </button>
                    {#if !explicitPresentation}
                      <button
                        class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Edit message"
                        title="Edit   resend replaces the conversation from here down"
                        disabled={board.switchProject.busy}
                        onclick={() => board.currentWorkingTraceAttribution.editMessage(msg)}
                      >
                        <CioPencil size={12} />
                      </button>
                      <button
                        class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-danger disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label="Delete message"
                        title="Delete   removes the conversation up to this message"
                        disabled={board.switchProject.busy}
                        onclick={() => board.editVideoNote.requestDeleteMessage(msg)}
                      >
                        <CioTrash size={12} />
                      </button>
                    {/if}
                  </div>
                  {#if recall}
                    <button
                      class="flex h-5 items-center gap-1 border border-accent/30 bg-accent/10 px-1.5 text-[0.625rem] font-medium tracking-wide text-accent transition-colors hover:border-accent/50 hover:bg-accent/20"
                      aria-label={recall.ariaLabel}
                      title={recall.title}
                      onclick={() => void recall.run()}
                    >
                      <CioUndo size={12} />
                      <span class="uppercase">Recall</span>
                    </button>
                  {/if}
                  <span class="text-[0.625rem] text-dimmed">·</span>
                  <MessageTimestamp at={msg.createdAt} class="text-[0.625rem] text-dimmed" />
                </div>
              {/if}
            </div>
          {/if}
          <!-- A slice of group work that the answer unblocked has no assistant
               row of its own until the harness mirrors one. It reads directly
               under the answer instead of waiting, so the resumed work appears
               where it happened rather than at the end of the turn. -->
          {#if groupThread}
            {#each board.pollStreamParts.segmentsBelow(absIndex) as segment (segment.segmentIndex)}
              {#if groupSliceDraws(segment)}
                <ThreadViewConversationGroupTraceBubble
                  {board}
                  {segment}
                  traceMsg={board.loadOlderMessages.messages[segment.turnStart] ?? msg}
                />
              {/if}
            {/each}
          {/if}
        {:else}
          <!-- Assistant message   one WorkTrace slice per answer the turn crossed -->
          {@const isTurnEnd = board.pollStreamParts.transcriptIndex.isTurnEnd[absIndex] ?? false}
          <!-- A group reply sits at the row that closes its turn. While a steered
               message waits below it, the harness keeps streaming, so that closing
               row would drift past the steer and drag the reply's whole trace into
               the next bubble. Pin the reply to the work row above the steer
               instead, and let the rows under it wait for the turn to split. -->
          {@const heldSteerIndex = groupThread ? board.buildSpecActionPrompt.heldSteerAbsIndex : -1}
          {@const heldSteerAnchor = groupThread ? board.pollStreamParts.heldSteerReplyAnchor : -1}
          {@const pinnedAboveHeldSteer = heldSteerAnchor !== -1 && heldSteerAnchor === absIndex}
          {@const hiddenBehindHeldSteer =
            heldSteerAnchor !== -1 && heldSteerIndex !== -1 && absIndex > heldSteerIndex}
          {@const closesReply = (isTurnEnd && !hiddenBehindHeldSteer) || pinnedAboveHeldSteer}
          {@const provider = messageProvider(msg, board.currentWorkingTraceAttribution.providers)}
          {@const modelLabel = messageModelLabel(
            msg,
            board.currentWorkingTraceAttribution.allModels
          )}
          {@const msgThinking = messageThinkingLevel(
            msg,
            board.currentWorkingTraceAttribution.allModels
          )}
          {@const msgOvenAppearance =
            msg.ovenAppearance ??
            board.currentWorkingTraceAttribution.ovenAppearanceForId(msg.ovenId)}
          {@const msgOvenLabel =
            msg.ovenLabel ?? board.currentWorkingTraceAttribution.ovenLabelForId(msg.ovenId)}
          {@const msgOvenIsLocal = msg.ovenId
            ? msg.ovenId === LOCAL_OVEN_ID
            : msg.ovenLabel === undefined || msg.ovenLabel === 'Local'}
          {@const fastVariant = msg.modelId ? fastVariantForModelId(msg.modelId) : null}
          {@const isLatest = absIndex === board.loadOlderMessages.messages.length - 1}
          {@const questionParts = msg.parts.filter(
            (p): p is Extract<AgentPart, { type: 'question' }> => p.type === 'question'
          )}
          {@const turnDuration = board.pollStreamParts.transcriptIndex.duration[absIndex] ?? null}
          {@const traceSegmentsAbove = board.pollStreamParts.segmentsAbove(absIndex)}
          {@const turnCheckpoint =
            board.pollStreamParts.transcriptIndex.checkpoint[absIndex] ?? null}
          {@const turnAuditReport =
            board.unmirroredTraceStartTime.isAssignmentAuditorThread && isTurnEnd
              ? auditReportForTurn(
                  board.loadOlderMessages.messages,
                  board.buildSpecActionPrompt.auditVersions,
                  absIndex
                )
              : null}

          {#if traceSegmentsAbove.length > 0 || questionParts.length > 0 || closesReply}
            <div class="group mb-6 flex min-w-0 flex-col">
              {#if !groupThread}
                {#each traceSegmentsAbove as segment (segment.segmentIndex)}
                  <ThreadViewConversationTurnTrace {board} {segment} traceMsg={msg} />
                {/each}
              {:else}
                {#each traceSegmentsAbove as segment (segment.segmentIndex)}
                  {#if groupSliceDraws(segment)}
                    <ThreadViewConversationGroupTraceBubble {board} {segment} traceMsg={msg} />
                  {/if}
                {/each}
              {/if}

              {#if closesReply}
                <!-- Final text output + footer   hide only on the active in-progress turn -->
                {#if board.unmirroredTraceStartTime.isAssignmentAuditorThread}
                  {#if !board.pollStreamParts.conversationBusy || !isLatest || turnAuditReport}
                    {#if turnAuditReport}
                      <AuditGeneratedCard
                        state={turnAuditReport.evidenceValidation === 'partial'
                          ? 'partial'
                          : 'report_ready'}
                        version={turnAuditReport.version}
                        validationIssues={turnAuditReport.evidenceIssues ?? []}
                        settings={board.contextUsage.auditSettings}
                        providers={board.currentWorkingTraceAttribution.providers}
                        projectId={board.handleAgentEvent.thread.projectId}
                        favoriteModels={rendererRecovery.favoriteModels}
                        recentModels={rendererRecovery.recentModels}
                        onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
                        onRetry={board.buildSpecActionPrompt.retryAssignmentAuditFromAuditor}
                        onModelChange={board.contextUsage.changeAuditModel}
                        onToggleFavorite={(providerId, modelId, harnessId) =>
                          rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
                        onReorderFavorite={(draggedKey, targetKey, position) =>
                          rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
                        onViewReport={() =>
                          board.currentWorkingTraceAttribution.openCoordinatorAuditReport(
                            turnAuditReport
                          )}
                      />
                    {/if}
                  {/if}
                {:else}
                  {@const turnClosingText = getTurnFinalText(
                    board.loadOlderMessages.messages,
                    absIndex,
                    board.pollStreamParts.isTransparentTurnMessage
                  )}
                  {@const turnClosingVisible = board.pollStreamParts.closingStatementVisible(
                    absIndex,
                    isLatest
                  )}
                  {@const rawClosingText = turnClosingText?.text ?? messageText(msg)}
                  {@const deliveredClosingText = conversationAnswerText(
                    textScope,
                    rawClosingText,
                    !msg.completedAt
                  )}
                  <!-- A group reply renders from its first streamed word instead of
                       waiting for the turn to hand the floor back: hiding the
                       bubble withheld the whole answer while the agent was still
                       writing it, so the message simply vanished mid-stream. -->
                  {#if (turnClosingText && (groupThread || turnClosingVisible)) || pinnedAboveHeldSteer}
                    {@const isReadingThisTurn =
                      'messageId' in speechController.playback &&
                      speechController.playback.messageId === msg.id &&
                      (speechController.playback.state === 'preparing' ||
                        speechController.playback.state === 'playing' ||
                        speechController.playback.state === 'paused')}
                    {@const isReadingActiveLine =
                      isReadingThisTurn &&
                      speechController.activeSegments !== null &&
                      speechController.activeSegments.length > 0 &&
                      speechController.readingOverlayActive}
                    <div
                      id={`msg-${msg.id}`}
                      class={groupThread
                        ? 'message-block min-w-0 max-w-[90%] border border-border bg-surface px-3.5 py-2.5 text-[0.8125rem] text-foreground'
                        : 'message-block min-w-0 w-full text-[0.8125rem] text-foreground'}
                      data-assistant-response
                      data-conversation-searchable
                      data-message-id={msg.id}
                      role="group"
                      ondblclick={(event) => beginReply(event, msg)}
                    >
                      <!-- Who answered. Drawn only in a group thread, and only
                           over the reply's text: the working trace above and
                           the metadata footer below belong to the turn, not to
                           a speaker. -->
                      {#if groupThread}
                        {@const speaker = groupSpeakerFor(board.handleAgentEvent.thread, msg)}
                        {@const replySource = replyTargetFor(msg)}
                        {#if speaker}
                          <ThreadMessageSpeaker
                            name={speaker.name}
                            icon={speaker.icon}
                            color={speaker.color}
                            plate={speaker.plate}
                            class="mb-1.5"
                            onOpen={replySource &&
                            replySource.threadId !== board.handleAgentEvent.thread.id
                              ? () =>
                                  void openThreadById(replySource.projectId, replySource.threadId)
                              : undefined}
                          />
                        {/if}
                        <!-- The work this answer came from, inside the same reply:
                             no band of its own, capped, and scrolling within that
                             cap so it never resizes the bubble around it. A turn is
                             stored as several rows, so the whole turn is drawn here
                             from the row that closes it: nothing of this turn may
                             render above the bubble instead. -->
                        {@const turnOpeningIndex = turnStartIndexForEnd(
                          board.loadOlderMessages.messages,
                          absIndex,
                          board.pollStreamParts.isTransparentTurnMessage
                        )}
                        {@const turnMessageIds = new Set(
                          board.loadOlderMessages.messages
                            .slice(turnOpeningIndex, absIndex + 1)
                            .map((message) => message.id)
                        )}
                        {@const turnIsCut =
                          board.pollStreamParts.turnHasAnswerCuts(turnOpeningIndex)}
                        {#if !turnIsCut}
                          {#each board.pollStreamParts.completedTurnViews.filter( (view) => turnMessageIds.has(view.anchorId) ) as view (view.turn.endTs)}
                            <ThreadViewConversationCompletedTurnTrace {board} turn={view.turn} />
                          {/each}
                          <!-- One trace per reply. A turn with no answered
                               question reads whole inside the bubble that closes
                               it. A turn the reader answered is cut instead: each
                               slice draws at its own mount point, so the answer
                               card sits between the work that asked it and the
                               work it unblocked, and drawing it whole here would
                               repeat that work under the answer. -->
                          <ThreadViewConversationTurnTrace
                            {board}
                            segment={board.pollStreamParts.wholeTurnSegment(turnOpeningIndex)}
                            traceMsg={msg}
                            inlineInBubble
                            closingTextIdOverride={pinnedAboveHeldSteer
                              ? (turnClosingText?.id ?? null)
                              : undefined}
                          />
                        {/if}
                      {/if}
                      {#if isReadingActiveLine}
                        <!-- The read-along only exists while a turn is being
                                 spoken, so its chunk waits for playback instead
                                 of riding along with the first screen. -->
                        {#await loadCachedPanelModule('module:lib/components/speech/ReadAlongOverlay.svelte', () => import('../../speech/ReadAlongOverlay.svelte')) then { default: ReadAlongOverlay }}
                          <ReadAlongOverlay
                            segments={speechController.activeSegments!}
                            activeIndex={speechController.visibleSegmentIndex}
                            spokenProgress={speechController.activeSegmentProgress}
                            textClass="text-[0.8125rem]"
                          />
                        {/await}
                      {:else}
                        <!-- The agent's closing statement is the turn's answer;
                                 the running commentary it wrote between tool calls
                                 lives in the trace above. In the Assistant view the
                                 answer may carry the drafted knowledge, which is a
                                 document rather than a code block, so it is shown as
                                 the finished markdown it is. -->
                        {@const assistantInlineTags = inlineFileTagsForMessage(
                          msg,
                          board.props.assistantSpaceThreads
                            ? {
                                threads: board.props.assistantSpaceThreads,
                                assistants: assistants.assistants,
                                assistantIcons: assistants.iconUrls
                              }
                            : undefined
                        )}
                        <DeferredMarkdownView
                          text={deliveredClosingText}
                          citationThread={board.unmirroredTraceStartTime.citationThreadContext}
                          annotationScope={{
                            projectId: board.handleAgentEvent.thread.projectId,
                            threadId: board.handleAgentEvent.thread.id
                          }}
                          inlineFileTags={assistantInlineTags}
                          onOpenAssistantTag={board.state.openAssistantTag}
                          onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
                          onOpenLocalFile={(url) =>
                            void board.unmirroredTraceStartTime.openFilePart(url)}
                        />
                      {/if}
                    </div>
                  {/if}

                  {#if absIndex === board.loadOlderMessages.messages.length - 1}
                    {reportTailCard({
                      threadId: board.handleAgentEvent.thread.id,
                      absIndex,
                      messages: board.loadOlderMessages.messages.length,
                      visible: board.composerScope.visibleMessages.length,
                      msgId: msg.id,
                      isTurnEnd,
                      chatMode: board.props.chatMode,
                      checkpoint: turnCheckpoint?.id ?? null,
                      changes: turnCheckpoint?.changes.length ?? -1,
                      card: board.pollStreamParts.transcriptIndex.checkpointCard[absIndex] ?? false
                    })}
                  {/if}
                  {#if !board.props.chatMode && turnCheckpoint && turnCheckpoint.changes.length > 0 && (board.pollStreamParts.transcriptIndex.checkpointCard[absIndex] ?? false)}
                    <div class="mt-3">
                      <!-- The run's change card only exists once a run has settled
                           with changes to show, so it loads when that happens
                           instead of riding the first screen. -->
                      {#await loadCachedPanelModule('module:lib/components/threads/RunChangesCard.svelte', () => import('../RunChangesCard.svelte')) then { default: RunChangesCard }}
                        <RunChangesCard
                          checkpoint={turnCheckpoint}
                          projectId={board.handleAgentEvent.thread.projectId}
                          threadId={board.handleAgentEvent.thread.id}
                          cited={citedForCard(absIndex)}
                          onRevealFile={(path) =>
                            board.unmirroredTraceStartTime.revealCheckpointFile(
                              turnCheckpoint.id,
                              path
                            )}
                          onOpenFile={(path) =>
                            void board.unmirroredTraceStartTime.openCheckpointFile(
                              turnCheckpoint.id,
                              path
                            )}
                          onReview={() =>
                            board.unmirroredTraceStartTime.reviewCheckpoint(turnCheckpoint.id)}
                          onUndo={() => board.abortRun.undoCheckpoint(turnCheckpoint)}
                          onRedo={() => board.abortRun.redoCheckpoint(turnCheckpoint)}
                        />
                      {/await}
                    </div>
                  {/if}

                  <!-- A steered turn reports what it had already changed before
                           the steer, above the steered message; the turn's own card at
                           its end repeats those files with everything after them. -->
                  {@const steeredPromptIndex =
                    board.pollStreamParts.transcriptIndex.steerCard[absIndex] ?? null}
                  {#if !board.props.chatMode && turnCheckpoint && steeredPromptIndex !== null}
                    {@const steeredChanges = changesBeforeSteer(
                      turnCheckpoint,
                      board.pollStreamParts.transcriptIndex.messageIndexById,
                      steeredPromptIndex
                    )}
                    {#if steeredChanges.length > 0 && steeredChanges.length < turnCheckpoint.changes.length}
                      {@const steeredCheckpoint = {
                        ...turnCheckpoint,
                        changes: steeredChanges
                      }}
                      <div class="mt-3">
                        {#await loadCachedPanelModule('module:lib/components/threads/RunChangesCard.svelte', () => import('../RunChangesCard.svelte')) then { default: RunChangesCard }}
                          <RunChangesCard
                            checkpoint={steeredCheckpoint}
                            projectId={board.handleAgentEvent.thread.projectId}
                            threadId={board.handleAgentEvent.thread.id}
                            steered
                            onRevealFile={(path) =>
                              board.unmirroredTraceStartTime.revealCheckpointFile(
                                turnCheckpoint.id,
                                path
                              )}
                            onOpenFile={(path) =>
                              void board.unmirroredTraceStartTime.openCheckpointFile(
                                turnCheckpoint.id,
                                path
                              )}
                            onReview={() =>
                              board.unmirroredTraceStartTime.reviewCheckpoint(turnCheckpoint.id)}
                            onUndo={() => board.abortRun.undoCheckpoint(turnCheckpoint)}
                            onRedo={() => board.abortRun.redoCheckpoint(turnCheckpoint)}
                          />
                        {/await}
                      </div>
                    {/if}
                  {/if}

                  {#if !board.switchProject.busy || !isLatest}
                    <!-- Footer shown once per turn on the last assistant message -->
                    <div class="mt-1 flex flex-col" data-message-actions>
                      <div class="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                        <div class="flex shrink-0 items-center gap-0.5">
                          <button
                            class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                            aria-label="Copy message"
                            title="Copy"
                            onclick={() =>
                              board.composerScope.copyMessage(msg, deliveredClosingText)}
                          >
                            {#if board.composerScope.copiedMessageId === msg.id}
                              <CioCheck size={12} class="text-success" />
                            {:else}
                              <CioCopy size={12} />
                            {/if}
                          </button>
                          <SpeechPlaybackButton
                            messageId={msg.id}
                            markdown={deliveredClosingText}
                            scope={{
                              kind: 'project',
                              projectId: board.handleAgentEvent.thread.projectId,
                              threadId: board.handleAgentEvent.thread.id
                            }}
                          />
                          {#if board.props.onContinueInThread && board.props.controller?.kind === 'temporary-chat'}
                            <button
                              class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label="Continue this chat in a new thread"
                              title="Continue in a new thread"
                              disabled={board.composerScope.continuingInThread}
                              onclick={() => void board.composerScope.continueInThread()}
                            >
                              {#if board.composerScope.continuingInThread}
                                <CioSpinner size={12} class="animate-spin" />
                              {:else}
                                <CioMessage size={12} />
                              {/if}
                            </button>
                          {/if}
                          {#if board.props.onAttachToParent && board.props.controller?.kind === 'temporary-chat'}
                            <!-- The side chat becomes durable and rides the chat
                                 it was opened from as context, so the agent can
                                 read it back without the user leaving the turn
                                 they were writing. -->
                            <button
                              class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label="Attach this chat to the main chat"
                              title="Attach to main chat"
                              disabled={board.composerScope.attachingToParent}
                              onclick={() => void board.composerScope.attachToParent()}
                            >
                              {#if board.composerScope.attachingToParent}
                                <CioSpinner size={12} class="animate-spin" />
                              {:else}
                                <CioArrowLeft size={12} />
                              {/if}
                            </button>
                          {/if}
                          <!-- Forking is offered in a group conversation too: Don's
                               replies are the work that gets carried into a
                               conversation of its own, and the fork keeps the
                               group's speakers. -->
                          {#if board.props.controller?.kind !== 'temporary-chat'}
                            <button
                              class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label="Fork thread from this message"
                              title="Fork from here"
                              disabled={board.editVideoNote.forkingMessageId !== null}
                              onclick={() => board.editVideoNote.forkFromMessage(msg)}
                            >
                              {#if board.editVideoNote.forkingMessageId === msg.id}
                                <CioSpinner size={12} class="animate-spin" />
                              {:else}
                                <CioFork size={12} />
                              {/if}
                            </button>
                          {/if}
                          {#if board.props.chatMode && board.props.onContinueInProject && !groupThread}
                            <button
                              class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                              aria-label="Continue this chat in a project"
                              title="Continue in a project"
                              onclick={() =>
                                board.studioTemporaryChatContext.openContinueInProject()}
                            >
                              <CioFolderInput size={12} />
                            </button>
                          {/if}
                          <button
                            class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                            aria-label="Export this conversation as a transcript"
                            title="Export transcript"
                            onclick={board.sources.openTranscriptExport}
                          >
                            <CioDownload size={12} />
                          </button>
                          {#if groupThread}
                            {@const replyTarget = replyTargetFor(msg)}
                            {#if replyTarget}
                              <button
                                class="p-1 text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
                                aria-label={`Reply to ${replyTarget.speakerName}`}
                                title="Reply to this message"
                                onclick={() => board.directReply.attach(replyTarget)}
                              >
                                <CioReplyMark size={12} />
                              </button>
                            {/if}
                          {/if}
                        </div>
                        <div
                          class="pointer-events-none flex shrink-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 whitespace-nowrap opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                        >
                          <span class="flex items-center gap-1 text-[0.625rem] text-dimmed">
                            <AgentIcon
                              agentId={resolveMessageHarnessId(
                                msg,
                                board.unmirroredTraceStartTime.messageHarnessFallback
                              )}
                              size={14}
                            />
                            {messageHarnessName(
                              msg,
                              board.unmirroredTraceStartTime.messageHarnessFallback
                            )}
                          </span>
                          {#if modelLabel}
                            <span class="text-[0.625rem] text-dimmed">·</span>
                            <span class="flex items-center gap-1 text-[0.625rem] text-dimmed">
                              <VendorIcon
                                name={provider?.name ?? modelLabel}
                                id={provider?.id}
                                size={12}
                              />
                              {modelLabel}
                              {#if fastVariant}
                                <CioZap
                                  size={10}
                                  class="text-accent"
                                  fill="currentColor"
                                  aria-label="Fast inference"
                                  title={`Fast inference   ~${fastVariant.multiplier}× usage`}
                                />
                              {/if}
                            </span>
                            {#if msgThinking}
                              <span
                                class={`${CONVERSATION_METADATA_BADGE_CLASS} capitalize`}
                                title={`Thinking level: ${msgThinking}`}
                                aria-label={`Thinking level: ${msgThinking}`}
                              >
                                <board.state.ThinkingMetadataIcon size={9} />
                                {msgThinking}
                              </span>
                            {/if}
                          {/if}
                          {#if msg.accountId || msg.accountLabel}
                            <span
                              class={CONVERSATION_METADATA_BADGE_CLASS}
                              title={`Account: ${msg.accountLabel ?? 'Default'}`}
                              aria-label={`Account: ${msg.accountLabel ?? 'Default'}`}
                            >
                              <board.state.AccountMetadataIcon size={10} />
                              {#if msg.accountLabel && msg.accountLabel !== 'Default'}{msg.accountLabel}{/if}
                            </span>
                          {/if}
                          <span
                            class={CONVERSATION_METADATA_BADGE_CLASS}
                            title={`Oven: ${msgOvenLabel}`}
                            aria-label={`Oven: ${msgOvenLabel}`}
                          >
                            {#if msgOvenIsLocal}
                              <board.state.LocalMetadataIcon size={10} class="shrink-0" />
                            {:else}
                              <img
                                class="h-3 w-3 shrink-0"
                                alt=""
                                src={msgOvenAppearance.customSvg
                                  ? getCustomSvgDataUrl(
                                      msgOvenAppearance.customSvg,
                                      msgOvenAppearance.color
                                    )
                                  : getIconSvgDataUrl(
                                      msgOvenAppearance.icon,
                                      msgOvenAppearance.color
                                    )}
                              />
                            {/if}
                            {msgOvenLabel}
                          </span>
                          <MessageTimestamp
                            at={msg.completedAt ?? msg.createdAt}
                            prefix="· "
                            class="text-[0.625rem] text-dimmed"
                          />
                          {#if turnDuration !== null}
                            <span class="text-[0.625rem] text-dimmed tabular-nums"
                              >· {formatDurationMs(turnDuration)}</span
                            >
                          {:else if msg.completedAt && msg.createdAt}
                            <span class="text-[0.625rem] text-dimmed tabular-nums"
                              >· {formatDurationMs(msg.completedAt - msg.createdAt)}</span
                            >
                          {/if}
                          {#if messageTokenRate( msg, { finalizedTokenRates: board.unmirroredTraceStartTime.finalizedTokenRates, liveTokenRate: board.handleAgentEvent.liveTokenRate } ) !== null}
                            {@const rate =
                              messageTokenRate(msg, {
                                finalizedTokenRates:
                                  board.unmirroredTraceStartTime.finalizedTokenRates,
                                liveTokenRate: board.handleAgentEvent.liveTokenRate
                              }) ?? 0}
                            <span class="text-[0.625rem] text-dimmed tabular-nums">
                              · {formatTokenRate(rate)}</span
                            >
                          {/if}
                        </div>
                      </div>
                    </div>
                  {/if}
                {/if}
              {/if}
            </div>
          {/if}
        {/if}
        {#if !groupThread}
          {#each board.pollStreamParts.segmentsBelow(absIndex) as segment (segment.segmentIndex)}
            <ThreadViewConversationTurnTrace
              {board}
              {segment}
              traceMsg={board.loadOlderMessages.messages[segment.turnStart] ?? msg}
            />
          {/each}
        {:else}
          {#each board.pollStreamParts.segmentsBelow(absIndex) as segment (segment.segmentIndex)}
            {#if groupSliceDraws(segment)}
              <ThreadViewConversationGroupTraceBubble
                {board}
                {segment}
                traceMsg={board.loadOlderMessages.messages[segment.turnStart] ?? msg}
              />
            {/if}
          {/each}
        {/if}
      {/each}

      <!-- Dispatched threads answer here, as replies from their own assistant or
           project, so the conversation can hold several threads at once and none
           of them has to wait for this one to be idle. -->
      {#key `${board.handleAgentEvent.thread.projectId}:${board.handleAgentEvent.thread.id}`}
        <DelegatedAttentionStack
          projectId={board.handleAgentEvent.thread.projectId}
          threadId={board.handleAgentEvent.thread.id}
        />
      {/key}

      {#if (board.buildSpecActionPrompt.pendingLiveTurn && board.buildSpecActionPrompt.heldSteerAbsIndex === -1) || board.pollStreamParts.settledTurnParts.length > 0 || liveGroupTrace}
        {@const tracePartsForTurn = board.buildSpecActionPrompt.pendingLiveTurn
          ? board.composerScope.unmirroredTraceParts
          : liveGroupTrace
            ? liveGroupTrace.parts
            : board.pollStreamParts.settledTurnParts}
        {@const traceBusyForTurn =
          Boolean(board.buildSpecActionPrompt.pendingLiveTurn) || liveGroupTrace !== null}
        {#if groupThread}
          <!-- In a group conversation the work is part of the reply, not a band
               above it: the bubble opens with who is speaking, the trace sits
               inside it at one fixed height, and the folded line underneath still
               says what is happening. -->
          {@const liveSpeaker = groupSpeakerForThread(board.handleAgentEvent.thread)}
          <GroupReplyBubble
            name={liveSpeaker?.name ?? board.handleAgentEvent.thread.title}
            icon={liveSpeaker?.icon ?? null}
            color={liveSpeaker?.color}
            plate={liveSpeaker?.plate ?? false}
          >
            <ThreadViewConversationLiveTurnTrace
              {board}
              traceParts={tracePartsForTurn}
              traceBusy={traceBusyForTurn}
              inGroupBubble
            />
            {#if traceBusyForTurn}
              <TraceActivityLine
                parts={board.pollStreamParts.latestTurnRenderableParts}
                folded={!agentRuns.isTraceOpen(
                  board.handleAgentEvent.thread.projectId,
                  board.pollStreamParts.conversationId
                )}
                onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
                formatProse={conversationLiveProse}
              />
            {/if}
          </GroupReplyBubble>
        {:else}
          <ThreadViewConversationLiveTurnTrace
            {board}
            traceParts={tracePartsForTurn}
            traceBusy={traceBusyForTurn}
          />
        {/if}
      {/if}

      {#if board.sources.specGenerationTraceActive && board.sources.specGenerationTraceParts.length > 0}
        <WorkingTrace
          parts={board.sources.specGenerationTraceParts}
          open
          busy={board.switchProject.busy}
          startTime={board.sources.specGenerationTraceStartedAt}
          headerLabel="Spec draft"
          projectId={board.handleAgentEvent.thread.projectId}
          threadId={board.handleAgentEvent.thread.id}
        />
      {/if}

      {#if receiptThread}
        {@const receipt = runReceiptState.receiptFor(receiptThread.id)}
        {#if receipt}
          {#await loadCachedPanelModule(PANEL_KEYS.runReceipt, () => import('../RunReceipt.svelte'))}
            <!-- The receipt loads after a run settles, so the wait is a blank line
                 rather than a placeholder that would claim a receipt exists. -->
            <div class="h-4" aria-hidden="true"></div>
          {:then { default: RunReceiptBlock }}
            <RunReceiptBlock thread={receiptThread} {receipt} />
          {:catch}
            <!-- A receipt that cannot load leaves the conversation exactly as it
                 was: it is evidence, never a requirement. -->
          {/await}
        {/if}
      {/if}

      {#if board.pollStreamParts.conversationBusy && !groupThread}
        <!-- The line reports the work in progress whenever the trace is folded,
             whoever folded it: the trace draws the fold state the run store
             keeps, so this reads the same value it does. -->
        <TraceActivityLine
          parts={board.pollStreamParts.latestTurnRenderableParts}
          folded={!agentRuns.isTraceOpen(
            board.handleAgentEvent.thread.projectId,
            board.pollStreamParts.conversationId
          )}
          onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
          formatProse={conversationLiveProse}
        />
      {/if}

      {#if board.unmirroredTraceStartTime.brainstormReportRefreshing || (board.buildSpecActionPrompt.delegatedWorkBusy && !board.pollStreamParts.conversationBusy) || board.composerScope.assignmentFormulating || (board.buildSpecActionPrompt.heldSteerAbsIndex === -1 && !board.buildSpecActionPrompt.pendingLiveTurn && !board.submitBrainstormDecision.activePlanningEntry && !board.harnessUsage.specFormulating && board.switchProject.busy && board.pollStreamParts.latestTurnRenderableParts.length === 0)}
        <div class="flex items-center gap-2 text-sm text-dimmed">
          <ThinkingOrb size={20} label={board.submitBrainstormDecision.activityLabel} />
          <span>
            {board.unmirroredTraceStartTime.brainstormReportRefreshing
              ? board.unmirroredTraceStartTime.brainstormActivityLabel
              : board.buildSpecActionPrompt.delegatedWorkBusy
                ? board.switchProject.delegatedActivityLabel
                : board.submitBrainstormDecision.activityLabel}
          </span>
          <span class="text-[0.75rem]">…</span>
        </div>
      {/if}
    {/if}
  </div>
</div>
