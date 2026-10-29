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
  import ThinkingOrb from '$lib/thinking-orb/ThinkingOrb.svelte'
  import InlineMediaFigure from '../InlineMediaFigure.svelte'
  import InlineImageFigure from '../InlineImageFigure.svelte'
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
  import { assistantDisplayText } from '$lib/components/assistant/assistant-view'
  import { assistantResultText } from '$shared/assistant-result'
  import MessageTimestamp from '$lib/components/shared/MessageTimestamp.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { modelKey } from '$lib/model-keys'
  import { promptArrive } from '$lib/motion'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { agentRuns } from '$lib/stores/agent-runs.svelte'
  import { foreignRuns } from '$lib/stores/foreign-runs.svelte'
  import type { AgentPart, TurnStreamCompletedTurn } from '$shared/types'
  import { formatTokenRate } from '$lib/token-rate.svelte'
  import {
    auditReportForTurn,
    changesBeforeSteer,
    getTurnFinalText,
    isActivityOnlyUserMessage
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

  /** The board the surface built, and the few values only it can build. */
  let { board }: { board: ThreadViewBoard } = $props()
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
    {@attach board.state.conversationColumn.attachment}
  >
    {#if !board.sources.loaded && board.composerScope.visibleMessages.length === 0}
      <div class="flex items-center gap-2 py-8 text-sm text-dimmed">
        <CioSpinner size={16} class="animate-spin" />
        Loading conversation...
      </div>
    {:else}
      {#if board.unmirroredTraceStartTime.hasOlderMessages}
        <div
          class="flex justify-center pb-2"
          {@attach board.studioTemporaryChatContext.trackHistoryHead}
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
      {#snippet liveTurnTrace(traceParts: AgentPart[], traceBusy: boolean)}
        <WorkingTrace
          parts={traceParts}
          open
          busy={traceBusy}
          note={traceBusy ? board.unmirroredTraceStartTime.workingStatusNote : null}
          active={board.props.active}
          olderPartsAvailable={board.pollStreamParts.streamTrace.hasOlder}
          onLoadOlderParts={board.pollStreamParts.loadOlderStreamParts}
          totalSteps={board.pollStreamParts.streamTrace.totalSteps}
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
          formatOutput={board.abortRun.assistantAuthoringOutput}
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
          formatOutput={board.abortRun.assistantAuthoringOutput}
        />
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
        {#if msg.inlineArtifact}
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
                  onExpand={(startAt) => board.editVideoNote.openMessageViewer(msg, part, startAt)}
                />
              {:else if part.type === 'file' && isAudioMime(part.mime)}
                <InlineMediaFigure
                  src={part.url}
                  kind="audio"
                  filename={part.filename ?? 'Media'}
                  onExpand={() => board.editVideoNote.openMessageViewer(msg, part)}
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
                {#if previousTurnAudit}
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
                  class="w-full border-l-2 border-l-foreground bg-surface px-4 py-2.5 text-sm text-foreground"
                  data-conversation-searchable
                >
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
          <!-- Assistant message   single WorkTrace per turn containing ALL parts -->
          {@const isTurnStart =
            board.pollStreamParts.transcriptIndex.isTurnStart[absIndex] ?? false}
          {@const isTurnEnd = board.pollStreamParts.transcriptIndex.isTurnEnd[absIndex] ?? false}
          {@const isLatestTurn = absIndex === board.buildSpecActionPrompt.latestTurnInfo.startIndex}
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
          {@const harnessId = resolveMessageHarnessId(
            msg,
            board.unmirroredTraceStartTime.messageHarnessFallback
          )}
          {@const harnessName = messageHarnessName(
            msg,
            board.unmirroredTraceStartTime.messageHarnessFallback
          )}
          {@const useLiveAttribution =
            isLatestTurn &&
            board.buildSpecActionPrompt.latestTurnInfo.active &&
            board.unmirroredTraceStartTime.liveBusy}
          {@const isLatest = absIndex === board.loadOlderMessages.messages.length - 1}
          {@const questionParts = msg.parts.filter(
            (p): p is Extract<AgentPart, { type: 'question' }> => p.type === 'question'
          )}
          {@const turnDuration = board.pollStreamParts.transcriptIndex.duration[absIndex] ?? null}
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

          {#if isTurnStart || questionParts.length > 0 || isTurnEnd}
            <div class="group mb-6 flex min-w-0 flex-col">
              {#if isTurnStart}
                {@const turnDone =
                  board.pollStreamParts.transcriptIndex.turnCompleted[absIndex] ?? false}
                {@const isCurrentAssistantTurn =
                  isLatestTurn &&
                  board.buildSpecActionPrompt.latestTurnInfo.active &&
                  !board.buildSpecActionPrompt.pendingLiveTurn}
                {@const traceIsLive =
                  board.unmirroredTraceStartTime.threadWorking &&
                  isCurrentAssistantTurn &&
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
                  board.pollStreamParts.transcriptIndex.turnEnd[absIndex] ?? absIndex}
                {@const turnClosingText = getTurnFinalText(
                  board.loadOlderMessages.messages,
                  turnEndIndex,
                  board.pollStreamParts.isTransparentTurnMessage
                )}
                {@const turnClosingVisible = board.pollStreamParts.closingStatementVisible(
                  turnEndIndex,
                  turnEndIndex === board.loadOlderMessages.messages.length - 1
                )}
                {@const traceHoldsClosingText = traceIsLive && !turnClosingVisible}
                {@const traceIsLiveTurn = isCurrentAssistantTurn || traceIsLive || traceIsRestored}
                {@const turnClosingTextId =
                  turnClosingVisible && turnClosingText ? turnClosingText.id : null}
                {@const turnParts = board.pollStreamParts.turnTraceParts(
                  absIndex,
                  traceIsLiveTurn,
                  turnClosingTextId,
                  traceHoldsClosingText
                )}
                {#if shouldMountWorkingTrace(turnParts.length, traceIsLive)}
                  <WorkingTrace
                    parts={turnParts}
                    open={isCurrentAssistantTurn || traceIsLive || traceIsRestored}
                    busy={traceIsLive || traceIsRestored}
                    done={turnDone}
                    rehydrated={traceIsRestored}
                    foreignRun={traceRunIsForeign}
                    active={board.props.active}
                    olderPartsAvailable={isCurrentAssistantTurn &&
                      board.pollStreamParts.streamTrace.hasOlder}
                    onLoadOlderParts={isCurrentAssistantTurn
                      ? board.pollStreamParts.loadOlderStreamParts
                      : undefined}
                    totalSteps={isCurrentAssistantTurn
                      ? board.pollStreamParts.streamTrace.totalSteps
                      : undefined}
                    startTime={isLatestTurn
                      ? (board.composerScope.getTurnStartTime(absIndex) ??
                        board.studioTemporaryChatContext.activeTurnStartTime)
                      : board.composerScope.getTurnStartTime(absIndex)}
                    modelLabel={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .modelLabel
                      : modelLabel}
                    thinkingLevel={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .thinkingLevel
                      : msgThinking}
                    providerName={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .providerName
                      : provider?.name}
                    providerId={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .providerId
                      : provider?.id}
                    harnessId={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .harnessId
                      : harnessId}
                    harnessName={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .harnessName
                      : harnessName}
                    accountLabel={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .accountLabel
                      : msg.accountLabel}
                    accountId={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .accountId
                      : msg.accountId}
                    ovenLabel={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .ovenLabel
                      : (msg.ovenLabel ??
                        board.currentWorkingTraceAttribution.ovenLabelForId(msg.ovenId))}
                    ovenIsLocal={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .ovenIsLocal
                      : msgOvenIsLocal}
                    ovenAppearance={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution
                          .ovenAppearance
                      : msgOvenAppearance}
                    isFast={useLiveAttribution
                      ? board.currentWorkingTraceAttribution.currentWorkingTraceAttribution.isFast
                      : fastVariant !== null}
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
                    checkpointId={turnCheckpoint?.id ?? null}
                    checkpointPaths={turnCheckpoint?.changes.map((change) => change.path) ?? []}
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
                {/if}
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
                  {@const deliveredClosingText = board.props.assistantMode
                    ? board.abortRun.assistantAuthoringThread
                      ? assistantDisplayText(turnClosingText?.text ?? messageText(msg))
                      : assistantResultText(
                          turnClosingText?.text ?? messageText(msg),
                          !msg.completedAt
                        )
                    : (turnClosingText?.text ?? messageText(msg))}
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
                      class="message-block min-w-0 w-full text-[0.8125rem] text-foreground"
                      data-board.abortRun.assistant-response
                      data-conversation-searchable
                      data-message-id={msg.id}
                    >
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
                        <DeferredMarkdownView
                          text={deliveredClosingText}
                          citationThread={board.unmirroredTraceStartTime.citationThreadContext}
                          annotationScope={{
                            projectId: board.handleAgentEvent.thread.projectId,
                            threadId: board.handleAgentEvent.thread.id
                          }}
                          onCiteFile={board.unmirroredTraceStartTime.openFileCitation}
                          onOpenLocalFile={(url) =>
                            void board.unmirroredTraceStartTime.openFilePart(url)}
                        />
                      {/if}
                    </div>
                  {/if}

                  {#if !board.props.chatMode && turnCheckpoint && turnCheckpoint.changes.length > 0 && (board.pollStreamParts.transcriptIndex.checkpointCard[absIndex] ?? false)}
                    <div class="mt-3">
                      <RunChangesCard
                        checkpoint={turnCheckpoint}
                        projectId={board.handleAgentEvent.thread.projectId}
                        threadId={board.handleAgentEvent.thread.id}
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
                          {#if board.props.chatMode && board.props.onContinueInProject}
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
      {/each}

      {#if (board.buildSpecActionPrompt.pendingLiveTurn && board.buildSpecActionPrompt.heldSteerAbsIndex === -1) || board.pollStreamParts.settledTurnParts.length > 0}
        {@render liveTurnTrace(
          board.buildSpecActionPrompt.pendingLiveTurn
            ? board.composerScope.unmirroredTraceParts
            : board.pollStreamParts.settledTurnParts,
          Boolean(board.buildSpecActionPrompt.pendingLiveTurn)
        )}
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
