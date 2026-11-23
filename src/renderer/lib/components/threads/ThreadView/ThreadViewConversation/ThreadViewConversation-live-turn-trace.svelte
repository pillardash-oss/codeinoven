<script lang="ts">
  /**
   * The live or settled trace for a turn with no mirrored assistant row.
   *
   * It renders as its own block so a held steer can be placed after it instead of
   * above the work it interrupts, and it reads the live stream's own paging
   * because it is the one trace a running turn owns while it streams.
   */
  import type { ThreadView as ThreadViewBoard } from '../ThreadView-board.svelte'
  import WorkingTrace from '../../WorkingTrace.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import type { AgentPart } from '$shared/types'
  import { conversationTraceOutput } from './ThreadViewConversation-trace-text'

  interface Props {
    board: ThreadViewBoard
    traceParts: AgentPart[]
    traceBusy: boolean
    inGroupBubble?: boolean
    /** Above a held steer the trace shows only its latest step, so the steered
     *  message stays where the reader is looking instead of below the whole run. */
    latestOnly?: boolean
  }

  let { board, traceParts, traceBusy, inGroupBubble = false, latestOnly = false }: Props = $props()

  const shownParts = $derived(latestOnly ? traceParts.slice(-1) : traceParts)

  /** A group reply is attributed to the speaker above its bubble, and a
   *  temporary chat names the model that answered in the message footer, so
   *  neither repeats the machinery in the trace header. */
  const hideAttribution = $derived(
    inGroupBubble || board.props.controller?.kind === 'temporary-chat'
  )

  const formatOutput = conversationTraceOutput(() => board)
</script>

<WorkingTrace
  parts={shownParts}
  open
  {hideAttribution}
  flat={inGroupBubble}
  bodyMaxHeightRem={inGroupBubble ? 14 : undefined}
  busy={traceBusy}
  done={!traceBusy}
  note={traceBusy ? board.unmirroredTraceStartTime.workingStatusNote : null}
  steps={traceBusy ? board.unmirroredTraceStartTime.workingStatusSteps : null}
  active={board.props.active}
  olderPartsAvailable={!latestOnly && board.pollStreamParts.streamTrace.hasOlder}
  onLoadOlderParts={board.pollStreamParts.loadOlderStreamParts}
  totalSteps={board.pollStreamParts.streamTrace.totalSteps}
  turnSubagentParts={board.pollStreamParts.streamTrace.subagentParts}
  turnCompacted={board.pollStreamParts.streamTrace.turnCompacted}
  turnSpan={board.pollStreamParts.streamTrace.turnSpan}
  startTime={board.unmirroredTraceStartTime.unmirroredTraceStartTime}
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
  initialOpen={agentRuns.isTraceOpen(
    board.handleAgentEvent.thread.projectId,
    board.pollStreamParts.conversationId
  )}
  folded={!agentRuns.isTraceOpen(
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
  {formatOutput}
/>
