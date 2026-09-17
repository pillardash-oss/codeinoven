<script lang="ts">
  import { SvelteMap } from 'svelte/reactivity'
  import ChatComposer from '$lib/components/chats/ChatComposer.svelte'
  import AiAccountSetupCard from '$lib/components/threads/AiAccountSetupCard.svelte'
  import ThreadView from '$lib/components/threads/ThreadView.svelte'
  import WelcomeStart from './WelcomeStart.svelte'
  import { harnessHasProvider, selectedModelExists } from '$lib/ai-account'
  import { invoke } from '$lib/ipc.svelte'
  import { modelKey } from '$lib/model-keys'
  import { reportError } from '$lib/stores/app-errors.svelte'
  import { createAccountUsageCache } from '$lib/stores/account-usage.svelte'
  import { rendererRecovery, type MainView } from '$lib/stores/renderer-recovery.svelte'
  import { sidebarState } from '$lib/stores/sidebar.svelte'
  import { workspaceState } from '$lib/stores/workspace.svelte'
  import {
    FIRST_RUN_PROVIDER_SEARCH,
    providerConnectFlow
  } from '$lib/stores/provider-connect-flow.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { providerStore } from '$lib/stores/providers.svelte'
  import { chatEffectiveSettings, chatSettings } from '$lib/stores/thread-settings.svelte'
  import {
    INBOX_PROJECT_ID,
    type AgentHarnessUsage,
    type Project,
    type Thread
  } from '$shared/types'
  import type { AppConfig, AppConfigPatch, PromptAttachment } from '$shared/types'

  interface Props {
    mode: 'projects' | 'chats' | 'threads'
    active: boolean
    selectedThread: Thread | null
    visibleProjects: Project[]
    projectIcons: SvelteMap<string, string>
    threadsByProject: SvelteMap<string, Thread[]>
    config?: AppConfig
    updateConfig?: (patch: AppConfigPatch) => Promise<void>
    /** Remounts the empty-state chats composer to restore a failed first send. */
    restoreKey: number
    onNavigate: (view: MainView) => void
    onForked: (thread: Thread) => void
    onContinueInProject: (forked: Thread) => void
    onProjectCreated: (project: Project) => Promise<void>
    onOpenScopeView: (thread: Thread) => void
    onSendChat: (msg: string, files: PromptAttachment[]) => Promise<void>
    onRequestAddProject: (kind: 'local' | 'git-clone') => void
  }

  let {
    mode,
    active,
    selectedThread,
    visibleProjects,
    projectIcons,
    threadsByProject,
    config,
    updateConfig,
    restoreKey,
    onNavigate,
    onForked,
    onContinueInProject,
    onProjectCreated,
    onOpenScopeView,
    onSendChat,
    onRequestAddProject
  }: Props = $props()

  let chatsComposer: ChatComposer | undefined = $state(undefined)

  const chatSuggestedPrompts = [
    'Research a question using my device',
    'Run a task for me on this computer',
    'Brainstorm ideas with me'
  ]

  /** Provider catalog for the Chats tab   feeds the empty-state composer so the
      model picker is populated before the first message creates a thread. */
  let chatInboxId = $state<string | null>(null)
  let chatProviders = $derived(
    chatInboxId
      ? (providerCatalog.cached(chatInboxId) ?? providerCatalog.allCached())
      : providerCatalog.allCached()
  )
  /** Effective chat settings   the chat's own model when one has been picked,
   *  else the last project model so a fresh chat starts on the model in use. */
  let chatComposerSettings = $derived(chatEffectiveSettings())

  /** Harness display name for the chat setup card, straight from the registry. */
  let chatHarnessName = $derived(
    providerStore.providers.find((provider) => provider.id === chatComposerSettings.harnessId)
      ?.name ?? chatComposerSettings.harnessId
  )
  /** True while the new-chat composer has a provider and a model to run on. */
  let chatCanRunTurns = $derived(
    harnessHasProvider(chatProviders, chatComposerSettings.harnessId) &&
      selectedModelExists(chatProviders, chatComposerSettings)
  )
  /** Armed by the composer refusing a send the chat has no account for. */
  let chatAiAccountPromptOpen = $state(false)
  let chatAiAccountPromptVisible = $derived(chatAiAccountPromptOpen && !chatCanRunTurns)

  /** Open the harness's provider list for the chat that has not been created
   *  yet, then re-probe the inbox catalog so the connected models show up. */
  function openChatAiAccountSetup(): void {
    providerConnectFlow.open(chatComposerSettings.harnessId, {
      search: FIRST_RUN_PROVIDER_SEARCH,
      onConnected: () => {
        if (chatInboxId) void providerCatalog.refresh(chatInboxId, true)
      }
    })
  }

  /** Live account quota for the not-yet-created "Start a new chat" composer
   *  the exact same provider-level hover-fetch cache the thread battery uses. */
  const newChatUsage = createAccountUsageCache()
  function revealNewChatUsage(): void {
    if (newChatUsage.isStale()) {
      void newChatUsage.refresh({
        harnessId: chatComposerSettings.harnessId,
        providerId: chatComposerSettings.providerId
      })
    }
  }
  const newChatHarnessUsage = $derived.by((): AgentHarnessUsage[] =>
    newChatUsage.usage.map((usage) => ({
      harnessId: usage.harnessId,
      providerId: usage.providerId,
      costUsd: 0,
      rateLimits: usage.rateLimits,
      ...(usage.credits ? { credits: usage.credits } : {}),
      ...(usage.bankedResets ? { bankedResets: usage.bankedResets } : {})
    }))
  )
  $effect(() => {
    if (mode !== 'chats') return
    let alive = true
    void (async () => {
      try {
        const inbox = await invoke('project:ensureInbox')
        if (!alive) return
        chatInboxId = inbox.id
      } catch {
        if (alive) chatInboxId = null
      }
    })()
    return () => {
      alive = false
    }
  })

  function handleConversationRenderError(error: unknown): void {
    const thread = workspaceState.selectedThread
    if (!thread) return
    reportError(error, 'The conversation could not be rendered.', {
      projectId: thread.projectId,
      threadId: thread.id
    })
  }
