<script lang="ts">
  import { onMount } from 'svelte'
  import {
    ChevronDown,
    Loader2,
    MessageSquare,
    PanelLeft,
    Plus,
    Send,
    Smartphone,
    X
  } from '@lucide/svelte'
  import { remoteBridge, isRemoteConnected } from '$lib/remote/remote-bridge'
  import { threadMessages } from '$lib/stores/thread-messages.svelte'
  import { DEFAULT_SETTINGS } from '$lib/stores/thread-settings.svelte'
  import { threadStatusSort } from '$lib/stores/workspace.svelte'
  import { supportsFastInference, fastSelectionModelId } from '$shared/fast-inference'
  import { STANDARD_THINKING_PRESETS } from '$shared/thinking-presets'
  import type {
    AgentContextUsage,
    Project,
    PromptAttachment,
    ProviderCatalog,
    Thread,
    ThreadSettings
  } from '$shared/types'

  interface RemoteChatAppProps {
    onDisconnect?: () => void
  }

  let { onDisconnect = () => undefined }: RemoteChatAppProps = $props()

  let projects = $state<Project[]>([])
  let threads = $state<Thread[]>([])
  let catalog = $state<ProviderCatalog[]>([])
  let selectedProjectId = $state<string | null>(null)
  let selectedThreadId = $state<string | null>(null)
  let sidebarOpen = $state(true)
  let view = $state<'projects' | 'threads'>('projects')
  let loading = $state(true)
  let error = $state('')
  let busy = $state(false)
  let draft = $state('')
  let loadingMessages = $state(false)
  let connected = $state(isRemoteConnected())
  let attachments = $state<PromptAttachment[]>([])
  let fileInput: HTMLInputElement | undefined = $state(undefined)
  let showModelPicker = $state(false)
  let showThinkingPicker = $state(false)
  let settings = $state<ThreadSettings>({ ...DEFAULT_SETTINGS })

  const STATUS_GROUPS: Array<{ key: string; label: string; match: (t: Thread) => boolean }> = [
    { key: 'todo', label: 'To do', match: (t) => t.status === 'created' },
    {
      key: 'attention',
      label: 'Needs attention',
      match: (t) =>
        ['planning', 'executing', 'awaiting_approval', 'failed', 'interrupted'].includes(t.status)
    },
    { key: 'unread', label: 'Unread', match: (t) => !t.read && t.status !== 'created' },
    { key: 'done', label: 'Done', match: (t) => t.status === 'completed' }
  ]

  const selectedThread = $derived(threads.find((t) => t.id === selectedThreadId) ?? null)
  const selectedProject = $derived(projects.find((p) => p.id === selectedProjectId) ?? null)

  // Keep the composer settings in sync with the selected thread's settings whenever
  // the selected thread changes (see openThread and loadData). This is event-driven
  // rather than an $effect so we don't write to $state inside an effect.
  function syncSettingsFrom(thread: Thread | null): void {
    if (thread?.settings) {
      settings = { ...DEFAULT_SETTINGS, ...thread.settings }
    }
  }

  const visibleMessages = $derived(
    selectedThread ? threadMessages.messages(selectedThread.projectId, selectedThread.id) : []
  )

  const selectedCatalog = $derived(catalog.find((c) => c.id === settings.providerId))

  const selectedModel = $derived(selectedCatalog?.models.find((m) => m.id === settings.modelId))

  const thinkingPresets = $derived(
    selectedModel?.thinkingPresets?.length
      ? selectedModel.thinkingPresets
      : STANDARD_THINKING_PRESETS
  )

  const fastSupported = $derived(
    selectedCatalog && selectedModel
      ? supportsFastInference(settings.harnessId, selectedCatalog.id, selectedModel.fastSupported)
      : false
  )

  const contextUsage = $derived.by((): AgentContextUsage | undefined => {
    let contextWindow: number | undefined
    let contextUsed = 0
    let costUsd = 0
    let reasoning = 0
    let cacheRead = 0
    let cacheWrite = 0
    let input = 0
    let output = 0
    for (const message of visibleMessages) {
      if (message.contextWindow !== undefined) contextWindow = message.contextWindow
      if (message.contextUsed !== undefined) contextUsed = message.contextUsed
      if (message.cost !== undefined) costUsd += message.cost
      input += message.tokens?.input ?? 0
      output += message.tokens?.output ?? 0
      reasoning += message.tokens?.reasoning ?? 0
      cacheRead += message.tokens?.cacheRead ?? 0
      cacheWrite += message.tokens?.cacheWrite ?? 0
    }
    if (input === 0 && output === 0 && costUsd === 0) return undefined
    return {
      contextWindow,
      contextUsed,
      contextPercent:
        contextWindow && contextWindow > 0 ? (contextUsed / contextWindow) * 100 : undefined,
      costUsd,
      tokens: {
        input,
        output,
        reasoning,
        cacheRead,
        cacheWrite,
        total: input + output + reasoning + cacheRead + cacheWrite
      },
      rateLimits: []
    }
  })

  function groupedThreads(): Array<{ key: string; label: string; threads: Thread[] }> {
    const scoped = threads.filter((t) =>
      view === 'projects' ? t.projectId === selectedProjectId : true
    )
    return STATUS_GROUPS.map((group) => ({
      ...group,
      threads: scoped.filter(group.match).sort(threadStatusSort)
    })).filter((group) => group.threads.length > 0)
  }

  async function loadData(): Promise<void> {
    loading = true
    error = ''
    try {
      const [projectList, threadList, snapshots] = await Promise.all([
        remoteBridge.invoke('project:list'),
        remoteBridge.invoke('thread:listAll'),
        remoteBridge.invoke('agent:listProviderSnapshot', selectedProjectId ?? '')
      ])
      projects = (projectList as Project[]).filter((p) => !p.hidden)
      threads = threadList as Thread[]
      catalog = snapshots as ProviderCatalog[]
      if (!selectedProjectId && projects.length > 0) {
        selectedProjectId = projects[0].id
      }
      if (selectedThreadId && !threads.some((t) => t.id === selectedThreadId)) {
        selectedThreadId = null
      }
      if (!selectedThreadId) {
        const first = threads.find((t) => t.projectId === selectedProjectId)
        if (first) selectedThreadId = first.id
      }
      if (selectedThreadId && selectedProjectId) {
        const thread = threads.find((t) => t.id === selectedThreadId) ?? null
        syncSettingsFrom(thread)
        await openThreadMessages(thread)
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not load your threads.'
    } finally {
      loading = false
    }
  }

  async function openThread(thread: Thread): Promise<void> {
    selectedThreadId = thread.id
    selectedProjectId = thread.projectId
    sidebarOpen = false
    draft = ''
    attachments = []
    syncSettingsFrom(thread)
    await openThreadMessages(thread)
  }

  async function openThreadMessages(thread: Thread | null): Promise<void> {
    if (!thread) return
    loadingMessages = true
    try {
      await threadMessages.load(thread.projectId, thread.id)
      const status = (await remoteBridge.invoke(
        'agent:getSessionStatus',
        thread.projectId,
        thread.id
      )) as { sessionId?: string } | null
      void threadMessages.setSessionId(thread.projectId, thread.id, status?.sessionId ?? undefined)
    } finally {
      loadingMessages = false
    }
  }

  async function handleSend(): Promise<void> {
    const text = draft.trim()
    if (!selectedThread || text.length === 0 || busy) return
    busy = true
    try {
      const effective = { ...DEFAULT_SETTINGS, ...(settings ?? {}) }
      await threadMessages.send(
        selectedThread.projectId,
        selectedThread.id,
        effective,
        text,
        attachments,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined
      )
      draft = ''
      attachments = []
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not send your message.'
    } finally {
      busy = false
    }
  }

  async function commitSettings(): Promise<void> {
    if (!selectedThread) return
    try {
      const updated = (await remoteBridge.invoke(
        'thread:updateSettings',
        selectedThread.projectId,
        selectedThread.id,
        settings
      )) as Thread
      settings = { ...DEFAULT_SETTINGS, ...(updated.settings ?? settings) }
    } catch (e) {
      error = e instanceof Error ? e.message : 'Could not save settings.'
    }
  }

  async function selectModel(providerId: string, modelId: string): Promise<void> {
    settings = { ...settings, providerId, modelId }
    await commitSettings()
    showModelPicker = false
  }
  async function setPermission(permissionLevel: 'auto_review' | 'full_access'): Promise<void> {
    settings = { ...settings, permissionLevel }
    await commitSettings()
  }

  async function setThinking(thinkingLevel: ThreadSettings['thinkingLevel']): Promise<void> {
    settings = { ...settings, thinkingLevel }
    await commitSettings()
    showThinkingPicker = false
  }
  async function toggleFast(enabled: boolean): Promise<void> {
    const harnessId = settings.harnessId
    if (enabled && selectedCatalog) {
      settings = {
        ...settings,
        inferenceMode: 'fast',
        modelId: fastSelectionModelId(harnessId, settings.modelId)
      }
    } else {
      settings = { ...settings, inferenceMode: 'normal' }
    }
    await commitSettings()
  }

  /** Captures the hidden file input so the attach button can trigger it. */
  function captureFileInput(node: HTMLInputElement): (() => void) | void {
    fileInput = node
    return () => {
      fileInput = undefined
    }
  }

  function onFileChange(): void {
    const file = fileInput?.files?.[0]
    if (!file) return
    attachments = [
      ...attachments,
      {
        mime: file.type || 'application/octet-stream',
        url: URL.createObjectURL(file),
        filename: file.name
      }
    ]
    if (fileInput) fileInput.value = ''
  }

  function removeAttachment(index: number): void {
    const removed = attachments[index]
    if (removed?.url.startsWith('blob:')) URL.revokeObjectURL(removed.url)
    attachments = attachments.filter((_, i) => i !== index)
  }

  function statusLabel(status: Thread['status']): string {
    switch (status) {
      case 'created':
        return 'Created'
      case 'planning':
        return 'Planning'
      case 'executing':
        return 'Executing'
      case 'awaiting_approval':
        return 'Awaiting approval'
      case 'interrupted':
        return 'Interrupted'
      case 'completed':
        return 'Completed'
      case 'failed':
        return 'Failed'
    }
  }

  onMount(() => {
    void loadData()
    const interval = window.setInterval(() => {
      connected = isRemoteConnected()
      if (!connected) {
        window.clearInterval(interval)
      }
    }, 1500)
    return () => window.clearInterval(interval)
  })
</script>

{#if !connected}
  <div class="flex h-full flex-col items-center justify-center gap-4 bg-app p-6">
    <Smartphone size={32} class="text-muted" />
    <p class="text-sm text-muted">Connection to your desktop was lost.</p>
    <button
      type="button"
      class="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-on-primary"
      onclick={onDisconnect}
    >
      Reconnect
    </button>
  </div>
{:else}
  <div class="flex h-full bg-app">
    {#if sidebarOpen}
      <aside class="flex w-72 shrink-0 flex-col border-r bg-surface">
        <div class="flex items-center justify-between border-b px-3 py-2">
          <div class="flex items-center gap-2">
            <MessageSquare size={15} class="text-primary" />
            <span class="text-sm font-semibold">Threads</span>
          </div>
          <button
            type="button"
            class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground"
            aria-label="Hide the sidebar"
            title="Hide the sidebar"
            onclick={() => (sidebarOpen = false)}
          >
            <PanelLeft size={14} />
          </button>
        </div>

        <!-- Projects / Threads view switcher -->
        <div class="border-b px-3 py-2">
          <div class="relative">
            <select
              class="w-full appearance-none rounded-lg border bg-elevated px-2.5 py-1.5 text-xs font-medium outline-none focus:border-primary"
              bind:value={view}
              aria-label="Switch between projects and threads"
            >
              <option value="projects">Projects</option>
              <option value="threads">Threads</option>
            </select>
            <ChevronDown
              size={12}
              class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-dimmed"
            />
          </div>
          {#if view === 'projects'}
            <div class="relative mt-2">
              <select
                class="w-full appearance-none rounded-lg border bg-elevated px-2.5 py-1.5 text-xs font-medium outline-none focus:border-primary"
                bind:value={selectedProjectId}
                aria-label="Select project"
              >
                {#each projects as project (project.id)}
                  <option value={project.id}>{project.name}</option>
                {/each}
              </select>
              <ChevronDown
                size={12}
                class="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-dimmed"
              />
            </div>
          {/if}
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          {#if loading}
            <div class="flex items-center gap-2 px-2 py-3 text-xs text-muted">
              <Loader2 size={13} class="animate-spin" />
              Loading threads…
            </div>
          {:else if error}
            <p class="px-2 py-3 text-xs text-danger">{error}</p>
          {:else}
            {#each groupedThreads() as group (group.key)}
              <p
                class="px-2 pb-1 pt-3 text-[10px] font-semibold uppercase tracking-wide text-dimmed"
              >
                {group.label}
              </p>
              <div class="space-y-px">
                {#each group.threads as thread (thread.id)}
                  {@const selected = thread.id === selectedThreadId}
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors {selected
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted hover:bg-elevated hover:text-foreground'}"
                    title={thread.title || 'Untitled thread'}
                    onclick={() => void openThread(thread)}
                  >
                    <span class="min-w-0 flex-1 truncate">{thread.title || 'Untitled thread'}</span>
                    {#if !thread.read}
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"></span>
                    {/if}
                  </button>
                {/each}
              </div>
            {:else}
              <p class="px-2 py-3 text-xs text-dimmed">No threads yet.</p>
            {/each}
          {/if}
        </div>
      </aside>
    {/if}

    <main class="flex min-w-0 flex-1 flex-col">
      <!-- Chat header: title + context usage -->
      <header class="flex h-12 shrink-0 items-center gap-2 border-b px-3">
        <button
          type="button"
          class="flex h-7 w-7 items-center justify-center rounded-md text-muted transition-colors hover:bg-elevated hover:text-foreground lg:hidden"
          aria-label="Show the sidebar"
          title="Show the sidebar"
          onclick={() => (sidebarOpen = true)}
        >
          <PanelLeft size={15} />
        </button>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold">{selectedThread?.title || 'Select a thread'}</p>
          <p class="truncate text-[11px] text-dimmed">
            {selectedProject?.name ?? ''}
            {#if selectedThread}· {statusLabel(selectedThread.status)}{/if}
          </p>
        </div>
        {#if contextUsage}
          <div
            class="flex shrink-0 items-center gap-3 text-[11px] text-muted"
            aria-label="Context usage"
          >
            {#if contextUsage.contextWindow}
              <span class="tabular-nums">
                {contextUsage.contextPercent !== undefined
                  ? `${Math.round(contextUsage.contextPercent)}% context`
                  : `${(contextUsage.contextUsed / 1_000_000).toFixed(1)}M tokens`}
              </span>
            {/if}
            <span class="tabular-nums">{contextUsage.tokens.output.toLocaleString()} out</span>
            <span class="tabular-nums">${contextUsage.costUsd.toFixed(3)}</span>
          </div>
        {/if}
      </header>

      <!-- Messages -->
      <div class="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {#if loadingMessages}
          <div class="flex items-center gap-2 text-xs text-muted">
            <Loader2 size={13} class="animate-spin" />
            Loading conversation…
          </div>
        {:else if visibleMessages.length === 0}
          <p class="text-center text-xs text-dimmed">
            Start the conversation — this thread is empty.
          </p>
        {:else}
          <div class="space-y-4">
            {#each visibleMessages as message (message.id)}
              {@const isUser = message.role === 'user'}
              <div class="flex {isUser ? 'justify-end' : 'justify-start'}">
                <div
                  class="max-w-[85%] rounded-xl border px-3 py-2 {isUser
                    ? 'bg-primary/10'
                    : 'bg-surface'}"
                >
                  {#each message.parts as part (part.id)}
                    {#if (part.type === 'text' || part.type === 'reasoning') && part.text}
                      <p class="whitespace-pre-wrap text-[13px] leading-relaxed">{part.text}</p>
                    {/if}
                  {/each}
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <!-- Composer -->
      <div class="border-t px-3 py-2">
        {#if attachments.length > 0}
          <div class="mb-1.5 flex flex-wrap gap-1.5">
            {#each attachments as attachment, index (attachment.url)}
              <span
                class="flex items-center gap-1 rounded-md bg-elevated px-2 py-1 text-[11px] text-muted"
              >
                {attachment.filename ?? 'attachment'}
                <button
                  type="button"
                  class="text-dimmed hover:text-danger"
                  aria-label="Remove attachment"
                  title="Remove attachment"
                  onclick={() => removeAttachment(index)}
                >
                  <X size={11} />
                </button>
              </span>
            {/each}
          </div>
        {/if}

        <div class="flex items-end gap-2">
          <div
            class="flex min-w-0 flex-1 items-end gap-1.5 rounded-lg border bg-elevated px-2 py-1.5"
          >
            <input
              {@attach captureFileInput}
              type="file"
              class="hidden"
              aria-label="Attach a file"
              onchange={onFileChange}
            />
            <button
              type="button"
              class="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-foreground"
              aria-label="Attach a file"
              title="Attach a file"
              onclick={() => fileInput?.click()}
            >
              <Plus size={15} />
            </button>
            <textarea
              class="min-h-9 max-h-40 flex-1 resize-none bg-transparent py-1 text-sm text-foreground outline-none placeholder:text-dimmed"
              placeholder="Message {selectedThread?.title ?? 'the agent'}…"
              rows="1"
              bind:value={draft}
              onkeydown={(e: KeyboardEvent) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void handleSend()
                }
              }}></textarea>
          </div>
          <button
            type="button"
            class="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 text-xs font-medium text-on-primary transition-colors hover:opacity-90 disabled:pointer-events-none disabled:opacity-50"
            disabled={busy || draft.trim().length === 0 || !selectedThread}
            title="Send message"
            onclick={() => void handleSend()}
          >
            {#if busy}
              <Loader2 size={13} class="animate-spin" />
            {:else}
              <Send size={13} />
            {/if}
          </button>
        </div>

        <!-- Model / permission / thinking / fast controls -->
        <div class="mt-1.5 flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            class="flex items-center gap-1 rounded-md bg-elevated px-2 py-1 text-[11px] text-muted transition-colors hover:text-foreground"
            title="Choose model"
            onclick={() => (showModelPicker = !showModelPicker)}
          >
            {settings.modelId || 'Model'}
            <ChevronDown size={11} />
          </button>

          <button
            type="button"
            class="flex items-center gap-1 rounded-md bg-elevated px-2 py-1 text-[11px] text-muted transition-colors hover:text-foreground"
            title="Permission level"
            onclick={() =>
              void setPermission(
                settings.permissionLevel === 'full_access' ? 'auto_review' : 'full_access'
              )}
          >
            {settings.permissionLevel === 'full_access' ? 'Full access' : 'Auto review'}
          </button>

          <button
            type="button"
            class="flex items-center gap-1 rounded-md bg-elevated px-2 py-1 text-[11px] text-muted transition-colors hover:text-foreground"
            title="Thinking level"
            onclick={() => (showThinkingPicker = !showThinkingPicker)}
          >
            {settings.thinkingLevel}
            <ChevronDown size={11} />
          </button>

          {#if fastSupported}
            <button
              type="button"
              class="rounded-md px-2 py-1 text-[11px] transition-colors {settings.inferenceMode ===
              'fast'
                ? 'bg-primary/15 text-primary'
                : 'bg-elevated text-muted hover:text-foreground'}"
              title="Toggle fast mode"
              onclick={() => void toggleFast(settings.inferenceMode !== 'fast')}
            >
              Fast
            </button>
          {/if}

          {#if showModelPicker}
            <div class="w-full rounded-lg border bg-surface p-2">
              {#each catalog as provider (provider.id)}
                <p class="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wide text-dimmed">
                  {provider.name ?? provider.id}
                </p>
                <div class="mb-1 grid grid-cols-2 gap-1">
                  {#each provider.models as model (model.id)}
                    <button
                      type="button"
                      class="rounded-md px-2 py-1 text-left text-[11px] transition-colors {settings.modelId ===
                        model.id && settings.providerId === provider.id
                        ? 'bg-primary/10 text-foreground'
                        : 'text-muted hover:bg-elevated hover:text-foreground'}"
                      onclick={() => void selectModel(provider.id, model.id)}
                    >
                      {model.name}
                    </button>
                  {/each}
                </div>
              {/each}
            </div>
          {/if}

          {#if showThinkingPicker}
            <div class="w-full rounded-lg border bg-surface p-2">
              <div class="grid grid-cols-2 gap-1">
                {#each thinkingPresets as preset (preset.id)}
                  <button
                    type="button"
                    class="rounded-md px-2 py-1 text-left text-[11px] transition-colors {settings.thinkingLevel ===
                    preset.id
                      ? 'bg-primary/10 text-foreground'
                      : 'text-muted hover:bg-elevated hover:text-foreground'}"
                    onclick={() => void setThinking(preset.id as ThreadSettings['thinkingLevel'])}
                  >
                    {preset.label}
                  </button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
      </div>
    </main>
  </div>
{/if}
