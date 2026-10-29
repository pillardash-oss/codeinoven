<script lang="ts">
  import type { ThreadView as ThreadViewBoard } from './ThreadView-board.svelte'
  import type { ComposerShoeData } from '../../chats/ComposerShoe.svelte'
  import type { ActionDefinition } from '$lib/actions'
  import CioAttention from '@pdslng/cio-icon/CioAttention.svelte'
  import CioChevronDown from '@pdslng/cio-icon/CioChevronDown.svelte'
  import { fly, slide } from 'svelte/transition'
  import ChatComposer from '../../chats/ChatComposer.svelte'
  import ForeignRunCard from '../ForeignRunCard.svelte'
  import CardButton from '../../shared/CardButton.svelte'
  import CardFoot from '../../shared/CardFoot.svelte'
  import CardFrame from '../../shared/CardFrame.svelte'
  import CardHead from '../../shared/CardHead.svelte'
  import CardNotice from '../../shared/CardNotice.svelte'
  import { cardArrive, dismissSlide } from '../../shared/card-motion'
  import AgentTodoCard from '../AgentTodoCard.svelte'
  import ComposerQueuedCard from '../ComposerQueuedCard.svelte'
  import AgentQuestionCard from '../AgentQuestionCard.svelte'
  import AgentSecretCard from '../AgentSecretCard.svelte'
  import PermissionRequestCard from '../PermissionRequestCard.svelte'
  import ImageDescriptorErrorCard from '../ImageDescriptorErrorCard.svelte'
  import AgentProviderStatusCard from '../AgentProviderStatusCard.svelte'
  import AiAccountSetupCard from '../AiAccountSetupCard.svelte'
  import SpecReadyCard from '../SpecReadyCard.svelte'
  import BrainstormEntryChoiceCard from '../BrainstormEntryChoiceCard.svelte'
  import BrainstormReadyCard from '../BrainstormReadyCard.svelte'
  import EngineeringRetryCard from '../EngineeringRetryCard.svelte'
  import EngineeringEntryCard from '../../chats/EngineeringEntryCard.svelte'
  import PrdReadyCard from '../PrdReadyCard.svelte'
  import AssignmentReadyCard from '../AssignmentReadyCard.svelte'
  import AuditOfferCard from '../AuditOfferCard.svelte'
  import AuditReadyCard from '../AuditReadyCard.svelte'
  import AuditGeneratedCard from '../AuditGeneratedCard.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import AssistantRecapCard from '$lib/components/assistant/AssistantRecapCard.svelte'
  import AssistantReadyCard from '$lib/components/assistant/AssistantReadyCard.svelte'
  import AssistantSessionQuestion from '$lib/components/assistant/AssistantSessionQuestion.svelte'
  import { rendererRecovery, publishDraftActivity } from '$lib/stores/renderer-recovery.svelte'
  import { modelKey } from '$lib/model-keys'
  import { dismissedTodo } from '$lib/stores/dismissed-todo.svelte'
  import { assistantIsScheduled } from '$shared/types'
  import { APP_NAME } from '$shared/brand'
  import { supportsManualCompaction } from '$shared/thread-status-policy'
  import { harnessDisplayName } from '../thread-message-presentation'

  /** The board the surface built, and the few values only it can build. */
  let {
    board,
    composerShoe,
    activeActions,
    compactionFold
  }: {
    board: ThreadViewBoard
    composerShoe: ComposerShoeData
    activeActions: ActionDefinition[]
    compactionFold: { readonly folded: boolean }
  } = $props()
</script>

<div
  class="bottom-chrome relative {board.composerScope.centeredComposer
    ? 'flex min-h-0 flex-1 flex-col justify-center'
    : 'shrink-0'}"
