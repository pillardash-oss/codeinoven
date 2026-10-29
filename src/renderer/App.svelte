<script lang="ts">
  import AppHeader from '$lib/components/layout/AppHeader.svelte'
  import AppPanelHost from '$lib/components/layout/AppPanelHost.svelte'
  import GlobalContextSidebar from '$lib/components/layout/GlobalContextSidebar.svelte'
  import InstanceRoleNotice from '$lib/components/layout/InstanceRoleNotice.svelte'
  import AppViewRail from '$lib/components/layout/AppViewRail.svelte'
  import Workspace from '$lib/components/workspace/Workspace.svelte'
  import ConversationFirstPaint from '$lib/components/workspace/ConversationFirstPaint.svelte'
  import { hasConversationPainted, whenConversationPainted } from '$lib/conversation-painted'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { fly } from 'svelte/transition'
  import { pageReveal } from '$lib/components/layout/page-reveal'
  import Toaster from '$lib/components/ui/Toaster.svelte'
  import TooltipHost from '$lib/components/ui/TooltipHost.svelte'
  import AppConfirmDialog from '$lib/components/ui/AppConfirmDialog.svelte'
  import TextSelectionContextMenu from '$lib/components/shared/TextSelectionContextMenu.svelte'
  import { invoke } from '$lib/ipc.svelte'
  import {
    isSettingsView,
    settingsSectionForView,
    settingsViewForSection
  } from '$lib/stores/renderer-recovery.svelte'
  import { browserStore } from '$lib/stores/browser-access.svelte'
  import { pipState } from '$lib/stores/pip.svelte'
  import { scopeState } from '$lib/stores/scope.svelte'
  import { standaloneFiles } from '$lib/stores/standalone-files.svelte'
  import { scopeJobs } from '$lib/stores/scope-jobs.svelte'
  import { agentAssist } from '$lib/components/assist/agent-assist-store.svelte'
  import { agentAssistJobs } from '$lib/components/assist/agent-assist-jobs.svelte'
  import { scopeConfirmations } from '$lib/stores/scope-confirmations.svelte'
  import { cioCleanupStore } from '$lib/stores/cio-cleanup.svelte'
  import { providerConnectFlow } from '$lib/stores/provider-connect-flow.svelte'
  import { baseUrlProviderFlow } from '$lib/stores/base-url-provider-flow.svelte'
  import { harnessLifecycleStore } from '$lib/stores/harness-lifecycle.svelte'
  import { ovenSetupStore } from '$lib/stores/oven-setup.svelte'
  import { prLifecycleStore } from '$lib/stores/pr-lifecycle.svelte'
  import { prBatchJobs } from '$lib/stores/pr-batch-jobs.svelte'
  import { gitSyncJobs } from '$lib/stores/git-sync-jobs.svelte'
  import { gitPullJobs } from '$lib/stores/git-pull-jobs.svelte'
  import { githubSignIn } from '$lib/stores/github-sign-in.svelte'
  import { guideState } from '$lib/guide/guide-state.svelte'
  import { onMount } from 'svelte'
  import { createApp } from './App/App-board.svelte'
  const board = createApp()

  /**
   * The conversation the user was reading, painted before anything owns it.
   *
   * The workspace is a second module graph on top of the shell, so on a launch
   * that restores a thread its own pane cannot paint until that graph and the
   * thread read behind it have both landed. The one thing a launch already has
   * before either is the transcript it read on the renderer's first statement
   * (`preloadRestoredThreadConversation`), so the last prompt and its answer are
   * shown from here in the meantime instead of leaving the app's main area empty
   * while the rail, the header and the thread list fill in around it.
   *
   * It is a real handoff, not a delay: the layer is removed the moment the
   * renderer reports that the restored conversation painted, which is the same
   * signal the splash is released on. The failsafe only exists so a restore that
   * never reports cannot trap the user behind this layer.
   */
  let conversationPainted = $state(hasConversationPainted())
  let firstScreenDismissed = $state(false)
  let restoredThread = $derived(rendererRecovery.selectedThread)
  let firstScreenActive = $derived(
    restoredThread !== null &&
      !conversationPainted &&
      !firstScreenDismissed &&
      board.openAssistantFromSearch.showsContentView
  )

  onMount(() => {
    whenConversationPainted(() => {
      conversationPainted = true
    })
    // A restore that never reports must not trap the user behind this layer.
    const failsafe = setTimeout(() => {
      firstScreenDismissed = true
    }, 15_000)
    return () => clearTimeout(failsafe)
  })