</script>

<div
  class="min-h-0 min-w-0 overflow-hidden"
  style:grid-column="1"
  style:grid-row="1"
  data-onboarding="conversation"
>
  {#if selectedThread}
    <div class="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden">
      {#key selectedThread.id}
        <svelte:boundary onerror={handleConversationRenderError}>
          <ThreadView
            thread={selectedThread}
            {active}
            chatMode={mode === 'chats'}
            allowCenteredComposer={mode === 'chats' ||
              (!workspaceState.headStartUsedThreadIds.has(selectedThread.id) &&
                ((threadsByProject.get(selectedThread.projectId)?.length ?? 0) === 1 ||
                  workspaceState.freshEmptyStateThreadIds.has(selectedThread.id)))}
            {onForked}
            projects={visibleProjects}
            {projectIcons}
            {onContinueInProject}
            {onProjectCreated}
            onOpenScopeView={(thread) => void onOpenScopeView(thread)}
          />
          {#snippet failed(_error: unknown, reset: () => void)}
            <div class="flex h-full min-h-0 items-center justify-center px-6">
              <div
                class="w-full max-w-md rounded-xl border border-danger/30 bg-surface px-5 py-4"
                role="alert"
              >
                <p class="text-sm font-semibold text-foreground">
                  Conversation view failed to render
                </p>
                <p class="mt-1 text-sm text-muted">
                  The thread is still saved. Reload this view to continue.
                </p>
                <button
                  type="button"
                  class="mt-4 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-on-primary transition-opacity hover:opacity-90"
                  onclick={reset}
                >
                  Reload conversation
                </button>
              </div>
            </div>
          {/snippet}
        </svelte:boundary>
      {/key}
    </div>
  {:else if mode === 'chats'}
    <!-- Empty state   greeting, composer, and suggested prompts centered -->
    <div
      class="flex h-full flex-col items-center justify-center px-6"
      data-drop-region="conversation"
    >
      <div class="mb-6 text-center">
        <h1 class="text-[1.375rem] font-semibold tracking-tight">Start a new chat</h1>
        <p class="mt-1 text-[0.875rem] text-muted">Send a message to begin no project needed</p>
      </div>
      <div class="w-full max-w-4xl">
        {#if chatAiAccountPromptVisible}
          <div class="mb-3">
            <AiAccountSetupCard
              harnessName={chatHarnessName}
              providers={chatProviders}
              settings={chatComposerSettings}
              projectId={chatInboxId ?? INBOX_PROJECT_ID}
              refreshing={chatInboxId ? providerCatalog.refreshing(chatInboxId) : false}
              favoriteModels={rendererRecovery.chatFavoriteModels}
              recentModels={rendererRecovery.chatRecentModels}
              onRemoveRecent={(key) => rendererRecovery.removeChatRecentModel(key)}
              onToggleFavorite={(providerId, modelId, harnessId) =>
                rendererRecovery.toggleChatFavorite(modelKey(harnessId, providerId, modelId))}
              onReorderFavorite={(draggedKey, targetKey, position) =>
                rendererRecovery.reorderChatFavorite(draggedKey, targetKey, position)}
              onModelChange={(next) => chatSettings.commit(next)}
              onConnect={openChatAiAccountSetup}
              onDismiss={() => (chatAiAccountPromptOpen = false)}
            />
          </div>
        {/if}
        {#key restoreKey}
          <ChatComposer
            bind:this={chatsComposer}
            placeholder="What do you want to work on?"
            autofocus
            showEngineeringMode={false}
            showChatModes
            hidePermissionSelector
            settings={chatComposerSettings}
            onSettingsChange={(settings) => chatSettings.commit(settings)}
            providers={chatProviders}
            projectId={chatInboxId}
            attachmentStorage={{
              kind: 'chat',
              projectId: INBOX_PROJECT_ID,
              threadId: 'new-chat'
            }}
            harnessId={chatComposerSettings.harnessId}
            favoriteModels={rendererRecovery.chatFavoriteModels}
            onToggleFavorite={(providerId, modelId, harnessId) =>
              rendererRecovery.toggleChatFavorite(modelKey(harnessId, providerId, modelId))}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderChatFavorite(draggedKey, targetKey, position)}
            recentModels={rendererRecovery.chatRecentModels}
            onRemoveRecent={(key) => rendererRecovery.removeChatRecentModel(key)}
            onModelUsed={(modelKey) => rendererRecovery.addChatRecentModel(modelKey)}
            imageDescriptorDefault={config?.agentDefaults.imageDescriptor}
            imageDescriptorAskAgain={config?.imageDescriptorAskAgain === true}
            onImageDescriptorDefaultChange={(selection) =>
              void updateConfig?.({
                agentDefaults: {
                  ...(config?.agentDefaults ?? { syncFromThreadChanges: false }),
                  imageDescriptor: selection
                }
              })}
            onImageDescriptorAskAgainChange={(value) =>
              void updateConfig?.({ imageDescriptorAskAgain: value })}
            initialValue={rendererRecovery.draftFor(INBOX_PROJECT_ID, 'new-chat')}
            onValueChange={(value) =>
              rendererRecovery.setDraft(INBOX_PROJECT_ID, 'new-chat', value)}
            initialAttachments={rendererRecovery.attachmentsFor(INBOX_PROJECT_ID, 'new-chat')}
            onAttachmentsChange={(files) =>
              rendererRecovery.setDraft(
                INBOX_PROJECT_ID,
                'new-chat',
                rendererRecovery.draftFor(INBOX_PROJECT_ID, 'new-chat'),
                files
              )}
            onSend={(msg, files) => void onSendChat(msg, files)}
            onNeedsAiAccount={() => (chatAiAccountPromptOpen = true)}
            onRevealUsage={revealNewChatUsage}
            onHideUsage={() => newChatUsage.markStale()}
            usageRefreshing={newChatUsage.refreshing}
            harnessUsage={newChatHarnessUsage}
          />
          <div class="mt-4 flex flex-wrap items-center justify-center gap-2">
            {#each chatSuggestedPrompts as prompt (prompt)}
              <button
                type="button"
                class="rounded-full border border-border bg-surface px-3.5 py-1.5 text-[0.75rem] text-muted transition-colors hover:bg-elevated hover:text-foreground"
                onclick={() => chatsComposer?.setComposerText(prompt)}
              >
                {prompt}
              </button>
            {/each}
          </div>
        {/key}
      </div>
    </div>
  {:else}
    <WelcomeStart
      variant="projects"
      onNewChat={() => onNavigate('chats')}
      onToggleSidebar={() => sidebarState.toggle()}
      onAddProject={() => {
        onNavigate('projects')
        onRequestAddProject('local')
      }}
      onCloneRepo={() => {
        onNavigate('projects')
        onRequestAddProject('git-clone')
      }}
      onOpenSettings={() => onNavigate('settings')}
      onShowTour={() => workspaceState.requestOnboarding()}
    />
  {/if}
</div>
