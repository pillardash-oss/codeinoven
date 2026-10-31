<script lang="ts">
  import { isMacPlatform } from '$lib/shortcut-display'
  import CioArrowUp from '@pdslng/cio-icon/CioArrowUp.svelte'
  import CioClock from '@pdslng/cio-icon/CioClock.svelte'
  import CioCompactSend from '@pdslng/cio-icon/CioCompactSend.svelte'
  import CioFlame from '@pdslng/cio-icon/CioFlame.svelte'
  import CioMaximize from '@pdslng/cio-icon/CioMaximize.svelte'
  import CioMinimize from '@pdslng/cio-icon/CioMinimize.svelte'
  import CioStop from '@pdslng/cio-icon/CioStop.svelte'
  import { ICON_SIZE } from '$lib/components/icons/cio/scale'
  import { scale } from 'svelte/transition'
  import { motionDuration } from '$lib/motion'
  import { DEFAULT_HARNESS } from '$shared/harness-default'
  import AttachmentPreview from './AttachmentPreview.svelte'
  import StartAfterThreadPicker from './StartAfterThreadPicker.svelte'
  import ProjectFileMentionMenu from './ProjectFileMentionMenu.svelte'
  import ChatComposerAttachmentStrip from './ChatComposerAttachmentStrip.svelte'
  import ChatComposerDropZone from './ChatComposerDropZone.svelte'
  import ChatComposerImageGate from './ChatComposerImageGate.svelte'
  import ExpertCard from './ExpertCard.svelte'
  import ChatComposerPermissionPicker from './ChatComposerPermissionPicker.svelte'
  import ChatComposerPlusMenu from './ChatComposerPlusMenu.svelte'
  import { isEditablePastedTextAttachment } from './chat-composer-attachments'
  import { composerAssistantTagToken } from './composer-mentions'
  import SlashActionMenu from '../actions/SlashActionMenu.svelte'
  import RichMarkdownEditor from '../shared/RichMarkdownEditor.svelte'
  import CardNotice from '../shared/CardNotice.svelte'
  import VoiceInputButton from '../speech/VoiceInputButton.svelte'
  import EngineeringToolbox from './EngineeringToolbox.svelte'
  import ModelPicker from '../shared/ModelPicker.svelte'
  import ComposerShoe from './ComposerShoe.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import { createChatComposer } from './ChatComposer/ChatComposer-board.svelte'
  import type { Props } from './ChatComposer/ChatComposer-types'

  let {
    onSend,
    disabled = false,
    working = false,
    stackedAbove = false,
    onStop,
    placeholder = 'Send a message...',
    autofocus = false,
    settings,
    onSettingsChange,
    onAccountSelected,
    actions = [],
    onActionSelect,
    onSlashCommand,
    usageCreditsCommandId,
    providers = [],
    harnessId = DEFAULT_HARNESS,
    projectId = null,
    threadId = '',
    attachmentStorage,
    fileTagProjectId,
    assignmentId,
    assignmentTasks = [],
    assistantTags = [],
    onOpenAssistantTag,
    initialValue = '',
    onValueChange,
    initialAttachments = [],
    onAttachmentsChange,
    initialProjectReferences = [],
    onProjectReferencesChange,
    initialTaskReferences = [],
    onTaskReferencesChange,
    initialStartAfterThreads = [],
    onStartAfterThreadsChange,
    onOpenStartAfterThread,
    initialThreadReferences = [],
    onThreadReferencesChange,
    references = [],
    onRemoveReference,
    onRemoveAllReferences,
    onEditReference,
    onRelocateItem,
    showEngineeringMode = true,
    engineeringLifecycle = null,
    engineeringActive,
    onEngineeringLifecycleSelect,
    showChatModes = false,
    independentAuditAvailable = false,
    independentAuditEnabled = false,
    onIndependentAuditToggle,
    engineeringToolboxHidden = false,
    hidePermissionSelector = false,
    readOnlyMode = false,
    allowAttachments = false,
    favoriteModels = [],
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite,
    recentModels = [],
    onModelUsed,
    contextUsage,
    generationRate,
    generationDetails,
    efficiencyKpis,
    harnessUsage = [],
    onRevealUsage,
    onHideUsage,
    usageRefreshing = false,
    canCompact = false,
    compacting = false,
    onCompact,
    onActivateBankedReset,
    historyMessages = [],
    onHistoryNavigateStart,
    imageDescriptorDefault,
    imageDescriptorAskAgain = false,
    onImageDescriptorDefaultChange,
    onImageDescriptorAskAgainChange,
    enableImageDescriptorGate = true,
    shoe,
    onNeedsAiAccount
  }: Props = $props()
  const board = createChatComposer(() => ({
    onSend,
    disabled,
    working,
    stackedAbove,
    onStop,
    placeholder,
    autofocus,
    settings,
    onSettingsChange,
    onAccountSelected,
    actions,
    onActionSelect,
    onSlashCommand,
    usageCreditsCommandId,
    providers,
    harnessId,
    projectId,
    threadId,
    attachmentStorage,
    fileTagProjectId,
    assignmentId,
    assignmentTasks,
    assistantTags,
    onOpenAssistantTag,
    initialValue,
    onValueChange,
    initialAttachments,
    onAttachmentsChange,
    initialProjectReferences,
    onProjectReferencesChange,
    initialTaskReferences,
    onTaskReferencesChange,
    initialStartAfterThreads,
    onStartAfterThreadsChange,
    onOpenStartAfterThread,
    initialThreadReferences,
    onThreadReferencesChange,
    references,
    onRemoveReference,
    onRemoveAllReferences,
    onEditReference,
    onRelocateItem,
    showEngineeringMode,
    engineeringLifecycle,
    engineeringActive,
    onEngineeringLifecycleSelect,
    showChatModes,
    independentAuditAvailable,
    independentAuditEnabled,
    onIndependentAuditToggle,
    engineeringToolboxHidden,
    hidePermissionSelector,
    readOnlyMode,
    allowAttachments,
    favoriteModels,
    onToggleFavorite,
    onRemoveRecent,
    onReorderFavorite,
    recentModels,
    onModelUsed,
    contextUsage,
    generationRate,
    generationDetails,
    efficiencyKpis,
    harnessUsage,
    onRevealUsage,
    onHideUsage,
    usageRefreshing,
    canCompact,
    compacting,
    onCompact,
    onActivateBankedReset,
    historyMessages,
    onHistoryNavigateStart,
    imageDescriptorDefault,
    imageDescriptorAskAgain,
    onImageDescriptorDefaultChange,
    onImageDescriptorAskAgainChange,
    enableImageDescriptorGate,
    shoe,
    onNeedsAiAccount
  }))
  /**
   * The surface's published API, kept on the component and answered by its unit.
   */
  export function focusComposerAtEnd(): void {
    return board.captureComposerRoot.focusComposerAtEnd()
  }

  /**
   * The surface's published API, kept on the component and answered by its unit.
   */
  export function setComposerText(text: string): void {
    return board.captureComposerRoot.setComposerText(text)
  }

  /**
   * The surface's published API, kept on the component and answered by its unit.
   */
  export function focusComposerAtStart(): void {
    return board.captureComposerRoot.focusComposerAtStart()
  }

  /**
   * The surface's published API, kept on the component and answered by its unit.
   */
  export function focusComposerAtSavedCaret(): void {
    return board.submit.focusComposerAtSavedCaret()
  }
