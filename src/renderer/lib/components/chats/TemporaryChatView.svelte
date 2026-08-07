<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { Clock3, FileText, Loader2, MessageSquare, RotateCcw, X } from '@lucide/svelte'
  import ChatComposer from './ChatComposer.svelte'
  import ImagePreview from './ImagePreview.svelte'
  import MarkdownView from '../markdown/MarkdownView.svelte'
  import WorkingTrace from '../threads/WorkingTrace.svelte'
  import { invoke, subscribe } from '$lib/ipc.svelte'
  import { messageId } from '$shared/id'
  import { FileBlobUrlManager } from '$lib/media-urls.svelte'
  import { isImageMime } from '$lib/mime'
  import {
    contextSidebarState,
    type TemporaryChatContextTab
  } from '$lib/stores/context-sidebar.svelte'
  import { providerCatalog } from '$lib/stores/provider-catalog.svelte'
  import { rendererRecovery } from '$lib/stores/renderer-recovery.svelte'
  import { getAgentIcon } from '$lib/agent-icons/registry'
  import type {
    AgentMessage,
    AgentEvent,
    AgentPart,
    PromptAttachment,
    PromptReference,
    ThreadSettings
  } from '$shared/types'

  interface Props {
    tab: TemporaryChatContextTab
  }

  let { tab }: Props = $props()
  /** Reactive provider catalog for the tab's project — seeded from the cache
   *  and kept current when the model picker lazily refreshes the store. */
  let providers = $derived(providerCatalog.cached(tab.projectId) ?? providerCatalog.allCached())
  let loadedAuditSessionId = $state('')
  let previewFile = $state<Extract<AgentPart, { type: 'file' }> | null>(null)
  let imageUrls = new FileBlobUrlManager()
  let references = $derived<PromptReference[]>(
    tab.selectionAttached
      ? [{ id: `${tab.id}:selection`, label: 'Selection 1', text: tab.selection }]
      : []
  )
  let modelLabel = $derived.by((): string | null => {
    const modelId = tab.settings.modelId
    if (!modelId) return null
    const model = providers
      .flatMap((p) => p.models)
      .find(
        (m) =>
          m.id === modelId && (!tab.settings.providerId || m.providerId === tab.settings.providerId)
      )
    return model?.name ?? modelId
  })
  let providerName = $derived(
    providers.find((p) => p.id === tab.settings.providerId)?.name ?? undefined
  )
  let harnessName = $derived(
    tab.settings.harnessId
      ? (getAgentIcon(tab.settings.harnessId)?.name ?? tab.settings.harnessId)
      : null
  )

  function textFor(message: AgentMessage): string {
    return message.parts
      .filter((part): part is Extract<AgentPart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text)
      .join('\n')
  }

  function fileParts(message: AgentMessage): Extract<AgentPart, { type: 'file' }>[] {
    return message.parts.filter(
      (part): part is Extract<AgentPart, { type: 'file' }> => part.type === 'file'
    )
  }

  function workingParts(message: AgentMessage): AgentPart[] {
    return message.parts.filter((part) => part.type !== 'text' && part.type !== 'question')
  }

  /** When the agent started working on the turn an assistant message belongs to. */
  function turnStartTime(messageIndex: number): number | undefined {
    for (let i = messageIndex - 1; i >= 0; i--) {
      const candidate = tab.messages[i]
      if (candidate.role === 'user') return candidate.createdAt
    }
    return undefined
  }

  function upsertPart(part: AgentPart): void {
    const messageIndex = tab.messages.findIndex((message) => message.id === part.messageID)
    if (messageIndex < 0) {
      tab.messages = [
        ...tab.messages,
        {
          id: part.messageID,
          role: 'assistant',
          parts: [part],
          createdAt: Date.now()
        }
      ]
      return
    }
    const message = tab.messages[messageIndex]
    const partIndex = message.parts.findIndex((candidate) => candidate.id === part.id)
    const parts =
      partIndex < 0
        ? [...message.parts, part]
        : message.parts.map((candidate, index) => (index === partIndex ? part : candidate))
    tab.messages = tab.messages.map((candidate, index) =>
      index === messageIndex ? { ...message, parts } : candidate
    )
  }

  function applyDelta(messageId: string, partId: string, field: string, delta: string): void {
    if (field !== 'text') return
    tab.messages = tab.messages.map((message) => {
      if (message.id !== messageId) return message
      return {
        ...message,
        parts: message.parts.map((part) => {
          if (part.id !== partId) return part
          if (part.type === 'text' || part.type === 'reasoning') {
            return { ...part, text: part.text + delta }
          }
          return part
        })
      }
    })
  }

  function handleEvent(event: AgentEvent): void {
    if (!('sessionId' in event)) return
    if (event.type === 'temporary-chat.started') {
      tab.sessionId = event.sessionId
      return
    }
    if (!tab.sessionId || event.sessionId !== tab.sessionId) return
    switch (event.type) {
      case 'message.part.updated':
        upsertPart(event.part)
        break
      case 'message.part.delta':
        applyDelta(event.messageId, event.partId, event.field, event.delta)
        break
      case 'message.completed':
        tab.messages = tab.messages.map((message) =>
          message.id === event.messageId
            ? { ...message, completedAt: Date.now(), error: event.error }
            : message
        )
        break
      case 'session.error':
        tab.error = event.issue?.message ?? event.error ?? 'The audit session failed.'
        tab.busy = false
        break
      case 'session.status':
        if (event.status.state === 'error') {
          tab.error = event.status.issue.message
          tab.busy = false
        }
        break
      case 'session.idle':
        break
    }
  }

  function userMessage(
    text: string,
    attachments: PromptAttachment[] = [],
    references: PromptReference[] = []
  ): AgentMessage {
    const id = messageId()
    const now = Date.now()
    return {
      id,
      role: 'user',
      parts: [
        { type: 'text', id: `${id}:text`, messageID: id, text },
        ...attachments.map((attachment, index): AgentPart => ({
          type: 'file',
          id: `${id}:file-${index}`,
          messageID: id,
          mime: attachment.mime,
          url: attachment.url,
          filename: attachment.filename
        }))
      ],
      references: references.length > 0 ? references : undefined,
      createdAt: now,
      completedAt: now
    }
  }

  function touch(): void {
    if (tab.expired) return
    contextSidebarState.touchTemporaryChat(tab)
    if (!tab.sessionStarted) return
    const temporaryChatId = tab.temporaryChatId
    void invoke('agent:touchTemporaryChat', temporaryChatId).then((status) => {
      if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
      if (!status.active) {
        contextSidebarState.expireTemporaryChat(tab, false)
        return
      }
      if (status.expiresAt) {
        contextSidebarState.touchTemporaryChat(tab, status.expiresAt)
      }
    })
  }

  function restart(): void {
    contextSidebarState.restartTemporaryChat(tab)
    if (tab.mode === 'elaborate') {
      tab.autoPromptSent = true
      void sendElaboratePrompt()
    }
  }

  function sendElaboratePrompt(): Promise<void> {
    return send(
      'Explain this selection in detail. Do not perform any execution, do not make code changes, run tests, or do anything beyond: read-only and findings based on the available context. Focus on answering just the selection and avoiding mentioning anything unrelated!',
      [],
      '*Elaborate.*'
    )
  }

  async function send(
    text: string,
    attachments: PromptAttachment[] = [],
    presentationText = text
  ): Promise<void> {
    const prompt = text.trim()
    if (!prompt || tab.busy || tab.expired) return
    touch()
    const temporaryChatId = tab.temporaryChatId
    const attachedSelection = tab.selectionAttached ? tab.selection : undefined
    const outgoing = userMessage(
      presentationText,
      attachments,
      attachedSelection
        ? [
            {
              id: `${temporaryChatId}:selection`,
              label: 'Selection 1',
              text: attachedSelection
            }
          ]
        : []
    )
    tab.messages = [...tab.messages, outgoing]
    if (attachedSelection) tab.selectionMessageId = outgoing.id
    tab.selectionAttached = false
    tab.draft = ''
    tab.busy = true
    tab.error = ''
    tab.sessionStarted = true
    try {
      const response = await invoke(
        'agent:sendTemporaryPrompt',
        tab.projectId,
        tab.threadId,
        temporaryChatId,
        tab.settings,
        prompt,
        attachments,
        attachedSelection,
        tab.messages.length === 1 ? tab.initialContext : undefined
      )
      if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
      if (!tab.messages.some((m) => m.id === response.id)) {
        tab.messages = [...tab.messages, response]
      }
      touch()
    } catch (error) {
      if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
      tab.error = error instanceof Error ? error.message : 'The temporary chat could not respond.'
    } finally {
      if (tab.temporaryChatId === temporaryChatId && !tab.expired) {
        tab.busy = false
      }
    }
  }

  function updateSettings(settings: ThreadSettings): void {
    tab.settings = {
      ...settings,
      engineeringMode: false,
      permissionLevel: 'auto_review'
    }
  }

  onMount(() => {
    const unsubscribeExpiry = subscribe('agent:temporaryChatExpired', (temporaryChatId) => {
      if (temporaryChatId === tab.temporaryChatId) {
        contextSidebarState.expireTemporaryChat(tab, false)
      }
    })
    const unsubscribeEvents = subscribe('agent:event', (...args: unknown[]) => {
      const event = args[0] as AgentEvent
      if (event) handleEvent(event)
    })
    if (tab.sessionStarted) {
      const temporaryChatId = tab.temporaryChatId
      void invoke('agent:getTemporaryChatStatus', temporaryChatId).then((status) => {
        if (tab.temporaryChatId !== temporaryChatId || tab.expired) return
        if (!status.active) {
          contextSidebarState.expireTemporaryChat(tab, false)
          return
        }
        if (status.expiresAt) {
          contextSidebarState.touchTemporaryChat(tab, status.expiresAt)
        }
      })
    }
    if (tab.mode === 'elaborate' && !tab.autoPromptSent) {
      tab.autoPromptSent = true
      void sendElaboratePrompt()
    }
    return () => {
      unsubscribeExpiry()
      unsubscribeEvents()
    }
  })

  $effect(() => {
    const sessionId = tab.sessionId
    if (tab.mode !== 'audit' || !sessionId || loadedAuditSessionId === sessionId) return
    loadedAuditSessionId = sessionId
    const temporaryChatId = tab.temporaryChatId
    void invoke('agent:loadTemporaryChatMessages', temporaryChatId)
      .then((messages) => {
        if (tab.temporaryChatId !== temporaryChatId || tab.sessionId !== sessionId) return
        tab.messages = messages
      })
      .catch(() => {
        // Live events still populate the trace when provider history is temporarily unavailable.
      })
  })

  // Convert file:// attachment URLs to blob: Object URLs so attached images
  // render reliably in the Electron renderer.
  $effect(() => {
    for (const message of tab.messages) {
      for (const part of message.parts) {
        if (part.type === 'file' && isImageMime(part.mime) && part.url.startsWith('file://')) {
          void imageUrls.load(part.url, part.mime)
        }
      }
    }
  })

  onDestroy(() => imageUrls.destroy())
