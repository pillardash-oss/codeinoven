<script lang="ts">
  /**
   * One slice of a turn's working trace.
   *
   * A turn the reader answered is cut at that answer, so the work that led to the
   * question, the answer card, and the work the answer unblocked read in the
   * order they happened. A settled slice draws from the durable log's pages, and a
   * live one draws the stream's own newest window.
   */
  import type { ThreadView as ThreadViewBoard } from '../ThreadView-board.svelte'
  import WorkingTrace from '../../WorkingTrace.svelte'
  import { shouldMountWorkingTrace } from '$lib/working-trace-parts'
  import { LOCAL_OVEN_ID } from '$shared/ovens'
  import { fastVariantForModelId } from '$shared/fast-inference'
  import { isGroupThread, type AgentMessage } from '$shared/types'
  import { getTurnFinalText, type TraceSegmentLayout } from '../../thread-turn-parts'
  import {
    messageHarnessName,
    messageModelLabel,
    messageProvider,
    messageThinkingLevel,
    resolveMessageHarnessId
  } from '../../thread-message-presentation'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
  import { conversationTraceOutput } from './ThreadViewConversation-trace-text'

  interface Props {
    board: ThreadViewBoard
    segment: TraceSegmentLayout
    traceMsg: AgentMessage
    inlineInBubble?: boolean
    closingTextIdOverride?: string | null
  }

  let { board, segment, traceMsg, inlineInBubble = false, closingTextIdOverride }: Props = $props()

  const groupThread = $derived(isGroupThread(board.handleAgentEvent.thread))
  /** A group reply is attributed to the speaker above its bubble, and a
   *  temporary chat names the model that answered in the message footer, so
   *  neither repeats the machinery in the trace header. */
  const hideAttribution = $derived(groupThread || board.props.controller?.kind === 'temporary-chat')
  const formatOutput = conversationTraceOutput(() => board)

  const turnStart = $derived(segment.turnStart)
  const turnDone = $derived(board.pollStreamParts.transcriptIndex.turnCompleted[turnStart] ?? false)
  const isTraceTurnLatest = $derived(
    turnStart === board.buildSpecActionPrompt.latestTurnInfo.startIndex
  )
  const isCurrentAssistantTurn = $derived(
    isTraceTurnLatest &&
      board.buildSpecActionPrompt.latestTurnInfo.active &&
      !board.buildSpecActionPrompt.pendingLiveTurn
  )
  const traceIsLive = $derived(
    board.unmirroredTraceStartTime.threadWorking &&
      isCurrentAssistantTurn &&
      !turnDone &&
      !board.unmirroredTraceStartTime.brainstormReportRefreshing
  )
  const traceIsRestored = $derived(
    board.buildSpecActionPrompt.restoredBusy &&
      isCurrentAssistantTurn &&
      !board.unmirroredTraceStartTime.liveBusy &&
      !turnDone
  )
  const traceRunIsForeign = $derived(
    foreignRuns.isForeign(board.handleAgentEvent.thread.projectId, board.handleAgentEvent.thread.id)
  )
  const turnEndIndex = $derived(
    board.pollStreamParts.transcriptIndex.turnEnd[turnStart] ?? turnStart
  )
  const turnClosingText = $derived(
    getTurnFinalText(
      board.loadOlderMessages.messages,
      turnEndIndex,
      board.pollStreamParts.isTransparentTurnMessage
    )
  )
  const turnClosingVisible = $derived(
    board.pollStreamParts.closingStatementVisible(
      turnEndIndex,
      turnEndIndex === board.loadOlderMessages.messages.length - 1
    )
  )
  const traceHoldsClosingText = $derived(!groupThread && traceIsLive && !turnClosingVisible)
  const traceIsLiveTurn = $derived(isCurrentAssistantTurn || traceIsLive || traceIsRestored)
  const turnClosingTextId = $derived(
    closingTextIdOverride !== undefined
      ? closingTextIdOverride
      : groupThread
        ? (turnClosingText?.id ?? null)
        : turnClosingVisible && turnClosingText
          ? turnClosingText.id
          : null
  )
  const traceParts = $derived(
    board.pollStreamParts.segmentTraceParts(
      segment,
      traceIsLiveTurn,
      turnClosingTextId,
      traceHoldsClosingText
    )
  )
  const settledTrace = $derived(
    traceIsLiveTurn
      ? null
      : board.settledTracePages.page(
          board.settledTracePages.keyFor(traceMsg.id, segment.segmentIndex),
          traceParts
        )
  )
  const turnParts = $derived(settledTrace ? settledTrace.parts : traceParts)
  const segmentIsLast = $derived(segment.segmentIndex === segment.boundaries.length)
  const segmentBusy = $derived(traceIsLive && segmentIsLast)
  const segmentDone = $derived(segmentIsLast ? turnDone : true)
  const liveTracePaging = $derived(isCurrentAssistantTurn && segmentIsLast)
  const segmentStartTime = $derived(
    segment.segmentIndex === 0
      ? isTraceTurnLatest
        ? (board.composerScope.getTurnStartTime(turnStart) ??
          board.studioTemporaryChatContext.activeTurnStartTime)
        : board.composerScope.getTurnStartTime(turnStart)
      : segment.answerIndex === null
        ? undefined
        : board.loadOlderMessages.messages[segment.answerIndex]?.createdAt
  )
  const useSegmentLiveAttribution = $derived(
    isTraceTurnLatest &&
      board.buildSpecActionPrompt.latestTurnInfo.active &&
      board.unmirroredTraceStartTime.liveBusy
  )
  const segmentProvider = $derived(
    messageProvider(traceMsg, board.currentWorkingTraceAttribution.providers)
  )
  const segmentModelLabel = $derived(
    messageModelLabel(traceMsg, board.currentWorkingTraceAttribution.allModels)
  )
  const segmentThinking = $derived(
    messageThinkingLevel(traceMsg, board.currentWorkingTraceAttribution.allModels)
  )
  const segmentOvenAppearance = $derived(
    traceMsg.ovenAppearance ??
      board.currentWorkingTraceAttribution.ovenAppearanceForId(traceMsg.ovenId)
  )
  const segmentOvenLabel = $derived(
    traceMsg.ovenLabel ?? board.currentWorkingTraceAttribution.ovenLabelForId(traceMsg.ovenId)
  )
  const segmentOvenIsLocal = $derived(
    traceMsg.ovenId
      ? traceMsg.ovenId === LOCAL_OVEN_ID
      : traceMsg.ovenLabel === undefined || traceMsg.ovenLabel === 'Local'
  )
  const segmentFastVariant = $derived(
    traceMsg.modelId ? fastVariantForModelId(traceMsg.modelId) : null
  )
  const segmentHarnessId = $derived(
    resolveMessageHarnessId(traceMsg, board.unmirroredTraceStartTime.messageHarnessFallback)
  )
  const segmentHarnessName = $derived(
    messageHarnessName(traceMsg, board.unmirroredTraceStartTime.messageHarnessFallback)
  )
  const segmentCheckpoint = $derived(
    board.pollStreamParts.transcriptIndex.checkpoint[turnStart] ?? null
  )
