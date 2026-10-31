import { ThreadViewHandleAgentEvent } from './ThreadView-handle-agent-event.svelte'
import { ThreadViewLoadOlderMessages } from './ThreadView-load-older-messages.svelte'
import { ThreadViewContextUsage } from './ThreadView-context-usage.svelte'
import { ThreadViewSubmitSpecDecision } from './ThreadView-submit-spec-decision.svelte'
import { ThreadViewHarnessUsage } from './ThreadView-harness-usage.svelte'
import { ThreadViewSwitchProject } from './ThreadView-switch-project.svelte'
import { ThreadViewSteerQueuedMessage } from './ThreadView-steer-queued-message.svelte'
import { ThreadViewSubmitBrainstormDecision } from './ThreadView-submit-brainstorm-decision.svelte'
import { ThreadViewBuildSpecActionPrompt } from './ThreadView-build-spec-action-prompt.svelte'
import { ThreadViewPollStreamParts } from './ThreadView-poll-stream-parts.svelte'
import { ThreadViewCurrentWorkingTraceAttribution } from './ThreadView-current-working-trace-attribution.svelte'
import { ThreadViewAbortRun } from './ThreadView-abort-run.svelte'
import { ThreadViewSources } from './ThreadView-sources.svelte'
import { ThreadViewEditVideoNote } from './ThreadView-edit-video-note.svelte'
import { ThreadViewStudioTemporaryChatContext } from './ThreadView-studio-temporary-chat-context.svelte'
import { ThreadViewComposerScope } from './ThreadView-composer-scope.svelte'
import { ThreadViewUnmirroredTraceStartTime } from './ThreadView-unmirrored-trace-start-time.svelte'
import { ThreadViewEngineeringStageActions } from './ThreadView-engineering-stage-actions.svelte'
import { ThreadViewProjectSuggestedPrompts } from './ThreadView-project-suggested-prompts.svelte'
import { ThreadViewStudioReloadNonce } from './ThreadView-studio-reload-nonce.svelte'
import { ThreadViewExpandedMessageBodies } from './ThreadView-expanded-message-bodies.svelte'
import { ThreadViewOpenOvenPicker } from './ThreadView-open-oven-picker.svelte'
import { ThreadViewState } from './ThreadView-state.svelte'
import { ThreadViewEffects } from './ThreadView-effects.svelte'
import type { ThreadViewSurfaceProps } from './ThreadView-types'
import { BoardState } from '$lib/components/board-state'
/**
 * The ThreadView board: one instance per concern, each holding this board.
 *
 * It is built during the component's own setup, so an `$effect` a unit registers
 * is owned by the component and tears down with it. A unit reads the props
 * through this board, so a prop that changes keeps every `$derived` live.
 */
export class ThreadView extends BoardState<ThreadViewSurfaceProps> {
  readonly handleAgentEvent = new ThreadViewHandleAgentEvent(this)
  readonly loadOlderMessages = new ThreadViewLoadOlderMessages(this)
  readonly contextUsage = new ThreadViewContextUsage(this)
  readonly submitSpecDecision = new ThreadViewSubmitSpecDecision(this)
  readonly harnessUsage = new ThreadViewHarnessUsage(this)
  readonly switchProject = new ThreadViewSwitchProject(this)
  readonly steerQueuedMessage = new ThreadViewSteerQueuedMessage(this)
  readonly submitBrainstormDecision = new ThreadViewSubmitBrainstormDecision(this)
  readonly buildSpecActionPrompt = new ThreadViewBuildSpecActionPrompt(this)
  readonly pollStreamParts = new ThreadViewPollStreamParts(this)
  readonly currentWorkingTraceAttribution = new ThreadViewCurrentWorkingTraceAttribution(this)
  readonly abortRun = new ThreadViewAbortRun(this)
  readonly sources = new ThreadViewSources(this)
  readonly editVideoNote = new ThreadViewEditVideoNote(this)
  readonly studioTemporaryChatContext = new ThreadViewStudioTemporaryChatContext(this)
  readonly composerScope = new ThreadViewComposerScope(this)
  readonly unmirroredTraceStartTime = new ThreadViewUnmirroredTraceStartTime(this)
  readonly engineeringStageActions = new ThreadViewEngineeringStageActions(this)
  readonly projectSuggestedPrompts = new ThreadViewProjectSuggestedPrompts(this)
  readonly studioReloadNonce = new ThreadViewStudioReloadNonce(this)
  readonly expandedMessageBodies = new ThreadViewExpandedMessageBodies(this)
  readonly openOvenPicker = new ThreadViewOpenOvenPicker(this)
  readonly state = new ThreadViewState(this)
  readonly effects = new ThreadViewEffects(this)
  constructor(readProps: () => ThreadViewSurfaceProps) {
    super(readProps)
    this.submitSpecDecision.bindAuditState()
    this.loadOlderMessages.bindSettings()
    this.unmirroredTraceStartTime.bindThread()
    this.contextUsage.bindAuditSettings()
    this.pollStreamParts.bindTraceScope()
    this.unmirroredTraceStartTime.bindThread()
    this.loadOlderMessages.bind()
    this.effects.init()
  }
}
/** Build the board from the surface props. */
export function createThreadView(readProps: () => ThreadViewSurfaceProps): ThreadView {
  return new ThreadView(readProps)
}
