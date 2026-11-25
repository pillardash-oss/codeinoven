<script lang="ts">
  /**
   * One slice of a group turn's work, drawn where that slice belongs.
   *
   * The transcript's own answers (a question the reader settled) sit between the
   * slices, so the work that asked reads above the answer and the work the answer
   * unblocked reads below it, under the speaker who did it.
   */
  import type { ThreadView as ThreadViewBoard } from '../ThreadView-board.svelte'
  import GroupReplyBubble from '../../GroupReplyBubble.svelte'
  import type { AgentMessage } from '$shared/types'
  import type { TraceSegmentLayout } from '../../thread-turn-parts'
  import { groupSpeakerFor } from './ThreadViewConversation-speakers'
  import ThreadViewConversationTurnTrace from './ThreadViewConversation-turn-trace.svelte'

  interface Props {
    board: ThreadViewBoard
    segment: TraceSegmentLayout
    traceMsg: AgentMessage
  }

  let { board, segment, traceMsg }: Props = $props()

  const sliceSpeaker = $derived(groupSpeakerFor(board.handleAgentEvent.thread, traceMsg))
</script>

<GroupReplyBubble
  name={sliceSpeaker?.name ?? board.handleAgentEvent.thread.title}
  icon={sliceSpeaker?.icon ?? null}
  color={sliceSpeaker?.color}
  plate={sliceSpeaker?.plate ?? false}
>
  <ThreadViewConversationTurnTrace {board} {segment} {traceMsg} inlineInBubble />
</GroupReplyBubble>