</script>

<div class="flex h-screen flex-col bg-app">
  <AppHeader
    activeView={board.onKeydown.activeView}
    goBack={board.spotlightPalette.goBack}
    goForward={board.openAssistantFromSearch.goForward}
    navigation={board.openAssistantFromSearch.navigation}
  />

  <div class="flex min-h-0 flex-1">
    <AppViewRail
      options={board.openAssistantFromSearch.navigation.headerViewOptions()}
      shownOption={board.openAssistantFromSearch.navigation.shownHeaderViewOption}
      projectBadgeOption={board.openAssistantFromSearch.navigation.projectBadgeOption}
      activeView={board.onKeydown.activeView}
      navigate={board.onKeydown.navigate}
      onOptionHover={board.openAssistantFromSearch.handleViewOptionHover}
    />

    <!-- `overflow-clip`, not `overflow-hidden`: the arriving view slides up on
         its reveal transition, and a scroll container here would let that
         offset scroll the shell before it clamps back. Clip keeps this frame
         fixed. -->
    <main class="relative min-w-0 flex-1 overflow-clip">
      <!-- One shell for all views   the workspace (and the open thread) stays
         mounted across Settings/Scope so returning never reloads the thread
         list or reconnects the harness. It fades out rather than going
         `display: none`, so the swap cross-fades with the page arriving on top
         while keeping it out of the tab order and the accessibility tree.

         Visibility is transitioned on the way OUT only, and the arriving shell
         takes `transition-property: opacity` without it. A transitioned
         visibility computes `hidden` for the instant a switch starts   the
         after-change value of an interpolated visibility is `visible` only
         once the transition has actually begun, and that first frame is
         exactly when a return to the conversation asks its composer to take
         the caret. Measured in this app: with visibility transitioned in both
         directions, no element inside the arriving shell accepts focus until a
         later frame, so the composer silently refused the caret; with the
         incoming direction untransitioned the same focus request lands on the
         frame it is made. The outgoing direction keeps the transition, which is
         what holds the fading shell on screen instead of blanking it the moment
         the other page arrives. -->
      <div
        class="h-full duration-200 ease-out motion-reduce:transition-none {board
          .openAssistantFromSearch.showsContentView
          ? 'visible opacity-100 transition-[opacity]'
          : 'invisible pointer-events-none opacity-0 transition-[opacity,visibility]'}"
      >
        <Workspace
          mode={board.openAssistantFromSearch.lastContentView}
          active={board.openAssistantFromSearch.showsContentView}
          scopeViewActive={board.onKeydown.activeView === 'scope'}
          navigate={board.onKeydown.navigate}
          lastProjectViewLanding={() =>
            board.openAssistantFromSearch.navigation.projectFamilyLanding()}
          config={board.updateConfig.config}
          updateConfig={board.updateConfig.updateConfig}
        />
      </div>
      {#if firstScreenActive && restoredThread}
        <!-- The restored conversation, before its own renderer owns the area.
             Sits above the workspace shell so the first thing on screen is what
             the user was reading, not an empty column beside a loading list. -->
        <div
          class="pointer-events-none absolute inset-0 z-10 bg-app"
          data-conversation-first-screen
        >
          <ConversationFirstPaint
            projectId={restoredThread.projectId}
            threadId={restoredThread.threadId}
          />
        </div>
      {/if}
      {#if board.onKeydown.activeView === 'scope'}
        {#await import('$lib/components/scope/ScopeView.svelte') then { default: ScopeView }}
          <div class="absolute inset-0" transition:fly={pageReveal()}>
            <ScopeView
              navigateToScopedThreads={board.openAssistantFromSearch.navigateToScopedThreads}
            />
          </div>
        {/await}
      {:else if isSettingsView(board.onKeydown.activeView)}
        <!-- Each settings section is its own dedicated page in the board.openAssistantFromSearch.navigation model.
           The view stays mounted and SettingsView swaps its content on the section
           prop   a keyed remount here would flash the screen on every tab switch. -->
        {#await import('$lib/components/settings/SettingsView.svelte') then { default: SettingsView }}
          <div class="absolute inset-0" transition:fly={pageReveal()}>
            <SettingsView
              config={board.updateConfig.config}
              settingsReady={board.updateConfig.settingsReady}
              error={board.updateConfig.settingsError}
              setPreference={board.updateConfig.setPreference}
              updateConfig={board.updateConfig.updateConfig}
              section={settingsSectionForView(board.onKeydown.activeView) ?? 'general'}
              onNavigateSection={(section) =>
                board.onKeydown.navigate(settingsViewForSection(section))}
              onBack={() =>
                board.onKeydown.navigate(board.openAssistantFromSearch.lastViewBeforeSettings)}
              onHistoryBack={() => void board.spotlightPalette.goBack()}
            />
          </div>
        {/await}
      {:else if board.onKeydown.activeView === 'browser'}
        <!-- The global browser is its own workspace   the app header above it is
             the only shared chrome. It is pinned to the stage instead of left in
             normal flow, because the workspace shell behind it stays mounted as a
             full-height sibling: in flow the browser sits below the fold and only
             enters view once focus scrolls the stage. -->
        {#await import('$lib/components/browser/BrowserView.svelte') then { default: BrowserView }}
          <div class="absolute inset-0">
            <BrowserView />
          </div>
        {/await}
      {:else if !board.openAssistantFromSearch.showsContentView}
        <div
          class="absolute inset-0 flex items-center justify-center"
          transition:fly={pageReveal()}
        >
          <p class="text-sm text-dimmed">Coming soon</p>
        </div>
      {/if}
      {#if board.onKeydown.activeView === 'scope' || isSettingsView(board.onKeydown.activeView)}
        <GlobalContextSidebar />
      {/if}
      {#if browserStore()?.peekTab}
        {#key browserStore()?.peekTab?.id}
          {#await import('$lib/components/browser/BrowserPeekWindow.svelte') then { default: BrowserPeekWindow }}
            <BrowserPeekWindow />
          {/await}
        {/key}
      {/if}
      {#if browserStore()?.sitePermissionsPrompt}
        {#await import('$lib/components/browser/BrowserSitePermissionsModal.svelte') then { default: BrowserSitePermissionsModal }}
          <BrowserSitePermissionsModal />
        {/await}
      {/if}
      {#if browserStore()?.screenSharePrompt}
        {#await import('$lib/components/browser/BrowserScreenSharePicker.svelte') then { default: BrowserScreenSharePicker }}
          <BrowserScreenSharePicker />
        {/await}
      {/if}
    </main>

    <!-- A guide's words, in a column beside the app rather than over it: the app
         reflows beside the dock, so nothing a guide explains is ever covered. -->
    {#if guideState.visible}
      {#await import('$lib/components/guide/GuideDock.svelte') then { default: GuideDock }}
        <GuideDock />
      {/await}
    {/if}
  </div>

  <!-- The marker a guide draws inside the app: one element, a rule to the dock,
       and the notch where it lands. Fixed to the window, and never in the way. -->
  {#if guideState.visible}
    {#await import('$lib/components/guide/GuideMarks.svelte') then { default: GuideMarks }}
      <GuideMarks />
    {/await}
  {/if}

  <!-- The instance-role notice sits at the very bottom as a status bar: it is a
       standing condition, so it reads as chrome rather than as content above
       the workspace. It moves here so it never pushes the workspace down. -->
  {#if board.state.instanceRole?.role === 'secondary'}
    <InstanceRoleNotice
      ownerPid={board.state.instanceRole.ownerPid}
      onOpenOwner={() => void invoke('app:openInstanceOwner')}
      onTakeOver={() => void invoke('app:transferInstanceControl')}
      onQuit={() => void invoke('app:confirmClose')}
    />
  {/if}
  {#if board.spotlightPalette.spotlightScreenId}
    {#await import('$lib/components/actions/CommandPalette.svelte') then { default: CommandPalette }}
      <CommandPalette {...board.spotlightPalette.spotlightPalette} />
    {/await}
  {/if}
  {#if board.spotlightPalette.newProjectSpotlightOpen}
    {#await import('$lib/components/shared/ProjectCreateControl.svelte') then { default: ProjectCreateControl }}
      <ProjectCreateControl
        mode="spotlight"
        open={board.spotlightPalette.newProjectSpotlightOpen}
        onClose={board.spotlightPalette.closeNewProjectSpotlight}
        onProjectCreated={board.spotlightPalette.handleSpotlightProjectCreated}
        onExisting={board.spotlightPalette.handleSpotlightExistingProject}
      />
    {/await}
  {/if}
  {#if board.updateConfig.startAtLoginOfferOpen}
    <!-- The one-time start-at-login offer. Raised right after an assistant is given
         its first knowledge, so the question is about the runs the user has just
         set up, and floated above every view because that save happens in the
         thread the assistant belongs to. -->
    {#await import('$lib/components/layout/StartAtLoginPrompt.svelte') then { default: StartAtLoginPrompt }}
      <StartAtLoginPrompt open onChoose={board.updateConfig.answerStartAtLoginOffer} />
    {/await}
  {/if}
  <Toaster />
  <!-- Raised by menus that close as soon as one of their items is chosen, so the
       question outlives the surface that asked it. -->
  <AppConfirmDialog />
  <TextSelectionContextMenu />
  <TooltipHost />
  {#if scopeConfirmations.current}
    <!-- An agent's destructive scope action is parked in main until this dialog
         is answered, so it floats above every view until the user decides. -->
    {#await import('$lib/components/scope/ScopeAgentConfirmDialog.svelte') then { default: ScopeAgentConfirmDialog }}
      <ScopeAgentConfirmDialog />
    {/await}
  {/if}
  {#if pipState.active && pipState.frameDataUrl !== null}
    {#await import('$lib/components/pip/PipOverlay.svelte') then { default: PipOverlay }}
      <PipOverlay />
    {/await}
  {/if}
  {#if standaloneFiles.open && standaloneFiles.presentation === 'docked'}
    <!-- Files opened through the operating system: docked as a floating panel by
         default so the workspace and its threads stay usable, minimizable to a
         screen-edge chip. Editable text saved straight back to the file, and
         deliberately project-less (no file tree, no tree operations, nothing
         indexed). -->
    {#await import('$lib/components/files/StandaloneFileDock.svelte') then { default: StandaloneFileDock }}
      <StandaloneFileDock />
    {/await}
  {:else if standaloneFiles.open}
    <!-- The explicit full screen mode of the same files, one action away from
         the docked panel. -->
    {#await import('$lib/components/files/StandaloneFileViewer.svelte') then { default: StandaloneFileViewer }}
      <StandaloneFileViewer />
    {/await}
  {/if}
  {#if standaloneFiles.pendingClose}
    <!-- One unsaved-changes confirmation served to both the docked panel and the
         fullscreen reader. -->
    {#await import('$lib/components/files/StandaloneFileCloseDialog.svelte') then { default: StandaloneFileCloseDialog }}
      <StandaloneFileCloseDialog />
    {/await}
  {/if}

  {#if providerConnectFlow.request}
    <!-- The provider connect flow floats above every view: a surface with no AI
         account connected (the first-run setup card, the empty model picker)
         opens the harness's provider list without navigating away. -->
    {#await import('$lib/components/providers/ProviderConnectHost.svelte') then { default: ProviderConnectHost }}
      <ProviderConnectHost />
    {/await}
  {/if}

  {#if baseUrlProviderFlow.request}
    <!-- The custom base-URL provider editor is a dockable panel, so it is owned
         here rather than by the settings page that lists the providers: docking
         it leaves a chip behind while the user keeps working, and a chip owned
         by the settings subtree would vanish the moment they navigated away. -->
    {#await import('$lib/components/providers/BaseUrlProviderHost.svelte') then { default: BaseUrlProviderHost }}
      <BaseUrlProviderHost />
    {/await}
  {/if}

  {#if board.settleCloseConfirmationThread.closeConfirmation}
    {#await import('$lib/components/layout/CloseConfirmationModal.svelte') then { default: CloseConfirmationModal }}
      <CloseConfirmationModal
        payload={board.settleCloseConfirmationThread.closeConfirmation}
        projects={scopeState.projectRecords}
        onDismiss={board.settleCloseConfirmationThread.abandonClose}
        onConfirm={board.settleCloseConfirmationThread.confirmForceClose}
        onConfirmSave={board.settleCloseConfirmationThread.confirmForceCloseSaving}
      />
    {/await}
  {/if}

  {#if githubSignIn.open}
    <!-- The GitHub device-flow sign-in, docked so the user can authorize in a
         browser   including the app's own   while the panel keeps polling. It
         floats above every view because the flow outlives the panel it was
         opened from: the Git sidebar is behind the browser view when it lands. -->
    {#await import('$lib/components/git/GitHubSignInDock.svelte') then { default: GitHubSignInDock }}
      <GitHubSignInDock />
    {/await}
  {/if}

  {#if ovenSetupStore.initialized}
    {#await import('$lib/components/settings/OvenSetupModal.svelte') then { default: OvenSetupModal }}
      <OvenSetupModal
        open={ovenSetupStore.open}
        initialOvenId={ovenSetupStore.ovenId}
        onComplete={(ovenId) => ovenSetupStore.markComplete(ovenId)}
        onClose={() => ovenSetupStore.close()}
      />
    {/await}
  {/if}

  {#if harnessLifecycleStore.runs.length}
    <!-- Floats above every view   survives board.openAssistantFromSearch.navigation while tasks keep running. -->
    {#await import('$lib/components/providers/HarnessRunModal.svelte') then { default: HarnessRunModal }}
      <HarnessRunModal />
    {/await}
  {/if}

  {#if prLifecycleStore.drafts.length}
    <!-- Floats above every view   survives thread/project/view and sidebar visibility. -->
    {#await import('$lib/components/git/PrDockHost.svelte') then { default: PrDockHost }}
      <PrDockHost />
    {/await}
  {/if}

  {#if agentAssist.request || agentAssistJobs.jobs.length}
    <!-- Every "with agent" control opens this one setup panel, wherever it lives. -->
    {#await import('$lib/components/assist/AgentAssistHost.svelte') then { default: AgentAssistHost }}
      <AgentAssistHost />
    {/await}
  {/if}

  {#if scopeJobs.jobs.length}
    <!-- Floats above every view so a worktree run keeps reporting while the user works. -->
    {#await import('$lib/components/scope/ScopeJobDockHost.svelte') then { default: ScopeJobDockHost }}
      <ScopeJobDockHost />
    {/await}
  {/if}

  {#if prBatchJobs.jobs.length}
    <!-- Floats above every view so a confirmed batch keeps closing pull requests while the user works. -->
    {#await import('$lib/components/git/PrBatchDockHost.svelte') then { default: PrBatchDockHost }}
      <PrBatchDockHost />
    {/await}
  {/if}

  {#if gitSyncJobs.jobs.length}
    <!-- Floats above every view so a sync between two checkouts reports itself, and its outcome is never a dialog. -->
    {#await import('$lib/components/git/GitSyncDockHost.svelte') then { default: GitSyncDockHost }}
      <GitSyncDockHost />
    {/await}
  {/if}

  {#if gitPullJobs.jobs.length}
    <!-- Floats above every view so a pull reports itself after its chooser is gone, and its outcome is never a dialog. -->
    {#await import('$lib/components/git/GitPullDockHost.svelte') then { default: GitPullDockHost }}
      <GitPullDockHost />
    {/await}
  {/if}

  {#if cioCleanupStore.jobs.length}
    <!-- Floats above every view so a manual cleanup keeps reporting while the user works. -->
    {#await import('$lib/components/cio/CioCleanupDockHost.svelte') then { default: CioCleanupDockHost }}
      <CioCleanupDockHost />
    {/await}
  {/if}

  <!-- The app's global panels (notifications and sticky notes) are mounted once
       here and moved into whichever rail is on screen, so a view switch never
       rebuilds them. See `app-panel-portal.ts`. -->
  <AppPanelHost />
</div>