</script>

<svelte:window onkeydown={board.captureComposerRoot.onWindowKeydown} />

{#if board.handleDropData.preview.file}
  {@const previewAttachment = board.handleDropData.preview.file}
  <AttachmentPreview
    attachment={previewAttachment}
    src={board.handleDropData.preview.urls[previewAttachment.url]}
    text={board.handleDropData.preview.texts[previewAttachment.url]}
    documentHtml={board.handleDropData.preview.documents[previewAttachment.url]}
    documentLoading={board.handleDropData.preview.documentLoading[previewAttachment.url] ?? false}
    onSaveText={isEditablePastedTextAttachment(previewAttachment)
      ? board.handleDropData.savePreviewText
      : undefined}
    pager={board.handleDropData.previewPager}
    onClose={() => {
      board.handleDropData.preview.close()
      board.submit.focusComposerAtSavedCaret()
    }}
  />
{/if}

<ChatComposerDropZone
  region={board.clearDropState.isDragging ? board.clearDropState.dropRegion : null}
  onAnchorChange={board.handleDropAnchorChange.handleDropAnchorChange}
  onDropData={board.handleDropData.handleDropData}
  onClearDropState={board.clearDropState.clearDropState}
/>

<!-- The composer owns a stacking context at z-40, one rung above everything the
     transcript paints (its board.props.working trace header pins at z-20) and above the
     scroll-to-latest button (z-30). Its own overlays all live inside this context
     at z-30/z-40, so they were previously capped at the composer's old z-10 and
     the pinned trace header painted straight through the board.handleDropData.slash and reference
     menus when they opened upward into the transcript. Keeping the composer
     below the app's menu and modal rungs (z-50/z-60) is what keeps those
     overlays from escaping over unrelated panels. -->
<div
  class="chat-composer relative z-40 border bg-surface {board.props.stackedAbove
    ? 'border-t border-dashed border-border-strong'
    : ''} {board.captureComposerRoot.expansion.maximized ? 'composer-maximized' : ''}"
  data-onboarding="composer"
  data-guide="composer"
  data-voice-trigger-root
  {@attach board.captureComposerRoot.captureComposerRoot}