</script>

<!-- A group reply's answer is its own text in its own bubble, so the work
     inside that bubble never carries a copy of it: that copy is what made
     the trace show a clipped second answer above the real one. -->

<!-- A group reply owns its answer from the first streamed word: its bubble
     is the only place that text renders, so the trace never carries a
     copy of it, whether or not the turn has handed the floor back yet.
     A reply pinned above a held steer shows the text it closed on, which
     can be older than the turn's newest text, so it names that text
     itself and the trace drops that one instead. -->

<!-- A settled turn's work is already in the transcript, so nothing can
     fetch it page by page: what a 600-step run costs is mounting it. The
     newest page mounts, and the top of the trace pulls the next older one
     exactly as the live trace does. A live turn keeps its own durable
     paging, which this never touches. -->

{#snippet segmentTrace()}
  <WorkingTrace
    parts={turnParts}
    {hideAttribution}
    flat={groupThread}
    bodyMaxHeightRem={groupThread ? 14 : undefined}
    open={isCurrentAssistantTurn || traceIsLive}
    busy={segmentBusy}
    done={segmentDone}
    {formatOutput}
    rehydrated={traceIsRestored && segmentIsLast}
    foreignRun={traceRunIsForeign}
    active={board.props.active}
    olderPartsAvailable={liveTracePaging
      ? board.pollStreamParts.streamTrace.hasOlder
      : (settledTrace?.hasOlder ?? false)}
    onLoadOlderParts={liveTracePaging
      ? board.pollStreamParts.loadOlderStreamParts
      : settledTrace?.hasOlder
        ? () => board.settledTracePages.loadOlder(settledTrace.key, traceParts.length)
        : undefined}
    totalSteps={liveTracePaging
      ? board.pollStreamParts.streamTrace.totalSteps
      : settledTrace?.totalSteps}
    turnSubagentParts={liveTracePaging
      ? board.pollStreamParts.streamTrace.subagentParts
      : settledTrace?.subagentParts}
    turnCompacted={liveTracePaging
      ? board.pollStreamParts.streamTrace.turnCompacted
      : settledTrace?.compacted}
    turnSpan={liveTracePaging ? board.pollStreamParts.streamTrace.turnSpan : settledTrace?.span}
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
    folded={isCurrentAssistantTurn
      ? !agentRuns.isTraceOpen(
          board.handleAgentEvent.thread.projectId,
          board.handleAgentEvent.thread.id
        )
      : undefined}
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
  <!-- In a group conversation a turn's work is only ever drawn by the
       reply that closes it (`inlineInBubble`). Any other call is a
       caller that still expects work above a bubble, and that is exactly
       the second, speaker-less trace this screen must never show. -->
  {#if !groupThread || inlineInBubble}
    {@render segmentTrace()}
  {/if}
{/if}