</script>

<div class="flex h-full min-h-0 flex-col bg-app">
  {#if previewFile}
    <ImagePreview
      src={imageUrls.getUrl(previewFile.url)}
      filename={previewFile.filename ?? 'image'}
      onClose={() => (previewFile = null)}
    />
  {/if}
  {#if tab.expired}
    <div class="flex min-h-0 flex-1 items-center justify-center px-6">
      <div class="w-full max-w-sm rounded-xl border border-border bg-surface p-5 text-center">
        <Clock3 size={20} class="mx-auto text-dimmed" />
        <p class="mt-3 text-sm font-semibold text-foreground">Side chat has expired</p>
        <p class="mt-1 text-xs leading-relaxed text-muted">
          Its temporary history and agent session were discarded after
          {tab.mode === 'audit' ? '24 hours' : 'three hours'} of inactivity.
        </p>
        <button
          type="button"
          class="mt-4 inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-on-primary transition-colors hover:bg-primary-hover"
          onclick={restart}
        >
          <RotateCcw size={13} />
          Start new side chat
        </button>
      </div>
    </div>
  {:else}
    {#if tab.mode === 'audit'}
      <header class="shrink-0 border-b border-border px-4 py-3">
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <h2 class="text-xs font-semibold text-foreground">Audit agent</h2>
            <p class="mt-0.5 text-[11px] text-muted">
              This trace remains available for 24 hours. Hiding the sidebar keeps it alive.
            </p>
          </div>
          <span
            class="flex shrink-0 items-center gap-1 text-[10px] {tab.busy
              ? 'text-info'
              : tab.error
                ? 'text-danger'
                : 'text-success'}"
          >
            {#if tab.busy}
              <Loader2 size={10} class="animate-spin" />
              Auditing
            {:else if tab.error}
              Failed
            {:else}
              Ready
            {/if}
          </span>
        </div>
      </header>
    {/if}
    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div class="mx-auto flex w-full max-w-2xl flex-col gap-5">
        {#each tab.messages as message, messageIndex (message.id)}
          {#if message.role === 'user'}
            <div class="ml-auto max-w-[90%]">
              {#if message.references?.length}
                <div class="mb-1.5 flex flex-wrap justify-end gap-1.5">
                  {#each message.references as reference (reference.id)}
                    <span
                      class="flex max-w-full items-center gap-1.5 rounded-lg border border-accent/30 bg-accent/10 px-2 py-1 text-[11px]"
                      title={reference.comment
                        ? `${reference.comment}\n\n${reference.text}`
                        : reference.text}
                    >
                      <MessageSquare size={11} class="shrink-0 text-accent" />
                      <span class="font-medium text-foreground">{reference.label}</span>
                      <span class="truncate text-muted">{reference.text}</span>
                      {#if reference.comment}
                        <span class="max-w-48 truncate italic text-foreground">
                          “{reference.comment}”
                        </span>
                      {/if}
                    </span>
                  {/each}
                </div>
              {/if}
              {#if fileParts(message).length > 0}
                <div class="mb-1.5 flex flex-wrap justify-end gap-1.5">
                  {#each fileParts(message) as part (part.id)}
                    {#if isImageMime(part.mime)}
                      <button
                        type="button"
                        class="group relative overflow-hidden rounded-lg border border-border transition-shadow hover:shadow-md"
                        title="Preview {part.filename ?? 'image'}"
                        aria-label="Preview {part.filename ?? 'image'}"
                        onclick={() => (previewFile = part)}
                      >
                        <img
                          src={imageUrls.getUrl(part.url)}
                          alt={part.filename ?? 'image'}
                          class="h-16 w-24 object-cover"
                          onerror={(e: Event) =>
                            void imageUrls.bindImage(
                              part.url,
                              part.mime,
                              e.currentTarget as HTMLImageElement
                            )}
                        />
                        <span
                          class="absolute inset-0 flex items-center justify-center bg-black/0 text-[10px] font-medium text-white opacity-0 transition-all group-hover:bg-black/30 group-hover:opacity-100"
                        >
                          Preview
                        </span>
                      </button>
                    {:else}
                      <span
                        class="flex max-w-full items-center gap-1.5 rounded-lg bg-surface px-2 py-1 text-[11px] text-muted"
                        title={part.filename ?? part.url}
                      >
                        <FileText size={11} class="shrink-0" />
                        <span class="max-w-32 truncate"
                          >{part.filename ?? part.url.split('/').pop() ?? 'file'}</span
                        >
                      </span>
                    {/if}
                  {/each}
                </div>
              {/if}
              <div class="rounded-lg bg-surface px-3 py-2 text-sm text-foreground">
                <MarkdownView text={textFor(message)} />
              </div>
            </div>
          {:else if textFor(message)}
            {@const traceParts = workingParts(message)}
            <div class="flex min-w-0 flex-col gap-2.5 text-sm text-foreground">
              {#if traceParts.length > 0}
                <WorkingTrace
                  parts={traceParts}
                  open={tab.busy}
                  busy={tab.busy}
                  latest={tab.busy}
                  startTime={turnStartTime(messageIndex)}
                  {modelLabel}
                  {providerName}
                  harnessId={tab.settings.harnessId}
                  {harnessName}
                />
              {/if}
              {#if textFor(message)}
                <MarkdownView text={textFor(message)} />
              {/if}
            </div>
          {:else if workingParts(message).length > 0}
            <WorkingTrace
              parts={workingParts(message)}
              open={tab.busy}
              busy={tab.busy}
              latest={tab.busy}
              startTime={turnStartTime(messageIndex)}
              {modelLabel}
              {providerName}
              harnessId={tab.settings.harnessId}
              {harnessName}
            />
          {/if}
        {/each}

        {#if tab.busy}
          <div class="flex items-center gap-2 text-xs text-dimmed">
            <Loader2 size={13} class="animate-spin text-info" />
            {tab.mode === 'audit' ? 'Auditing implementation…' : 'Reading context…'}
          </div>
        {/if}

        {#if tab.error}
          <div
            class="flex items-start justify-between gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger"
          >
            <span>{tab.error}</span>
            <button
              type="button"
              class="shrink-0 rounded p-0.5 transition-colors hover:bg-danger/10"
              title="Dismiss error"
              aria-label="Dismiss temporary chat error"
              onclick={() => (tab.error = '')}
            >
              <X size={12} />
            </button>
          </div>
        {/if}
      </div>
    </div>

    {#if tab.mode !== 'audit'}
      <div class="shrink-0 border-t border-border bg-app px-3 py-3">
        <div class="mx-auto max-w-2xl">
          <ChatComposer
            placeholder="Ask a read-only question…"
            disabled={tab.busy}
            settings={tab.settings}
            onSettingsChange={updateSettings}
            {providers}
            projectId={tab.projectId}
            harnessId={tab.settings.harnessId}
            showEngineeringMode={false}
            readOnlyMode
            allowAttachments
            hidePermissionSelector
            enableImageDescriptorGate={false}
            favoriteModels={rendererRecovery.chatFavoriteModels}
            onToggleFavorite={(providerId, modelId) =>
              rendererRecovery.toggleChatFavorite(`${providerId}:${modelId}`)}
            onReorderFavorite={(draggedKey, targetKey, position) =>
              rendererRecovery.reorderChatFavorite(draggedKey, targetKey, position)}
            recentModels={rendererRecovery.chatRecentModels}
            onModelUsed={(modelKey) => rendererRecovery.addChatRecentModel(modelKey)}
            {references}
            onRemoveReference={() => (tab.selectionAttached = false)}
            initialValue={tab.draft}
            onValueChange={(value) => {
              tab.draft = value
              touch()
            }}
            onSend={(message, attachments) => void send(message, attachments)}
          />
        </div>
      </div>
    {/if}
  {/if}
</div>