>
  <!-- The composer has no bar above its writing surface: the editor is the top
       edge, so a card the composer grows under it reads as the message box
       extended rather than as something with a strip beneath it. What the
       composer is pointed at lives in the board.props.shoe below (see `.composer-board.props.shoe`). -->
  {#if board.handleDropData.imageDescriptorGateOpen}
    <ChatComposerImageGate
      providers={board.props.providers}
      projectId={board.props.projectId}
      harnessId={board.handleDropData.resolved.harnessId}
      bind:visionSelection={board.handleDropData.gateVisionSelection}
      bind:donotAsk={board.handleDropData.gateDonotAsk}
      favoriteModels={board.props.favoriteModels}
      recentModels={board.props.recentModels}
      onRemoveRecent={board.props.onRemoveRecent}
      onToggleFavorite={board.props.onToggleFavorite}
      onReorderFavorite={board.props.onReorderFavorite}
      onCancel={board.captureComposerRoot.cancelImageDescriptorGate}
      onConfirm={board.handleDropData.confirmImageDescriptorGate}
    />
  {/if}

  {#if board.captureComposerRoot.expertGateOpen && board.captureComposerRoot.expertGateState}
    <ExpertCard
      expertState={board.captureComposerRoot.expertGateState}
      session={board.captureComposerRoot.expertGateSession}
      modelLabel={board.handleDropData.expertModelLabel}
      warming={board.captureComposerRoot.expertWarming}
      onUse={() => void board.captureComposerRoot.decideExperts('all', false)}
      onDisable={() => void board.captureComposerRoot.decideExperts('off', false)}
      onNeverAsk={() => void board.captureComposerRoot.decideExperts('off', true)}
      onOpenSettings={() => workspaceState.navigateToSettings?.('design')}
    />
  {/if}

  {#if board.handleDropData.ovenModelNotice}
    <CardNotice placement="composer" tone="warn">
      {board.handleDropData.ovenModelNotice}
    </CardNotice>
  {/if}

  {#if board.handleDropData.selectedHarnessLacksAttachments && (board.handleDropData.attachmentBlockedNotice || board.submit.attachments.length > 0)}
    <CardNotice placement="composer" tone="danger">
      This model cannot accept file board.submit.attachments. Choose another model before sending
      this file.
    </CardNotice>
  {/if}

  {#if board.captureComposerRoot.textAttachmentError}
    <CardNotice placement="composer" tone="danger">
      {board.captureComposerRoot.textAttachmentError}
    </CardNotice>
  {/if}

  <ChatComposerAttachmentStrip
    attachments={board.submit.attachments}
    references={board.props.references}
    startAfterThreads={board.handleDropData.startAfterThreads}
    threadReferences={board.handleDropData.threadReferences}
    showChatModes={board.props.showChatModes}
    fileSystemMode={board.handleDropData.resolved.fileSystemMode}
    previewUrls={board.handleDropData.preview.urls}
    onPreviewAttachment={board.handleDropData.preview.open}
    onRemoveAttachment={board.submit.removeAttachment}
    onToggleFileSystemMode={board.handleDropData.toggleFileSystemMode}
    startAfterPopoverOpen={board.captureComposerRoot.startAfterPopoverOpen}
    onOpenStartAfterPopover={board.captureComposerRoot.openStartAfterPopover}
    onScheduleStartAfterPopoverClose={board.captureComposerRoot.scheduleStartAfterPopoverClose}
    onCloseStartAfterPopover={board.captureComposerRoot.closeStartAfterPopover}
    onClearStartAfterThreads={board.captureComposerRoot.clearStartAfterThreads}
    onOpenStartAfterThread={board.props.onOpenStartAfterThread}
    onRemoveStartAfterThread={board.handleDropData.removeStartAfterThread}
    onRemoveThreadContext={board.handleDropData.removeThreadContext}
    selectionPopoverOpen={board.captureComposerRoot.selectionPopoverOpen}
    onOpenSelectionPopover={board.captureComposerRoot.openSelectionPopover}
    onScheduleSelectionPopoverClose={board.captureComposerRoot.scheduleSelectionPopoverClose}
    onToggleSelectionPopover={board.captureComposerRoot.toggleSelectionPopover}
    onCloseSelectionPopover={board.captureComposerRoot.closeSelectionPopover}
    onEditReference={board.props.onEditReference}
    onRemoveReference={board.props.onRemoveReference}
    onRemoveAllReferences={board.props.onRemoveAllReferences}
    onRelocateItem={board.props.onRelocateItem}
    onReferenceMenuOpenChange={board.captureComposerRoot.handleReferenceMenuOpenChange}
  />

  <div
    class="relative"
    style="--editor-gutter: 2.25rem"
    {@attach board.captureComposerRoot.observeEditorLines}
  >
    {#if board.submit.slashOpen}
      <SlashActionMenu
        actions={board.handleDropData.slash.available}
        query={board.submit.slashQuery}
        activeIndex={board.submit.slashIndex}
        onSelect={(action) => board.submit.selectSlashAction(action, 'pointer')}
      />
    {/if}
    {#if board.submit.mentions.open}
      <ProjectFileMentionMenu
        entries={board.submit.mentions.entries}
        activeIndex={board.submit.mentions.index}
        query={board.submit.mentions.query}
        onSelect={board.submit.selectMention}
        onFilterChange={() => {
          if (board.submit.lastCaretText !== null)
            void board.submit.mentions.update(board.submit.lastCaretText)
        }}
      />
    {/if}
    <!-- Maximize   sits in the gutter beneath the console prompt, so it never
         eats into the writing surface and the editor's lines can run all the way
         to the composer's right edge. It appears on the third rendered line and
         stays available while expanded. -->
    {#if board.captureComposerRoot.showExpandControl}
      <button
        type="button"
        class="absolute top-9 left-2 z-20 flex h-6 w-6 items-center justify-center text-dimmed transition-colors hover:bg-elevated hover:text-foreground"
        transition:scale={{ duration: motionDuration(150), start: 0.85 }}
        aria-label={board.captureComposerRoot.expansion.maximized
          ? 'Collapse the composer'
          : 'Expand the composer'}
        aria-pressed={board.captureComposerRoot.expansion.maximized}
        title={board.captureComposerRoot.expansion.maximized
          ? 'Collapse the composer to its normal size'
          : 'Expand the composer for a taller, wider typing area'}
        onclick={board.captureComposerRoot.toggleComposerExpansion}
      >
        <span class="control-glyphs" aria-hidden="true">
          <span
            class="control-glyph"
            class:is-active={board.captureComposerRoot.expansion.maximized}
          >
            <CioMinimize size={ICON_SIZE.control} />
          </span>
          <span
            class="control-glyph"
            class:is-active={!board.captureComposerRoot.expansion.maximized}
          >
            <CioMaximize size={ICON_SIZE.control} />
          </span>
        </span>
      </button>
    {/if}

    <!-- The console prompt: the marker the writing line hangs off, in the gold
         this workstation keeps for the few places that earn it. It inks up and
         steps forward while the field has focus, and it is never selectable. -->
    <span class="composer-prompt" aria-hidden="true">&gt;</span>
    <RichMarkdownEditor
      bind:this={board.submit.richEditor}
      id={board.submit.composerEditorId}
      class="composer-editor w-full overflow-y-auto pt-3 pr-4 pb-1 pl-9 text-sm leading-5 text-foreground outline-none"
      bind:value={board.submit.value}
      placeholder={board.props.placeholder}
      autofocus={board.props.autofocus}
      disabled={board.props.disabled}
      ariaLabel="Message"
      onValueChange={board.submit.handleComposerValueChange}
      onSubmit={board.submit.submit}
      onPaste={board.captureComposerRoot.handlePaste}
      inlineBadges={board.submit.projectReferenceBadges}
      onInlineBadgeActivate={(_value) => {
        // Only an assistant tag opens something on click; a file or task badge
        // stays the inert reference it has always been, and the click falls
        // through to the caret. A thread from another project has no opener
        // here, so its badge is as inert as a file's.
        const tag = board.captureComposerRoot.composerTags.find(
          (entry) => composerAssistantTagToken(entry) === board.submit.value
        )
        if (!tag || !board.props.assistantTags.includes(tag)) return false
        board.props.onOpenAssistantTag?.(tag)
        return true
      }}
      onCaretTextChange={board.submit.handleCaretTextChange}
    />
  </div>

  <!-- Bottom bar: + menu · model · thinking ··· send -->
  <div
    class="composer-toolbar flex min-w-0 items-center gap-1 border-t border-dashed border-border-strong px-3 pb-2 pt-1.5"
  >
    <ChatComposerPlusMenu
      open={board.handleDropData.plusMenuOpen}
      onToggle={() => {
        board.handleDropData.plusMenuOpen = !board.handleDropData.plusMenuOpen
        board.handleDropData.modelMenuOpen = false
        board.handleDropData.thinkingMenuOpen = false
      }}
      onClose={() => (board.handleDropData.plusMenuOpen = false)}
      showChatModes={board.props.showChatModes}
      fileSystemMode={board.handleDropData.resolved.fileSystemMode}
      onToggleFileSystemMode={board.handleDropData.toggleFileSystemMode}
      independentAuditAvailable={board.props.independentAuditAvailable}
      independentAuditEnabled={board.props.independentAuditEnabled}
      projectId={board.props.projectId}
      readOnlyMode={board.props.readOnlyMode}
      onToggleIndependentAudit={(enabled) =>
        void board.handleDropData.toggleIndependentAudit(enabled)}
      showEngineeringMode={board.props.showEngineeringMode}
      startAfterEnabled={board.handleDropData.startAfterEnabled}
      startAfterThreads={board.handleDropData.startAfterThreads}
      onToggleStartAfter={board.handleDropData.toggleStartAfter}
      onRemoveStartAfterThread={board.handleDropData.removeStartAfterThread}
      onOpenStartAfterPicker={board.handleDropData.openStartAfterPicker}
      allowAttachments={board.props.allowAttachments}
      selectedHarnessLacksAttachments={board.handleDropData.selectedHarnessLacksAttachments}
      onPickAttachment={() => {
        board.handleDropData.plusMenuOpen = false
        void board.handleDropData.pickAttachment()
      }}
    />

    {#if board.props.showEngineeringMode && board.props.onEngineeringLifecycleSelect && !board.props.engineeringToolboxHidden}
      <EngineeringToolbox
        bind:this={board.captureComposerRoot.engineeringToolbox}
        lifecycleState={board.props.engineeringLifecycle}
        active={board.props.engineeringActive === true}
        disabled={board.props.readOnlyMode}
        onselect={board.props.onEngineeringLifecycleSelect}
        onclose={() => {
          if (board.submit.richEditor?.caretBookmark()) board.submit.focusComposerAtSavedCaret()
          else board.captureComposerRoot.focusComposerAtStart()
        }}
      />
    {/if}

    <div
      class={`flex min-w-0 shrink items-center ${
        board.props.readOnlyMode ||
        !board.props.hidePermissionSelector ||
        board.handleDropData.resolved.fileSystemMode === true
          ? 'gap-3'
          : ''
      }`}
    >
      <ChatComposerPermissionPicker
        readOnlyMode={board.props.readOnlyMode}
        hidePermissionSelector={board.props.hidePermissionSelector}
        fileSystemMode={board.handleDropData.resolved.fileSystemMode}
        permissionLevel={board.handleDropData.resolved.permissionLevel}
        working={board.props.working}
        menuOpen={board.handleDropData.permissionMenuOpen}
        onToggle={() => {
          board.handleDropData.permissionMenuOpen = !board.handleDropData.permissionMenuOpen
          board.handleDropData.plusMenuOpen = false
          board.handleDropData.modelMenuOpen = false
          board.handleDropData.thinkingMenuOpen = false
        }}
        onClose={board.handleDropData.closeAllMenus}
        onSelect={board.handleDropData.selectPermission}
      />

      <!-- Shared model selector   model + thinking level in one control, and the
           saved profiles every other picker offers too. -->
      <ModelPicker
        bind:this={board.handleDropData.modelPicker}
        providers={board.props.providers}
        projectId={board.props.projectId}
        harnessId={board.props.harnessId}
        unavailableHarnessIds={board.handleDropData.unavailableHarnessIds}
        unavailableHarnessReason={board.handleDropData.unavailableHarnessReason}
        providerId={board.handleDropData.ovenModelUnavailable
          ? ''
          : board.handleDropData.resolved.providerId}
        modelId={board.handleDropData.ovenModelUnavailable
          ? ''
          : board.handleDropData.resolved.modelId}
        label={board.handleDropData.ovenModelUnavailable
          ? 'Choose a model for this Oven'
          : undefined}
        accountId={board.handleDropData.resolved.accountId}
        favoriteModels={board.props.favoriteModels}
        recentModels={board.props.recentModels}
        onRemoveRecent={board.props.onRemoveRecent}
        bind:open={board.handleDropData.modelMenuOpen}
        bind:thinkingMenuOpen={board.handleDropData.thinkingMenuOpen}
        bind:accountMenuOpen={board.handleDropData.accountMenuOpen}
        onAccountPickerVisibleChange={(visible) => {
          board.handleDropData.accountPickerVisible = visible
        }}
        onSelect={board.handleDropData.selectModel}
        onSelectAccount={board.props.onAccountSelected}
        onToggleFavorite={board.props.onToggleFavorite}
        onReorderFavorite={board.props.onReorderFavorite}
        runtimeSettings={board.handleDropData.resolved}
        bind:runtimeMenuOpen={board.handleDropData.inferenceMenuOpen}
        onSelectRuntime={(runtime) =>
          board.handleDropData.applySettings({ ...board.handleDropData.resolved, ...runtime })}
        thinkingLevel={board.handleDropData.resolved.thinkingLevel}
        thinkingPresets={board.handleDropData.thinkingPresets}
        onSelectThinking={(level) =>
          board.handleDropData.selectThinking({ id: level, label: level })}
        permissionLevel={board.handleDropData.resolved.permissionLevel}
        onApplyProfile={board.handleDropData.applyProfile}
        showProfiles={!board.props.readOnlyMode}
      />
    </div>

    <!-- API usage credits   native harness command to bill this session's
         turns against pay-as-you-go API credits instead of a subscription. -->
    {#if board.props.usageCreditsCommandId}
      <button
        type="button"
        class="flex h-8 w-8 items-center justify-center text-muted transition-colors hover:bg-elevated hover:text-foreground"
        aria-label="Switch to API usage credits"
        title="Switch this session to pay-as-you-go API usage credits"
        onclick={board.state.runUsageCredits}
      >
        <CioFlame size={ICON_SIZE.control} />
      </button>
    {/if}

    <span class="flex-1"></span>

    <!-- Keep the mic mounted in one stable slot so recording state never resets
         when the composer gains text and the send control appears. -->
    <VoiceInputButton
      targetId={board.submit.composerEditorId}
      getTarget={board.submit.composerSpeechTarget}
      scope={board.state.speechScope}
      disabled={board.props.disabled}
    />

    <!-- Send / Queue / Stop button. It never unmounts: it widens out of the row
         and fades when the composer has nothing to send or stop, and widens back
         when it does, so the mic beside it slides instead of the row snapping.
         Its glyphs share one box, so a send morphs into the stop square.
           - Agent idle:       ArrowUp (send)   primary, board.props.disabled when empty
           - Agent board.props.working, user typing:  AlarmClock (queue)   primary, always clickable
           - Agent board.props.working, no text:      Square (stop)   quiet at rest, danger tint on hover
           - Stop confirmation pending:   "Stop?" danger label -->
    <button
      type="button"
      class="composer-send-control relative flex h-8 shrink-0 items-center justify-center {board
        .submit.pendingStop
        ? 'bg-danger text-on-danger hover:bg-danger-hover'
        : board.captureComposerRoot.canStop
          ? 'text-muted hover:bg-danger/10 hover:text-danger'
          : 'bg-accent text-on-accent hover:bg-accent-hover'}"
      class:is-present={board.captureComposerRoot.showSendControl}
      class:is-armed={board.submit.pendingStop}
      inert={!board.captureComposerRoot.showSendControl || undefined}
      aria-label={board.submit.pendingStop
        ? 'Confirm stop'
        : board.captureComposerRoot.canStop
          ? 'Stop agent'
          : board.props.working
            ? 'Queue message'
            : board.handleDropData.compactBeforeSend
              ? 'Compact context and send message'
              : 'Send message'}
      title={board.submit.pendingStop
        ? 'Click again to stop'
        : board.captureComposerRoot.canStop
          ? 'Stop the running agent'
          : board.props.working
            ? `Queue   ${board.state.sendModifierLabel}Enter · Steer   ${isMacPlatform() ? '⌘⇧' : 'Ctrl+Shift+'}Enter`
            : board.handleDropData.compactBeforeSend
              ? `Compact context, then send   ${board.state.sendModifierLabel}Enter`
              : `Send   ${board.state.sendModifierLabel}Enter`}
      disabled={board.props.disabled ||
        (board.captureComposerRoot.canStop ? false : board.handleDropData.ovenModelUnavailable) ||
        (!board.props.working && !board.captureComposerRoot.hasSendableContent)}
      onclick={() => board.submit.submit()}
    >
      <span class="control-glyphs" aria-hidden="true">
        <span
          class="control-glyph"
          class:is-active={board.captureComposerRoot.sendControlGlyph === 'stop'}
        >
          <CioStop size={ICON_SIZE.control} />
        </span>
        <span
          class="control-glyph"
          class:is-active={board.captureComposerRoot.sendControlGlyph === 'queue'}
        >
          <CioClock size={ICON_SIZE.control} />
        </span>
        <span
          class="control-glyph"
          class:is-active={board.captureComposerRoot.sendControlGlyph === 'send'}
        >
          {#if board.handleDropData.compactBeforeSend}
            <CioCompactSend size={ICON_SIZE.control} />
          {:else}
            <CioArrowUp size={ICON_SIZE.control} />
          {/if}
        </span>
      </span>
      <span
        class="pending-stop-label text-[0.5625rem] font-semibold"
        class:is-active={board.submit.pendingStop}
      >
        Stop?
      </span>
    </button>
  </div>
</div>

<!-- The composer board.props.shoe: the one bar the composer owns, floating just underneath
     it, sized to the row it holds and centered under the composer. It slides up
     behind the composer (z below it) so its top edge is tucked under the
     composer's bottom border   only the lower half shows, like a board.props.shoe. It is
     rendered by every composer, in every mode: the properties of whatever is
     being written into are never a project-mode extra.
     No z-index on the wrapper: the composer (z-40) paints over the card, and the
     board.props.shoe's dropdown (z-40 inside the composer's own stacking context) opens above
     the composer and above the transcript's pinned trace header.
     The wrapper is the board.props.shoe's own inline-size query container: the composer
     cannot query a sibling, and the card must stay free of containment so it
     can size itself to its content. -->
{#if board.props.shoe}
  <div
    class="composer-board.props.shoe relative -mt-4 flex w-full justify-center px-4 pt-3 pb-2 @container"
  >
    <!-- The card frame is the console board.props.shoe: one surface, tucked behind the
         composer so only its lower band shows. Its top padding is what holds the
         segments clear of the composer's lower edge. -->
    <div
      class="composer-board.props.shoe-card flex min-w-0 items-center justify-center border border-border bg-surface px-0.5 pt-1.5 pb-1"
    >
      <ComposerShoe
        bind:this={board.captureComposerRoot.shoeComponent}
        shoe={board.props.shoe}
        usage={board.handleDropData.usageReading}
        onScopeMenuClosed={board.submit.focusComposerAtSavedCaret}
      />
    </div>
  </div>
{/if}

<StartAfterThreadPicker
  open={board.handleDropData.startAfterPickerOpen}
  projectId={board.props.projectId}
  currentThreadId={board.props.threadId}
  selectedIds={board.handleDropData.startAfterThreads.map((t) => t.id)}
  onSelect={board.handleDropData.selectStartAfterThread}
  onClose={() => {
    board.handleDropData.startAfterPickerOpen = false
    if (board.handleDropData.startAfterThreads.length === 0)
      board.handleDropData.startAfterEnabled = false
    board.submit.focusComposerAtSavedCaret()
  }}
/>

<style>
  .chat-composer {
    container-type: inline-size;
    /* `width: 100%` is what lets the maximize transition run: an `auto` width
       cannot interpolate to the measured pixel width, so the box would snap
       wider while its margins were still animating. */
    width: 100%;
    transition:
      width 240ms ease,
      margin-inline 240ms ease,
      border-color 220ms ease,
      box-shadow 420ms ease;
  }

  /* At rest the composer is a bordered field; focus inks the border and lifts it
     a hair, so the surface being written on is what the eye lands on. */
  .chat-composer:focus-within {
    border-color: var(--color-border-strong);
    box-shadow: 0 0.5rem 1.5rem -0.75rem rgb(0 0 0 / 0.18);
  }

  /* The prompt marker sits in the editor's gutter, on the writing line, and
     steps forward as focus arrives. It is decorative: the marker is
     aria-hidden and the gutter is why the board.props.placeholder is inset too. */
  .composer-prompt {
    position: absolute;
    top: 0.75rem;
    left: 0.875rem;
    font-weight: 700;
    line-height: 1.25rem;
    color: var(--color-accent-hover);
    opacity: 0.55;
    pointer-events: none;
    transition:
      opacity 220ms ease,
      transform 220ms ease;
  }

  .chat-composer:focus-within .composer-prompt {
    opacity: 1;
    transform: translateX(0.125rem);
  }

  /* The board.props.shoe card carries the console shadow: a soft, short drop that separates
     the bar from the canvas without turning it into a floating panel. */
  .composer-board.props.shoe-card {
    box-shadow: 0 0.5rem 1.25rem -0.875rem rgb(0 0 0 / 0.4);
  }

  /* Maximize   the editor is the composer's typing surface, so the control is
     what grows: the collapsed height cap becomes the expanded floor (the box is
     immediately large) and the cap triples. The 60vh clamp keeps a visible
     conversation on short windows. */
  :global(.composer-editor) {
    min-height: 2.5rem;
    max-height: 10rem;
    transition:
      min-height 240ms ease,
      max-height 240ms ease;
  }

  :global(.chat-composer.composer-maximized .composer-editor) {
    min-height: 10rem;
    max-height: min(30rem, 60vh);
  }

  /* Maximize also widens the composer to 150% of its column.
     `--composer-expanded-width` is measured against the hosting conversation
     pane (see chat-composer-expand.svelte.ts) and falls back to the column width
     until that measurement lands; the negative inline margins centre a box that
     is now wider than its own parent. */
  :global(.chat-composer.composer-maximized) {
    width: var(--composer-expanded-width, 100%);
    margin-inline: calc((100% - var(--composer-expanded-width, 100%)) / 2);
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.chat-composer),
    :global(.composer-editor),
    .composer-send-control,
    .control-glyphs,
    .control-glyph,
    .pending-stop-label {
      transition: none;
    }
  }

  /* Send / Queue / Stop   one control that never unmounts. It widens out of the
     row and fades when the composer has nothing to send or stop, and widens back
     in when it does, so the mic beside it slides instead of the row snapping.
     While collapsed the negative start margin cancels the toolbar's `gap-1`, so
     the row's right edge is what moves and nothing shifts once the motion ends.
     Colour rides the same transition, so the gold send and the quiet stop tint
     into each other. */
  .composer-send-control {
    width: 0;
    /* A flex item's automatic minimum size would otherwise floor the used width
       at the control's own content, so the collapsed box has to say it may
       reach zero. */
    min-width: 0;
    margin-inline-start: -0.25rem;
    overflow: hidden;
    opacity: 0;
    pointer-events: none;
    transition:
      width 200ms cubic-bezier(0.215, 0.61, 0.355, 1),
      margin-inline-start 200ms cubic-bezier(0.215, 0.61, 0.355, 1),
      opacity 150ms ease,
      background-color 160ms ease,
      color 160ms ease;
  }

  .composer-send-control.is-present {
    width: 2rem;
    margin-inline-start: 0;
    opacity: 1;
    pointer-events: auto;
  }

  /* A control's glyphs share one box, all of them mounted: the active one
     crossfades and settles into place, so a state change reads as one mark
     becoming another rather than as a swap. Opacity and transform only, so the
     change never touches layout. */
  .control-glyphs {
    position: relative;
    display: grid;
    place-items: center;
    width: 1.0625rem;
    height: 1.0625rem;
    transition: opacity 150ms ease;
  }

  .control-glyph {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    opacity: 0;
    transform: scale(0.55) rotate(-32deg);
    transition:
      opacity 130ms ease,
      transform 210ms cubic-bezier(0.215, 0.61, 0.355, 1);
  }

  .control-glyph.is-active {
    opacity: 1;
    transform: none;
  }

  /* While the word is on screen the square behind it stays off; the narrow tier
     has no room for the word, so the square carries the armed state there (see
     the container query below). */
  .composer-send-control.is-armed .control-glyphs {
    opacity: 0;
  }

  .pending-stop-label {
    position: absolute;
    inset: 0;
    display: grid;
    place-items: center;
    opacity: 0;
    pointer-events: none;
    transition: opacity 130ms ease;
  }

  .pending-stop-label.is-active {
    opacity: 1;
  }

  /* Control labels ellipsize as the composer tightens   they never wrap to a
     second line. At the narrow tier they drop out entirely so only the icon is
     left behind. The `.composer-control-label` rule for the permission picker
     lives in that component. */
  @container (max-width: 520px) {
    .composer-toolbar {
      padding-inline: 0.5rem;
    }

    .composer-send-control.is-armed .control-glyphs {
      opacity: 1;
    }

    .pending-stop-label.is-active {
      opacity: 0;
    }
  }

  /* The board.props.shoe sizes to the row it holds: never wider than the room the composer
     leaves it, and as wide as that row needs, so the board.props.shoe reads as one bar
     centered under the message box in every mode   a project thread with a scope
     and a branch, a chat with nothing but its own name and the keys.
     `.composer-board.props.shoe` is the query container (see its `@container` class), so
     these rules and the board.props.shoe's own truncation stages measure the composer, minus
     that wrapper's own inline padding. */
  .composer-board.props.shoe-card {
    width: max-content;
    max-width: 100%;
  }

  /* Tight composer: the board.props.shoe trims its own inline padding before the row has to
     ellipsize, so the row keeps the room it needs. */
  @container (max-width: 630px) {
    .composer-board.props.shoe-card {
      padding-inline: 0.375rem;
    }
  }
</style>
