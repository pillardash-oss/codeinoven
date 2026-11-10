<script lang="ts">
  import type { ThreadView as ThreadViewBoard } from './ThreadView-board.svelte'
  import CioAudioLines from '@pdslng/cio-icon/CioAudioLines.svelte'
  import CioCheck from '@pdslng/cio-icon/CioCheck.svelte'
  import CioClapper from '@pdslng/cio-icon/CioClapper.svelte'
  import CioCopy from '@pdslng/cio-icon/CioCopy.svelte'
  import CioDownload from '@pdslng/cio-icon/CioDownload.svelte'
  import CioFileText from '@pdslng/cio-icon/CioFileText.svelte'
  import CioFolderInput from '@pdslng/cio-icon/CioFolderInput.svelte'
  import CioFork from '@pdslng/cio-icon/CioFork.svelte'
  import CioMessage from '@pdslng/cio-icon/CioMessage.svelte'
  import CioPencil from '@pdslng/cio-icon/CioPencil.svelte'
  import CioSpinner from '@pdslng/cio-icon/CioSpinner.svelte'
  import CioTrash from '@pdslng/cio-icon/CioTrash.svelte'
  import CioUndo from '@pdslng/cio-icon/CioUndo.svelte'
  import CioZap from '@pdslng/cio-icon/CioZap.svelte'
  import ConversationSkeleton from './ConversationSkeleton.svelte'
  import { shouldMountWorkingTrace } from '$lib/working-trace-parts'
  import { formatDurationMs } from '$lib/format/duration'
  import { fly } from 'svelte/transition'
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
  import RunChangesCard from '../RunChangesCard.svelte'
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
  import { assistantAccentColor, getAssistantIcon } from '$lib/assistant-icons'
  import CioUserMark from '$lib/components/icons/cio/CioUserMark.svelte'
  import ThreadMessageSpeaker from '../ThreadMessageSpeaker.svelte'
  import DelegatedAttentionStack from '../DelegatedAttentionStack.svelte'
  import { isGroupThread } from '$shared/types'
  import { conversationAnswerText, conversationProseText } from '../conversation-text'
  import MessageTimestamp from '$lib/components/shared/MessageTimestamp.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { modelKey } from '$lib/model-keys'
  import { promptArrive } from '$lib/motion'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { logRendererDev } from '$lib/system/renderer-logger'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
  import type { AgentMessage, AgentPart, TurnStreamCompletedTurn } from '$shared/types'
  import { formatTokenRate } from '$lib/token-rate.svelte'
  import {
    auditReportForTurn,
    changesBeforeSteer,
    getTurnFinalText,
    isActivityOnlyUserMessage,
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

  function conversationTraceOutput(text: string): string {
    return conversationProseText(textScope, text)
  }

  /**
   * The newest words a live step left behind, read the same way the answer is.
   *
   * The activity line under the transcript draws that prose before the answer
   * exists, so it can hold the app's own `<assistant_result>` boundary while the
   * run is still working. A run that has not opened its result yet says nothing
   * here, and the line reports what the agent is doing instead.
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

  /** One assistant a group thread's transcript names above its reply. */
  interface GroupSpeaker {
    name: string
    icon: string | null
    color: string
  }

  /**
   * The assistant that spoke one reply in a group thread, or null when there is
   * nobody left to name.
   *
   * The message's own `author` snapshot wins, because it is what the reply read
   * as when it was written: an assistant can be renamed, re-iconed or deleted
   * after it spoke, and the conversation that happened must keep reading as
   * itself. A reply with no snapshot is the thread's own assistant speaking (the
   * host of a group opens the conversation as itself), so it is resolved through
   * the assistants the renderer already holds rather than through a second path.
   *
   * The icon comes from `getAssistantIcon`, the same resolution every assistant
   * surface uses, with the stored image icon by id as its highest priority.
   */
  function groupSpeakerFor(msg: AgentMessage): GroupSpeaker | null {
    const author = msg.author
    if (author) {
      return {
        name: author.name,
        icon: getAssistantIcon(author, assistants.iconUrls.get(author.assistantId) ?? null),
        color: assistantAccentColor(author)
      }
    }
    return groupSpeakerForThread()
  }

  /** The speaker of this thread's own replies, when the thread runs as one
   *  assistant. Used before any message exists, so a live reply can open with the
   *  name it will answer under. */
  function groupSpeakerForThread(): GroupSpeaker | null {
    const assistant = assistants.assistantForTask(board.handleAgentEvent.thread)
    if (!assistant) return null
    return {
      name: assistant.name,
      icon: getAssistantIcon(assistant, assistants.iconUrls.get(assistant.id) ?? null),
      color: assistantAccentColor(assistant)
    }
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
      <!-- The live or settled trace for a turn with no mirrored assistant
               row. It renders as its own block so a held steer can be placed
               after it instead of above the work it interrupts. -->
      {#snippet liveTurnTrace(traceParts: AgentPart[], traceBusy: boolean, inGroupBubble = false)}
        <WorkingTrace
          parts={traceParts}
          open
          compact={inGroupBubble}
          bodyMaxHeightRem={inGroupBubble ? 14 : undefined}
          busy={traceBusy}
          done={!traceBusy}
          note={traceBusy ? board.unmirroredTraceStartTime.workingStatusNote : null}
          active={board.props.active}
          olderPartsAvailable={board.pollStreamParts.streamTrace.hasOlder}
          onLoadOlderParts={board.pollStreamParts.loadOlderStreamParts}
          totalSteps={board.pollStreamParts.streamTrace.totalSteps}
          turnSubagentParts={board.pollStreamParts.streamTrace.subagentParts}
          turnCompacted={board.pollStreamParts.streamTrace.turnCompacted}
          turnSpan={board.pollStreamParts.streamTrace.turnSpan}
          startTime={board.unmirroredTraceStartTime.unmirroredTraceStartTime}
          modelLabel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .modelLabel}
          thinkingLevel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .thinkingLevel}
          providerName={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .providerName}
          providerId={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .providerId}
          harnessId={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.harnessId}
          harnessName={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .harnessName}
          accountLabel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .accountLabel}
          accountId={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.accountId}
          ovenLabel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.ovenLabel}
          ovenIsLocal={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .ovenIsLocal}
          ovenAppearance={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .ovenAppearance}
          isFast={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.isFast}
          initialOpen={agentRuns.isTraceOpen(
            board.handleAgentEvent.thread.projectId,
            board.pollStreamParts.conversationId
          )}
          initialUserOpened={agentRuns.isTraceUserOpened(
            board.handleAgentEvent.thread.projectId,
            board.pollStreamParts.conversationId
          )}
          initiallyFolded={agentRuns.isTraceUserFolded(
            board.handleAgentEvent.thread.projectId,
            board.pollStreamParts.conversationId
          )}
          projectId={board.handleAgentEvent.thread.projectId}
          threadId={board.handleAgentEvent.thread.id}
          onToggle={(open, userOpened, userFolded) =>
            agentRuns.setTraceOpen(
              board.handleAgentEvent.thread.projectId,
              board.pollStreamParts.conversationId,
              open,
              userOpened,
              userFolded
            )}
          onOpenSubagent={board.unmirroredTraceStartTime.openSubagent}
          onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
          formatOutput={conversationTraceOutput}
        />
      {/snippet}
      <!-- A turn a prompt closed whose work the transcript never mirrored:
               the durable log's record of it, rendered settled. It owns no
               session any more, so it shows no spinner, and it ships its step
               total with the newest window of entries, paging the rest in as
               the reader opens it. -->
      {#snippet completedTurnTraceBlock(turn: TurnStreamCompletedTurn)}
        <WorkingTrace
          parts={turn.parts}
          done
          busy={false}
          totalSteps={turn.totalSteps}
          turnSubagentParts={turn.subagentParts}
          turnCompacted={turn.turnCompacted}
          turnSpan={turn.turnSpan}
          startTime={turn.startTs}
          endTime={turn.endTs}
          active={board.props.active}
          olderPartsAvailable={turn.hasOlder}
          onLoadOlderParts={() => board.pollStreamParts.loadOlderCompletedTurnParts(turn.endTs)}
          projectId={board.handleAgentEvent.thread.projectId}
          threadId={board.handleAgentEvent.thread.id}
          modelLabel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .modelLabel}
          thinkingLevel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .thinkingLevel}
          providerName={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .providerName}
          providerId={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .providerId}
          harnessId={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.harnessId}
          harnessName={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .harnessName}
          accountLabel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .accountLabel}
          accountId={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.accountId}
          ovenLabel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.ovenLabel}
          ovenIsLocal={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .ovenIsLocal}
          ovenAppearance={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
            .ovenAppearance}
          isFast={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.isFast}
          onOpenSubagent={board.unmirroredTraceStartTime.openSubagent}
          onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
          formatOutput={conversationTraceOutput}
        />
      {/snippet}
      <!-- One slice of a turn's working trace. A turn the reader answered is cut
           at that answer, so the work that led to the question, the answer card,
           and the work the answer unblocked read in the order they happened. -->
      {#snippet turnTraceSegment(
        segment: TraceSegmentLayout,
        traceMsg: AgentMessage,
        inlineInBubble = false
      )}
        {@const turnStart = segment.turnStart}
        {@const turnDone = board.pollStreamParts.transcriptIndex.turnCompleted[turnStart] ?? false}
        {@const isTraceTurnLatest =
          turnStart === board.buildSpecActionPrompt.latestTurnInfo.startIndex}
        {@const isCurrentAssistantTurn =
          isTraceTurnLatest &&
          board.buildSpecActionPrompt.latestTurnInfo.active &&
          !board.buildSpecActionPrompt.pendingLiveTurn}
        {@const traceIsLive =
          board.unmirroredTraceStartTime.threadWorking &&
          isCurrentAssistantTurn &&
          !turnDone &&
          !board.unmirroredTraceStartTime.brainstormReportRefreshing}
        {@const traceIsRestored =
          board.buildSpecActionPrompt.restoredBusy &&
          isCurrentAssistantTurn &&
          !board.unmirroredTraceStartTime.liveBusy &&
          !turnDone}
        {@const traceRunIsForeign = foreignRuns.isForeign(
          board.handleAgentEvent.thread.projectId,
          board.handleAgentEvent.thread.id
        )}
        {@const turnEndIndex =
          board.pollStreamParts.transcriptIndex.turnEnd[turnStart] ?? turnStart}
        {@const turnClosingText = getTurnFinalText(
          board.loadOlderMessages.messages,
          turnEndIndex,
          board.pollStreamParts.isTransparentTurnMessage
        )}
        {@const turnClosingVisible = board.pollStreamParts.closingStatementVisible(
          turnEndIndex,
          turnEndIndex === board.loadOlderMessages.messages.length - 1
        )}
        <!-- A group reply's answer is its own text in its own bubble, so the work
             inside that bubble never carries a copy of it: that copy is what made
             the trace show a clipped second answer above the real one. -->
        {@const traceHoldsClosingText = !groupThread && traceIsLive && !turnClosingVisible}
        {@const traceIsLiveTurn = isCurrentAssistantTurn || traceIsLive || traceIsRestored}
        {@const turnClosingTextId =
          turnClosingVisible && turnClosingText ? turnClosingText.id : null}
        {@const turnParts = board.pollStreamParts.segmentTraceParts(
          segment,
          traceIsLiveTurn,
          turnClosingTextId,
          traceHoldsClosingText
        )}
        {@const segmentIsLast = segment.segmentIndex === segment.boundaries.length}
        {@const segmentBusy = traceIsLive && segmentIsLast}
        {@const segmentDone = segmentIsLast ? turnDone : true}
        {@const segmentStartTime =
          segment.segmentIndex === 0
            ? isTraceTurnLatest
              ? (board.composerScope.getTurnStartTime(turnStart) ??
                board.studioTemporaryChatContext.activeTurnStartTime)
              : board.composerScope.getTurnStartTime(turnStart)
            : segment.answerIndex === null
              ? undefined
              : board.loadOlderMessages.messages[segment.answerIndex]?.createdAt}
        {@const useSegmentLiveAttribution =
          isTraceTurnLatest &&
          board.buildSpecActionPrompt.latestTurnInfo.active &&
          board.unmirroredTraceStartTime.liveBusy}
        {@const segmentProvider = messageProvider(
          traceMsg,
          board.currentWorkingTraceAttribution.providers
        )}
        {@const segmentModelLabel = messageModelLabel(
          traceMsg,
          board.currentWorkingTraceAttribution.allModels
        )}
        {@const segmentThinking = messageThinkingLevel(
          traceMsg,
          board.currentWorkingTraceAttribution.allModels
        )}
        {@const segmentOvenAppearance =
          traceMsg.ovenAppearance ??
          board.currentWorkingTraceAttribution.ovenAppearanceForId(traceMsg.ovenId)}
        {@const segmentOvenLabel =
          traceMsg.ovenLabel ??
          board.currentWorkingTraceAttribution.ovenLabelForId(traceMsg.ovenId)}
        {@const segmentOvenIsLocal = traceMsg.ovenId
          ? traceMsg.ovenId === LOCAL_OVEN_ID
          : traceMsg.ovenLabel === undefined || traceMsg.ovenLabel === 'Local'}
        {@const segmentFastVariant = traceMsg.modelId
          ? fastVariantForModelId(traceMsg.modelId)
          : null}
        {@const segmentHarnessId = resolveMessageHarnessId(
          traceMsg,
          board.unmirroredTraceStartTime.messageHarnessFallback
        )}
        {@const segmentHarnessName = messageHarnessName(
          traceMsg,
          board.unmirroredTraceStartTime.messageHarnessFallback
        )}
        {@const segmentCheckpoint =
          board.pollStreamParts.transcriptIndex.checkpoint[turnStart] ?? null}
        {#snippet segmentTrace()}
          <WorkingTrace
            parts={turnParts}
            compact={groupThread}
            bodyMaxHeightRem={groupThread ? 14 : undefined}
            open={isCurrentAssistantTurn || traceIsLive}
            busy={segmentBusy}
            done={segmentDone}
            formatOutput={conversationTraceOutput}
            rehydrated={traceIsRestored && segmentIsLast}
            foreignRun={traceRunIsForeign}
            active={board.props.active}
            olderPartsAvailable={isCurrentAssistantTurn &&
              segmentIsLast &&
              board.pollStreamParts.streamTrace.hasOlder}
            onLoadOlderParts={isCurrentAssistantTurn && segmentIsLast
              ? board.pollStreamParts.loadOlderStreamParts
              : undefined}
            totalSteps={isCurrentAssistantTurn && segmentIsLast
              ? board.pollStreamParts.streamTrace.totalSteps
              : undefined}
            turnSubagentParts={isCurrentAssistantTurn && segmentIsLast
              ? board.pollStreamParts.streamTrace.subagentParts
              : undefined}
            turnCompacted={isCurrentAssistantTurn && segmentIsLast
              ? board.pollStreamParts.streamTrace.turnCompacted
              : undefined}
            turnSpan={isCurrentAssistantTurn && segmentIsLast
              ? board.pollStreamParts.streamTrace.turnSpan
              : undefined}
            startTime={segmentStartTime}
            modelLabel={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.modelLabel
              : segmentModelLabel}
            thinkingLevel={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.thinkingLevel
              : segmentThinking}
            providerName={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.providerName
              : segmentProvider?.name}
            providerId={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.providerId
              : segmentProvider?.id}
            harnessId={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.harnessId
              : segmentHarnessId}
            harnessName={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.harnessName
              : segmentHarnessName}
            accountLabel={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.accountLabel
              : traceMsg.accountLabel}
            accountId={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.accountId
              : traceMsg.accountId}
            ovenLabel={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.ovenLabel
              : segmentOvenLabel}
            ovenIsLocal={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.ovenIsLocal
              : segmentOvenIsLocal}
            ovenAppearance={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.ovenAppearance
              : segmentOvenAppearance}
            isFast={useSegmentLiveAttribution
              ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.isFast
              : segmentFastVariant !== null}
            initialOpen={isCurrentAssistantTurn &&
              agentRuns.isTraceOpen(
                board.handleAgentEvent.thread.projectId,
                board.handleAgentEvent.thread.id
              )}
            initialUserOpened={isCurrentAssistantTurn &&
              agentRuns.isTraceUserOpened(
                board.handleAgentEvent.thread.projectId,
                board.handleAgentEvent.thread.id
              )}
            initiallyFolded={isCurrentAssistantTurn &&
              agentRuns.isTraceUserFolded(
                board.handleAgentEvent.thread.projectId,
                board.handleAgentEvent.thread.id
              )}
            projectId={board.handleAgentEvent.thread.projectId}
            threadId={board.handleAgentEvent.thread.id}
            checkpointId={segmentCheckpoint?.id ?? null}
            checkpointPaths={segmentCheckpoint?.changes.map((change) => change.path) ?? []}
            onToggle={(open, userOpened, userFolded) => {
              if (isCurrentAssistantTurn) {
                agentRuns.setTraceOpen(
                  board.handleAgentEvent.thread.projectId,
                  board.handleAgentEvent.thread.id,
                  open,
                  userOpened,
                  userFolded
                )
              }
            }}
            onOpenSubagent={board.unmirroredTraceStartTime.openSubagent}
            onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
          />
        {/snippet}
        {#if shouldMountWorkingTrace(turnParts.length, segmentBusy)}
          {#if !groupThread || inlineInBubble}
            {@render segmentTrace()}
          {:else}
            <!-- A turn with no answer row of its own still reports its work as a
                 reply from its speaker, so the conversation keeps one voice per
                 bubble. -->
            {@const traceSpeaker = groupSpeakerFor(traceMsg)}
            {#if traceSpeaker}
              <GroupReplyBubble
                name={traceSpeaker.name}
                icon={traceSpeaker.icon}
                color={traceSpeaker.color}
              >
                {@render segmentTrace()}
              </GroupReplyBubble>
            {:else}
              {@render segmentTrace()}
            {/if}
          {/if}
        {/if}
      {/snippet}
      {#each board.composerScope.visibleMessages as msg, msgIndex (msg.id)}
        {@const absIndex =
          msgIndex +
          (board.loadOlderMessages.messages.length - board.composerScope.visibleMessages.length)}
        <!-- The work of the turn a steer interrupted sits directly above the
                 message that closed it, which is the order the run was lived in:
                 prompt, its trace, the steer, then the next turn's trace. -->
        {#each board.pollStreamParts.completedTurnViews.filter((view) => view.anchorId === msg.id) as view (view.turn.endTs)}
          {@render completedTurnTraceBlock(view.turn)}
        {/each}
        <!-- A steer still held under the running trace: its work is the
                 interrupted turn's, so that trace renders above the message. -->
        {#if absIndex === board.buildSpecActionPrompt.heldSteerAbsIndex && !board.pollStreamParts.turnAboveHasAssistantRow(absIndex)}
          {@render liveTurnTrace(board.composerScope.unmirroredTraceParts, true)}
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
                     that hangs under it: a prompt this view watched arrive rises
                     the last few pixels into place, while history (and a message
                     it mounts for a jump) appears where it belongs. The motion is
                     transform and opacity only, so the reader's scroll position
                     and the tail lock never wait on it (`promptArrive`). -->
            <div
              id={`msg-${msg.id}`}
              class="message-block group flex min-w-0 flex-col"
              in:fly={promptArrive(msg.createdAt, board.state.viewAttachedAt)}
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
                    <div class="mb-2 flex flex-wrap gap-1.5">
                      {#each msg.references as reference (reference.id)}
                        <span
                          class="inline-flex max-w-full items-center gap-1.5 border border-accent/30 bg-accent/10 px-2 py-1 text-[0.75rem]"
                          title={reference.comment
                            ? `${reference.comment}\n\n${reference.text}`
                            : reference.text}
                        >
                          <CioMessage size={11} class="shrink-0 text-accent" />
                          <span class="font-medium text-foreground">{reference.label}</span>
                          <span class="max-w-56 truncate text-muted">{reference.text}</span>
                          {#if reference.comment}
                            <span class="max-w-48 truncate italic text-foreground">
                              “{reference.comment}”
                            </span>
                          {/if}
                        </span>
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
                <div
                  class="mt-1 flex items-center gap-1.5 self-end opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <div class="flex items-center gap-0.5">
                    {#if threadMessages.isSteerHeld(board.handleAgentEvent.thread.projectId, board.pollStreamParts.conversationId, msg.id)}
                      <button
                        class="p-1 text-accent transition-colors hover:bg-elevated"
                        aria-label="Undo steer   the message has not reached the agent yet"
                        title="Undo   the agent never receives a steered message that is undone"
                        onclick={() => void board.pollStreamParts.undoHeldSteer(msg)}
                      >
                        <CioUndo size={12} />
                      </button>
                    {/if}
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
                  <span class="text-[0.625rem] text-dimmed">·</span>
                  <MessageTimestamp at={msg.createdAt} class="text-[0.625rem] text-dimmed" />
                </div>
              {/if}
            </div>
          {/if}
        {:else}
          <!-- Assistant message   one WorkTrace slice per answer the turn crossed -->
          {@const isTurnEnd = board.pollStreamParts.transcriptIndex.isTurnEnd[absIndex] ?? false}
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

          {#if traceSegmentsAbove.length > 0 || questionParts.length > 0 || isTurnEnd}
            <div class="group mb-6 flex min-w-0 flex-col">
              {#if !groupThread}
                {#each traceSegmentsAbove as segment (segment.segmentIndex)}
                  {@render turnTraceSegment(segment, msg)}
                {/each}
              {/if}

              {#if isTurnEnd}
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
                  {#if turnClosingVisible && turnClosingText}
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
                    >
                      <!-- Who answered. Drawn only in a group thread, and only
                           over the reply's text: the working trace above and
                           the metadata footer below belong to the turn, not to
                           a speaker. -->
                      {#if groupThread}
                        {@const speaker = groupSpeakerFor(msg)}
                        {#if speaker}
                          <ThreadMessageSpeaker
                            name={speaker.name}
                            icon={speaker.icon}
                            color={speaker.color}
                            class="mb-1.5"
                          />
                        {/if}
                        <!-- The work this answer came from, inside the same reply:
                             no band of its own, capped, and scrolling within that
                             cap so it never resizes the bubble around it. -->
                        {#each traceSegmentsAbove as segment (segment.segmentIndex)}
                          {@render turnTraceSegment(segment, msg, true)}
                        {/each}
                      {/if}
                      {#if isReadingActiveLine}
                        <!-- The read-along only exists while a turn is being
                                 spoken, so its chunk waits for playback instead
                                 of riding along with the first screen. -->
                        {#await import('../../speech/ReadAlongOverlay.svelte') then { default: ReadAlongOverlay }}
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
                      </div>
                    {/if}
                  {/if}

                  {#if !board.switchProject.busy || !isLatest}
                    <!-- Footer shown once per turn on the last assistant message -->
                    <div class="mt-1 flex flex-col">
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
                          {#if board.props.controller?.kind !== 'temporary-chat' && !groupThread}
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
                        </div>
                        {#if !groupThread}
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
                        {/if}
                      </div>
                    </div>
                  {/if}
                {/if}
              {/if}
            </div>
          {/if}
        {/if}
        {#each board.pollStreamParts.segmentsBelow(absIndex) as segment (segment.segmentIndex)}
          {@render turnTraceSegment(
            segment,
            board.loadOlderMessages.messages[segment.turnStart] ?? msg
          )}
        {/each}
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

      {#if (board.buildSpecActionPrompt.pendingLiveTurn && board.buildSpecActionPrompt.heldSteerAbsIndex === -1) || board.pollStreamParts.settledTurnParts.length > 0}
        {@const tracePartsForTurn = board.buildSpecActionPrompt.pendingLiveTurn
          ? board.composerScope.unmirroredTraceParts
          : board.pollStreamParts.settledTurnParts}
        {@const traceBusyForTurn = Boolean(board.buildSpecActionPrompt.pendingLiveTurn)}
        {#if groupThread}
          <!-- In a group conversation the work is part of the reply, not a band
               above it: the bubble opens with who is speaking, the trace sits
               inside it at one fixed height, and the folded line underneath still
               says what is happening. -->
          {@const liveSpeaker = groupSpeakerForThread()}
          <GroupReplyBubble
            name={liveSpeaker?.name ?? board.handleAgentEvent.thread.title}
            icon={liveSpeaker?.icon ?? null}
            color={liveSpeaker?.color}
          >
            {@render liveTurnTrace(tracePartsForTurn, traceBusyForTurn, true)}
            {#if traceBusyForTurn}
              <TraceActivityLine
                parts={board.pollStreamParts.latestTurnRenderableParts}
                folded={!agentRuns.isTraceOpen(
                  board.handleAgentEvent.thread.projectId,
                  board.handleAgentEvent.thread.id
                )}
                onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
                formatProse={conversationLiveProse}
              />
            {/if}
          </GroupReplyBubble>
        {:else}
          {@render liveTurnTrace(tracePartsForTurn, traceBusyForTurn)}
        {/if}
      {/if}

      {#if board.sources.specGenerationTraceActive && board.sources.specGenerationTraceParts.length > 0}
        <WorkingTrace
          parts={board.sources.specGenerationTraceParts}
          open
          busy={board.switchProject.busy}
          startTime={board.sources.specGenerationTraceStartedAt}
          projectId={board.handleAgentEvent.thread.projectId}
          threadId={board.handleAgentEvent.thread.id}
        />
      {/if}

      {#if board.sources.assignmentGenerationTraceActive && board.sources.assignmentGenerationTraceParts.length > 0}
        <WorkingTrace
          parts={board.sources.assignmentGenerationTraceParts}
          open
          busy={board.switchProject.busy}
          startTime={board.sources.assignmentGenerationTraceStartedAt}
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
        <TraceActivityLine
          parts={board.pollStreamParts.latestTurnRenderableParts}
          folded={!agentRuns.isTraceOpen(
            board.handleAgentEvent.thread.projectId,
            board.handleAgentEvent.thread.id
          )}
          onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
          formatProse={conversationLiveProse}
        />
      {/if}

      {#if board.unmirroredTraceStartTime.brainstormReportRefreshing || board.buildSpecActionPrompt.delegatedWorkBusy || board.composerScope.assignmentFormulating || (board.buildSpecActionPrompt.heldSteerAbsIndex === -1 && !board.buildSpecActionPrompt.pendingLiveTurn && !board.submitBrainstormDecision.activePlanningEntry && !board.harnessUsage.specFormulating && board.switchProject.busy && board.pollStreamParts.latestTurnRenderableParts.length === 0)}
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
