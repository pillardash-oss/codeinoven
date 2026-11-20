<script lang="ts">
  /**
   * A turn a prompt closed whose work the transcript never mirrored: the durable
   * log's record of it, rendered settled.
   *
   * It owns no session any more, so it shows no spinner, and it ships its step
   * total with the newest window of entries, paging the rest in as the reader
   * opens it.
   */
  import type { ThreadView as ThreadViewBoard } from '../ThreadView-board.svelte'
  import WorkingTrace from '../../WorkingTrace.svelte'
  import { isGroupThread, type TurnStreamCompletedTurn } from '$shared/types'
  import { conversationTraceOutput } from './ThreadViewConversation-trace-text'

  interface Props {
    board: ThreadViewBoard
    turn: TurnStreamCompletedTurn
  }

  let { board, turn }: Props = $props()

  const groupThread = $derived(isGroupThread(board.handleAgentEvent.thread))
  const formatOutput = conversationTraceOutput(() => board)
</script>

<WorkingTrace
  parts={turn.parts}
  done
  busy={false}
  compact={groupThread}
  flat={groupThread}
  bodyMaxHeightRem={groupThread ? 14 : undefined}
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
  modelLabel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.modelLabel}
  thinkingLevel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.thinkingLevel}
  providerName={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.providerName}
  providerId={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.providerId}
  harnessId={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.harnessId}
  harnessName={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.harnessName}
  accountLabel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.accountLabel}
  accountId={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.accountId}
  ovenLabel={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.ovenLabel}
  ovenIsLocal={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.ovenIsLocal}
  ovenAppearance={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
    .ovenAppearance}
  isFast={board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.isFast}
  onOpenSubagent={board.unmirroredTraceStartTime.openSubagent}
  onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
  {formatOutput}
/>