>
  {#if board.loadOlderMessages.userScrolledAway}
    <!-- Bottom-anchored chrome, so it exists only while the reader is away
             from the tail. Squared and bordered like every other control, and it
             names what it does instead of showing a bare chevron in a pill.

             Its rung is deliberate: above everything the transcript paints, which
             reaches z-20 on a working trace's sticky header, and below the
             composer (z-40), whose own menus and popovers open upward across this
             spot so they must never be cut off by it. The click-away scrims sit
             below it inside the composer, which is what a scrim should do to a
             control above the surface it guards. -->
    <button
      type="button"
      class="group absolute left-1/2 z-30 inline-flex h-7 -translate-x-1/2 items-center gap-1 border border-border-strong bg-surface px-2 text-[0.6875rem] font-medium whitespace-nowrap text-foreground shadow-md transition-colors hover:bg-elevated focus-visible:ring-2 focus-visible:ring-primary focus-visible:outline-none"
      style:top={board.unmirroredTraceStartTime.scrollButtonTop}
      title="Scroll to latest message"
      aria-label="Scroll to latest message"
      onclick={board.loadOlderMessages.scrollToLatest}
      transition:fly={{ y: -8, duration: 140 }}
    >
      <CioChevronDown
        size={12}
        class="shrink-0 text-muted transition-colors group-hover:text-foreground"
      />
      Latest
    </button>
  {/if}
  <div class="flex min-w-0 flex-col">
    <!-- Assignment worker failures stay visible on the coordinator, but their
         actions target the owning durable worker rather than this thread. -->
    {#each board.submitBrainstormDecision.assignmentWorkerAttentionItems as item, index (item.task.id)}
      <div class="conversation-gutter shrink-0 px-6">
        <div class="mx-auto max-w-3xl">
          <AgentProviderStatusCard
            status={board.state.assignmentWorkerAttentionStatus(item.task, item.worker)}
            providerName={harnessDisplayName(item.worker.settings?.harnessId ?? 'unknown')}
            settings={item.worker.settings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            sourceLabel={item.task.workerName ?? item.worker.title}
            sourceDetail={item.task.title}
            retryLabel="Retry worker"
            retrying={board.submitBrainstormDecision.assignmentWorkerRetryingId === item.worker.id}
            stackedAbove={index > 0}
            joinsBelow
            threadId={board.handleAgentEvent.thread.id}
            foldKey={`worker:${item.worker.id}`}
            onModelChange={(selected) =>
              void board.currentWorkingTraceAttribution.changeAssignmentWorkerModel(
                item.worker,
                selected
              )}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            onRetry={() => void board.submitBrainstormDecision.retryAssignmentWorker(item.worker)}
          />
        </div>
      </div>
    {/each}

    <!-- Provider status   between messages and composer, always visible. A
         matching bubbled worker error is replaced by the attributed card above. -->
    {#if board.submitBrainstormDecision.visibleProviderStatus && !board.submitBrainstormDecision.coordinatorErrorMatchesAssignmentWorker}
      <div class="conversation-gutter shrink-0 px-6">
        <div class="mx-auto max-w-3xl">
          <AgentProviderStatusCard
            status={board.submitBrainstormDecision.visibleProviderStatus}
            stackedAbove={board.unmirroredTraceStartTime.stackedAboveSlot('provider')}
            joinsBelow
            threadId={board.handleAgentEvent.thread.id}
            providerName={board.submitBrainstormDecision.statusCardProviderName}
            settings={board.composerScope.statusCardSettings ??
              (board.props.chatMode
                ? {
                    ...board.loadOlderMessages.settings,
                    assignmentMode: false,
                    loopMode: false
                  }
                : board.loadOlderMessages.settings)}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.modelFavoritesFor(board.sources.modelScope())}
            recentModels={rendererRecovery.modelRecentsFor(board.sources.modelScope())}
            onRemoveRecent={(key) =>
              rendererRecovery.removeModelRecentFor(board.sources.modelScope(), key)}
            onModelChange={board.currentWorkingTraceAttribution.changeThreadModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleModelFavoriteFor(
                board.sources.modelScope(),
                modelKey(harnessId, providerId, modelId)
              )}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderModelFavoriteFor(
                board.sources.modelScope(),
                draggedKey,
                targetKey,
                position
              )}
            onStop={board.abortRun.abortRun}
            onRetry={board.abortRun.retryConnection}
            retrying={board.abortRun.providerRetrying}
            onSignedIn={board.submitBrainstormDecision.proactiveAuthVisible
              ? () => void board.studioTemporaryChatContext.refreshAfterProactiveSignIn()
              : undefined}
            autoRetryEnabled={board.unmirroredTraceStartTime.autoRetryAfterReset}
            onDismiss={() => {
              board.handleAgentEvent.errorMessage = ''
              board.handleAgentEvent.providerStatus = null
              board.submitBrainstormDecision.proactiveAuthIssue = null
              if (board.props.controller) {
                // Controller conversations own their error state in the
                // controller's store key   clearing the thread-scoped
                // backend error would leave the card stuck on screen.
                board.props.controller.clearStatus()
              } else {
                void board.composerScope.dismissSessionError()
              }
            }}
          />
        </div>
      </div>
    {/if}

    <!-- Compaction interrupted   the auto-compaction ate the last turn and was
       stopped before it saved a summary. A top-of-thread card: it reports, it
       never blocks the composer. -->
    {#if board.unmirroredTraceStartTime.compactionInterruptedNotice}
      <div class="conversation-gutter shrink-0 px-6">
        <div class="mx-auto max-w-3xl">
          <div out:slide={dismissSlide()} role="status" aria-live="polite">
            <CardFrame
              placement="top"
              label="Compaction interrupted"
              stackedAbove={board.unmirroredTraceStartTime.stackedAboveSlot('compaction')}
              joinsBelow
            >
              <CardHead
                icon={CioAttention}
                title="Compaction interrupted"
                chip={{
                  text: 'Stopped',
                  tone: 'urgent',
                  title: 'The summary was never saved'
                }}
                bind:folded={compactionFold.folded}
                foldLabel="compaction notice"
              />
              {#if !compactionFold.folded}
                <div class="space-y-2 px-3 py-2.5">
                  <CardNotice icon={CioAttention} tone="warn">
                    {board.unmirroredTraceStartTime.compactionInterruptedNotice}
                  </CardNotice>
                </div>
                <CardFoot>
                  {#snippet left()}
                    <CardButton
                      label="Dismiss"
                      title="Dismiss the compaction notice"
                      variant="ghost"
                      onclick={() =>
                        (board.unmirroredTraceStartTime.compactionInterruptedNotice = '')}
                    />
                  {/snippet}
                </CardFoot>
              {/if}
            </CardFrame>
          </div>
        </div>
      </div>
    {/if}

    <!-- Queued message card   attached to the top of the composer. It stacks on the
       edge of whatever the composer slot shows, so its own bottom rule is dropped
       and the surface below carries the join: a broken line when a card is what
       follows, the composer's dashed top rule when the composer is. It opens the
       way it closes, on the slot rather than the card: the space grows out of the
       composer's edge (`cardArrive`) exactly as the card's own dismissal collapses
       it, so parking a message never snaps the transcript up by a card's height.
       The head names what waits, and Send now (the steer key) is a head control. -->
    {#if board.steerQueuedMessage.queuedCardVisible}
      <div class="conversation-gutter shrink-0 px-6" in:slide={cardArrive()}>
        <div class="mx-auto max-w-3xl">
          <ComposerQueuedCard
            text={board.steerQueuedMessage.queuedMessage}
            hasContent={board.steerQueuedMessage.queuedHasContent}
            attachments={board.steerQueuedMessage.queuedAttachments}
            previewUrls={board.studioTemporaryChatContext.attachmentPreview.urls}
            count={board.unmirroredTraceStartTime.queuedCount}
            next={board.unmirroredTraceStartTime.queuedNextMessages}
            promptReferences={board.steerQueuedMessage.queuedPromptReferences}
            presentation={board.steerQueuedMessage.queuedPresentation}
            startAfterThreads={board.steerQueuedMessage.queuedStartAfterThreads}
            steerModifierLabel={board.state.steerModifierLabel}
            threadId={board.handleAgentEvent.thread.id}
            stackedAbove={board.unmirroredTraceStartTime.stackedAboveSlot('queued')}
            onPreviewAttachment={board.studioTemporaryChatContext.openQueuedAttachment}
            onSteer={() => void board.steerQueuedMessage.steerQueuedMessage()}
            onEdit={board.steerQueuedMessage.editQueuedMessage}
            onDelete={board.unmirroredTraceStartTime.deleteQueuedMessage}
            onDeleteAll={board.steerQueuedMessage.deleteAllQueuedMessages}
            onAddStartAfter={() => (board.state.queuedStartAfterPickerOpen = true)}
            onRemoveStartAfter={(dependency) =>
              (board.steerQueuedMessage.queuedStartAfterPendingRemoval = dependency)}
            onOpenStartAfter={(id) => void board.unmirroredTraceStartTime.openStartAfterThread(id)}
            onPreloadStartAfter={board.unmirroredTraceStartTime.preloadStartAfterThread}
          />
        </div>
      </div>
    {/if}

    <!-- Composer   always anchored at the bottom. Blocking permission and question
       tools replace it until the user responds. The queued card sits directly on
       whatever this slot shows, so it keeps its own top spacing and gives up the
       padding here rather than opening a gap in the middle of the stack. -->
    <div
      class="conversation-gutter composer-gutter relative shrink-0 px-6 pb-5 {board
        .unmirroredTraceStartTime.composerStackedAbove
        ? 'pt-0'
        : 'pt-2'}"
    >
      <div
        class="mx-auto w-full {board.composerScope.centeredComposer ? 'max-w-4xl' : 'max-w-3xl'}"
      >
        {#if board.composerScope.centeredComposer}
          {#if board.props.assistantMode}
            <div class="mb-5 text-center">
              <h1 class="text-[1.25rem] font-semibold tracking-tight text-foreground">
                {board.props.assistantName ?? board.handleAgentEvent.thread.title}
              </h1>
              <p class="mx-auto mt-1.5 max-w-2xl text-[0.875rem] leading-relaxed text-muted">
                {#if board.props.assistantName && board.state.assistantUnnamed && !board.props.assistantKnowledgeComplete}
                  Your new board.abortRun.assistant is getting to know you. Answer its first
                  question and it takes it from there.
                {:else if board.props.assistantName && !board.props.assistantKnowledgeComplete}
                  Tell {board.props.assistantName} what you want it to handle. It asks what it needs,
                  and writes down what it learns so every run follows it.
                {:else if board.props.assistantName && board.abortRun.assistantSetupThread}
                  This conversation is where you teach {board.props.assistantName} and change its behavior.
                  To give it a task, start a new one with the New task button in the header, or press
                  {board.state.assistantNewTaskShortcut}.
                {:else if board.props.assistantName}
                  This task runs on <span class="text-foreground">{board.props.assistantName}</span
                  >'s behavior. Send a message to run it now, or change anything in Assistant
                  behavior.
                {:else}
                  Describe what this task should do and the agent will take it from there.
                {/if}
              </p>
            </div>
          {:else if board.props.emptyStateHeading}
            <div class="mb-5 text-center">
              {@render board.props.emptyStateHeading()}
            </div>
          {:else}
            <div class="mb-5 text-center">
              <h1
                class="flex items-center justify-center gap-2.5 text-[1.375rem] font-semibold tracking-tight text-foreground"
              >
                {#if board.switchProject.centeredProjectIconUrl}
                  <img
                    src={board.switchProject.centeredProjectIconUrl}
                    alt=""
                    aria-hidden="true"
                    class="size-7 object-cover"
                  />
                {/if}
                {board.props.chatMode
                  ? 'Start a new chat'
                  : (board.contextUsage.project?.name ?? 'New thread')}
              </h1>
              <p class="mt-1 text-[0.875rem] text-muted">
                {board.props.chatMode
                  ? 'Send a message to begin no project needed'
                  : board.currentWorkingTraceAttribution.centeredModelName
                    ? `What should ${board.currentWorkingTraceAttribution.centeredModelName} work on using CodeInOven?`
                    : 'How can CodeInOven serve you today?'}
              </p>
            </div>
          {/if}
        {/if}
        {#if board.unmirroredTraceStartTime.aiAccountPromptVisible}
          <div>
            <AiAccountSetupCard
              harnessName={harnessDisplayName(board.loadOlderMessages.settings.harnessId)}
              providers={board.currentWorkingTraceAttribution.providers}
              settings={board.loadOlderMessages.settings}
              projectId={board.handleAgentEvent.thread.projectId}
              stackedAbove={board.unmirroredTraceStartTime.stackedAboveSlot('account')}
              joinsBelow
              threadId={board.handleAgentEvent.thread.id}
              favoriteModels={rendererRecovery.modelFavoritesFor(board.sources.modelScope())}
              recentModels={rendererRecovery.modelRecentsFor(board.sources.modelScope())}
              onRemoveRecent={(key) =>
                rendererRecovery.removeModelRecentFor(board.sources.modelScope(), key)}
              onToggleFavorite={(providerId, modelId, harnessId) =>
                rendererRecovery.toggleModelFavoriteFor(
                  board.sources.modelScope(),
                  modelKey(harnessId, providerId, modelId)
                )}
              onReorderFavorite={(draggedKey, targetKey, position) =>
                rendererRecovery.reorderModelFavoriteFor(
                  board.sources.modelScope(),
                  draggedKey,
                  targetKey,
                  position
                )}
              onModelChange={board.contextUsage.updateSettings}
              onConnect={board.composerScope.openAiAccountSetup}
              onDismiss={() => (board.unmirroredTraceStartTime.aiAccountPromptOpen = false)}
            />
          </div>
        {/if}
        {#if board.props.assistantForeignRunThreadId}
          <div>
            <ForeignRunCard
              projectId={board.handleAgentEvent.thread.projectId}
              threadId={board.props.assistantForeignRunThreadId}
              stackedAbove={board.unmirroredTraceStartTime.stackedAboveSlot('foreign-run')}
              joinsBelow
            />
          </div>
        {/if}
        {#if board.sources.pendingImageDescriptorError && !board.submitBrainstormDecision.achievementAutonomous}
          {#key board.sources.pendingImageDescriptorError.id}
            <ImageDescriptorErrorCard
              request={board.sources.pendingImageDescriptorError}
              providers={board.currentWorkingTraceAttribution.providers}
              projectId={board.handleAgentEvent.thread.projectId}
              favoriteModels={rendererRecovery.favoriteModels}
              recentModels={rendererRecovery.recentModels}
              onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
              onRetry={async (requestId, selection, remember) => {
                if (remember) {
                  board.sources.agentDefaults = {
                    ...board.sources.agentDefaults,
                    imageDescriptor: selection
                  }
                  board.unmirroredTraceStartTime.imageDescriptorAskAgain = true
                  await invoke('config:update', {
                    agentDefaults: board.sources.agentDefaults,
                    imageDescriptorAskAgain: true
                  })
                }
                await board.sources.replyImageDescriptor(requestId, 'retry', selection)
              }}
              onIgnore={(requestId) => board.sources.replyImageDescriptor(requestId, 'ignore')}
              onPickImage={(requestId) => board.sources.pickImageDescriptorReplacement(requestId)}
              onFalsePositive={(requestId) =>
                board.sources.reportImageDescriptorFalsePositive(requestId)}
              onToggleFavorite={(providerId, modelId, harnessId) =>
                rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
              onReorderFavorite={(draggedKey, targetKey, position) =>
                rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
              stackedAbove={board.unmirroredTraceStartTime.stackedAboveSlot('image-descriptor')}
              joinsBelow
              threadId={board.handleAgentEvent.thread.id}
            />
          {/key}
        {/if}
        {#if board.submitBrainstormDecision.failureRetryVisible && board.handleAgentEvent.engineeringLifecycle}
          <EngineeringRetryCard
            stage={board.handleAgentEvent.engineeringLifecycle.activeStage}
            failure={board.handleAgentEvent.engineeringLifecycle.failure}
            busy={board.submitBrainstormDecision.engineeringLifecycleRetrying}
            settings={board.loadOlderMessages.settings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            onRetry={() => void board.submitBrainstormDecision.retryEngineeringLifecycle()}
            onCancel={() => void board.studioTemporaryChatContext.cancelEngineeringFailure()}
            onModelChange={board.currentWorkingTraceAttribution.changeThreadModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        {/if}
        {#if board.unmirroredTraceStartTime.isAssignmentAuditorThread}
          <AuditGeneratedCard
            state={board.buildSpecActionPrompt.assignmentAuditState}
            version={board.buildSpecActionPrompt.assignmentAuditState === 'running'
              ? undefined
              : board.contextUsage.auditReport?.version}
            error={board.unmirroredTraceStartTime.assignmentAuditFailure ||
              board.handleAgentEvent.errorMessage}
            startedAt={board.unmirroredTraceStartTime.assignmentAuditStartedAt}
            finishedAt={board.unmirroredTraceStartTime.assignmentAuditFinishedAt}
            reworkCycle={board.unmirroredTraceStartTime.assignmentReworkCycle}
            settings={board.contextUsage.auditSettings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            busy={board.submitSpecDecision.auditBusy || board.switchProject.busy}
            onRetry={board.buildSpecActionPrompt.retryAssignmentAuditFromAuditor}
            onModelChange={board.contextUsage.changeAuditModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            onViewReport={board.currentWorkingTraceAttribution.openCoordinatorAuditReport}
          />
        {:else if (board.editVideoNote.pendingEngineeringEntry === 'prd' || board.editVideoNote.pendingEngineeringEntry === 'spec') && !board.switchProject.busy && !board.submitBrainstormDecision.failureRetryVisible}
          <EngineeringEntryCard
            target={board.editVideoNote.pendingEngineeringEntry}
            busy={board.harnessUsage.prdBusy || board.harnessUsage.brainstormBusy}
            onBrainstormFirst={() => board.editVideoNote.chooseEngineeringEntry('brainstorm_first')}
            onJumpIn={() => board.editVideoNote.chooseEngineeringEntry('jump_in')}
            settings={board.loadOlderMessages.settings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            onModelChange={board.currentWorkingTraceAttribution.changeThreadModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        {:else if board.submitBrainstormDecision.brainstormWorkflow?.entryChoice && !board.editVideoNote.brainstorm && !board.submitBrainstormDecision.spec && board.submitBrainstormDecision.brainstormGenerationFailed && !board.switchProject.busy && !board.submitBrainstormDecision.failureRetryVisible}
          <BrainstormEntryChoiceCard
            busy={board.harnessUsage.brainstormBusy}
            retryChoice={board.submitBrainstormDecision.brainstormWorkflow.entryChoice}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            settings={board.loadOlderMessages.settings}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            onStartBrainstorm={() =>
              board.submitBrainstormDecision.chooseBrainstormEntry('brainstorm')}
            onJumpToSpec={() => board.submitBrainstormDecision.chooseBrainstormEntry('spec')}
            onModelChange={board.currentWorkingTraceAttribution.changeSpecModel}
            onCancel={board.submitBrainstormDecision.cancelBrainstormEntryRetry}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        {:else if board.submitBrainstormDecision.brainstormWorkflow?.stage === 'choice_pending' && !board.switchProject.busy && !board.submitBrainstormDecision.failureRetryVisible}
          <BrainstormEntryChoiceCard
            busy={board.harnessUsage.brainstormBusy}
            onStartBrainstorm={() =>
              board.submitBrainstormDecision.chooseBrainstormEntry('brainstorm')}
            onJumpToSpec={() => board.submitBrainstormDecision.chooseBrainstormEntry('spec')}
            onClose={board.submitBrainstormDecision.revertEngineeringEntryChoice}
          />
        {:else if board.composerScope.visiblePermissions.length > 0 && !board.submitBrainstormDecision.achievementAutonomous}
          {@const pendingPermission = board.composerScope.visiblePermissions[0]}
          {#key pendingPermission.id}
            <PermissionRequestCard
              request={pendingPermission}
              scope={{
                kind: 'project',
                projectId: board.handleAgentEvent.thread.projectId,
                threadId: board.handleAgentEvent.thread.id
              }}
              onAllowOnce={board.abortRun.allowPermissionOnce}
              onAllowAlways={board.abortRun.allowPermissionAlways}
              onReject={board.abortRun.rejectPermission}
              onAlternative={board.abortRun.providePermissionAlternative}
            />
          {/key}
        {:else if board.handleAgentEvent.pendingQuestionRequests.length > 0 && !board.composerScope.assistantRecapSupersedesQuestion && (!board.submitBrainstormDecision.achievementAutonomous || board.handleAgentEvent.pendingQuestionRequests[0].questions.some((question) => question.secretRequest === true))}
          {@const pendingRequest = board.handleAgentEvent.pendingQuestionRequests[0]}
          {#key pendingRequest.requestId}
            {#if pendingRequest.questions.some((question) => question.secretRequest === true)}
              <AgentSecretCard
                request={pendingRequest}
                scope={{
                  kind: 'project',
                  projectId: board.handleAgentEvent.thread.projectId,
                  threadId: board.handleAgentEvent.thread.id
                }}
                onSubmit={board.composerScope.handleSecretSubmit}
                onDismiss={board.unmirroredTraceStartTime.handleQuestionDismiss}
                onExplain={board.sources.handleQuestionExplain}
                onQuickChat={board.sources.handleQuestionQuickChat}
                onPause={board.composerScope.handleSecretPause}
              />
            {:else}
              <AgentQuestionCard
                request={pendingRequest}
                scope={{
                  kind: 'project',
                  projectId: board.handleAgentEvent.thread.projectId,
                  threadId: board.handleAgentEvent.thread.id
                }}
                onAnswer={board.unmirroredTraceStartTime.handleQuestionAnswer}
                onDismiss={board.unmirroredTraceStartTime.handleQuestionDismiss}
                onUpdate={board.sources.handleQuestionUpdate}
                onExplain={board.sources.handleQuestionExplain}
                onQuickChat={board.sources.handleQuestionQuickChat}
                settings={board.loadOlderMessages.settings}
                providers={board.currentWorkingTraceAttribution.providers}
                projectId={board.handleAgentEvent.thread.projectId}
                favoriteModels={rendererRecovery.favoriteModels}
                recentModels={rendererRecovery.recentModels}
                onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
                onModelChange={board.currentWorkingTraceAttribution.changeThreadModel}
                onToggleFavorite={(providerId, modelId, harnessId) =>
                  rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
                onReorderFavorite={(draggedKey, targetKey, position) =>
                  rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
              />
            {/if}
          {/key}
        {:else if board.buildSpecActionPrompt.assignmentAuditState === 'running' && board.unmirroredTraceStartTime.assignmentAuditOwner && !board.submitBrainstormDecision.achievementAutonomous && !board.submitBrainstormDecision.failureRetryVisible}
          <AuditGeneratedCard
            state="running"
            reworkCycle={board.unmirroredTraceStartTime.assignmentReworkCycle}
            settings={board.contextUsage.auditSettings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            busy={board.submitSpecDecision.auditBusy}
            onRetry={() => void board.buildSpecActionPrompt.openAssignmentAuditWork()}
            onModelChange={board.contextUsage.changeAuditModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            onViewReport={board.contextUsage.openAuditStudio}
          />
        {:else if board.unmirroredTraceStartTime.plainEngineeringAuditRunning && !board.submitBrainstormDecision.achievementAutonomous && !board.submitBrainstormDecision.failureRetryVisible}
          <AuditGeneratedCard
            state="running"
            settings={board.contextUsage.auditSettings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            onRetry={board.contextUsage.generateDurableImplementationAudit}
            onModelChange={board.contextUsage.changeAuditModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            onViewTrace={() => void board.currentWorkingTraceAttribution.openDurableAuditWork()}
            onViewReport={board.contextUsage.openAuditStudio}
          />
        {:else if board.buildSpecActionPrompt.assignmentAuditState === 'failed' && board.unmirroredTraceStartTime.assignmentAuditOwner && !board.switchProject.busy && !board.submitBrainstormDecision.achievementAutonomous && !board.submitBrainstormDecision.failureRetryVisible}
          <AuditGeneratedCard
            state="failed"
            error={board.unmirroredTraceStartTime.assignmentAuditFailure}
            startedAt={board.unmirroredTraceStartTime.assignmentAuditStartedAt}
            finishedAt={board.unmirroredTraceStartTime.assignmentAuditFinishedAt}
            retryLabel="Retry audit"
            reworkCycle={board.unmirroredTraceStartTime.assignmentReworkCycle}
            settings={board.contextUsage.auditSettings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            busy={board.submitSpecDecision.auditBusy}
            onRetry={board.buildSpecActionPrompt.generateDurableAssignmentAudit}
            onModelChange={board.contextUsage.changeAuditModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            onViewReport={board.contextUsage.openAuditStudio}
          />
        {:else if board.buildSpecActionPrompt.assignmentAuditState === 'partial' && board.contextUsage.auditReport && !board.switchProject.busy && !board.submitBrainstormDecision.achievementAutonomous && !board.unmirroredTraceStartTime.studioOnlyAuditWorkflow && !board.submitBrainstormDecision.failureRetryVisible}
          <AuditGeneratedCard
            state="partial"
            version={board.contextUsage.auditReport.version}
            validationIssues={board.contextUsage.auditReport.evidenceIssues ?? []}
            retryLabel="Ask auditor to validate facts"
            settings={board.contextUsage.auditSettings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            busy={board.submitSpecDecision.auditBusy}
            onRetry={board.buildSpecActionPrompt.generateDurableAssignmentAudit}
            onModelChange={board.contextUsage.changeAuditModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            onViewReport={board.contextUsage.openAuditStudio}
          />
        {:else if board.buildSpecActionPrompt.assignmentAuditState === 'offered' && board.unmirroredTraceStartTime.assignmentAuditOwner && !board.buildSpecActionPrompt.assignmentAuditOfferDismissed && !board.switchProject.busy && !board.submitBrainstormDecision.achievementAutonomous && !board.unmirroredTraceStartTime.studioOnlyAuditWorkflow && !board.submitBrainstormDecision.failureRetryVisible}
          <AuditOfferCard
            threadTitle={board.handleAgentEvent.thread.title}
            reworkCycle={board.unmirroredTraceStartTime.assignmentReworkCycle}
            settings={board.contextUsage.auditSettings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            busy={board.submitSpecDecision.auditBusy}
            onCancel={() => void board.submitSpecDecision.completeAudit('dismiss')}
            onAudit={board.buildSpecActionPrompt.generateAudit}
            onModelChange={board.contextUsage.changeAuditModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        {:else if board.buildSpecActionPrompt.assignmentAuditState === 'report_ready' && board.contextUsage.auditReport && board.unmirroredTraceStartTime.assignmentAuditOwner && !board.switchProject.busy && !board.submitBrainstormDecision.achievementAutonomous && !board.unmirroredTraceStartTime.studioOnlyAuditWorkflow && !board.submitBrainstormDecision.failureRetryVisible}
          <AuditReadyCard
            report={board.contextUsage.auditReport}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            settings={board.contextUsage.auditSettings}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            busy={board.submitSpecDecision.auditBusy}
            onViewReport={board.contextUsage.openAuditStudio}
            onComplete={board.submitSpecDecision.completeAudit}
            onCancel={() => void board.submitSpecDecision.completeAudit('dismiss')}
            onReaudit={board.buildSpecActionPrompt.reaudit}
            onModelChange={board.contextUsage.changeAuditModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        {:else if board.harnessUsage.prd?.status === 'draft' && !board.switchProject.busy && !board.harnessUsage.specFormulating && !board.submitBrainstormDecision.failureRetryVisible}
          <PrdReadyCard
            busy={board.harnessUsage.prdBusy}
            onReview={board.unmirroredTraceStartTime.openPrdStudio}
            onFinalize={board.harnessUsage.finalizePrd}
            settings={board.loadOlderMessages.settings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            onModelChange={board.currentWorkingTraceAttribution.changeThreadModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        {:else if board.submitBrainstormDecision.brainstormWorkflow?.stage === 'drafting' && board.editVideoNote.brainstorm && !board.switchProject.busy && !board.harnessUsage.specFormulating && !board.submitBrainstormDecision.failureRetryVisible}
          {@const readyBrainstorm = board.editVideoNote.brainstorm}
          <BrainstormReadyCard
            version={readyBrainstorm.version}
            prototypes={readyBrainstorm.content.prototypes ?? []}
            busy={board.harnessUsage.brainstormBusy}
            onReview={board.editVideoNote.openBrainstormStudio}
            onOpenPrototype={board.unmirroredTraceStartTime.openPrototypePreview}
            onNextStep={(step) => board.harnessUsage.brainstormNextStep(step, readyBrainstorm)}
            settings={board.loadOlderMessages.settings}
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            onModelChange={board.currentWorkingTraceAttribution.changeThreadModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        {:else if board.submitSpecDecision.assignment?.status === 'draft' && !board.switchProject.busy && !board.harnessUsage.specFormulating && !board.submitBrainstormDecision.failureRetryVisible}
          {#key board.submitSpecDecision.assignment.version}
            <AssignmentReadyCard
              assignment={board.submitSpecDecision.assignment}
              providers={board.currentWorkingTraceAttribution.providers}
              projectId={board.handleAgentEvent.thread.projectId}
              harnessId={board.loadOlderMessages.settings.harnessId}
              fallbackModel={board.sources.workerModelForThread()}
              seniorModel={board.composerScope.seniorModelForThread()}
              favoriteModels={rendererRecovery.favoriteModels}
              recentModels={rendererRecovery.recentModels}
              onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
              busy={board.submitSpecDecision.assignmentBusy}
              error={board.submitSpecDecision.assignmentError}
              onSave={(content) => void board.submitSpecDecision.saveAssignment(content)}
              onApprove={(content) => void board.submitSpecDecision.approveAssignment(content)}
              onOpenFullscreen={board.submitSpecDecision.openAssignmentStudio}
              onWorkerModelChange={(selection) => board.sources.syncAgentRole('worker', selection)}
              onSeniorModelChange={board.sources.updateAssignmentSeniorModel}
              onTaskScopeChange={board.submitSpecDecision.updateAssignmentTaskScope}
              onWorkerScopeChange={board.submitSpecDecision.updateAssignmentWorkerScope}
              assignmentScopeBucketId={board.unmirroredTraceStartTime.assignmentScopeBucketId}
              onOpenTaskThread={(threadId) =>
                void board.currentWorkingTraceAttribution.openAssignmentTaskThread(threadId)}
              resolveTaskThread={board.currentWorkingTraceAttribution.resolveAssignmentTaskThread}
              onToggleFavorite={(providerId, modelId, harnessId) =>
                rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
              onReorderFavorite={(draggedKey, targetKey, position) =>
                rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
            />
          {/key}
        {:else if board.composerScope.conversationAssignmentVisible && !board.switchProject.busy && !board.submitBrainstormDecision.failureRetryVisible}
          <SpecReadyCard
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            settings={board.loadOlderMessages.settings}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            busy={board.submitSpecDecision.assignmentBusy}
            specless
            assignmentMode
            error={board.submitSpecDecision.assignmentError}
            onCancel={board.composerScope.dismissConversationAssignment}
            onReview={board.abortRun.reviewReadySpec}
            onProceed={board.studioTemporaryChatContext.proceedWithReadySpec}
            onGenerateAssignment={() => void board.submitSpecDecision.generateAssignmentDraft()}
            onOpenAssignment={board.submitSpecDecision.openAssignmentStudio}
            onModelChange={board.currentWorkingTraceAttribution.changeThreadModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        {:else if (board.studioTemporaryChatContext.specReadyToolVisible || (board.loadOlderMessages.settings.assignmentMode && board.submitBrainstormDecision.spec && !board.submitSpecDecision.assignment)) && board.submitBrainstormDecision.spec && !board.switchProject.busy && !board.harnessUsage.specFormulating && !board.submitBrainstormDecision.failureRetryVisible}
          <SpecReadyCard
            providers={board.currentWorkingTraceAttribution.providers}
            projectId={board.handleAgentEvent.thread.projectId}
            settings={board.loadOlderMessages.settings}
            favoriteModels={rendererRecovery.favoriteModels}
            recentModels={rendererRecovery.recentModels}
            onRemoveRecent={(key) => rendererRecovery.removeRecentModel(key)}
            busy={board.switchProject.busy || board.abortRun.specBusy}
            assignmentMode={board.loadOlderMessages.settings.assignmentMode === true}
            assignmentAvailable={board.submitSpecDecision.assignment !== null}
            onCancel={board.studioTemporaryChatContext.cancelSpecReadyTool}
            onReview={board.abortRun.reviewReadySpec}
            onProceed={board.studioTemporaryChatContext.proceedWithReadySpec}
            onGenerateAssignment={() => void board.submitSpecDecision.generateAssignmentDraft()}
            onOpenAssignment={board.submitSpecDecision.openAssignmentStudio}
            onModelChange={board.currentWorkingTraceAttribution.changeSpecModel}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderFavorite(draggedKey, targetKey, position)}
          />
        {:else}
          {#if !board.submitBrainstormDecision.failureRetryVisible}
            {#if board.composerScope.visibleTodo}
              <AgentTodoCard
                items={board.composerScope.visibleTodo.items}
                signature={board.composerScope.visibleTodo.signature}
                busy={board.switchProject.busy}
                stopped={board.composerScope.todoRunStopped}
                foreign={board.composerScope.foreignRunActive}
                stackedAbove={board.unmirroredTraceStartTime.stackedAboveSlot('todo')}
                threadId={board.handleAgentEvent.thread.id}
                onClose={() =>
                  dismissedTodo.dismiss(
                    board.handleAgentEvent.thread.id,
                    board.composerScope.visibleTodo?.signature ?? ''
                  )}
              />
            {/if}
            {#if board.composerScope.foreignRunActive}
              <ForeignRunCard
                projectId={board.handleAgentEvent.thread.projectId}
                threadId={board.handleAgentEvent.thread.id}
              />
            {:else if board.switchProject.assistantRecapInComposer && board.switchProject.assistantDraft}
              <!-- The recap card takes the composer's place rather than sitting on
                       top of it: it is asking for the one answer the composer would
                       otherwise collect, and a draft under review is not something to
                       type into. Keep editing puts the composer back. -->
              <AssistantRecapCard
                assistantName={board.abortRun.assistant?.name ??
                  board.props.assistantName ??
                  board.handleAgentEvent.thread.title}
                knowledge={board.switchProject.assistantDraft.knowledge}
                plan={board.switchProject.assistantDraft.plan}
                update={board.props.assistantKnowledgeComplete}
                previousKnowledge={board.abortRun.assistant?.knowledge ?? ''}
                scheduled={board.abortRun.assistant
                  ? assistantIsScheduled(board.abortRun.assistant)
                  : true}
                existingConnections={board.abortRun.existingAssistantConnections}
                saving={board.switchProject.assistantSaving}
                onSave={() => void board.switchProject.confirmAssistantSave()}
                onKeepEditing={board.unmirroredTraceStartTime.keepEditingAssistant}
                threadId={board.handleAgentEvent.thread.id}
              />
            {:else if board.switchProject.assistantComposerCovered}
              {#if board.switchProject.assistantBehaviorSession && board.props.active}
                {#key `${board.handleAgentEvent.thread.id}:${board.switchProject.assistantBehaviorSession.startedAt}:${board.switchProject.assistantBehaviorSession.dismissals}`}
                  <AssistantSessionQuestion
                    projectId={board.handleAgentEvent.thread.projectId}
                    threadId={board.handleAgentEvent.thread.id}
                    repeated={board.switchProject.assistantBehaviorSession.dismissals > 0}
                    onDone={board.unmirroredTraceStartTime.finishAssistantBehaviorSession}
                    onContinue={board.unmirroredTraceStartTime.modifyAssistantBehavior}
                    onDismiss={board.switchProject.dismissAssistantSessionQuestion}
                  />
                {/key}
              {:else}
                <AssistantReadyCard
                  threadId={board.handleAgentEvent.thread.id}
                  active={board.props.active}
                  scheduled={board.abortRun.assistantScheduled}
                  nextRunAt={board.abortRun.assistantSetupNextRunAt}
                  running={board.abortRun.assistantRunStarting}
                  onModify={board.unmirroredTraceStartTime.modifyAssistantBehavior}
                  onStartTask={() => workspaceState.requestAssistantTask()}
                  onRunNow={() => void board.abortRun.runAssistantNow()}
                />
              {/if}
            {:else}
              {#key board.currentWorkingTraceAttribution.composerRestoreKey}
                <ChatComposer
                  bind:this={board.state.composer}
                  placeholder={board.props.assistantMode &&
                  board.props.assistantName &&
                  !board.props.assistantKnowledgeComplete
                    ? `Tell $assistantName={board.props.assistantName} what you want it to do…`
                    : board.abortRun.assistantSetupThread && board.props.assistantKnowledgeComplete
                      ? 'Change its behavior, its times, or a connection…'
                      : board.submitBrainstormDecision.activePlanningEntry === 'brainstorm'
                        ? 'Add details to the Brainstorm discussion…'
                        : board.submitBrainstormDecision.activePlanningEntry === 'spec'
                          ? 'Sr. Engineer is preparing the specification…'
                          : board.composerScope.assignmentFormulating
                            ? 'Sr. Engineer is preparing the Assignment…'
                            : board.harnessUsage.specFormulating
                              ? 'Formulating specification…'
                              : board.buildSpecActionPrompt.delegatedWorkBusy
                                ? `$delegatedActivityLabel={board.switchProject.delegatedActivityLabel}   message the Sr. Engineer`
                                : board.switchProject.busy
                                  ? `${APP_NAME} is working   type to queue a message`
                                  : (board.props.composerPlaceholder ?? 'Send a message...')}
                  disabled={board.harnessUsage.specFormulating}
                  working={board.switchProject.busy}
                  onStop={board.abortRun.abortRun}
                  autofocus
                  showEngineeringMode={!board.props.chatMode &&
                    !board.currentWorkingTraceAttribution.orchestrationChild}
                  engineeringLifecycle={board.editVideoNote.pendingLifecycleDisplay}
                  engineeringActive={board.submitBrainstormDecision.engineeringOn}
                  onEngineeringLifecycleSelect={board.switchProject.selectEngineeringLifecycle}
                  independentAuditAvailable={board.currentWorkingTraceAttribution
                    .independentAuditAvailable}
                  independentAuditEnabled={board.currentWorkingTraceAttribution
                    .independentAuditDisplayEnabled}
                  onIndependentAuditToggle={board.currentWorkingTraceAttribution
                    .toggleIndependentAudit}
                  engineeringToolboxHidden={board.currentWorkingTraceAttribution
                    .independentAuditDisplayEnabled}
                  showChatModes={board.props.chatMode}
                  settings={board.loadOlderMessages.settings}
                  onSettingsChange={board.contextUsage.updateSettings}
                  onAccountSelected={board.currentWorkingTraceAttribution.rememberSelectedAccount}
                  providers={board.currentWorkingTraceAttribution.providers}
                  harnessId={board.loadOlderMessages.settings.harnessId}
                  actions={activeActions}
                  onActionSelect={board.switchProject.handleActionSelection}
                  onSlashCommand={board.switchProject.executeHarnessCommand}
                  usageCreditsCommandId={board.unmirroredTraceStartTime.usageCreditsCommand?.id}
                  contextUsage={board.currentWorkingTraceAttribution.composerUsage}
                  generationRate={board.switchProject.composerGenerationRate}
                  generationDetails={board.switchProject.composerGenerationDetails}
                  efficiencyKpis={board.studioTemporaryChatContext.storedEfficiencyKpis}
                  onRevealUsage={board.contextUsage.revealContextUsage}
                  onHideUsage={board.unmirroredTraceStartTime.hideContextUsage}
                  usageRefreshing={board.contextUsage.accountUsageCache.refreshing}
                  harnessUsage={board.harnessUsage.harnessUsage}
                  canCompact={supportsManualCompaction(
                    board.loadOlderMessages.settings.harnessId,
                    providerStore.providers
                  ) && !board.switchProject.busy}
                  compacting={board.switchProject.compacting}
                  onCompact={() => void board.switchProject.compactWork()}
                  onActivateBankedReset={() => {
                    board.state.showBankedResetConfirm = true
                  }}
                  projectId={board.handleAgentEvent.thread.projectId}
                  threadId={board.handleAgentEvent.thread.id}
                  shoe={composerShoe}
                  stackedAbove={board.unmirroredTraceStartTime.composerStackedAbove}
                  attachmentStorage={{
                    kind: board.props.chatMode ? 'chat' : 'project',
                    projectId: board.handleAgentEvent.thread.projectId,
                    threadId: board.handleAgentEvent.thread.id
                  }}
                  fileTagProjectId={board.contextUsage.project?.source === 'local' &&
                  board.contextUsage.project.path
                    ? board.handleAgentEvent.thread.projectId
                    : undefined}
                  assignmentId={board.submitSpecDecision.assignment?.id}
                  assignmentTasks={board.submitSpecDecision.assignment?.content.tasks ?? []}
                  assistantTags={board.studioTemporaryChatContext.assistantTagCandidates}
                  onOpenAssistantTag={(tag) =>
                    board.state.openAssistantTag(`${tag.kind}:${tag.id}`)}
                  initialValue={rendererRecovery.draftFor(
                    board.handleAgentEvent.thread.projectId,
                    board.handleAgentEvent.thread.id
                  )}
                  initialAttachments={rendererRecovery.attachmentsFor(
                    board.handleAgentEvent.thread.projectId,
                    board.handleAgentEvent.thread.id
                  )}
                  initialProjectReferences={rendererRecovery.projectReferencesFor(
                    board.handleAgentEvent.thread.projectId,
                    board.handleAgentEvent.thread.id
                  )}
                  initialTaskReferences={rendererRecovery.taskReferencesFor(
                    board.handleAgentEvent.thread.projectId,
                    board.handleAgentEvent.thread.id
                  )}
                  initialStartAfterThreads={rendererRecovery.startAfterThreadsFor(
                    board.handleAgentEvent.thread.projectId,
                    board.handleAgentEvent.thread.id
                  )}
                  initialThreadReferences={rendererRecovery.threadReferencesFor(
                    board.handleAgentEvent.thread.projectId,
                    board.handleAgentEvent.thread.id
                  )}
                  onValueChange={(value) => {
                    rendererRecovery.setDraft(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      value
                    )
                    publishDraftActivity(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      rendererRecovery.hasDraftContent(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      )
                    )
                  }}
                  onAttachmentsChange={(files) => {
                    rendererRecovery.setDraft(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      rendererRecovery.draftFor(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      ),
                      files
                    )
                    publishDraftActivity(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      rendererRecovery.hasDraftContent(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      )
                    )
                  }}
                  onProjectReferencesChange={(projectReferences) => {
                    rendererRecovery.setDraft(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      rendererRecovery.draftFor(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      ),
                      rendererRecovery.attachmentsFor(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      ),
                      projectReferences
                    )
                    publishDraftActivity(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      rendererRecovery.hasDraftContent(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      )
                    )
                  }}
                  onTaskReferencesChange={(taskReferences) => {
                    rendererRecovery.setDraft(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      rendererRecovery.draftFor(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      ),
                      rendererRecovery.attachmentsFor(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      ),
                      rendererRecovery.projectReferencesFor(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      ),
                      taskReferences
                    )
                    publishDraftActivity(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      rendererRecovery.hasDraftContent(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      )
                    )
                  }}
                  onStartAfterThreadsChange={(startAfterThreads) => {
                    rendererRecovery.setStartAfterThreads(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      startAfterThreads
                    )
                    publishDraftActivity(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      rendererRecovery.hasDraftContent(
                        board.handleAgentEvent.thread.projectId,
                        board.handleAgentEvent.thread.id
                      )
                    )
                  }}
                  onOpenStartAfterThread={(threadId) =>
                    void board.unmirroredTraceStartTime.openStartAfterThread(threadId)}
                  onThreadReferencesChange={(threadReferences) => {
                    rendererRecovery.setThreadReferences(
                      board.handleAgentEvent.thread.projectId,
                      board.handleAgentEvent.thread.id,
                      threadReferences
                    )
                  }}
                  onRelocateItem={board.composerScope.relocationAvailable
                    ? board.composerScope.requestComposerRelocation
                    : undefined}
                  references={board.unmirroredTraceStartTime.composerReferences}
                  onRemoveReference={board.steerQueuedMessage.removeComposerReference}
                  onRemoveAllReferences={board.steerQueuedMessage.clearComposerReferences}
                  onEditReference={board.steerQueuedMessage.editResponseReference}
                  onSend={board.harnessUsage.sendComposerMessage}
                  onNeedsAiAccount={() =>
                    (board.unmirroredTraceStartTime.aiAccountPromptOpen = true)}
                  historyMessages={board.editVideoNote.composerHistoryTexts}
                  onHistoryNavigateStart={() =>
                    void board.editVideoNote.refreshUserMessageHistory()}
                  hidePermissionSelector={board.props.chatMode}
                  favoriteModels={rendererRecovery.modelFavoritesFor(board.sources.modelScope())}
                  onToggleFavorite={(providerId, modelId, harnessId) =>
                    rendererRecovery.toggleModelFavoriteFor(
                      board.sources.modelScope(),
                      modelKey(harnessId, providerId, modelId)
                    )}
                  onReorderFavorite={(draggedKey, targetKey, position) =>
                    rendererRecovery.reorderModelFavoriteFor(
                      board.sources.modelScope(),
                      draggedKey,
                      targetKey,
                      position
                    )}
                  recentModels={rendererRecovery.modelRecentsFor(board.sources.modelScope())}
                  onRemoveRecent={(key) =>
                    rendererRecovery.removeModelRecentFor(board.sources.modelScope(), key)}
                  onModelUsed={(modelKey) =>
                    rendererRecovery.addModelRecentFor(board.sources.modelScope(), modelKey)}
                  imageDescriptorDefault={board.sources.agentDefaults.imageDescriptor}
                  imageDescriptorAskAgain={board.unmirroredTraceStartTime.imageDescriptorAskAgain}
                  onImageDescriptorDefaultChange={board.sources.setImageDescriptorDefault}
                  onImageDescriptorAskAgainChange={board.unmirroredTraceStartTime
                    .setImageDescriptorAskAgain}
                />
                {#if board.composerScope.centeredComposer && !board.props.assistantMode}
                  <div class="mt-4 flex flex-wrap items-center justify-center gap-2">
                    {#each board.projectSuggestedPrompts.suggestedPrompts as prompt (prompt)}
                      <button
                        type="button"
                        class="border border-border bg-surface px-3.5 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                        onclick={() => board.state.composer?.setComposerText(prompt)}
                      >
                        {prompt}
                      </button>
                    {/each}
                  </div>
                {/if}
              {/key}
            {/if}
          {/if}
        {/if}
      </div>
    </div>
  </div>
</div>
